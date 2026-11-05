/**
 * Authenticated /api/cursor-to-dsh/* routes for the Settings → Cursor page.
 * Secrets are written only through credentials.set; responses never echo key values.
 */
import type { CursorUiConfig } from "./ui-state.ts";
import {
  addProfile,
  readUsageDisplay,
  removeProfile,
  setProfileKey,
  setUsageDisplay,
  uiSnapshot,
  useProfile,
} from "./ui-state.ts";
import { fetchCursorUsage } from "./quota-cursor.ts";
import { fetchCopilotUsage } from "./quota-copilot.ts";

const API_ROOT = "/api/cursor-to-dsh";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readJson(request: Request): Promise<any> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must be JSON");
  }
}

export function registerHostApi(
  ctx: any,
  getConfig: () => CursorUiConfig,
  resolveStoredKey?: () => Promise<string | undefined>,
  readCopilotTokens?: () => Promise<string[]>,
): void {
  const fetchAction = (action: (request: Request) => Promise<unknown>) => async (request: Request) => {
    try {
      return jsonResponse(200, { ok: true, value: await action(request) });
    } catch (error) {
      return jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Usage payload for the Settings card and the conversation usage pill. */
  const usageSnapshot = async (provider: string, force: boolean): Promise<Record<string, unknown>> => {
    const mode = readUsageDisplay(getConfig());
    if (provider === "cursor") {
      let storedKey: string | undefined;
      try {
        storedKey = resolveStoredKey ? await resolveStoredKey() : undefined;
      } catch {
        storedKey = undefined;
      }
      return { mode, provider, ...(await fetchCursorUsage({ storedKey: storedKey ?? null, force })) };
    }
    if (provider === "copilot") {
      let tokens: string[] = [];
      try {
        tokens = readCopilotTokens ? await readCopilotTokens() : [];
      } catch {
        tokens = [];
      }
      return { mode, provider, ...(await fetchCopilotUsage({ tokens, force })) };
    }
    throw new Error(`Unknown usage provider: ${provider}`);
  };

  ctx.inject(["connection"], (cctx: any) => {
    cctx.effect(() => {
      const disposers = [
        cctx.connection.fetch.register({
          path: `${API_ROOT}/status`,
          methods: ["GET"],
          requestBody: "buffered",
          fetch: fetchAction(async () => uiSnapshot(ctx, getConfig())),
        }),
        cctx.connection.fetch.register({
          path: `${API_ROOT}/keys`,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(async (request) => {
            const body = await readJson(request);
            const profiles = await setProfileKey(ctx, getConfig(), {
              id: String(body.id ?? ""),
              label: body.label != null ? String(body.label) : undefined,
              key: String(body.key ?? ""),
            });
            return { ...(await uiSnapshot(ctx, getConfig())), profiles };
          }),
        }),
        cctx.connection.fetch.register({
          path: `${API_ROOT}/keys/add`,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(async (request) => {
            const body = await readJson(request);
            await addProfile(ctx, getConfig(), {
              id: String(body.id ?? ""),
              label: body.label != null ? String(body.label) : undefined,
            });
            return uiSnapshot(ctx, getConfig());
          }),
        }),
        cctx.connection.fetch.register({
          path: `${API_ROOT}/keys/remove`,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(async (request) => {
            const body = await readJson(request);
            await removeProfile(ctx, getConfig(), String(body.id ?? ""));
            return uiSnapshot(ctx, getConfig());
          }),
        }),
        cctx.connection.fetch.register({
          path: `${API_ROOT}/keys/use`,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(async (request) => {
            const body = await readJson(request);
            await useProfile(ctx, getConfig(), String(body.id ?? ""));
            return uiSnapshot(ctx, getConfig());
          }),
        }),
        cctx.connection.fetch.register({
          path: `${API_ROOT}/usage`,
          methods: ["GET"],
          requestBody: "buffered",
          fetch: fetchAction(async (request) => {
            const query = new URLSearchParams(String(request.url ?? "").split("?")[1] ?? "");
            return usageSnapshot(query.get("provider") ?? "cursor", query.get("force") === "1");
          }),
        }),
        cctx.connection.fetch.register({
          path: `${API_ROOT}/usage/display`,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(async (request) => {
            const body = await readJson(request);
            const mode = await setUsageDisplay(ctx, getConfig(), String(body.mode ?? ""));
            return { mode };
          }),
        }),
      ];
      return async () => {
        for (const dispose of [...disposers].reverse()) await dispose();
      };
    }, "cursor-to-dsh: settings API");
  });
}

export { API_ROOT };
