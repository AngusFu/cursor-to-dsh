/**
 * Where does the transcript actually live?
 *
 *   CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-blobs.ts <agentId> <token>
 *
 * Dumps rootPromptMessagesJson as decoded utf8, then scans store.db's `blobs`
 * table for the token and reports which blob ids hold it and whether the
 * current checkpoint still references them.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import Database from "node:sqlite";
import { createAgentPlatform } from "@cursor/sdk";

const [agentId, token] = process.argv.slice(2);
if (!agentId || !token) {
  console.error("usage: poc-blobs.ts <agentId> <token>");
  process.exit(1);
}

const { DatabaseSync } = Database as any;
const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
const base = join(homedir(), ".cursor", "projects", slug, "sdk-agent-store");
const storeRoot = `${base}/${createHash("sha256").update(process.cwd()).digest("hex")}`;

/** Decode a bytes-ish value to utf8. */
function toBytes(v: unknown): number[] | null {
  if (typeof v === "string") return [...Buffer.from(v, "utf8")];
  if (v instanceof Uint8Array) return [...v];
  if (Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number")) return v as number[];
  return null;
}

async function main() {
  const platform = await createAgentPlatform();
  const state: any = await platform.checkpointStore.loadLatest(agentId);

  console.log(`=== rootPromptMessagesJson ===`);
  const rp = state?.rootPromptMessagesJson;
  console.log(`  type=${typeof rp} isArray=${Array.isArray(rp)} ctor=${rp?.constructor?.name}`);
  const bytes = toBytes(rp);
  if (bytes) {
    const buf = Buffer.from(bytes);
    console.log(`  bytes=${buf.length}`);
    console.log(`  as utf8: ${JSON.stringify(buf.toString("utf8").slice(0, 600))}`);
    console.log(`  contains token (utf8): ${buf.toString("utf8").includes(token)}`);
    // Maybe it is a JSON array of blob ids stored as bytes.
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      console.log(`  json parse ok: type=${Array.isArray(parsed) ? "array" : typeof parsed} len=${parsed?.length}`);
      if (Array.isArray(parsed)) console.log(`  first entries: ${JSON.stringify(parsed.slice(0, 4))}`);
    } catch {
      console.log(`  json parse failed`);
    }
    // gzip / deflate?
    for (const [name, fn] of Object.entries({
      gunzip: (b: Buffer) => gunzipSync(b),
      inflate: (b: Buffer) => inflateSync(b),
      inflateRaw: (b: Buffer) => inflateRawSync(b),
      brotli: (b: Buffer) => brotliDecompressSync(b),
    })) {
      try {
        const out = (fn as any)(buf).toString("utf8");
        console.log(`  ${name} ok (${out.length}): ${JSON.stringify(out.slice(0, 300))}`);
        console.log(`  ${name} contains token: ${out.includes(token)}`);
      } catch {
        /* not that codec */
      }
    }
  } else {
    console.log(`  value: ${JSON.stringify(rp)?.slice(0, 600)}`);
    console.log(`  contains token: ${JSON.stringify(rp ?? "").includes(token)}`);
  }

  // rootPromptMessagesJson is an array of 32-byte blob ids — the prompt is
  // hydrated from exactly these. Resolve them and see whether they hold the token.
  const rootRefs: string[] = [];
  if (Array.isArray(rp)) {
    for (const entry of rp) {
      const b = toBytes(entry);
      if (b && b.length === 32) rootRefs.push(Buffer.from(b).toString("hex"));
      else if (typeof entry === "string" && /^[0-9a-f]{64}$/.test(entry)) rootRefs.push(entry);
    }
  }
  console.log(`  rootPromptMessagesJson blob ids: ${rootRefs.length}`);

  console.log(`\n=== store.db blobs ===`);
  const dbs: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st: any;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e === "store.db") dbs.push(p);
    }
  };
  walk(storeRoot, 0);
  console.log(`  store.db files: ${dbs.length}`);

  const checkpointRefs = new Set<string>();
  const collect = (v: unknown, depth = 0) => {
    if (depth > 6 || v == null) return;
    if (typeof v === "string") {
      if (/^[0-9a-f]{64}$/.test(v)) checkpointRefs.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) collect(x, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) collect(x, depth + 1);
    }
  };
  collect(state);
  console.log(`  64-hex refs in checkpoint: ${checkpointRefs.size}`);

  for (const dbPath of dbs) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("select id, data from blobs").all() as any[];
      const hits = rows.filter((r) => Buffer.from(r.data).includes(Buffer.from(token, "utf8")));
      console.log(`  ${dbPath.replace(homedir(), "~")}`);
      console.log(`    blobs=${rows.length} containing token=${hits.length}`);
      // Are the prompt-hydrating blobs in THIS store, and do they hold the token?
      const byId = new Map(rows.map((r) => [String(r.id), Buffer.from(r.data)]));
      const present = rootRefs.filter((id) => byId.has(id));
      if (rootRefs.length > 0) {
        console.log(`    rootPrompt blobs resolved here: ${present.length}/${rootRefs.length}`);
        for (const id of rootRefs) {
          const data = byId.get(id);
          if (!data) continue;
          const has = data.includes(Buffer.from(token, "utf8"));
          console.log(`      ${id.slice(0, 16)} size=${data.length} holdsToken=${has}`);
          if (has) {
            const idx = data.indexOf(Buffer.from(token, "utf8"));
            console.log(`        ${JSON.stringify(data.slice(Math.max(0, idx - 140), idx + 60).toString("utf8"))}`);
          }
        }
      }
      for (const h of hits) {
        const buf = Buffer.from(h.data);
        const idx = buf.indexOf(Buffer.from(token, "utf8"));
        const referenced = checkpointRefs.has(h.id);
        console.log(`    HIT id=${h.id} size=${buf.length} referencedByCheckpoint=${referenced}`);
        console.log(`      context: ${JSON.stringify(buf.slice(Math.max(0, idx - 120), idx + 80).toString("utf8"))}`);
      }
      const unreferencedHits = hits.filter((h) => !checkpointRefs.has(h.id));
      console.log(`    hits NOT referenced by current checkpoint: ${unreferencedHits.length}`);
    } catch (e) {
      console.log(`    read failed: ${String(e)}`);
    } finally {
      db.close();
    }
  }

  console.log(`\n=== meta ===`);
  for (const dbPath of dbs) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("select key, value from meta").all() as any[];
      console.log(`  ${dbPath.replace(homedir(), "~")}`);
      for (const r of rows) {
        const v = Buffer.isBuffer(r.value) ? Buffer.from(r.value).toString("utf8") : String(r.value);
        console.log(`    ${r.key} = ${v.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`    meta read failed: ${String(e)}`);
    } finally {
      db.close();
    }
  }
}

await main();
process.exit(0);
