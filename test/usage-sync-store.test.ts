import { test } from "node:test";
import assert from "node:assert/strict";

import { createUsageSyncStore } from "../src/usage-sync-store.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("force during an in-flight non-force request waits, then issues force=1", async () => {
  const calls: boolean[] = [];
  const first = deferred<{ mode: string; n: number }>();
  const second = deferred<{ mode: string; n: number }>();
  let starts = 0;
  const store = createUsageSyncStore(async (force) => {
    calls.push(force);
    starts += 1;
    return starts === 1 ? first.promise : second.promise;
  });

  const soft = store.fetch(false, "cursor");
  const forced = store.fetch(true, "cursor");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], false);
  assert.equal(store.pendingForce("cursor"), true);

  first.resolve({ mode: "auto", n: 1 });
  assert.deepEqual(await soft, { mode: "auto", n: 1 });
  // The follow-up force request starts after the soft one settles.
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [false, true]);

  second.resolve({ mode: "auto", n: 2 });
  assert.deepEqual(await forced, { mode: "auto", n: 2 });
  assert.equal(store.snapshot("cursor")?.n, 2);
});

test("multiple force callers during a non-force fetch share one follow-up force request", async () => {
  const calls: boolean[] = [];
  const first = deferred<{ n: number }>();
  const second = deferred<{ n: number }>();
  let starts = 0;
  const store = createUsageSyncStore(async (force) => {
    calls.push(force);
    starts += 1;
    return starts === 1 ? first.promise : second.promise;
  });

  void store.fetch(false, "cursor");
  const a = store.fetch(true, "cursor");
  const b = store.fetch(true, "cursor");
  first.resolve({ n: 1 });
  second.resolve({ n: 2 });
  assert.deepEqual(await a, { n: 2 });
  assert.deepEqual(await b, { n: 2 });
  assert.deepEqual(calls, [false, true]);
});

test("force during an in-flight force request joins that promise (no extra fetch)", async () => {
  const calls: boolean[] = [];
  const first = deferred<{ n: number }>();
  const store = createUsageSyncStore(async (force) => {
    calls.push(force);
    return first.promise;
  });
  const a = store.fetch(true, "cursor");
  const b = store.fetch(true, "cursor");
  first.resolve({ n: 1 });
  assert.deepEqual(await a, { n: 1 });
  assert.deepEqual(await b, { n: 1 });
  assert.deepEqual(calls, [true]);
});

test("failed non-force still issues the pending force follow-up", async () => {
  const calls: boolean[] = [];
  const first = deferred<{ n: number }>();
  const second = deferred<{ n: number }>();
  let starts = 0;
  const store = createUsageSyncStore(async (force) => {
    calls.push(force);
    starts += 1;
    return starts === 1 ? first.promise : second.promise;
  });
  const soft = store.fetch(false, "cursor");
  const forced = store.fetch(true, "cursor");
  first.reject(new Error("soft failed"));
  await assert.rejects(soft, /soft failed/);
  second.resolve({ n: 9 });
  assert.deepEqual(await forced, { n: 9 });
  assert.deepEqual(calls, [false, true]);
});

test("applyMode writes every cached snapshot so a sibling subscriber sees it immediately", async () => {
  const seen: Array<{ provider: string; mode?: string }> = [];
  const store = createUsageSyncStore(async (_force, provider) => ({ mode: "auto", provider }));
  store.subscribe((provider, snap) => {
    seen.push({ provider, mode: snap?.mode });
  });
  await store.fetch(false, "cursor");
  await store.fetch(false, "copilot");
  seen.length = 0;
  store.applyMode("off");
  assert.equal(store.snapshot("cursor")?.mode, "off");
  assert.equal(store.snapshot("copilot")?.mode, "off");
  assert.deepEqual(
    seen,
    [
      { provider: "cursor", mode: "off" },
      { provider: "copilot", mode: "off" },
    ],
  );
});
