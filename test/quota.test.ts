import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTimestamp, toneFromUsedPct } from "../src/quota.ts";
import {
  fetchCursorUsage,
  resetUsageCache,
  tokenCandidates,
} from "../src/quota-cursor.ts";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const GROK_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus";

const usageBody = {
  planUsage: {
    totalPercentUsed: 55.5,
    autoPercentUsed: 0.2517,
    apiPercentUsed: 0,
    includedSpend: 309,
    limit: 7000,
  },
  billingCycleStart: "1793791936000",
  billingCycleEnd: "1796383936000",
};

const grokBody = { usagePercent: 100, nextResetTimestampUtc: "2026-11-11T00:34:58.170Z" };

type FakeCall = { url: string; token: string | null };

/** Fake Cursor: token "dead" is rejected, anything else answers the canned payloads. */
function fakeFetch(opts: { calls?: FakeCall[]; rejectWith?: number } = {}) {
  const calls = opts.calls ?? [];
  return (async (input: any, init: any) => {
    const url = String(input);
    const token = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "") || null;
    calls.push({ url, token });
    if (opts.rejectWith) return new Response("{}", { status: opts.rejectWith });
    const payload = url === GROK_URL ? grokBody : usageBody;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function tempHome(authJson?: { accessToken: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cursor-usage-"));
  if (authJson) {
    await mkdir(join(dir, ".config", "cursor"), { recursive: true });
    await writeFile(join(dir, ".config", "cursor", "auth.json"), JSON.stringify(authJson));
  }
  return dir;
}

test("tone turns red past 90 and amber from 70", () => {
  assert.equal(toneFromUsedPct(0), "ok");
  assert.equal(toneFromUsedPct(69.9), "ok");
  assert.equal(toneFromUsedPct(70), "warning");
  assert.equal(toneFromUsedPct(90), "warning");
  assert.equal(toneFromUsedPct(90.1), "danger");
  assert.equal(toneFromUsedPct(100), "danger");
});

test("billing timestamps accept ms, s and ISO strings", () => {
  assert.equal(parseTimestamp("1796383936000"), new Date(1796383936000).toISOString());
  assert.equal(parseTimestamp(1796383936), new Date(1796383936000).toISOString());
  assert.equal(parseTimestamp("2026-11-11T00:34:58.170Z"), "2026-11-11T00:34:58.170Z");
  assert.equal(parseTimestamp("not a date"), null);
  assert.equal(parseTimestamp(undefined), null);
});

test("token ladder: auth.json, saved key and env tokens, deduped", async () => {
  const home = await tempHome({ accessToken: " local-token " });
  try {
    const found = await tokenCandidates({ CURSOR_API_KEY: "env-key" }, home, "env-key");
    assert.deepEqual(
      found.map((candidate) => [candidate.label, candidate.token]),
      [["Cursor auth.json", "local-token"], ["saved key", "env-key"]],
    );

    const empty = await tokenCandidates({}, await tempHome(), null);
    assert.deepEqual(empty, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("usage windows: three billing meters plus the Grok week, with reset times", async () => {
  resetUsageCache();
  const home = await tempHome({ accessToken: "good" });
  try {
    const calls: FakeCall[] = [];
    const snapshot = await fetchCursorUsage({
      fetchImpl: fakeFetch({ calls }),
      homeDir: home,
      env: {},
    });
    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.sourceLabel, "Cursor auth.json");
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.error, null);

    assert.deepEqual(
      snapshot.windows.map((win) => [win.id, win.usedPct, win.tone]),
      [
        ["auto", 0.2517, "ok"],
        ["api", 0, "ok"],
        ["total", 55.5, "ok"],
        ["grok_bot", 100, "danger"],
      ],
    );
    assert.equal(snapshot.windows[2].resetsAt, new Date(1796383936000).toISOString());
    assert.equal(snapshot.windows[3].resetsAt, "2026-11-11T00:34:58.170Z");

    // Both RPCs went out with the same Bearer token.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, USAGE_URL);
    assert.equal(calls[1].url, GROK_URL);
    assert.equal(calls[0].token, "good");
    assert.equal(calls[1].token, "good");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a 401 falls through to the next candidate instead of failing", async () => {
  resetUsageCache();
  const home = await tempHome({ accessToken: "dead" });
  try {
    const calls: FakeCall[] = [];
    const snapshot = await fetchCursorUsage({
      fetchImpl: (async (input: any, init: any) => {
        const token = String(init?.headers?.Authorization ?? "");
        if (token.includes("dead")) return new Response("{}", { status: 401 });
        return fakeFetch({ calls })(input, init);
      }) as typeof fetch,
      homeDir: home,
      env: {},
      storedKey: "alive",
    });
    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.sourceLabel, "saved key");
    assert.equal(snapshot.windows.length, 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("every rejected credential reports an error, none reports unavailable", async () => {
  resetUsageCache();
  const home = await tempHome({ accessToken: "dead" });
  try {
    const snapshot = await fetchCursorUsage({
      fetchImpl: fakeFetch({ rejectWith: 401 }),
      homeDir: home,
      env: {},
      storedKey: "also-dead",
    });
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.configured, true);
    assert.match(String(snapshot.error), /401/);
    assert.equal(snapshot.windows.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("no sign-in anywhere is unavailable, not an error", async () => {
  resetUsageCache();
  const home = await tempHome();
  try {
    const snapshot = await fetchCursorUsage({ fetchImpl: fakeFetch(), homeDir: home, env: {} });
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.configured, false);
    assert.equal(snapshot.sourceLabel, null);
    assert.ok(snapshot.error);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reads are cached for two minutes and force bypasses the cache", async () => {
  resetUsageCache();
  const home = await tempHome({ accessToken: "good" });
  try {
    const calls: FakeCall[] = [];
    const fetchImpl = fakeFetch({ calls });
    await fetchCursorUsage({ fetchImpl, homeDir: home, env: {} });
    const afterFirst = calls.length;
    assert.ok(afterFirst >= 2);

    await fetchCursorUsage({ fetchImpl, homeDir: home, env: {} });
    assert.equal(calls.length, afterFirst, "second read must be served from cache");

    await fetchCursorUsage({ fetchImpl, homeDir: home, env: {}, force: true });
    assert.ok(calls.length > afterFirst, "force must reach Cursor again");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
