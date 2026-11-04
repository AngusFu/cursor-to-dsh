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
| `src/ui-state.ts` | Settings/API overlay: profiles, active key |
| `src/host-api.ts` | Authenticated `/api/cursor-to-dsh/*` for Settings → Cursor |
| `src/commands.ts` | Slash commands: `/cursor-key-*` |
| `client/factory.js` | Settings → Cursor browser page (copied to `lib/client.js`) |
| `cordis.patch.yml` | Bundle layer that inserts the `llm-cursor` row |
| `patches/@cursor__sdk@<ver>.patch` | pnpm patch on the locked `@cursor/sdk` (see below) |
| `scripts/patch-cursor-sdk.mjs` | Re-applies that patch to a `pnpm patch` directory on SDK upgrades |

## Commands

```bash
pnpm install     # pnpm 12 only: applies patches/ to @cursor/sdk (npm would silently skip it)
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

## `@cursor/sdk`: locked + patched

- `@cursor/sdk` is pinned to an exact version (no `^`/`~`) and patched with pnpm (`patchedDependencies` in `pnpm-workspace.yaml`, file in `patches/`). Installs ship minified `dist/` (cjs, esm, bun `bundled`), not TS source, so the patch edits those three builds.
- Why: the SDK's `run.stream()` converter maps `webSearchToolCall` / `webFetchToolCall` to `return null`, so `tool_call` messages for them never reach the stream (still true in 1.3.1). The patch emits them as `tool_call` with `name: "webSearch" | "webFetch"`, args `{ searchTerm }` / `{ url }`, result `{ status, value | error }`, like `semSearch` / `mcp`.
- The patch does not turn web tools on: this plugin still creates agents with `tools: ["mcp"]` only.
- `patchedDependencies` only applies to the project being installed. Inside a DSH profile the patch is applied only if the profile's own `pnpm-workspace.yaml` lists it (copy the patch file into the profile; see README). Without that, the plugin works, unpatched.
- Upgrade = re-patch, never bump alone:
  1. `pnpm add @cursor/sdk@<new> --save-exact` (drop the old `patchedDependencies` entry and patch file first; new SDK releases may need `minimumReleaseAgeExclude`).
  2. `pnpm patch @cursor/sdk@<new>` → `node scripts/patch-cursor-sdk.mjs <printed dir>` → `pnpm patch-commit <printed dir>`. The script fails loudly if the minified anchors moved; then re-read the switch around `case"webSearchToolCall"` and adjust.
  3. `npm test` (`test/sdk-patch.test.ts` extracts the converter from each installed build and asserts web tool calls are emitted). Optionally a live run with web tools enabled.
  4. Update the README profile snippet to the new version/patch file name.

## ripgrep

`rg` (plus `cursorsandbox`) comes from `@cursor/sdk`'s `optionalDependencies` (`@cursor/sdk-<platform>-<arch>`), not from this repo. The SDK's local runtime needs it (workspace scanning; it throws `Ripgrep path not configured` without one), so do not exclude it. `src/sdk.ts` `configureRipgrep()` only points `CURSOR_RIPGREP_PATH` at that package's binary because DSH does not put package binaries on PATH.

