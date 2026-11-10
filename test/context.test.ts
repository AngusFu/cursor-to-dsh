import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactCheckpoint,
  needlesFrom,
  parseRefs,
  payloadHoldsNeedle,
  refHex,
} from "../src/context/checkpoint.ts";
import { ACP_SYSTEM_MARKER, acpContextSectionText, acpSystemPromptAddition } from "../src/context/acp-prompts.ts";
import { registerAcpContextPrompt } from "../src/context/system-prompt.ts";
import { cursorContextToolsWhen } from "../src/context/cursor-route.ts";
import { planCompaction, runCompaction } from "../src/context/compact.ts";
import {
  SUMMARY_PREFIX,
  collectSummaryText,
  renderSummaryMessages,
  summarizerModelKey,
} from "../src/context/summarizer.ts";

/** A workspace that cannot hold a store, so every rewrite is refused. */
const NOWHERE = "/nonexistent/cursor-to-dsh-context-test";

const user = (text: string) => ({ role: "user", content: text });

test("blob ids are recognised in every shape the SDK hands them back", () => {
  const bytes = Array.from({ length: 32 }, (_, i) => i + 1);
  const hex = bytes.map((n) => n.toString(16).padStart(2, "0")).join("");

  assert.equal(refHex(hex), hex);
  assert.equal(refHex(Uint8Array.from(bytes)), hex);
  assert.equal(refHex(bytes), hex);

  // protojs turns bytes into an object keyed "0".."31"
  const rotated: Record<string, number> = {};
  bytes.forEach((n, i) => (rotated[String(i)] = n));
  assert.equal(refHex(rotated), hex);

  assert.equal(refHex(hex.slice(0, 63)), null);
  assert.equal(refHex("not an id"), null);
  assert.equal(refHex(null), null);
  assert.equal(refHex({}), null);
});

test("parseRefs keeps only the ids it can read", () => {
  const hex = "a".repeat(64);
  assert.deepEqual(parseRefs([hex, { junk: 1 }, null, hex]), [hex, hex]);
  assert.deepEqual(parseRefs("nope"), []);
});

test("needlesFrom keeps distinctive lines and drops the short ones", () => {
  const lines = ["NEEDLE-ALPHA-0001", "NEEDLE-ALPHA-0001", "short", "NEEDLE-BETA-0002"];
  assert.deepEqual(needlesFrom(lines), ["NEEDLE-ALPHA-0001", "NEEDLE-BETA-0002"]);
});

test("payload matching is byte-wise over UTF-8", () => {
  const payload = Buffer.from("Remember NEEDLE-ALPHA-0001 现在", "utf8");
  assert.equal(payloadHoldsNeedle(payload, ["NEEDLE-ALPHA-0001"]), true);
  assert.equal(payloadHoldsNeedle(payload, ["现在"]), true);
  assert.equal(payloadHoldsNeedle(payload, ["NEEDLE-GAMMA"]), false);
  assert.equal(payloadHoldsNeedle(payload, []), false);
});

test("planCompaction folds everything but the last keepTurns messages", () => {
  const messages = Array.from({ length: 10 }, (_, i) => user(`message ${i}`));
  const plan = planCompaction({ messages, compactedAt: 0, keepTurns: 2, previousSummary: "" });

  assert.ok(plan);
  assert.equal(plan.keepFrom, 8);
  assert.equal(plan.drop.length, 8);
  assert.match(plan.history, /message 0/);
  assert.doesNotMatch(plan.history, /message 9/);
});

test("planCompaction stops once there is nothing new to fold in", () => {
  const messages = Array.from({ length: 3 }, (_, i) => user(`message ${i}`));

  // Already compacted as far as the window allows.
  assert.equal(planCompaction({ messages, compactedAt: 2, keepTurns: 1, previousSummary: "s" }), undefined);
  // A keepTurns of 0 must not slice the window away entirely.
  assert.equal(planCompaction({ messages, compactedAt: 0, keepTurns: 0, previousSummary: "" })?.keepFrom, 2);
  // Nothing to render means nothing worth sending to the summariser.
  assert.equal(planCompaction({ messages: [], compactedAt: 0, keepTurns: 1, previousSummary: "" }), undefined);
});

test("planCompaction honours inclusive refRange inside the droppable window", () => {
  const messages = Array.from({ length: 6 }, (_, i) => user(`message ${i}`));
  const plan = planCompaction({
    messages,
    compactedAt: 0,
    keepTurns: 2,
    previousSummary: "",
    refRange: { startRef: "m00001", endRef: "m00003", startIndex: 1, endIndex: 3 },
  });
  assert.ok(plan);
  assert.equal(plan.drop.length, 3);
  assert.equal(plan.keepFrom, 4);
  assert.doesNotMatch(plan.history, /message 0/);
  assert.match(plan.history, /message 3/);
});

test("planCompaction folds the previous summary into the history, not into a new one", () => {
  const plan = planCompaction({
    messages: [user("the new part")],
    compactedAt: 0,
    keepTurns: 1,
    previousSummary: "earlier summary",
  });
  // keepTurns = 1 leaves nothing to drop, so this compaction never runs.
  assert.equal(plan, undefined);

  const later = planCompaction({
    messages: [user("one"), user("two"), user("three")],
    compactedAt: 0,
    keepTurns: 1,
    previousSummary: "earlier summary",
  });
  assert.ok(later);
  assert.match(later.history, /^earlier summary/);
  assert.match(later.history, /two/);
});

test("runCompaction refuses to touch the checkpoint when summarising fails", async () => {
  const calls: string[] = [];
  const store = {
    loadLatest: async () => {
      calls.push("load");
      return null;
    },
    saveCheckpoint: async () => {
      calls.push("save");
      return {};
    },
  };

  const messages = Array.from({ length: 6 }, (_, i) => user(`history line ${i} long enough`));
  const base = { store, agentId: "agent-x", cwd: NOWHERE, messages, compactedAt: 0, keepTurns: 1, previousSummary: "" };

  assert.equal(await runCompaction({ ...base, summarize: async () => { throw new Error("boom"); } }), undefined);
  assert.equal(await runCompaction({ ...base, summarize: async () => "   " }), undefined);
  // Neither failure may reach the store: a summary without a rewritten
  // checkpoint would inject text for context that was never dropped.
  assert.deepEqual(calls, []);
});

test("runCompaction refuses to inject a summary when the rewrite is refused", async () => {
  const messages = Array.from({ length: 6 }, (_, i) => user(`history line ${i} long enough`));
  const outcome = await runCompaction({
    store: { loadLatest: async () => null, saveCheckpoint: async () => ({}) },
    agentId: "agent-x",
    cwd: NOWHERE,
    messages,
    compactedAt: 0,
    keepTurns: 1,
    previousSummary: "",
    summarize: async () => "a fine summary",
  });
  assert.equal(outcome, undefined);
});

test("compactCheckpoint fails closed when no store can be found for the workspace", async () => {
  const ref = "a".repeat(64);
  const result = await compactCheckpoint({
    store: {
      // Passes the "is there anything to rewrite" gates, then cannot be located.
      loadLatest: async () => ({ turns: ["t1", "t2"], rootPromptMessagesJson: [ref] }),
      saveCheckpoint: async () => ({}),
    },
    agentId: "agent-x",
    cwd: NOWHERE,
    keepTurns: 1,
    needles: ["NEEDLE-ALPHA-0001"],
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /store/);
});

test("the summary prompt asks for a continuation summary and forbids new actions", () => {
  const messages = renderSummaryMessages({ history: "HISTORY BODY" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");

  const text = JSON.stringify(messages);
  assert.match(text, /continuation summary/);
  assert.match(text, /--- HISTORY ---/);
  assert.match(text, /HISTORY BODY/);
  assert.match(text, /do not take any new action/i);
  assert.match(text, /no preamble, no markdown fence/);
});

test("collectSummaryText takes only the text the user would read", async () => {
  async function* chunks() {
    yield { type: "text-delta", text: "kept " };
    yield { type: "reasoning-delta", text: "thinking out loud" };
    yield { type: "text-delta", text: "text" };
    yield { type: "usage", usage: {} };
  }
  assert.equal(await collectSummaryText(chunks()), "kept text");

  async function* empty() {
    /* no chunks */
  }
  assert.equal(await collectSummaryText(empty()), "");
  assert.equal(await collectSummaryText((async function* () { yield { type: "reasoning-delta", text: "x" }; })()), "");
});

test("cursorContextToolsWhen admits context tools only on the cursor route", () => {
  assert.equal(cursorContextToolsWhen({ modelSelection: { provider: "cursor" } }), true);
  assert.equal(cursorContextToolsWhen({ modelSelection: { provider: "deepseek" } }), false);
  assert.equal(cursorContextToolsWhen({}), false);
});

test("registerAcpContextPrompt registers runtime context only on cursor route", () => {
  const contexts: any[] = [];
  const ctx = {
    systemPrompt: {
      context: (entry: any) => {
        contexts.push(entry);
        return () => {};
      },
    },
  };
  registerAcpContextPrompt(ctx as any);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]!.name, "cursor:acp-context");
  assert.equal(contexts[0]!.text({ modelSelection: { provider: "deepseek" } }), "");
  assert.match(contexts[0]!.text({ modelSelection: { provider: "cursor" } }), /\[acp-context\]/);
});

test("acpContextSectionText includes marker and compress tools", () => {
  const text = acpContextSectionText();
  assert.match(text, /\[acp-context\]/);
  assert.match(text, /cursor_context_compress/);
});

test("acpSystemPromptAddition appends full acp standing prompt once", () => {
  const once = acpSystemPromptAddition("DSH agent rules");
  assert.match(once, /\[acp-context\]/);
  assert.match(once, /cursor_context_compress/);
  assert.match(once, /ACP TAGS/);
  assert.ok(once.length > "DSH agent rules".length + 200);
  assert.equal(acpSystemPromptAddition(once), once);
  assert.match(acpSystemPromptAddition(`x\n\n${ACP_SYSTEM_MARKER}\ny`), /\[acp-context\]/);
});

test("the summary prefix marks the block the next turn must carry", () => {
  assert.match(SUMMARY_PREFIX, /CONTEXT SUMMARY/);
});

test("summarizerModelKey distinguishes an explicit model from following the session", () => {
  assert.equal(summarizerModelKey("", ""), "*:*");
  assert.equal(summarizerModelKey("deepseek", ""), "deepseek:*");
  assert.equal(summarizerModelKey("deepseek", "deepseek-chat"), "deepseek:deepseek-chat");
  assert.notEqual(summarizerModelKey("", ""), summarizerModelKey("cursor", "cursor"));
});
