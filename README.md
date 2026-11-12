# cursor-to-dsh

[![license](https://img.shields.io/npm/l/cursor-to-dsh)](LICENSE)

> Fork: [AngusFu/cursor-to-dsh](https://github.com/AngusFu/cursor-to-dsh)（上游 [lukeinx/cursor-to-dsh](https://github.com/lukeinx/cursor-to-dsh)）。本 fork 增加：**Settings → Cursor 配置页**（多 API Key / 选用 / 经 credentials 存储）。

> Use Cursor models as the `cursor` LLM provider in DeepSeek Harness (DSH) and DeepSeek Desktop, through the official `@cursor/sdk` and your own Cursor API key. DSH keeps the agent loop, tools and permissions; Cursor is only the model. The docs are in Chinese.

把 Cursor 注册为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，含 DeepSeek Desktop）的模型提供方 `cursor`。DSH 负责 agent 循环、工具和权限，Cursor 只当模型。

![一次带工具调用的对话：DSH 把工具交给 Cursor，Cursor 调工具时交回 DSH 执行，结果回填到同一个 Cursor run](docs/images/flow.png)

## 特点

- **官方接口**：聊天只用 Cursor 官方 `@cursor/sdk` 和你自己的 API Key，不改宿主代码；通过 DSH 的 `ctx.llm.registerAdapter` 注册。
- **用量 UI**：设置 → Cursor 的「用量」卡片 + 输入框旁用量胶囊（自动 / 常驻 / 关闭），按当前模型切换显示 Cursor（Auto / API / 合计 / Grok Bot）或 Copilot（Premium / 对话 / 补全，无限额显示「不限」）的百分比与重置时间。Cursor 侧凭据取本机 Cursor 登录态（`state.vscdb` / `auth.json`，API Key 单独拿不到用量）；Copilot 侧只借 Copilot 登录保存的 grant（不改它的登录），退化到 `GITHUB_TOKEN` / `gh auth token`。
- **Copilot 登录**：设置 → Cursor 的「Copilot 登录」卡 + `/copilot-login`、`/copilot-status`、`/copilot-logout` 命令，设备码登录；凭据记录沿用 `llm-pi-ai/github-copilot`（与 DSH 内置 `github-copilot` 路由一致），迁移自 `@lujianjun19/dsh-llm-github-copilot`，验证通过后可卸载该插件。
- **工具归 DSH**：默认关闭 Cursor 内置工具；读写文件、执行命令都由 DSH 执行，沿用沙箱和审批。
- **多 Key UI**：设置 → Cursor 添加 / 保存 / 选用 / 删除；也可用 `/cursor-key-*` 命令。
- **缓存复用**：每个 DSH 会话对应一个 Cursor agent，只发新增内容；工具结果回填到同一个 run 继续。
- **模型与用量**：模型和推理强度来自 Cursor 实时目录，始终 `fast=false`；按 DSH 互不重叠的用量桶上报，不误报超限。
- **图片**：用户消息和工具结果里的图片转给 Cursor。

## 安装

前置：DSH `0.2.0-rc.2` 及以上（DeepSeek Desktop 内置 `0.2.1-rc.2`）。

**CLI 或其他 profile**：`dsh plugin --profile <名称> add cursor-to-dsh`。

**DeepSeek Desktop**：`desktop` profile 由 Desktop 独占，`dsh plugin add` 会报 `managed exclusively by the Electron application`，需要手动改：

1. 完全退出 DeepSeek Harness Desktop。
2. 在 `~/.dsh/profiles/desktop/package.json` 里**追加**两处，已有条目不动：

   ```json
   {
     "dependencies": { "cursor-to-dsh": "github:AngusFu/cursor-to-dsh#v0.3.0" },
     "dsh": { "profile": { "bundles": ["…已有条目…", "cursor-to-dsh"] } }
   }
   ```

3. 用 Desktop 自带的 pnpm 安装，然后启动：

   ```bash
   cd ~/.dsh/profiles/desktop
   node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install
   open -a "DeepSeek Harness"
   ```

升级：改版本号后重复第 3 步。

**Cursor 内置 webSearch / webFetch 进 run.stream()**：原版 `@cursor/sdk` 把这两种 tool call `return null` 丢掉。本插件锁定 SDK 版本，`postinstall` 在安装时就地改 SDK 的 ESM 构建（只改这两个 case，版本不符或代码变动时只警告不报错）。profile 无需额外配置，只要 `allowBuilds` 里有 `cursor-to-dsh`（`prepare` 本来就需要）。

### 填 API Key（支持多把）— 用配置页，不要手写 yaml

在 [cursor.com/dashboard](https://cursor.com/dashboard) → API Keys → New API Key 创建（个人 key 或 service account key，不支持 Team Admin key）。

**主路径：设置 → Cursor**（本插件自带页面）

1. 打开 DeepSeek Harness / Desktop → **设置 → Cursor**
2. **添加** profile（如 `work` / `personal`）
3. 在对应行粘贴 API Key → **保存 Key**（只写进 DSH credentials，界面永不回显）
4. 点 **选用** 切换当前 Key

也可用斜杠命令（非 Web 表面）：`/cursor-keys`、`/cursor-key-set <id> <key>`（不记入会话日志）、`/cursor-key-use <id>`、`/cursor-key-add`、`/cursor-key-remove`。

> 不要手改 `~/.dsh/.credentials.yaml`。配置页和命令会调用 `credentials.set`；yaml 只是底层存储。

单 profile 查找顺序：credentials → 环境变量 / launch env →（不推荐）明文 `apiKey`。

### 验证

「设置 → 模型」里出现 Cursor，模型选择里有 `cursor` 下的模型即成功。也可以把 `agent-default-model` 设为 `provider: cursor`。

### 让 Agent 代装

把下面这段发给 Claude Code、Cursor、pi 等：

```text
按 https://github.com/AngusFu/cursor-to-dsh 的 README 给我的 DeepSeek Harness Desktop 安装 cursor-to-dsh（github:AngusFu/cursor-to-dsh#v0.3.0），
遵守 README 里给 Agent 的规则；装好后告诉我把 Cursor API Key 填到哪里，key 由我自己填。
```

给 Agent 的规则：

- 改 profile 前先退出 Desktop；只追加条目，不改已有的 `dependencies` 和 `bundles`。
- key 由用户在「设置 → Cursor」填写，Agent 不读取、不打印密钥。
- 改本仓库代码前先读 [AGENTS.md](AGENTS.md)。

## 配置

默认不用配。需要时在 profile 的 `cordis.patch.yml` 覆盖插件这一行（patch 会替换整个 `config`，要写全）：

```yaml
- id: llm-cursor
  name: cursor-to-dsh
  config:
    apiKeyProfiles:
      - id: default
        label: Default
        apiKeyEnv: CURSOR_API_KEY
      - id: work
        label: Work
        apiKeyEnv: CURSOR_API_KEY_WORK
    activeKeyId: default
    apiKeyEnv: CURSOR_API_KEY
    context: min
```

| 配置项 | 默认值 | 环境变量覆盖 | 含义 |
|---|---|---|---|
| `apiKeyProfiles` | 一项 `default` | | 多把 Key 的元数据（密钥在 credentials；请用设置页维护） |
| `activeKeyId` | `default` | | 当前使用的 profile `id`（设置页「选用」） |
| `apiKeyEnv` | `CURSOR_API_KEY` | | 兼容旧版：profiles 为空时的单 key 凭据名 |
| `apiKey` | 无 | | 明文 key，不推荐 |
| `context` | `min` | `DSH_CURSOR_CONTEXT` | 上下文档位：`min`、`max` 或如 `300k`；被拒时自动降档 |
| `cwd` | 会话工作目录 | `DSH_CURSOR_CWD` | Cursor agent 的工作目录 |

其他环境变量：`DSH_CURSOR_DEBUG=1` 输出调试日志到 stderr；`DSH_CURSOR_PREWARM=0` 关闭预热（插件加载后在后台预建一次 agent，省掉 Cursor SDK 首次约 8 秒的初始化）。


## 图片备份位置

折叠出 Cursor checkpoint 的图片会备份到用户级插件目录，**不会写入项目或会话 cwd**：

- 路径：`$DSH_HOME/cursor-to-dsh/retrieve/img/<DSH session id>/`；默认是 `~/.dsh/cursor-to-dsh/retrieve/img/<id>/`。未设置、空白或相对路径的 `DSH_HOME` 视为未设置。
- 写入、索引更新和 TTL 共用同一边界：先解析操作系统用户 HOME 的真实位置（兼容 macOS HOME/系统祖先的正常别名），再逐级检查 HOME 下的目录。`DSH_HOME` 必须是 HOME 内的专用子目录，不能等于 HOME；HOME 下面的 `DSH_HOME`/插件根/任一中间目录、会话桶或索引的软链接均拒绝。配置到 HOME 外、已知项目内或不可验证的位置时，**关闭该根的备份/清理，不另找项目目录落盘**。原本将 DSH 数据放外置盘或用子目录链接的配置因此不支持图片备份；不会修改那份配置。
- 按原生会话 id 分桶，不按工作目录分桶。换一个 cwd 仍会找到同一会话的备份；进程中见过的会话工作目录也继续禁止写入；若 cwd 本身是 HOME 或其祖先，也会保守关闭备份而不写入该 cwd 下。
- 每桶 `index.json` 原子更新，图片文件按引用、原始图片序号和内容哈希命名。新存储的缺失/损坏索引可从本桶文件名重建，不压缩多图序号；同一位置有多个版本且索引丢失时拒绝猜选。有效索引及新消息的对应关系优先，不因 TTL 换成旧图；有效引用的图片缺失/过期时保留空引用索引，阻止历史文件或旧项目图片回填。
- 过期文件默认 7 天（按文件 mtime，在归档或恢复该会话时懒清理），只清理通过上述验证的用户级桶。明确声明属于其他会话的索引不是“损坏”：拒绝读、写和 TTL，不能靠扫描文件名绕过。
- 若旧图片在项目 `.dsh/retrieve/img/<session>/`，**保留原样，不删除、不迁移、不自动扫描其他会话导入**。只读兼容要求目录无重定向、索引明确声明当前 session id、文件路径留在同一桶内；旧索引缺失/损坏/归属不符时不从文件名推断归属。新用户级索引中已有的整个引用优先，不能混入旧项目同名引用的图片。
- 这不是沙箱：模型仍可能用普通文件工具读到工作区里其他会话的 transcript、Cursor `assets` 或旧项目缓存。本插件不会据此扩大成全机文件权限系统。

## 已知限制

- 文件附件保留引用，不作为任意二进制投递；已卸载（offloaded）或读不出的图片可能只留占位说明。工具/系统变化后的恢复会重放完整未完成轮中仍可读取的图片。
- 工具交接期间不报用量，上下文用量在 run 结束时更新。
- 不支持 `stop`（报 `UNSUPPORTED_OPTION`）；`temperature`、`maxTokens` 被忽略。

## 开发

```bash
pnpm install && npm run build  # 用 pnpm 12（postinstall 会 patch @cursor/sdk）；DSH 加载的是 lib/，改源码后要重新 build 并重启 DSH
npm test                       # 假 Cursor agent 的单测
npm run check                  # 类型检查
npm run check:public           # 推 GitHub / 发 npm 前：不含内网链接和本机路径
CURSOR_API_KEY=... node --experimental-strip-types scripts/live.ts [模型 id]   # 真实 Cursor 实测
```

本地源码接入 Desktop：安装第 2 步的依赖写成 `"cursor-to-dsh": "link:<仓库绝对路径>"`。

不动 profile、在真实 DSH 里试跑一次（overlay 里的路径必须是绝对路径）：

```yaml
# /tmp/cursor-overlay.yml
- insert:
    - id: llm-cursor
      name: <仓库绝对路径>/lib/index.js
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: cursor
    model: claude-haiku-5-5
```

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
CURSOR_API_KEY=... DSH_CURSOR_DEBUG=1 "$DSH" --profile headless --patch /tmp/cursor-overlay.yml --json "Read README.md and summarize it in one line"
```

调试日志里工具结果回填那次应显示 `plan=results`，多轮对话的第二轮应显示 `plan=send`。`--patch` 挂载的插件用自己的 `@deepseek-ai/dsh-llm` 副本，错误码会变成 `UNKNOWN`，只用于试跑。

架构和约束见 [AGENTS.md](AGENTS.md)。

## 版权

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 Luke。
