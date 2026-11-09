# Handoff：长会话上下文压缩（context compaction）

> 写给接手的人（或下一个会话）。读完这一份应该能直接继续，不需要重新做研究。
> 更新：**2026-11-09 晚间**（acp-kernel 对齐 + 本地看板）。分支 `main`，工作区含未提交改动。

---

## 0. 一句话现状（2026-11-09 晚间）

- **M3 checkpoint 原地改写**、工具 `cursor_context_*`、SQLite ledger、`acp-kernel` 保护区与 §8 preflight **已接线**。
- **设置页**：`contextManagement` = `preserveRecentMessages` / `preserveRecentTokens` / `outputReserve` / `safetyMargin` / `preflightMaxAttempts`（**已无** `enabled` / `budgetTokens` / `keepTurns`）。
- **本地 acp 看板**：Settings → Cursor「上下文看板（acp）」、`/cursor-acp-panel`、`/cursor-context-fill`、`cursor_context_status`、API `GET /api/cursor-to-dsh/context/panel*`.
- **`GET` 宿主 API 路由必须带 `requestBody: "buffered"`**（DSH connection.fetch），否则 Settings 看板 400。
- **对话 pill**：`conversation.input.right` 上的 **上下文占用 %**（`GET /api/cursor-to-dsh/context/fill?sessionId=`，每轮 `runTurn` 更新）。
- **未做**：billion-context 全量管道（CCR/absorb/crush）、`acp_cache` 经济学进 panel、宿主 `/compact`→Cursor 同步、看板遥测进 billion-context 仪表盘。
- **已做（本批）**：compress handoff 集成测（`test/compress-handoff.integration.test.ts`）、context fill pill + `/cursor-context-fill`、legacy `contextManagement` 迁移、SQLite WAL/并行容错。
- **实测脚本**（2026-11-09）：`npm run live:context`（真 Cursor + compact 全接线）；`npm run smoke:web`（跑着的 `dsh web` API）。**fill pill 必须在 DSH Web 进程里完成至少一轮 Cursor 对话**才会非空（fill-cache 仅进程内；CLI 实测不写 DSH 内存）。

```bash
# 从 dsh web 启动 log 取 token
DSH_TOKEN=... npm run smoke:web
# 或 export CURSOR_API_KEY 后
npm run live:context
```

---

## 1. 项目背景

`/Users/yywl/Documents/workspace/cursor-to-dsh` 是 DSH（DeepSeek Harness）插件，
把 Cursor 注册为 `cursor` LLM provider 路由。**DSH 拥有 agent loop / 工具 / 权限，Cursor 只是模型。**

### 布局

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口（`name`/`inject`/`Config`/`apply`） |
| `src/adapter.ts` | `CursorAdapter extends LlmAdapter`：`stream`/`listModels`/`resolveModel` |
| `src/session.ts` | 每个 DSH session 一个持久 Cursor agent；增量发送；历史变了就换代 |
| `src/transcript.ts` / `src/reply.ts` / `src/prompt.ts` | DSH `GenerateOptions` → core transcript / `StreamChunk` 输出 / 渲染与指纹 |
| `src/usage.ts` | 不相交 bucket，省略 `totalTokens` |
| `src/models.ts` | Cursor 目录 → DSH 模型信息 |
| `src/keys.ts` / `src/ui-state.ts` / `src/host-api.ts` | 多 API-key profile / 设置页状态 / 认证 HTTP 端点 |
| `src/commands.ts` | 斜杠命令 `/cursor-key-*` |
| `client/factory.js` | 设置页浏览器 UI（**会被复制到 `lib/client.js`**） |
| `scripts/patch-cursor-sdk.mjs` | postinstall 给 `@cursor/sdk` 打 ESM 补丁 |

### 命令

```bash
npm run check        # tsc --noEmit
npm test             # 单测（fake Cursor agent）
npm run build        # tsc 出 lib/ + 复制 client/factory.js -> lib/client.js
npm run check:public # push / publish 前必跑
pnpm install         # pnpm 12；postinstall 打 @cursor/sdk 补丁
```

---

## 2. 已提交的 4 个 commit

```
a42beb0 feat(ui): live compaction settings on the Cursor settings page
f789b74 test: checkpoint PoCs behind the in-place rewrite
97c3d03 docs: RFC for long-session context adaptation
3db8683 feat(context): compact a Cursor session in place instead of rebuilding it
30fad55 Add generic DSH tool-discalance prompt for Cursor sessions.   ← 起点
```

| commit | 内容 |
|---|---|
| `97c3d03` | `docs/billion-context-adaptation-design.md` — RFC v1（17 节）。§1 结论、§3 checkpoint 改写三路径 M1/M2/M3、§15 composer-api 对照 |
| `3db8683` | `src/context/{checkpoint,compact,summarizer}.ts` + `test/context.test.ts` + `src/session.ts` 接线 |
| `f789b74` | `scripts/poc-*.ts` 系列 PoC 脚本 |
| `a42beb0` | `src/ui-state.ts` / `src/host-api.ts` / `src/index.ts` / `client/factory.js` 的设置页接线 |

**未提交**：acp 对齐 + 看板 + fill pill + 集成测等（`main` ahead of origin，见 `git status`）。

---

## 3. 核心技术结论（已验证，别再重查）

### 3.1 为什么不用"分代重建"而用 checkpoint 原地改写

Cursor SDK `@cursor/sdk` **1.3.1**（本仓库锁死版本）：

- `SDKAgent` 公开接口**只有** `agentId`/`model`/`send`/`close`/`reload`/`listArtifacts`/`downloadArtifact`/`getUsage`/`summarize`
  —— **没有任何 replace-history 方法**。
- 但**每次 `send()` 都从磁盘重载状态**：`dist/esm/index.js` 里
  `const i = await this.platform.checkpointStore.loadLatest(this.agentId)` → 作为 `initialState` 传给 `J.run(...)`。
  **agent 没有内存权威历史。**
- 每个请求都带全量 `conversationState`（`dist/esm/305.js`，用 `0 === t.turns.length` 判首轮）
  → **客户端权威，state 收缩 = 模型侧收缩。**
- checkpoint 是**内容寻址 blob 图**，root blob 是 `ConversationStateStructure` proto，含
  `turns: blobId[]`、`todos: blobId[]`、`summary: blobId?`；每个 turn 的 `userMessage`/`steps` 也是 blob 引用。
- **写入是公开 API**：`AgentCheckpointStore`（`dist/esm/run-store-public-types.d.ts:166-176`）
  = `loadLatest` / `saveCheckpoint` / `getBlobStore` / `getFullConversation`；
  `createAgentPlatform({ store, checkpointStore })` 可注入（`platform.d.ts:87`）。
  `saveCheckpoint` = `state.toBinary() → hash → setBlob → agents.update({ latestCheckpoint: { schemaVersion:1, rootBlobId } })`。
- **Cursor 自己的 `summarize()` 就走这条路** → 后端接受收缩后的 state 是既成事实。
  README 原文："Later sends give the model the summary instead of the full transcript"、
  "The agent also summarizes on its own when a conversation nears the model's context limit, on local and cloud agents alike"。

### 3.2 三条路径（RFC §3.2）

| | 做法 | 评价 |
|---|---|---|
| **M1** | 官方 `summarize()` | 零风险但内容不可控 → 仅作观测对照 |
| **M2** | `Agent.delete(id)` + `Agent.create({ agentId })` 同 id 重建 | 可行；**delete 会删 runs/run_events/checkpoints → usage 历史丢失，删前必须 `getUsage()` 快照**；同 id 重建前必须先删（否则抛 `Agent ... already exists`） |
| **M3** | run 之间改写 checkpoint：`loadLatest() → 过滤 state.turns → saveCheckpoint()` | **推荐主线**。同 agentId 原地收缩；**旧 blob 留在 content-addressed store = 免费原文账本**，正好对上 RFC §5.1/§9 |

**M3 零合成变体**：只做 `state.turns = state.turns.slice(-K)` 截断，摘要塞进下一条 user message
（正是 `src/prompt.ts` 首轮已做的事）→ **不需要构造任何新 proto**。

### 3.3 硬约束

- **只能 run 结束后改写**——run 期间改写会与 runner 的 `handleCheckpoint` 写入打架。
- 改写**不触碰 agent metadata**（`blobEncryptionKey` 存在 metadata 内部键里）。
- 读回校验是**必须的**：`loadLatest()` 后确认 `state.turns.length` 确实收缩了，否则视为失败并回退 M2。
- `AgentCheckpointStore` 的 d.ts 类型 `SdkConversationStateStructure`/`SdkConversationState`/`SdkBlobStore`
  **全是 `unknown`**（运行时才是 proto 实例）。proto 类兜底：`Object.getPrototypeOf(msg).constructor` 取 class。

---

## 4. 已落地的代码

### 4.1 `src/context/`（新建）

- **`compact.ts`** — 压缩编排与计划。
  - `planCompaction`（`:41-54`）：
    ```ts
    const keep = Math.max(1, Math.floor(input.keepTurns) || 1);
    const keepFrom = Math.max(0, input.messages.length - keep);
    if (keepFrom <= input.compactedAt) return undefined;
    const drop = Array.from(input.messages).slice(input.compactedAt, keepFrom);
    ```
    → `[0, compactedAt)` 绝不重碰、`[compactedAt, keepFrom)` 压掉、`[keepFrom, length)` 原文保留。
    **纯索引，零语义权重**（这正是用户在 m01612 问"压缩哪些不压缩哪些咋判断"的答案的一半）。
  - `runCompaction({ store, agentId, cwd, messages, compactedAt, keepTurns, previousSummary, summarize })`
    → `{ ok, keepFrom, summary, summaryTokens }` 或 `{ ok:false, reason }`。
  - 五种不压出口 + 读回校验错误串：
    - `no prompt ref held the compacted text`（`dropped.length === 0`）
    - `N dropped ref(s) survived the read-back`
    - `turns grew after the rewrite (pre -> post); a run wrote over it`
- **`checkpoint.ts`** — checkpoint blob 图读写。
  - `compactCheckpoint`（`:205-219`）：needle = `needlesFrom([...plan.drop.map(incrementText), input.previousSummary])`
    （`checkpoint.ts:74-86`，按 `\n` 切行、**每行 ≥16 字符**才留、去重），
    逐 ref 去 `~/.cursor/projects/<slug>/sdk-agent-store/store.db` 读 payload，
    `payloadHoldsNeedle` 子串命中 → 删，未命中 → **保守保留**。
  - store 路径：`~/.cursor/projects/<slug>/sdk-agent-store/store.db`
- **`summarizer.ts`** — 摘要调用。`SUMMARY_PREFIX` 已导出。
  **注意**：`purpose: 'compaction' | 'session-title'` 是 DSH 保留值，我们的 adapter 不得借用（见 §6）。

### 4.2 `src/session.ts`（改造）

- `import { runCompaction } from "./context/compact.ts";`（L38）
- `import type { ContextManagementConfig } from "./ui-state.ts";`
- **`CompactDeps`**（现形）：
  ```ts
  { store: CheckpointStoreLike; settings: () => ContextManagementConfig; summarize: (history, opts?) => Promise<string>; }
  ```
  （原 `budgetTokens`/`keepTurns` 两个字段已删，改成每轮 `settings()` 读，**所以设置页改完立刻生效，不用重启**）
- `maybeCompact`：`const cfg = deps.settings(); if (!cfg.enabled) return "";` →
  `if (retained <= cfg.budgetTokens) return "";` → `keepTurns: cfg.keepTurns`
- `s.compactedAt` / `s.summary` / `s.summaryTokens`（L82 `compactedAt = 0`；L414 `s.compactedAt = outcome.keepFrom;`）
- **`sessionKeyFor`**（L271-273）：
  ```ts
  if (!purpose && typeof sessionId === "string" && sessionId) return sessionId;
  return ANON_PREFIX + hash(`${purpose ?? ""}\n${t.systemPrompt}\n${t.messages.length ? fingerprint(t.messages[0]) : ""}`);
  ```
  → **辅助调用（标题、压缩）带了 session id 但不碰 agent**（L270 注释）。
- `plan()`（L220-242）判 `fresh` 的条件（任一成立就换代）：
  `!s || s.closed || !s.sentFirst || messages.length <= s.seen.length`、
  **`s.seen.some((fp, i) => fingerprint(messages[i]) !== fp)`**、
  `s.runDone`、`!call || results.some(...)`、`results.length !== handed.length`、
  `!steering.every(sendable)`、L242 `!s.runDone || s.pending.length || !added.every(sendable)`
- L390 token 估算：`estimateTranscript(t.systemPrompt, t.tools, t.messages.slice(s.compactedAt))`
- L460-466 plan 失败降级 `if (addition === undefined) plan = { kind: "fresh" };`

### 4.3 设置页（`a42beb0`）

- **`src/ui-state.ts`**
  - `CursorUiConfig` 加 `contextManagement?: Partial<ContextManagementConfig> | { get?: () => … }`
  - **`ContextManagementConfig` 接口 + `CONTEXT_DEFAULTS` 定义在这里**
    （`{ enabled:false, summarizerProvider:"", summarizerModel:"", budgetTokens:180_000, keepTurns:1 }`）
    —— 因为 `index.ts → host-api.ts → ui-state.ts` 成环，`index.ts` 只 re-export。
  - `Overlay.contextManagement` + `applyOverlay`/`resetOverlay`
  - **`readContextManagement(config: unknown)`** —— 参数类型**特意是 `unknown`**：
    `index.ts` 的 `Config` 带 `Volatile<>` 包装，不满足 `CursorUiConfig`
    （首跑报 `error TS2345: Argument of type 'Config' is not assignable to parameter of type 'CursorUiConfig' … Volatile<ApiKeyProfile[]>`）
  - `setContextManagement(ctx, config, patch)` —— 校验
    `budgetTokens must be a positive number of tokens` / `keepTurns must be at least 1` → `persistConfig`
  - `uiSnapshot` 返回 `contextManagement: readContextManagement(config)`
- **`src/host-api.ts`**
  - 新增 **`POST /api/cursor-to-dsh/context`**：body 逐字段 `Boolean/String/Number` 归一成 patch
    → `setContextManagement(...)` → **必须返回完整 `uiSnapshot(...)`**（前端 `run()` 会 `setStatus(next)`）
- **`src/index.ts`**
  - `export type { ContextManagementConfig } from "./ui-state.ts";`
  - `const management = () => readContextManagement(config);`（**getter，实时**）
  - **`const compact: CompactDeps = { store: checkpointStore, settings: management, summarize: summarise };`**
    —— 常驻接线，`enabled` 每轮判断
- **`client/factory.js`**（967 行 → 更多）
  - EN locale `const EN` 在 **line 21-87**，ZH `const ZH` 在 **line 88-153**（同键序）
  - 新增 17 个 key（两表都要加）：
    `ctxTitle / ctxHint / ctxEnabled / ctxOn / ctxOff / ctxEnabledHint / ctxModelHint /
     ctxProvider / ctxProviderPlaceholder / ctxModel / ctxModelPlaceholder /
     ctxBudget / ctxBudgetHint / ctxKeep / ctxKeepHint / ctxApply / ctxApplied`
  - 新组件 **`ContextCard({ initial, onSaved })`**，插在 `function CursorSettings() {` 之前；
    挂载点在 `jsx(CopilotAuthCard, {}),` 之后：
    `jsx(ContextCard, { initial: status?.contextManagement, onSaved: (next) => { if (next) setStatus(next); } })`
  - 复用的样式 key：`card`(205) `h3`(206) `hint`(207) `row`(208) `actions`(210)
    `field`(214) `label`(215) `error`(216) `modeRow`(247) `sectionDivider`(248)
  - `Input` 透传到 `<input>`，**`type:"number"` 可用**；onChange 取 `event?.target?.value ?? ""`
  - `jsx`/`jsxs` 从顶部 import；组件用 `function X(props) {}` 声明

### 4.4 一个隐蔽的坑：`.volatile()`

`dsh-settings` 的 `write()` 会走 `isVolatilePath`（`schema.js:78`），
**只有 schema 节点上有 `meta.volatile` 才会跳过持久化**，
否则保存设置时会报 **`Config field "contextManagement" is not volatile`**。

修法：在 `src/index.ts` 的 `contextManagement` object 节点 `.description(...)` 之后加 **`.volatile()`**。
（`volatileForm` / `isVolatilePath` 遇到 `meta.volatile` 时对**整个子树**生效。）
`lib/index.js` 现在有 **5 个 `volatile()`**（修之前 4 个）。

> 已经踩过一次并修好了，但如果以后**新增**设置字段，记得同样加 `.volatile()`。

---

## 5. 验证状态（全部通过）

```bash
npm run check        # 干净
npm test             # 92/92 pass
npm run build        # copied client/factory.js -> lib/client.js
npm run check:public # ok (54 files, 4 rules)
node --check lib/client.js   # SYNTAX OK
```

### 真机 PoC（唯一一票否决项，已 PASS）

**`scripts/poc-e2e.ts`** —— 用**生产代码路径** `runCompaction` 打真 store + 真模型：

```bash
CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-e2e.ts
# 可选第二个参数指定模型，默认 claude-haiku-5-5
```

结果（第二轮）：

```
seed: finished
PASS control remembers — E2E-3E22N6ZM
tail: finished OK
PASS runCompaction — keepFrom=5 summary=92 chars
PASS checkpoint shrunk — turns=1
probe: finished 在当前对话中，您没有给过我任何代码词…
PASS model forgot
=== RESULT: PASS ===
```

**踩过的坑（重要）**：第一轮 FAIL，因为 messages 数组**漏了 assistant 消息**
（只放了 `[user seed, assistant "OK", user control, user tail]`）。
模型会把 secret 复述进自己的回复，那条回复是**独立的 prompt ref**，不在 drop 集合里 → 没压掉 → 模型还看得到。
**构造 DSH transcript 测试数据必须含 assistant 消息**（真实 DSH transcript 一定含，见 `fingerprint` 处理 `role==="assistant"`、`session.ts:420` 注释 "including its own replies"）。修复后 `keepFrom` 从 2 变 5。

### 其它 PoC 脚本

- `scripts/poc-checkpoint.ts` — M3 三段验证（只截断 `state.turns` → `saveCheckpoint` → 下轮 `send()` 问"我第一条消息说了什么"）
- `scripts/poc-m3b.ts` — 变体
- `scripts/poc-store-compat.ts` — 证明**静态 `Agent.create` 与 `createAgentPlatform()` 用同一个 store**
  → 接线不必改建 agent 的路径（结论：v2 两路 `HIT turns=1`）
- `scripts/live.ts` — 真 Cursor 冒烟（`CURSOR_API_KEY=... node --experimental-strip-types scripts/live.ts`）

---

## 6. 正在解决的问题：DSH 自己的 compaction 系统

### 6.1 用户的质疑

**User said (m01731): "感觉还是很成问题啊...模型不能主动压缩的话 ."**

目前实现是**预算触发**（`budgetTokens` / `keepTurns`），不是模型主动触发。

### 6.2 已查明的 DSH 内部机制（别重查）

**DSH 有一等公民的 compaction 系统**，事件挂在 cordis 事件总线上：

`SessionEventMap` 四个事件（类型声明内嵌在
`node_modules/@deepseek-ai/dsh-commands/lib/typert.host.js`，也见
`.pnpm/@deepseek-ai+dsh-session@0.2.0-rc.2_*/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:255`）：

```ts
'compaction/start':   { compactionId; sourceCommandId?; turn: number | null };
'compaction/summary': { compactionId; sourceCommandId?; summary: ContentBlock[];
                        shadowedRange: { start: SessionSeq; end: SessionSeq };
                        shadowedSeqs: SessionSeq[]; shadowedTokenCount: number;
                        provider: string; model: string; maxTokens?: number; usage?: TokenUsage }
                      & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: never; llmStreamCall?: never });
'compaction/end':     { compactionId; sourceCommandId?; turn: number | null; error?: string };
'compaction/prune':   { shadowedRange; shadowedSeqs; shadowedTokenCount };
```

另有 `MessageSourceMap` 的 `'compact-checkpoint': CompactionCheckpointSource`
（`CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & { readonly compactionId: CompactionId; readonly sourceCommandId?: CommandId }`），
以及 `SessionReferenceSource` 含 `compacted: boolean; originalMessages; retainedMessages; omittedMessages; omittedBytes; truncated`。

**关键：插件可以订阅** —— `dsh-session/lib/types/index.d.ts` 模块头注释：

> "Event-sourced session service: append-only session log, in-memory store, and the derived LLM message history.
> **Persistence is a plugin concern (subscribe to `session/event`, drain on `session/flush`).**"

同文件 `declare module '@deepseek-ai/cordis'`：

```ts
interface Context { sessions: SessionStore; }
interface Events {
  'session/created'(this: Scoped<Session>, session: Session): void;
  'session/disposed'(this: Scoped<Session>, session: Session): void;
  'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
  'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void;
}
```

`@mode`：`event` = `emit`（"Post-commit, fire-and-forget append feed… observer failures are logged and contained
without making the committed append fail."）、`flush` = `parallel`。
全部带 Scope-filtered dispatch 说明（agent-scoped listener 只收到该 agent 的 session）。

→ **可行做法**：
```ts
ctx.on("session/event", (session, event) => {
  if (event.type === "compaction/summary" || event.type === "compaction/prune") { /* 同步收缩 Cursor 侧 */ }
});
```

**cordis 事件总线**（`node_modules/@deepseek-ai/cordis/lib/types/events.d.ts`）：
`:88 on<K extends keyof Events>(name, listener, options?): () => boolean`、`:97 once(...)`、
`:216 export interface Events {`（cordis 自带只有 9 个 `internal/*` 事件）、
`export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'`。
`context.d.ts:24` 注释确认方法混在 `ctx` 上：**`ctx.on` / `ctx.emit` / `ctx.parallel` / `ctx.serial` / `ctx.bail` / `ctx.waterfall`**。

各 dsh-* 包靠 `declare module '@deepseek-ai/cordis' { interface Events {…} }` 增量注册，
命中：`dsh-client-connection/lib/types/index.d.ts:15-16`、`dsh-commands/lib/types/index.d.ts:63`
与 `dsh-commands/lib/types/types.d.ts:78-79`、`dsh-credentials/lib/types/index.d.ts:98`、
`dsh-launch-environment/lib/types/index.d.ts:75`、`dsh-llm/lib/types/index.d.ts:28,32`、
`dsh-settings/lib/types/index.d.ts:24`、**`dsh-session/lib/types/index.d.ts:26,30`**。

**DSH 的压缩摘要器走 `ctx.llm`**：
`dsh-llm/lib/types/types.d.ts:544-547`
```ts
purpose?: 'compaction' | 'session-title';
// Provider-neutral classification for an auxiliary model call. Adapters may map the purpose to
// model-hidden transport metadata. Ordinary conversation requests leave it unset.
```
`dsh-llm/README.md:30`："Any composition that calls a model provider — an agent loop, a session-title
generator, a compaction summarizer — streams its requests through this service."

→ **DSH 压缩时会以 `purpose: "compaction"` 打到我们的 adapter**
（我们的 `src/context/summarizer.ts` 已注明这两个 purpose 是保留值，adapter 不得借用；
`sessionKeyFor` 也已经用 `purpose` 把这类调用隔离成 `ANON_PREFIX` key）。

### 6.3 已查清（2026-11-09 续）

1. **DSH 触发入口**：`deepseek-ai/deepseek-harness` → `packages/compaction/command-compact`，斜杠 **`/compact`**（无参数）调 `ctx.compaction.compactNow()`。自动压力/溢出走 `compactIfNeeded`。详见宿主 `docs/subsystems/compaction.md`。
2. **`session/event` 订阅**：`src/index.ts` → `registerHostCompaction(ctx, …)`，用 `ctx.on("session/event", …)` 宽松类型，无需 `dsh-session` peerDep。
3. **Cursor 侧同步**：`compaction/summary` 缓存摘要 + `shadowedSeqs`；`compaction/end`（无 `error`）→ `syncCursorAfterHostCompaction` → `runHostCompaction`（复用 DSH 摘要，不调 summariser）。

### 6.4 新增实现（未单独 commit）

| 文件 | 职责 |
|---|---|
| `src/host-compaction.ts` | `registerHostCompaction`；`summaryFromBlocks` / `needlesFromShadowed` / `syncCursorAfterHostCompaction` |
| `src/context/compact.ts` | `runHostCompaction` + 共享 `applyCompactionRewrite` |
| `src/session.ts` | `liveCursorSessions`；`summaryPending` 下轮 incremental 前置 `SUMMARY_PREFIX` |
| `test/host-compaction.test.ts` | 单元测试 |

**行为要点**：仅 `provider === "cursor"`；仅 idle session（`runDone && !busy`）；不依赖 `contextManagement.enabled`；`compaction/prune` 暂无单独路径。

### 6.5 本地其它线索（已走不通，别重复）

- `/usr/local/bin/dsh` → `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
  （**DSH 桌面应用确实装在本机**）。`dsh --help` 只有 `--profile`/`--patch`/`--dump-config*` 等，
  **没有子命令列出 `/compact`**。
- `npx asar extract …/app.asar …` **崩溃**（输出 `}` + `Node.js v24.22.1`，未生成目录）
  → asar 路线放弃，走 GitHub。
- `grep -rln "compaction/prune" node_modules/@deepseek-ai/` → **空**（只有类型声明，无实现）。
- GitHub 无 token：`search/code` → 401 `Requires authentication`；只能用公开 repo API 与 raw 文件。
- zsh 下 `grep --include=*.d.ts` **不加引号**会报 `no matches found: --include=*.d.ts`（glob 被展开），必须加引号。

---

## 7. Open objectives（仍未完成）

1. **实现长会话上下文压缩功能，含总开关与可自选（含非 Cursor）的压缩模型**
   （User said m00692、m00720）
   —— 总开关 + `summarizerProvider`/`summarizerModel` 设置页已做；
   **"可自选非 Cursor 模型"这条还没真正验证**（设置字段在，`summarise()` 是否真按 provider 分流要查 `src/index.ts` 的 `summarise` 实现）。
2. **回答"模型不能主动压缩"**（User said m01731）—— 代码已接（§6.4）；**待真机**：DSH 会话跑 `/compact` 后确认 Cursor 侧遗忘 + 下轮 incremental 不 fresh。
3. **给出 M3/M2 是否成立的结论**（User said m00336）
   —— PoC 已 PASS（§5），**待复跑 + 长对话验证**。

---

## 8. 参考文档

- **`docs/billion-context-adaptation-design.md`** —— RFC v1（17 节，398 行）
  §1 结论 / §2 参考依据 / §3 **checkpoint 改写三路径 M1·M2·M3** / §4 结构图 / §5 三份状态 /
  §6 工具设计 / §7 压缩生效与 handoff / §8 压缩策略与窗口预算 / §9 原文离线检索持久化 /
  §10 与 DSH compaction 及现成 bili 的关系 / §11 usage 可观测性 / §12 文件改动建议 /
  §13 实施阶段 P0–P3 / §14 必须通过的测试 / **§15 对照实现 composer-api** / §16 许可证 / §17 推荐决策
- **composer-api 对照结论**（`standardagents/composer-api`，349 stars，MIT）：
  它用 `"@cursor/sdk": "^1.0.13"`（**比本仓库 1.3.1 旧且用 `^` 浮动**）却"没那么多问题"，
  是因为它**不需要**：OpenAI 边界无状态、客户端每请求重发全量历史、agent 只是可随时丢弃的 session 亲和缓存
  （冷启动全量重放 = 天然分代重建）、完全不管上下文（交给 Cursor 自建自动摘要）、
  压缩是独立一次性端点产出纯文本、容忍历史分叉、token 靠字符数估算。
  **反向启发：不能照抄它，否则退回"假压缩"。**
  **正向启发：它的容错工程值得搬**——可重试错误淘汰重建（429/503/8/14 + message 关键词，最多 3 次退避）、
  180s 超时、per-agent 串行队列、tool call 立即 cancel + `local.force` 解卡、128 agent LRU、6h TTL。

---

## 9. 快速上手顺序

1. 读 `docs/billion-context-adaptation-design.md` §3（checkpoint 改写）和 §17（推荐决策）。
2. 读 `src/context/compact.ts` 和 `src/context/checkpoint.ts`（核心机制）。
3. 读 `src/session.ts` 的 `plan()` / `maybeCompact` / `sessionKeyFor`（接线点）。
4. **接着 §6.3 查 `deepseek-ai/deepseek-harness` 源码**，确认：
   ① 有没有 `/compact` 触发入口 ② 怎么订阅 `session/event` ③ DSH 压缩后 Cursor 侧怎么同步。
5. 跑 `npm run check && npm test` 确认基线还是绿的（应该是 86/86）。
