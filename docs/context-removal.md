# 压缩移除与兼容边界

## 保留和移除

保留普通 Cursor SDK 调用、按 DSH 会话复用 agent、模型参数/降档、多 Key、设置页/用量、普通 DSH 提示词及工具桥接。工具签名变化判定与工具交接重发保原问题的已发布修复不回退。

移除自建 `acp-kernel`、原文/refs/kernel SQLite ledger、分层压缩、M3 checkpoint 改写/M2 压缩换代、预算/自动摘要 sidecar、`cursor_context_compress/status/decompress/search`、`/cursor-context-*` 与 `/cursor-acp-panel`、压缩设置/看板/API/fill pill。Cursor SDK 自身保存 checkpoint 的正常机制不属于上述删除范围。

图片附件和工具返回图片仍通过字节传输。旧 imageRef 归档/恢复只服务于已移除压缩层，因此同步移除其文件备份/索引/TTL；不留一个闲置写库/清理器。这保证本插件不再产生项目图片缓存写入，但不承诺限制 SDK 或模型主动访问共享文件。

## 旧资料原样保留

本插件不再打开 `~/.dsh/cursor-context-ledger.db`（及其 WAL/SHM），不再访问/清理 `$DSH_HOME/cursor-to-dsh/retrieve/img` 和旧项目 `.dsh/retrieve/img`。不会删除、迁移、自动扫描导入旧图片，也不会清理原配置里的 `contextManagement`。这些资料若要保留检索/恢复能力，须另外设计只读导出；此次不擅自导出、弃置或改写。

不修改 DSH session DB、Cursor 原生 SDK 数据目录或 checkpoint。普通在途/后续 SDK 会话复用规则未改；需要重启安装时，应先结束当前在途任务。桥在进程重启后仍按既有设计由宿主提交的 DSH 历史构建 agent，没有新增 SDK-only 历史迁移或恢复承诺。宿主已经删掉的原文、只存于旧压缩归档的原文以及仅 SDK 持有的额外上下文不会被凭空恢复；不能把卸载压缩层说成完成了这些数据迁移。

## Cursor 输入过滤范围

依据 billion-context 0.1.213 实际包的 manifest：核心 `compress`、`decompress`、`search_context`、`acp_status`、`acp_cache`；可选 `absorb`、`acp_rule`、`acp_retrieve`、`acp_read_original_image`。兼容旧版 `image_full`；同时拒绝四个已退休的本插件 context 工具。可配置改名的 absorb/retrieve 按已核实且保持不变的协议描述与参数组合识别；通用名字按 schema/描述指纹匹配，避免屏蔽普通文件压缩等工具，不使用宽泛前缀禁用。

过滤仅作用于 Cursor adapter 的请求投影，原全局 tool list 不变。移除工具的配套描述不进入 SDK 工具定义；不再注册本插件 `[acp-context]` 提示。旧宿主 runtime snapshot 仅在 `source.kind=runtime-context`、带明确 `cursor:acp-context` section 且原始内容与宿主渲染契约一致时分离，其他 sections 保留。没有归属或混杂额外内容则明确报错，存储的历史不变；用户/assistant/tool 正文即使引用同样文本也不删除。旧压缩工具的调用/结果仍作为历史事实保留，并不重新提供这些工具。

已核实安装版 global billion-context 的 DSH native 入口通过 manifest 注册工具、`llm/stream` 记录归属，本身没有 `systemPrompt.context/section` 注册；其网络代理会在自己的协议管道组装压缩指导。本插件不改该全局代理/fetch hook，不影响其他模型，也不声称能控制桥下游的任意网络改写。自定义改名且同时改描述/schema 的全局工具若失去可辨识来源，需宿主提供 provenance；不能凭名字猜测后删除任意工具。

## 不在本次范围

没有引入 Paseo 私有目录/文件权限 guard、全 shell 沙箱或 session 数据迁移；没有修改全局插件、DSH 配置或服务。测试仅证明桥的输入保真、移除功能不再执行及缓存零写入，不证明模型绝不误解来源或执行越权操作。
