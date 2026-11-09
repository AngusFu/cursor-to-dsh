/**
 * Per-DSH-session compression the model requested via
 * `cursor_context_compress`. Committed after the tool-result batch (§7.2 handoff).
 */

export interface PendingModelCompress {
  readonly summary: string;
  readonly keepTurns: number;
  readonly revision: number;
  readonly at: number;
  readonly topic?: string;
  readonly startRef?: string;
  readonly endRef?: string;
}

const PENDING = new Map<string, PendingModelCompress>();
let revisionSeq = 0;

export interface ScheduleCompressOpts {
  keepTurns: number;
  topic?: string;
  startRef?: string;
  endRef?: string;
}

/** Schedule a model-authored compression for a Cursor session id. */
export function scheduleModelCompress(
  sessionId: string,
  summary: string,
  opts: ScheduleCompressOpts,
): PendingModelCompress {
  const entry: PendingModelCompress = {
    summary: summary.trim(),
    keepTurns: Math.max(1, Math.floor(opts.keepTurns) || 1),
    revision: ++revisionSeq,
    at: Date.now(),
    topic: opts.topic?.trim() || undefined,
    startRef: opts.startRef?.trim() || undefined,
    endRef: opts.endRef?.trim() || undefined,
  };
  PENDING.set(sessionId, entry);
  return entry;
}

export function rescheduleModelCompress(sessionId: string, pending: PendingModelCompress): void {
  PENDING.set(sessionId, pending);
}

export function peekModelCompress(sessionId: string): PendingModelCompress | undefined {
  return PENDING.get(sessionId);
}

export function takeModelCompress(sessionId: string): PendingModelCompress | undefined {
  const hit = PENDING.get(sessionId);
  if (hit) PENDING.delete(sessionId);
  return hit;
}

/** Test hook. */
export function clearAllPendingCompress(): void {
  PENDING.clear();
  revisionSeq = 0;
}
