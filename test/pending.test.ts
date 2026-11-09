import { test } from "node:test";
import assert from "node:assert/strict";

import { clearAllPendingCompress, peekModelCompress, scheduleModelCompress, takeModelCompress } from "../src/context/pending.ts";

test("scheduleModelCompress is consumed once per session", () => {
  clearAllPendingCompress();
  const first = scheduleModelCompress("sess-a", "summary text long enough to count", { keepTurns: 2 });
  assert.equal(first.revision, 1);
  assert.deepEqual(peekModelCompress("sess-a"), first);
  const taken = takeModelCompress("sess-a");
  assert.equal(taken?.revision, 1);
  assert.equal(peekModelCompress("sess-a"), undefined);
});

test("revisions increase across sessions", () => {
  clearAllPendingCompress();
  const a = scheduleModelCompress("s1", "x".repeat(40), { keepTurns: 1 });
  const b = scheduleModelCompress("s2", "y".repeat(40), { keepTurns: 1 });
  assert.ok(b.revision > a.revision);
});
