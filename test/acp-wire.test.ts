import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAcpWireView, renderTranscriptWithAcpView } from "../src/context/acp-wire.ts";
import { fingerprint } from "../src/prompt.ts";

test("renderTranscriptWithAcpView uses truncated tool-result bodies from the acp view", () => {
  const raw = [
    { role: "user", content: "run" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } }],
    },
    { role: "tool", toolCallId: "c1", toolName: "bash", content: "x".repeat(5000) },
  ];
  const fp = fingerprint(raw[2]!);
  const view = buildAcpWireView([
    { id: fingerprint(raw[0]!), role: "user", contentType: "text", text: '<acp tokens="1" type="text">m00001</acp>\nrun' },
    { id: fingerprint(raw[1]!), role: "assistant", contentType: "tool-call", text: "", toolName: "bash", toolCallId: "c1" },
    { id: fp, role: "tool", contentType: "tool-result", text: "[truncated 4200 chars]", toolName: "bash", toolCallId: "c1" },
  ]);
  const text = renderTranscriptWithAcpView("SYS", raw, view.messages);
  assert.match(text, /\[truncated 4200 chars\]/);
  assert.doesNotMatch(text, /x{100}/);
  assert.match(text, /<acp /);
});
