import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearContextFillSnapshots,
  getContextFillSnapshot,
  setContextFillSnapshot,
} from "../src/context/fill-cache.ts";

test("context fill cache round-trips by session id", () => {
  clearContextFillSnapshots();
  const id = `fill-${Date.now()}`;
  setContextFillSnapshot({
    sessionId: id,
    modelId: "claude-haiku-5-5",
    percent: 42,
    retainedTokens: 84_000,
    limitTokens: 200_000,
    viewPending: false,
    updatedAt: Date.now(),
  });
  const snap = getContextFillSnapshot(id);
  assert.equal(snap?.percent, 42);
  assert.equal(snap?.retainedTokens, 84_000);
  clearContextFillSnapshots();
  assert.equal(getContextFillSnapshot(id), undefined);
});
