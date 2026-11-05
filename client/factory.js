/**
 * Browser half: Settings → Cursor (multi API keys).
 * Built as a DSH client ModuleLoader factory (copied to lib/client.js).
 */
window.__ModuleLoader__.load({
  id: "cursor-to-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Button, Input, StateDot } = require("@deepseek-ai/dsh-client-ui-primitives");
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    const API = "/api/cursor-to-dsh";
    const NS = "cursor-to-dsh";
    const PLUGIN_VERSION = "0.3.0";

    const EN = {
      nav: "Cursor",
      title: "Cursor",
      intro: "Store multiple Cursor API keys here (write-only via DSH credentials). Pick which key is active.",
      keysTitle: "API keys",
      keysHint: "Keys are never shown after save. Leave the input blank to keep the current key.",
      active: "Active",
      configured: "Key saved",
      missing: "Key missing",
      use: "Use",
      remove: "Remove",
      saveKey: "Save key",
      addTitle: "Add profile",
      addId: "Id",
      addLabel: "Label",
      add: "Add",
      refresh: "Refresh",
      busy: "Working…",
      placeholderKey: "Paste Cursor API key",
      placeholderId: "work",
      placeholderLabel: "Work",
      commandHint: "Chat commands: /cursor-keys, /cursor-key-set, /cursor-key-use, /cursor-key-add, /cursor-key-remove.",
      pluginVersion: "Plugin version:",
      error: "Error",
      usageTitle: "Usage",
      usageHint: "Cursor reads this host's Cursor sign-in; Copilot reuses the Copilot sign-in in Settings. Cached up to 2 minutes.",
      usagePillLabel: "Usage pill",
      usageModeAuto: "Auto",
      usageModeAlways: "Always",
      usageModeOff: "Off",
      usageModeHint: "Auto shows the pill only while a Cursor model is selected.",
      usageResetsAt: "Resets {t}",
      usageUpdatedAt: "Updated {t}",
      usageSource: "Source",
      usageLoading: "Loading…",
      usageNoData: "Cursor returned no usage windows.",
      usageNoSignIn: "No Cursor sign-in on this host. Open the Cursor desktop app once, or set CURSOR_ACCESS_TOKEN.",
      winAuto: "Auto mode",
      winApi: "API",
      winTotal: "Total",
      winGrok: "Grok Bot",
      winPremium: "Premium",
      winChat: "Chat",
      winCompletions: "Completions",
      winShortAuto: "Auto",
      winShortTotal: "Total",
      winShortGrok: "Grok",
      winShortPremium: "Premium",
      winShortChat: "Chat",
      winShortCompletions: "Comp",
      usageUnlimited: "Unlimited",
      usagePlan: "Plan",
      usageSectionCursor: "Cursor usage",
      usageSectionCopilot: "Copilot usage",
      usageNoCopilot: "No GitHub token found. Sign in to Copilot under Settings, or set GITHUB_TOKEN.",
      copilotAuthTitle: "Copilot sign-in",
      copilotAuthHint: "Stores the credential DSH's github-copilot route and the usage card read. This plugin never touches model traffic.",
      copilotSignedIn: "Signed in",
      copilotSignedOut: "Not signed in",
      copilotPending: "Waiting for authorization…",
      copilotCode: "Code: {t}",
      copilotOpen: "Open {t}",
      copilotLogin: "Sign in",
      copilotLogout: "Sign out",
      copilotModelCount: "Models: {t}",
    };
    const ZH = {
      nav: "Cursor",
      title: "Cursor",
      intro: "在此管理多把 Cursor API Key（经 DSH credentials 只写存储）。选择当前使用的 Key。",
      keysTitle: "API Key",
      keysHint: "保存后不会回显密钥。输入框留空表示保留现有 Key。",
      active: "使用中",
      configured: "已保存",
      missing: "未配置",
      use: "选用",
      remove: "删除",
      saveKey: "保存 Key",
      addTitle: "添加配置",
      addId: "Id",
      addLabel: "显示名",
      add: "添加",
      refresh: "刷新",
      busy: "处理中…",
      placeholderKey: "粘贴 Cursor API Key",
      placeholderId: "work",
      placeholderLabel: "工作",
      commandHint: "对话命令：/cursor-keys、/cursor-key-set、/cursor-key-use、/cursor-key-add、/cursor-key-remove。",
      pluginVersion: "插件版本：",
      error: "错误",
      usageTitle: "用量",
      usageHint: "Cursor 读本机 Cursor 登录态，Copilot 复用设置里的 Copilot 登录；最多缓存 2 分钟。",
      usagePillLabel: "用量胶囊",
      usageModeAuto: "自动",
      usageModeAlways: "常驻",
      usageModeOff: "关闭",
      usageModeHint: "自动：仅在选中 Cursor 模型时显示胶囊。",
      usageResetsAt: "重置于 {t}",
      usageUpdatedAt: "更新于 {t}",
      usageSource: "来源",
      usageLoading: "加载中…",
      usageNoData: "Cursor 未返回用量数据。",
      usageNoSignIn: "本机未找到 Cursor 登录态：先打开一次 Cursor 桌面端，或设置 CURSOR_ACCESS_TOKEN。",
      winAuto: "自动模式",
      winApi: "API",
      winTotal: "合计",
      winGrok: "Grok Bot",
      winPremium: "高级请求",
      winChat: "对话",
      winCompletions: "补全",
      winShortAuto: "自动",
      winShortTotal: "合计",
      winShortGrok: "Grok",
      winShortPremium: "高级",
      winShortChat: "对话",
      winShortCompletions: "补全",
      usageUnlimited: "不限",
      usagePlan: "套餐",
      usageSectionCursor: "Cursor 用量",
      usageSectionCopilot: "Copilot 用量",
      usageNoCopilot: "未登录 Copilot：先在设置里完成 Copilot 登录，或设置 GITHUB_TOKEN。",
      copilotAuthTitle: "Copilot 登录",
      copilotAuthHint: "登录写入 DSH github-copilot 路由和用量卡读取的同一份凭据；本插件不碰模型流量。",
      copilotSignedIn: "已登录",
      copilotSignedOut: "未登录",
      copilotPending: "等待授权…",
      copilotCode: "验证码：{t}",
      copilotOpen: "打开 {t}",
      copilotLogin: "登录",
      copilotLogout: "退出",
      copilotModelCount: "模型：{t}",
    };

    let localeRuntime;
    const localeSubscribe = (listener) => (localeRuntime === void 0 ? () => {} : localeRuntime.subscribe(listener));
    const localeSnapshot = () => localeRuntime?.getSnapshot().revision ?? 0;
    function text(key) {
      const dictionary = localeRuntime?.getSnapshot().active === "zh" ? ZH : EN;
      return dictionary[key] ?? EN[key] ?? key;
    }
    function useLocaleRevision() {
      useSyncExternalStore(localeSubscribe, localeSnapshot, () => 0);
    }

    const css = {
      section: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 760, paddingBottom: 32 },
      title: { margin: 0, fontSize: 22, lineHeight: "30px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      intro: { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-secondary)" },
      card: { display: "flex", flexDirection: "column", gap: 14, padding: 18, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)" },
      h3: { margin: 0, fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      hint: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
      status: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      actions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      profile: { display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2)" },
      profileTitle: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      meta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      field: { display: "flex", flexDirection: "column", gap: 6, minWidth: 220, flex: 1 },
      label: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      error: { margin: 0, whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-error, var(--dsw-alias-state-danger-label))" },
      versionLink: { color: "var(--dsw-alias-brand-primary)" },
      // Usage surfaces mirror dsh-opencode-go's pill/panel metrics so the two
      // plugins look alike in the same input area.
      windows: { display: "flex", flexDirection: "column", gap: 7 },
      winTile: {
        background: "color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 6%, transparent)",
        borderRadius: 10, overflow: "hidden",
      },
      winRow: { padding: "10px 12px" },
      winHead: { display: "flex", alignItems: "center", gap: 10 },
      winLabel: {
        fontSize: 12.5, color: "var(--dsw-alias-label-secondary)", width: 80, flex: "none",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      },
      winPct: { fontSize: 13, fontWeight: 650, color: "var(--dsw-alias-label-primary)", width: 44, textAlign: "right", flex: "none", fontVariantNumeric: "tabular-nums" },
      barTrack: {
        flex: 1, height: 8, borderRadius: 99, minWidth: 60, overflow: "hidden",
        background: "color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 12%, transparent)",
      },
      barFill: { display: "block", height: "100%", borderRadius: 99, transition: "width .3s ease" },
      winReset: { marginTop: 6, fontSize: 11, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)" },
      usageFooter: { padding: "2px 6px 0", fontSize: 11, lineHeight: 1.6, opacity: 0.65, color: "var(--dsw-alias-label-secondary)" },
      section: { display: "flex", flexDirection: "column", gap: 7, minWidth: 0 },
      sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "2px 6px 0" },
      sectionTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      compactBtn: {
        border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 25%, transparent)",
        background: "transparent", color: "inherit", borderRadius: 6,
        padding: "4px 9px", font: "inherit", fontSize: 11.5, cursor: "pointer",
      },
      modeRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      sectionDivider: {
        height: ".5px", margin: "0 12px", flex: "none",
        background: "color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 10%, transparent)",
      },
      pillWrap: { position: "relative", display: "inline-flex", minWidth: 0, color: "var(--dsw-alias-label-primary)" },
      pill: {
        display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px",
        border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 16%, transparent)",
        borderRadius: 12, background: "color-mix(in srgb, var(--dsw-alias-bg-layer-1, Canvas) 72%, transparent)",
        color: "inherit", font: "inherit", fontSize: 12.5, lineHeight: 1.6, whiteSpace: "nowrap",
        cursor: "pointer", minWidth: 0, maxWidth: "46vw", overflow: "hidden",
      },
      pillText: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
      pillDot: { width: 7, height: 7, borderRadius: "50%", flex: "none" },
      usagePanel: {
        position: "absolute", bottom: "calc(100% + 10px)", right: 0, zIndex: 100,
        boxSizing: "border-box", width: 340, maxWidth: "calc(100vw - 24px)", maxHeight: "72vh",
        display: "flex", flexDirection: "column", fontSize: 12, isolation: "isolate",
        color: "var(--dsw-alias-label-primary)", borderRadius: 16, overflow: "hidden",
        border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 12%, transparent)",
        boxShadow: "0 20px 60px rgba(0,0,0,.33)",
      },
      panelMaterial: {
        zIndex: -1, borderRadius: "inherit", pointerEvents: "none", position: "absolute", inset: 0,
        background: "color-mix(in srgb, var(--dsw-alias-bg-layer-1, #2a2a2c) 88%, transparent)",
        backdropFilter: "blur(40px) saturate(150%)",
        WebkitBackdropFilter: "blur(40px) saturate(150%)",
      },
      panelBody: { display: "flex", flexDirection: "column", gap: 7, padding: 10, overflowY: "auto", flex: 1, minHeight: 0, position: "relative" },
      authRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500, color: "var(--dsw-alias-label-primary)", flexWrap: "wrap" },
      authCode: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 17, fontWeight: 700, letterSpacing: 1.5, color: "var(--dsw-alias-label-primary)" },
      authLink: { color: "var(--dsw-alias-brand-primary)", fontSize: 13, wordBreak: "break-all" },
    };

    async function request(path, method = "GET", body) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        cache: "no-store",
        body: body ? JSON.stringify(body) : undefined,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`Cursor settings request failed (HTTP ${response.status})`);
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `Cursor settings request failed (HTTP ${response.status})`);
      }
      return payload.value;
    }

    /* ---------- usage (Settings card + conversation pill) ---------- */

    const USAGE_POLL_MS = 60_000;
    const MODES = ["auto", "always", "off"];
    const MODE_KEYS = { auto: "usageModeAuto", always: "usageModeAlways", off: "usageModeOff" };
    const WIN_KEYS = {
      auto: "winAuto", api: "winApi", total: "winTotal", grok_bot: "winGrok",
      premium: "winPremium", chat: "winChat", completions: "winCompletions",
    };
    /** Compact labels for the collapsed pill (panel keeps the full ones). */
    const WIN_SHORT_KEYS = {
      auto: "winShortAuto", total: "winShortTotal", grok_bot: "winShortGrok",
      premium: "winShortPremium", chat: "winShortChat", completions: "winShortCompletions",
    };
    /** Quota provider id -> display block. */
    const PROVIDERS = {
      cursor: { sectionKey: "usageSectionCursor" },
      copilot: { sectionKey: "usageSectionCopilot" },
    };
    const TONE_COLORS = {
      ok: "var(--dsw-alias-label-success, #3fa66a)",
      warning: "var(--dsw-alias-label-warning, #b46900)",
      danger: "var(--dsw-alias-label-danger, #c93c3c)",
    };

    /** Model-directory provider id -> quota provider id (null = not covered). */
    const quotaProviderOf = (modelProvider) =>
      modelProvider === "cursor" ? "cursor" : modelProvider === "github-copilot" ? "copilot" : null;

    const readUsage = (force, provider) =>
      request(`/usage?provider=${encodeURIComponent(provider)}${force ? "&force=1" : ""}`);
    const writeUsageMode = (mode) => request("/usage/display", "POST", { mode });

    function tp(key, value) {
      return text(key).replace("{t}", value);
    }

    function formatTime(iso) {
      if (!iso) return "";
      const date = new Date(iso);
      if (!Number.isFinite(date.getTime())) return "";
      return date.toLocaleString();
    }

    function formatPct(pct) {
      const value = Math.max(0, Math.min(100, Number(pct) || 0));
      return `${Math.round(value * 10) / 10}%`;
    }

    const toneColor = (tone) => TONE_COLORS[tone] ?? TONE_COLORS.ok;

    function UsageRow({ win }) {
      const pct = win.unlimited ? 100 : Math.max(0, Math.min(100, Number(win.usedPct) || 0));
      return jsxs("div", {
        style: css.winRow,
        children: [
          jsxs("div", {
            style: css.winHead,
            children: [
              jsx("span", { style: css.winLabel, children: text(WIN_KEYS[win.id] ?? "winTotal") }),
              jsx("span", {
                style: css.barTrack,
                children: jsx("span", {
                  style: {
                    ...css.barFill,
                    width: `${pct}%`,
                    background: win.unlimited ? "var(--dsw-alias-label-tertiary)" : toneColor(win.tone),
                  },
                }),
              }),
              jsx("span", {
                style: css.winPct,
                children: win.unlimited ? text("usageUnlimited") : formatPct(pct),
              }),
            ],
          }),
          win.resetsAt ? jsx("div", { style: css.winReset, children: tp("usageResetsAt", formatTime(win.resetsAt)) }) : null,
        ],
      });
    }

    /** Rows / hint / error for one usage snapshot; shared by the card and the pill panel. */
    function UsageBody({ usage, error, provider }) {
      if (error) return jsx("p", { role: "alert", style: css.error, children: error });
      if (!usage) return jsx("p", { style: css.hint, children: text("usageLoading") });
      if (usage.status === "unavailable") {
        return jsx("p", {
          style: css.hint,
          children: text(provider === "copilot" ? "usageNoCopilot" : "usageNoSignIn"),
        });
      }
      if (usage.status === "error") return jsx("p", { role: "alert", style: css.error, children: usage.error ?? text("error") });
      const windows = usage.windows ?? [];
      if (!windows.length) return jsx("p", { style: css.hint, children: text("usageNoData") });
      return jsx("div", {
        style: css.winTile,
        children: windows.map((win, index) =>
          jsxs("div", {
            children: [
              index > 0 ? jsx("div", { style: css.sectionDivider }) : null,
              jsx(UsageRow, { win }),
            ],
          }, win.id),
        ),
      });
    }

    function UsageFooter({ usage }) {
      if (!usage || usage.status !== "available") return null;
      const parts = [
        usage.fetchedAt ? tp("usageUpdatedAt", formatTime(usage.fetchedAt)) : "",
        usage.planLabel ? `${text("usagePlan")}: ${usage.planLabel}` : "",
        usage.sourceLabel ? `${text("usageSource")}: ${usage.sourceLabel}` : "",
      ].filter(Boolean);
      return jsx("div", { style: css.usageFooter, children: parts.join(" · ") });
    }

    /**
     * One snapshot source for both surfaces.
     * `shouldPoll(usage)` decides the 60s timer; the page pauses it while hidden and
     * refreshes immediately when it becomes visible again.
     */
    function useUsage(shouldPoll, provider) {
      const [usage, setUsage] = useState();
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState();

      const load = useCallback((force) => {
        setBusy(true);
        return readUsage(force, provider).then(
          (next) => { setUsage(next); setError(void 0); return next; },
          (cause) => { setError(cause instanceof Error ? cause.message : String(cause)); return void 0; },
        ).finally(() => setBusy(false));
      }, [provider]);

      useEffect(() => {
        let alive = true;
        readUsage(false, provider).then(
          (next) => { if (alive) { setUsage(next); setError(void 0); } },
          (cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); },
        );
        return () => { alive = false; };
      }, [provider]);

      const poll = shouldPoll(usage);
      useEffect(() => {
        if (!poll) return undefined;
        const refresh = () => { if (!document.hidden) void load(false); };
        const timer = setInterval(refresh, USAGE_POLL_MS);
        document.addEventListener("visibilitychange", refresh);
        return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
      }, [poll, load]);

      /** Save the pill display mode (one POST) and adopt it into this state. */
      const saveMode = useCallback((mode) => {
        setBusy(true);
        return writeUsageMode(mode).then(
          (next) => {
            const saved = next?.mode ?? mode;
            setUsage((prev) => (prev ? { ...prev, mode: saved } : prev));
            setError(void 0);
            return saved;
          },
          (cause) => { setError(cause instanceof Error ? cause.message : String(cause)); return void 0; },
        ).finally(() => setBusy(false));
      }, []);

      /** Adopt a mode another state just saved, without a second POST. */
      const applyMode = useCallback((mode) => {
        setUsage((prev) => (prev ? { ...prev, mode } : prev));
      }, []);

      return { usage, busy, error, load, saveMode, applyMode };
    }

    /** One provider's block: head (title + refresh) + window tile + footer. */
    function UsageSection({ provider, state }) {
      return jsxs("div", {
        style: css.section,
        children: [
          jsxs("div", {
            style: css.sectionHead,
            children: [
              jsx("span", { style: css.sectionTitle, children: text(PROVIDERS[provider].sectionKey) }),
              jsx("button", {
                type: "button",
                style: css.compactBtn,
                disabled: state.busy,
                onClick: () => { void state.load(true); },
                children: text("refresh"),
              }),
            ],
          }),
          jsx(UsageBody, { usage: state.usage, error: state.error, provider }),
          jsx(UsageFooter, { usage: state.usage }),
        ],
      });
    }

    const EMPTY_DIRECTORY_STORE = { subscribe: () => () => {}, getSnapshot: () => null };

    /** Cursor usage pill in the conversation input (slot: conversation.input.right). */
    function UsagePill({ directory }) {
      const store = useMemo(
        () => (directory && directory.subscribe && directory.getSnapshot
          ? { subscribe: directory.subscribe.bind(directory), getSnapshot: directory.getSnapshot.bind(directory) }
          : EMPTY_DIRECTORY_STORE),
        [directory],
      );
      const dirState = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const modelProvider = directory ? (dirState?.current?.provider ?? null) : null;
      const covered = !directory || quotaProviderOf(modelProvider) !== null;
      const activeProvider = quotaProviderOf(modelProvider) ?? "cursor";
      const shouldPoll = (value) => Boolean(value) && value.mode !== "off";
      const cursorState = useUsage(shouldPoll, "cursor");
      const copilotState = useUsage(shouldPoll, "copilot");
      const [open, setOpen] = useState(false);
      const wrapRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("pointerdown", onDown);
        return () => document.removeEventListener("pointerdown", onDown);
      }, [open]);

      const mode = cursorState.usage?.mode ?? copilotState.usage?.mode ?? "auto";
      if (mode === "off") return null;
      // auto: only while this session is on a covered model (no directory store = show it).
      if (mode === "auto" && !covered) return null;

      // Collapsed readings follow the current model's provider; the panel always
      // shows both, so 常驻 mode never hides the other provider's quota.
      const active = activeProvider === "copilot" ? copilotState : cursorState;
      const usage = active.usage;
      const sectionKey = PROVIDERS[activeProvider].sectionKey;
      const windows = usage?.status === "available" ? usage.windows ?? [] : [];
      const preferred = activeProvider === "copilot" ? "premium" : "total";
      const main =
        windows.find((win) => win.id === preferred) ??
        windows.find((win) => win.id === "auto") ??
        windows.find((win) => !win.unlimited) ??
        windows[0];
      // Second reading: the window that most needs attention, else the next row.
      const second =
        windows.find((win) => win !== main && win.tone !== "ok") ??
        windows.find((win) => win !== main && win.id !== preferred && win.id !== "auto") ??
        (windows.length > 1 && windows[1] !== main ? windows[1] : undefined);
      const winLine = (win) =>
        `${text(WIN_KEYS[win.id] ?? "winTotal")} ${win.unlimited ? text("usageUnlimited") : formatPct(win.usedPct)}`;
      const shortLine = (win) =>
        `${text(WIN_SHORT_KEYS[win.id] ?? WIN_KEYS[win.id] ?? "winTotal")} ${win.unlimited ? text("usageUnlimited") : formatPct(win.usedPct)}`;
      const brand = activeProvider === "copilot" ? "Copilot" : "Cursor";
      const triggerText = !usage
        ? "…"
        : usage.status !== "available"
          ? "—"
          : [brand, main && shortLine(main), second && shortLine(second)]
              .filter(Boolean)
              .join(" · ");
      const title = usage?.status === "available"
        ? `${text(sectionKey)} · ${windows.map(winLine).join(" · ")}`
        : (usage?.error ?? text(activeProvider === "copilot" ? "usageNoCopilot" : "usageNoSignIn"));

      return jsxs("div", { style: css.pillWrap, ref: wrapRef, children: [
        jsx("button", {
          type: "button",
          style: css.pill,
          title,
          "aria-expanded": open,
          onClick: () => setOpen((value) => !value),
          children: jsx("span", { style: css.pillText, children: triggerText }),
        }),
        open
          ? jsxs("div", {
              style: css.usagePanel,
              children: [
                jsx("div", { style: css.panelMaterial }),
                jsxs("div", {
                  style: css.panelBody,
                  children: [
                    jsx(UsageSection, { provider: "cursor", state: cursorState }),
                    jsx("div", { style: css.sectionDivider }),
                    jsx(UsageSection, { provider: "copilot", state: copilotState }),
                  ],
                }),
              ],
            })
          : null,
      ] });
    }

    /**
     * Settings card: GitHub Copilot device-flow sign-in. The backend controller
     * (`src/copilot-auth.ts`) is ported from @lujianjun19/dsh-llm-github-copilot
     * so that plugin can be retired; the credential record id is unchanged.
     */
    function CopilotAuthCard() {
      const [status, setStatus] = useState();
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState();

      const load = useCallback(() => request("/copilot/status").then(
        (next) => { setStatus(next); setError(void 0); return next; },
        (cause) => { setError(cause instanceof Error ? cause.message : String(cause)); return void 0; },
      ), []);
      useEffect(() => { void load(); }, [load]);

      // The backend polls GitHub; this only watches the flow state.
      const pending = status?.state === "pending";
      useEffect(() => {
        if (!pending) return undefined;
        const timer = setInterval(() => { void load(); }, 2500);
        return () => clearInterval(timer);
      }, [pending, load]);

      const run = (action) => {
        setBusy(true);
        setError(void 0);
        return action().then(
          (next) => { setStatus(next); },
          (cause) => { setError(cause instanceof Error ? cause.message : String(cause)); },
        ).finally(() => setBusy(false));
      };

      const authenticated = status?.state === "authenticated";
      const dotColor = !status
        ? "var(--dsw-alias-label-tertiary)"
        : authenticated ? TONE_COLORS.ok : pending ? TONE_COLORS.warning : TONE_COLORS.danger;
      const label = !status
        ? text("usageLoading")
        : authenticated ? text("copilotSignedIn")
        : pending ? text("copilotPending")
        : text("copilotSignedOut");

      return jsxs("div", {
        style: css.card,
        children: [
          jsxs("div", {
            style: css.row,
            children: [
              jsx("h3", { style: css.h3, children: text("copilotAuthTitle") }),
              jsxs("div", {
                style: css.actions,
                children: [
                  jsx(Button, {
                    variant: "outline",
                    disabled: busy,
                    onClick: () => { void load(); },
                    children: text("refresh"),
                  }),
                  authenticated
                    ? jsx(Button, {
                        variant: "outline",
                        disabled: busy,
                        onClick: () => { void run(() => request("/copilot/logout", "POST", {})); },
                        children: text("copilotLogout"),
                      })
                    : jsx(Button, {
                        variant: "primary",
                        disabled: busy || pending,
                        onClick: () => { void run(() => request("/copilot/login", "POST", {})); },
                        children: text("copilotLogin"),
                      }),
                ],
              }),
            ],
          }),
          jsx("p", { style: css.hint, children: text("copilotAuthHint") }),
          error ? jsx("p", { role: "alert", style: css.error, children: error }) : null,
          jsxs("div", {
            style: css.authRow,
            children: [
              jsx("span", { style: { ...css.pillDot, background: dotColor } }),
              jsx("span", { children: label }),
              authenticated && status?.modelCount
                ? jsx("span", { style: css.meta, children: tp("copilotModelCount", String(status.modelCount)) })
                : null,
              !authenticated && status?.message
                ? jsx("span", { style: css.meta, children: status.message })
                : null,
            ],
          }),
          pending && status?.userCode
            ? jsxs("div", {
                style: css.windows,
                children: [
                  jsx("span", { style: css.authCode, children: status.userCode }),
                  jsx("a", {
                    href: status.verificationUri,
                    target: "_blank",
                    rel: "noreferrer",
                    style: css.authLink,
                    children: tp("copilotOpen", status.verificationUri ?? ""),
                  }),
                ],
              })
            : null,
        ],
      });
    }

    function CursorSettings() {
      useLocaleRevision();
      const [status, setStatus] = useState();
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState();
      const [drafts, setDrafts] = useState({});
      const [newId, setNewId] = useState("");
      const [newLabel, setNewLabel] = useState("");

      const refresh = async () => {
        try {
          const next = await request("/status");
          setStatus(next);
          setError(void 0);
          return next;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return void 0;
        }
      };

      useEffect(() => {
        let alive = true;
        request("/status").then(
          (value) => { if (alive) setStatus(value); },
          (cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); },
        );
        return () => { alive = false; };
      }, []);

      const run = async (fn) => {
        setBusy(true);
        setError(void 0);
        try {
          const next = await fn();
          if (next) setStatus(next);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };


      const cursorUsage = useUsage(() => false, "cursor");
      const copilotUsage = useUsage(() => false, "copilot");
      const setMode = (mode) => {
        void cursorUsage.saveMode(mode).then((saved) => {
          if (saved) copilotUsage.applyMode(saved);
        });
      };
      const mode = cursorUsage.usage?.mode ?? copilotUsage.usage?.mode ?? "auto";
      const modeBusy = cursorUsage.busy || copilotUsage.busy;

      return jsxs("section", {
        style: css.section,
        children: [
          jsx("h2", { style: css.title, children: text("title") }),
          jsx("p", { style: css.intro, children: text("intro") }),

          jsxs("div", {
            style: css.card,
            children: [
              jsx("h3", { style: css.h3, children: text("usageTitle") }),
              jsx("p", { style: css.hint, children: text("usageHint") }),
              jsx(UsageSection, { provider: "cursor", state: cursorUsage }),
              jsx("div", { style: css.sectionDivider }),
              jsx(UsageSection, { provider: "copilot", state: copilotUsage }),
              jsxs("div", {
                style: css.modeRow,
                children: [
                  jsx("span", { style: css.label, children: text("usagePillLabel") }),
                  ...MODES.map((item) =>
                    jsx(Button, {
                      variant: mode === item ? "primary" : "outline",
                      disabled: modeBusy,
                      onClick: () => setMode(item),
                      children: text(MODE_KEYS[item]),
                    }, item),
                  ),
                ],
              }),
              jsx("p", { style: css.hint, children: text("usageModeHint") }),
            ],
          }),

          jsx(CopilotAuthCard, {}),

          jsxs("div", {
            style: css.card,
            children: [
              jsxs("div", {
                style: css.row,
                children: [
                  jsx("h3", { style: css.h3, children: text("keysTitle") }),
                  jsx(Button, { variant: "outline", disabled: busy, onClick: () => { void run(refresh); }, children: text("refresh") }),
                ],
              }),
              jsx("p", { style: css.hint, children: text("keysHint") }),
              error ? jsx("p", { role: "alert", style: css.error, children: error }) : null,
              ...(status?.profiles ?? []).map((profile) =>
                jsxs("div", {
                  key: profile.id,
                  style: css.profile,
                  children: [
                    jsxs("div", {
                      style: css.row,
                      children: [
                        jsxs("div", {
                          style: css.profileTitle,
                          children: [
                            jsx(StateDot, { tone: profile.configured ? "success" : "danger" }),
                            `${profile.label} (${profile.id})`,
                            profile.active ? jsx("span", { style: css.meta, children: `· ${text("active")}` }) : null,
                          ],
                        }),
                        jsx("span", {
                          style: css.meta,
                          children: `${profile.configured ? text("configured") : text("missing")} · ${profile.apiKeyEnv}`,
                        }),
                      ],
                    }),
                    jsxs("div", {
                      style: css.row,
                      children: [
                        jsxs("div", {
                          style: css.field,
                          children: [
                            jsx("span", { style: css.label, children: text("saveKey") }),
                            jsx(Input, {
                              type: "password",
                              autoComplete: "new-password",
                              placeholder: text("placeholderKey"),
                              value: drafts[profile.id] ?? "",
                              disabled: busy,
                              onChange: (event) => {
                                const value = event?.target?.value ?? "";
                                setDrafts((prev) => ({ ...prev, [profile.id]: value }));
                              },
                            }),
                          ],
                        }),
                        jsxs("div", {
                          style: css.actions,
                          children: [
                            jsx(Button, {
                              variant: "primary",
                              disabled: busy || !(drafts[profile.id] || "").trim(),
                              onClick: () => {
                                void run(async () => {
                                  const key = (drafts[profile.id] || "").trim();
                                  const next = await request("/keys", "POST", { id: profile.id, label: profile.label, key });
                                  setDrafts((prev) => ({ ...prev, [profile.id]: "" }));
                                  return next;
                                });
                              },
                              children: text("saveKey"),
                            }),
                            jsx(Button, {
                              variant: "outline",
                              disabled: busy || profile.active,
                              onClick: () => { void run(() => request("/keys/use", "POST", { id: profile.id })); },
                              children: text("use"),
                            }),
                            jsx(Button, {
                              variant: "outline",
                              disabled: busy || (status?.profiles?.length ?? 0) <= 1,
                              onClick: () => { void run(() => request("/keys/remove", "POST", { id: profile.id })); },
                              children: text("remove"),
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
              ),
            ],
          }),

          jsxs("div", {
            style: css.card,
            children: [
              jsx("h3", { style: css.h3, children: text("addTitle") }),
              jsxs("div", {
                style: css.row,
                children: [
                  jsxs("div", {
                    style: css.field,
                    children: [
                      jsx("span", { style: css.label, children: text("addId") }),
                      jsx(Input, {
                        value: newId,
                        placeholder: text("placeholderId"),
                        disabled: busy,
                        onChange: (event) => setNewId(event?.target?.value ?? ""),
                      }),
                    ],
                  }),
                  jsxs("div", {
                    style: css.field,
                    children: [
                      jsx("span", { style: css.label, children: text("addLabel") }),
                      jsx(Input, {
                        value: newLabel,
                        placeholder: text("placeholderLabel"),
                        disabled: busy,
                        onChange: (event) => setNewLabel(event?.target?.value ?? ""),
                      }),
                    ],
                  }),
                  jsx(Button, {
                    variant: "primary",
                    disabled: busy || !newId.trim(),
                    onClick: () => {
                      void run(async () => {
                        const next = await request("/keys/add", "POST", { id: newId.trim(), label: newLabel.trim() || undefined });
                        setNewId("");
                        setNewLabel("");
                        return next;
                      });
                    },
                    children: text("add"),
                  }),
                ],
              }),
            ],
          }),

          jsx("p", { style: css.hint, children: text("commandHint") }),
          jsxs("p", {
            style: css.hint,
            children: [
              text("pluginVersion"),
              " ",
              jsx("a", {
                href: `https://github.com/AngusFu/cursor-to-dsh/releases/tag/v${PLUGIN_VERSION}`,
                target: "_blank",
                rel: "noreferrer",
                style: css.versionLink,
                children: `cursor-to-dsh v${PLUGIN_VERSION}`,
              }),
            ],
          }),
        ],
      });
    }

    const inject = {
      locale: ["@deepseek-ai/dsh-client-locale"],
      slots: ["@deepseek-ai/dsh-client-ui-renderer"],
    };

    function apply(ctx) {
      localeRuntime = ctx.locale;
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "cursor-to-dsh",
            order: 12,
            locale: NS,
            label: () => text("nav"),
          },
          CursorSettings,
        ),
      );

      // Usage pill beside the composer; modelDirectories comes from the shell, so a scope
      // that never becomes ready only costs the pill, never the settings page.
      ctx.inject(["modelDirectories"], (mctx) => {
        mctx.slots.inject("conversation.input.right", () =>
          mctx.slots.register(
            {
              name: "conversation.input.right",
              id: "cursor-to-dsh-usage",
              order: 900,
              inject: (sessionId) => ({
                directory: mctx.modelDirectories?.directoryFor?.(sessionId)?.store,
              }),
            },
            UsagePill,
          ),
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
