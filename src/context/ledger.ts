/**
 * In-memory原文账本：压缩时归档被 drop 的消息，支持 search / decompress。
 * Message refs come exclusively from acp-kernel assign-refs (via kernelTurnPlan).
 */
import {
  loadArchiveChunks,
  loadMessageRefs,
  persistArchiveChunk,
  persistMessageRefs,
} from "./ledger-persist.ts";
import { clearKernelSessions, kernelTurnPlan, type AcpPreserveConfig } from "./kernel.ts";
import { resolveCompressionLayer } from "./layers.ts";
import { incrementText, textOf } from "../prompt.ts";

export interface MessageRef {
  readonly ref: string;
  index: number;
  readonly fingerprint: string;
  text: string;
  archived: boolean;
}

export interface ArchiveChunk {
  readonly id: string;
  readonly revision: number;
  readonly messageRefs: readonly string[];
  readonly text: string;
  readonly summary: string;
  readonly tier?: number;
  readonly at: number;
}

interface SessionLedger {
  nextChunk: number;
  byFp: Map<string, string>;
  refs: MessageRef[];
  chunks: ArchiveChunk[];
}

const LEDGERS = new Map<string, SessionLedger>();
const DEFAULT_CONTEXT_WINDOW = 200_000;

function ledgerOf(sessionId: string): SessionLedger {
  let s = LEDGERS.get(sessionId);
  if (!s) {
    const stored = loadArchiveChunks(sessionId);
    const refsStored = loadMessageRefs(sessionId);
    const nextChunk = stored.length
      ? Math.max(...stored.map((c) => Number.parseInt(c.id.slice(1), 10))) + 1
      : 1;
    const byFp = new Map(refsStored.map((r) => [r.fingerprint, r.ref]));
    const refs = refsStored.map((r) => ({
      ref: r.ref,
      index: r.index,
      fingerprint: r.fingerprint,
      text: r.text,
      archived: r.archived,
    }));
    s = { nextChunk, byFp, refs, chunks: [...stored] };
    LEDGERS.set(sessionId, s);
  }
  return s;
}

function chunkId(n: number): string {
  return `c${String(n).padStart(5, "0")}`;
}

function estimateTokens(messages: readonly any[]): number {
  return Math.ceil(
    messages.reduce((n, m) => n + (incrementText(m) || textOf(m?.content) || "").length / 4, 0),
  );
}

/** Sync ledger refs from acp-kernel (single source of truth for message refs). */
export function syncMessageRefs(
  sessionId: string,
  messages: readonly any[],
  opts?: { tokenCount?: number; contextWindow?: number; compactedAt?: number; preserve?: AcpPreserveConfig },
): readonly MessageRef[] {
  const s = ledgerOf(sessionId);
  if (!messages.length) return [];
  const window = opts?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const tokenCount = opts?.tokenCount ?? estimateTokens(messages);
  const plan = kernelTurnPlan(sessionId, messages, tokenCount, window, {
    compactedAt: opts?.compactedAt ?? 0,
    preserve: opts?.preserve,
  });

  const out: MessageRef[] = [];
  const live = new Set<string>();
  for (const part of plan.messageRefs) {
    const { fingerprint: fp, ref, index, text } = part;
    s.byFp.set(fp, ref);
    live.add(ref);
    const entry: MessageRef = { ref, index, fingerprint: fp, text, archived: plan.coveredCoreIds.has(fp) };
    const existing = s.refs.find((r) => r.ref === ref);
    if (existing) {
      Object.assign(existing, entry);
      out.push(existing);
    } else {
      s.refs.push(entry);
      out.push(entry);
    }
  }
  s.refs = s.refs.filter((r) => live.has(r.ref) || r.archived);
  persistMessageRefs(
    sessionId,
    s.refs.map((r) => ({
      ref: r.ref,
      fingerprint: r.fingerprint,
      text: r.text,
      index: r.index,
      archived: r.archived,
    })),
  );
  return out;
}

export function refAt(sessionId: string, ref: string): MessageRef | undefined {
  return ledgerOf(sessionId).refs.find((r) => r.ref === ref);
}

export function refsInRange(sessionId: string, startRef: string, endRef: string): MessageRef[] | undefined {
  const s = ledgerOf(sessionId);
  const start = s.refs.find((r) => r.ref === startRef);
  const end = s.refs.find((r) => r.ref === endRef);
  if (!start || !end || start.index > end.index) return undefined;
  return s.refs.filter((r) => r.index >= start.index && r.index <= end.index);
}

/** Message refs or block ids (bN) in the compressible index window. */
export function compressibleRefs(sessionId: string, compactedAt: number, keepFrom: number): MessageRef[] {
  const s = ledgerOf(sessionId);
  return s.refs.filter((r) => !r.archived && r.index >= compactedAt && r.index < keepFrom);
}

export interface CompressRefRange {
  readonly startRef: string;
  readonly endRef: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface CompressRefClamp {
  readonly requested: { readonly startRef: string; readonly endRef: string };
  readonly reason: string;
}

/** Resolve (and clamp) an inclusive ref range to the droppable window; never throws. */
export function resolveCompressRefRange(
  sessionId: string,
  startRef: string,
  endRef: string,
  compactedAt: number,
  keepFrom: number,
  droppable: ReadonlySet<string>,
):
  | { ok: true; refRange: CompressRefRange; clamped?: CompressRefClamp }
  | { ok: false; reason: string } {
  if (!refAt(sessionId, startRef) || !refAt(sessionId, endRef)) {
    return {
      ok: false,
      reason: `unknown ref(s); run cursor_context_status. startRef=${startRef} endRef=${endRef}`,
    };
  }
  const span = refsInRange(sessionId, startRef, endRef);
  if (!span?.length) {
    return { ok: false, reason: `invalid ref order ${startRef}..${endRef}` };
  }
  const eligible = (r: MessageRef) => !r.archived && r.index >= compactedAt && r.index < keepFrom && droppable.has(r.ref);
  const first = span.find(eligible);
  const last = [...span].reverse().find(eligible);
  if (!first || !last) {
    return {
      ok: false,
      reason: `range ${startRef}..${endRef} has no droppable messages (preserveKeepFrom index ${keepFrom})`,
    };
  }
  const between = span.filter((r) => r.index >= first.index && r.index <= last.index);
  if (!between.every(eligible)) {
    return {
      ok: false,
      reason: `range ${startRef}..${endRef} crosses protected messages; pick a sub-range from compressibleRefs`,
    };
  }
  const refRange: CompressRefRange = {
    startRef: first.ref,
    endRef: last.ref,
    startIndex: first.index,
    endIndex: last.index,
  };
  const clamped =
    first.ref !== startRef || last.ref !== endRef
      ? {
          requested: { startRef, endRef },
          reason: `clamped to droppable ${first.ref}..${last.ref} (preserveKeepFrom index ${keepFrom})`,
        }
      : undefined;
  return { ok: true, refRange, clamped };
}

export function archiveCompression(opts: {
  sessionId: string;
  revision: number;
  summary: string;
  dropRefs: readonly string[];
  dropText: string;
  topic?: string;
}): ArchiveChunk {
  const s = ledgerOf(opts.sessionId);
  const id = chunkId(s.nextChunk++);
  for (const ref of opts.dropRefs) {
    const hit = s.refs.find((r) => r.ref === ref);
    if (hit) hit.archived = true;
  }
  const tier = resolveCompressionLayer(opts.topic) === "T3" ? 3 : resolveCompressionLayer(opts.topic) === "T2" ? 2 : 1;
  const chunk: ArchiveChunk = {
    id,
    revision: opts.revision,
    messageRefs: [...opts.dropRefs],
    text: opts.dropText,
    summary: opts.summary,
    tier,
    at: Date.now(),
  };
  s.chunks.push(chunk);
  persistArchiveChunk(opts.sessionId, chunk);
  return chunk;
}

export function ledgerStats(sessionId: string): {
  messageRefs: number;
  archivedRefs: number;
  chunks: number;
  chunkIds: string[];
} {
  const s = ledgerOf(sessionId);
  return {
    messageRefs: s.refs.length,
    archivedRefs: s.refs.filter((r) => r.archived).length,
    chunks: s.chunks.length,
    chunkIds: s.chunks.map((c) => c.id),
  };
}

export function searchArchive(sessionId: string, query: string, limit: number): { ref: string; chunkId: string; snippet: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const s = ledgerOf(sessionId);
  const hits: { ref: string; chunkId: string; snippet: string; at: number }[] = [];
  for (const chunk of s.chunks) {
    const text = chunk.text.toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const i = text.indexOf(q, pos);
      if (i < 0) break;
      const start = Math.max(0, i - 80);
      const end = Math.min(chunk.text.length, i + q.length + 120);
      hits.push({
        ref: chunk.messageRefs[0] ?? chunk.id,
        chunkId: chunk.id,
        snippet: chunk.text.slice(start, end),
        at: chunk.at,
      });
      pos = i + q.length;
      if (hits.length >= limit) return hits;
    }
  }
  hits.sort((a, b) => b.at - a.at);
  return hits.slice(0, limit);
}

export function decompressChunk(opts: {
  sessionId: string;
  ref?: string;
  chunkId?: string;
  offset?: number;
  limit?: number;
}): { chunkId: string; ref: string; offset: number; totalChars: number; text: string; hasMore: boolean } | undefined {
  const s = ledgerOf(opts.sessionId);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 8_000)), 32_000);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  let chunk: ArchiveChunk | undefined;
  if (opts.chunkId) chunk = s.chunks.find((c) => c.id === opts.chunkId);
  else if (opts.ref) {
    chunk = [...s.chunks].reverse().find((c) => c.messageRefs.includes(opts.ref!));
  } else if (s.chunks.length) chunk = s.chunks[s.chunks.length - 1];
  if (!chunk) return undefined;
  const totalChars = chunk.text.length;
  const text = chunk.text.slice(offset, offset + limit);
  return {
    chunkId: chunk.id,
    ref: chunk.messageRefs[0] ?? chunk.id,
    offset,
    totalChars,
    text,
    hasMore: offset + text.length < totalChars,
  };
}

/** Test hook. */
export function clearLedgers(): void {
  LEDGERS.clear();
  clearKernelSessions();
}
