import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendImagePlaceholders,
  archiveSessionImages,
  describeRestorable,
  imagePlaceholdersForSummary,
  imageRestoreMode,
  messageImageBytes,
  pathWithinRoot,
  pruneRetrieveImgExports,
  resetImageRestoreForTests,
  resolveImageRestore,
  restoreExportDir,
  setImageRestoreRoot,
  writeRestoredImage,
  type RestorableImage,
} from "../src/context/image-restore.ts";
import { archiveCompression, clearLedgers, decompressChunk, searchArchive } from "../src/context/ledger.ts";
import { resetLedgerDb } from "../src/context/ledger-persist.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const pngImg: RestorableImage = { mediaType: "image/png", b64: PNG, bytes: Buffer.byteLength(PNG, "base64"), width: 1, height: 1 };

const previousHome = process.env.HOME;

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cursor-img-${label}-`));
  process.env.HOME = root;
  return root;
}

afterEach(() => {
  resetImageRestoreForTests();
  clearLedgers();
  resetLedgerDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

function userWithImage(data: string, mimeType = "image/png", text = "see this") {
  return { role: "user", content: [{ type: "text", text }, { type: "image", data, mimeType }] };
}

test("imageRestoreMode: blank/null is text paging; non-string is an error; list and mNNNNN select image mode", () => {
  assert.deepEqual(imageRestoreMode(undefined), { mode: "text" });
  assert.deepEqual(imageRestoreMode(null), { mode: "text" });
  assert.deepEqual(imageRestoreMode(""), { mode: "text" });
  assert.deepEqual(imageRestoreMode("   "), { mode: "text" });
  assert.equal(imageRestoreMode(42).mode, "error");
  assert.match((imageRestoreMode(42) as { message: string }).message, /must be a string/);
  assert.deepEqual(imageRestoreMode("list"), { mode: "image", ref: "list" });
  assert.deepEqual(imageRestoreMode(" m00042 "), { mode: "image", ref: "m00042" });
});

test("messageImageBytes reads transcript data, data URLs, and skips stamps without bytes", () => {
  const withData = messageImageBytes(userWithImage(PNG));
  assert.equal(withData.length, 1);
  assert.equal(withData[0]!.b64, PNG);
  assert.equal(withData[0]!.width, 1);
  assert.equal(withData[0]!.height, 1);

  const dataUrl = messageImageBytes(userWithImage(`data:image/png;base64,${PNG}`));
  assert.equal(dataUrl[0]!.b64, PNG);
  assert.equal(dataUrl[0]!.mediaType, "image/png");

  const stamp = messageImageBytes({
    role: "user",
    content: [{ type: "image", attachment: { attachmentId: "a1", mediaType: "image/png", width: 8, height: 6 } }],
  });
  assert.equal(stamp.length, 0);

  const tool = messageImageBytes({
    role: "toolResult",
    content: [
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "image", data: GIF, mimeType: "image/gif" },
    ],
  });
  assert.equal(tool.length, 2);
  assert.equal(tool[1]!.mediaType, "image/gif");
});

test("placeholders include mNNNNN only when the image is restorable", () => {
  const notes = imagePlaceholdersForSummary(userWithImage(PNG), "m00042", [true]);
  assert.deepEqual(notes, ["[image: png 1x1 · m00042]"]);
  const stamps = imagePlaceholdersForSummary(
    { role: "user", content: [{ type: "image", attachment: { mediaType: "image/png", width: 8, height: 6 } }] },
    "m00042",
    [false],
  );
  assert.deepEqual(stamps, ["[image: png 8x6]"]);
});

test("writeRestoredImage: 0600, content-hash skip-if-exists, multi-image suffix, rebase does not serve stale pixels", () => {
  const root = tempRoot("write");
  const p = writeRestoredImage("m00042", 0, pngImg, "sess-A", root);
  assert.ok(p && /m00042-[0-9a-f]{8}\.png$/.test(p.replace(/\\/g, "/")), p);
  assert.ok(p!.startsWith(restoreExportDir("sess-A", root)));
  assert.deepEqual(readFileSync(p!), Buffer.from(PNG, "base64"));
  if (process.platform !== "win32") assert.equal(statSync(p!).mode & 0o777, 0o600);
  const p2 = writeRestoredImage("m00042", 1, pngImg, "sess-A", root);
  assert.ok(/m00042-1-[0-9a-f]{8}\.png$/.test(p2!.replace(/\\/g, "/")));
  assert.equal(writeRestoredImage("m00042", 0, pngImg, "sess-A", root), p);

  const PNG2 = PNG.slice(0, -8) + "YPhfDw" + PNG.slice(-2);
  const gen2 = writeRestoredImage("m00001", 0, { ...pngImg, b64: PNG2, bytes: Buffer.byteLength(PNG2, "base64") }, "sess-rebase", root);
  const gen1 = writeRestoredImage("m00001", 0, pngImg, "sess-rebase", root);
  assert.notEqual(gen1, gen2);
  assert.deepEqual(readFileSync(gen1!), Buffer.from(PNG, "base64"));
  assert.deepEqual(readFileSync(gen2!), Buffer.from(PNG2, "base64"));
});

test("cross-session isolation: same ref number never shares a directory or pixels", () => {
  const root = tempRoot("iso");
  const pa = writeRestoredImage("m00001", 0, pngImg, "conv-alpha", root)!;
  const gif: RestorableImage = { mediaType: "image/gif", b64: GIF, bytes: Buffer.byteLength(GIF, "base64") };
  const pb = writeRestoredImage("m00001", 0, gif, "conv-beta", root)!;
  assert.notEqual(pa, pb);
  assert.ok(pa.includes(join("retrieve", "img", "conv-alpha")));
  assert.ok(pb.includes(join("retrieve", "img", "conv-beta")));
  assert.equal(pathWithinRoot(restoreExportDir("conv-alpha", root), pb), undefined);
  assert.deepEqual(readFileSync(pa), Buffer.from(PNG, "base64"));
  assert.deepEqual(readFileSync(pb), Buffer.from(GIF, "base64"));
});

test("archive + restore: bytes recover to a host path; list, suffix, failures, and text paging coexist", () => {
  const root = tempRoot("archive");
  const sessionId = "sess-restore";
  setImageRestoreRoot(sessionId, root);
  const messages = [
    userWithImage(PNG, "image/png", "first shot"),
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    {
      role: "toolResult",
      content: [
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: GIF, mimeType: "image/gif" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "later UNIQUE_TEXT_PAGE" }] },
  ];
  const refs = [
    { ref: "m00010", index: 0 },
    { ref: "m00011", index: 1 },
    { ref: "m00012", index: 2 },
    { ref: "m00013", index: 3 },
  ];
  const notes = archiveSessionImages({ sessionId, messages, refs, sessionRoot: root, onlyIndexes: new Set([0, 2]) });
  assert.ok(notes.some((n) => n.restorable && n.placeholder.includes("m00010")));
  assert.ok(notes.some((n) => n.placeholder.includes("m00012")));
  const summary = appendImagePlaceholders("Earlier turns covered the first screenshot and tool output.", notes);
  assert.match(summary, /\[image: png 1x1 · m00010\]/);
  assert.match(summary, /cursor_context_decompress\(\{ imageRef \}\)/);

  const listed = resolveImageRestore({ sessionId, imageRef: "list", sessionRoot: root });
  assert.equal(listed.ok, true);
  assert.match(listed.text, /\[Restorable images \(3\):\]/);
  assert.match(listed.text, /m00010 /);
  assert.match(listed.text, /m00012 /);
  assert.match(listed.text, /m00012\[-1\]/);

  const one = resolveImageRestore({ sessionId, imageRef: "m00010", sessionRoot: root });
  assert.equal(one.ok, true);
  assert.equal(one.images?.length, 1);
  assert.deepEqual(readFileSync(one.images![0]!.path), Buffer.from(PNG, "base64"));
  assert.ok(one.images![0]!.path.startsWith(restoreExportDir(sessionId, root)));

  const second = resolveImageRestore({ sessionId, imageRef: "m00012[-1]", sessionRoot: root });
  assert.equal(second.ok, true);
  assert.equal(second.images?.length, 1);
  assert.deepEqual(readFileSync(second.images![0]!.path), Buffer.from(GIF, "base64"));

  const missing = resolveImageRestore({ sessionId, imageRef: "m99999", sessionRoot: root });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /decompress FAILED: no restorable image for ref "m99999"/);

  const stampOnly = archiveSessionImages({
    sessionId,
    messages: [{ role: "user", content: [{ type: "image", attachment: { attachmentId: "gone", mediaType: "image/jpeg" } }] }],
    refs: [{ ref: "m00099", index: 0 }],
    sessionRoot: root,
  });
  assert.equal(stampOnly.every((n) => !n.restorable), true);
  const noBytes = resolveImageRestore({ sessionId, imageRef: "m00099", sessionRoot: root });
  assert.equal(noBytes.ok, false);
  assert.match(noBytes.text, /no restorable image for ref "m00099"/);

  archiveCompression({
    sessionId,
    revision: 1,
    summary,
    dropRefs: ["m00013"],
    dropText: "later UNIQUE_TEXT_PAGE\n" + notes.map((n) => n.placeholder).join("\n"),
  });
  const page = decompressChunk({ sessionId, ref: "m00013", limit: 8000 });
  assert.ok(page);
  assert.match(page!.text, /UNIQUE_TEXT_PAGE/);
  const hits = searchArchive(sessionId, "m00010", 10);
  assert.ok(hits.some((h) => h.snippet.includes("m00010")));
  assert.equal(imageRestoreMode("").mode, "text");
});

test("restore refuses a path that escapes the session directory", () => {
  const root = tempRoot("escape");
  const sessionId = "sess-escape";
  const dir = restoreExportDir(sessionId, root);
  mkdirSync(dir, { recursive: true });
  const outside = join(root, "outside.png");
  writeFileSync(outside, Buffer.from(PNG, "base64"));
  symlinkSync(outside, join(dir, "m00042-deadbeef.png"));
  writeFileSync(join(dir, "index.json"), JSON.stringify({
    sessionId,
    images: { m00042: [{ mediaType: "image/png", bytes: 80, path: join(dir, "m00042-deadbeef.png") }] },
  }));
  setImageRestoreRoot(sessionId, root);
  const result = resolveImageRestore({ sessionId, imageRef: "m00042", sessionRoot: root });
  assert.equal(result.ok, false, result.text);
  assert.match(result.text, /no restorable image/);

  const traversal = resolveImageRestore({ sessionId, imageRef: "../sess-other/m00042", sessionRoot: root });
  assert.equal(traversal.ok, false);
});

test("TTL prune removes expired files from this session only", () => {
  const root = tempRoot("ttl");
  const pa = writeRestoredImage("m00001", 0, pngImg, "ttl-a", root)!;
  const pb = writeRestoredImage("m00001", 0, pngImg, "ttl-b", root)!;
  const fresh = writeRestoredImage("m00002", 0, pngImg, "ttl-a", root)!;
  const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  // Expire both sessions deterministically; never rely on a freshly written file
  // being older than Date.now() on the filesystem's timestamp resolution.
  utimesSync(pa, past, past);
  utimesSync(pb, past, past);
  const removed = pruneRetrieveImgExports("ttl-a", root);
  assert.equal(removed, 1);
  assert.equal(existsSync(pa), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(pb), true);
});
