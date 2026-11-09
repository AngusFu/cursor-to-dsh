/**
 * PoC M3-decisive #2.
 *
 * Finding from poc-blobs: the request prompt is hydrated from
 * `state.rootPromptMessagesJson` (a list of 32-byte blob ids), NOT from
 * `state.turns`. Truncating `turns` alone leaves the token blobs referenced.
 *
 * This run truncates BOTH:
 *   - state.turns              -> keep only the clean tail turn
 *   - state.rootPromptMessagesJson -> drop every blob id whose payload holds the token
 * then probes with a fresh handle. If the model finally forgot, M3 works once the
 * prompt-hydrating refs are rewritten. If it still remembers, memory is elsewhere
 * (or server-side) and M3 is dead.
 *
 *   CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-m3c.ts [model]
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import Database from "node:sqlite";
import { createAgentPlatform } from "@cursor/sdk";

const model = process.argv[2] || "claude-haiku-5-5";
const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("CURSOR_API_KEY is required");
  process.exit(1);
}

const cwd = process.cwd();
const TOKEN = `M3C-${Date.now().toString(36).toUpperCase()}`;
const id = `poc-m3c-${Date.now()}`;

let failures = 0;
const info = (label: string, detail: unknown) => console.log(`  ${label}: ${detail}`);
const ok = (label: string, detail = "") => console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label: string, detail = "") => {
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

async function turn(agent: any, text: string) {
  const run = await agent.send(text);
  for await (const _ of run.stream()) {
    /* drain */
  }
  const res = await run.wait();
  return { status: res.status, text: res.result ?? "", error: res.error?.message };
}

/** 32-byte array / string -> hex blob id */
function refHex(v: unknown): string | null {
  if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) return v;
  if (v instanceof Uint8Array && v.length === 32) return Buffer.from(v).toString("hex");
  if (Array.isArray(v) && v.length === 32 && v.every((n) => typeof n === "number")) {
    return Buffer.from(v as number[]).toString("hex");
  }
  if (v && typeof v === "object") {
    // proto bytes often round-trip as {0:n,1:n,...}
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 32 && keys.every((k, i) => k === String(i) && typeof o[k] === "number")) {
      return Buffer.from(keys.map((k) => o[k] as number)).toString("hex");
    }
  }
  return null;
}

/** Find the store.db whose blob table resolves these refs. */
function findStore(refs: string[]): { path: string; data: Map<string, Buffer> } | null {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const base = join(homedir(), ".cursor", "projects", slug, "sdk-agent-store");
  const { DatabaseSync } = Database as any;
  const found: string[] = [];
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
      else if (e === "store.db") found.push(p);
    }
  };
  walk(base, 0);
  let best: { path: string; data: Map<string, Buffer> } | null = null;
  let bestHits = 0;
  for (const p of found) {
    try {
      const db = new DatabaseSync(p, { readOnly: true });
      const rows = db.prepare("select id, data from blobs").all() as any[];
      db.close();
      const map = new Map<string, Buffer>(rows.map((r) => [String(r.id), Buffer.from(r.data)]));
      const hits = refs.filter((r) => map.has(r)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = { path: p, data: map };
      }
    } catch {
      /* unreadable */
    }
  }
  return bestHits > 0 ? best : null;
}

console.log(`model=${model} cwd=${cwd}\nagent=${id}\ntoken=${TOKEN}\n`);

const platform = await createAgentPlatform();

console.log("--- seed ---");
const agent = await platform.createAgent({
  model: { id: model },
  apiKey,
  tools: [],
  agentId: id,
  name: "m3c",
  local: { cwd, settingSources: [] },
} as any);

info("seed", JSON.stringify(await turn(agent, `Remember this code word: ${TOKEN}. Reply with just OK.`)));
const control = await turn(agent, `What code word did I give you earlier? Reply with just the code word.`);
info("control", `${control.status} ${control.text}`);
if (control.text.includes(TOKEN)) ok("control remembers", control.text);
else bad("control remembers", control.text);

console.log("\n--- clean tail (must NOT contain the token) ---");
const tailTurn = await turn(agent, "Reply with just OK.");
info("tail", `${tailTurn.status} ${tailTurn.text}`);

console.log("\n--- inspect prompt-hydrating refs ---");
const state: any = await platform.checkpointStore.loadLatest(id);
info("turns before", state.turns?.length);
const rp = state.rootPromptMessagesJson;
info("rootPromptMessagesJson", `isArray=${Array.isArray(rp)} len=${Array.isArray(rp) ? rp.length : "n/a"}`);

const refs: string[] = [];
if (Array.isArray(rp)) {
  for (const entry of rp) {
    const h = refHex(entry);
    if (h) refs.push(h);
  }
}
info("parsed blob ids", refs.length);

const store = findStore(refs);
if (!store) {
  bad("locate store.db", "could not resolve rootPromptMessagesJson blobs in any store.db");
} else {
  info("store", store.path.replace(homedir(), "~"));
  const tokenBuf = Buffer.from(TOKEN, "utf8");
  const tokenRefs = refs.filter((r) => (store.data.get(r) ?? Buffer.alloc(0)).includes(tokenBuf));
  const cleanRefs = refs.filter((r) => !tokenRefs.includes(r));
  info("refs holding token", `${tokenRefs.length} of ${refs.length}`);
  for (const r of tokenRefs) {
    const d = store.data.get(r)!;
    const idx = d.indexOf(tokenBuf);
    info(`  ref ${r.slice(0, 16)}`, `size=${d.length} ${JSON.stringify(d.slice(Math.max(0, idx - 90), idx + 40).toString("utf8"))}`);
  }

  // --- the actual intervention ---
  console.log("\n--- truncate turns AND drop token-bearing prompt refs ---");
  try {
    state.turns = Array.from(state.turns as ArrayLike<unknown>).slice(-1);
  } catch {
    const f = { ...state } as any;
    f.turns = Array.from((state.turns ?? []) as ArrayLike<unknown>).slice(-1);
    Object.assign(state, f);
  }
  try {
    state.rootPromptMessagesJson = Array.isArray(rp) ? rp.filter((e: unknown) => {
      const h = refHex(e);
      return h !== null && !tokenRefs.includes(h);
    }) : rp;
  } catch {
    const f = { ...state } as any;
    f.rootPromptMessagesJson = Array.isArray(rp)
      ? rp.filter((e: unknown) => {
          const h = refHex(e);
          return h !== null && !tokenRefs.includes(h);
        })
      : rp;
    Object.assign(state, f);
  }
  info("turns after", state.turns?.length);
  info("rootPrompt refs after", Array.isArray(state.rootPromptMessagesJson) ? state.rootPromptMessagesJson.length : "n/a");

  const ref = await platform.checkpointStore.saveCheckpoint(id, state);
  info("saveCheckpoint", JSON.stringify(ref));

  const back: any = await platform.checkpointStore.loadLatest(id);
  const backRefs: string[] = [];
  if (Array.isArray(back.rootPromptMessagesJson)) {
    for (const e of back.rootPromptMessagesJson) {
      const h = refHex(e);
      if (h) backRefs.push(h);
    }
  }
  info("read-back turns", back.turns?.length);
  info("read-back rootPrompt refs", backRefs.length);
  const stillToken = backRefs.filter((r) => tokenRefs.includes(r));
  if (back.turns?.length === 1 && stillToken.length === 0) {
    ok("read-back clean", `turns=1, token refs dropped (${tokenRefs.length})`);
  } else {
    bad("read-back clean", `turns=${back.turns?.length} tokenRefsLeft=${stillToken.length}`);
  }

  console.log("\n--- probe with a fresh handle ---");
  try {
    agent.close();
  } catch {
    /* sync close */
  }
  const fresh: any = await platform.resumeAgent(id, {
    model: { id: model },
    apiKey,
    tools: [],
    local: { cwd, settingSources: [] },
  } as any);
  const probe = await turn(fresh, `What code word did I give you earlier? Reply with just the code word.`);
  info("probe", `${probe.status} ${probe.text}${probe.error ? ` ERR=${probe.error}` : ""}`);
  if (probe.error) bad("probe send", probe.error);
  else if (probe.text.includes(TOKEN)) bad("model forgot", probe.text);
  else ok("model forgot", probe.text);
  try {
    fresh.close();
  } catch {
    /* ditto */
  }
}

console.log(`\n=== RESULT: ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
console.log(`agents kept: ${id}`);
process.exit(failures === 0 ? 0 : 1);
