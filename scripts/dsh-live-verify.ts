/**
 * Live verify: real Cursor + full compact wiring (same as DSH plugin).
 * Does NOT start DSH — exercises CursorAdapter the way `dsh web` does.
 *
 *   node --experimental-strip-types scripts/dsh-live-verify.ts [model] [sessionId]
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CursorAdapter } from "../src/adapter.ts";
import { getContextFillSnapshot, clearContextFillSnapshots } from "../src/context/fill-cache.ts";
import { ledgerPersistenceEnabled, loadKernelState } from "../src/context/ledger-persist.ts";
import { renderLiveContextPanel, renderPersistedContextPanel } from "../src/context/panel.ts";
import { contextWindow } from "../src/models.ts";
import { createCursorAgent, deleteCursorAgent, listCursorModels } from "../src/sdk.ts";
import { closeAllCursorSessions, sessionSnapshot } from "../src/session.ts";
import type { CompactDeps } from "../src/session.ts";
import type { CheckpointStoreLike } from "../src/context/checkpoint.ts";
import { CONTEXT_DEFAULTS, readContextManagement } from "../src/ui-state.ts";
import { kernelTurnPlan } from "../src/context/kernel.ts";

const model = process.argv[2] ?? "claude-haiku-5-5";
const sessionId = process.argv[3] ?? `live-verify-${Date.now()}`;

if (!process.env.CURSOR_API_KEY?.trim()) {
  console.error("CURSOR_API_KEY required (DSH credentials or export)");
  process.exit(2);
}

mkdirSync(join(homedir(), ".dsh"), { recursive: true });

let failed = 0;
const ok = (what: string, detail = "") => console.log(`  PASS ${what}${detail ? ` — ${detail}` : ""}`);
const bad = (what: string, detail = "") => {
  failed += 1;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
};

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

const compact: CompactDeps = {
  store: checkpointStore,
  readBudget: () => readContextManagement({}),
  resolveKeepTurns: (sessionKey, messages, tokenCount, windowTokens, compactedAt) =>
    kernelTurnPlan(sessionKey, messages, tokenCount, windowTokens, { compactedAt, preserve: preserveConfig() }).keepTurns,
  preserveConfig,
  createAgent: createCursorAgent,
  deleteAgent: deleteCursorAgent,
};

const adapter = new CursorAdapter({
  createAgent: createCursorAgent,
  listModels: listCursorModels,
  resolveApiKey: async () => process.env.CURSOR_API_KEY,
  cwdFor: () => process.cwd(),
  compact,
});

let seq = 0;
const msg = (role: string, text: string) => ({ id: `m${++seq}`, role, content: [{ type: "text", text }] });

async function turn(messages: any[]) {
  const chunks: any[] = [];
  const t0 = Date.now();
  for await (const c of adapter.stream({
    provider: "cursor",
    model,
    messages,
    tools: [],
    sessionId,
    reasoningEffort: undefined,
  })) {
    chunks.push(c);
  }
  const finish = chunks.at(-1)?.reason;
  const usage = chunks.find((c) => c.type === "usage")?.usage;
  const blocks = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { finish, usage, text, ms: Date.now() - t0 };
}

console.log(`session=${sessionId} model=${model} sqlite=${ledgerPersistenceEnabled()}`);
clearContextFillSnapshots();

const system = msg("system", "Reply in one short sentence.");
const u1 = msg("user", "Say exactly: context-verify-ok");
const r1 = await turn([system, u1]);

if (r1.finish?.kind === "stop") ok("cursor turn", `${r1.ms}ms usage=${JSON.stringify(r1.usage)} text=${JSON.stringify(r1.text.slice(0, 80))}`);
else bad("cursor turn", JSON.stringify(r1.finish));

const fill = getContextFillSnapshot(sessionId);
if (fill && fill.percent >= 0 && fill.limitTokens > 0) {
  ok("context fill cache", `${fill.percent}% ${fill.retainedTokens}/${fill.limitTokens} pending=${fill.viewPending}`);
} else {
  bad("context fill cache", "no snapshot after turn");
}

const windowTokens = contextWindow({ id: model });
const snap = sessionSnapshot(sessionId, [system, u1], system.content[0].text, [], model, preserveConfig());
if (snap.estimatedRetainedTokens != null) ok("sessionSnapshot", `retained≈${snap.estimatedRetainedTokens} refs=${snap.refs?.length ?? 0}`);
else bad("sessionSnapshot", "missing retained estimate");

const panel = renderLiveContextPanel({
  sessionId,
  messages: [system, u1],
  systemPrompt: system.content[0].text,
  tools: [],
  modelId: model,
  preserve: preserveConfig(),
});
if (panel.includes("cursor-to-dsh@") && panel.includes("ACP")) ok("live acp panel", `${panel.split("\n").length} lines`);
else bad("live acp panel", "unexpected panel text");

const stored = loadKernelState(sessionId);
if (stored && stored.lastTokenCount > 0) ok("sqlite kernel_state", `lastTokenCount=${stored.lastTokenCount}`);
else if (!ledgerPersistenceEnabled()) ok("sqlite kernel_state", "skipped (node:sqlite unavailable)");
else bad("sqlite kernel_state", "missing or zero lastTokenCount");

const cold = renderPersistedContextPanel(sessionId, windowTokens);
if (cold?.includes("cursor-to-dsh@")) ok("persisted panel", "rendered");
else if (!ledgerPersistenceEnabled()) ok("persisted panel", "skipped (sqlite off)");
else bad("persisted panel", "empty");

closeAllCursorSessions();
console.log(failed ? `\nFAILED ${failed} check(s)` : "\nALL LIVE CHECKS PASSED");
process.exit(failed ? 1 : 0);
