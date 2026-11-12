import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { CursorAdapter } from "../src/adapter.ts";
import { Config } from "../src/index.ts";
import { closeAllCursorSessions } from "../src/session.ts";
import { readRequest } from "../src/transcript.ts";
import { registerHostApi } from "../src/host-api.ts";
import { uiSnapshot, resetOverlay } from "../src/ui-state.ts";
import { isBiliAcpTool, withoutBiliAcpTools } from "../src/context/bili-tools.ts";
import { fakeCursor, adapterFor, say, sys, user } from "./session-harness.ts";

afterEach(() => { closeAllCursorSessions(); resetOverlay(); });
const prefix = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n";
const sections = [{ name: "approval-policy", text: "Ask before publishing." }, { name: "cursor:acp-context", text: "[acp-context]\nUse cursor_context_compress." }, { name: "instructions", text: "Follow AGENTS.md; answer in Chinese." }];
const context = (parts = sections) => ({ role: "user", source: { kind: "runtime-context", form: "snapshot", sections: parts }, content: [{ type: "text", text: prefix + parts.map(s => s.text).join("\n\n") }] });

test("ordinary DSH prompt, instructions, user tool results and image bytes still reach the SDK", async () => {
  const cursor = fakeCursor(async function* () { yield say("ok"); });
  const adapter = adapterFor(cursor, { readImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }) });
  const input = { ...user("describe this"), content: [{ type: "text", text: "describe this" }, { type: "image", attachment: { attachmentId: "fresh" } }] };
  for await (const _ of adapter.stream({ model: "m", sessionId: "ordinary", messages: [sys("SYSTEM/AGENTS"), context(), input] })) {}
  assert.match(cursor.sends[0].text, /SYSTEM\/AGENTS/);
  assert.match(cursor.sends[0].text, /Ask before publishing/);
  assert.match(cursor.sends[0].text, /Follow AGENTS.md/);
  assert.match(cursor.sends[0].text, /describe this/);
  assert.doesNotMatch(cursor.sends[0].text, /\[acp-context\]|cursor_context_compress|<acp /);
  assert.deepEqual(cursor.sends[0].images, [{ data: "aW1hZ2U=", mimeType: "image/png" }]);
});

test("filter only attributed retired context, never matching user prose or ordinary context", () => {
  const original = context(); const frozen = JSON.stringify(original);
  const text = "[acp-context]\nPlease explain cursor_context_compress, do not invoke it.";
  const request = readRequest({ messages: [original, user(text), { role: "developer", source: { kind: "user" }, content: text }, context([{ name: "project-note", text }])] });
  assert.equal(JSON.stringify(original), frozen, "history is immutable");
  assert.equal(request.messages.length, 4);
  assert.doesNotMatch(JSON.stringify(request.messages[0]), /Use cursor_context_compress/);
  assert.match(JSON.stringify(request.messages.slice(1)), /Please explain cursor_context_compress/);
  assert.equal(readRequest({ messages: [context([sections[1]])] }).messages.length, 0);
});

test("unattributed/mismatched retired runtime guidance is explicit, not silent loss of normal history", () => {
  const noAttribution = { ...context([sections[1]]), source: { kind: "runtime-context" } };
  assert.throws(() => readRequest({ messages: [noAttribution] }), /lacks section attribution/);
  const mixed = context(); mixed.content[0].text += "\nExtra user requirements.";
  const before = JSON.stringify(mixed);
  assert.throws(() => readRequest({ messages: [mixed] }), /Cannot safely separate/);
  assert.equal(JSON.stringify(mixed), before);
});

test("verified current global manifest IDs and retired local tools are not forwarded", () => {
  // billion-context@0.1.213: ACP_TOOL_NAMES + optional manifest entries.
  for (const name of ["search_context", "acp_status", "acp_cache", "acp_rule", "acp_retrieve", "acp_read_original_image", "cursor_context_compress", "cursor_context_status", "cursor_context_decompress", "cursor_context_search"]) {
    assert.equal(isBiliAcpTool({ name }), true, name);
  }
  const compression = { name: "compress", description: "Replace consumed conversation ranges using mNNNNN refs", parameters: { type: "object", properties: { content: { type: "string" } } } };
  const absorb = { name: "absorb", description: "Distill a tool result after an [ACP absorb] instruction", parameters: { type: "object", properties: { ref: { type: "string" }, summary: { type: "string" } } } };
  assert.equal(isBiliAcpTool(compression), true); assert.equal(isBiliAcpTool(absorb), true);
  for (const name of ["compress", "decompress", "absorb", "image_full", "cursor_context_project_notes"]) assert.equal(isBiliAcpTool({ name, description: "Ordinary project operation", parameters: { type: "object", properties: { file_path: { type: "string" } } } }), false, name);
  const normal = { name: "read", description: "Read source", parameters: {} };
  const original = [compression, absorb, normal];
  assert.deepEqual(withoutBiliAcpTools(original), [normal]); assert.equal(original.length, 3, "global DSH list is untouched");
});

test("filtered global tool changes do not restart a pending real DSH tool run", async () => {
  let result: any;
  const cursor = fakeCursor(async function* (ctx) { result = await ctx.callTool("read", { file_path: "a.ts" }, "read-1"); yield say("done"); });
  const adapter = adapterFor(cursor); const u = user("之前是谁加的这俩");
  const read = { name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } };
  const run = async (messages: any[], tools: any[]) => { const chunks: any[] = []; for await (const c of adapter.stream({ model: "m", sessionId: "global-tools", messages, tools })) chunks.push(c); return chunks.filter(c => c.type === "block-end").map(c => c.block); };
  const reply = await run([u], [read, { name: "acp_status" }]);
  const assistant = { role: "assistant", content: reply };
  await run([u, assistant, { role: "tool", toolCallId: "read-1", content: "Josip/ba697c8" }], [read, { name: "acp_rule" }, { name: "acp_retrieve" }]);
  assert.equal(cursor.created.length, 1); assert.equal(cursor.sends.length, 1);
  assert.equal(result.content[0].text, "Josip/ba697c8");
});

test("legacy compression deps/settings do nothing; no checkpoint/image/index/TTL/project writes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cursor-no-compress-"));
  const cwd = path.join(root, "project"), home = path.join(root, "home"), data = path.join(home, ".dsh");
  mkdirSync(path.join(cwd, ".dsh", "retrieve", "img", "old"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, "cursor-context-ledger.db"), "old database sentinel");
  writeFileSync(path.join(cwd, ".dsh", "retrieve", "img", "old", "old.png"), "old image sentinel");
  const inventory = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(e => [e.name, e.isDirectory() ? inventory(path.join(dir,e.name)) : readFileSync(path.join(dir,e.name)).toString("base64")]);
  const before = inventory(root); const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = data;
  try {
    const cursor = fakeCursor(async function* () { yield say("ok"); });
    const forbidden = new Proxy({}, { get: () => { throw new Error("removed compression path was used"); } });
    const adapter = adapterFor(cursor, { compact: forbidden, contextEnabled: () => { throw new Error("removed gate used"); }, cwdFor: () => cwd });
    const messages: any[] = [user("normal no-image request")];
    for (const suffix of [[], [user("next ordinary turn")]]) for await (const _ of adapter.stream({ model: "m", sessionId: "legacy", messages: [...messages, ...suffix], contextManagement: { enabled: true } })) {}
    closeAllCursorSessions(); assert.deepEqual(inventory(root), before);
  } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});

test("removed context settings/API cannot recreate storage; multi-key and usage surfaces remain", async () => {
  const routes: any[] = []; const ctx: any = { get: () => undefined, inject: (_names: any, apply: any) => apply({ effect: (fn: any) => fn(), connection: { fetch: { register: (route: any) => { routes.push(route); return () => {}; } } } }) };
  registerHostApi(ctx, () => ({ contextManagement: { enabled: true } } as any));
  assert.ok(routes.some(r => r.path.endsWith("/keys/use"))); assert.ok(routes.some(r => r.path.endsWith("/usage")));
  assert.equal(routes.some(r => r.path.includes("/context")), false);
  assert.ok(routes.every(r => r.requestBody === "buffered"));
  const snapshot = await uiSnapshot(ctx, { contextManagement: { enabled: true } } as any);
  assert.equal("contextManagement" in snapshot, false); assert.ok(snapshot.profiles.length); assert.equal(snapshot.usageDisplay, "auto");
  // Schemastery tolerates a retained obsolete config field; no migration writes.
  assert.doesNotThrow(() => (Config as any)({ contextManagement: { enabled: true } }));
});

test("client still registers Settings and usage pill, with no compression UI/polling slot", () => {
  let factory: any; const code = readFileSync(new URL("../client/factory.js", import.meta.url), "utf8");
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: (module: any) => { factory = module.factory; } } } });
  const client = factory((_name: string) => ({})); const registrations: any[] = [];
  const ctx: any = { locale: undefined, slots: { inject: (_slot: string, fn: any) => fn(), register: (options: any, component: any) => registrations.push({ options, component }) }, inject: (_names: string[], fn: any) => fn(ctx) };
  client.apply(ctx);
  assert.deepEqual(registrations.map(r => r.options.id), ["cursor-to-dsh", "cursor-to-dsh-usage"]);
  assert.doesNotMatch(code, /ContextCard|ContextPanelCard|ContextFillPill|\/context\/fill|\/context\/panel|contextManagement/);
});

test("runtime source closure and lockfile do not depend on compression or open its stores", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["acp-kernel"], undefined);
  const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"); assert.doesNotMatch(lock, /acp-kernel/);
  for (const name of ["session", "index", "adapter", "host-api", "ui-state"]) assert.doesNotMatch(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"), /node:sqlite|saveCheckpoint|loadLatest|createAgentPlatform|archiveSessionImages|scheduleModelCompress|contextManagement/);
});

test("actual installed billion-context 0.1.213 manifest schema fixtures are all filtered", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/billion-context-0.1.213-tools.json", import.meta.url), "utf8"));
  assert.equal(fixture.tools.length, 9);
  for (const tool of fixture.tools) assert.equal(isBiliAcpTool(tool), true, tool.name);
  assert.deepEqual(readRequest({ tools: fixture.tools }).tools, []);
  for (const name of ["absorb", "acp_retrieve"]) {
    const tool = fixture.tools.find((t: any) => t.name === name);
    assert.equal(isBiliAcpTool({ ...tool, name: "configured_optional_alias" }), true);
    assert.equal(isBiliAcpTool({ ...tool, name: "normal_project_tool", description: "An unrelated tool; ACP is only mentioned here" }), false);
  }
});

test("image requests with symlinked old storage and broken indexes do not write or clean anything", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "cursor-no-image-cache-"));
  const cwd = path.join(root, "project"), link = path.join(root, "linked-dsh-home");
  mkdirSync(path.join(cwd, "retrieve", "img", "old"), { recursive: true });
  const index = path.join(cwd, "retrieve", "img", "old", "index.json");
  writeFileSync(index, "broken index: must not rebuild or clean"); symlinkSync(cwd, link);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = link;
  try {
    const cursor = fakeCursor(async function* () { yield say("ok"); });
    const adapter = adapterFor(cursor, { cwdFor: () => cwd, readImage: async () => ({ data: "cGl4ZWxz", mimeType: "image/png" }) });
    const messages = [{ ...user("image"), content: [{ type: "image", attachment: { attachmentId: "new" } }] }];
    for (const id of ["a", "b"]) for await (const _ of adapter.stream({ model: "m", sessionId: id, messages })) {}
    for (const send of cursor.sends) assert.deepEqual(send.images, [{ data: "cGl4ZWxz", mimeType: "image/png" }]);
    assert.deepEqual(readdirSync(cwd), ["retrieve"]); assert.deepEqual(readdirSync(path.dirname(index)), ["index.json"]);
    assert.equal(readFileSync(index, "utf8"), "broken index: must not rebuild or clean");
  } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});

test("clean build drops stale compiled compression modules, never old user data", async () => {
  const { copyFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(path.join(tmpdir(), "cursor-clean-build-"));
  try {
    mkdirSync(path.join(root, "scripts")); mkdirSync(path.join(root, "lib", "context"), { recursive: true }); mkdirSync(path.join(root, ".dsh"));
    writeFileSync(path.join(root, "lib", "context", "checkpoint.js"), "old output");
    writeFileSync(path.join(root, ".dsh", "cursor-context-ledger.db"), "retain old data");
    copyFileSync(new URL("../scripts/clean-build.mjs", import.meta.url), path.join(root, "scripts", "clean-build.mjs"));
    execFileSync(process.execPath, [path.join(root, "scripts", "clean-build.mjs")], { cwd: tmpdir() });
    assert.deepEqual(readdirSync(root).sort(), [".dsh", "scripts"]);
    assert.equal(readFileSync(path.join(root, ".dsh", "cursor-context-ledger.db"), "utf8"), "retain old data");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
