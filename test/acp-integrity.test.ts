import { test } from "node:test";
import assert from "node:assert/strict";

import { computeIntegrityWithdrawals } from "../src/context/acp-integrity.ts";
import type { CoreMessage } from "acp-kernel";

test("computeIntegrityWithdrawals keeps tool-call and tool-result paired", () => {
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "go" },
    { id: "c1", role: "assistant", contentType: "tool-call", text: "call", toolName: "read", toolCallId: "tc1" },
    { id: "r1", role: "tool", contentType: "tool-result", text: "body", toolName: "read", toolCallId: "tc1" },
    { id: "u2", role: "user", contentType: "text", text: "next" },
  ];
  const folded = new Set(["c1"]);
  const out = computeIntegrityWithdrawals(messages, folded);
  assert.ok(out.withdrawn.has("c1"));
  assert.ok(out.withdrawn.has("r1"));
  assert.equal(out.splitPairCount, 1);
});
