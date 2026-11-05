import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchCopilotUsage,
  resetCopilotUsageCache,
  windowsFromCopilotResponse,
} from "../src/quota-copilot.ts";

const businessBody = {
  copilot_plan: "business",
  access_type_sku: "copilot_for_business_seat_quota",
  quota_reset_date: "2026-12-01",
  quota_snapshots: {
    chat: { has_quota: true, unlimited: true, percent_remaining: 100, entitlement: 0, remaining: 0 },
    completions: { has_quota: true, unlimited: true, percent_remaining: 100, entitlement: 0, remaining: 0 },
    premium_interactions: {
      has_quota: true,
      unlimited: false,
      percent_remaining: 100,
      entitlement: 5000,
      remaining: 5000,
    },
  },
};

const freeBody = {
  copilot_plan: "free",
  quota_reset_date: undefined,
  limited_user_reset_date: "2026-11-20",
  monthly_quotas: { chat: 50, completions: 100 },
  limited_user_quotas: { chat: 45, completions: 25 },
};

type FakeCall = { token: string | null };

function fakeFetch(opts: { status?: number; body?: unknown; calls?: FakeCall[] } = {}) {
  const calls = opts.calls ?? [];
  return (async (_input: any, init: any) => {
    const auth = String(init?.headers?.authorization ?? "");
    calls.push({ token: auth.replace(/^token /, "") || null });
    return new Response(JSON.stringify(opts.body ?? businessBody), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("business plan: premium meter plus unlimited chat rows, one reset date", () => {
  const windows = windowsFromCopilotResponse(businessBody);
  assert.deepEqual(
    windows.map((win) => [win.id, win.usedPct, win.unlimited ?? false, win.tone]),
    [
      ["premium", 0, false, "ok"],
      ["chat", 0, true, "ok"],
      ["completions", 0, true, "ok"],
    ],
  );
  assert.equal(windows[0].resetsAt, new Date("2026-12-01").toISOString());
});

test("percent falls back to entitlement minus remaining", () => {
  const windows = windowsFromCopilotResponse({
    copilot_plan: "pro",
    quota_snapshots: {
      premium_interactions: { has_quota: true, unlimited: false, entitlement: 300, remaining: 60 },
    },
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPct, 80);
  assert.equal(windows[0].tone, "warning");
});

test("free plan reads monthly totals against limited usage", () => {
  const windows = windowsFromCopilotResponse(freeBody);
  assert.deepEqual(
    windows.map((win) => [win.id, win.usedPct, win.tone]),
    [
      ["chat", 90, "warning"],
      ["completions", 25, "ok"],
    ],
  );
  assert.equal(windows[0].resetsAt, new Date("2026-11-20").toISOString());
});

test("no token anywhere is unavailable, not an error", async () => {
  resetCopilotUsageCache();
  const snapshot = await fetchCopilotUsage({
    fetchImpl: fakeFetch(),
    env: {},
    execFileImpl: ((_file: any, _args: any, _opts: any, cb: any) => cb(new Error("no gh"))) as any,
  });
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.configured, false);
  assert.ok(snapshot.error);
});

test("the DSH grant answers first; a 401 falls through to env", async () => {
  resetCopilotUsageCache();
  const calls: FakeCall[] = [];
  const snapshot = await fetchCopilotUsage({
    fetchImpl: (async (input: any, init: any) => {
      const auth = String(init?.headers?.authorization ?? "");
      if (auth.includes("stale")) return new Response("{}", { status: 401 });
      return fakeFetch({ calls })(input, init);
    }) as typeof fetch,
    env: { GITHUB_TOKEN: "env-token" },
    tokens: ["stale"],
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.sourceLabel, "env token");
  assert.equal(snapshot.planLabel, "business");
  assert.equal(snapshot.windows.length, 3);
  assert.deepEqual(
    calls.map((call) => call.token),
    ["env-token"],
    "stale grant skipped, env token used for the one real request",
  );
});

test("gh auth token is the last candidate", async () => {
  resetCopilotUsageCache();
  const snapshot = await fetchCopilotUsage({
    fetchImpl: fakeFetch(),
    env: {},
    execFileImpl: ((_file: any, _args: any, _opts: any, cb: any) => cb(null, "gho_from_cli\n", "")) as any,
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.sourceLabel, "gh auth token");
});

test("every rejected token reports an error, none reports unavailable", async () => {
  resetCopilotUsageCache();
  const snapshot = await fetchCopilotUsage({
    fetchImpl: fakeFetch({ status: 401, body: {} }),
    env: { GITHUB_TOKEN: "dead" },
    tokens: ["also-dead"],
    execFileImpl: ((_file: any, _args: any, _opts: any, cb: any) => cb(new Error("no gh"))) as any,
  });
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.configured, true);
  assert.match(String(snapshot.error), /401/);
});

test("reads are cached and force bypasses the cache", async () => {
  resetCopilotUsageCache();
  const calls: FakeCall[] = [];
  const fetchImpl = fakeFetch({ calls });
  await fetchCopilotUsage({ fetchImpl, env: { GITHUB_TOKEN: "t" } });
  assert.equal(calls.length, 1);
  await fetchCopilotUsage({ fetchImpl, env: { GITHUB_TOKEN: "t" } });
  assert.equal(calls.length, 1, "second read must be served from cache");
  await fetchCopilotUsage({ fetchImpl, env: { GITHUB_TOKEN: "t" }, force: true });
  assert.equal(calls.length, 2, "force must reach GitHub again");
});
