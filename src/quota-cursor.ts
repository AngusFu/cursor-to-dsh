/**
 * Cursor subscription usage (DashboardService Connect RPC).
 *
 * Two reverse-engineered POST + Bearer calls:
 *   GetCurrentPeriodUsage -> Auto / API / Total percentages + billing cycle end
 *   GetSandUsageStatus     -> Grok Bot weekly allowance + its reset
 *
 * A dashboard API key answers 401 on these endpoints (verified), while the desktop
 * OAuth token works, so candidates are tried in order and a 401 falls through to
 * the next one instead of failing the read.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

const CURSOR_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_GROK_BOT_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus";
const HTTP_TIMEOUT_MS = 15_000;

const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CURSOR_LEGACY_AUTH_KEY = "cursorAuthStatus";

export interface CursorUsageOptions {
  fetchImpl?: UsageFetch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  storedKey?: string | null;
  force?: boolean;
}

interface TokenCandidate {
  token: string;
  label: string;
}

const cache = createUsageCache<UsageSnapshot>((value) => value.status === "available");
/** The token that answered last time goes first so the ladder stops after one call. */
let winnerToken: string | null = null;

/** Test hook. */
export function resetUsageCache(): void {
  cache.reset();
  winnerToken = null;
}

interface CursorStateStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface CursorStateDatabase {
  prepare(sql: string): CursorStateStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => CursorStateDatabase;
}

function readItemTableValue(db: CursorStateDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
  const value = row?.["value"];
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

function tokenFromDb(db: CursorStateDatabase): string | null {
  const modern = readItemTableValue(db, CURSOR_ACCESS_TOKEN_KEY)?.trim();
  if (modern) return modern;
  const legacy = readItemTableValue(db, CURSOR_LEGACY_AUTH_KEY);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as { accessToken?: unknown };
      if (typeof parsed?.accessToken === "string" && parsed.accessToken.trim()) {
        return parsed.accessToken.trim();
      }
    } catch {
      // ignore a malformed legacy blob
    }
  }
  return null;
}

/** Desktop keeps auth in VS Code's ItemTable; read it with node:sqlite, no sqlite3 CLI. */
async function readTokenFromStateDb(homeDir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dbPaths: string[] = [];
  const appData = env["APPDATA"];
  if (appData) dbPaths.push(join(appData, "Cursor", "User", "globalStorage", "state.vscdb"));
  dbPaths.push(
    join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
  );
  dbPaths.push(join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"));

  // Declared as a string so TypeScript skips module resolution: older @types/node has no
  // node:sqlite typings, while the runtime (Node 22+) provides it.
  const sqliteSpecifier: string = "node:sqlite";
  let sqlite: NodeSqliteModule;
  try {
    sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch {
    return null;
  }

  for (const path of dbPaths) {
    if (!existsSync(path)) continue;
    let db: CursorStateDatabase | undefined;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true });
      const token = tokenFromDb(db);
      if (token) return token;
    } catch {
      // Locked / permission / corrupt all land here; try the next candidate.
    } finally {
      db?.close();
    }
  }
  return null;
}

/** Headless hosts (cursor-agent) keep the session here instead of a desktop db. */
async function readTokenFromAuthJson(homeDir: string): Promise<string | null> {
  const path = join(homeDir, ".config", "cursor", "auth.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { accessToken?: unknown };
    return typeof parsed?.accessToken === "string" && parsed.accessToken.trim()
      ? parsed.accessToken.trim()
      : null;
  } catch {
    return null;
  }
}

export async function tokenCandidates(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  storedKey: string | null,
): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  const push = (token: string | null | undefined, label: string): void => {
    const clean = typeof token === "string" ? token.trim() : "";
    if (!clean || out.some((candidate) => candidate.token === clean)) return;
    out.push({ token: clean, label });
  };

  const dbToken = await readTokenFromStateDb(homeDir, env);
  if (dbToken) push(dbToken, "Cursor state.vscdb");
  else push(await readTokenFromAuthJson(homeDir), "Cursor auth.json");
  push(storedKey, "saved key");
  push(env["CURSOR_ACCESS_TOKEN"] || env["CURSOR_TOKEN"], "env token");
  push(env["CURSOR_API_KEY"], "env key");
  return out;
}

async function connectRpc(url: string, token: string, fetchImpl: UsageFetch): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

function windowsFromUsage(body: any): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const plan = body && typeof body.planUsage === "object" && body.planUsage ? body.planUsage : null;
  const resetsAt = parseTimestamp(body?.billingCycleEnd);
  if (plan) {
    const entries: Array<[string, unknown]> = [
      ["auto", plan.autoPercentUsed],
      ["api", plan.apiPercentUsed],
      ["total", plan.totalPercentUsed],
    ];
    for (const [id, raw] of entries) {
      const pct = finiteNumber(raw);
      if (pct === null) continue;
      const usedPct = clampPct(pct);
      windows.push({ id, usedPct, resetsAt, tone: toneFromUsedPct(usedPct) });
    }
  }
  return windows;
}

/** Grok Bot keeps a separate weekly allowance from the main billing-cycle meters. */
function grokWindowFromBody(body: any): UsageWindow | null {
  if (body?.usesPooledEnterpriseAllowance === true) return null;
  if (body?.hasNonZeroIncludedLimit === false) return null;
  if (body?.includedLimitZero === true) return null;
  const pct = finiteNumber(body?.usagePercent);
  if (pct === null) return null;
  const usedPct = clampPct(pct);
  return {
    id: "grok_bot",
    usedPct,
    resetsAt: parseTimestamp(body?.nextResetTimestampUtc),
    tone: toneFromUsedPct(usedPct),
  };
}

async function fetchGrokWindow(token: string, fetchImpl: UsageFetch): Promise<UsageWindow | null> {
  try {
    const res = await connectRpc(CURSOR_GROK_BOT_USAGE_URL, token, fetchImpl);
    if (!res.ok) return null;
    return grokWindowFromBody(await res.json());
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

export function fetchCursorUsage(options: CursorUsageOptions = {}): Promise<UsageSnapshot> {
  return cache.read(Boolean(options.force), () => runFetch(options));
}

async function runFetch(options: CursorUsageOptions): Promise<UsageSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  let candidates = await tokenCandidates(env, homeDir, options.storedKey ?? null);
  if (!candidates.length) {
    return snapshotError(
      "No Cursor sign-in found on this host (desktop app, ~/.config/cursor/auth.json, or an env token).",
      false,
      null,
    );
  }
  if (winnerToken) {
    candidates = [
      ...candidates.filter((candidate) => candidate.token === winnerToken),
      ...candidates.filter((candidate) => candidate.token !== winnerToken),
    ];
  }

  let lastError = "";
  let rejected = false;
  for (const candidate of candidates) {
    let res: Response;
    try {
      res = await connectRpc(CURSOR_USAGE_URL, candidate.token, fetchImpl);
    } catch (err) {
      lastError = errorMessage(err);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      rejected = true;
      continue;
    }
    if (!res.ok) {
      lastError = `Cursor API returned HTTP ${res.status}`;
      continue;
    }
    let body: any;
    try {
      body = await res.json();
    } catch (err) {
      lastError = `Cursor API returned an unreadable body: ${errorMessage(err)}`;
      continue;
    }
    if (!body || typeof body !== "object") {
      lastError = "Cursor API returned an unexpected usage payload.";
      continue;
    }
    const windows = windowsFromUsage(body);
    const grok = await fetchGrokWindow(candidate.token, fetchImpl);
    if (grok) windows.push(grok);
    winnerToken = candidate.token;
    return {
      status: "available",
      windows,
      fetchedAt: new Date().toISOString(),
      sourceLabel: candidate.label,
      configured: true,
      error: null,
    };
  }

  const error = lastError ||
    (rejected
      ? "Cursor rejected every saved credential (HTTP 401); sign in to the Cursor desktop app again."
      : "Cursor usage request failed.");
  return snapshotError(error, true, null);
}
