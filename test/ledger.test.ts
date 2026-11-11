import { test } from "node:test";
import assert from "node:assert/strict";

import {
  archiveCompression,
  clearLedgers,
  compressibleRefs,
  decompressChunk,
  refsInRange,
  resolveCompressRefRange,
  searchArchive,
  syncMessageRefs,
} from "../src/context/ledger.ts";

import { isolateLedgerHome } from "./isolate-ledger-home.ts";

isolateLedgerHome("cursor-ledger-test-");

const messages = () => [
  { role: "user", content: "alpha question" },
  { role: "assistant", content: "alpha answer" },
  { role: "user", content: "beta question" },
];

test("resolveCompressRefRange clamps endRef past preserveKeepFrom", () => {
  clearLedgers();
  const sessionId = `ledger-clamp-${Date.now()}`;
  const msgs = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `msg ${i}` }));
  const allRefs = syncMessageRefs(sessionId, msgs, { contextWindow: 200_000 });
  const keepFrom = 6;
  const droppable = new Set(compressibleRefs(sessionId, 0, keepFrom).map((r) => r.ref));
  const resolved = resolveCompressRefRange(
    sessionId,
    allRefs[0]!.ref,
    allRefs[allRefs.length - 1]!.ref,
    0,
    keepFrom,
    droppable,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.refRange.startRef, allRefs[0]!.ref);
  assert.equal(resolved.refRange.endRef, allRefs[5]!.ref);
  assert.ok(resolved.clamped);
  assert.match(resolved.clamped!.reason, /clamped/);
});

test("resolveCompressRefRange returns reason when nothing droppable", () => {
  clearLedgers();
  const sessionId = `ledger-empty-${Date.now()}`;
  const msgs = [{ role: "user", content: "only tail" }];
  syncMessageRefs(sessionId, msgs, { contextWindow: 200_000 });
  const droppable = new Set<string>();
  const resolved = resolveCompressRefRange(sessionId, "m00001", "m00001", 0, 0, droppable);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /no droppable/);
});

test("syncMessageRefs assigns stable refs and range lookup", () => {
  clearLedgers();
  const sessionId = `ledger-sync-${Date.now()}`;
  const refs = syncMessageRefs(sessionId, messages(), { contextWindow: 200_000 });
  assert.equal(refs.length, 3);
  assert.match(refs[0]!.ref, /^m\d{5}$/);
  const span = refsInRange(sessionId, refs[0]!.ref, refs[1]!.ref);
  assert.equal(span?.length, 2);
  assert.equal(span?.[0]?.index, 0);
});

test("archive search and decompress paginate dropped text", () => {
  clearLedgers();
  const sessionId = `ledger-archive-${Date.now()}`;
  const refs = syncMessageRefs(sessionId, messages(), { contextWindow: 200_000 });
  const dropRefs = refs.slice(0, 2).map((r) => r.ref);
  const dropText = "alpha question\n\nalpha answer";
  const chunk = archiveCompression({
    sessionId,
    revision: 1,
    summary: "folded alpha",
    dropRefs,
    dropText,
  });
  assert.equal(chunk.messageRefs.length, 2);

  const hits = searchArchive(sessionId, "alpha answer", 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.chunkId, chunk.id);

  const page = decompressChunk({ sessionId, chunkId: chunk.id, limit: 20 });
  assert.ok(page);
  assert.equal(page!.text, dropText.slice(0, 20));
  assert.equal(page!.hasMore, dropText.length > 20);
});
