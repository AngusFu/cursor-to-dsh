import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CursorAdapter } from "../src/adapter.ts";
import {
  archiveSessionImages,
  legacyProjectExportDir,
  pluginImageStoreRoot,
  pruneRetrieveImgExports,
  resetImageRestoreForTests,
  resolveDshHome,
  resolveImageRestore,
  restoreExportDir,
  writeRestoredImage,
  type RestorableImage,
} from "../src/context/image-restore.ts";
import { closeAllCursorSessions } from "../src/session.ts";
import { isolateLedgerHome } from "./isolate-ledger-home.ts";
import { fakeCursor, say } from "./session-harness.ts";

isolateLedgerHome("cursor-img-store-");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const pngImg: RestorableImage = { mediaType: "image/png", b64: PNG, bytes: Buffer.byteLength(PNG, "base64"), width: 1, height: 1 };
const gifImg: RestorableImage = { mediaType: "image/gif", b64: GIF, bytes: Buffer.byteLength(GIF, "base64") };

const previousDshHome = process.env.DSH_HOME;

function projectDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `cursor-img-project-${label}-`));
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

afterEach(() => {
  resetImageRestoreForTests();
  closeAllCursorSessions();
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
});

function refsFor(messages: any[]) {
  return messages.map((_, index) => ({ ref: `m${String(index + 1).padStart(5, "0")}`, index }));
}

test("resolveDshHome follows the host convention and ignores cwd-relative overrides", () => {
  const home = realpathSync(process.env.HOME!);
  delete process.env.DSH_HOME;
  assert.equal(resolveDshHome(), join(home, ".dsh"));
  process.env.DSH_HOME = "   ";
  assert.equal(resolveDshHome(), join(home, ".dsh"));
  process.env.DSH_HOME = "relative-dir";
  assert.equal(resolveDshHome(), join(home, ".dsh"));
  const abs = join(home, "custom-dsh");
  process.env.DSH_HOME = abs;
  assert.equal(resolveDshHome(), abs);
  assert.ok(pluginImageStoreRoot().startsWith(join(abs, "cursor-to-dsh", "retrieve", "img")));
});

test("archive, restore, empty turns and TTL never write into the project cwd", async () => {
  const project = projectDir("zero-write");
  const sessionId = "sess-zero-write";
  const messages = [
    { role: "user", content: [{ type: "text", text: "see this" }, { type: "image", data: PNG, mimeType: "image/png" }] },
  ];
  archiveSessionImages({ sessionId, messages, refs: refsFor(messages), sessionRoot: project });
  const restored = resolveImageRestore({ sessionId, imageRef: "m00001", sessionRoot: project });
  assert.equal(restored.ok, true);
  assert.equal(listFiles(project).length, 0);
  assert.equal(existsSync(join(project, ".dsh")), false);
  assert.ok(restored.images![0]!.path.startsWith(restoreExportDir(sessionId)));
  assert.ok(restored.images![0]!.path.includes(join("cursor-to-dsh", "retrieve", "img", sessionId)));

  archiveSessionImages({ sessionId: "sess-empty", messages: [{ role: "user", content: [{ type: "text", text: "no image" }] }], refs: [], sessionRoot: project });
  assert.equal(existsSync(restoreExportDir("sess-empty")), false);
  assert.equal(listFiles(project).length, 0);

  const expired = writeRestoredImage("m00001", 0, pngImg, "sess-ttl")!;
  const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  utimesSync(expired, past, past);
  assert.equal(pruneRetrieveImgExports("sess-ttl", project), 1);
  assert.equal(existsSync(expired), false);
  assert.equal(listFiles(project).length, 0);
});

test("the same session is found across cwds; a different session cannot read its pixels", () => {
  const projectA = projectDir("cwd-a");
  const projectB = projectDir("cwd-b");
  const sessionId = "sess-cross-cwd";
  const messages = [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }] }];
  archiveSessionImages({ sessionId, messages, refs: refsFor(messages), sessionRoot: projectA });
  const fromB = resolveImageRestore({ sessionId, imageRef: "m00001", sessionRoot: projectB });
  assert.equal(fromB.ok, true);
  assert.deepEqual(readFileSync(fromB.images![0]!.path), Buffer.from(PNG, "base64"));
  assert.equal(listFiles(projectA).length, 0);
  assert.equal(listFiles(projectB).length, 0);
  const other = resolveImageRestore({ sessionId: "sess-other", imageRef: "m00001", sessionRoot: projectB });
  assert.equal(other.ok, false);
  assert.equal(existsSync(restoreExportDir("sess-other")), false);
});

test("a project .dsh symlink cannot escape writes or import another session", () => {
  const project = projectDir("symlink-root");
  const outside = projectDir("outside");
  symlinkSync(outside, join(project, ".dsh"));
  const sessionId = "sess-symlink-root";
  const messages = [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }] }];
  archiveSessionImages({ sessionId, messages, refs: refsFor(messages), sessionRoot: project });
  const restored = resolveImageRestore({ sessionId, imageRef: "m00001", sessionRoot: project });
  assert.equal(restored.ok, true);
  assert.ok(restored.images![0]!.path.startsWith(pluginImageStoreRoot()));
  assert.equal(listFiles(outside).length, 0, "must not follow a project .dsh symlink");
});

test("a session-bucket symlink is refused for write and restore, and does not rewrite the target index", () => {
  const sessionA = "sess-alias-a";
  const sessionB = "sess-alias-b";
  const pathB = writeRestoredImage("m00001", 0, pngImg, sessionB)!;
  archiveSessionImages({
    sessionId: sessionB,
    messages: [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }] }],
    refs: [{ ref: "m00001", index: 0 }],
  });
  const dirB = restoreExportDir(sessionB);
  mkdirSync(pluginImageStoreRoot(), { recursive: true });
  symlinkSync(dirB, restoreExportDir(sessionA));
  resetImageRestoreForTests();
  assert.equal(writeRestoredImage("m00001", 0, gifImg, sessionA), null);
  const archived = archiveSessionImages({
    sessionId: sessionA,
    messages: [{ role: "user", content: [{ type: "image", data: GIF, mimeType: "image/gif" }] }],
    refs: [{ ref: "m00001", index: 0 }],
  });
  assert.equal(archived.some((n) => n.restorable), false);
  const indexB = JSON.parse(readFileSync(join(dirB, "index.json"), "utf8"));
  assert.equal(indexB.sessionId, sessionB);
  resetImageRestoreForTests();
  const fromA = resolveImageRestore({ sessionId: sessionA, imageRef: "m00001" });
  assert.equal(fromA.ok, false);
  const fromB = resolveImageRestore({ sessionId: sessionB, imageRef: "m00001" });
  assert.equal(fromB.ok, true);
  assert.deepEqual(readFileSync(fromB.images![0]!.path), Buffer.from(PNG, "base64"));
  assert.deepEqual(readFileSync(pathB), Buffer.from(PNG, "base64"));
});

test("an index.json symlink is not written through and does not clobber an outside file", () => {
  const sessionId = "sess-index-link";
  const marker = join(projectDir("marker"), "benign.txt");
  writeFileSync(marker, "UNCHANGED");
  const dir = restoreExportDir(sessionId);
  mkdirSync(dir, { recursive: true });
  symlinkSync(marker, join(dir, "index.json"));
  archiveSessionImages({
    sessionId,
    messages: [{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }] }],
    refs: [{ ref: "m00001", index: 0 }],
  });
  assert.equal(readFileSync(marker, "utf8"), "UNCHANGED");
});

test("a torn index rebuilds from filenames and keeps multi-image positions", () => {
  const sessionId = "sess-torn";
  archiveSessionImages({
    sessionId,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", data: PNG, mimeType: "image/png" },
          { type: "image", data: GIF, mimeType: "image/gif" },
        ],
      },
    ],
    refs: [{ ref: "m00001", index: 0 }],
  });
  const before = resolveImageRestore({ sessionId, imageRef: "m00001[-0]" });
  assert.equal(before.images![0]!.mediaType, "image/png");
  writeFileSync(join(restoreExportDir(sessionId), "index.json"), "{");
  resetImageRestoreForTests();
  const after0 = resolveImageRestore({ sessionId, imageRef: "m00001[-0]" });
  const after1 = resolveImageRestore({ sessionId, imageRef: "m00001[-1]" });
  assert.equal(after0.ok, true);
  assert.equal(after0.images![0]!.mediaType, "image/png");
  assert.equal(after1.ok, true);
  assert.equal(after1.images![0]!.mediaType, "image/gif");
});

test("legacy project images of the same session are read-only and are not imported or pruned", () => {
  const project = projectDir("legacy");
  const sessionId = "sess-legacy";
  const legacyDir = join(project, ".dsh", "retrieve", "img", sessionId);
  mkdirSync(legacyDir, { recursive: true });
  const legacyFile = join(legacyDir, "m00007-aaaaaaaa.png");
  writeFileSync(legacyFile, Buffer.from(PNG, "base64"));
  writeFileSync(join(legacyDir, "index.json"), JSON.stringify({
    sessionId,
    images: { m00007: [{ mediaType: "image/png", bytes: Buffer.byteLength(PNG, "base64"), path: legacyFile, width: 1, height: 1 }] },
  }));
  const before = listFiles(project);
  assert.equal(legacyProjectExportDir(sessionId, project), realpathSync(legacyDir));
  const restored = resolveImageRestore({ sessionId, imageRef: "m00007", sessionRoot: project });
  assert.equal(restored.ok, true);
  assert.equal(restored.images![0]!.path, realpathSync(legacyFile));
  const foreign = resolveImageRestore({ sessionId: "sess-foreign", imageRef: "m00007", sessionRoot: project });
  assert.equal(foreign.ok, false);
  const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  utimesSync(legacyFile, past, past);
  assert.equal(pruneRetrieveImgExports(sessionId, project), 0);
  assert.deepEqual(listFiles(project), before);
  // A new archive must land in the user store, leaving the legacy bytes untouched.
  archiveSessionImages({
    sessionId,
    messages: [{ role: "user", content: [{ type: "image", data: GIF, mimeType: "image/gif" }] }],
    refs: [{ ref: "m00001", index: 0 }],
    sessionRoot: project,
  });
  assert.deepEqual(readFileSync(legacyFile), Buffer.from(PNG, "base64"));
  const fresh = resolveImageRestore({ sessionId, imageRef: "m00001", sessionRoot: project });
  assert.ok(fresh.images![0]!.path.startsWith(restoreExportDir(sessionId)));
  assert.ok(!fresh.images![0]!.path.startsWith(project));
});

test("a host adapter turn with cwd set still archives under the plugin store, not the project", async () => {
  const project = projectDir("adapter");
  const cursor = fakeCursor(async function* () {
    yield say("seen");
  });
  const adapter = new CursorAdapter({
    createAgent: cursor.createAgent,
    listModels: async () => [{ id: "m", displayName: "M" }],
    resolveApiKey: async () => "k",
    cwdFor: () => project,
    readImage: async () => ({ data: PNG, mimeType: "image/png" }),
  });
  const messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", attachment: { attachmentId: "a1", mediaType: "image/png", bytes: 3, width: 1, height: 1 } }], source: { kind: "user" } },
  ];
  for await (const _ of adapter.stream({ provider: "cursor", model: "m", messages, sessionId: "sess-adapter", tools: [] })) {
    /* drain */
  }
  const restored = resolveImageRestore({ sessionId: "sess-adapter", imageRef: "list", sessionRoot: project });
  assert.match(restored.text, /Restorable images/);
  assert.equal(listFiles(project).length, 0);
  assert.ok((restored.images ?? []).every((im) => im.path.startsWith(pluginImageStoreRoot())));
});

test("rebased image refs replace old indexed pixels; ambiguous torn-index versions fail closed", () => {
  const sessionId = "sess-rebased-versions";
  const refs = [{ref:"m00001",index:0}];
  archiveSessionImages({sessionId,messages:[{role:"user",content:[{type:"image",data:PNG,mimeType:"image/png"}]}],refs});
  archiveSessionImages({sessionId,messages:[{role:"user",content:[{type:"image",data:GIF,mimeType:"image/gif"}]}],refs});
  assert.equal(resolveImageRestore({sessionId,imageRef:"m00001"}).images![0].mediaType,"image/gif");
  writeFileSync(join(restoreExportDir(sessionId),"index.json"),"{");resetImageRestoreForTests();
  assert.equal(resolveImageRestore({sessionId,imageRef:"m00001[-0]"}).ok,false,"do not arbitrarily choose between historical versions after losing the index");
});

test("unavailable image positions remain holes after index persistence and rebuilding", () => {
  const sessionId="sess-gapped-images";
  archiveSessionImages({sessionId,messages:[{role:"user",content:[
    {type:"image",attachment:{mediaType:"image/png",width:1,height:1}},
    {type:"image",data:GIF,mimeType:"image/gif"},
  ]}],refs:[{ref:"m00001",index:0}]});
  for(const torn of [false,true]) {
    if(torn)writeFileSync(join(restoreExportDir(sessionId),"index.json"),"{");
    resetImageRestoreForTests();
    assert.equal(resolveImageRestore({sessionId,imageRef:"m00001[-0]"}).ok,false);
    assert.equal(resolveImageRestore({sessionId,imageRef:"m00001[-1]"}).images![0].mediaType,"image/gif");
  }
});

test("TTL preserves a valid latest-version mapping instead of rebuilding from leftover historical pixels", () => {
 const sessionId="sess-ttl-versions";const refs=[{ref:"m00001",index:0}];
 for(const [data,mimeType] of [[PNG,"image/png"],[GIF,"image/gif"]]) {
  archiveSessionImages({sessionId,messages:[{role:"user",content:[{type:"image",data,mimeType}]}],refs});
 }
 const expired=join(restoreExportDir(sessionId),"expired.tmp");writeFileSync(expired,"old temp");const old=new Date(Date.now()-10*24*3600*1000);utimesSync(expired,old,old);
 assert.equal(pruneRetrieveImgExports(sessionId),1);
 assert.equal(resolveImageRestore({sessionId,imageRef:"m00001"}).images![0].mediaType,"image/gif");
});

test("primary message refs do not fill missing positions with legacy pixels", () => {
 const projectA=projectDir("no-legacy-mixing");
 const sessionId="sess-no-legacy-mixing";const legacy=join(projectA,".dsh","retrieve","img",sessionId);mkdirSync(legacy,{recursive:true});
 const old=join(legacy,"m00001-1-deadbeef.png");writeFileSync(old,Buffer.from(PNG,"base64"));
 writeFileSync(join(legacy,"index.json"),JSON.stringify({sessionId,images:{m00001:[{path:old,mediaType:"image/png",bytes:1,index:1}]}}));
 archiveSessionImages({sessionId,sessionRoot:projectA,messages:[{role:"user",content:[{type:"image",data:GIF,mimeType:"image/gif"}]}],refs:[{ref:"m00001",index:0}]});
 const got=resolveImageRestore({sessionId,imageRef:"m00001",sessionRoot:projectA});
 assert.equal(got.images!.length,1);assert.equal(got.images![0].mediaType,"image/gif");
 assert.equal(resolveImageRestore({sessionId,imageRef:"m00001[-1]",sessionRoot:projectA}).ok,false);
 assert.equal(existsSync(old),true);
});
