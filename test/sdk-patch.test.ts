/**
 * Guards the postinstall patch (scripts/patch-cursor-sdk.mjs) on @cursor/sdk's ESM build, the one DSH
 * loads via import(): its run.stream() tool-call converter must emit webSearch / webFetch instead of
 * `return null`. Extracts the converter from the installed chunk and feeds it synthetic tool calls.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-ignore plain .mjs script
import { esmChunk, patchSource, resolveSdkDir } from "../scripts/patch-cursor-sdk.mjs";

const file: string = esmChunk(resolveSdkDir(import.meta.url));

/** `function(v){if(!v?.tool)return null;switch(v.tool.case){... default:return v.tool}}` */
function converter(src: string): (toolCall: any) => any {
  const head = /function(?: [\w$]+)?\(([\w$]+)\)\{if\(!\1\?\.tool\)return null;switch\(\1\.tool\.case\)\{/.exec(src);
  assert.ok(head, "converter head not found");
  const tail = `default:return ${head[1]}.tool}}`;
  const end = src.indexOf(tail, head.index);
  assert.ok(end > head.index, "converter tail not found");
  return new Function(`return (${src.slice(head.index, end + tail.length).replace(/^function(?: [\w$]+)?/, "function")});`)();
}

const event = (kind: string, value: any) => ({ tool: { case: kind, value } });

test("installed @cursor/sdk ESM chunk carries the web-tools patch", () => {
  const src = readFileSync(file, "utf8");
  assert.equal(patchSource(src).state, "already", "run `pnpm install` (postinstall) or `node scripts/patch-cursor-sdk.mjs`");
});

test("patched converter emits webSearch", () => {
  const convert = converter(readFileSync(file, "utf8"));
  assert.deepEqual(convert(event("webSearchToolCall", { args: { searchTerm: "dsh cursor" } })), { type: "webSearch", args: { searchTerm: "dsh cursor" } });
  const done = convert(
    event("webSearchToolCall", {
      args: { searchTerm: "dsh cursor" },
      result: { result: { case: "success", value: { references: [{ title: "T", url: "https://x.test", chunk: "c" }] } } },
    }),
  );
  assert.deepEqual(done.result, { status: "success", value: { references: [{ title: "T", url: "https://x.test", chunk: "c" }] } });
  const rejected = convert(event("webSearchToolCall", { args: { searchTerm: "q" }, result: { result: { case: "rejected", value: { reason: "no" } } } }));
  assert.deepEqual(rejected.result, { status: "error", error: "no" });
});

test("patched converter emits webFetch; neighbours still drop", () => {
  const convert = converter(readFileSync(file, "utf8"));
  const done = convert(event("webFetchToolCall", { args: { url: "https://x.test" }, result: { result: { case: "success", value: { url: "https://x.test", markdown: "# hi" } } } }));
  assert.deepEqual(done, { type: "webFetch", args: { url: "https://x.test" }, result: { status: "success", value: { url: "https://x.test", markdown: "# hi" } } });
  const failed = convert(event("webFetchToolCall", { args: { url: "u" }, result: { result: { case: "error", value: { url: "u", error: "404" } } } }));
  assert.deepEqual(failed.result, { status: "error", error: "404" });
  assert.equal(convert(event("readTodosToolCall", {})), null);
  assert.equal(convert(event("truncatedToolCall", {})), null);
});

test("patchSource is idempotent", () => {
  const src = readFileSync(file, "utf8");
  assert.equal(patchSource(src).text, src);
});
