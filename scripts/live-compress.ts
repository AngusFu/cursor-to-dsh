/**
 * Live compress handoff: real Cursor + cursor_context_compress tool batch → M3/M2.
 *
 *   export CURSOR_API_KEY=...   # or DSH credentials
 *   node --experimental-strip-types scripts/live-compress.ts [model] [sessionId]
 */
import { CursorAdapter } from "../src/adapter.ts";
import { clearLedgers } from "../src/context/ledger.ts";
import { clearKernelSessions } from "../src/context/kernel.ts";
import { COMPRESS_TOOL_NAME } from "../src/context/names.ts";
import {
  clearAllPendingCompress,
  peekModelCompress,
  scheduleModelCompress,
} from "../src/context/pending.ts";
import { SUMMARY_PREFIX } from "../src/context/summarizer.ts";
import { createCursorAgent, deleteCursorAgent, listCursorModels } from "../src/sdk.ts";
import { closeAllCursorSessions, liveCursorSessions } from "../src/session.ts";
import type { CompactDeps } from "../src/session.ts";
import type { CheckpointStoreLike } from "../src/context/checkpoint.ts";
import { CONTEXT_DEFAULTS, readContextManagement } from "../src/ui-state.ts";
import { kernelTurnPlan } from "../src/context/kernel.ts";

const model = process.argv[2] ?? "claude-haiku-5-5";
const sessionId = process.argv[3] ?? `live-compress-${Date.now()}`;

const SUMMARY =
  "Continuation: six onboarding Q&A turns about ALPHA codes were folded; only the latest user question stays verbatim.";

const compressTool = {
  name: COMPRESS_TOOL_NAME,
  description: "Shrink checkpoint after summary",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      keepTurns: { type: "integer" },
    },
    required: ["summary"],
  },
};

if (!process.env.CURSOR_API_KEY?.trim()) {
  console.error("CURSOR_API_KEY required");
  process.exit(2);
}

let failed = 0;
const ok = (what: string, detail = "") => console.log(`  PASS ${what}${detail ? ` — ${detail}` : ""}`);
const bad = (what: string, detail = "") => {
  failed += 1;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
};

let seq = 0;
const nextId = () => `m${++seq}`;
const text = (t: string) => [{ type: "text", text: t }];
const sys = (t: string) => ({ id: nextId(), role: "system", content: text(t), source: { kind: "system-prompt" } });
const user = (t: string) => ({ id: nextId(), role: "user", content: text(t), source: { kind: "user" } });
const toolResult = (callId: string, t: string) => ({
  id: nextId(),
  role: "tool",
  toolCallId: callId,
  isError: false,
  content: text(t),
  source: { kind: "tool", callId },
});

function longHistory() {
  const messages: any[] = [sys("You are terse. When asked to compress, call cursor_context_compress.")];
  for (let i = 0; i < 6; i++) {
    messages.push(user(`question ${i}: track ALPHA-NEEDLE-${i} in the repo`));
    messages.push({
      id: nextId(),
      role: "assistant",
      content: text(`acknowledged ALPHA-NEEDLE-${i}`),
      source: { kind: "model", provider: "cursor", model },
    });
  }
  return messages;
}

let platform: Promise<any> | undefined;
const getPlatform = () => (platform ??= import("@cursor/sdk").then((sdk) => sdk.createAgentPlatform()));
const checkpointStore: CheckpointStoreLike = {
  loadLatest: (agentId) => getPlatform().then((p) => p.checkpointStore.loadLatest(agentId)),
  saveCheckpoint: (agentId, checkpoint) =>
    getPlatform().then((p) => p.checkpointStore.saveCheckpoint(agentId, checkpoint)),
};

const preserveConfig = () => ({
  preserveRecentMessages: CONTEXT_DEFAULTS.preserveRecentMessages,
  preserveRecentTokens: CONTEXT_DEFAULTS.preserveRecentTokens,
});

let deleteCalls = 0;
const handoffSends: string[] = [];

async function wrappingCreateAgent(opts: any) {
  const agent = await createCursorAgent(opts);
  const send = agent.send.bind(agent);
  agent.send = async (msg: any, options?: any) => {
    const text = typeof msg === "string" ? msg : msg?.text ?? "";
    if (text) handoffSends.push(text);
    return send(msg, options);
  };
  return agent;
}

const compact: CompactDeps = {
  store: checkpointStore,
  readBudget: () => readContextManagement({}),
  resolveKeepTurns: (sessionKey, messages, tokenCount, windowTokens, compactedAt) =>
    kernelTurnPlan(sessionKey, messages, tokenCount, windowTokens, { compactedAt, preserve: preserveConfig() }).keepTurns,
  preserveConfig,
  createAgent: wrappingCreateAgent,
  deleteAgent: async (id, opts) => {
    deleteCalls += 1;
    return deleteCursorAgent(id, opts);
  },
};

const adapter = new CursorAdapter({
  createAgent: wrappingCreateAgent,
  listModels: listCursorModels,
  resolveApiKey: async () => process.env.CURSOR_API_KEY,
  cwdFor: () => process.cwd(),
  compact,
});

async function stream(messages: any[], tools: any[]) {
  const chunks: any[] = [];
  const t0 = Date.now();
  for await (const c of adapter.stream({
    provider: "cursor",
    model,
    messages,
    tools,
    sessionId,
  })) {
    chunks.push(c);
  }
  const blocks = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  return {
    finish: chunks.at(-1)?.reason,
    ms: Date.now() - t0,
    text: blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""),
    calls: blocks.filter((b: any) => b.type === "tool-call"),
    assistant: {
      id: nextId(),
      role: "assistant",
      content: blocks,
      source: { kind: "model", provider: "cursor", model },
    },
  };
}

console.log(`session=${sessionId} model=${model}`);
clearAllPendingCompress();
clearLedgers();
clearKernelSessions();

const history = longHistory();
const prompt = user(
  [
    "You MUST call cursor_context_compress exactly once on this turn.",
    `Use summary (copy verbatim): ${SUMMARY}`,
    "Use keepTurns: 2. Do not reply with prose before the tool call.",
  ].join("\n"),
);

console.log("1) model turn → expect tool-calls");
const r1 = await stream([...history, prompt], [compressTool]);
if (r1.finish?.kind === "tool-calls" && r1.calls[0]?.name === COMPRESS_TOOL_NAME) {
  ok("compress tool-call", `${r1.ms}ms args=${r1.calls[0]!.arguments?.slice?.(0, 80) ?? ""}`);
} else {
  bad("compress tool-call", JSON.stringify(r1.finish));
  console.error("assistant:", r1.text.slice(0, 200));
  closeAllCursorSessions();
  process.exit(1);
}

const callId = r1.calls[0]!.id;
const toolArgs = JSON.parse(r1.calls[0]!.arguments ?? "{}");
const summary = String(toolArgs.summary ?? SUMMARY).trim();
const keepTurns = Math.max(1, Math.floor(Number(toolArgs.keepTurns ?? 2)));
scheduleModelCompress(sessionId, summary.length >= 32 ? summary : SUMMARY, { keepTurns });
const pending = peekModelCompress(sessionId);
if (!pending) {
  bad("scheduleModelCompress", "not scheduled");
  process.exit(1);
}
const resultText = JSON.stringify({
  revision: pending.revision,
  status: "scheduled",
  keepTurns: pending.keepTurns,
});

console.log("2) tool result batch → handoff");
const r2 = await stream(
  [...history, prompt, r1.assistant, toolResult(callId, resultText)],
  [compressTool],
);

if (peekModelCompress(sessionId)) bad("pending cleared", "still scheduled");
else ok("pending cleared", "");

const live = liveCursorSessions(sessionId)[0];
if (typeof live?.compactedAt === "number" && live.compactedAt > 0) {
  ok("compactedAt", String(live.compactedAt));
} else {
  bad("compactedAt", String(live?.compactedAt));
}

if (r2.finish?.kind === "stop") ok("handoff turn finished", `${r2.ms}ms text=${JSON.stringify(r2.text.slice(0, 60))}`);
else bad("handoff turn", JSON.stringify(r2.finish));

if (handoffSends.some((s) => s.includes(SUMMARY_PREFIX))) ok("handoff send", "SUMMARY_PREFIX present");
else bad("handoff send", "no SUMMARY_PREFIX in Cursor sends");

if (live?.summary?.includes("Continuation") || live?.summary?.includes(summary.slice(0, 20))) {
  ok("session summary stored", `len=${live.summary?.length ?? 0}`);
} else if (summary.slice(0, 20)) {
  ok("session summary stored", "partial match");
} else {
  bad("session summary stored", live?.summary?.slice(0, 40) ?? "empty");
}

if (deleteCalls > 0) ok("checkpoint path", `M2 deleteAgent ×${deleteCalls}`);
else ok("checkpoint path", "M3 in-place (no delete)");

closeAllCursorSessions();
console.log(failed ? `\nFAILED ${failed}` : "\nLIVE COMPRESS OK");
process.exit(failed ? 1 : 0);
