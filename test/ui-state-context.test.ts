import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_DEFAULTS,
  migrateLegacyContextSettings,
  readContextManagement,
  resetOverlay,
} from "../src/ui-state.ts";

test("readContextManagement maps legacy keepTurns to preserveRecentMessages", () => {
  resetOverlay();
  const merged = readContextManagement({ contextManagement: { keepTurns: 3 } });
  assert.equal(merged.preserveRecentMessages, 3);
  assert.equal(merged.preserveRecentTokens, CONTEXT_DEFAULTS.preserveRecentTokens);
  assert.equal(merged.outputReserve, CONTEXT_DEFAULTS.outputReserve);
});

test("migrateLegacyContextSettings rewrites persisted doc without legacy keys", async () => {
  resetOverlay();
  let saved: Record<string, unknown> | undefined;
  const ctx = {
    get: (name: string) =>
      name === "settings"
        ? {
            read: async () => ({
              contextManagement: {
                enabled: false,
                budgetTokens: 180_000,
                keepTurns: 2,
                summarizerProvider: "openai",
                summarizerModel: "gpt",
              },
            }),
            update: async (_ns: string, patch: Record<string, unknown>) => {
              saved = patch;
            },
          }
        : undefined,
    meta: { id: "cursor-to-dsh" },
  };
  const changed = await migrateLegacyContextSettings(ctx, {});
  assert.equal(changed, true);
  assert.ok(saved?.contextManagement);
  const cm = saved!.contextManagement as Record<string, unknown>;
  assert.equal(cm.enabled, false);
  assert.ok(!("keepTurns" in cm));
  assert.ok(!("budgetTokens" in cm));
  assert.equal(cm.preserveRecentMessages, CONTEXT_DEFAULTS.preserveRecentMessages);
});

test("readContextManagement defaults enabled to false", () => {
  resetOverlay();
  assert.equal(readContextManagement({}).enabled, false);
  assert.equal(readContextManagement({ contextManagement: { enabled: true } }).enabled, true);
});
