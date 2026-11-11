# Cursor 与 billion-context 数据链路核实

核实时间：2026-11-12 00:25（Asia/Shanghai）。本次只做源码核实与离线 mock/纯内核测试，没有启动上游服务或调用计费模型。

## 固定版本

- cursor-to-dsh main：`a13c78e62788573f6be81c8075e57be8b0d57c57`，0.3.0，结束时重新读取 main，未更新。
- billion-context 默认分支：`c26c31ace45a88f42a2ed0ba23df2217d9c1ce99`，0.1.213，结束时复核相同 SHA。
- 本仓实际依赖 `acp-kernel@0.0.101`、`@cursor/sdk@1.3.1`；上游该 SHA 的 kernel 为 0.0.195。本补丁没有升级依赖。

## 一句话里程碑

**共用 acp-kernel 不等于共用数据库。当前 Cursor 插件确实另有 SQLite；上游公开插件 API 不能仅靠接工具就接管 Cursor SDK 的完整历史。此次修复不创建新库、不共写上游库，也不迁移或删除旧数据。**

## 谁负责什么

| 数据/动作 | acp-kernel | billion-context runtime | 当前 Cursor adapter |
|---|---|---|---|
| 压缩范围、配对、refs、block summary、coverage | 纯函数生成/验证 `CompressionState` | 持有 state，并保存 | 持有同类 state；修复后以 kernel coverage 决定保留视图与归档范围 |
| 压缩前原文 | 可根据 host 传入 messages 收集；不是常驻原文服务 | 压缩时保存 `blockContents` 的 one/full 原文；保留 session/raw snapshot | DSH 仍拥有原始历史；已有 archive_chunks 保存压缩原文 |
| CCR 内容寻址/取回 | 生成并操作 `MessageContentStore`，`byRef/byHash` | host 持有 store，unified-first 加载，执行 retrieve | 既有 content_store 表保存 kernel store |
| search/decompress | 提供 `searchBlocks`、`collectBlockContent` 等运算 | 工具层读 state、blockContents、CCR 与 ancestor session；服务负责权限/锁/注入 | 既有 context tools 与 archive 检索；不是自动连到上游 search 服务 |
| revision | 返回状态；不自动提供分布式 session CAS | session revisionEpoch/内容 hash、锁及工具 expectedRevision | 本地 pending/applied revision；本补丁只做拒绝前置和 transport staging 的提交冲突检测，不声称解决所有 sidecar 陈旧结果 |
| 磁盘 | `acp-kernel/persist` 提供 `StateStore<T>` 原子 JSON 写入机制 | SessionStore + unified backend，SQLite index.db/内容寻址 blobs；另有 MySQL 等后端 | `~/.dsh/cursor-context-ledger.db`，四张已有表 |

关键证据：

- [本仓独立 SQLite 的路径和四张表](https://github.com/AngusFu/cursor-to-dsh/blob/a13c78e62788573f6be81c8075e57be8b0d57c57/src/context/ledger-persist.ts#L22-L74)。本补丁不修改此文件。
- [上游 Session 的 state、blockContents、snapshot 和 revision](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/session.ts#L639-L701)。summary/coverage 与压缩原文是不同对象。
- [unified-first contentStoreOf 与 host 采纳/持久化职责](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/store.ts#L114-L173)。
- [上游压缩后收集 one/full 原文](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/stream.ts#L1370-L1415)。
- [decompress 优先读取 host blockContents](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/decompress-shared.ts#L155-L245)，[search 调 kernel 算法并读 host 内容](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/decompress-shared.ts#L821-L891)。
- [统一 SQLite/内容寻址存储](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/storage/store.ts#L1-L30)。注意：上游明确支持**自己的 runtime**多进程写同一 index.db，并对同 session split-brain 报警（[拓扑说明](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/storage/store.ts#L411-L424)）；这并不授权本仓用另一套 schema/ledger 直接双写其文件。
- [kernel/persist 的职责边界](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/kernel/src/persist/index.ts#L1-L24)：上游负责原子写入机制，host 决定目录、payload/schema、加载/保存生命周期。本仓锁定的 0.0.101 安装包也已导出 StateStore/mergeCompressionState，不必为此先升级内核。

## 能不能直接走相同链路

现有上游 DSH native 链路是：

`DSH 模型 HTTP → native fetch redirect/headers → bili proxy 解析完整请求 → session/processTurn → 上游持久化 → 改写模型请求`。

Cursor 链路是：

`DSH messages → Cursor adapter/kernel → Cursor SDK native agent/checkpoint → 模型`。

[上游 DSH native 说明](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/agent/dsh-native.ts#L1-L28)明确依赖拦截标准模型 HTTP。Cursor SDK native agent 不是这个已核实的标准请求入口，不能假设 JS 全局 fetch 自动拦得到。

上游有受支持的 manifest/tool/session-register/status/snapshot/fork 等 API，但：

1. [plugin 协议要求每次模型请求经过 proxy](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/plugin.ts#L91-L107)。
2. [tool 在 session 锁内使用已记住的 processed/original messages](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/plugin.ts#L2408-L2446)，不是传一份 conversationId 就有原文。
3. [snapshot 是读取；fork 校验既有 parent 的 revision 和 ordered identities](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/src/plugin.ts#L1626-L1732)，不是任意上传 Cursor 历史的接口。
4. [npm 公开 exports](https://github.com/ranxianglei/billion-context/blob/c26c31ace45a88f42a2ed0ba23df2217d9c1ce99/package.json#L7-L17)没有通用 SessionStore/UnifiedStore 库入口。

因此，**已核实的公开契约不足以让当前 Cursor transport 原样接上上游完整数据链路**；这是接口边界，不是断言技术上不可能。

## 需要决定的边界（本补丁不实施）

- **只想去掉自制 SQLite 写库机制**：可沿用已存在的 `acp-kernel/persist StateStore<T>`，但 host 仍要保存原文/summary/state，仍是独立持久化数据，并非共享 bili 数据库。应另做旧库只读导入、单写者/回滚与恢复测试，不应把切换存储塞进这次正确性补丁。
- **真要同一个数据源/同一套 search/decompress**：应让一个 bili runtime/service 拥有原文、refs、block、revision、检索与持久化，Cursor 只做 SDK/checkpoint transport。需要上游受支持的完整历史 ingest → canonical model view 接口，以及图片/检索注入、expectedRevision、压缩 prepare/commit/failure 语义；当前工具 API 不能替代这一层。需确认是否接受运行/复用该服务、与上游补接口，再实施集成。
- **不做的捷径**：不导入未导出的 storage 私有模块；不把 `cursor-context-ledger.db` 指到 index.db；不让两个独立压缩权威同时写同一 session；不悄悄升级 .101 到 .195 并迁移已有状态。

## 本补丁的最小边界

保留现有存储格式。只把压缩接受/coverage/view 的决策收敛到 kernel：raw/normalized 统一、全部并行 tool id、任意中段范围按实际覆盖归档、预算按同一个 kernel view、M2 重放完整有效视图、拒绝不发布成功 revision。归档仍是可读取原文副本，不再由 prefix cursor 推断“已压缩”。历史旧归档未回填，也没有自动“修复”用户旧库。
