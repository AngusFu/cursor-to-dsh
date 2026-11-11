import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Cursor-side checkpoint rewrite (RFC §3.2, path M3).
 *
 * A live Cursor agent does not keep its history in memory: every `send` re-reads
 * the checkpoint from disk, and the request prompt is hydrated from
 * `state.rootPromptMessagesJson` — a list of 32-byte blob ids — not from
 * `state.turns`. Truncating `turns` alone therefore changes nothing the model
 * sees (`scripts/poc-m3b.ts`); the prompt refs have to go with it
 * (`scripts/poc-m3c.ts`, verified: the model stops recalling the dropped text).
 *
 * The rewrite happens between runs only — a run in flight writes its own
 * checkpoint when it ends and would undo this (`scripts/poc-checkpoint.ts`,
 * phase C: `pre=3 post=4`).
 *
 * All of this reads and writes the store directly through the public
 * `AgentCheckpointStore`; no SDK patching is involved.
 */

/** The slice of `AgentCheckpointStore` this module needs. */
export interface CheckpointStoreLike {
  loadLatest(agentId: string): Promise<unknown>;
  saveCheckpoint(agentId: string, checkpoint: unknown): Promise<unknown>;
}

export interface CompactResult {
  /** False = nothing was written; the caller must fall back to a fresh agent. */
  readonly ok: boolean;
  /** Present when `ok` is false. */
  readonly reason?: string;
  readonly turnsBefore: number;
  readonly turnsAfter: number;
  readonly refsBefore: number;
  readonly refsAfter: number;
  readonly droppedRefs: number;
}

/** 32-byte blob id, in any of the shapes a round-tripped proto field takes. */
export function refHex(v: unknown): string | null {
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

/** Parse every blob id in a `rootPromptMessagesJson`-shaped field. */
export function parseRefs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    const h = refHex(entry);
    if (h) out.push(h);
  }
  return out;
}

/** Text worth looking for in a blob payload. Short needles match too much. */
export function needlesFrom(texts: readonly string[], minLength = 16): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    for (const line of raw.split("\n")) {
      const needle = line.trim();
      if (needle.length < minLength || seen.has(needle)) continue;
      seen.add(needle);
      out.push(needle);
    }
  }
  return out;
}

export function payloadHoldsNeedle(payload: Buffer, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (payload.includes(Buffer.from(n, "utf8"))) return true;
  }
  return false;
}

interface StoreData {
  path: string;
  data: Map<string, Buffer>;
}

/** Every `store.db` under the workspace's `sdk-agent-store`, blob table loaded. */
function collectStores(cwd: string): StoreData[] {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const base = join(homedir(), ".cursor", "projects", slug, "sdk-agent-store");
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
      let st: ReturnType<typeof statSync>;
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

  const out: StoreData[] = [];
  for (const p of found) {
    try {
      // node:sqlite is built in from Node 22.5; typed lazily so this module
      // stays importable where the type stubs are absent.
      const sqlite = require("node:sqlite") as { DatabaseSync: any };
      const db = new sqlite.DatabaseSync(p, { readOnly: true });
      const rows = db.prepare("select id, data from blobs").all() as { id: string; data: Uint8Array }[];
      db.close();
      out.push({ path: p, data: new Map(rows.map((r) => [String(r.id), Buffer.from(r.data)])) });
    } catch {
      /* unreadable store; another one may hold the refs */
    }
  }
  return out;
}

/** The store that actually resolves these refs (one workspace can have several). */
export function findStore(cwd: string, refs: readonly string[]): StoreData | null {
  let best: StoreData | null = null;
  let bestHits = 0;
  for (const store of collectStores(cwd)) {
    const hits = refs.filter((r) => store.data.has(r)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = store;
    }
  }
  return bestHits > 0 ? best : null;
}

function setField(state: any, key: string, value: unknown): void {
  try {
    state[key] = value;
  } catch {
    // Frozen or accessor-backed proto: rebuild through a plain object.
    Object.assign(state, { ...state, [key]: value });
  }
}

/**
 * Shrink `agentId`'s checkpoint to its last `keepTurns` turns and drop every
 * prompt ref whose payload still carries the text being compacted away.
 *
 * Fails closed: if the store cannot be located, or nothing that should have
 * been dropped was, nothing is written and the caller falls back to M2 (a
 * fresh agent) rather than claiming a compression that did not happen.
 */
export async function compactCheckpoint(opts: {
  store: CheckpointStoreLike;
  agentId: string;
  cwd: string;
  keepTurns: number;
  /** Text that must no longer reach the model. */
  needles: readonly string[];
  /** Refs already known to be part of the retained tail; never dropped. */
  keepRefs?: readonly string[];
  /** A blob may mix dropped history with system/tail; never delete that blob. */
  keepNeedles?: readonly string[];
}): Promise<CompactResult> {
  const empty = { turnsBefore: 0, turnsAfter: 0, refsBefore: 0, refsAfter: 0, droppedRefs: 0 };
  const state: any = await opts.store.loadLatest(opts.agentId);
  if (!state || typeof state !== "object") {
    return { ...empty, ok: false, reason: "no checkpoint to rewrite" };
  }

  const turnsBefore = Array.isArray(state.turns) ? state.turns.length : 0;
  const refsBefore = parseRefs(state.rootPromptMessagesJson);
  if (turnsBefore === 0 || refsBefore.length === 0) {
    return { ...empty, turnsBefore, refsBefore: refsBefore.length, ok: false, reason: "checkpoint has no turns or prompt refs" };
  }
  if (opts.needles.length === 0) {
    return { ...empty, turnsBefore, refsBefore: refsBefore.length, ok: false, reason: "nothing to drop" };
  }

  const store = findStore(opts.cwd, refsBefore);
  if (!store) {
    return { ...empty, turnsBefore, refsBefore: refsBefore.length, ok: false, reason: "store.db not found for this workspace" };
  }

  const keep = new Set(opts.keepRefs ?? []);
  const survivors: string[] = [];
  const dropped: string[] = [];
  for (const ref of refsBefore) {
    if (keep.has(ref)) {
      survivors.push(ref);
      continue;
    }
    const payload = store.data.get(ref);
    if (payload && payloadHoldsNeedle(payload, opts.keepNeedles ?? []) && payloadHoldsNeedle(payload, opts.needles)) {
      return { ...empty, turnsBefore, refsBefore: refsBefore.length, ok: false, reason: "prompt ref mixes compressed and retained content; replay required" };
    }
    if (payload && payloadHoldsNeedle(payload, opts.keepNeedles ?? [])) survivors.push(ref);
    else if (payload && payloadHoldsNeedle(payload, opts.needles)) dropped.push(ref);
    else survivors.push(ref);
  }
  if (dropped.length === 0) {
    return { ...empty, turnsBefore, refsBefore: refsBefore.length, ok: false, reason: "no prompt ref held the compacted text" };
  }

  const keepTurns = Math.max(0, opts.keepTurns);
  setField(state, "turns", Array.from(state.turns as ArrayLike<unknown>).slice(-keepTurns || undefined));
  setField(
    state,
    "rootPromptMessagesJson",
    Array.isArray(state.rootPromptMessagesJson)
      ? state.rootPromptMessagesJson.filter((e: unknown) => {
          const h = refHex(e);
          return h === null ? true : survivors.includes(h);
        })
      : state.rootPromptMessagesJson,
  );

  await opts.store.saveCheckpoint(opts.agentId, state);

  const back: any = await opts.store.loadLatest(opts.agentId);
  const refsAfter = parseRefs(back?.rootPromptMessagesJson);
  const turnsAfter = Array.isArray(back?.turns) ? back.turns.length : 0;
  const leaked = refsAfter.filter((r) => dropped.includes(r));
  if (leaked.length > 0) {
    return { ok: false, reason: `${leaked.length} dropped ref(s) survived the read-back`, turnsBefore, turnsAfter, refsBefore: refsBefore.length, refsAfter: refsAfter.length, droppedRefs: dropped.length };
  }
  if (turnsAfter > turnsBefore) {
    return { ok: false, reason: `turns grew after the rewrite (${turnsBefore} -> ${turnsAfter}); a run wrote over it`, turnsBefore, turnsAfter, refsBefore: refsBefore.length, refsAfter: refsAfter.length, droppedRefs: dropped.length };
  }
  return { ok: true, turnsBefore, turnsAfter, refsBefore: refsBefore.length, refsAfter: refsAfter.length, droppedRefs: dropped.length };
}
