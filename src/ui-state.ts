/**
 * Live UI state for multi-key profiles.
 * Prefer persisting through ctx.settings when mounted; otherwise keep an
 * in-memory overlay (keys themselves always go through credentials.set).
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";

import { cfgGet, cfgString } from "./config-value.ts";
import {
  type ApiKeyProfile,
  type KeyConfig,
  normalizeProfiles,
  profileCredentialRef,
} from "./keys.ts";
import type { UsageMode } from "./quota.ts";

export type CursorUiConfig = KeyConfig & {
  apiKeyProfiles?: ApiKeyProfile[] | { get?: () => ApiKeyProfile[] };
  activeKeyId?: string | { get?: () => string };
  usageDisplay?: string | { get?: () => string };
  contextManagement?: Partial<ContextManagementConfig> | { get?: () => Partial<ContextManagementConfig> };
};

/**
 * Long-session context management. Defined here rather than in `index.ts` so
 * the settings layer never has to import the plugin entry.
 */
export interface ContextManagementConfig {
  /** Billion-context / acp session management (compress tools, budget, standing prompt). */
  enabled: boolean;
  /** acp-kernel soft-protect: recent message count (billion-context default 5). */
  preserveRecentMessages: number;
  /** acp-kernel soft-protect: recent token tail (default 5000). */
  preserveRecentTokens: number;
  /** Tokens reserved for model output when computing §8 input budget. */
  outputReserve: number;
  /** Extra margin on top of outputReserve. */
  safetyMargin: number;
  /** Hard preflight attempts per session generation before CURSOR_CONTEXT_BUDGET_EXCEEDED. */
  preflightMaxAttempts: number;
}

export const CONTEXT_DEFAULTS: ContextManagementConfig = {
  enabled: false,
  preserveRecentMessages: 5,
  preserveRecentTokens: 5_000,
  outputReserve: 8_192,
  safetyMargin: 8_192,
  preflightMaxAttempts: 3,
};

export type ProfileStatus = {
  id: string;
  label: string;
  apiKeyEnv: string;
  active: boolean;
  configured: boolean;
  writable: boolean;
  source?: string;
};

type Overlay = {
  activeKeyId?: string;
  apiKeyProfiles?: ApiKeyProfile[];
  usageDisplay?: UsageMode;
  contextManagement?: ContextManagementConfig;
};

const overlay: Overlay = {};

export function readProfiles(config: CursorUiConfig | undefined): ApiKeyProfile[] {
  return overlay.apiKeyProfiles ?? normalizeProfiles({
    apiKeyProfiles: cfgGet(config?.apiKeyProfiles as any),
    activeKeyId: cfgString(config?.activeKeyId) || undefined,
    apiKeyEnv: cfgString(config?.apiKeyEnv) || undefined,
    apiKey: config?.apiKey,
  });
}

export function readActiveKeyId(config: CursorUiConfig | undefined): string {
  if (overlay.activeKeyId) return overlay.activeKeyId;
  const profiles = readProfiles(config);
  const want = cfgString(config?.activeKeyId).trim();
  return want && profiles.some((p) => p.id === want) ? want : profiles[0]?.id ?? "default";
}

export function applyOverlay(next: Overlay): void {
  if (next.activeKeyId !== undefined) overlay.activeKeyId = next.activeKeyId;
  if (next.apiKeyProfiles !== undefined) overlay.apiKeyProfiles = next.apiKeyProfiles;
  if (next.usageDisplay !== undefined) overlay.usageDisplay = next.usageDisplay;
  if (next.contextManagement !== undefined) overlay.contextManagement = next.contextManagement;
}

/** Test hook. */
export function resetOverlay(): void {
  delete overlay.activeKeyId;
  delete overlay.apiKeyProfiles;
  delete overlay.usageDisplay;
  delete overlay.contextManagement;
}

const USAGE_MODES: UsageMode[] = ["auto", "always", "off"];

/** Usage pill visibility: auto = only on Cursor models, always = always, off = never. */
export function readUsageDisplay(config: CursorUiConfig | undefined): UsageMode {
  if (overlay.usageDisplay) return overlay.usageDisplay;
  const raw = cfgString(config?.usageDisplay).trim().toLowerCase();
  return (USAGE_MODES.find((mode) => mode === raw) ?? "auto") as UsageMode;
}

export async function setUsageDisplay(
  ctx: any,
  config: CursorUiConfig | undefined,
  modeRaw: string,
): Promise<UsageMode> {
  const mode = USAGE_MODES.find((item) => item === String(modeRaw).trim().toLowerCase());
  if (!mode) throw new Error("Usage display must be one of: auto, always, off");
  await persistConfig(ctx, { usageDisplay: mode });
  return readUsageDisplay(config);
}

export function settingsNamespace(ctx: any): string {
  return ctx?.fiber?.entry?.options?.id ?? "llm-cursor";
}

/**
 * The compaction settings as the session will see them: overlay first, then
 * whatever the profile declares, then the defaults. Every field is normalised
 * so a hand-edited YAML that dropped a key cannot produce a NaN budget.
 */
export function readContextManagement(config: unknown): ContextManagementConfig {
  const raw = overlay.contextManagement ?? cfgGet((config as any)?.contextManagement) ?? {};
  const r = raw as Partial<ContextManagementConfig>;
  const num = (key: keyof ContextManagementConfig, min: number, fallback: number) => {
    const v = Math.floor(Number(r[key]));
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  const legacyKeep = Math.floor(Number((raw as { keepTurns?: number }).keepTurns));
  const preserveRecentMessages = Number.isFinite(legacyKeep) && legacyKeep >= 1 && r.preserveRecentMessages === undefined
    ? legacyKeep
    : num("preserveRecentMessages", 1, CONTEXT_DEFAULTS.preserveRecentMessages);
  const legacyEnabled = (raw as { enabled?: unknown }).enabled;
  const enabled =
    typeof r.enabled === "boolean"
      ? r.enabled
      : typeof legacyEnabled === "boolean"
        ? legacyEnabled
        : CONTEXT_DEFAULTS.enabled;
  return {
    enabled,
    preserveRecentMessages,
    preserveRecentTokens: num("preserveRecentTokens", 256, CONTEXT_DEFAULTS.preserveRecentTokens),
    outputReserve: num("outputReserve", 1024, CONTEXT_DEFAULTS.outputReserve),
    safetyMargin: num("safetyMargin", 1024, CONTEXT_DEFAULTS.safetyMargin),
    preflightMaxAttempts: num("preflightMaxAttempts", 1, CONTEXT_DEFAULTS.preflightMaxAttempts),
  };
}

/** Persist a partial update; returns the merged settings afterwards. */
export async function setContextManagement(
  ctx: any,
  config: CursorUiConfig | undefined,
  patch: Partial<ContextManagementConfig>,
): Promise<ContextManagementConfig> {
  const current = readContextManagement(config);
  const merged: ContextManagementConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    preserveRecentMessages: Math.floor(Number(patch.preserveRecentMessages ?? current.preserveRecentMessages)) || current.preserveRecentMessages,
    preserveRecentTokens: Math.floor(Number(patch.preserveRecentTokens ?? current.preserveRecentTokens)) || current.preserveRecentTokens,
    outputReserve: Math.floor(Number(patch.outputReserve ?? current.outputReserve)) || current.outputReserve,
    safetyMargin: Math.floor(Number(patch.safetyMargin ?? current.safetyMargin)) || current.safetyMargin,
    preflightMaxAttempts:
      Math.floor(Number(patch.preflightMaxAttempts ?? current.preflightMaxAttempts)) || current.preflightMaxAttempts,
  };
  if (merged.preserveRecentMessages < 1) throw new Error("preserveRecentMessages must be at least 1");
  if (merged.preserveRecentTokens < 256) throw new Error("preserveRecentTokens must be at least 256");
  if (merged.outputReserve < 1024) throw new Error("outputReserve must be at least 1024");
  if (merged.safetyMargin < 1024) throw new Error("safetyMargin must be at least 1024");
  if (merged.preflightMaxAttempts < 1) throw new Error("preflightMaxAttempts must be at least 1");
  await persistConfig(ctx, { contextManagement: merged });
  return readContextManagement(config);
}

async function persistConfig(ctx: any, patch: Record<string, unknown>): Promise<void> {
  applyOverlay(patch as Overlay);
  const settings = ctx?.get?.("settings");
  if (!settings?.update) return;
  const ns = settingsNamespace(ctx);
  try {
    await settings.update(ns, patch);
  } catch (err) {
    // Overlay still applies for this process; caller surfaces the message.
    throw err;
  }
}

export async function listProfileStatus(ctx: any, config: CursorUiConfig | undefined): Promise<ProfileStatus[]> {
  const profiles = readProfiles(config);
  const active = readActiveKeyId(config);
  const credentials = ctx?.get?.("credentials");
  const out: ProfileStatus[] = [];
  for (const profile of profiles) {
    const refName = profileCredentialRef(profile);
    let configured = false;
    let writable = true;
    let source: string | undefined;
    if (credentials?.describe) {
      try {
        const info = await credentials.describe(credentialRef(refName));
        configured = Boolean(info?.configured);
        writable = info?.writable !== false;
        source = typeof info?.source === "string" ? info.source : undefined;
      } catch {
        /* describe failed — treat as unconfirmed / not configured */
      }
    } else if (profile.apiKey?.trim()) {
      configured = true;
      source = "inline";
    }
    out.push({
      id: profile.id,
      label: profile.label?.trim() || profile.id,
      apiKeyEnv: refName,
      active: profile.id === active,
      configured,
      writable,
      source,
    });
  }
  return out;
}

export async function setProfileKey(
  ctx: any,
  config: CursorUiConfig | undefined,
  opts: { id: string; label?: string; key: string },
): Promise<ProfileStatus[]> {
  const id = opts.id.trim();
  if (!id) throw new Error("Profile id is required");
  const key = opts.key.trim();
  if (!key) throw new Error("API key is required");
  if (!/^[\x21-\x7E]+$/.test(key)) throw new Error("API key must be non-empty printable ASCII");

  const profiles = readProfiles(config).map((p) => ({ ...p }));
  let profile = profiles.find((p) => p.id === id);
  if (!profile) {
    profile = {
      id,
      label: opts.label?.trim() || id,
      apiKeyEnv: id === "default" ? "CURSOR_API_KEY" : `CURSOR_API_KEY_${id}`.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(),
    };
    profiles.push(profile);
  } else if (opts.label?.trim()) {
    profile.label = opts.label.trim();
  }
  // Never keep plaintext in config once credentials can store it.
  delete profile.apiKey;

  const refName = profileCredentialRef(profile);
  const credentials = ctx?.get?.("credentials");
  if (!credentials?.set) throw new Error("credentials service is not mounted; cannot store API keys from the UI");
  await credentials.set(credentialRef(refName), key);

  const activeKeyId = readActiveKeyId(config);
  await persistConfig(ctx, {
    apiKeyProfiles: profiles.map(({ id: pid, label, apiKeyEnv }) => ({
      id: pid,
      label: label || pid,
      apiKeyEnv: apiKeyEnv || profileCredentialRef({ id: pid, apiKeyEnv }),
    })),
    activeKeyId: profiles.some((p) => p.id === activeKeyId) ? activeKeyId : profiles[0].id,
  });
  return listProfileStatus(ctx, { ...config, apiKeyProfiles: profiles, activeKeyId });
}

export async function addProfile(
  ctx: any,
  config: CursorUiConfig | undefined,
  opts: { id: string; label?: string },
): Promise<ProfileStatus[]> {
  const id = opts.id.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new Error("Profile id must start with a letter and use only letters, digits, _ or -");
  const profiles = readProfiles(config).map((p) => ({ ...p }));
  if (profiles.some((p) => p.id === id)) throw new Error(`Profile "${id}" already exists`);
  profiles.push({
    id,
    label: opts.label?.trim() || id,
    apiKeyEnv: id === "default" ? "CURSOR_API_KEY" : `CURSOR_API_KEY_${id}`.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(),
  });
  await persistConfig(ctx, {
    apiKeyProfiles: profiles.map(({ id: pid, label, apiKeyEnv }) => ({ id: pid, label: label || pid, apiKeyEnv })),
    activeKeyId: readActiveKeyId(config),
  });
  return listProfileStatus(ctx, { ...config, apiKeyProfiles: profiles });
}

export async function removeProfile(
  ctx: any,
  config: CursorUiConfig | undefined,
  idRaw: string,
): Promise<ProfileStatus[]> {
  const id = idRaw.trim();
  const profiles = readProfiles(config).map((p) => ({ ...p }));
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`Profile "${id}" not found`);
  if (profiles.length === 1) throw new Error("Cannot remove the last profile");
  const [removed] = profiles.splice(idx, 1);
  const credentials = ctx?.get?.("credentials");
  const refName = profileCredentialRef(removed);
  if (credentials?.unset && credentials?.describe) {
    try {
      const info = await credentials.describe(credentialRef(refName));
      if (info?.writable && info?.configured) await credentials.unset(credentialRef(refName));
    } catch {
      /* best effort */
    }
  }
  let activeKeyId = readActiveKeyId(config);
  if (activeKeyId === id) activeKeyId = profiles[0].id;
  await persistConfig(ctx, {
    apiKeyProfiles: profiles.map(({ id: pid, label, apiKeyEnv }) => ({ id: pid, label: label || pid, apiKeyEnv })),
    activeKeyId,
  });
  return listProfileStatus(ctx, { ...config, apiKeyProfiles: profiles, activeKeyId });
}

export async function useProfile(ctx: any, config: CursorUiConfig | undefined, idRaw: string): Promise<ProfileStatus[]> {
  const id = idRaw.trim();
  const profiles = readProfiles(config);
  if (!profiles.some((p) => p.id === id)) throw new Error(`Profile "${id}" not found`);
  await persistConfig(ctx, { activeKeyId: id });
  return listProfileStatus(ctx, { ...config, activeKeyId: id });
}

/** Drop legacy contextManagement keys from persisted settings (keepTurns, enabled, …). */
export async function migrateLegacyContextSettings(ctx: any, config: CursorUiConfig | undefined): Promise<boolean> {
  const settings = ctx?.get?.("settings");
  if (!settings?.read) return false;
  const ns = settingsNamespace(ctx);
  let doc: any;
  try {
    doc = await settings.read(ns);
  } catch {
    return false;
  }
  const raw = doc?.contextManagement;
  if (!raw || typeof raw !== "object") return false;
  const legacy = "keepTurns" in raw || "budgetTokens" in raw || "summarizerProvider" in raw || "summarizerModel" in raw;
  if (!legacy) return false;
  const { keepTurns: _k, budgetTokens: _b, summarizerProvider: _p, summarizerModel: _m, ...rest } = raw as Record<string, unknown>;
  await persistConfig(ctx, {
    contextManagement: readContextManagement({ ...(config as object), contextManagement: rest }),
  });
  return true;
}

export function uiSnapshot(ctx: any, config: CursorUiConfig | undefined) {
  return (async () => ({
    activeKeyId: readActiveKeyId(config),
    profiles: await listProfileStatus(ctx, config),
    usageDisplay: readUsageDisplay(config),
    contextManagement: readContextManagement(config),
    settingsNs: settingsNamespace(ctx),
  }))();
}
