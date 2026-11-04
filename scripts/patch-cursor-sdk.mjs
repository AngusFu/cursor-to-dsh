#!/usr/bin/env node
/**
 * postinstall: make @cursor/sdk's run.stream() emit Cursor's built-in webSearch / webFetch tool calls.
 *
 * The SDK's tool-call converter maps webSearchToolCall / webFetchToolCall to `return null`, so they
 * never reach run.stream(). This rewrites those two cases in the ESM build (what DSH loads through
 * `import("@cursor/sdk")`) to emit `{ type: "webSearch" | "webFetch", args, result }`, shaped like
 * semSearch / mcp. Applied in place at install time instead of a committed diff: the minified chunk
 * is one ~1.3 MB line, so any unified diff of it is megabytes.
 *
 * Only touches the exact SDK version pinned in package.json; idempotent; never fails the install
 * (prints a warning instead). Replaces the file via rename so a hardlinked package store is not mutated.
 *
 *   node scripts/patch-cursor-sdk.mjs            # patch the @cursor/sdk this package resolves
 *   node scripts/patch-cursor-sdk.mjs <sdk-dir>  # patch an explicit unpacked SDK directory
 *   node scripts/patch-cursor-sdk.mjs --check    # exit 1 unless the resolved SDK is patched
 */
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "/*cursor-to-dsh:web-tools*/";

// Result mappers; `R` is the proto result message ({ result: { case, value } }).
const searchResult = (R) =>
  `(()=>{const c=${R}.result?.case;return"success"===c?{status:"success",value:{references:(${R}.result.value.references??[]).map((x=>({title:x.title,url:x.url,chunk:x.chunk})))}}:"error"===c?{status:"error",error:${R}.result.value.error}:"rejected"===c?{status:"error",error:${R}.result.value.reason}:void 0})()`;
const fetchResult = (R) =>
  `(()=>{const c=${R}.result?.case;return"success"===c?{status:"success",value:{url:${R}.result.value.url,markdown:${R}.result.value.markdown}}:"error"===c?{status:"error",error:${R}.result.value.error}:"rejected"===c?{status:"error",error:${R}.result.value.reason}:void 0})()`;
// `v` is the switch subject, the same name the minifier gave the surrounding converter.
const searchCase = (v) =>
  `${MARK}case"webSearchToolCall":{const{args:a,result:r}=${v}.tool.value;return a?{type:"webSearch",args:{searchTerm:a.searchTerm},...r?{result:${searchResult("r")}}:{}}:null}`;
const fetchCase = (v) =>
  `case"webFetchToolCall":{const{args:a,result:r}=${v}.tool.value;return a?{type:"webFetch",args:{url:a.url},...r?{result:${fetchResult("r")}}:{}}:null}`;

const HEAD = /function(?: [\w$]+)?\(([\w$]+)\)\{if\(!\1\?\.tool\)return null;switch\(\1\.tool\.case\)\{/;

function once(text, from, to, file) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: expected 1 match of ${JSON.stringify(from)}, got ${n}`);
  return text.replace(from, () => to);
}

/** Returns "patched" | "already". Throws when the minified anchors moved. */
export function patchSource(text, file = "chunk") {
  if (text.includes(MARK)) return { text, state: "already" };
  const head = HEAD.exec(text);
  if (!head) throw new Error(`${file}: tool-call converter not found`);
  const v = head[1];
  let t = once(text, 'case"readTodosToolCall":case"webSearchToolCall":', searchCase(v) + 'case"readTodosToolCall":', file);
  t = once(t, 'case"truncatedToolCall":case"webFetchToolCall":', 'case"truncatedToolCall":', file);
  t = once(t, 'case"applyAgentDiffToolCall":', fetchCase(v) + 'case"applyAgentDiffToolCall":', file);
  return { text: t, state: "patched" };
}

/** The dist/esm chunk holding the converter. */
export function esmChunk(sdkDir) {
  const dir = join(sdkDir, "dist", "esm");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f))
    .filter((f) => readFileSync(f, "utf8").includes('case"webSearchToolCall"'));
  if (hits.length !== 1) throw new Error(`${dir}: expected one chunk with webSearchToolCall, got ${hits.length}`);
  return hits[0];
}

export function resolveSdkDir(from = import.meta.url) {
  // exports has no "./package.json"; "." resolves to dist/cjs/index.js under require.
  return dirname(dirname(dirname(createRequire(from).resolve("@cursor/sdk"))));
}

function main(argv) {
  const here = dirname(dirname(fileURLToPath(import.meta.url)));
  const pinned = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies?.["@cursor/sdk"];
  const check = argv.includes("--check");
  const explicit = argv.find((a) => !a.startsWith("--"));
  let sdkDir;
  try {
    sdkDir = explicit ?? resolveSdkDir();
  } catch {
    console.warn("[cursor-to-dsh] @cursor/sdk not resolvable; skipping web-tools patch");
    return check ? 1 : 0;
  }
  const version = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version;
  if (version !== pinned) {
    console.warn(`[cursor-to-dsh] @cursor/sdk ${version} != pinned ${pinned}; web-tools patch not applied`);
    return check ? 1 : 0;
  }
  const file = esmChunk(sdkDir);
  const { text, state } = patchSource(readFileSync(file, "utf8"), file);
  if (check) {
    console.log(`[cursor-to-dsh] ${file}: ${state === "already" ? "patched" : "NOT patched"}`);
    return state === "already" ? 0 : 1;
  }
  if (state === "patched") {
    const tmp = `${file}.cursor-to-dsh.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }
  console.log(`[cursor-to-dsh] @cursor/sdk ${version} web-tools patch: ${state} (${file.slice(sdkDir.length + 1)})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // Never break the host install; the plugin works unpatched (web tool calls just stay invisible).
    console.warn(`[cursor-to-dsh] web-tools patch skipped: ${err instanceof Error ? err.message : err}`);
    if (process.argv.includes("--check")) process.exitCode = 1;
  }
}
