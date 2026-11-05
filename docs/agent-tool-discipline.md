# Agent tool discipline (DSH / MCP)

通用提示词：减少「工具参数名用错、edit 对不上、删代码留 dangling 引用」这类 step 浪费。适用于 DeepSeek Harness 会话（含 Cursor `composer-*` 路由），也可贴进 profile 的 system 或 `AGENTS.md`。

## 用法

1. **整段复制**下面 `## Prompt` 到 DSH 自定义 system、workspace `AGENTS.md`、或 Cursor User Rules（与 DSH 并存时以 DSH 注入为准）。
2. **Cursor 插件用户**：`cursor-to-dsh` 已在首包 transcript 注入精简版（见 `src/prompt.ts` 的 `TOOL_DISCIPLINE_NOTE`）；需要更长版时可把本节 Prompt 再加进 profile。

## Prompt

```text
Tool discipline (this host, not Cursor IDE):

- Argument names come only from each tool's JSON Schema on this request. Do not assume names from Cursor, Copilot, or other products (common mistakes: path or glob_pattern instead of file_path and pattern). If a tool returns INVALID_ARGS or "missing required property", fix names from the error message; never repeat the same arguments.

- Before calling an unfamiliar tool, inspect its schema (GetDynamicTools / tool descriptor). read, write, and edit take file_path; glob and grep take pattern (and path or file_path as documented—not interchangeable with "path" alone unless the schema says so).

- Before edit, read the file (or grep the exact lines) so old_string matches the current content exactly, including tabs and trailing newlines. If edit returns old_string not found, read again and adjust—do not spam identical edits.

- Before removing a file, route, UI page, env flag, or exported symbol, grep the repo for references: imports, call sites, helpers in the same package, tests, and skills/docs. Update or relocate shared helpers (e.g. a small func used by two CLI files) in the same pass. Prefer one dependency scan over many compile-fix rounds.

- After substantive deletes or refactors, run the project's build or tests (respect sandbox: use workspace-local caches like GOCACHE/GOMODCACHE under the repo if the default cache is blocked). Treat non-zero exit codes as blocking until understood.

- read: offset is a positive 1-based line number within the file; negative or past EOF offsets are errors.

- bash: every result includes [exit code: N]; investigate N ≠ 0 before moving on.

- Paths: grep/glob/read only work on real directories and files. Do not search inside `.asar` archives (e.g. `Something.app/Contents/Resources/app.asar/...`)—the OS returns "Not a directory". Runtime "implementation checkout" paths inside an app bundle are not the session workspace; use the session working directory or an explicit git clone for ripgrep. If a path fails with IO error, do not repeat the same path; pick a writable checkout or ask.
```

## 为何有效（对照典型失败）

| 现象 | 提示词里的对应条 |
|------|------------------|
| `missing required property "pattern"` / `"file_path"` | Schema / 勿用 Cursor 参数名 |
| `FS_EDIT_NOT_FOUND` | edit 前先 read，失败再 read |
| 删 `cron.go` 后 `undefined: shortID` | 删前 grep，同 package 共享符号 |
| 删字段后 `stopCron` / struct 语法错 | 删前 grep 引用，一次改齐 |
| `offset must be a positive integer` | read offset 规则 |
| `rg: ...app.asar/... Not a directory` | 勿对 `.asar` 做 grep；用 workspace 或真实 checkout |
