# AGENTS.md

DeepSeek Harness (DSH) plugin that registers Cursor as the `cursor` LLM provider route. DSH owns the agent loop, tools and permissions; Cursor is only the model. The session core is ported from the author's Cursor provider for pi (cursor-to-pi).

## Layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry (`name`, `inject`, `Config`, `apply`): key lookup, working directory, adapter registration |
| `src/adapter.ts` | `CursorAdapter extends LlmAdapter`: `stream`, `listModels`, `resolveModel`, catalog cache |
| `src/transcript.ts` | DSH `GenerateOptions` -> core transcript (`user` / `developer` / `assistant` / `toolResult`) |
| `src/session.ts` | One Cursor agent per DSH session, tool-call handoff, mid-session tool changes, turn loop |
| `src/reply.ts` | DSH `StreamChunk` output and the mirrored assistant message |
| `src/models.ts` | Cursor catalog -> DSH model info and reasoning efforts -> Cursor params |
| `src/prompt.ts` | Transcript rendering, fingerprints, tool results, token estimates |
| `src/usage.ts` | Cursor usage -> DSH disjoint buckets, Cursor overhead calibration |
| `src/sdk.ts` | Cursor SDK access (agent, catalog, ripgrep path) |
| `src/keys.ts` | Multi API-key profiles + active key resolution |
| `src/ui-state.ts` | Settings/API overlay: profiles, active key, pill display mode |
| `src/quota.ts` | Shared quota core: window / snapshot types, tone, 2-min SWR cache |
| `src/quota-cursor.ts` | Cursor usage: login-state token ladder, DashboardService RPCs |
| `src/quota-copilot.ts` | Copilot usage: borrowed grant / env / gh token, GitHub internal endpoint |
| `src/host-api.ts` | Authenticated `/api/cursor-to-dsh/*` for Settings → Cursor (keys + usage) |
| `src/commands.ts` | Slash commands: `/cursor-key-*` |
| `client/factory.js` | Settings → Cursor browser page + conversation usage pill (copied to `lib/client.js`) |
| `cordis.patch.yml` | Bundle layer that inserts the `llm-cursor` row |
| `scripts/patch-cursor-sdk.mjs` | postinstall: patches the locked `@cursor/sdk` ESM build (see below) |

## Commands

```bash
pnpm install     # pnpm 12; postinstall patches @cursor/sdk (see below)
npm test         # unit tests with the fake Cursor agent
npm run check    # tsc --noEmit
npm run build    # lib/ for DSH to load
npm run check:public  # before any push to GitHub or npm publish
```

Live check (real Cursor, no DSH): `CURSOR_API_KEY=... node --experimental-strip-types scripts/live.ts`.

## Rules

- Use DSH's official seam (`ctx.llm.registerAdapter`); never wrap or patch DSH internals.
- Cursor's built-in tools stay off (`tools: ["mcp"]` only). All tools stay DSH MCP custom tools.
- DSH host packages (`@deepseek-ai/cordis`, `dsh-llm`, `dsh-credentials`, `dsh-launch-environment`, `schemastery`) are `peerDependencies` + `devDependencies`, never `dependencies`: DSH supplies the shared instances.
- Keep the route id `cursor`, model ids, the `llm-cursor` row id and `DSH_CURSOR_*` variables stable; user patches depend on them.
- Error codes stay outside DSH's default retry list; a half-finished Cursor run must not be replayed.
- Usage buckets are disjoint and `totalTokens` is omitted; DSH discards a total that disagrees with the buckets.
- New behavior gets a test through `CursorAdapter.stream()` in `test/session.test.ts` or a unit test.
- Source must stay type-strippable (no enums, no parameter properties); `lib/` is built by `tsc`, not committed.
- Do not commit secrets, internal links or local absolute paths; `npm run check:public` enforces the common cases. Publishing runs `prepublishOnly` (type check, tests, build, public check); never bypass it.

## Installation in DSH profiles

A DSH profile (`~/.dsh/profiles/<name>`) is a pnpm project: `package.json` lists `"cursor-to-dsh": "github:AngusFu/cursor-to-dsh#vX.Y.Z"` plus the `cursor-to-dsh` bundle, and DSH (or Desktop's bundled pnpm) runs `pnpm install` there; git installs run `prepare` (= `tsc` build), so the profile needs `allowBuilds: cursor-to-dsh: true`. DSH loads `lib/` and resolves `@cursor/sdk` through `import()`, i.e. `dist/esm`.

## `@cursor/sdk`: locked + patched at install

- `@cursor/sdk` is pinned to an exact version (no `^`/`~`). Installs ship minified `dist/` (cjs, esm, bun `bundled`), not TS source.
- Why: the SDK's `run.stream()` converter maps `webSearchToolCall` / `webFetchToolCall` to `return null`, so `tool_call` messages for them never reach the stream (still true in 1.3.1). The patch emits them as `tool_call` with `name: "webSearch" | "webFetch"`, args `{ searchTerm }` / `{ url }`, result `{ status, value | error }`, like `semSearch` / `mcp`.
- How: `postinstall` runs `scripts/patch-cursor-sdk.mjs`, which rewrites the two cases in the one `dist/esm/*.js` chunk holding the converter (DSH loads the SDK via `import()`, so only ESM matters; cjs/bundled are left alone). No committed diff: that chunk is a single ~1.3 MB line, so a `pnpm patch` file was megabytes.
- The script only acts on the exact version pinned in `package.json`, is idempotent (marker comment), replaces the file via rename (never mutates a hardlinked store file), and never fails the install: on a version mismatch or moved anchors it prints a warning and the plugin runs unpatched. `node scripts/patch-cursor-sdk.mjs --check` exits 1 when unpatched.
- Works inside DSH profiles with no profile changes, as long as the profile allows builds for `cursor-to-dsh` (it already must, for `prepare`). With npm or `--ignore-scripts` nothing is patched.
- The patch does not turn web tools on: this plugin still creates agents with `tools: ["mcp"]` only.
- Upgrade = re-patch, never bump alone:
  1. `pnpm add @cursor/sdk@<new> --save-exact` (new releases may need `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`).
  2. `node scripts/patch-cursor-sdk.mjs` — if it warns that anchors moved, re-read the minified switch around `case"webSearchToolCall"` in `dist/esm` and adjust `patchSource()`.
  3. `npm test` (`test/sdk-patch.test.ts` extracts the converter from the installed ESM chunk and asserts web tool calls are emitted and the patch is present). Optionally a live run with `tools: ["webSearch","webFetch"]` consuming `run.stream()`.

## ripgrep

`rg` (plus `cursorsandbox`) comes from `@cursor/sdk`'s `optionalDependencies` (`@cursor/sdk-<platform>-<arch>`), not from this repo. The SDK's local runtime needs it (workspace scanning; it throws `Ripgrep path not configured` without one), so do not exclude it. `src/sdk.ts` `configureRipgrep()` only points `CURSOR_RIPGREP_PATH` at that package's binary because DSH does not put package binaries on PATH.

