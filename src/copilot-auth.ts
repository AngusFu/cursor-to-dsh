/**
 * GitHub Copilot sign-in (device flow), ported from
 * `@lujianjun19/dsh-llm-github-copilot` so that plugin can be retired.
 *
 * The credential contract is unchanged on purpose: the long-lived OAuth token
 * is written as a grant record at `llm-pi-ai/github-copilot`, exactly what the
 * harness's built-in `github-copilot` route already reads, plus the
 * `GITHUB_COPILOT_OAUTH_TOKEN` reference for ambient deployments. Login and
 * logout go through `connection.fetch` routes (authenticated), never raw
 * `webServer` routes.
 */
import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

export const COPILOT_RECORD_SCOPE = "llm-pi-ai";
export const COPILOT_PROVIDER = "github-copilot";
export const COPILOT_TOKEN_ENV = "GITHUB_COPILOT_OAUTH_TOKEN";

/** GitHub's public OAuth device endpoints (same client id as the VS Code app). */
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const VERIFICATION_URI = "https://github.com/login/device";
const OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const OAUTH_SCOPE = "read:user";
const HTTP_TIMEOUT_MS = 15_000;

const HEADERS = {
  accept: "application/json",
  "content-type": "application/x-www-form-urlencoded",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "user-agent": "GitHubCopilotChat/0.35.0",
};

export type AuthFlowState = "pending" | "authenticated" | "expired" | "denied" | "error" | "signed-out";

export interface AuthStatus {
  authenticated: boolean;
  state: AuthFlowState;
  /** Credential reference this sign-in publishes to. */
  credential: string;
  provider: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: number;
  message?: string;
  /** A token still exists outside the local grant (env / reference). */
  credentialRemaining?: boolean;
  modelCount?: number;
}

export interface CopilotCredentials {
  readRecord(key: unknown): Promise<any>;
  modifyRecord(key: unknown, next: () => unknown): Promise<any>;
  deleteRecord(key: unknown): Promise<void>;
  describe(ref: unknown): Promise<{ writable?: boolean }>;
  resolve(ref: unknown): Promise<{ value: string } | undefined>;
  set(ref: unknown, value: string): Promise<void>;
  unset(ref: unknown): Promise<void>;
}

export interface CopilotAuthDeps {
  /** Resolved lazily: the credentials service mounts after plugin activation. */
  credentials?: () => CopilotCredentials | undefined;
  /** Ambient token from the launching environment / .env. */
  getAmbient?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timers?: { setTimeout(cb: () => unknown, ms: number): unknown; clearTimeout(id: unknown): void };
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

const recordKey = () => credentialKey(COPILOT_RECORD_SCOPE, COPILOT_PROVIDER);
const ref = () => credentialRef(COPILOT_TOKEN_ENV);

function grantToken(record: any): string | undefined {
  if (record?.kind !== "grant") return undefined;
  const refresh = record.payload?.refresh;
  return typeof refresh === "string" && refresh.length > 0 ? refresh : undefined;
}

function grantModelIds(record: any): string[] | undefined {
  const ids = record?.payload?.availableModelIds;
  return Array.isArray(ids) && ids.every((id: typeof ids[number]) => typeof id === "string") ? ids : undefined;
}

/** The record shape `llm-pi-ai` reads; only `refresh` carries information. */
function grantRecord(token: string) {
  return { kind: "grant", payload: { type: "oauth", refresh: token, access: "", expires: 0 } };
}

async function startDeviceFlow(fetchImpl: typeof fetch): Promise<DeviceFlow> {
  const response = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: HEADERS,
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub device authorization failed (HTTP ${response.status})`);
  const data = await response.json();
  if (typeof data.device_code !== "string" || typeof data.user_code !== "string") {
    throw new Error("GitHub did not return a device code");
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: typeof data.verification_uri === "string" && data.verification_uri
      ? data.verification_uri
      : VERIFICATION_URI,
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresIn: Number(data.expires_in) || 900,
  };
}

type PollResult =
  | { state: "done"; token: string }
  | { state: "retry" | "slow-down" | "expired" | "denied" }
  | { state: "error"; message: string };

async function pollDeviceFlow(device: DeviceFlow, fetchImpl: typeof fetch): Promise<PollResult> {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    device_code: device.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  }).toString();
  let response: Response;
  try {
    response = await fetchImpl(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: HEADERS,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    return { state: "retry" };
  }
  if (!response.ok) return { state: "retry" };
  const data = await response.json();
  if (typeof data.access_token === "string" && data.access_token.length > 0) {
    return { state: "done", token: data.access_token };
  }
  switch (data.error) {
    case "authorization_pending": return { state: "retry" };
    case "slow_down": return { state: "slow-down" };
    case "expired_token": return { state: "expired" };
    case "access_denied": return { state: "denied" };
    default: return { state: "error", message: data.error ?? "unknown" };
  }
}

export interface CopilotAuth {
  status(): Promise<AuthStatus>;
  beginLogin(): Promise<AuthStatus>;
  logout(): Promise<AuthStatus>;
  /** Long-lived token for the usage ladder: grant first, reference, then ambient. */
  rawToken(): Promise<string | undefined>;
  /** Adopt an ambient token into the grant once, like the original plugin. */
  seedFromAmbient(): Promise<void>;
  dispose(): void;
}

export function createCopilotAuth(deps: CopilotAuthDeps = {}): CopilotAuth {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timers = deps.timers ?? { setTimeout: (cb: () => unknown, ms: number) => setTimeout(() => void cb(), ms), clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) };
  const log = deps.log ?? (() => undefined);
  const credentials = () => deps.credentials?.();
  const ambient = () => deps.getAmbient?.() || process.env[COPILOT_TOKEN_ENV] || undefined;

  const activeTimers = new Set<unknown>();
  let generation = 0;
  let flow: { state: AuthFlowState; verificationUri?: string; userCode?: string; expiresAt?: number; message?: string } | undefined;

  const clearTimers = () => {
    for (const timer of activeTimers) timers.clearTimeout(timer);
    activeTimers.clear();
  };

  const publicFlow = () => {
    if (!flow) return {};
    const out: Partial<AuthStatus> = { state: flow.state };
    if (flow.verificationUri !== undefined) out.verificationUri = flow.verificationUri;
    if (flow.userCode !== undefined) out.userCode = flow.userCode;
    if (flow.expiresAt !== undefined) out.expiresAt = flow.expiresAt;
    if (flow.message !== undefined) out.message = flow.message;
    return out;
  };

  const readGrant = async () => credentials()?.readRecord(recordKey());

  const rawToken = async (): Promise<string | undefined> => {
    const fromGrant = grantToken(await readGrant());
    if (fromGrant !== undefined) return fromGrant;
    const creds = credentials();
    if (creds) {
      try {
        const hit = await creds.resolve(ref());
        if (hit && hit.value.length > 0) return hit.value;
      } catch {
        /* reference unavailable */
      }
    }
    return ambient();
  };

  const storeRawOAuthToken = async (token: string): Promise<void> => {
    const creds = credentials();
    if (!creds) throw new Error("Signing in needs the credentials service");
    await creds.modifyRecord(recordKey(), () => grantRecord(token));
    if (grantToken(await creds.readRecord(recordKey())) !== token) {
      throw new Error(
        "The Copilot credential record did not survive the write; the consuming route may have changed its grant format",
      );
    }
    try {
      if ((await creds.describe(ref())).writable) await creds.set(ref(), token);
    } catch {
      // Launching environments that expose the reference read-only skip it.
    }
  };

  const status = async (): Promise<AuthStatus> => {
    const record = await readGrant();
    const stored = grantToken(record);
    const raw = stored ?? (await rawToken());
    if (raw === undefined) {
      return {
        authenticated: false,
        state: flow?.state ?? "signed-out",
        credential: COPILOT_TOKEN_ENV,
        provider: COPILOT_PROVIDER,
        ...publicFlow(),
      };
    }
    const modelIds = grantModelIds(record);
    return {
      authenticated: true,
      state: "authenticated",
      credential: COPILOT_TOKEN_ENV,
      provider: COPILOT_PROVIDER,
      ...(stored === undefined ? { credentialRemaining: true } : {}),
      ...(modelIds ? { modelCount: modelIds.length } : {}),
    };
  };

  const schedulePoll = (device: DeviceFlow): void => {
    clearTimers();
    const myGeneration = ++generation;
    let interval = device.interval;
    const deadline = Date.now() + device.expiresIn * 1000;
    flow = {
      state: "pending",
      verificationUri: device.verificationUri,
      userCode: device.userCode,
      expiresAt: deadline,
    };
    const finish = (state: AuthFlowState, message?: string) => {
      if (myGeneration !== generation) return;
      flow = { state, ...(message !== undefined ? { message } : {}) };
    };
    const tick = async () => {
      activeTimers.delete(timer);
      if (myGeneration !== generation) return;
      if (Date.now() > deadline) {
        finish("expired", "The device code expired. Start sign-in again.");
        return;
      }
      const result = await pollDeviceFlow(device, fetchImpl);
      if (myGeneration !== generation) return;
      if (result.state === "done") {
        try {
          await storeRawOAuthToken(result.token);
          finish("authenticated");
          log("info", "cursor-to-dsh: GitHub Copilot sign-in completed");
        } catch (error) {
          finish("error", error instanceof Error ? error.message : String(error));
          log("error", "cursor-to-dsh: failed to store the Copilot credential");
        }
        return;
      }
      switch (result.state) {
        case "slow-down": interval = Math.max(interval + 5, 1); break;
        case "expired": finish("expired", "The device code expired. Start sign-in again."); return;
        case "denied": finish("denied", "GitHub authorization was denied."); return;
        case "error": finish("error", result.message); return;
        default: break;
      }
      timer = timers.setTimeout(() => tick(), interval * 1000);
      activeTimers.add(timer);
    };
    let timer: unknown = timers.setTimeout(() => tick(), interval * 1000);
    activeTimers.add(timer);
  };

  const beginLogin = async (): Promise<AuthStatus> => {
    const existing = await rawToken();
    if (existing !== undefined) return status();
    if (flow?.state === "pending" && typeof flow.expiresAt === "number" && Date.now() < flow.expiresAt) {
      return {
        authenticated: false,
        state: "pending",
        credential: COPILOT_TOKEN_ENV,
        provider: COPILOT_PROVIDER,
        ...publicFlow(),
      } as AuthStatus;
    }
    const device = await startDeviceFlow(fetchImpl);
    schedulePoll(device);
    return {
      authenticated: false,
      state: "pending",
      credential: COPILOT_TOKEN_ENV,
      provider: COPILOT_PROVIDER,
      ...publicFlow(),
    } as AuthStatus;
  };

  const logout = async (): Promise<AuthStatus> => {
    const creds = credentials();
    if (!creds) throw new Error("Signing out needs the credentials service");
    generation += 1;
    clearTimers();
    flow = { state: "signed-out" };
    await creds.deleteRecord(recordKey());
    try {
      if ((await creds.describe(ref())).writable && (await creds.resolve(ref())) !== undefined) {
        await creds.unset(ref());
      }
    } catch {
      // read-only references simply stay
    }
    return status();
  };

  const seedFromAmbient = async (): Promise<void> => {
    try {
      if (grantToken(await readGrant()) !== undefined) return;
      const existing = await rawToken();
      if (existing === undefined) return;
      await storeRawOAuthToken(existing);
      log("info", `cursor-to-dsh: adopted the existing ${COPILOT_TOKEN_ENV} token into the Copilot grant`);
    } catch (error) {
      log("warn", `cursor-to-dsh: could not adopt an existing Copilot token (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  return {
    status,
    beginLogin,
    logout,
    rawToken,
    seedFromAmbient,
    dispose: () => {
      generation += 1;
      clearTimers();
    },
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fetchAction(action: () => Promise<unknown>) {
  return async (): Promise<Response> => {
    try {
      return jsonResponse(200, { ok: true, value: await action() });
    } catch (error) {
      return jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

const remainingCredentialNotice = (credential: string) =>
  `${credential} still supplies a token outside the local grant. Remove it from the launching environment and restart DSH to finish signing out.`;

/** Wire routes + slash commands; returns the controller (usage reuses rawToken). */
export function registerCopilotAuth(ctx: any): CopilotAuth {
  const auth = createCopilotAuth({
    credentials: () => ctx.get?.("credentials"),
    getAmbient: () => {
      try {
        return launchEnvironmentOf(ctx)?.get?.(COPILOT_TOKEN_ENV)?.value;
      } catch {
        return undefined;
      }
    },
    log: (level, message) => {
      const logger = (ctx as any).logger;
      logger?.[level]?.(message);
    },
  });

  ctx.effect(() => () => auth.dispose(), "cursor-to-dsh: copilot auth");

  ctx.inject?.(["credentials"], (cctx: any) => {
    cctx.effect(() => {
      void auth.seedFromAmbient();
      return () => {};
    }, "cursor-to-dsh: adopt an existing Copilot token");
  });

  ctx.inject?.(["connection"], (cctx: any) => {
    cctx.effect(() => {
      const root = "/api/cursor-to-dsh/copilot";
      const disposers = [
        cctx.connection.fetch.register({
          path: `${root}/status`,
          methods: ["GET"],
          requestBody: "buffered",
          fetch: fetchAction(() => auth.status()),
        }),
        cctx.connection.fetch.register({
          path: `${root}/login`,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(() => auth.beginLogin()),
        }),
        cctx.connection.fetch.register({
          path: `${root}/logout`,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(() => auth.logout()),
        }),
      ];
      return async () => {
        for (const dispose of [...disposers].reverse()) await dispose();
      };
    }, "cursor-to-dsh: copilot auth routes");
  });

  ctx.inject?.(["commands"], (cctx: any) => {
    cctx.commands.register({
      name: "copilot-login",
      description: "Sign in to GitHub Copilot via the device flow",
      handler: async () => {
        try {
          const status = await auth.beginLogin();
          if (status.credentialRemaining) return { kind: "success", text: remainingCredentialNotice(status.credential) };
          if (status.authenticated) return { kind: "success", text: "GitHub Copilot is already authenticated. Run /copilot-status for details." };
          return {
            kind: "success",
            text: [
              "GitHub Copilot sign-in",
              `1. Open this URL in your browser: ${status.verificationUri}`,
              `2. Enter this code: ${status.userCode}`,
              "3. Authorize the GitHub App (VS Code) and complete sign-in.",
              "",
              "Polling continues in the background; your credential is stored automatically once you authorize.",
              `Then select a model under the "${COPILOT_PROVIDER}" provider in Settings → Models.`,
            ].join("\n"),
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      },
    });

    cctx.commands.register({
      name: "copilot-status",
      description: "Show GitHub Copilot authentication status",
      handler: async () => {
        try {
          const status = await auth.status();
          if (status.credentialRemaining) return { kind: "success", text: remainingCredentialNotice(status.credential) };
          if (!status.authenticated) {
            return { kind: "success", text: `GitHub Copilot is NOT signed in. Run /copilot-login to sign in, or set ${COPILOT_TOKEN_ENV}.` };
          }
          return {
            kind: "success",
            text: [
              "GitHub Copilot: authenticated.",
              `Credential published to the "${status.provider}" provider.`,
              status.modelCount === undefined
                ? "Model list is populated by that provider on its first request."
                : `Models available to this account: ${status.modelCount}`,
              "Select a model under that provider in Settings → Models.",
            ].join("\n"),
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      },
    });

    cctx.commands.register({
      name: "copilot-logout",
      description: "Sign out of GitHub Copilot and remove the stored credential",
      handler: async () => {
        try {
          const existing = await auth.rawToken();
          const status = await auth.logout();
          if (status.credentialRemaining) return { kind: "success", text: `Local GitHub Copilot grant removed, but ${remainingCredentialNotice(status.credential)}` };
          if (existing === undefined) return { kind: "success", text: "GitHub Copilot is not signed in. Nothing to do." };
          return { kind: "success", text: `GitHub Copilot signed out; the "${status.provider}" credential has been removed.` };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  });

  return auth;
}
