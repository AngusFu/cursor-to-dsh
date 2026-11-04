/**
 * Guards the pnpm patch on @cursor/sdk (patches/@cursor__sdk@*.patch): the run.stream() tool-call
 * converter must emit webSearch / webFetch instead of `return null`. Pulls the converter out of
 * each installed build (esm, cjs, bundled) and feeds it synthetic upstream tool-call events.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const sdkDir = dirname(dirname(dirname(require.resolve("@cursor/sdk"))));

/**
 * The per-tool converter inside the stream mapper:
 * `function(v){if(!v?.tool)return null;switch(v.tool.case){... default:return v.tool}}`.
 */
function converter(file: string): (toolCall: any) => any {
  const src = readFileSync(file, "utf8");
  const head = /function(?: [\w$]+)?\(([\w$]+)\)\{if\(!\1\?\.tool\)return null;switch\(\1\.tool\.case\)\{/.exec(src);
  assert.ok(head, `${file}: converter head not found`);
  const v = head[1];
  const tail = `default:return ${v}.tool}}`;
  const end = src.indexOf(tail, head.index);
  assert.ok(end > head.index, `${file}: converter tail not found`);
  const body = src.slice(head.index, end + tail.length).replace(/^function(?: [\w$]+)?/, "function");
  assert.ok(body.includes('case"webSearchToolCall"'), `${file}: converter lacks webSearchToolCall`);
  return new Function(`return (${body});`)() as any;
}

function chunk(sub: string): string {
  const dir = join(sdkDir, "dist", sub);
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f))
    .filter((f) => readFileSync(f, "utf8").includes('case"webSearchToolCall"'));
  assert.equal(hits.length, 1, `dist/${sub}`);
  return hits[0];
}

const builds = { esm: chunk("esm"), cjs: chunk("cjs"), bundled: join(sdkDir, "dist", "bundled", "index.js") };
const event = (kind: string, value: any) => ({ tool: { case: kind, value } });

for (const [name, file] of Object.entries(builds)) {
  test(`patched @cursor/sdk ${name}: webSearch tool calls reach run.stream()`, () => {
    const convert = converter(file);
    const started = convert(event("webSearchToolCall", { args: { searchTerm: "dsh cursor" } }));
    assert.deepEqual(started, { type: "webSearch", args: { searchTerm: "dsh cursor" } });
    const done = convert(
      event("webSearchToolCall", {
        args: { searchTerm: "dsh cursor" },
        result: { result: { case: "success", value: { references: [{ title: "T", url: "https://x.test", chunk: "c" }] } } },
      })
    );
    assert.deepEqual(done.result, { status: "success", value: { references: [{ title: "T", url: "https://x.test", chunk: "c" }] } });
    const rejected = convert(event("webSearchToolCall", { args: { searchTerm: "q" }, result: { result: { case: "rejected", value: { reason: "no" } } } }));
    assert.deepEqual(rejected.result, { status: "error", error: "no" });
  });

  test(`patched @cursor/sdk ${name}: webFetch tool calls reach run.stream()`, () => {
    const convert = converter(file);
    const done = convert(
      event("webFetchToolCall", { args: { url: "https://x.test" }, result: { result: { case: "success", value: { url: "https://x.test", markdown: "# hi" } } } })
    );
    assert.deepEqual(done, { type: "webFetch", args: { url: "https://x.test" }, result: { status: "success", value: { url: "https://x.test", markdown: "# hi" } } });
    const failed = convert(event("webFetchToolCall", { args: { url: "u" }, result: { result: { case: "error", value: { url: "u", error: "404" } } } }));
    assert.deepEqual(failed.result, { status: "error", error: "404" });
    // Untouched neighbours still drop.
    assert.equal(convert(event("readTodosToolCall", {})), null);
    assert.equal(convert(event("truncatedToolCall", {})), null);
  });
}
