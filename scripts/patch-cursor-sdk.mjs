#!/usr/bin/env node
/**
 * Re-applies the cursor-to-dsh edits to an unpacked @cursor/sdk directory (the one
 * `pnpm patch @cursor/sdk@<version>` prints). The SDK's run.stream() converter drops
 * webSearchToolCall / webFetchToolCall with `return null`; this makes them emit
 * `tool_call` messages named `webSearch` / `webFetch`, shaped like semSearch / mcp.
 *
 * Usage: node scripts/patch-cursor-sdk.mjs <sdk-dir>  then  pnpm patch-commit <sdk-dir>
 * Fails loudly if an anchor is missing or ambiguous: re-read the minified switch then.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: patch-cursor-sdk.mjs <unpacked @cursor/sdk dir>");

// Result mappers shared by both builds; `R` is the proto result message.
const searchResult = (R) =>
  `(()=>{const c=${R}.result?.case;return"success"===c?{status:"success",value:{references:(${R}.result.value.references??[]).map((x=>({title:x.title,url:x.url,chunk:x.chunk})))}}:"error"===c?{status:"error",error:${R}.result.value.error}:"rejected"===c?{status:"error",error:${R}.result.value.reason}:void 0})()`;
const fetchResult = (R) =>
  `(()=>{const c=${R}.result?.case;return"success"===c?{status:"success",value:{url:${R}.result.value.url,markdown:${R}.result.value.markdown}}:"error"===c?{status:"error",error:${R}.result.value.error}:"rejected"===c?{status:"error",error:${R}.result.value.reason}:void 0})()`;

// cjs/esm chunk: switch on `e`, cases fall through to a shared `return null`.
const splitSearch = `case"webSearchToolCall":{const{args:t,result:r}=e.tool.value;return t?{type:"webSearch",args:{searchTerm:t.searchTerm},...r?{result:${searchResult("r")}}:{}}:null}`;
const splitFetch = `case"webFetchToolCall":{const{args:t,result:r}=e.tool.value;return t?{type:"webFetch",args:{url:t.url},...r?{result:${fetchResult("r")}}:{}}:null}`;
// bundled (bun) build: switch on `$`, every case has its own `return null`.
const bunSearch = `case"webSearchToolCall":{let{args:A,result:B}=$.tool.value;if(!A)return null;return{type:"webSearch",args:{searchTerm:A.searchTerm},...B?{result:${searchResult("B")}}:{}}}`;
const bunFetch = `case"webFetchToolCall":{let{args:A,result:B}=$.tool.value;if(!A)return null;return{type:"webFetch",args:{url:A.url},...B?{result:${fetchResult("B")}}:{}}}`;

function once(text, from, to, file) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: expected 1 match of ${JSON.stringify(from.slice(0, 60))}, got ${n}`);
  return text.replace(from, () => to);
}

function patchSplit(file) {
  let t = readFileSync(file, "utf8");
  t = once(t, 'case"readTodosToolCall":case"webSearchToolCall":', splitSearch + 'case"readTodosToolCall":', file);
  t = once(t, 'case"truncatedToolCall":case"webFetchToolCall":', 'case"truncatedToolCall":', file);
  t = once(t, 'case"applyAgentDiffToolCall":', splitFetch + 'case"applyAgentDiffToolCall":', file);
  writeFileSync(file, t);
}

function patchBundled(file) {
  let t = readFileSync(file, "utf8");
  t = once(t, 'case"webSearchToolCall":return null;', bunSearch, file);
  t = once(t, 'case"webFetchToolCall":return null;', bunFetch, file);
  writeFileSync(file, t);
}

const chunkWith = (sub) => {
  const hits = readdirSync(join(dir, "dist", sub))
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, "dist", sub, f))
    .filter((f) => readFileSync(f, "utf8").includes('case"webSearchToolCall"'));
  if (hits.length !== 1) throw new Error(`dist/${sub}: expected one chunk with webSearchToolCall, got ${hits.length}`);
  return hits[0];
};

const targets = [chunkWith("cjs"), chunkWith("esm")];
for (const f of targets) patchSplit(f);
patchBundled(join(dir, "dist", "bundled", "index.js"));
for (const f of [...targets, join(dir, "dist", "bundled", "index.js")]) {
  const t = readFileSync(f, "utf8");
  if (!t.includes('type:"webSearch"') || !t.includes('type:"webFetch"')) throw new Error(`${f}: patch did not land`);
  console.log(`patched ${f.slice(dir.length + 1)}`);
}
