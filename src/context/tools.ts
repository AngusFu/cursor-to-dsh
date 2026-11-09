/**
 * billion-context style context tools for Cursor sessions (RFC §6).
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { PROVIDER_ID } from "../models.ts";
import { estimateTranscript } from "../prompt.ts";
import {
  type CompressRefRange,
  compressibleRefs,
  decompressChunk,
  ledgerStats,
  resolveCompressRefRange,
  searchArchive,
  syncMessageRefs,
} from "./ledger.ts";
import { cursorContextParamDescription, cursorContextToolDescription } from "./acp-tool-surface.ts";
import { planCompaction } from "./compact.ts";
import { kernelTurnPlan } from "./kernel.ts";
import { resolveCompressionLayer } from "./layers.ts";
import { COMPRESS_TOOL_NAME, DECOMPRESS_TOOL_NAME, SEARCH_TOOL_NAME, STATUS_TOOL_NAME } from "./names.ts";
import { peekModelCompress, scheduleModelCompress } from "./pending.ts";
import { debug } from "../session.ts";

export { COMPRESS_TOOL_NAME, STATUS_TOOL_NAME, DECOMPRESS_TOOL_NAME, SEARCH_TOOL_NAME } from "./names.ts";

const CURSOR_ONLY =
  "This tool is only available while the session route is Cursor (`cursor`). Switch provider or start a Cursor session.";
const CONTEXT_DISABLED =
  "Long-session context management is disabled (Settings → Cursor → enable long-session context).";

function sessionIdOf(exec: { agent?: { session?: { id?: string; requestContext?: () => { provider?: string } | undefined } } }): string | undefined {
  const session = exec.agent?.session;
  const id = session?.id;
  return typeof id === "string" && id ? id : undefined;
}

function assertCursorSession(exec: { agent?: { session?: { id?: string; requestContext?: () => { provider?: string } | undefined } } }): string {
  const id = sessionIdOf(exec);
  if (!id) throw new Error("No DSH session id; persistent compression is disabled.");
  const provider = exec.agent?.session?.requestContext?.()?.provider;
  if (provider && provider !== PROVIDER_ID) throw new Error(CURSOR_ONLY);
  return id;
}

function messagesOf(exec: { agent?: { session?: { deriveMessages?: () => readonly unknown[] } } }): any[] {
  const derived = exec.agent?.session?.deriveMessages?.();
  return derived ? Array.from(derived) : [];
}

export interface ContextToolsDeps {
  contextEnabled?: () => boolean;
  preserveConfig: () => { preserveRecentMessages: number; preserveRecentTokens: number };
  contextWindowForModel: (modelId: string) => number;
  sessionSnapshot: (sessionId: string, session: any, modelId: string) => Record<string, unknown>;
}

function assertContextManagement(deps: ContextToolsDeps): void {
  if (deps.contextEnabled?.() === false) throw new Error(CONTEXT_DISABLED);
}

function pdesc(tool: string, param: string, fallback: string): string {
  return cursorContextParamDescription(param, tool) ?? fallback;
}

function tdesc(tool: string, fallback: string): string {
  return cursorContextToolDescription(tool) ?? fallback;
}

function compressNoop(
  reason: string,
  keepTurns: number,
  droppable: Set<string>,
  keepFrom: number,
  extra?: Record<string, unknown>,
) {
  return {
    status: "noop" as const,
    reason,
    keepTurns,
    preserveKeepFrom: keepFrom,
    compressibleRefs: [...droppable],
    ...extra,
  };
}

export function registerContextTools(ctx: Context, deps: ContextToolsDeps): void {
  const tools: any = (ctx as any).tools;
  if (!tools?.register) return;

  tools.register(
    defineTool({
      name: COMPRESS_TOOL_NAME,
      description: tdesc(
        COMPRESS_TOOL_NAME,
        "Commit a continuation summary and shrink what the Cursor model still holds in its checkpoint. Only on Cursor-routed sessions.",
      ),
      parameters: {
        summary: {
          type: "string",
          required: true,
          description: pdesc(COMPRESS_TOOL_NAME, "summary", "Continuation summary the model will read back instead of the dropped prefix."),
        },
        startRef: {
          type: "string",
          description: pdesc(COMPRESS_TOOL_NAME, "startRef", "Inclusive first message ref to fold (from status)."),
        },
        endRef: {
          type: "string",
          description: pdesc(COMPRESS_TOOL_NAME, "endRef", "Inclusive last message ref to fold (from status)."),
        },
        topic: {
          type: "string",
          description: pdesc(COMPRESS_TOOL_NAME, "topic", "Optional label: plain text or t2:/t3: prefix for tier."),
        },
        keepTurns: {
          type: "integer",
          description: "Advanced override: recent messages to keep verbatim (default = acp protect zone).",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => {
          const v = value as {
            revision?: number;
            status?: string;
            keepTurns?: number;
            startRef?: string | null;
            endRef?: string | null;
            reason?: string;
            clamped?: { reason?: string };
            compressibleRefs?: string[];
          };
          const text =
            v.status === "scheduled"
              ? `Compression scheduled (revision ${v.revision}, keepTurns=${v.keepTurns}${v.startRef ? `, range ${v.startRef}..${v.endRef}` : ""}${v.clamped?.reason ? `; ${v.clamped.reason}` : ""}). Checkpoint rewrite runs after this tool-result batch.`
              : v.status === "noop"
                ? `Nothing to compress (${v.reason ?? "no droppable range"}). keepTurns=${v.keepTurns}${v.compressibleRefs?.length ? `; compressibleRefs=${v.compressibleRefs.join(",")}` : ""}.`
                : JSON.stringify(value);
          return [{ type: "text", text }];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertContextManagement(deps);
        const sessionId = assertCursorSession(exec);
        const summary = String(args.summary ?? "").trim();
        if (summary.length < 32) {
          throw new Error("summary is too short; include enough detail to resume the task (at least 32 characters).");
        }
        const messages = messagesOf(exec);
        const snap = exec.agent?.session;
        const modelId = snap?.requestContext?.()?.model ?? "unknown";
        const window = deps.contextWindowForModel(modelId);
        const tokenCount = estimateTranscript("", [], messages);
        const snapshot = deps.sessionSnapshot(sessionId, snap, modelId) as { compactedAt?: number; viewPending?: boolean };
        syncMessageRefs(sessionId, messages, {
          tokenCount,
          contextWindow: window,
          compactedAt: snapshot.compactedAt ?? 0,
          preserve: deps.preserveConfig(),
        });
        const plan = kernelTurnPlan(sessionId, messages, tokenCount, window, {
          compactedAt: snapshot.compactedAt ?? 0,
          preserve: deps.preserveConfig(),
        });
        const keepTurns = args.keepTurns ?? plan.keepTurns;
        const keepFrom = args.keepTurns != null ? Math.max(0, messages.length - keepTurns) : plan.keepFromIndex;
        const startRef = args.startRef?.trim();
        const endRef = args.endRef?.trim();
        const droppable = new Set(compressibleRefs(sessionId, snapshot.compactedAt ?? 0, keepFrom).map((r) => r.ref));
        if ((startRef && !endRef) || (!startRef && endRef)) {
          return compressNoop("startRef and endRef must both be set or both omitted", keepTurns, droppable, keepFrom);
        }
        if (snapshot.viewPending) {
          return compressNoop("compression already scheduled; wait for handoff before scheduling again", keepTurns, droppable, keepFrom);
        }
        let refRange: CompressRefRange | undefined;
        let refClamp: { requested: { startRef: string; endRef: string }; reason: string } | undefined;
        let rangeStart = startRef;
        let rangeEnd = endRef;
        if (startRef && endRef) {
          const resolved = resolveCompressRefRange(
            sessionId,
            startRef,
            endRef,
            snapshot.compactedAt ?? 0,
            keepFrom,
            droppable,
          );
          if (resolved.ok === false) {
            return compressNoop(resolved.reason, keepTurns, droppable, keepFrom, { startRef, endRef });
          }
          refRange = resolved.refRange;
          refClamp = resolved.clamped;
          rangeStart = resolved.refRange.startRef;
          rangeEnd = resolved.refRange.endRef;
        }
        const previousSummary = String((snapshot as { previousSummary?: string }).previousSummary ?? "");
        if (
          !planCompaction({
            messages,
            compactedAt: snapshot.compactedAt ?? 0,
            keepTurns,
            previousSummary,
            refRange,
          })
        ) {
          return compressNoop("nothing to fold between compactedAt and the protect tail", keepTurns, droppable, keepFrom, {
            startRef: rangeStart ?? null,
            endRef: rangeEnd ?? null,
          });
        }
        resolveCompressionLayer(args.topic);
        const pending = scheduleModelCompress(sessionId, summary, {
          keepTurns,
          topic: args.topic,
          startRef: rangeStart,
          endRef: rangeEnd,
        });
        debug(`model-compress scheduled key=${sessionId.slice(0, 12)} rev=${pending.revision}`);
        return {
          revision: pending.revision,
          status: "scheduled",
          keepTurns: pending.keepTurns,
          startRef: pending.startRef ?? null,
          endRef: pending.endRef ?? null,
          clamped: refClamp ?? null,
        };
      },
    }),
  );

  tools.register(
    defineTool({
      name: STATUS_TOOL_NAME,
      description: tdesc(
        STATUS_TOOL_NAME,
        "Show Cursor context state (like acp_status): generation, kernel compressible/protected ranges, refs, budget estimate, ledger.",
      ),
      parameters: {},
      output: {
        schema: { type: "json" },
        render: (_args, value) => {
          const v = value as { panel?: string };
          const blocks: { type: "text"; text: string }[] = [];
          if (v.panel) blocks.push({ type: "text", text: v.panel });
          blocks.push({ type: "text", text: JSON.stringify(value, null, 2) });
          return blocks;
        },
      },
      async execute(_args, exec) {
        assertContextManagement(deps);
        const sessionId = sessionIdOf(exec);
        const session = exec.agent?.session;
        const provider = session?.requestContext?.()?.provider ?? "unknown";
        const modelId = session?.requestContext?.()?.model ?? "unknown";
        if (!sessionId || provider !== PROVIDER_ID) {
          return { provider, error: sessionId ? CURSOR_ONLY : "no session id" };
        }
        const messages = messagesOf(exec);
        const window = deps.contextWindowForModel(modelId);
        const snap = deps.sessionSnapshot(sessionId, session, modelId) as { compactedAt?: number };
        syncMessageRefs(sessionId, messages, {
          contextWindow: window,
          compactedAt: snap.compactedAt ?? 0,
          preserve: deps.preserveConfig(),
        });
        const p = peekModelCompress(sessionId);
        return {
          ...deps.sessionSnapshot(sessionId, session, modelId),
          ledger: ledgerStats(sessionId),
          pending: p
            ? {
                revision: p.revision,
                keepTurns: p.keepTurns,
                at: p.at,
                topic: p.topic ?? null,
                startRef: p.startRef ?? null,
                endRef: p.endRef ?? null,
                summaryChars: p.summary.length,
              }
            : null,
        };
      },
    }),
  );

  tools.register(
    defineTool({
      name: DECOMPRESS_TOOL_NAME,
      description: tdesc(
        DECOMPRESS_TOOL_NAME,
        "Page through archived原文 from a past compression. Use chunkId or message ref; offset/limit paginate UTF-8 text.",
      ),
      parameters: {
        ref: { type: "string", description: "Message ref inside an archive chunk." },
        chunkId: {
          type: "string",
          description: pdesc(DECOMPRESS_TOOL_NAME, "chunkId", "Archive chunk id (c00001…) from search or status."),
        },
        offset: {
          type: "integer",
          description: pdesc(DECOMPRESS_TOOL_NAME, "offset", "Character offset into archived text (default 0)."),
        },
        limit: {
          type: "integer",
          description: pdesc(DECOMPRESS_TOOL_NAME, "limit", "Max characters to return (default 8000, max 32000)."),
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        assertContextManagement(deps);
        const sessionId = assertCursorSession(exec);
        const page = decompressChunk({
          sessionId,
          ref: args.ref,
          chunkId: args.chunkId,
          offset: args.offset,
          limit: args.limit,
        });
        if (!page) throw new Error("No archived chunk found for that ref/chunkId.");
        return page;
      },
    }),
  );

  tools.register(
    defineTool({
      name: SEARCH_TOOL_NAME,
      description: tdesc(
        SEARCH_TOOL_NAME,
        "Search archived compression原文 for a query string; returns snippets and chunk ids.",
      ),
      parameters: {
        query: {
          type: "string",
          required: true,
          description: pdesc(SEARCH_TOOL_NAME, "query", "Case-insensitive substring search."),
        },
        limit: { type: "integer", description: "Max hits (default 20)." },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        assertContextManagement(deps);
        const sessionId = assertCursorSession(exec);
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("query is required.");
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 100);
        return { hits: searchArchive(sessionId, query, limit) };
      },
    }),
  );
}
