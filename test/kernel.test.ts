import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearKernelSessions,
  kernelNudgeForTurn,
  kernelTurnPlan,
  toCoreMessages,
} from "../src/context/kernel.ts";
import { clearLedgers } from "../src/context/ledger.ts";

import { isolateLedgerHome } from "./isolate-ledger-home.ts";

isolateLedgerHome("cursor-kernel-test-");

test("toCoreMessages maps DSH roles and text", () => {
  const cores = toCoreMessages([
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
  assert.equal(cores.length, 2);
  assert.equal(cores[0]!.role, "user");
  assert.match(cores[0]!.text ?? "", /hello/);
});

test("toCoreMessages pairs tool-call id on assistant messages", () => {
  const cores = toCoreMessages([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
    },
    { role: "tool", toolCallId: "call-1", toolName: "read", content: "ok" },
  ]);
  assert.equal(cores[0]!.contentType, "tool-call");
  assert.equal(cores[0]!.toolCallId, "call-1");
  assert.equal(cores[1]!.contentType, "tool-result");
  assert.equal(cores[1]!.toolCallId, "call-1");
});

test("kernelNudgeForTurn returns undefined on a tiny transcript", () => {
  clearKernelSessions();
  clearLedgers();
  const nudge = kernelNudgeForTurn(`k-test-${Date.now()}`, [{ role: "user", content: "hi" }], 100, 200_000);
  assert.equal(nudge, undefined);
});

test("kernelTurnPlan emits text-only acp tags for user messages", () => {
  clearKernelSessions();
  clearLedgers();
  const sid = `k-tags-${Date.now()}`;
  const messages = [{ role: "user", content: "hello acp wire" }];
  const plan = kernelTurnPlan(sid, messages, 500, 200_000);
  assert.ok(plan.wireMessages.length >= 1);
  assert.ok(plan.taggedTextByFingerprint.size >= 1);
  const fp = [...plan.taggedTextByFingerprint.keys()][0]!;
  const tagged = plan.taggedTextByFingerprint.get(fp)!;
  assert.match(tagged, /<acp /);
  assert.match(tagged, /hello acp wire/);
});
