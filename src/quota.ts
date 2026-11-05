/**
 * Shared quota core for the UI (Settings card + conversation usage pill).
 *
 * Provider-specific fetching lives next door: `quota-cursor.ts` and
 * `quota-copilot.ts`. This module owns only the shapes every provider
 * reports, the tone thresholds, and the small SWR cache both use.
 */
export type UsageTone = "ok" | "warning" | "danger";
export type UsageStatus = "available" | "unavailable" | "error";
export type UsageMode = "auto" | "always" | "off";

export interface UsageWindow {
  id: string;
  /** Percent used, clamped to 0..100. 0 while `unlimited`. */
  usedPct: number;
  resetsAt: string | null;
  tone: UsageTone;
  /** The provider reported no cap (Copilot business chat, for example). */
  unlimited?: boolean;
}

export interface UsageSnapshot {
  status: UsageStatus;
  windows: UsageWindow[];
  fetchedAt: string;
  /** Which credential answered, e.g. "Cursor state.vscdb", "DSH Copilot grant". */
  sourceLabel: string | null;
  /** Whether any credential exists at all (drives the setup hint). */
  configured: boolean;
  error: string | null;
  /** Plan name when the provider reports one, e.g. "business". */
  planLabel?: string | null;
}

export type UsageFetch = typeof fetch;

export function toneFromUsedPct(usedPct: number): UsageTone {
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Providers send unix ms or s as a number or string, or an ISO / bare date string. */
export function parseTimestamp(value: unknown): string | null {
  const raw = finiteNumber(value);
  if (raw !== null) {
    const ms = Math.abs(raw) < 10_000_000_000 ? raw * 1000 : raw;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value.trim());
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Clamp to 0..100 and round to 4 decimals so payloads stay clean (UI rounds to 1). */
export function clampPct(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10_000) / 10_000;
}

export interface UsageCache<T> {
  read(force: boolean, run: () => Promise<T>): Promise<T>;
  reset(): void;
}

const SUCCESS_TTL_MS = 2 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;

/**
 * Two-minute SWR cache for successful reads, half a minute for failures, so a
 * pill polling every 60s cannot hammer the provider. Concurrent reads share
 * one in-flight request. `fresh` decides which TTL applies.
 */
export function createUsageCache<T>(fresh: (value: T) => boolean): UsageCache<T> {
  let entry: { at: number; value: T } | null = null;
  let pending: Promise<T> | null = null;
  return {
    read(force: boolean, run: () => Promise<T>): Promise<T> {
      if (pending) return pending;
      if (!force && entry && Date.now() - entry.at < (fresh(entry.value) ? SUCCESS_TTL_MS : ERROR_TTL_MS)) {
        return Promise.resolve(entry.value);
      }
      pending = run()
        .then((value) => {
          entry = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    reset(): void {
      entry = null;
      pending = null;
    },
  };
}
