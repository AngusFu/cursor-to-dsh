/**
 * Compaction summariser.
 *
 * The dropped prefix of a Cursor conversation is compressed to plain text by
 * an ordinary DSH model call — any registered provider, not necessarily
 * Cursor — and the result is rendered into the next user message. That keeps
 * compaction off Cursor's quota, avoids building a throwaway Cursor agent as a
 * sidecar, and needs no `purpose` (the only values DSH defines are
 * `'compaction'` and `'session-title'`, and neither may be borrowed).
 *
 * Pure: no SDK access, no DSH runtime access. The caller supplies the history
 * and consumes the returned messages, so this stays unit-testable.
 */
import type { RequestMessage } from "@deepseek-ai/dsh-llm";

/**
 * Marks machine-produced compaction text so it reads as background rather
 * than as a fresh instruction from the human.
 */
export const SUMMARY_PREFIX = "CONTEXT SUMMARY (earlier turns compacted):";

/** Guard rail: a summariser that rambles is worse than one that gives up. */
export const MAX_SUMMARY_TOKENS = 4_096;

export interface SummaryRequest {
  /**
   * Text form of the history being dropped. The retained tail is *not*
   * included — it stays verbatim in the checkpoint.
   */
  readonly history: string;
}

/**
 * Prompt for the summariser.
 *
 * Everything lives in a single user message: `SystemMessage` requires a
 * `source` from the system-prompt producer, which this plugin does not own,
 * and `RequestUserInput` deliberately leaves `source` absent.
 */
export function renderSummaryMessages(request: SummaryRequest): RequestMessage[] {
  const history = request.history.trim() || "(empty)";
  const text = [
    "Compact the conversation history below into a continuation summary for a coding agent that is about to resume this work.",
    "",
    "Preserve: the user's goals, decisions and constraints; important file paths, identifiers and commands; pending tasks; tool results that still matter; unresolved errors.",
    "Drop: pleasantries, superseded attempts, repetition, and narration of what already happened.",
    "",
    "Rules:",
    "- Write in the same language as the conversation.",
    "- Do not answer the original request and do not take any new action.",
    "- If part of the history is already a compaction summary, fold it in instead of summarizing it again.",
    "- Output only the summary: no preamble, no markdown fence, no \"Summary:\" heading.",
    "",
    "--- HISTORY ---",
    history,
  ].join("\n");
  return [{ role: "user", content: [{ type: "text", text }] }];
}

/**
 * Pull the assembled prose out of a `StreamChunk` stream.
 *
 * Reasoning deltas are skipped on purpose: they are not part of what the
 * model will read back later, and folding them in would make compaction both
 * noisier and more expensive.
 */
export async function collectSummaryText(
  chunks: AsyncIterable<{ type: string; text?: string }>,
): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of chunks) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") parts.push(chunk.text);
  }
  return parts.join("").trim();
}

/**
 * Cache key for a summariser choice. `""` means "follow the session's own
 * provider/model", so the key must stay distinct from any explicit id.
 */
export function summarizerModelKey(provider: string, model: string): string {
  return `${provider || "*"}:${model || "*"}`;
}
