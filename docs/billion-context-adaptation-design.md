# cursor-to-dsh 长会话上下文适配技术方案（RFC v1）

状态：设计提案，尚未实现。目标是类似 billion-context 的长会话能力，不是把模型物理窗口扩大到十亿 token。

## 1. 结论

建议采用 **acp-kernel 内嵌 + 本地原文账本 + 压缩视图 + Cursor checkpoint 原地改写（分代重建兜底）**。

- DSH 继续拥有 agent loop、工具执行和权限；本插件只管理 `cursor` 路由实际送给模型的上下文。
- 普通轮次沿用现在的增量发送和持久 Cursor agent。
- 压缩、持久展开或历史编辑改变模型可见前缀时，优先在 run 之间改写该 agent 的 checkpoint 使 `turns` 收缩；改写路径不可用或读回校验失败时，回退到创建新一代 Cursor agent，从压缩视图启动。
- 原文独立保存，摘要采用 T1/T2/T3 分层，可搜索和按需读取原文。
- 不代理 Cursor 私有协议，不新增 SDK minified patch（checkpoint 改写只用公开的 `AgentCheckpointStore` 接口），不伪报十亿 token 的 `contextWindow`。
- 与 <https://github.com/standardagents/composer-api> 的差异见 §15：它用同一套 SDK 却没有本方案的困扰，因为它在 API 边界无状态、agent 只是可丢弃的缓存；本方案的需求更强，不能照抄它"不管理上下文"的做法。

**能实现的是累计处理超长历史，同时把活跃上下文约束在实际模型窗口内。** 不能承诺任意远期细节自动无损记忆，也不能直接承诺上游项目宣传的 5 倍节省或 95–97% 缓存命中率。

## 2. 参考依据与现状

参考仓库：<https://github.com/ranxianglei/billion-context>

本方案检查的源码快照：`848f59b9963f293b8beac5b95bb861a7dcf25a0c`。该快照的 `kernel/package.json` 声明 `acp-kernel` 为 `0.0.188`；这不是建议直接安装该版本，正式接入必须核验 npm 发布包与选定版本的 API、许可证和测试。

重点参考：

- `kernel/src/compress.ts`：`createCore`、`processTurn`、`applyCompression`；内核不调用模型，摘要必须由外部模型提供。
- `kernel/src/types.ts`：稳定消息引用、压缩块、T1/T2/T3 和覆盖关系。
- `kernel/src/ccr.ts`、`content-store.ts`：大结果原文离线保存及按引用取回。
- `kernel/src/protected.ts`、`turn-integrity.ts`：保护近期内容及工具调用/结果的完整性。
- `src/preflight.ts`：窗口超限前的兜底压缩。它包含代理协议及请求依赖，不能把它当纯内核 API 直接搬入本项目。
- `src/agent/dsh-native.ts`：通过 DSH 原生工具服务注册上下文工具，用执行上下文的 `agent.session.id` 绑定会话。
- `LICENSE`：MIT 正文之外存在产品出处标注条款，包括使用 acp-kernel 的情况。

本项目已有基础：

| 文件 | 当前行为 | 对适配的意义 |
|---|---|---|
| `src/adapter.ts` | 每次接收 DSH 全部派生历史，转换后调用 `runTurn` | 增加上下文账本同步及视图准备入口 |
| `src/transcript.ts` | DSH 消息转 core transcript | 增加稳定身份及 acp-kernel 投影，不能直接把现有结构当 `CoreMessage` |
| `src/session.ts` | 持久 agent、增量发送、等待 DSH 工具结果；历史变化则 fresh | 可扩展为显式 generation 切换 |
| `src/prompt.ts` | 首轮将系统提示和历史渲染为一段文本 | 在渲染边界加入稳定引用、摘要来源标记 |
| `src/usage.ts` | 区分累计 run usage 与估算 context fill | 需加入代际切换、压缩 sidecar 的独立账目 |
| `src/models.ts` | 模型窗口选择及参数拒绝后降档 | 压缩预算必须使用真正生效的档位 |
| `test/session.test.ts` | fake Cursor、完整 stream/handoff 测试 | 作为主要回归入口 |

## 3. 最大障碍：不能只压缩传入消息

现在 Cursor 会记住 `agent.send()` 的所有历史，后续 DSH 请求只补增量。假设 DSH 历史从 A+B+C 变成摘要 S+C，但继续使用旧 agent，并发送 S，旧 agent 实际持有的是 A+B+C+S。这不是压缩，甚至增加开销。

因此：

> 压缩状态提交 ≠ Cursor 上下文已收缩。必须在模型可见前缀改变后确认 Cursor 侧真正收缩，才能认定生效。

### 3.1 SDK 结论：没有 replace-history，但 checkpoint 可写

锁定的 SDK `1.3.1` 在公开 `SDKAgent` 接口（`dist/esm/agent.d.ts`）中只有 `send` / `close` / `reload` / `listArtifacts` / `downloadArtifact` / `getUsage` / `summarize`，确实**没有**可指定消息范围和自定义摘要的 replace-history 接口。但源码检查确认了另一条路：

1. **每次 send 都从磁盘重载状态。** `dist/esm/index.js` 的 run 路径：`const i = await this.platform.checkpointStore.loadLatest(this.agentId), a = i instanceof Gt.Y9z ? i : new Gt.Y9z({})` … `k = await J.run(t, { ..., initialState: a, blobStore: g, ... })`。agent 没有内存权威历史，`initialState` 每次来自 checkpoint store。
2. **每个请求带全量 conversation state。** `dist/esm/305.js`：`new qr.Mpn({ conversationState: t, action: ..., ... })`，并用 `0 === t.turns.length` 判断首轮 → 客户端权威，state 收缩即模型侧收缩。
3. **checkpoint 是内容寻址 blob 图。** root blob = `ConversationStateStructure` proto，含 `turns: blobId[]`、`todos: blobId[]`、`summary: blobId?`；每个 turn blob 的 `agentConversationTurn` 值里 `userMessage` 是 blob、`steps` 是 blobId 数组；读回走 `getFullConversation()`（逐 turn 反序列化并保留 `summary`）。
4. **写入路径是公开接口。** `dist/esm/run-store-public-types.d.ts` 的 `AgentCheckpointStore { loadLatest, saveCheckpoint, getBlobStore, getFullConversation, deleteAgent? }`，`createAgentPlatform({ checkpointStore })` 可注入；`saveCheckpoint` 实现 = `state.toBinary() → hash → setBlob → agents.update({ latestCheckpoint: { schemaVersion: 1, rootBlobId } })`。
5. **Cursor 自己就是这么压缩的。** `summarize()` = `sendImpl({ summarize: true })`；README 明言 "Later sends give the model the summary instead of the full transcript"，且 **"The agent also summarizes on its own when a conversation nears the model's context limit, on local and cloud agents alike"** → 后端接受收缩后的 state 是既成事实。这是本方案最大的未知数，已被 SDK 自身行为证明。
6. d.ts 层 `SdkConversationStateStructure = unknown`，运行时是 proto 实例；`Object.getPrototypeOf(msg).constructor` 可取到 class（`.create()` / `.toBinary()`），blobId 格式可从 `saveCheckpoint` 前后对比逆推（`nj(Bk(bytes))`，`k()` 有前缀归一化）。

### 3.2 三条落地路径

| | 做法 | 优点 | 代价 |
|---|---|---|---|
| M1 官方摘要 | 调 `summarize()` | 零风险，后端已验证 | 内容与范围不可控，无法实现 T1/T2/T3 与原文账本 |
| M2 分代重建 | `Agent.delete(id)` + `Agent.create({ agentId })` 同 id 重建（本地 `createAgent` 对已存在 id 抛 `Agent ... already exists`，必须先删） | 纯公开 API；`src/prompt.ts` 首轮渲染现成就是"压缩视图当首条消息" | 硬重置；`delete` 会删 runs / run_events / checkpoints → **usage 历史丢失，删前必须 `getUsage()` 快照** |
| M3 checkpoint 改写 | run 之间 `loadLatest()` → 过滤 `state.turns` → `saveCheckpoint()` | 同一 agentId 原地收缩，`src/session.ts` 换代逻辑大幅简化；旧 blob 留在 content-addressed store 里 = 免费原文账本（对上 §5.1 / §9） | 合成 summary turn 需拿到 proto 类；需 PoC 后端是否校验 requestId 链 |

**推荐主线是 M3，M2 作为 fallback，M1 只作观测对照。** M3 还有一个**零合成变体**：只做过滤截断（`state.turns = state.turns.slice(-K)`），摘要不进 checkpoint，而是塞进下一条 user message —— 这正是 `src/prompt.ts` 首轮已经在做的事。这样不需要构造任何新 proto，就能得到 §4 / §5 的语义：`turns` 只留近尾部，下一条 send 携带 T1 摘要与近况。

### 3.3 仍然成立的约束

- **只能在 run 结束后改写**：活动中改写会与 runner 的 `handleCheckpoint` 写入打架（`onCheckpoint` 每次都会覆盖 `latestRootBlobId`）。所以"停旧 run"仍然必要，只是不必"停旧 run → 建新 agent"这么重。
- 改写不触碰 agent metadata（`blobEncryptionKey` 存在 metadata 内部键里），因此不破坏后续读取。
- `summarize()` 仅支持本地 agent、all-or-nothing、活动 run 期间不能调用；README 明言失败时 "later sends still see the full conversation"。仍需观察 SDK `summary` 事件，记录 Cursor 内部摘要及退化信号，避免错误地把 DSH 原文长度当成 Cursor 实际驻留长度。
- MVP 不依赖 Cursor 原生摘要实现 ACP 语义：M1 内容不可控，本方案仍需自己的 T1/T2/T3 与原文账本。

## 4. 总体结构

```text
DSH agent loop / 原始会话历史 / 权限
    │ GenerateOptions
    ▼
CursorAdapter.stream
    │
    ├─ ContextManager
    │    ├─ CanonicalLedger：原文、身份、分支、工具结果
    │    ├─ acp-kernel：引用、覆盖关系、分层压缩、推荐
    │    ├─ ContextStore：原文 blob + block/state 持久化
    │    ├─ BudgetGuard：窗口与输出余量
    │    └─ ViewRenderer：摘要 + 未压缩内容 + 当前任务
    │
    ▼
runTurn(rawIdentity, modelView, viewRevision)
    ├─ 同一代且前缀一致：send 增量 / handoff 结果
    └─ 前缀改变：安全停止旧 run → 收缩 Cursor 侧历史 → 发送 modelView
         ├─ 首选：checkpoint 原地改写（§3.2 M3），同 agentId 继续
         └─ 回退：checkpoint 改写不可用/读回校验失败 → 新 agent（M2）
    │
    ▼
Cursor SDK（tools: ["mcp"]）
    │ 工具调用
    ▼
DSH tools.execute → 真实结果 → 下一次 stream
```

上下文工具也通过 DSH 注册和执行，不在 Cursor `execute` 中偷偷消费。不把维护压缩变成第二个通用 agent loop；后台 summarizer 只能生成摘要，禁用全部副作用工具。

## 5. 三份状态必须分离

### 5.1 CanonicalLedger：原文账本

只追加，保存原始消息和附件引用，不覆盖用户会话。历史编辑、回退或宿主摘要建立新的 lineage/revision，旧分支保留为只读存档。

稳定身份规则：

1. 有宿主稳定 message ID 时优先使用，但仍校验内容版本。
2. 当前转换流程没有保留 message ID，需在适配层增加 identity sidecar；若宿主没有可用 ID，则用 lineage、首次入库 seq、内容版本确定身份。
3. 重复文本不能仅靠内容 hash 去重；用位置/前驱关系区分不同出现。
4. 指纹必须覆盖角色、工具名、call ID、规范化参数、错误状态及附件身份。现有 `fingerprint()` 忽略图片身份等信息，不宜直接充当持久身份。
5. 同一 assistant 内的正文及多个 tool-call 投影成多个 `CoreMessage` 时，必须保留 parent/unit 映射，避免拆开一个工具执行单元。

### 5.2 CompressionState：摘要状态

包含内核状态、引用映射、原文索引、lineage、revision 和待应用的压缩变更。摘要块保留原文覆盖关系及下级块链接。

摘要文字不是新的系统指令。即使内核输出摘要 carrier 为 `system`，转回本项目时也应作为带明确来源标记的历史/记忆内容，而不是拼进真实 DSH system prompt。检索原文同样保持不可信历史数据属性。

### 5.3 CursorGeneration：当前模型驻留状态

至少记录：

- `generation`、`appliedViewRevision`；
- raw history 的已消费位置及身份；
- 本代真正发送的视图及增量链；
- pending tool calls、已交付结果及取消状态；
- 原始 usage 样本、驻留预算锚点和内部 summary 事件；
- checkpoint 侧的 `rootBlobId`、改写前后 `state.turns.length`，以及"改写是否被下一次 send 实际采用"的验证结果。checkpoint 改写成功但模型仍看到旧前缀时，本代状态必须标记为失效而不是继续沿用。

现有 `s.seen` 不能同时代表原文链和压缩后的模型链。压缩视图的消息数量与原文数量不同，后续必须以 raw cursor 判断 DSH 增量，再对照本代 model view 判断是否可继续。

## 6. 工具设计

建议使用路由专属名称，避免与现成 billion-context 插件冲突：

| 工具 | 作用 |
|---|---|
| `cursor_context_compress` | 按稳定引用范围提交模型写出的摘要；支持 topic，校验当前视图及范围 |
| `cursor_context_decompress` | 默认分页返回原文，而非永久展开整个窗口；后续再支持有 TTL 的窗口展开 |
| `cursor_context_search` | 搜索可见内容、摘要和原文索引，返回引用及有限片段 |
| `cursor_context_status` | 展示真实窗口、活跃估算、累计历史、块、可压缩范围、待切换状态 |

所有工具绑定 `exec.agent.session.id` 及宿主/profile namespace，不允许模型通过参数指定任意他人 session。没有可靠会话身份时，禁用持久压缩写入，匿名 one-shot 只做独立预算处理。

工具存在不等于所有模型路由都能使用：非 Cursor 会话调用时应明确拒绝；必要时通过宿主正式的工具可见性机制限定范围。工具参数、返回结构及版本冲突需通过 DSH 实测。

`compress` 一般由当前模型产生摘要；建议保留：用户目标及修改、约束、重要路径/符号、决策和理由、关键报错、已执行动作及测试结果、未完成项、原文引用。引用可追溯不代表摘要不会丢语义。

## 7. 压缩生效与工具 handoff

### 7.1 普通路径

1. 同步新原文与真实工具结果到 ledger。
2. 没有压缩视图变化时沿用原 generation。
3. 新用户/developer 消息增量发送；工具结果仍通过现有 `PendingCall.resolve` 交给 Cursor。

### 7.2 模型主动压缩路径

```text
模型请求 cursor_context_compress
→ 插件按现有机制将调用交给 DSH
→ DSH 执行上下文工具，校验并持久化新摘要/revision
→ 下一次 stream 收齐这批工具结果并入库
→ 识别 desiredRevision != appliedViewRevision
→ 安全停止旧 run（不先 resolve 后让它继续生成）
→ 收缩 Cursor 侧历史：首选 checkpoint 原地改写（读回校验通过）
   └─ 改写不可用/校验失败 → 从压缩视图及完整已完成结果启动新 agent
→ 继续任务，正常向 DSH 输出
```

关键约束：

- 未完成工具调用及本轮结果不能被压缩；并行调用/结果作为完整单元保护。
- compress 与业务工具同批出现时，等待整批结果到齐再切换；实际执行过的写文件/命令不能重新发给 DSH 执行。
- 若宿主未给全结果，保持 pending 状态，不猜测结果，不提前换代。
- cancel 必须确认旧 run 不再生成；确认失败应终止本次调用，而不是启动并行新 run。
- 取消产生的占位结果不能污染真实 ledger；已知业务结果以 DSH 提供的数据为准。
- 已流出的 assistant 文本保持唯一；重建提示标明已完成动作并从 handoff 点继续，不能重复输出前半段。
- `applyCompression` 及结果渲染应基于同一 canonical view，防止推荐范围能看到、执行时却不能定位。
- desired revision、已持久摘要及 applied generation 分开记录。新 agent 启动失败可再次使用已提交摘要，不重新执行业务工具，也不误报压缩已在模型侧生效。
- checkpoint 改写（M3）成功后必须 `loadLatest()` 读回验证：`state.turns.length` 确已收缩、压缩视图首条消息可见。读回不收缩一律视为失败并回退 M2，不得继续宣称已压缩。
- ContextManager 每会话串行化状态变更；锁不能覆盖等待 DSH 工具执行的整个过程，否则会与上下文工具死锁。工具事务只短暂锁定 revision，下一次 stream 执行 generation 切换。

## 8. 压缩策略与窗口预算

### 8.1 两条控制线

- 软控制：基于增长量和当前压力提示模型压缩。初始建议以真实窗口比例缩放，例如增长量约 `min(30K, 0.15W)`；这是本方案调参起点，不是上游默认值。
- 硬控制：每次启动/send/交付工具结果前做预算检查；超限时执行有限次数 preflight summarization，不能只等模型自己调用 compress。

```text
effectiveWindow = 实际生效的模型/context 档位
inputBudget = effectiveWindow - outputReserve - safetyMargin
estimatedResident = renderedInput + toolSchemas + cursorOverhead
                    + imageAllowance + 本代未切换的增量/提示开销
```

预算必须包含首轮工具纪律提示、渲染标签及包装。当前 `estimateTranscript()` 不是精确 tokenizer，并且 assistant 的部分内容可能重复计入；先通过测试修正口径，再作为保守估算基础。当前 overhead 校准也混入输出及估算误差，不能直接当精确 provider overhead。

`maxTokens` 当前没有直接传给 SDK 控制生成，预算里的输出余量应保守取值，不能当已强制约束的输出上限。没有可靠图片计数时设置保守 allowance。

Cursor context 参数降档后立即重新计算预算；不能继续拿 catalog 上的大档位规划压缩。

### 8.2 分层策略

- T1：已消费的历史段 → 详细摘要。
- T2：积累的 T1 摘要 → 按任务/主题整合。
- T3：长期摘要 → 核心长期事实、决策与原文索引。
- 最近任务、当前用户指令、未完成调用、已知失败及不可恢复附件保持保护。

尽可能压缩“较旧但不在最早固定前缀”的段，批量应用并设置 cooldown，以降低反复重建成本；任意被删除内容所在点之后的缓存仍可能失效，不能声称前缀缓存完全不受影响。

### 8.3 Preflight sidecar

单独创建无工具、无副作用的临时 Cursor agent，仅发送候选段及摘要规则。摘要通过专用内部 summarizer 入口生成，不递归调用常规 `CursorAdapter.stream()`，也不冒用 DSH `purpose` 的既有枚举作为新功能契约。

每个 chunk 自身也必须适配 sidecar 模型窗口；大范围先分块再合并。次数、时间、输出长度及费用均设上限；默认每次 preflight 最多 3 次调用作为调参起点。

摘要为空、无有效缩减、受保护内容本身超窗、存储失败或达到上限时，返回不在默认 retry 列表中的 `CURSOR_CONTEXT_*` 错误。只有确认未向任务模型交付输入、无业务副作用时才允许有限内部重试；不得重播半完成任务 run。

紧急硬裁剪不是默认成功路径；如未来提供，必须显式标记低保真及可恢复引用，不能静默宣称高保真压缩。

## 9. 原文离线、检索与持久化

先实现 lossless 大工具结果 offload：真实结果完整存档，交给 Cursor 的内容可为有限 preview + 原文引用。必须在首次交付给旧 run 前替换模型可见副本，否则仍要换代才能回收驻留空间。副本不得修改 DSH 存储的实际工具结果。

存储建议：

- SQLite 保存 session namespace、lineage、消息 seq、工具执行记录、块关系、revision 和索引。
- 原文正文/大结果以内容寻址 blob 保存，附件保留宿主引用与可用性信息，不重复堆积 base64。
- 写入原文与压缩状态具备事务一致性；只有原文已安全存储才能隐藏它。
- 保留 bounded 热缓存，不在每轮加载全部原文、展开所有 `effectiveMessageIds` 或重写整个会话快照。
- 搜索 MVP 先用关键词/FTS 或 BM25；向量检索后续评估，不作为必需依赖。
- 分页取回、单次 token 上限、授权校验、schema migration、会话删除和导出均需定义。
- 原文可能含命令输出、凭据和用户隐私：本地访问控制、日志不打印正文/密钥、用户可删除；持久化策略及加密要求需产品确认。

SQLite driver 必须在 DSH Desktop 实际 Node/Electron 环境验证；`acp-kernel` 的引擎声明不等于其持久模块与宿主 runtime 必然兼容。通过 storage port 隔离实现，先完成选型 PoC，不直接引入未经验证的原生 addon。

## 10. DSH 自带 compaction 和现成 bili 的关系

MVP 默认与 DSH 原生 compaction 共存，不全局关闭：

- 若 DSH 发来 `purpose: "compaction"` / `"session-title"`，保持现有辅助请求隔离，不能修改主会话压缩状态。
- 宿主重写历史后，显式建立新 lineage；不能把老块继续强行覆盖到新历史。旧原文保留为只读 archive，其检索入口明确区分“当前分支”和“旧历史”。
- 高频双重压缩可能损伤质量；长期目标是通过正式 profile 配置或宿主公开的按会话上下文管理扩展点协调。
- 本方案检查的 `dsh-llm` 接口有公开 `llm/stream` 中间件，但没有确认可通过它关闭主 agent 的所有 compaction 决策。不要把“有模型调用中间件”误当“可以接管宿主上下文政策”。
- 找不到正式按路由关闭接口时，以兼容模式发布；不能 monkey-patch DSH internals，也不能将 `contextWindow` 改成虚假的超大值。

现成 billion-context 的 DSH native 路径注册了宿主工具，并通过 fetch interception 转写可识别的模型 API 请求。Cursor SDK 不走本插件公开的 OpenAI/Anthropic baseURL 接口，因此该 native 插件对 Cursor 路由能否实际压缩必须另行证明；仅装上两个插件不代表本方案已实现。

同一会话只允许一个有权改变 Cursor 压缩视图的 owner。若现成 bili 的上下文工具可见，不能把它们误接到本插件 ledger；显式选择 owner/禁用冲突工具。跨插件检测若无稳定 capability 接口，应降级为用户配置加醒目警告，不能仅凭环境变量猜测安全。

## 11. Usage、性能与可观测性

必须拆分三类数值：

1. 实际消费：Cursor 原始累计 run usage，按 run/usage 标识去重，包括终止旧 run 和 sidecar 压缩的消费。
2. 当前上下文：本代活跃视图及增量的估算/可得测量，用于窗口压力。
3. 历史规模：本地原文累计 token/bytes，与当前窗口无关。

保持 DSH usage 桶互斥及省略 `totalTokens` 的既有约定。不把 sidecar 输入 token 加到主会话 context fill；若 DSH 没有独立账单/维护调用展示接口，先在插件 panel 单独报告，并标明主面板不包含这部分消费。取消 run 的 usage 可得性及 `getUsage()` 拉取方式需要真 SDK PoC；拿不到时显示 unknown，不能记成零。

记录：generation 切换次数/原因、切换前后 token、压缩耗时/费用、原文取回率、缓存命中、内部摘要事件、host-compaction 次数、预算估算误差、对齐与事务失败。压缩节省必须扣除生成摘要和重建冷输入成本。

超长会话还有宿主成本：DSH 每次构造完整 derived history，本插件无法仅在 adapter 内将这个上游成本降为 O(delta)。实现可避免重复 base64 解码和正文重算，但完整历史扫描仍可能是瓶颈。真正月级/十亿累计 token 必须评估 DSH 官方增量读取接口、宿主文件规模及 UI 性能；没有这些能力时，能力定位为“模型侧长上下文管理”，不承诺无限期单会话流畅。

## 12. 文件改动建议

新增：

- `src/context/manager.ts`：状态协调、revision、预算入口。
- `src/context/ledger.ts`：稳定身份、增量入库、分支同步。
- `src/context/kernel.ts`：锁定版本 acp-kernel 适配层。
- `src/context/view.ts`：投影、来源标记、稳定渲染及视图 hash。
- `src/context/store.ts`：storage port、原文与状态事务。
- `src/context/tools.ts`：DSH 上下文工具注册及授权。
- `src/context/preflight.ts`：无副作用 sidecar、有限压缩流程。
- `src/context/checkpoint.ts`：Cursor checkpoint 读写与改写（§3.2 M3）：`loadLatest` → 过滤 `state.turns` → `saveCheckpoint` → 读回校验；proto 类兜底取法；blobId 格式逆推与断言；失败时抛 `CURSOR_CONTEXT_*` 错误交由上层回退 M2。
- `test/context*.test.ts`：身份、范围、事务、检索及预算测试。

修改：

- `src/adapter.ts`：同步 ledger 后准备 model view；预算早于大规模图片加载。
- `src/transcript.ts`：保存身份 sidecar，不破坏既有 transcript 消费者。
- `src/session.ts`：拆 raw/model seen；换代及 handoff 安全协议；内部 summary 事件；前缀改变时优先调用 checkpoint 改写，失败才走 `Agent.delete` + `Agent.create` 分代重建（M2 删前 `getUsage()` 快照）。
- `src/prompt.ts`：稳定引用、记忆/原文来源渲染、正确计数。
- `src/models.ts`：向 budget 暴露生效档位，不改变现有 provider/model ID。
- `src/usage.ts`：维护调用账目、代际消费及 context fill 分离。
- `src/index.ts`：配置与可选 `tools` service 注入；不让基础 provider 因缺失工具 service 而无法启动。
- `src/host-api.ts`、`client/factory.js`：认证状态查询、压缩统计和手动控制。
- `package.json`：经核验后锁定 acp-kernel；DSH host package 仍为 peer + dev dependency。

配置建议为新 `contextManagement` 区块，默认关闭，包括 soft threshold、目标 fill、输出余量、preflight 限额、原文 offload、storage、owner 和保留策略。保留既有 `context`、`DSH_CURSOR_*`、`cursor` 路由及 `llm-cursor` row 语义不变。

## 13. 实施阶段与验收门槛

### P0：可行性 PoC

- **checkpoint 改写 PoC（M3，主线）**：用 `createAgentPlatform()` 取得 `checkpointStore` → `loadLatest()` 拿 proto 实例 → 逆推 blobId 格式 → 只截断 `state.turns` → `saveCheckpoint()` → 下一轮 `send()` 确认模型只看到近尾部（**唯一一票否决项**）。同时观察后端是否因 requestId/conversationId 不连续报错。
- **分代重建 PoC（M2，回退）**：`Agent.delete` + 同 id `Agent.create`，删前 `getUsage()` 快照，验证 usage 历史确实丢失且快照可用。
- 实测 activity run 取消、compress handoff、并行业务结果的 generation 切换；run 期间改写 checkpoint 的竞态。
- 验证改写/重建后 Cursor 侧只收到压缩视图，旧 run 不再产生新工具请求。
- 核验选定 acp-kernel 包、DSH 原生工具 seam、SQLite runtime、usage 可得性。
- 模拟 DSH compaction、图片身份变化及 SDK 原生 summary。

**门槛：checkpoint 改写与分代重建两条路径都不能证明安全，就不推进主动压缩。** 可以先发布分页原文工具/offload，不能假装完成压缩。

### P1：保守 MVP

- 原文 ledger + 大结果 offload + 搜索/分页读取。
- T1 压缩、显式 revision、仅安全边界换代。
- 窗口 preflight、预算错误、重启恢复、状态 panel。
- DSH compaction 兼容；默认 feature flag 关闭。

### P2：主动分层管理

- 模型自主 compress、增长 nudge、T2/T3、冷却及批量换代。
- 受预算限制的短期展开及原文检索增强。
- 与宿主正式 context policy 的协调、跨插件 owner 协议。

### P3：长跑与经济性验证

- 同工作负载比较原版、T1、分层和仅 offload 四组。
- 评估 100K/200K 等真实可用窗口，而不是盲信模型名称。
- 长历史事实回忆、任务约束遵守、跨天恢复、真实副作用无重复。
- 分别记录模型输入、实际费用、维护费用、缓存、TTFT、宿主扫描和存储峰值。
- 逐级运行百万级/千万级历史；十亿累计 token 结论需要真实长跑证据，不由几个单元测试推出。

可先按三个发布批次规划：安全切换与存储 PoC → MVP → 分层及经济性优化。具体工期在 P0 后估算，主要不确定项是取消协议、宿主 compaction 政策和 runtime 存储兼容性。

## 14. 必须通过的测试

通过 `CursorAdapter.stream()` 增加回归：

1. 未压缩轮次依然只创建一个 agent、只发送新增用户文本。
2. 压缩后新 agent 不含折叠原文；再下一轮不因 raw/view 长度不同重复 fresh。
3. 普通及并行工具调用/结果完整，无副作用重放。
4. compress 与业务工具混合、结果缺失、顺序变化及用户 steering。
5. cancel 超时、abort、新代启动失败、状态提交后崩溃恢复。
6. 搜索和分页读取可找回摘要遗漏的精确代码/报错，不跨 session/profile 泄露。
7. 重复消息、历史编辑、回退、host compaction、title 和模型切换隔离。
8. 大工具结果、不可恢复图片、上下文档位降级、极大初始历史。
9. sidecar 空摘要、超时、无缩减、费用上限及无工具执行。
10. 原始消费去重、维护消费独立、DSH usage 桶互斥。
11. 摘要/检索原文不能提升为系统指令；带恶意文本和伪引用仍是历史数据。
12. 长跑中热缓存有界、存储不每轮全量重写、身份与覆盖关系无漂移。
13. checkpoint 改写：读回 `turns` 确已收缩且下一轮 `send()` 生效；改写与 runner `handleCheckpoint` 的写入竞态；改写失败自动回退 M2 且 usage 快照完整；旧 blob 仍可从 store 读出（原文账本不丢）。

发布前仍运行 `npm run check`、`npm test`、`npm run build`、`npm run check:public`，不绕过发布检查。

## 15. 对照实现：standardagents/composer-api

`<https://github.com/standardagents/composer-api>` 同样基于 Cursor SDK（`package.json` 中 `"@cursor/sdk": "^1.0.13"`，比本仓库锁定的 1.3.1 旧且用 `^` 浮动），却没有遇到本方案 §3 的障碍。原因是**它根本不需要改写 Cursor 历史**，而不是它解决了这个问题。

它的架构取舍（源码核对结论）：

- **API 边界无状态**：`OpenAICompatibility.swift` `prepareChatRequest` 要求请求体带完整 `messages` 数组，把整段对话渲染成**一个 prompt 字符串**（`transcript.append("\(role.uppercased()): \(text)")`，tool 结果渲染成 `TOOL RESULT(...)` / `LOCAL TOOL RESULT: ...`，`let prompt = transcript.joined(separator: "\n")`）。客户端（OpenCode 等）每次重发全量历史 → agent 状态丢了也能从客户端原文重建。
- **agent 只是 session 亲和性缓存**：`scripts/cursor-sdk-local-agent-bridge.mjs` 的 `agentCacheKey(input)` = `sha256([apiKey, model, workingDirectory, sessionKey].join("\0")).slice(0,32)`；`getAgent()` 命中缓存即复用，未命中就 `Agent.create`。**整个 bridge 没有一次 `Agent.resume`**，只有 `Agent.create`。`maxAgents` 默认 128，按 `touchedAt` 淘汰 `close()`。
- **冷/热两条 prompt 路径**：`runLocalAgentBody` 中 `const prompt = agentEntry.cached && input.incrementalPrompt ? input.incrementalPrompt : input.prompt;` —— 冷启动发全量渲染稿，热命中只发增量。增量窗口很小：`incrementalMessageStartIndex` = `max(0, min(lastUserIndex, messages.count - 12))`。增量稿首行写着 "Continue the same local Cursor SDK agent session." / "Rely on prior SDK session context for older conversation..."。
- **完全不做上下文窗口管理**：bridge / responses-proxy / worker 全文 grep `truncat|summar|context window|maxTokens` 零命中，只有 `inputTokenEstimate(characters:)` 用于 usage 上报。它在 codex 模型对象里**宣称** `auto_compact_token_limit = contextWindow * 0.9`、`effective_context_window_percent = 90`、`truncation_policy`（`OpenAICompatibility.swift` `codexModelObject`）但**从不自执行** —— 长上下文交给 Cursor 自己的自动摘要（SDK README 已证：agent 接近窗口上限会自行 summarize）。
- **压缩是客户端功能、纯文本摘要**：`POST /v1/responses/compact` → `prepareResponseCompactionRequest` 用固定三行 prompt（"You are compacting a long-running local Responses API conversation." / "Return a concise continuation summary that preserves user goals, decisions, constraints, important file paths, pending tasks, tool results, and any unresolved errors." / "Do not add new actions or answer the original request..."）跑一个 `sessionKey: nil, incrementalPrompt: nil` 的**一次性 agent**，返回 `object: "response.compaction"`、`output[0].type = "compaction"`、`encrypted_content = <明文摘要>`；回放时渲染成 `COMPACTED CONVERSATION SUMMARY: ...`。**没有内核、没有 T1/T2/T3、没有原文账本、没有引用展开。**
- **responses-proxy 硬截 16 轮**：`buildPrompt` 里 `const recent = history.slice(-16)` → `Prior conversation:\n...`。
- **不检测历史分叉**：grep `diverge|mismatch|desync|out of sync|history hash` 零命中。客户端改写历史它不管，直接信任 agent 记忆。
- **失败 = 淘汰重建**：`runLocalAgentUnlocked` 用 `Promise.race([work, timeout])`，`runTimeoutMs` 默认 180000 → `activeRun.cancel()` + 504 `cursor_sdk_timeout`；`isRetryableSDKRunError(error)` 判 429/503、code 8/14 或 message 含 "rate limit"/"server at capacity"/"resource exhausted" 等 → `evictCachedAgent` 后重试，`maxRunRetries` = 3；`run.wait()` 返回 `status === "error"` 时 `evictAgent(...)` 再抛错。
- **每 agent 串行 + 工具调用即取消**：`runExclusiveForAgent(input, work)` 按 cacheKey 排队；`captureToolCall` 一见模型 tool call 就 `run.cancel()` 返回 `{text:"", toolCalls:[...], status:"tool_call"}` 交外层客户端执行，随后下次 send 带 `local: { force: true }`（SDK `LocalSendOptions.force`："Expire the currently active persisted run... Recovery path for local agents left wedged after a crashed CLI process."）。
- **session 亲和头**：`sessionAffinity(_ request:)` 依次读 `x-session-affinity`、`x-opencode-session-id`、`x-opencode-session`、`x-cursorapi-session`、`x-cursorapi-project`、`x-project-path`、`x-workspace-path`、`x-working-directory`；responses 路径用 `sessionKey(responseID:previousResponseID:explicitSessionKey:)` 派生。Cloudflare worker 侧 `SDK_SESSION_TTL_MS = 6h` + D1 `0002_sdk_sessions.sql` 跨 isolate 保留 agentId。
- **usage 靠字符数估算**：README 明言 "Token usage is estimated from character counts because Cursor's stream does not return OpenAI token accounting on this path."

**结论**：composer-api 把"上下文归 Cursor 自动摘要、原文归客户端"当作架构前提，因此它只需要一个可随时丢弃的 agent 缓存，天然不需要 replace-history。本方案的需求更强 —— 要 T1/T2/T3、原文账本、引用展开、可控驻留窗口 —— 所以必须自己解决 Cursor 侧收缩，也就是 §3.2 的 M3/M2。可借鉴的是它的工程韧性：可重试错误淘汰重建、180s 超时、per-agent 串行队列、tool call 立即 cancel + `local.force` 解卡、128 agent LRU、6h TTL。

## 16. 许可证与发布文档

若使用 acp-kernel，按实际发布包许可证保留版权和出处。参考快照的根 LICENSE 明确要求可见的 billion-context/acp-kernel 使用声明及链接；不能只凭 package.json 中的 `MIT` 标签判断义务。

当前 npm `files` 列表不包含 `docs/`，所以只在这份 RFC 中添加致谢不足以保证随包分发。正式实现应在 README/产品设置页增加可见说明，并将 required notices 放进实际发布的文件列表。

## 17. 推荐决策

批准 P0 + P1，先证明 checkpoint 原地改写（M3）能真实收缩 Cursor 侧历史、并验证分代重建（M2）作为回退；复用 acp-kernel，不复制整个代理服务。把"十亿累计历史"作为长期验证目标，把"原文可恢复、活跃窗口可控、业务工具不重放"作为首版可交付承诺。
