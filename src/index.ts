/**
 * DSH plugin entry: registers Cursor as the `cursor` LLM provider route.
 *
 * Keys are managed from Settings → Cursor (and slash commands). Secrets go
 * through credentials.set — never hand-edit ~/.dsh/.credentials.yaml.
 */
import type { Context, Volatile } from "@deepseek-ai/cordis";
import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import Schema from "@deepseek-ai/schemastery";

import { CursorAdapter } from "./adapter.ts";
import { registerCopilotAuth } from "./copilot-auth.ts";
import { registerCursorCommands } from "./commands.ts";
import { cfgString } from "./config-value.ts";
import { registerHostApi } from "./host-api.ts";
import { type ApiKeyProfile, type KeyConfig, resolveActiveApiKey } from "./keys.ts";
import { PROVIDER_ID, setContextPreference } from "./models.ts";
import { createCursorAgent, listCursorModels, prewarmCursor } from "./sdk.ts";
import { closeAllCursorSessions, debug, type CompactDeps } from "./session.ts";
import {
  readActiveKeyId,
  readContextManagement,
  readProfiles,
  type ContextManagementConfig,
  type CursorUiConfig,
} from "./ui-state.ts";
export type { ContextManagementConfig } from "./ui-state.ts";
import type { CheckpointStoreLike } from "./context/checkpoint.ts";
import { MAX_SUMMARY_TOKENS, collectSummaryText, renderSummaryMessages } from "./context/summarizer.ts";

export const name = "cursor-to-dsh";
export const inject = ["llm"];

export interface Config {
  /** Volatile so the settings service gives this plugin a namespace and the Models page lists Cursor. */
  apiKeyEnv: Volatile<string> | string;
  apiKey?: string;
  context: string | Volatile<string>;
  cwd?: string | Volatile<string>;
  apiKeyProfiles?: ApiKeyProfile[] | Volatile<ApiKeyProfile[]>;
  activeKeyId?: string | Volatile<string>;
  /** Usage pill visibility: auto (only Cursor models), always, off. */
  usageDisplay?: string | Volatile<string>;
  /**
   * Long-session context management: in-place Cursor checkpoint rewrite plus a
   * summariser for the dropped prefix. Off by default — the summariser and the
   * rewrite are opt-in because both change what the model can see.
   */
  contextManagement?: ContextManagementConfig;
}

const ApiKeyProfileSchema = Schema.object({
  id: Schema.string().required().description("Stable profile id (referenced by activeKeyId)."),
  label: Schema.string().description("Display label in Settings → Cursor."),
  apiKeyEnv: Schema.string().role("credential-ref").description("Credential reference that holds this profile's Cursor API key (filled via Settings → Cursor, never hand-edited yaml)."),
  apiKey: Schema.string().role("secret").description("Deprecated inline key; prefer Settings → Cursor which stores via credentials."),
});

export const Config: Schema<Config> = Schema.object({
  apiKeyProfiles: Schema.array(ApiKeyProfileSchema)
    .default([{ id: "default", label: "Default", apiKeyEnv: "CURSOR_API_KEY" }])
    .description("Cursor API key profiles. Add/select/store keys in Settings → Cursor (or /cursor-key-* commands).")
    .volatile(),
  activeKeyId: Schema.string().default("default").description("Which apiKeyProfiles.id is used for new Cursor agents.").volatile(),
  usageDisplay: Schema.string().default("auto").description("Cursor usage pill: auto (only on Cursor models), always, or off.").volatile(),
  apiKeyEnv: Schema.string().role("credential-ref").default("CURSOR_API_KEY").description("Legacy single-key credential / env name (used when apiKeyProfiles is empty).").volatile(),
  apiKey: Schema.string().role("secret").description("Legacy inline Cursor API key; prefer Settings → Cursor."),
  context: Schema.string().default("min").description("Cursor context tier: min, max, or an offered value such as 300k."),
  cwd: Schema.string().description("Cursor agent working directory; default is the session's directory."),
  contextManagement: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description("Rewrite the Cursor checkpoint in place when a session outgrows budgetTokens. Off by default."),
    summarizerProvider: Schema.string()
      .default("")
      .description("Provider route that summarises the dropped prefix (e.g. deepseek). Empty = use the session's own provider. Any registered DSH provider works — it does not have to be Cursor."),
    summarizerModel: Schema.string()
      .default("")
      .description("Model for summarizerProvider. Empty = that provider's default. Independent of the session's model, so compaction need not burn Cursor quota."),
    budgetTokens: Schema.number()
      .default(180_000)
      .description("Estimated tokens of retained history that triggers a rewrite."),
    keepTurns: Schema.number()
      .default(1)
      .description("Turns kept verbatim no matter how small the budget."),
  })
    .default({
      enabled: false,
      summarizerProvider: "",
      summarizerModel: "",
      budgetTokens: 180_000,
      keepTurns: 1,
    })
    .description("Long-session context management. Set in paseo.json; off unless enabled.")
    // Volatile so Settings can edit it live: the session reads it through
    // cfgGet() every turn, and dsh-settings refuses to write non-volatile paths.
    .volatile(),
}) as any;

export function apply(ctx: Context, config: Config): void {
  const getConfig = (): CursorUiConfig => config as CursorUiConfig;

  setContextPreference(cfgString(config?.context, "min"));
  (ctx as any).on?.("loader/volatile-update", () => {
    setContextPreference(cfgString(config?.context, "min"));
  });

  // Own settings page (Settings → Cursor); disable auto-generated form.
  ctx.inject?.(["settings"], (sctx: any) => {
    sctx.effect?.(
      () => sctx.settings.configure({ auto: false }, ctx.fiber),
      "cursor-to-dsh: settings page policy",
    );
  });

  const resolveApiKey = async (): Promise<string | undefined> => {
    const live: KeyConfig = {
      apiKeyProfiles: readProfiles(getConfig()),
      activeKeyId: readActiveKeyId(getConfig()),
      apiKeyEnv: cfgString(config?.apiKeyEnv) || "CURSOR_API_KEY",
      apiKey: config?.apiKey,
    };
    return resolveActiveApiKey(live, {
      fromCredentials: async (ref) => {
        const credentials: any = (ctx as any).get("credentials");
        if (!credentials) return undefined;
        try {
          const hit = await credentials.resolve(credentialRef(ref));
          return hit?.value?.trim() || undefined;
        } catch (err) {
          debug(`credentials lookup failed (${ref}): ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      },
      fromEnv: (ref) => launchEnvironmentOf(ctx).get(ref)?.value ?? process.env[ref],
    });
  };

  const cwdFor = (sessionId: string | undefined): string => {
    const override = process.env.DSH_CURSOR_CWD?.trim() || cfgString(config?.cwd).trim();
    if (override) return override;
    try {
      const session = sessionId ? (ctx as any).get("sessions")?.get?.(sessionId) : undefined;
      const dir = session ? (ctx as any).get("workingDirectory")?.get?.(session) : undefined;
      if (typeof dir === "string" && dir) return dir;
    } catch (err) {
      debug(`working directory lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return process.cwd();
  };

  const readImage = async (ref: any, signal?: AbortSignal) => {
    const attachments: any = (ctx as any).get("attachments");
    if (!attachments?.readImage) return undefined;
    const stored = await attachments.readImage(ref, signal);
    return { data: Buffer.from(stored.data).toString("base64"), mimeType: stored.ref?.mediaType ?? ref.mediaType };
  };

  const prewarm = /^(0|false|off)$/i.test(process.env.DSH_CURSOR_PREWARM ?? "")
    ? undefined
    : (opts: { apiKey: string; modelId: string }) => void prewarmCursor(opts);

  /**
   * Long-session context management, off unless the user asked for it.
   *
   * The summariser runs through DSH itself, so it may name any registered
   * provider — compaction need not burn Cursor quota. The rewrite goes through
   * the public checkpoint store; no SDK patching is involved.
   */
  let platform: Promise<any> | undefined;
  const getPlatform = (): Promise<any> =>
    (platform ??= import("@cursor/sdk").then((sdk) => sdk.createAgentPlatform()));
  const checkpointStore: CheckpointStoreLike = {
    loadLatest: (agentId) => getPlatform().then((p) => p.checkpointStore.loadLatest(agentId)),
    saveCheckpoint: (agentId, checkpoint) =>
      getPlatform().then((p) => p.checkpointStore.saveCheckpoint(agentId, checkpoint)),
  };

  const summarizerModels = new Map<string, string>();
  /** Re-read per call: the Settings page edits these without restarting DSH. */
  const management = () => readContextManagement(config);
  const summarise = async (
    history: string,
    opts?: { signal?: AbortSignal; sessionModel?: string },
  ): Promise<string> => {
    const cfg = management();
    const provider = (cfg.summarizerProvider || PROVIDER_ID).trim();
    let model = cfg.summarizerModel.trim();
    // No summariser of our own: borrow the session's model for Cursor, or ask
    // the named provider for its first model.
    if (!model && provider === PROVIDER_ID) model = opts?.sessionModel ?? "";
    if (!model) {
      model = summarizerModels.get(provider) ?? "";
      if (!model) {
        const listed: any[] = (await (ctx as any).llm.listModels(provider)) ?? [];
        model = String(listed[0]?.id ?? "");
        if (model) summarizerModels.set(provider, model);
      }
    }
    if (!model) throw new Error(`no model available for summarizer provider "${provider}"`);
    const chunks = (ctx as any).llm.stream({
      provider,
      model,
      messages: renderSummaryMessages({ history }),
      maxTokens: MAX_SUMMARY_TOKENS,
      signal: opts?.signal,
    });
    return collectSummaryText(chunks);
  };

  // Always wired: `enabled` is read per turn, so the switch on the Settings
  // page takes effect immediately instead of only after a restart.
  const compact: CompactDeps = {
    store: checkpointStore,
    settings: management,
    summarize: summarise,
  };

  const adapter = new CursorAdapter({
    createAgent: createCursorAgent,
    listModels: listCursorModels,
    resolveApiKey,
    cwdFor,
    readImage,
    prewarm,
    compact,
  });
  (ctx as any).llm.registerConfigurableProviders([
    { provider: PROVIDER_ID, displayName: "Cursor", settingsNs: (ctx as any).fiber?.entry?.options.id ?? name, settingsPath: [] },
  ]);
  (ctx as any).llm.registerAdapter([PROVIDER_ID], adapter);
  ctx.effect(() => () => closeAllCursorSessions(), "cursor sessions");

  /**
   * Long-lived GitHub OAuth token the Copilot sign-in plugin stored
   * (`llm-pi-ai` grant), plus the ambient override it documents. Read-only:
   * this plugin never writes Copilot credentials.
   */
  const readCopilotTokens = async (): Promise<string[]> => {
    const out: string[] = [];
    const credentials: any = (ctx as any).get("credentials");
    if (credentials?.readRecord) {
      try {
        const record = await credentials.readRecord(credentialKey("llm-pi-ai", "github-copilot"));
        const refresh = record?.payload?.refresh;
        if (typeof refresh === "string" && refresh.trim()) out.push(refresh.trim());
      } catch (err) {
        debug(`copilot grant lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const ambient = launchEnvironmentOf(ctx).get("GITHUB_COPILOT_OAUTH_TOKEN")?.value ?? process.env.GITHUB_COPILOT_OAUTH_TOKEN;
    if (ambient?.trim()) out.push(ambient.trim());
    return out;
  };

  registerHostApi(ctx, getConfig, resolveApiKey, readCopilotTokens);
  registerCopilotAuth(ctx);
  registerCursorCommands(ctx, getConfig);

  void resolveApiKey()
    .then((key) => (key ? adapter.listModels(PROVIDER_ID) : undefined))
    .catch(() => {});

}
