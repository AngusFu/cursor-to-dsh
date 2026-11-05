import { test } from "node:test";
import assert from "node:assert/strict";

import { COPILOT_TOKEN_ENV, createCopilotAuth, registerCopilotAuth } from "../src/copilot-auth.ts";

// The controller also falls back to this ambient reference; keep it out of the tests.
delete process.env[COPILOT_TOKEN_ENV];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEVICE_REPLY = {
  device_code: "dev-1",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  interval: 5,
  expires_in: 900,
};

function fakeFetch(tokenReplies: any[] = []) {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/login/device/code")) return jsonResponse(DEVICE_REPLY);
    const reply = tokenReplies[Math.min(index, tokenReplies.length - 1)];
    index += 1;
    return jsonResponse(reply ?? { error: "authorization_pending" });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function fakeCredentials(opts: { record?: any; refValue?: string; writable?: boolean } = {}) {
  const state = {
    record: opts.record as any,
    refValue: opts.refValue as string | undefined,
    writable: opts.writable ?? true,
    calls: [] as string[],
  };
  const credentials = {
    async readRecord() {
      state.calls.push("readRecord");
      return state.record;
    },
    async modifyRecord(_key: unknown, next: () => unknown) {
      state.calls.push("modifyRecord");
      state.record = next();
      return state.record;
    },
    async deleteRecord() {
      state.calls.push("deleteRecord");
      state.record = undefined;
    },
    async describe() {
      return { writable: state.writable };
    },
    async resolve() {
      return state.refValue !== undefined ? { value: state.refValue } : undefined;
    },
    async set(_key: unknown, value: string) {
      state.calls.push("set");
      state.refValue = value;
    },
    async unset() {
      state.calls.push("unset");
      state.refValue = undefined;
    },
  };
  return { credentials, state };
}

function fakeTimers() {
  const queue: Array<{ id: number; cb: () => unknown }> = [];
  let next = 1;
  return {
    timers: {
      setTimeout(cb: () => unknown) {
        const id = next;
        next += 1;
        queue.push({ id, cb });
        return id;
      },
      clearTimeout(id: unknown) {
        const index = queue.findIndex((entry) => entry.id === id);
        if (index >= 0) queue.splice(index, 1);
      },
    },
    async runNext() {
      const entry = queue.shift();
      assert.ok(entry, "expected a scheduled poll");
      await entry.cb();
    },
    pending: () => queue.length,
  };
}

const grantOf = (token: string, modelIds?: string[]) => ({
  kind: "grant",
  payload: { type: "oauth", refresh: token, access: "", expires: 0, ...(modelIds ? { availableModelIds: modelIds } : {}) },
});

test("beginLogin starts the device flow and reports the code", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const { credentials } = fakeCredentials();
  const clock = fakeTimers();
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, timers: clock.timers, getAmbient: () => undefined });

  const status = await auth.beginLogin();
  assert.equal(status.authenticated, false);
  assert.equal(status.state, "pending");
  assert.equal(status.userCode, "ABCD-1234");
  assert.equal(status.verificationUri, "https://github.com/login/device");
  assert.equal(calls.length, 1);
  assert.equal(clock.pending(), 1, "one background poll scheduled");
  auth.dispose();
});

test("a completed poll stores the grant and authenticates", async () => {
  const { fetchImpl } = fakeFetch([{ access_token: "ghu_new" }]);
  const { credentials, state } = fakeCredentials();
  const clock = fakeTimers();
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, timers: clock.timers, getAmbient: () => undefined });

  await auth.beginLogin();
  await clock.runNext();

  const status = await auth.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.state, "authenticated");
  assert.equal(state.record.kind, "grant");
  assert.equal(state.record.payload.refresh, "ghu_new");
  assert.equal(state.record.payload.access, "", "the consuming route performs the exchange");
  assert.ok(state.calls.includes("set"), "the reference is published too");
  auth.dispose();
});

test("authorization_pending keeps polling", async () => {
  const { fetchImpl } = fakeFetch([{ error: "authorization_pending" }]);
  const { credentials } = fakeCredentials();
  const clock = fakeTimers();
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, timers: clock.timers, getAmbient: () => undefined });

  await auth.beginLogin();
  await clock.runNext();

  const status = await auth.status();
  assert.equal(status.authenticated, false);
  assert.equal(status.state, "pending");
  assert.equal(clock.pending(), 1, "rescheduled");
  auth.dispose();
});

test("an expired device code ends the flow with a message", async () => {
  const { fetchImpl } = fakeFetch([{ error: "expired_token" }]);
  const { credentials } = fakeCredentials();
  const clock = fakeTimers();
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, timers: clock.timers, getAmbient: () => undefined });

  await auth.beginLogin();
  await clock.runNext();

  const status = await auth.status();
  assert.equal(status.authenticated, false);
  assert.equal(status.state, "expired");
  assert.match(String(status.message), /expired/i);
  assert.equal(clock.pending(), 0);
  auth.dispose();
});

test("beginLogin while already signed in never calls GitHub", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const { credentials } = fakeCredentials({ record: grantOf("ghu_existing", ["gpt-6.1-sol"]) });
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, getAmbient: () => undefined });

  const status = await auth.beginLogin();
  assert.equal(status.authenticated, true);
  assert.equal(status.modelCount, 1);
  assert.equal(calls.length, 0);
});

test("logout removes the grant and the reference", async () => {
  const { fetchImpl } = fakeFetch();
  const { credentials, state } = fakeCredentials({ record: grantOf("ghu_old"), refValue: "ghu_old" });
  const clock = fakeTimers();
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, timers: clock.timers, getAmbient: () => undefined });

  await auth.beginLogin(); // already signed in -> just a status read
  const status = await auth.logout();
  assert.equal(status.authenticated, false);
  assert.equal(status.state, "signed-out");
  assert.equal(state.record, undefined);
  assert.ok(state.calls.includes("deleteRecord"));
  assert.ok(state.calls.includes("unset"));
  auth.dispose();
});

test("seedFromAmbient adopts an env token into the grant", async () => {
  const { fetchImpl } = fakeFetch();
  const { credentials, state } = fakeCredentials();
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, getAmbient: () => "ghu_ambient" });

  await auth.seedFromAmbient();
  assert.equal(state.record?.payload?.refresh, "ghu_ambient");
  assert.equal(await auth.rawToken(), "ghu_ambient");
});

test("rawToken prefers the grant over the reference over ambient", async () => {
  const { fetchImpl } = fakeFetch();
  const { credentials } = fakeCredentials({ record: grantOf("ghu_grant"), refValue: "ghu_ref" });
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, getAmbient: () => "ghu_ambient" });

  assert.equal(await auth.rawToken(), "ghu_grant");
});

test("a read-only reference survives logout without throwing", async () => {
  const { fetchImpl } = fakeFetch();
  const { credentials, state } = fakeCredentials({ record: grantOf("ghu_old"), refValue: "ghu_old", writable: false });
  const auth = createCopilotAuth({ fetchImpl, credentials: () => credentials, getAmbient: () => undefined });

  const status = await auth.logout();
  assert.equal(status.credentialRemaining, true, "the reference still holds the token");
  assert.equal(state.record, undefined);
  assert.ok(!state.calls.includes("unset"), "read-only references are never unset");
});

test("registerCopilotAuth wires routes, commands and disposal into a host context", () => {
  const seen: string[] = [];
  const commands: string[] = [];
  const ctx: any = {
    effect: (fn: any) => { seen.push("effect"); fn?.(); return () => {}; },
    get: () => undefined,
    inject: (_names: string[], cb: (cctx: any) => void) => {
      seen.push("inject");
      cb({
        effect: (inner: any) => { inner?.(); return () => {}; },
        connection: {
          fetch: {
            register: (spec: any) => {
              seen.push(String(spec.path));
              return () => {};
            },
          },
        },
        commands: {
          register: (spec: any) => {
            commands.push(String(spec.name));
          },
        },
      });
    },
  };

  const auth = registerCopilotAuth(ctx);
  assert.deepEqual(commands, ["copilot-login", "copilot-status", "copilot-logout"]);
  for (const path of ["/status", "/login", "/logout"]) {
    assert.ok(seen.includes(`/api/cursor-to-dsh/copilot${path}`), `route ${path} registered`);
  }
  auth.dispose();
});
