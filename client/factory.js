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
      usageUnlimited: "Unlimited",
      usagePlan: "Plan",
      usageSectionCursor: "Cursor usage",
      usageSectionCopilot: "Copilot usage",
      usageNoCopilot: "No GitHub token found. Sign in to Copilot under Settings, or set GITHUB_TOKEN.",
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
      usageUnlimited: "不限",
      usagePlan: "套餐",
      usageSectionCursor: "Cursor 用量",
      usageSectionCopilot: "Copilot 用量",
      usageNoCopilot: "未登录 Copilot：先在设置里完成 Copilot 登录，或设置 GITHUB_TOKEN。",
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
      windows: { display: "flex", flexDirection: "column", gap: 14 },
      winRow: { display: "flex", flexDirection: "column", gap: 5 },
      winHead: { display: "flex", alignItems: "center", gap: 10 },
      winLabel: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-secondary)", width: 78, flex: "none" },
      winPct: { fontSize: 14, fontWeight: 700, color: "var(--dsw-alias-label-primary)", width: 52, textAlign: "right", flex: "none", fontVariantNumeric: "tabular-nums" },
      barTrack: { flex: 1, height: 8, borderRadius: 8, background: "var(--dsw-alias-border-l2)", overflow: "hidden", minWidth: 40 },
      barFill: { display: "block", height: "100%", borderRadius: 8, transition: "width .3s ease" },
      usageFooter: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", flexWrap: "wrap" },
      modeRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      sectionDivider: { borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 14 },
      pillWrap: { position: "relative", display: "inline-flex" },
      pill: {
        display: "inline-flex", alignItems: "center", gap: 8, height: 26, padding: "0 10px",
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 999,
        background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
        fontSize: 12, fontWeight: 600, lineHeight: "24px", cursor: "pointer",
        fontVariantNumeric: "tabular-nums",
      },
      pillDot: { width: 7, height: 7, borderRadius: "50%", flex: "none" },
      pillBar: { width: 42, height: 5, borderRadius: 5, background: "var(--dsw-alias-border-l2)", overflow: "hidden", flex: "none" },
      usagePanel: {
        position: "absolute", bottom: "calc(100% + 10px)", right: 0, width: 300,
        display: "flex", flexDirection: "column", gap: 12, padding: 14,
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12,
        background: "var(--dsw-alias-bg-layer-1)", zIndex: 60,
        boxShadow: "0 12px 32px rgba(0,0,0,.28)",
      },
      panelTitle: { margin: 0, fontSize: 13, fontWeight: 700, color: "var(--dsw-alias-label-primary)" },
      panelBody: { display: "flex", flexDirection: "column", gap: 12 },
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
          win.resetsAt ? jsx("span", { style: css.meta, children: tp("usageResetsAt", formatTime(win.resetsAt)) }) : null,
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
        style: css.windows,
        children: windows.map((win) => jsx(UsageRow, { win }, win.id)),
      });
    }

    function UsageFooter({ usage }) {
      if (!usage || usage.status !== "available") return null;
      const meta = [
        usage.planLabel ? `${text("usagePlan")}: ${usage.planLabel}` : "",
        usage.sourceLabel ? `${text("usageSource")}: ${usage.sourceLabel}` : "",
      ].filter(Boolean).join(" · ");
      return jsxs("div", {
        style: css.usageFooter,
        children: [
          jsx("span", { children: usage.fetchedAt ? tp("usageUpdatedAt", formatTime(usage.fetchedAt)) : "" }),
          meta ? jsx("span", { children: meta }) : null,
        ],
      });
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

    /** One provider's block inside the Settings card. */
    function UsageSection({ provider, state }) {
      return jsxs("div", {
        style: css.windows,
        children: [
          jsxs("div", {
            style: css.row,
            children: [
              jsx("h4", { style: css.h3, children: text(PROVIDERS[provider].sectionKey) }),
              jsx(Button, {
                variant: "outline",
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
      const quotaProvider = quotaProviderOf(modelProvider) ?? "cursor";
      const covered = !directory || quotaProviderOf(modelProvider) !== null;
      const { usage, busy, error, load } = useUsage(
        (value) => Boolean(value) && value.mode !== "off",
        quotaProvider,
      );
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

      if (!usage || usage.mode === "off") return null;
      // auto: only while this session is on a covered model (no directory store = show it).
      if (usage.mode === "auto" && !covered) return null;

      const sectionKey = PROVIDERS[quotaProvider].sectionKey;
      const windows = usage.status === "available" ? usage.windows ?? [] : [];
      const preferred = quotaProvider === "copilot" ? "premium" : "total";
      const main =
        windows.find((win) => win.id === preferred) ??
        windows.find((win) => win.id === "auto") ??
        windows.find((win) => !win.unlimited) ??
        windows[0];
      const pct = main ? (main.unlimited ? 100 : Math.max(0, Math.min(100, Number(main.usedPct) || 0))) : 0;
      const color = toneColor(main?.tone);
      const winLine = (win) =>
        `${text(WIN_KEYS[win.id] ?? "winTotal")} ${win.unlimited ? text("usageUnlimited") : formatPct(win.usedPct)}`;
      const title = usage.status === "available"
        ? `${text(sectionKey)} · ${windows.map(winLine).join(" · ")}`
        : (usage.error ?? text(quotaProvider === "copilot" ? "usageNoCopilot" : "usageNoSignIn"));

      return jsxs("div", { style: css.pillWrap, ref: wrapRef, children: [
        jsx("button", {
          type: "button",
          style: { ...css.pill, ...(open ? { borderColor: "var(--dsw-alias-brand-primary)" } : {}) },
          title,
          "aria-expanded": open,
          onClick: () => setOpen((value) => !value),
          children: [
            jsx("span", { style: { ...css.pillDot, background: usage.status === "available" ? color : TONE_COLORS.danger } }),
            jsx("span", {
              style: css.pillBar,
              children: jsx("span", { style: { ...css.barFill, width: `${pct}%`, background: color } }),
            }),
            jsx("span", {
              children: usage.status !== "available"
                ? "—"
                : (main?.unlimited ? text("usageUnlimited") : formatPct(pct)),
            }),
          ],
        }),
        open
          ? jsxs("div", {
              style: css.usagePanel,
              children: [
                jsxs("div", {
                  style: css.usageFooter,
                  children: [
                    jsx("p", { style: css.panelTitle, children: text(sectionKey) }),
                    jsx(Button, {
                      variant: "outline",
                      disabled: busy,
                      onClick: () => { void load(true); },
                      children: text("refresh"),
                    }),
                  ],
                }),
                jsx("div", {
                  style: css.panelBody,
                  children: jsx(UsageBody, { usage, error, provider: quotaProvider }),
                }),
                jsx(UsageFooter, { usage }),
              ],
            })
          : null,
      ] });
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
              jsx("div", {
                style: css.sectionDivider,
                children: jsx(UsageSection, { provider: "copilot", state: copilotUsage }),
              }),
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
