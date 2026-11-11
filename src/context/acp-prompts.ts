/**
 * acp-kernel load-bearing prompts for Cursor sessions (philosophy + rules + tags).
 */
import { buildCompressSystemPrompt, resolvePrompts } from "acp-kernel";

export const ACP_SYSTEM_MARKER = "[acp-context]";

const DSH_TOOLS_SECTION = `TOOLS (DSH · Cursor route)

- cursor_context_compress — Replace a contiguous range of older conversation with a continuation summary you write. Required summary (≥32 chars). Optional inclusive startRef/endRef from cursor_context_status (e.g. m00005..m00020). Optional topic (t2:/t3: for tier). Optional keepTurns override. Do not call when status shows no compressible ranges.
- cursor_context_status — Context status with compressible/protected ranges, refs, and budget. Call before compress to pick refs.
- cursor_context_decompress — Page archived原文 from a past compression (ref or chunkId). Pass imageRef (an mNNNNN ref) to restore a folded image to a file you open with the read tool; imageRef:"list" shows what is restorable.
- cursor_context_search — Search archived compression text by keyword.

Use ref IDs from <acp> tags in the transcript or from status (mNNNNN). Never echo the <acp> XML tags in your replies.

Do NOT call billion-context (bili-native) tools on Cursor-routed sessions: compress, decompress, search_context, acp_status. They target a different pipeline and do not shrink the Cursor checkpoint. On this route, context management is only via cursor_context_* above.`;

/** Standing acp block for DSH system prompt / Cursor wire (marker + philosophy + rules + tags). */
export function acpContextSectionText(): string {
  const block = buildCompressSystemPrompt(resolvePrompts(), { tools: DSH_TOOLS_SECTION });
  if (!block.trim()) return "";
  return [ACP_SYSTEM_MARKER, block].filter(Boolean).join("\n\n");
}

/** Legacy: append standing block onto a system prompt string (tests / non-DSH wire). Prefer `registerAcpContextPrompt`. */
export function acpSystemPromptAddition(base: string): string {
  const trimmed = base.trim();
  const section = acpContextSectionText();
  if (!section) return trimmed;
  if (trimmed.includes(ACP_SYSTEM_MARKER)) return trimmed;
  if (trimmed.includes(section.slice(0, 48))) return trimmed;
  return [trimmed, section].filter(Boolean).join("\n\n");
}
