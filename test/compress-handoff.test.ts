import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPRESS_TOOL_NAME } from "../src/context/names.ts";
import {
  peekModelCompress,
  rescheduleModelCompress,
  scheduleModelCompress,
  takeModelCompress,
} from "../src/context/pending.ts";
import { runHostCompaction } from "../src/context/compact.ts";
import { batchIncludesCompress } from "../src/session.ts";

test("batchIncludesCompress detects the compress tool in a result batch", () => {
  const results = [
    {
      call: { id: "c1", name: "read", args: {}, handed: true, resolve: () => {} },
      message: { content: "ok" },
    },
    {
      call: { id: "c2", name: COMPRESS_TOOL_NAME, args: {}, handed: true, resolve: () => {} },
      message: { content: "scheduled" },
    },
  ] as any;
  assert.equal(batchIncludesCompress(results), true);
  assert.equal(
    batchIncludesCompress([{ call: { id: "c1", name: "read", args: {}, handed: true, resolve: () => {} }, message: {} }] as any),
    false,
  );
});

test("compress pending survives take and reschedule", () => {
  const sessionId = `handoff-pending-${Date.now()}`;
  const summary = "continuation summary with enough detail for the compress tool";
  const first = scheduleModelCompress(sessionId, summary, { keepTurns: 2, startRef: "m00001", endRef: "m00002" });
  assert.equal(peekModelCompress(sessionId)?.revision, first.revision);
  const taken = takeModelCompress(sessionId);
  assert.equal(taken?.summary, summary);
  assert.equal(peekModelCompress(sessionId), undefined);
  rescheduleModelCompress(sessionId, taken!);
  assert.equal(peekModelCompress(sessionId)?.revision, first.revision);
});

test("runHostCompaction rejects empty needles without touching the store", async () => {
  const calls: string[] = [];
  const outcome = await runHostCompaction({
    store: {
      loadLatest: async () => {
        calls.push("load");
        return { turns: ["t1"], rootPromptMessagesJson: [] };
      },
      saveCheckpoint: async () => {
        calls.push("save");
        return {};
      },
    },
    agentId: "agent-handoff",
    cwd: "/tmp/nowhere-handoff",
    keepTurns: 1,
    summary: "folded prefix with enough continuation detail for the model",
    keepFrom: 4,
    needles: [],
  });
  assert.equal(outcome, undefined);
  assert.deepEqual(calls, []);
});
