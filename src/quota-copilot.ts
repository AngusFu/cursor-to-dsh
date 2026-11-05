/**
 * GitHub Copilot usage for the UI.
 *
 * Read-only: the Copilot sign-in itself belongs to
 * `@lujianjun19/dsh-llm-github-copilot`, which stores a grant under the
 * `llm-pi-ai` credential scope; this module only borrows the long-lived OAuth
 * token from it (or from env / `gh auth token`) and calls the same internal
 * endpoint the editor uses.
 *
 * Response shapes by plan:
 * - paid / Pro / Business: `quota_snapshots.{chat,completions,premium_interactions}`
 *   with entitlement / remaining / percent_remaining, `quota_reset_date`
 * - free / limited: `monthly_quotas` (total) + `limited_user_quotas` (used)
 *   + `limited_user_reset_date`
 * - unlimited buckets (Business chat) carry `unlimited: true` and stay a row
 *   marked 不限 instead of a fake percentage.
 */
import { execFile } from "node:child_process";

import {
  clampPct,
  createUsageCache,
  finiteNumber,
  parseTimestamp,
  toneFromUsedPct,
  type UsageFetch,
  type UsageSnapshot,
  type UsageWindow,
} from "./quota.ts";

const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const HTTP_TIMEOUT_MS = 15_000;

/** Identity headers the Copilot editor clients send (matches the sign-in plugin). */
const HEADERS = {
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "user-agent": "GitHubCopilotChat/0.35.0",
};

export interface CopilotUsageOptions {
  fetchImpl?: UsageFetch;
  env?: NodeJS.ProcessEnv;
  /** Tokens already resolved outside (DSH credentials grant, launch env). */
  tokens?: string[];
  execFileImpl?: typeof execFile;
  force?: boolean;
}

interface TokenCandidate {
  token: string;
  label: string;
}

const cache = createUsageCache<UsageSnapshot>((value) => value.status === "available");

/** Test hook. */
export function resetCopilotUsageCache(): void {
  cache.reset();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The GitHub CLI's OAuth token, for hosts that signed in with `gh auth login`. */
function ghAuthToken(execFileImpl: typeof execFile, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFileImpl("gh", ["auth", "token"], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? null : (stdout || "").trim() || null);
    });
  });
}

export async function copilotTokenCandidates(
  env: NodeJS.ProcessEnv,
  tokens: string[],
  execFileImpl: typeof execFile = execFile,
): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  const push = (token: string | null | undefined, label: string): void => {
    const clean = typeof token === "string" ? token.trim() : "";
    if (!clean || out.some((candidate) => candidate.token === clean)) return;
    out.push({ token: clean, label });
  };

  for (const token of tokens) push(token, "DSH Copilot grant");
  push(env["COPILOT_TOKEN"] || env["GITHUB_TOKEN"] || env["GITHUB_PAT"], "env token");
  push(await ghAuthToken(execFileImpl), "gh auth token");
  return out;
}

async function connectUsage(
  token: string,
  fetchImpl: UsageFetch,
): Promise<Response> {
  return fetchImpl(COPILOT_USAGE_URL, {
    headers: { ...HEADERS, authorization: `token ${token}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

/** One `quota_snapshots` bucket -> a window; null when it reports nothing usable. */
function snapshotWindow(
  id: string,
  snap: unknown,
  resetsAt: string | null,
): UsageWindow | null {
  if (!snap || typeof snap !== "object") return null;
  const bucket = snap as Record<string, unknown>;
  if (bucket["has_quota"] === false && bucket["unlimited"] !== true) return null;
  if (bucket["unlimited"] === true) {
    return { id, usedPct: 0, resetsAt, tone: toneFromUsedPct(0), unlimited: true };
  }
  const percentRemaining = finiteNumber(bucket["percent_remaining"]);
  const entitlement = finiteNumber(bucket["entitlement"]);
  const remaining = finiteNumber(bucket["remaining"]);
  let usedPct: number | null = null;
  if (percentRemaining !== null) usedPct = 100 - percentRemaining;
  else if (entitlement !== null && entitlement > 0 && remaining !== null) {
    usedPct = ((entitlement - remaining) / entitlement) * 100;
  }
  if (usedPct === null) return null;
  const pct = clampPct(usedPct);
  return { id, usedPct: pct, resetsAt, tone: toneFromUsedPct(pct) };
}

/** Free plan: totals in `monthly_quotas`, consumption in `limited_user_quotas`. */
function quotaWindow(
  id: string,
  monthly: unknown,
  limited: unknown,
  resetsAt: string | null,
): UsageWindow | null {
  const total = monthly && typeof monthly === "object" ? finiteNumber((monthly as any)[id]) : null;
  const used = limited && typeof limited === "object" ? finiteNumber((limited as any)[id]) : null;
  if (total === null || total <= 0 || used === null) return null;
  const pct = clampPct((used / total) * 100);
  return { id, usedPct: pct, resetsAt, tone: toneFromUsedPct(pct) };
}

export function windowsFromCopilotResponse(body: any): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const snapshots = body?.quota_snapshots;
  const paidReset = parseTimestamp(body?.quota_reset_date);
  const limitedReset = parseTimestamp(body?.limited_user_reset_date);
  const resetsAt = paidReset ?? limitedReset;

  if (snapshots && typeof snapshots === "object") {
    // [window id, quota_snapshots key]
    const entries: Array<[string, string]> = [
      ["premium", "premium_interactions"],
      ["chat", "chat"],
      ["completions", "completions"],
    ];
    for (const [id, key] of entries) {
      const win = snapshotWindow(id, (snapshots as any)[key], resetsAt);
      if (win) windows.push(win);
    }
  }
  if (!windows.length) {
    for (const id of ["chat", "completions"]) {
      const win = quotaWindow(id, body?.monthly_quotas, body?.limited_user_quotas, limitedReset ?? paidReset);
      if (win) windows.push(win);
    }
  }
  return windows;
}

function snapshotError(error: string, configured: boolean, sourceLabel: string | null): UsageSnapshot {
  return {
    status: configured ? "error" : "unavailable",
    windows: [],
    fetchedAt: new Date().toISOString(),
    sourceLabel,
    configured,
    error,
  };
}

export function fetchCopilotUsage(options: CopilotUsageOptions = {}): Promise<UsageSnapshot> {
  return cache.read(Boolean(options.force), () => runFetch(options));
}

async function runFetch(options: CopilotUsageOptions): Promise<UsageSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const candidates = await copilotTokenCandidates(env, options.tokens ?? [], options.execFileImpl);

  if (!candidates.length) {
    return snapshotError(
      "No GitHub token found: sign in to Copilot in Settings, set GITHUB_TOKEN, or run `gh auth login`.",
      false,
      null,
    );
  }

  let lastError = "";
  let rejected = false;
  for (const candidate of candidates) {
    let res: Response;
    try {
      res = await connectUsage(candidate.token, fetchImpl);
    } catch (err) {
      lastError = errorMessage(err);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      rejected = true;
      continue;
    }
    if (!res.ok) {
      lastError = `GitHub API returned HTTP ${res.status}`;
      continue;
    }
    let body: any;
    try {
      body = await res.json();
    } catch (err) {
      lastError = `GitHub API returned an unreadable body: ${errorMessage(err)}`;
      continue;
    }
    if (!body || typeof body !== "object") {
      lastError = "GitHub API returned an unexpected usage payload.";
      continue;
    }
    const planLabel =
      (typeof body.copilot_plan === "string" && body.copilot_plan) ||
      (typeof body.access_type_sku === "string" && body.access_type_sku) ||
      null;
    return {
      status: "available",
      windows: windowsFromCopilotResponse(body),
      fetchedAt: new Date().toISOString(),
      sourceLabel: candidate.label,
      configured: true,
      error: null,
      planLabel,
    };
  }

  const error = lastError ||
    (rejected
      ? "GitHub rejected every saved token (HTTP 401); sign in to Copilot again."
      : "Copilot usage request failed.");
  return snapshotError(error, true, null);
}
