import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { compactCheckpoint } from "../src/context/checkpoint.ts";
import { readRequest } from "../src/transcript.ts";
import { renderTranscriptWithAcpView } from "../src/context/acp-wire.ts";
import { toCoreMessages, kernelTurnPlan, kernelApplyCompression, kernelAppliedRevision, kernelStatus, kernelResidentTokens } from "../src/context/kernel.ts";
import { syncMessageRefs, decompressChunk, ledgerStats } from "../src/context/ledger.ts";
import { scheduleModelCompress, clearAllPendingCompress } from "../src/context/pending.ts";
import { liveCursorSessions, closeAllCursorSessions, sessionSnapshot } from "../src/session.ts";
import { applyTierDistillation } from "../src/context/distill.ts";
import { CONTEXT_DEFAULTS } from "../src/ui-state.ts";
import { fakeCursor, adapterFor, text, sys, user, toolResult, say } from "./session-harness.ts";

const sid = () => `consistency-${randomUUID()}`;
const preserve = { preserveRecentMessages: 0, preserveRecentTokens: 0 };
const summary = "Selected older work is summarized here; unselected history and the recent task must remain verbatim.";
const long = (i: number) => `UNIQUE_ORIGINAL_${i}: ` + `${i} source-record `.repeat(500);
const history = () => Array.from({ length: 8 }, (_, i) => user(long(i)));
const compress = { name: "cursor_context_compress", description: "compress", parameters: { type: "object", properties: {} } };

function compactDeps(cursor: any, onDelete = () => {}) {
  return {
    store: { loadLatest: async () => null, saveCheckpoint: async () => ({}) },
    readBudget: () => CONTEXT_DEFAULTS, preserveConfig: () => preserve, resolveKeepTurns: () => 2,
    createAgent: cursor.createAgent, deleteAgent: async () => { onDelete(); },
  };
}
async function stream(adapter: any, sessionId: string, messages: any[], tools: any[] = []) {
  const chunks: any[] = [];
  for await (const c of adapter.stream({ provider: "cursor", model: "m", messages, tools, sessionId })) chunks.push(c);
  const blocks = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  return { text: blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""), assistant: { role: "assistant", content: blocks }, chunks };
}
afterEach(() => { closeAllCursorSessions(); clearAllPendingCompress(); });

const rawBatch = () => [
  user("A tool batch"),
  { role: "assistant", content: [{ type: "text", text: "I will inspect both" }, { type: "tool-call", id: "read-1", name: "read", arguments: '{"file_path":"a.ts"}' }, { type: "tool-call", id: "bash-2", name: "bash", arguments: '{"command":"pwd"}' }] },
  { role: "tool", source: { kind: "tool", callId: "read-1" }, content: text("FILE_A_RESULT " + "x".repeat(6000)) },
  { role: "tool", source: { kind: "tool", callId: "bash-2" }, content: text("PWD_RESULT") },
  user("Continue"),
];

test("raw and normalized paths preserve every call/result id and identical refs", () => {
  const raw = rawBatch();
  const normalized = readRequest({ messages: raw }).messages;
  assert.deepEqual(toCoreMessages(raw), toCoreMessages(normalized));
  const cores = toCoreMessages(raw);
  assert.deepEqual(cores.filter((m) => m.contentType === "tool-call").map((m) => m.toolCallId), ["read-1", "bash-2"]);
  assert.deepEqual(cores.filter((m) => m.contentType === "tool-result").map((m) => m.toolCallId), ["read-1", "bash-2"]);
  const session = sid();
  const a = syncMessageRefs(session, raw, { preserve });
  const b = syncMessageRefs(session, normalized, { preserve });
  assert.deepEqual(a.map((r) => [r.ref, r.fingerprint, r.index]), b.map((r) => [r.ref, r.fingerprint, r.index]));
  assert.equal(a.filter((r) => r.index === 1).length, 3);
  const rendered = renderTranscriptWithAcpView("SYSTEM", normalized, toCoreMessages(raw));
  assert.equal((rendered.match(/calls read \(read-1\)/g) ?? []).length, 1);
  assert.equal((rendered.match(/calls bash \(bash-2\)/g) ?? []).length, 1);
});

test("kernel pair expansion includes both parallel results, not just first metadata", () => {
  const session = sid();
  const raw = rawBatch();
  const plan = kernelTurnPlan(session, raw, 2000, 200000, { preserve });
  const first = plan.messageRefs.find((r) => r.index === 1 && r.text.startsWith("calls read"))!;
  // Include result one to pass minCompressRange. Pair expansion must pull in result two.
  kernelApplyCompression(session, raw, { startRef: first.ref, endRef: plan.messageRefs.find((r) => r.index === 2)!.ref, summary, revision: 1 }, 200000, preserve);
  const after = kernelTurnPlan(session, raw, 100, 200000, { preserve });
  assert.equal(after.wireMessages.some((m) => m.contentType === "tool-call"), false);
  assert.ok(after.coveredIndexes.has(2));
  assert.ok(after.coveredIndexes.has(3));
});

test("kernel rejection does not change revision/state or archive a tier merge", async () => {
  const session = sid();
  const messages = readRequest({ messages: history() }).messages;
  kernelTurnPlan(session, messages, 10000, 200000, { preserve });
  assert.throws(() => kernelApplyCompression(session, messages, { startRef: "b99998", endRef: "b99999", summary, revision: 99 }, 200000, preserve), /rejected/);
  assert.equal(kernelAppliedRevision(session), 0);
  assert.equal(kernelStatus(session, 200000, 100, preserve).activeBlocks, 0);
  await assert.rejects(applyTierDistillation({ sessionKey: session, messages, summary, revision: 100, contextWindowTokens: 200000, preserve, plan: { tier: 2, startRef: "b99998", endRef: "b99999", sourceText: "old summaries", topic: "t2:auto", blocks: [] } }), /rejected/);
  assert.equal(ledgerStats(session).chunks, 0);
  assert.equal(kernelAppliedRevision(session), 0);
});

test("M2 handoff replays system, retained tool context, tail and image exactly once", async () => {
  const session = sid();
  let deletes = 0;
  const cursor = fakeCursor(async function* (ctx) {
    const body = typeof ctx.msg === "string" ? ctx.msg : ctx.msg.text;
    if (body.includes("Context compressed")) { yield say("HANDOFF_REPLAY_OK"); return; }
    await ctx.callTool(compress.name, {}, "compress-call");
  });
  const adapter = adapterFor(cursor, { compact: compactDeps(cursor, () => deletes++), readImage: async () => ({ data: "TAIL_IMAGE_BYTES", mimeType: "image/png" }) });
  const tail = { ...user("TAIL_ONLY_SECRET_7788"), content: [...text("TAIL_ONLY_SECRET_7788"), { type: "image", attachment: { attachmentId: "tail-image" } }] };
  const base = [sys("SYSTEM_MUST_SURVIVE_1111"), ...history(), tail];
  const r1 = await stream(adapter, session, base, [compress]);
  scheduleModelCompress(session, summary, { keepTurns: 4 });
  const r2 = await stream(adapter, session, [...base, r1.assistant, toolResult("compress-call", "compression scheduled")], [compress]);
  assert.equal(r2.text, "HANDOFF_REPLAY_OK");
  assert.equal(deletes, 1);
  const replay = cursor.sends.at(-1);
  assert.match(replay.text, /SYSTEM_MUST_SURVIVE_1111/);
  assert.match(replay.text, /TAIL_ONLY_SECRET_7788/);
  assert.match(replay.text, /compression scheduled/);
  assert.match(replay.text, /Only the tools attached/);
  assert.equal((replay.text.match(/TAIL_ONLY_SECRET_7788/g) ?? []).length, 1);
  assert.deepEqual(replay.images, [{ data: "TAIL_IMAGE_BYTES", mimeType: "image/png" }]);
});

test("idle M2 subrange preserves unselected prefix; archive refs/body and budget match kernel coverage", async () => {
  const session = sid();
  const cursor = fakeCursor(async function* () { yield say("OK"); });
  const adapter = adapterFor(cursor, { compact: compactDeps(cursor) });
  const base = [sys("SYSTEM_IDLE_999"), ...history()];
  const first = await stream(adapter, session, base);
  const messages1 = [...base, first.assistant, user("AFTER_MIDDLE_COMPRESS")];
  const normalized1 = readRequest({ messages: messages1 }).messages;
  const refs = syncMessageRefs(session, normalized1, { preserve });
  const ref0 = refs.find((r) => r.index === 0)!.ref;
  const ref2 = refs.find((r) => r.index === 2)!.ref;
  const ref3 = refs.find((r) => r.index === 3)!.ref;
  scheduleModelCompress(session, summary, { keepTurns: 2, startRef: ref2, endRef: ref3 });
  const second = await stream(adapter, session, messages1);
  assert.equal(second.text, "OK");
  const live = liveCursorSessions(session)[0]!;
  assert.equal(live.compactedAt, 0, "middle coverage is not a prefix cursor");
  assert.equal(decompressChunk({ sessionId: session, ref: ref0 }), undefined);
  const archived = decompressChunk({ sessionId: session, ref: ref2, limit: 32000 })!;
  assert.match(archived.text, /UNIQUE_ORIGINAL_2/);
  assert.match(archived.text, /UNIQUE_ORIGINAL_3/);
  assert.doesNotMatch(archived.text, /UNIQUE_ORIGINAL_0/);
  const replay = typeof cursor.sends.at(-1) === "string" ? cursor.sends.at(-1) : cursor.sends.at(-1).text;
  assert.match(replay, /SYSTEM_IDLE_999/);
  assert.match(replay, /UNIQUE_ORIGINAL_0/);
  assert.match(replay, /UNIQUE_ORIGINAL_1/);
  assert.doesNotMatch(replay, /UNIQUE_ORIGINAL_2/);
  assert.doesNotMatch(replay, /UNIQUE_ORIGINAL_3/);
  assert.equal((replay.match(/AFTER_MIDDLE_COMPRESS/g) ?? []).length, 1);
  const budget = kernelResidentTokens(session, normalized1, "SYSTEM_IDLE_999", [], 200000);
  assert.ok(budget > 9000, "unselected prefix still contributes to resident budget");
  const snap = sessionSnapshot(session, normalized1, "SYSTEM_IDLE_999", [], "m", preserve);
  assert.equal(snap.retainedMessages, normalized1.length - 2);
  assert.ok(snap.estimatedRetainedTokens! >= budget);
  // Verify persisted coverage/archive in another process, not the warm in-memory maps.
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { readFileSync } from "node:fs";
    import { kernelTurnPlan, kernelResidentTokens } from ${JSON.stringify(new URL("../src/context/kernel.ts", import.meta.url).href)};
    import { decompressChunk } from ${JSON.stringify(new URL("../src/context/ledger.ts", import.meta.url).href)};
    const { session, messages, ref } = JSON.parse(readFileSync(0, "utf8"));
    const plan = kernelTurnPlan(session, messages, 10000, 200000, { preserve: { preserveRecentMessages: 0, preserveRecentTokens: 0 } });
    console.log(JSON.stringify({ prefix: plan.compactedPrefix, covered: [...plan.coveredIndexes], archive: decompressChunk({ sessionId: session, ref, limit: 32000 })?.text, budget: kernelResidentTokens(session, messages, "SYSTEM_IDLE_999", [], 200000) }));
  `], { input: JSON.stringify({ session, messages: normalized1, ref: ref2 }), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const cold = JSON.parse(child.stdout);
  assert.equal(cold.prefix, 0); assert.deepEqual(cold.covered, [2, 3]);
  assert.match(cold.archive, /UNIQUE_ORIGINAL_2/); assert.doesNotMatch(cold.archive, /UNIQUE_ORIGINAL_0/);
  assert.ok(cold.budget > 9000);
  // A second, disjoint range closes the hole without dropping the earlier block.
  const messages2 = [...messages1, second.assistant, user("CLOSE_PREFIX_HOLE")];
  const n2 = readRequest({ messages: messages2 }).messages;
  const refs2 = syncMessageRefs(session, n2, { preserve });
  scheduleModelCompress(session, "Prefix messages zero and one summarized separately; the earlier middle summary stays available.", { keepTurns: 2, startRef: refs2.find((r) => r.index === 0)!.ref, endRef: refs2.find((r) => r.index === 1)!.ref });
  await stream(adapter, session, messages2);
  assert.equal(liveCursorSessions(session)[0]!.compactedAt, 4);
  assert.match(decompressChunk({ sessionId: session, ref: ref0, limit: 32000 })!.text, /UNIQUE_ORIGINAL_0/);
  assert.equal(ledgerStats(session).chunks, 2);
});

test("a rejected model compression neither rebuilds nor records success nor cancels continuation", async () => {
  const session = sid();
  let deletes = 0;
  const cursor = fakeCursor(async function* (ctx) { await ctx.callTool(compress.name, {}, "short-call"); yield say("CONTINUED_WITHOUT_COMPRESSION"); });
  const adapter = adapterFor(cursor, { compact: compactDeps(cursor, () => deletes++) });
  const base = [sys("SYSTEM"), ...history()];
  const first = await stream(adapter, session, base, [compress]);
  scheduleModelCompress(session, "x".repeat(40), { keepTurns: 2 }); // host accepts >=32; kernel requires 50
  const second = await stream(adapter, session, [...base, first.assistant, toolResult("short-call", "scheduled")], [compress]);
  assert.equal(second.text, "CONTINUED_WITHOUT_COMPRESSION");
  assert.equal(deletes, 0);
  assert.equal(cursor.created.length, 1);
  assert.equal(kernelAppliedRevision(session), 0);
  assert.equal(liveCursorSessions(session)[0]!.appliedViewRevision, 0);
  assert.equal(ledgerStats(session).chunks, 0);
});


test("mixed checkpoint blobs force M2 without losing retained system/tail; separable blobs still use M3", async () => {
  const cwd = `/checkpoint-fixture-${randomUUID()}`;
  const dir = join(homedir(), ".cursor", "projects", cwd.slice(1), "sdk-agent-store");
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(join(dir, "store.db"));
  db.exec("create table blobs (id text primary key, data blob)");
  const old = "OLD_SOURCE_TO_COMPRESS_123456789";
  const keep = "SYSTEM_AND_TAIL_MUST_STAY_123456789";
  const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
  const insert = db.prepare("insert into blobs values (?, ?)");
  insert.run(a, Buffer.from(`${old} ${keep}`));
  insert.run(b, Buffer.from(old)); insert.run(c, Buffer.from(keep)); db.close();
  let state: any = { turns: [1, 2, 3], rootPromptMessagesJson: [a] };
  let saves = 0;
  const store = { loadLatest: async () => structuredClone(state), saveCheckpoint: async (_: string, next: unknown) => { saves++; state = next; } };
  const mixed = await compactCheckpoint({ store, agentId: "fake", cwd, keepTurns: 1, needles: [old], keepNeedles: [keep] });
  assert.equal(mixed.ok, false); assert.match(mixed.reason!, /mixes/);
  assert.equal(saves, 0); assert.deepEqual(state.rootPromptMessagesJson, [a]);
  state.rootPromptMessagesJson = [b, c];
  const separate = await compactCheckpoint({ store, agentId: "fake", cwd, keepTurns: 1, needles: [old], keepNeedles: [keep] });
  assert.equal(separate.ok, true); assert.equal(saves, 1);
  assert.deepEqual(state.rootPromptMessagesJson, [c]); assert.deepEqual(state.turns, [3]);
});

test("transport refusal leaves staged kernel coverage, archive and success revision unpublished", async () => {
  const session = sid();
  const cursor = fakeCursor(async function* () { yield say("STILL_RUNNING"); });
  const deps = { ...compactDeps(cursor), deleteAgent: async () => { throw new Error("mock transport refusal"); } };
  const adapter = adapterFor(cursor, { compact: deps });
  const base = [sys("SYSTEM_TRANSPORT_REFUSAL"), ...history()];
  const first = await stream(adapter, session, base);
  scheduleModelCompress(session, summary, { keepTurns: 2 });
  const next = [...base, first.assistant, user("NEXT_TASK")];
  await stream(adapter, session, next);
  assert.equal(cursor.created.length, 1);
  assert.equal(kernelAppliedRevision(session), 0);
  assert.equal(kernelTurnPlan(session, readRequest({ messages: next }).messages, 1000, 200000, { preserve }).coveredCoreIds.size, 0);
  assert.equal(liveCursorSessions(session)[0]!.appliedViewRevision, 0);
  assert.equal(ledgerStats(session).chunks, 0);
});
