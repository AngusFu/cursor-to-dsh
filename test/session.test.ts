import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { CursorAdapter } from "../src/adapter.ts";
import { FALLBACK_MODELS } from "../src/models.ts";
import { closeAllCursorSessions, cursorSessionCount } from "../src/session.ts";
import { cursorOverhead, resetCursorOverhead } from "../src/usage.ts";


/** Scripted fake Cursor agent. Each send runs `script(ctx)` as the model. */
function fakeCursor(script: (ctx: any) => AsyncGenerator<any, any, void>) {
  const created: any[] = [];
  const sends: any[] = [];
  const sendOpts: any[] = [];
  // Fake durable user-input checkpoint: cancelled runs deliberately commit nothing.
  const checkpoints: any[][] = [];
  const createAgent = async (opts: any) => {
    created.push(opts);
    const agentTools = opts.local?.customTools ?? {};
    const committed: any[] = [];
    return {
      send: async (msg: any, options?: any) => {
        sends.push(msg);
        checkpoints.push([...committed]);
        sendOpts.push(options);
        const tools = options?.local?.customTools ?? agentTools;
        let status: any = { status: "finished", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 } };
        const queue: any[] = [];
        let wake: (() => void) | undefined;
        let finished = false;
        let cancelled = false;
        const ctx = {
          msg,
          opts,
          callTool: async (name: string, args: any, id: string) => {
            if (!tools[name]) throw new Error(`unknown tool ${name}`);
            return tools[name].execute(args, { toolCallId: id });
          },
          setStatus: (s: any) => (status = s),
        };
        (async () => {
          for await (const ev of script(ctx)) {
            if (cancelled) return;
            queue.push(ev);
            wake?.();
          }
          if (!cancelled && status?.status === "finished") committed.push(msg);
          finished = true;
          wake?.();
        })();
        return {
          stream: async function* () {
            for (;;) {
              while (queue.length) yield queue.shift();
              if (finished) return;
              await new Promise<void>((r) => (wake = r));
            }
          },
          wait: async () => {
            while (!finished) await new Promise((r) => setTimeout(r, 1));
            return status;
          },
          cancel: async () => {
            if (finished) return;
            cancelled = true;
            status = { status: "cancelled" };
            finished = true;
            wake?.();
          },
        };
      },
      close: () => {},
    };
  };
  return { createAgent, created, sends, sendOpts, checkpoints };
}

const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

let seq = 0;
const nextId = () => `msg-${++seq}`;
const text = (t: string) => [{ type: "text", text: t }];
const sys = (t: string) => ({ id: nextId(), role: "system", content: text(t), source: { kind: "system-prompt" } });
const user = (t: string) => ({ id: nextId(), role: "user", content: text(t), source: { kind: "user" } });
const dev = (t: string) => ({ id: nextId(), role: "developer", content: text(t), source: { kind: "user" } });
const toolResult = (callId: string, t: string, isError = false) => ({
  id: nextId(),
  role: "tool",
  toolCallId: callId,
  isError,
  content: text(t),
  source: { kind: "tool", callId },
});

const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } };
const xTool = { name: "x_doctor", description: "Check X", parameters: { type: "object", properties: {} } };

const v = (...values: string[]) => values.map((value) => ({ value }));
const catalog = [
  { id: "m", displayName: "M" },
  {
    id: "claude",
    displayName: "Claude",
    parameters: [
      { id: "thinking", values: v("true", "false") },
      { id: "effort", values: v("low", "high") },
      { id: "fast", values: v("true", "false") },
      { id: "context", values: v("300k", "1m") },
    ],
  },
];

function adapterFor(cursor: { createAgent: any }, deps: any = {}) {
  return new CursorAdapter({
    createAgent: cursor.createAgent,
    listModels: async () => catalog,
    resolveApiKey: async () => "k",
    cwdFor: () => "/work",
    ...deps,
  });
}

/** One DSH model call; the reply is assembled the way DSH stores it. */
async function call(adapter: CursorAdapter, messages: any[], options: any = {}) {
  const chunks: any[] = [];
  for await (const c of adapter.stream({ provider: "cursor", model: "m", messages, tools: [readTool], sessionId: "sess-1", ...options })) chunks.push(c);
  const blocks = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  const assistant = { id: nextId(), role: "assistant", content: blocks, source: { kind: "model", provider: "cursor", model: options.model ?? "m" } };
  return {
    chunks,
    finish: chunks.at(-1).reason,
    assistant,
    usage: chunks.find((c) => c.type === "usage")?.usage,
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
    calls: blocks.filter((b) => b.type === "tool-call"),
  };
}

beforeEach(() => {
  closeAllCursorSessions();
  resetCursorOverhead();
});

test("one Cursor agent per session; later calls send only the new user text", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    yield say(`echo:${typeof ctx.msg === "string" ? ctx.msg.slice(-5) : ""}`);
  });
  const adapter = adapterFor(cursor);
  const s = sys("SYS");
  const u1 = user("hello");
  const r1 = await call(adapter, [s, u1]);
  assert.deepEqual(r1.finish, { kind: "stop" });
  assert.equal(r1.text, "echo:hello");
  assert.match(cursor.sends[0], /^Only the tools attached[\s\S]*SYS[\s\S]*### user\nhello$/);
  assert.equal(cursor.created[0].local.cwd, "/work");
  assert.deepEqual(cursor.created[0].tools, ["mcp"]);
  assert.deepEqual(cursor.created[0].local.settingSources, []);

  const r2 = await call(adapter, [s, u1, r1.assistant, user("again")]);
  assert.deepEqual(r2.finish, { kind: "stop" });
  assert.equal(cursor.created.length, 1, "agent reused");
  assert.equal(cursor.sends[1], "again", "only the new text is sent");
});

test("a tool call stays inside one Cursor run and gets DSH's real result", async () => {
  let got: any;
  const cursor = fakeCursor(async function* (ctx) {
    yield say("reading");
    got = await ctx.callTool("read", { path: "a.txt" }, "call-1");
    yield say("done");
  });
  const adapter = adapterFor(cursor);
  const s = sys("SYS");
  const u1 = user("read a.txt");
  const r1 = await call(adapter, [s, u1]);
  assert.deepEqual(r1.finish, { kind: "tool-calls" });
  assert.equal(r1.text, "reading");
  assert.deepEqual(r1.calls, [{ type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.txt"}' }]);
  assert.equal(r1.usage, undefined, "no usage mid-run");

  const r2 = await call(adapter, [s, u1, r1.assistant, toolResult("call-1", "FILE")]);
  assert.deepEqual(r2.finish, { kind: "stop" });
  assert.equal(r2.text, "done");
  assert.deepEqual(got, { content: [{ type: "text", text: "FILE" }], isError: false });
  assert.equal(cursor.created.length, 1);
  assert.equal(cursor.sends.length, 1, "no second send: the run continued");
});

test("parallel tool calls are handed to DSH together", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    const [a, b] = await Promise.all([ctx.callTool("read", { path: "a" }, "c-a"), ctx.callTool("read", { path: "b" }, "c-b")]);
    yield say(`${a.content[0].text}+${b.content[0].text}`);
  });
  const adapter = adapterFor(cursor);
  const u1 = user("read both");
  const r1 = await call(adapter, [u1]);
  assert.deepEqual(r1.calls.map((c) => c.id), ["c-a", "c-b"]);
  const r2 = await call(adapter, [u1, r1.assistant, toolResult("c-a", "A"), toolResult("c-b", "B", true)]);
  assert.equal(r2.text, "A+B");
});

test("context messages DSH adds are sent with the next user text", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("x");
  const r1 = await call(adapter, [u1]);
  await call(adapter, [u1, r1.assistant, dev("cwd is /work"), user("y")]);
  assert.equal(cursor.created.length, 1);
  assert.equal(cursor.sends[1], "[context]\ncwd is /work\n\ny");
});

test("a user message sent while a tool runs rides along with the tool result", async () => {
  const results: any[] = [];
  const cursor = fakeCursor(async function* (ctx) {
    results.push(await ctx.callTool("read", { path: "a" }, "c-1"));
    yield say("done");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("go");
  const r1 = await call(adapter, [u1]);
  await call(adapter, [u1, r1.assistant, toolResult("c-1", "FILE"), user("also check b")]);
  assert.match(results[0].content.at(-1).text, /while the tool was running\]\nalso check b$/);
});

test("removed tools are dropped silently; only added ones are announced", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("x");
  const r1 = await call(adapter, [u1], { tools: [readTool, xTool] });
  await call(adapter, [u1, r1.assistant, user("y")], { tools: [readTool] });
  assert.equal(cursor.sends[1], "y");
  assert.deepEqual(Object.keys(cursor.sendOpts[1].local.customTools), ["read"]);
});

test("a rewritten history (compaction) replays from scratch on a new agent", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  await call(adapter, [user("first")]);
  await call(adapter, [user("[summary] first -> ok"), user("next")]);
  assert.equal(cursor.created.length, 2);
  assert.match(cursor.sends[1], /\[summary\]/);
  assert.equal(cursorSessionCount(), 1);
});

test("system prompt: a later system message with added lines keeps the agent, a rewrite does not", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  const s = sys("SYS");
  const u1 = user("x");
  const r1 = await call(adapter, [s, u1]);
  const u2 = user("y");
  const r2 = await call(adapter, [s, u1, r1.assistant, sys("SYS\n- x_doctor: diagnose"), u2], { tools: [readTool, xTool] });
  assert.equal(cursor.created.length, 1, "agent reused");
  assert.match(cursor.sends[1], /system prompt update[^\n]*\n- x_doctor: diagnose\n\n\[Tool update: [^\n]*available: x_doctor\.[^\n]*\]\n\ny$/);
  assert.deepEqual(Object.keys(cursor.sendOpts[1].local.customTools), ["read", "x_doctor"]);

  await call(adapter, [s, u1, r1.assistant, sys("SYS\n- x_doctor: diagnose"), u2, r2.assistant, sys("OTHER"), user("z")]);
  assert.equal(cursor.created.length, 2, "rewritten prompt starts over");
});

test("a tool change while DSH runs a tool continues on the same agent with the new tools", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    if (sentText(ctx.msg).startsWith("[Host turn replay:")) {
      await ctx.callTool("x_doctor", {}, "c-x");
      yield say("done");
      return;
    }
    await ctx.callTool("read", { path: "a" }, "c-1");
    yield say("stale run");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("go");
  const r1 = await call(adapter, [u1]);
  const res1 = toolResult("c-1", "FILE");
  const r2 = await call(adapter, [u1, r1.assistant, res1], { tools: [readTool, xTool] });
  assert.equal(r2.calls[0]?.name, "x_doctor");
  assert.equal(cursor.created.length, 1);
  assert.equal(turnSnapshot(cursor.sends[1]).messages.at(-1).content[0].text, "FILE");
  assert.match(sentText(cursor.sends[1]), /available: x_doctor\./);
  const r3 = await call(adapter, [u1, r1.assistant, res1, r2.assistant, toolResult("c-x", "OK")], { tools: [readTool, xTool] });
  assert.equal(r3.text, "done");
  assert.equal(cursor.sends.length, 2, "the follow-up run continued");
});

test("an aborted call finishes as aborted and drops the session", async () => {
  const cursor = fakeCursor(async function* () {
    await new Promise((r) => setTimeout(r, 50));
    yield say("late");
  });
  const adapter = adapterFor(cursor);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const r = await call(adapter, [user("hi")], { signal: controller.signal });
  assert.equal(r.finish.kind, "aborted");
  assert.equal(r.finish.failure.code, "ABORTED");
  assert.equal(cursorSessionCount(), 0);
});

test("a failed run reports a non-retryable error code", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    ctx.setStatus({ status: "error", error: { message: "model exploded" } });
  });
  const r = await call(adapterFor(cursor), [user("hi")]);
  assert.deepEqual(r.finish, { kind: "error", failure: { message: "model exploded", code: "CURSOR_RUN_FAILED" } });
  assert.equal(cursorSessionCount(), 0);
});

test("catalog params: effort mapped, Fast off, context stepped down when rejected", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const created: any[] = [];
  const createAgent = async (opts: any) => {
    created.push(opts.model.params);
    const agent = await cursor.createAgent(opts);
    if (!opts.model.params?.some((p: any) => p.value === "1m")) return agent;
    return {
      ...agent,
      send: async () => ({
        stream: async function* () {},
        wait: async () => ({ status: "error", error: { message: 'Invalid parameters for registry model: "claude"' } }),
        cancel: async () => {},
      }),
    };
  };
  process.env.DSH_CURSOR_CONTEXT = "max";
  try {
    const r = await call(adapterFor({ createAgent }), [user("hi")], { model: "claude", reasoningEffort: "low" });
    assert.deepEqual(r.finish, { kind: "stop" });
  } finally {
    delete process.env.DSH_CURSOR_CONTEXT;
  }
  assert.deepEqual(created[0], [
    { id: "thinking", value: "true" },
    { id: "effort", value: "low" },
    { id: "fast", value: "false" },
    { id: "context", value: "1m" },
  ]);
  assert.equal(created[1].at(-1).value, "300k");
});

test("usage: a single-call run is exact, a tool-heavy run fits the context estimate", async () => {
  const first = fakeCursor(async function* () {
    yield say("ok");
  });
  const r1 = await call(adapterFor(first), [user("hello")]);
  assert.deepEqual(r1.usage, { inputTokens: 10, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 });
  const overhead = cursorOverhead("m");
  assert.ok(overhead > 0 && overhead < 110);

  closeAllCursorSessions();
  const cursor = fakeCursor(async function* (ctx) {
    await ctx.callTool("read", { path: "a" }, "c-1");
    ctx.setStatus({ status: "finished", usage: { inputTokens: 900_000, outputTokens: 2_000, cacheReadTokens: 890_000 } });
    yield say("done");
  });
  const adapter = adapterFor(cursor);
  const u = user("read a");
  const c1 = await call(adapter, [u]);
  const r2 = await call(adapter, [u, c1.assistant, toolResult("c-1", "x".repeat(400))]);
  const fill = r2.usage.inputTokens + r2.usage.cacheReadTokens + r2.usage.cacheWriteTokens;
  assert.ok(fill > overhead + 100 && fill < 1_000, `context fill ${fill} is the estimate, not the cumulative input`);
  assert.equal(r2.usage.outputTokens, 2_000);
  assert.equal(r2.usage.totalTokens, undefined);
});

test("auxiliary calls (session titles) get their own agent and leave the session alone", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    yield say(typeof ctx.msg === "string" && ctx.msg.includes("Title this") ? "A title" : "ok");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("x");
  const r1 = await call(adapter, [u1]);
  const title = await call(adapter, [user("Title this")], { purpose: "session-title", tools: [] });
  assert.equal(title.text, "A title");
  assert.equal(cursorSessionCount(), 1, "the title agent is closed");
  await call(adapter, [u1, r1.assistant, user("y")]);
  assert.equal(cursor.created.length, 2, "main session kept its agent");
  assert.equal(cursor.sends.at(-1), "y");
});

test("a missing API key fails with MISSING_CREDENTIAL and creates no agent", async () => {
  const cursor = fakeCursor(async function* () {});
  const r = await call(adapterFor(cursor, { resolveApiKey: async () => undefined }), [user("hi")]);
  assert.equal(r.finish.kind, "error");
  assert.equal(r.finish.failure.code, "MISSING_CREDENTIAL");
  assert.equal(cursor.created.length, 0);
});

test("stop sequences are rejected instead of silently dropped", async () => {
  const cursor = fakeCursor(async function* () {});
  await assert.rejects(call(adapterFor(cursor), [user("hi")], { stop: ["END"] }), (err: any) => err.failure?.code === "UNSUPPORTED_OPTION");
});

const imageBlock = (id: string) => ({ type: "image", attachment: { attachmentId: id, mediaType: "image/png", bytes: 3, width: 1, height: 1 } });

test("user images reach Cursor as bytes and each attachment is read once", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("seen");
  });
  const reads: string[] = [];
  const adapter = adapterFor(cursor, {
    readImage: async (ref: any) => {
      reads.push(ref.attachmentId);
      return { data: `B64-${ref.attachmentId}`, mimeType: ref.mediaType };
    },
  });
  const u1 = { id: nextId(), role: "user", content: [{ type: "text", text: "what is this" }, imageBlock("a1")], source: { kind: "user" } };
  const r1 = await call(adapter, [u1]);
  assert.deepEqual(cursor.sends[0].images, [{ data: "B64-a1", mimeType: "image/png" }]);
  assert.match(cursor.sends[0].text, /### user\nwhat is this$/);

  const u2 = { id: nextId(), role: "user", content: [{ type: "text", text: "and this" }, imageBlock("a2")], source: { kind: "user" } };
  await call(adapter, [u1, r1.assistant, u2]);
  assert.deepEqual(cursor.sends[1], { text: "and this", images: [{ data: "B64-a2", mimeType: "image/png" }] });
  assert.deepEqual(reads, ["a1", "a2"], "a1 came from the cache on the second call");
  assert.deepEqual((await adapter.listModels("cursor"))[0].inputModalities, ["text", "image"]);
});

test("tool results carry images to Cursor; unreadable images become a note", async () => {
  let toolGot: any;
  const cursor = fakeCursor(async function* (ctx) {
    toolGot = await ctx.callTool("read", { path: "shot.png" }, "c-img");
    yield say("seen");
  });
  const adapter = adapterFor(cursor, {
    readImage: async (ref: any) => {
      if (ref.attachmentId === "broken") throw new Error("gone");
      return { data: `B64-${ref.attachmentId}`, mimeType: ref.mediaType };
    },
  });
  const u1 = user("look at the screenshot");
  const r1 = await call(adapter, [u1]);
  const shot = { id: nextId(), role: "tool", toolCallId: "c-img", content: [imageBlock("a2"), imageBlock("broken")], source: { kind: "tool", callId: "c-img" } };
  await call(adapter, [u1, r1.assistant, shot]);
  assert.deepEqual(toolGot.content, [
    { type: "image", data: "B64-a2", mimeType: "image/png" },
    { type: "text", text: "[image attachment not forwarded to Cursor]" },
  ]);
});

test("models: live catalog with efforts, fallback when the catalog is unavailable", async () => {
  const adapter = adapterFor(fakeCursor(async function* () {}));
  assert.deepEqual((await adapter.listModels("cursor")).map((m: any) => m.id), ["m", "claude"]);
  const claude = await adapter.resolveModel("cursor", "claude");
  assert.equal(claude.name, "Claude");
  assert.equal(claude.context.contextWindow, 300_000);
  assert.equal(claude.systemPromptUpdate, "in-history");
  assert.deepEqual(claude.reasoning.efforts.map((e: any) => e.id), ["off", "low", "high"]);
  assert.equal((await adapter.resolveModel("cursor", "m")).reasoning, undefined);
  assert.equal((await adapter.resolveModel("cursor", "unlisted")).name, "unlisted");

  const autos = adapterFor(fakeCursor(async function* () {}), {
    listModels: async () => [...catalog, { id: "auto-smart", displayName: "Auto" }, { id: "default", displayName: "Auto" }],
  });
  assert.deepEqual((await autos.listModels("cursor")).map((m: any) => m.name), ["M", "Claude", "Auto (auto-smart)", "Auto (default)"]);
  assert.equal((await autos.resolveModel("cursor", "default")).name, "Auto (default)");

  const offline = adapterFor(fakeCursor(async function* () {}), {
    listModels: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual((await offline.listModels("cursor")).map((m: any) => m.id), FALLBACK_MODELS.map((m) => m.id));
  const keyless = adapterFor(fakeCursor(async function* () {}), { resolveApiKey: async () => undefined });
  assert.equal((await keyless.listModels("cursor")).length, FALLBACK_MODELS.length);
});

test("models: refetches live catalog when key appears after keyless listModels", async () => {
  let key: string | undefined;
  const adapter = adapterFor(fakeCursor(async function* () {}), {
    resolveApiKey: async () => key,
    listModels: async () => [{ id: "live-one", displayName: "Live" }],
  });
  assert.deepEqual((await adapter.listModels("cursor")).map((m: any) => m.id), FALLBACK_MODELS.map((m) => m.id));
  key = "k";
  assert.deepEqual((await adapter.listModels("cursor")).map((m: any) => m.id), ["live-one"]);
});

test("models: invalidateCatalog forces a reload", async () => {
  let calls = 0;
  const adapter = adapterFor(fakeCursor(async function* () {}), {
    listModels: async () => {
      calls++;
      return [{ id: `m${calls}`, displayName: "M" }];
    },
  });
  assert.deepEqual((await adapter.listModels("cursor")).map((m: any) => m.id), ["m1"]);
  assert.deepEqual((await adapter.listModels("cursor")).map((m: any) => m.id), ["m1"]);
  adapter.invalidateCatalog();
  assert.deepEqual((await adapter.listModels("cursor")).map((m: any) => m.id), ["m2"]);
});

test("prewarm runs after a live catalog, not on the fallback catalog", async () => {
  const warmed: any[] = [];
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  await adapterFor(cursor, { prewarm: (o: any) => warmed.push(o) }).listModels("cursor");
  assert.deepEqual(warmed, [{ apiKey: "k", modelId: catalog[0].id }]);
  await adapterFor(cursor, { prewarm: (o: any) => warmed.push(o), resolveApiKey: async () => undefined }).listModels("cursor");
  assert.equal(warmed.length, 1);
});



test("Cursor agent stays mcp-only (no built-in webSearch/webFetch)", async () => {
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  await call(adapter, [sys("SYS"), user("hi")]);
  assert.deepEqual(cursor.created[0].tools, ["mcp"]);
});

// Regression fixtures for the 2026-11-12 Paseo conversation investigation.
const excludedAcpTools = [
  { name: "acp_status", description: "ACP status", parameters: { type: "object", properties: {} } },
  { name: "compress", description: "billion-context compress", parameters: { type: "object", properties: { startId: { type: "string" } } } },
];
test("regression: unchanged host ACP tools do not restart an in-flight read", async () => {
  let got: any;
  const cursor = fakeCursor(async function* (ctx) {
    if (sentText(ctx.msg).includes("[Host turn replay:")) {
      yield say("WRONG: restarted");
      return;
    }
    got = await ctx.callTool("read", { path: "a.txt" }, "reg-read");
    yield say("read completed on original run");
  });
  const adapter = adapterFor(cursor);
  const u = user("only tell me who added these lines");
  const options = { tools: [readTool, ...excludedAcpTools] };
  const r1 = await call(adapter, [u], options);
  const r2 = await call(adapter, [u, r1.assistant, toolResult("reg-read", "Alice")], options);
  assert.equal(cursor.sends.length, 1, "a stable filtered tool set must not cause cancel+send");
  assert.equal(r2.text, "read completed on original run");
  assert.equal(got.content[0].text, "Alice");
  assert.equal(cursor.created[0].local.customTools.acp_status, undefined);
  assert.equal(cursor.created[0].local.customTools.compress, undefined);
});
test("regression: excluded ACP tools are not falsely announced on a new user turn", async () => {
  const cursor = fakeCursor(async function* () { yield say("ok"); });
  const adapter = adapterFor(cursor);
  const u = user("first");
  const options = { tools: [readTool, ...excludedAcpTools] };
  const r1 = await call(adapter, [u], options);
  await call(adapter, [u, r1.assistant, user("again")], options);
  assert.equal(cursor.sends[1], "again", "new user input must not advertise hidden tools");
});

test("regression: real tool changes still restart once when excluded ACP tools exist", async () => {
  const cursor = fakeCursor(async function* (ctx) {
    if (sentText(ctx.msg).startsWith("[Host turn replay:")) {
      await ctx.callTool("x_doctor", {}, "c-x");
      yield say("done");
      return;
    }
    await ctx.callTool("read", { path: "a" }, "c-1");
    yield say("stale run");
  });
  const adapter = adapterFor(cursor);
  const u1 = user("go");
  const r1 = await call(adapter, [u1], { tools: [readTool, ...excludedAcpTools] });
  const res1 = toolResult("c-1", "FILE");
  const r2 = await call(adapter, [u1, r1.assistant, res1], { tools: [readTool, xTool, ...excludedAcpTools] });
  assert.equal(r2.calls[0]?.name, "x_doctor");
  assert.equal(cursor.created.length, 1);
  assert.equal(turnSnapshot(cursor.sends[1]).messages.at(-1).content[0].text, "FILE");
  assert.match(sentText(cursor.sends[1]), /available: x_doctor\./);
  const r3 = await call(adapter, [u1, r1.assistant, res1, r2.assistant, toolResult("c-x", "OK")], { tools: [readTool, xTool, ...excludedAcpTools] });
  assert.equal(r3.text, "done");
  assert.equal(cursor.sends.length, 2, "the follow-up run continued");
});

// Input-fidelity regressions. The fake SDK rolls back cancelled sends; these do not
// assert anything about a real model's decisions or its willingness to obey instructions.
const sentText = (msg: any): string => typeof msg === "string" ? msg : msg.text;
function turnSnapshot(msg: any): any {
  const body = sentText(msg).split("[Turn snapshot JSON]\n")[1]?.split("\n[End turn snapshot JSON]")[0];
  assert.ok(body, "recovery must carry a structured, role-labelled turn snapshot");
  return JSON.parse(body);
}

for (const change of ["add tool", "remove tool", "append system prompt"] as const) {
  test(`preserve turn: ${change} replays the real question with uncommitted checkpoint`, async () => {
    let n = 0;
    const cursor = fakeCursor(async function* (ctx) {
      if (++n === 1) {
        await ctx.callTool("read", { path: "git-history" }, "who");
        yield say("stale run must not win");
      } else yield say("answer only");
    });
    const adapter = adapterFor(cursor);
    const question = change === "remove tool" ? "直接git blam不行吗" : "之前是谁加的这俩";
    const evidence = change === "remove tool" ? "git blame: ba697c8 (Josip) 42" : "git log: ba697c8 Josip";
    const before = change === "remove tool" ? [readTool, xTool] : [readTool];
    const after = change === "add tool" ? [readTool, xTool] : [readTool];
    const u = user(question);
    const r1 = await call(adapter, [sys("SYS"), u], { tools: before });
    const r2 = await call(adapter, [sys(change === "append system prompt" ? "SYS\nADDED" : "SYS"), u, r1.assistant, toolResult("who", evidence)], { tools: after });
    assert.equal(r2.finish.kind, "stop");
    assert.equal(cursor.sends.length, 2);
    assert.equal(cursor.created.length, 1);
    assert.deepEqual(cursor.checkpoints[1], [], "cancel did not commit the original question");
    assert.ok(sentText(cursor.sends[1]).includes(question), "original question must survive cancellation");
    const snapshot = turnSnapshot(cursor.sends[1]);
    assert.deepEqual(snapshot.messages.map((m: any) => m.role), ["user", "assistant", "tool"]);
    assert.equal(snapshot.messages[0].content[0].text, question);
    assert.equal(snapshot.messages[2].toolCallId, "who");
    assert.equal(snapshot.messages[2].toolName, "read");
    assert.equal(snapshot.messages[2].content[0].text, evidence);
    assert.equal(snapshot.systemContext, change === "append system prompt" ? "SYS\nADDED" : "SYS");
    assert.doesNotMatch(sentText(cursor.sends[1]), /Continue the task\./);
    assert.match(sentText(cursor.sends[1]), /not a new user instruction or authorization/);
    assert.deepEqual(Object.keys(cursor.sendOpts[1].local.customTools), after.map((t) => t.name));
  });
}

test("preserve turn: consecutive handoffs retain prior evidence without recursive snapshots", async () => {
  let n = 0;
  const cursor = fakeCursor(async function* (ctx) {
    const step = ++n;
    if (step <= 2) {
      await ctx.callTool("read", { path: "history" }, `repeat-${step}`);
      yield say("stale");
    } else yield say("Josip, ba697c8");
  });
  const adapter = adapterFor(cursor);
  const u = user("之前是谁加的这俩");
  const r1 = await call(adapter, [sys("SYS"), u]);
  const t1 = toolResult("repeat-1", "git log: Josip ba697c8");
  const r2 = await call(adapter, [sys("SYS\nADDED"), u, r1.assistant, t1], { tools: [readTool, xTool] });
  const t2 = toolResult("repeat-2", "git blame: Josip ba697c8");
  await call(adapter, [sys("SYS\nADDED"), u, r1.assistant, t1, r2.assistant, t2]);
  assert.deepEqual(cursor.checkpoints[1], []);
  assert.deepEqual(cursor.checkpoints[2], []);
  const snapshot = turnSnapshot(cursor.sends[2]);
  assert.equal(snapshot.systemContext, "SYS\nADDED", "a cancelled earlier system update must also survive");
  assert.deepEqual(snapshot.messages.map((m: any) => m.role), ["user", "assistant", "tool", "assistant", "tool"]);
  assert.equal(snapshot.messages[2].content[0].text, "git log: Josip ba697c8");
  assert.equal(snapshot.messages[4].content[0].text, "git blame: Josip ba697c8");
  assert.equal(sentText(cursor.sends[2]).split("之前是谁加的这俩").length - 1, 1);
  assert.equal(sentText(cursor.sends[2]).split("[Turn snapshot JSON]").length - 1, 1);
  assert.ok(sentText(cursor.sends[2]).length < sentText(cursor.sends[1]).length + 1500);
});

test("preserve turn: completed turn is cleared before the next intent", async () => {
  let n = 0;
  const cursor = fakeCursor(async function* (ctx) {
    const step = ++n;
    if (step % 2) {
      await ctx.callTool("read", {}, `round-${step}`);
      yield say("stale");
    } else yield say("answered");
  });
  const adapter = adapterFor(cursor);
  const a = user("之前是谁加的这俩");
  const r1 = await call(adapter, [a]);
  const e1 = toolResult("round-1", "Josip ba697c8");
  const r2 = await call(adapter, [a, r1.assistant, e1], { tools: [readTool, xTool] });
  const b = user("直接git blam不行吗");
  const history = [a, r1.assistant, e1, r2.assistant, b];
  const r3 = await call(adapter, history, { tools: [readTool, xTool] });
  assert.equal(cursor.sends[2], "直接git blam不行吗");
  await call(adapter, [...history, r3.assistant, toolResult("round-3", "blame: NEW RESULT")]);
  const snapshot = turnSnapshot(cursor.sends[3]);
  assert.equal(snapshot.messages[0].content[0].text, "直接git blam不行吗");
  assert.doesNotMatch(sentText(cursor.sends[3]), /之前是谁加的这俩|Josip ba697c8/);
  assert.equal(cursor.created.length, 1, "do not rewrite SDK history to recover a turn");
});

test("preserve turn: a steer delivered through an earlier tool result stays ordered on a later handoff", async () => {
  let n = 0;
  let inline: any;
  const cursor = fakeCursor(async function* (ctx) {
    if (++n === 1) {
      inline = await ctx.callTool("read", {}, "steer-1");
      await ctx.callTool("read", {}, "steer-2");
      yield say("stale");
    } else yield say("answer the latest request");
  });
  const adapter = adapterFor(cursor);
  const u = user("inspect the change");
  const r1 = await call(adapter, [u]);
  const steer = user("只查作者，别提交");
  const context = dev("current branch: feature");
  const partial = [u, r1.assistant, toolResult("steer-1", "log: Josip"), steer, context];
  const r2 = await call(adapter, partial);
  assert.equal(cursor.sends.length, 1, "steer may first travel through the existing tool promise");
  assert.match(JSON.stringify(inline), /只查作者，别提交/);
  const latest = user("改用git blame回答，仍然不提交");
  await call(adapter, [...partial, r2.assistant, toolResult("steer-2", "blame: ba697c8"), latest], { tools: [readTool, xTool] });
  const snapshot = turnSnapshot(cursor.sends[1]);
  assert.deepEqual(snapshot.messages.filter((m: any) => m.role === "user").map((m: any) => m.content[0].text), ["inspect the change", "只查作者，别提交", "改用git blame回答，仍然不提交"]);
  assert.equal(snapshot.messages.filter((m: any) => m.role === "developer")[0].content[0].text, "current branch: feature");
  assert.equal(sentText(cursor.sends[1]).split("只查作者，别提交").length - 1, 1, "do not duplicate a steer as tool output");
});

test("preserve turn: original, steer and tool images survive repeated handoffs with file references", async () => {
  let n = 0;
  const cursor = fakeCursor(async function* (ctx) {
    if (++n <= 2) { await ctx.callTool("read", {}, `image-${n}`); yield say("stale"); }
    else yield say("seen");
  });
  const adapter = adapterFor(cursor, { readImage: async (ref: any) => ({ data: `B64-${ref.attachmentId}`, mimeType: "image/png" }) });
  const original = { ...user("look, don't commit"), content: [...text("look, don't commit"), imageBlock("original"), { type: "file", attachment: { attachmentId: "file-1", name: "evidence.txt", path: "/work/evidence.txt", mediaType: "text/plain" } }] };
  const r1 = await call(adapter, [original]);
  const steer = { ...user("compare this"), content: [...text("compare this"), imageBlock("steer")] };
  const evidence = { ...toolResult("image-1", "tool image"), content: [...text("tool image"), imageBlock("tool")] };
  const partial = [original, r1.assistant, evidence, steer];
  const r2 = await call(adapter, partial, { tools: [readTool, xTool] });
  await call(adapter, [...partial, r2.assistant, toolResult("image-2", "done")]);
  assert.equal(cursor.created.length, 1, "images must survive the cancelled-run path, not just a fresh replay");
  assert.deepEqual(cursor.checkpoints[1], []);
  assert.deepEqual(cursor.checkpoints[2], []);
  const expected = ["original", "tool", "steer"].map((id) => ({ data: `B64-${id}`, mimeType: "image/png" }));
  assert.deepEqual(cursor.sends[1].images, expected);
  assert.deepEqual(cursor.sends[2].images, expected);
  const snapshot = turnSnapshot(cursor.sends[2]);
  assert.deepEqual(snapshot.messages.flatMap((m: any) => m.content).filter((b: any) => b.type === "image").map((b: any) => b.imageIndex), [0, 1, 2]);
  assert.match(JSON.stringify(snapshot), /evidence\.txt/);
  assert.match(JSON.stringify(snapshot), /\/work\/evidence\.txt/);
  assert.match(JSON.stringify(snapshot), /file-1/);
  assert.doesNotMatch(sentText(cursor.sends[2]), /B64-original|B64-steer|B64-tool/);
});

test("preserve turn: rewritten system opens a fresh agent with original images, not the old prompt", async () => {
  let n = 0;
  const cursor = fakeCursor(async function* (ctx) {
    if (++n === 1) { await ctx.callTool("read", {}, "rewrite"); yield say("stale"); }
    else yield say("answered");
  });
  const adapter = adapterFor(cursor, { readImage: async () => ({ data: "ORIGINAL-IMAGE", mimeType: "image/png" }) });
  const u = { ...user("直接git blam不行吗"), content: [...text("直接git blam不行吗"), imageBlock("source")] };
  const r1 = await call(adapter, [sys("OLD SYSTEM"), u]);
  await call(adapter, [sys("NEW SYSTEM"), u, r1.assistant, toolResult("rewrite", "blame: Josip ba697c8")]);
  assert.equal(cursor.created.length, 2);
  assert.match(sentText(cursor.sends[1]), /NEW SYSTEM[\s\S]*直接git blam不行吗[\s\S]*Josip ba697c8/);
  assert.doesNotMatch(sentText(cursor.sends[1]), /OLD SYSTEM/);
  assert.deepEqual(cursor.sends[1].images, [{ data: "ORIGINAL-IMAGE", mimeType: "image/png" }]);
});

test("preserve turn: abort disposes the unfinished intent before reuse", async () => {
  let n = 0;
  const cursor = fakeCursor(async function* (ctx) {
    const step = ++n;
    if (step <= 2) { await ctx.callTool("read", {}, `abort-${step}`); yield say("stale"); }
    else yield say("new answer");
  });
  const adapter = adapterFor(cursor);
  const old = user("ABORTED OLD INTENT");
  const r1 = await call(adapter, [old]);
  const controller = new AbortController();
  controller.abort();
  const aborted = await call(adapter, [old, r1.assistant, toolResult("abort-1", "old evidence")], { signal: controller.signal, tools: [readTool, xTool] });
  assert.equal(cursor.sends.length, 1, "an already-aborted tool update must not send a new run");
  assert.equal(aborted.finish.kind, "aborted");
  assert.equal(cursorSessionCount(), 0);
  const fresh = user("NEW INTENT ONLY");
  const r2 = await call(adapter, [fresh]);
  await call(adapter, [fresh, r2.assistant, toolResult("abort-2", "new evidence")], { tools: [readTool, xTool] });
  assert.doesNotMatch(sentText(cursor.sends[2]), /ABORTED OLD INTENT|old evidence/);
  assert.equal(turnSnapshot(cursor.sends[2]).messages[0].content[0].text, "NEW INTENT ONLY");
  assert.equal(cursor.created.length, 2);
});

test("preserve turn: abort during the cancellation handshake prevents the replacement send", async () => {
  const controller = new AbortController();
  const cursor = fakeCursor(async function* (ctx) {
    await ctx.callTool("read", {}, "cancel-handshake");
    yield say("stale");
  });
  const adapter = adapterFor({ createAgent: async (options: any) => {
    const agent = await cursor.createAgent(options);
    return { ...agent, send: async (msg: any, sendOptions?: any) => {
      const run = await agent.send(msg, sendOptions);
      return { ...run, cancel: async () => { controller.abort(); await run.cancel(); } };
    } };
  } });
  const u = user("直接git blam不行吗");
  const r1 = await call(adapter, [u]);
  const r2 = await call(adapter, [u, r1.assistant, toolResult("cancel-handshake", "Josip ba697c8")], { tools: [readTool, xTool], signal: controller.signal });
  assert.equal(r2.finish.kind, "aborted");
  assert.equal(cursor.sends.length, 1, "abort after cancel must not launch the recovery run");
  assert.equal(cursorSessionCount(), 0);
});

for (const status of ["cancelled", "error"]) {
  test(`preserve turn: terminal SDK ${status} clears recovery state`, async () => {
    let n = 0;
    const cursor = fakeCursor(async function* (ctx) {
      if (++n === 1) { await ctx.callTool("read", {}, "terminal"); yield say("stale"); }
      else if (n === 2) ctx.setStatus({ status, error: { message: "synthetic failure" } });
      else yield say("new answer");
    });
    const adapter = adapterFor(cursor);
    const u = user("OLD TERMINAL INTENT");
    const r1 = await call(adapter, [u]);
    const r2 = await call(adapter, [u, r1.assistant, toolResult("terminal", "old output")], { tools: [readTool, xTool] });
    assert.equal(r2.finish.kind, status === "cancelled" ? "aborted" : "error");
    assert.equal(cursorSessionCount(), 0);
    await call(adapter, [user("NEW ONLY")]);
    assert.doesNotMatch(sentText(cursor.sends[2]), /OLD TERMINAL INTENT|old output/);
    assert.equal(cursor.created.length, 2);
  });
}

// Independently authored review regressions (not model-behavior assertions).
test('independent: removing the last forwarded tool explicitly overrides SDK creation-time tools', async () => {
 let n=0;const cursor=fakeCursor(async function*(ctx){
  if(++n===1){await ctx.callTool('read',{},'last-tool');yield say('stale')}
  else yield say('no tools now')
 });const adapter=adapterFor(cursor);const u=user('inspect only, do not write');
 const r1=await call(adapter,[u]);
 await call(adapter,[u,r1.assistant,toolResult('last-tool','read-only evidence')],{tools:[]});
 assert.deepEqual(cursor.sendOpts[1]?.local?.customTools,{},'SDK uses send.local.customTools ?? agent.options.local.customTools; omission restores removed tools');
 assert.equal(turnSnapshot(cursor.sends[1]).messages[0].content[0].text,'inspect only, do not write');
});

test('independent: schema-only change replays request, tool arguments and evidence unchanged', async()=>{
 let n=0;const cursor=fakeCursor(async function*(ctx){if(++n===1){await ctx.callTool('read',{path:'history'},'schema');yield say('stale')}else yield say('answer')});
 const adapter=adapterFor(cursor);const u=user('who introduced these two lines?');const r=await call(adapter,[u]);
 const changed={...readTool,parameters:{type:'object',properties:{file_path:{type:'string'}}}};
 await call(adapter,[u,r.assistant,toolResult('schema','author: fixture')],{tools:[changed]});
 const s=turnSnapshot(cursor.sends[1]);assert.equal(s.messages[0].content[0].text,'who introduced these two lines?');
 assert.deepEqual(s.messages[1].content.find((b:any)=>b.type==='toolCall').arguments,{path:'history'});
 assert.equal(s.messages[2].content[0].text,'author: fixture');assert.deepEqual(cursor.sendOpts[1].local.customTools.read.inputSchema,changed.parameters);
});

test('independent: two pending host sessions keep replay intent and image bytes separate', async()=>{
 const cursor=fakeCursor(async function*(ctx){if(!sentText(ctx.msg).startsWith('[Host turn replay:')){await ctx.callTool('read',{},'same-call-id');yield say('stale')}else yield say('answer')});
 const adapter=adapterFor(cursor,{readImage:async(ref:any)=>({data:'bytes-'+ref.attachmentId,mimeType:'image/png'})});
 const a={...user('A private request'),content:[...text('A private request'),{type:'image',attachment:{attachmentId:'A-image',path:'/fixture/A.png'}}]};
 const b={...user('B unrelated request'),content:[...text('B unrelated request'),{type:'image',attachment:{attachmentId:'B-image',path:'/fixture/B.png'}}]};
 const ra=await call(adapter,[a],{sessionId:'A'});const rb=await call(adapter,[b],{sessionId:'B'});
 await call(adapter,[a,ra.assistant,toolResult('same-call-id','A evidence')],{sessionId:'A',tools:[readTool,xTool]});
 await call(adapter,[b,rb.assistant,toolResult('same-call-id','B evidence')],{sessionId:'B',tools:[readTool,xTool]});
 assert.doesNotMatch(sentText(cursor.sends[2]),/B unrelated|B evidence/);assert.doesNotMatch(sentText(cursor.sends[3]),/A private|A evidence/);
 assert.deepEqual(cursor.sends[2].images,[{data:'bytes-A-image',mimeType:'image/png'}]);assert.deepEqual(cursor.sends[3].images,[{data:'bytes-B-image',mimeType:'image/png'}]);
});

test('independent: explicit close/reset drops the open intent before same-key reuse', async()=>{
 let n=0;const cursor=fakeCursor(async function*(ctx){if(++n<=2){await ctx.callTool('read',{},'reset-'+n);yield say('stale')}else yield say('answer')});
 const adapter=adapterFor(cursor);await call(adapter,[user('OLD CLOSED REQUEST')]);closeAllCursorSessions();
 const u=user('NEW REQUEST');const r=await call(adapter,[u]);await call(adapter,[u,r.assistant,toolResult('reset-2','new result')],{tools:[readTool,xTool]});
 assert.doesNotMatch(sentText(cursor.sends[2]),/OLD CLOSED REQUEST/);assert.equal(turnSnapshot(cursor.sends[2]).messages[0].content[0].text,'NEW REQUEST');assert.equal(cursor.created.length,2);
});
