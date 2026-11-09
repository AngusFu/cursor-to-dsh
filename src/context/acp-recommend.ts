/**
 * acp-kernel recommendation helpers (same algorithms as recommend.ts).
 * The published package bundles these inside index.js but does not export them yet.
 */
import { computeIntegrityWithdrawals } from "./acp-integrity.ts";
import {
  SUMMARY_HEADER,
  collectLatestProtected,
  countMessageTokens,
  coveredMessageIds,
  hasMediaPayload,
  isMessageLatestProtected,
  isMessageProtected,
  isToolMessage,
  matchToolPattern,
  segmentGroups,
  type CompressibleRange,
  type CompressionState,
  type Config,
  type ContextRanges,
  type CoreMessage,
} from "acp-kernel";

const NEVER_PRESERVE_RECENT_TOOLS = ["decompress", "search_context", "read", "bash"] as const;

function isNeverPreserveRecent(
  msg: CoreMessage,
  patterns?: readonly string[],
  preservePatterns?: readonly string[],
): boolean {
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result") return false;
  if (!msg.toolName) return false;
  const base = patterns === undefined ? NEVER_PRESERVE_RECENT_TOOLS : patterns;
  const list =
    preservePatterns === undefined || preservePatterns.length === 0
      ? base
      : base.filter((tool) => !preservePatterns.some((p) => matchToolPattern(tool, p)));
  for (const pattern of list) {
    if (matchToolPattern(msg.toolName, pattern)) return true;
  }
  return false;
}

function collectProtectedToolCallIds(messages: CoreMessage[], config: Pick<Config, "protectedTools" | "isToolProtected">): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId && isMessageProtected(m, config)) ids.add(m.toolCallId);
  }
  return ids;
}

function isMessageProtectedWithPairing(
  msg: CoreMessage,
  config: Pick<Config, "protectedTools" | "isToolProtected">,
  protectedCallIds: Set<string>,
): boolean {
  if (isMessageProtected(msg, config)) return true;
  if (msg.contentType === "tool-result" && msg.toolCallId && protectedCallIds.has(msg.toolCallId)) return true;
  return false;
}

function isSyntheticOrPruned(message: CoreMessage, covered: Set<string>): boolean {
  if (message.text?.startsWith(SUMMARY_HEADER)) return true;
  return covered.has(message.id);
}

/** Soft-protected tail refs (preserveRecentMessages + preserveRecentTokens + last user). */
export function computeProtectedRefs(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  countTokens?: (text: string) => number,
): Set<string> {
  const preserveN = config.preserveRecentMessages;
  const preserveTokens = config.preserveRecentTokens;
  const covered = coveredMessageIds(state);
  const result = new Set<string>();
  const visible: { ref: string; tokens: number }[] = [];
  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, covered)) continue;
    if (isNeverPreserveRecent(msg, config.neverPreserveRecentTools, config.preserveRecentTools)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    visible.push({ ref, tokens: countMessageTokens(msg, countTokens) });
  }
  if (preserveN > 0) {
    for (const m of visible.slice(-preserveN)) result.add(m.ref);
  }
  if (preserveTokens > 0) {
    let tokenAccum = 0;
    for (let i = visible.length - 1; i >= 0 && tokenAccum < preserveTokens; i--) {
      result.add(visible[i]!.ref);
      tokenAccum += visible[i]!.tokens;
    }
  }
  if (preserveN > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role !== "user" || isSyntheticOrPruned(msg, covered)) continue;
      const ref = state.messageRefs.byRaw[msg.id];
      if (ref && ref !== "BLOCKED") result.add(ref);
      break;
    }
  }
  return result;
}

/** Compressible / protected range groups for status + nudge surfaces. */
export function buildCompressibleRanges(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  protectedZoneRefs?: Set<string>,
  countTokens?: (text: string) => number,
): ContextRanges {
  type MsgInfo = {
    id: string;
    ref: string;
    gapBefore: boolean;
    tokens: number;
    chars: number;
    isTool: boolean;
    isUser: boolean;
    index: number;
  };
  const compressibleMsgs: MsgInfo[] = [];
  const protectedMsgs: {
    ref: string;
    gapBefore: boolean;
    tokens: number;
    tools: string[];
    index: number;
  }[] = [];
  const covered = coveredMessageIds(state);
  const protectedCallIds = collectProtectedToolCallIds(messages, config);
  const latest = collectLatestProtected(messages, config);
  for (const id of latest.callIds) protectedCallIds.add(id);
  let skipSinceCompressible = false;
  let skipSinceProtected = false;
  let msgIndex = -1;
  for (const msg of messages) {
    msgIndex++;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    if (isSyntheticOrPruned(msg, covered)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }
    if (hasMediaPayload(msg)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }
    if (isMessageProtectedWithPairing(msg, config, protectedCallIds) || isMessageLatestProtected(msg, latest)) {
      protectedMsgs.push({
        ref,
        gapBefore: skipSinceProtected,
        tokens: countMessageTokens(msg, countTokens),
        tools: msg.toolName ? [msg.toolName] : [],
        index: msgIndex,
      });
      skipSinceProtected = false;
      skipSinceCompressible = true;
      continue;
    }
    if (protectedZoneRefs?.has(ref)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }
    compressibleMsgs.push({
      id: msg.id,
      ref,
      gapBefore: skipSinceCompressible,
      tokens: countMessageTokens(msg, countTokens),
      chars: (msg.text ?? "").length,
      isTool: isToolMessage(msg),
      isUser: msg.role === "user",
      index: msgIndex,
    });
    skipSinceCompressible = false;
    skipSinceProtected = true;
  }
  const unfoldedIds = computeIntegrityWithdrawals(
    messages,
    new Set(compressibleMsgs.map((info) => info.id)),
  ).withdrawn;
  if (unfoldedIds.size > 0) {
    let gapPending = false;
    const kept: MsgInfo[] = [];
    for (const info of compressibleMsgs) {
      if (unfoldedIds.has(info.id)) {
        gapPending = true;
        continue;
      }
      kept.push(gapPending ? { ...info, gapBefore: true } : info);
      gapPending = false;
    }
    compressibleMsgs.length = 0;
    compressibleMsgs.push(...kept);
  }
  const compressible: CompressibleRange[] = [];
  for (const group of segmentGroups(compressibleMsgs)) {
    const first = group[0]!;
    const range: CompressibleRange = {
      startRef: first.ref,
      endRef: first.ref,
      startIndex: first.index,
      endIndex: first.index,
      count: 1,
      tokens: first.tokens,
      chars: first.chars,
      toolPct: first.isTool ? 100 : 0,
      textPct: first.isTool ? 0 : 100,
      userMsgs: first.isUser ? 1 : 0,
    };
    for (let i = 1; i < group.length; i++) {
      const info = group[i]!;
      range.endRef = info.ref;
      range.endIndex = info.index;
      range.count = (range.count ?? 1) + 1;
      range.tokens += info.tokens;
      range.chars = (range.chars ?? 0) + info.chars;
      if (info.isUser) range.userMsgs = (range.userMsgs ?? 0) + 1;
      if (info.isTool) {
        range.toolPct = Math.round(((range.toolPct ?? 0) * ((range.count ?? 1) - 1) + 100) / (range.count ?? 1));
      } else {
        range.toolPct = Math.round(((range.toolPct ?? 0) * ((range.count ?? 1) - 1)) / (range.count ?? 1));
      }
      range.textPct = 100 - (range.toolPct ?? 0);
    }
    compressible.push(range);
  }
  const protectedRanges: ContextRanges["protected"] = [];
  let pcur: (typeof protectedRanges)[number] | null = null;
  for (const info of protectedMsgs) {
    if (pcur && info.gapBefore) {
      protectedRanges.push(pcur);
      pcur = null;
    }
    if (!pcur) {
      pcur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        tools: [...info.tools],
        startIndex: info.index,
        endIndex: info.index,
      };
    } else {
      pcur.endRef = info.ref;
      pcur.endIndex = info.index;
      pcur.count++;
      pcur.tokens += info.tokens;
      for (const t of info.tools) {
        if (!pcur.tools.includes(t)) pcur.tools.push(t);
      }
    }
  }
  if (pcur) protectedRanges.push(pcur);
  return {
    compressible: compressible.filter((g) => g.tokens > 0),
    protected: protectedRanges,
  };
}
