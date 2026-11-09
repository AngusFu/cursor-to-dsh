import { test } from "node:test";
import assert from "node:assert/strict";

import { renderTierDistillMessages } from "../src/context/distill.ts";
import { TIER2_DISTILL_RULES } from "acp-kernel";

test("renderTierDistillMessages embeds tier-2 rules", () => {
  const msgs = renderTierDistillMessages(2, "block a\n\nblock b");
  const blocks = msgs[0]?.content;
  const text = Array.isArray(blocks) ? String((blocks[0] as { text?: string })?.text ?? "") : "";
  assert.ok(text.includes(TIER2_DISTILL_RULES.slice(0, 40)));
  assert.ok(text.includes("block a"));
});
