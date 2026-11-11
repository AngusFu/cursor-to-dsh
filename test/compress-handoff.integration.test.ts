/**
 * Fake Cursor session: compress tool-call batch → M2 handoff → checkpoint commit markers.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

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
import { CONTEXT_DEFAULTS } from "../src/ui-state.ts";
import { closeAllCursorSessions, liveCursorSessions } from "../src/session.ts";
import { resetCursorOverhead } from "../src/usage.ts";

import { fakeCursor, adapterFor, nextId, text, sys, user, toolResult } from "./session-harness.ts";

const SESSION = `sess-handoff-integration-${process.pid}-${Date.now()}`;
const SUMMARY =
  "Continuation: six turns of Q&A about ALPHA codes were folded; tail questions stay verbatim for the model.";
const compressTool = {
  name: COMPRESS_TOOL_NAME,
  description: "compress",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      keepTurns: { type: "integer" },
    },
  },
};

function longHistory() {
  const messages: any[] = [sys("SYS")];
  for (let i = 0; i < 6; i++) {
    messages.push(user(`question ${i}: track ALPHA-NEEDLE-${i} in the codebase please ${"source ".repeat(1000)}`));
    messages.push({
      id: nextId(),
      role: "assistant",
      content: text(`acknowledged ALPHA-NEEDLE-${i}`),
      source: { kind: "model", provider: "cursor", model: "m" },
    });
  }
  return messages;
}

async function stream(adapter: CursorAdapter, messages: any[]) {
  const chunks: any[] = [];
  for await (const c of adapter.stream({
    provider: "cursor",
    model: "m",
    messages,
    tools: [compressTool],
    sessionId: SESSION,
  })) {
    chunks.push(c);
  }
  const blocks = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  const assistant = {
    id: nextId(),
    role: "assistant",
    content: blocks,
    source: { kind: "model", provider: "cursor", model: "m" },
  };
  return {
    chunks,
    finish: chunks.at(-1)?.reason,
    assistant,
    text: blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""),
    calls: blocks.filter((b: any) => b.type === "tool-call"),
  };
}

beforeEach(() => {
  closeAllCursorSessions();
  clearAllPendingCompress();
  clearLedgers();
  clearKernelSessions();
  resetCursorOverhead();
});

test("compress tool batch triggers handoff commit (M2 fallback) and clears pending", async () => {
  let deleteCalls = 0;
  const cursor = fakeCursor(async function* (ctx) {
    const body = typeof ctx.msg === "string" ? ctx.msg : ctx.msg?.text ?? "";
    if (body.includes(SUMMARY_PREFIX) || body.includes("Context compressed")) {
      yield { type: "assistant", message: { content: [{ type: "text", text: "HANDOFF_OK" }] } };
      return;
    }
    yield { type: "assistant", message: { content: [{ type: "text", text: "scheduling" }] } };
    await ctx.callTool(COMPRESS_TOOL_NAME, { summary: SUMMARY, keepTurns: 2 }, "compress-1");
  });

  const compact = {
    store: {
      loadLatest: async () => null,
      saveCheckpoint: async () => ({}),
    },
    readBudget: () => CONTEXT_DEFAULTS,
    preserveConfig: () => ({ preserveRecentMessages: 5, preserveRecentTokens: 5000 }),
    resolveKeepTurns: () => 2,
    createAgent: cursor.createAgent,
    deleteAgent: async () => {
      deleteCalls += 1;
    },
  };

  const adapter = adapterFor(cursor, { compact });
  const base = longHistory();
  const u1 = user("call cursor_context_compress now");

  const r1 = await stream(adapter, [...base, u1]);
  assert.deepEqual(r1.finish, { kind: "tool-calls" });
  assert.equal(r1.calls.length, 1);
  assert.equal(r1.calls[0]!.name, COMPRESS_TOOL_NAME);

  scheduleModelCompress(SESSION, SUMMARY, { keepTurns: 2 });
  assert.ok(peekModelCompress(SESSION));

  const toolMsg = toolResult("compress-1", JSON.stringify({ status: "scheduled", revision: peekModelCompress(SESSION)!.revision }));
  const r2 = await stream(adapter, [...base, u1, r1.assistant, toolMsg]);
  assert.equal(r2.text, "HANDOFF_OK");
  assert.deepEqual(r2.finish, { kind: "stop" });

  const live = liveCursorSessions(SESSION)[0];
  assert.ok(live, "session still live");
  assert.ok(live!.compactedAt > 0, "compactedAt advanced");
  assert.ok(live!.appliedViewRevision > 0, "revision applied");
  assert.ok(live!.summary.includes("Continuation"), "summary stored on session");
  assert.equal(peekModelCompress(SESSION), undefined, "pending cleared");
  assert.ok(deleteCalls >= 1, "M2 deleteAgent ran when M3 store absent");
  assert.ok(cursor.sends.some((s) => typeof s === "string" && s.includes(SUMMARY)), "handoff replay carried the accepted kernel summary");
});
