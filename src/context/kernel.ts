/**
 * acp-kernel adapter (billion-context alignment): refs, protect zone, nudge, blocks.
 */
import {
  createContentStore,
  createCore,
  createInitialState,
  defaultConfig,
  renderNudgeText,
  resolvePrompts,
  type CompressibleRange,
  type CompressionState,
  type Config,
  type CoreMessage,
  type MessageContentStore,
  type NudgeDecision,
  type CompressionBlock,
  type ProtectedRange,
} from "acp-kernel";
import { buildCompressibleRanges, computeProtectedRefs } from "./acp-recommend.ts";
import { buildAcpWireView, type AcpWireView } from "./acp-wire.ts";

import { fingerprint, incrementText, textOf } from "../prompt.ts";
import { loadContentStore, loadKernelState, persistContentStore, persistKernelState } from "./ledger-persist.ts";
import { resolveCompressionLayer } from "./layers.ts";

const core = createCore({
  countTokens: (text) => Math.max(1, Math.ceil(text.length / 4)),
});

export interface AcpPreserveConfig {
  preserveRecentMessages?: number;
  preserveRecentTokens?: number;
}

export interface KernelTurnPlan {
  keepFromIndex: number;
  keepTurns: number;
  compressibleRanges: CompressibleRange[];
  protectedRanges: ProtectedRange[];
  refsByFingerprint: Map<string, string>;
  /** Full model view after processTurn (filter / truncate / tags / …). */
  wireMessages: CoreMessage[];
  /** Wire text for user/developer messages after acp render-refs (text-only). */
  taggedTextByFingerprint: Map<string, string>;
  nudge?: NudgeDecision;
}

interface SessionKernel {
  state: CompressionState;
  config: Config;
  contentStore: MessageContentStore;
  appliedRevision: number;
  lastTokenCount: number;
}

const SESSIONS = new Map<string, SessionKernel>();

function tierOfTopic(topic?: string): 1 | 2 | 3 {
  const layer = resolveCompressionLayer(topic);
  if (layer === "T3") return 3;
  if (layer === "T2") return 2;
  return 1;
}

function roleOf(m: any): CoreMessage["role"] {
  const r = String(m?.role ?? "user");
  if (r === "assistant" || r === "system" || r === "tool") return r;
  return "user";
}

export function toCoreMessages(messages: readonly any[]): CoreMessage[] {
  return messages.map((m) => {
    const text = incrementText(m) || textOf(m?.content) || "";
    const role = roleOf(m);
    let contentType: CoreMessage["contentType"] = "text";
    let toolName: string | undefined;
    let toolCallId: string | undefined;
    if (role === "tool") {
      contentType = "tool-result";
      toolName = m.toolName;
      toolCallId = m.toolCallId;
    } else if (role === "assistant" && Array.isArray(m?.content)) {
      const blocks = m.content;
      const toolCall = blocks.find((p: any) => p?.type === "toolCall");
      if (toolCall) {
        contentType = "tool-call";
        toolName = toolCall.name;
        toolCallId = toolCall.id;
      } else if (blocks.some((p: any) => p?.type === "thinking")) {
        contentType = "reasoning";
      }
    }
    return { id: fingerprint(m), role, contentType, text, toolName, toolCallId };
  });
}

function acpConfig(contextWindow: number, preserve?: AcpPreserveConfig): Config {
  const overrides: Partial<Config> = {};
  if (preserve?.preserveRecentMessages !== undefined) {
    overrides.preserveRecentMessages = preserve.preserveRecentMessages;
  }
  if (preserve?.preserveRecentTokens !== undefined) {
    overrides.preserveRecentTokens = preserve.preserveRecentTokens;
  }
  return defaultConfig(contextWindow, overrides);
}

function sessionKernel(sessionId: string, contextWindow: number, preserve?: AcpPreserveConfig): SessionKernel {
  let hit = SESSIONS.get(sessionId);
  if (!hit) {
    const stored = loadKernelState(sessionId);
    hit = {
      state: stored?.state ?? createInitialState(),
      config: acpConfig(contextWindow, preserve),
      contentStore: loadContentStore(sessionId) ?? createContentStore(),
      appliedRevision: stored?.appliedRevision ?? 0,
      lastTokenCount: stored?.lastTokenCount ?? 0,
    };
    SESSIONS.set(sessionId, hit);
  }
  hit.config = acpConfig(contextWindow, preserve);
  return hit;
}

export function flushKernelState(sessionId: string): void {
  const hit = SESSIONS.get(sessionId);
  if (!hit) return;
  persistKernelState(sessionId, {
    state: hit.state,
    appliedRevision: hit.appliedRevision,
    lastTokenCount: hit.lastTokenCount,
  });
  persistContentStore(sessionId, hit.contentStore);
}

/**
 * One acp `processTurn` + protect/compressible ranges — source of truth for tail policy.
 * Default protect zone matches acp-kernel: 5 recent messages + 5000 recent tokens.
 */
/** Inputs for acp `buildStatusPanel` without rendering. */
export function kernelPanelInputs(
  sessionId: string,
  messages: readonly any[],
  tokenCount: number,
  contextWindow: number,
  preserve?: AcpPreserveConfig,
  opts?: { compactedAt?: number },
): {
  state: CompressionState;
  nudge?: NudgeDecision;
  modelContextLimit: number;
} {
  const plan = kernelTurnPlan(sessionId, messages, tokenCount, contextWindow, {
    compactedAt: opts?.compactedAt,
    preserve,
  });
  const sk = sessionKernel(sessionId, contextWindow, preserve);
  return {
    state: sk.state,
    nudge: plan.nudge,
    modelContextLimit: sk.config.modelContextLimit,
  };
}

export function kernelTurnPlan(
  sessionId: string,
  messages: readonly any[],
  tokenCount: number,
  contextWindow: number,
  opts?: { compactedAt?: number; preserve?: AcpPreserveConfig },
): KernelTurnPlan {
  const sk = sessionKernel(sessionId, contextWindow, opts?.preserve);
  const coreMessages = toCoreMessages(messages);
  const result = core.processTurn({
    messages: coreMessages,
    state: sk.state,
    config: sk.config,
    tokenCount,
    renderTags: "text-only",
    contentStore: sk.contentStore,
  });
  sk.state = result.state;
  sk.contentStore = result.contentStore;
  sk.lastTokenCount = Math.max(0, Math.floor(Number(tokenCount)));

  const taggedTextByFingerprint = new Map<string, string>();
  for (const m of result.messages) {
    const text = m.text?.trim();
    if (text) taggedTextByFingerprint.set(m.id, text);
  }

  const byRaw = result.state.messageRefs?.byRaw ?? {};
  const refsByFingerprint = new Map<string, string>();
  for (const m of coreMessages) {
    const ref = byRaw[m.id];
    if (ref) refsByFingerprint.set(m.id, ref);
  }

  const countTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
  const protectedRefs = computeProtectedRefs(coreMessages, result.state, sk.config, countTokens);
  const contextRanges = buildCompressibleRanges(coreMessages, result.state, sk.config, protectedRefs, countTokens);

  let keepFromIndex = messages.length;
  for (let i = 0; i < coreMessages.length; i++) {
    const ref = byRaw[coreMessages[i]!.id];
    if (ref && protectedRefs.has(ref)) keepFromIndex = Math.min(keepFromIndex, i);
  }
  keepFromIndex = Math.max(opts?.compactedAt ?? 0, keepFromIndex);
  const keepTurns = Math.max(1, messages.length - keepFromIndex);

  flushKernelState(sessionId);
  return {
    keepFromIndex,
    keepTurns,
    compressibleRanges: contextRanges.compressible,
    protectedRanges: contextRanges.protected,
    refsByFingerprint,
    wireMessages: result.messages,
    taggedTextByFingerprint,
    nudge: result.nudge,
  };
}

/** Live acp model view for the Cursor wire (undefined when kernel idle). */
export function acpWireViewForSend(
  sessionId: string,
  messages: readonly any[],
  systemPrompt: string,
  tools: readonly any[],
  tokenCount: number,
  contextWindow: number,
  preserve?: AcpPreserveConfig,
  compactedAt?: number,
): AcpWireView | undefined {
  if (!sessionId || sessionId.startsWith("anon:")) return undefined;
  const plan = kernelTurnPlan(sessionId, messages, tokenCount, contextWindow, { compactedAt, preserve });
  return buildAcpWireView(plan.wireMessages);
}

export function kernelNudgeForTurn(
  sessionId: string,
  messages: readonly any[],
  tokenCount: number,
  contextWindow: number,
  preserve?: AcpPreserveConfig,
): string | undefined {
  const plan = kernelTurnPlan(sessionId, messages, tokenCount, contextWindow, { preserve });
  if (!plan.nudge?.shouldInject) return undefined;
  return renderNudgeText(plan.nudge, resolvePrompts()).text;
}

export function kernelApplyCompression(
  sessionId: string,
  messages: readonly any[],
  opts: { startRef: string; endRef: string; summary: string; topic?: string; revision: number },
  contextWindow: number,
  preserve?: AcpPreserveConfig,
): void {
  const sk = sessionKernel(sessionId, contextWindow, preserve);
  const tier = tierOfTopic(opts.topic);
  const coreMessages = toCoreMessages(messages);
  const ranges = [
    {
      startRef: opts.startRef,
      endRef: opts.endRef,
      summary: opts.summary,
      topic: opts.topic ?? `T${tier}`,
    },
  ];
  const out = core.applyCompression({
    ranges,
    messages: coreMessages,
    state: sk.state,
    config: sk.config,
  });
  sk.state = out.state;
  sk.appliedRevision = opts.revision;
  flushKernelState(sessionId);
}

export function kernelStatus(sessionId: string, contextWindow: number, tokenCount: number, preserve?: AcpPreserveConfig) {
  const sk = sessionKernel(sessionId, contextWindow, preserve);
  return core.status(sk.state, tokenCount, sk.config);
}

export function kernelAppliedRevision(sessionId: string): number {
  return SESSIONS.get(sessionId)?.appliedRevision ?? loadKernelState(sessionId)?.appliedRevision ?? 0;
}

/** When acp nudge tier is 2|3 with target blocks, plan block-boundary distillation. */
export function kernelTierDistillPlan(
  sessionId: string,
  messages: readonly any[],
  tokenCount: number,
  contextWindow: number,
  preserve?: AcpPreserveConfig,
): {
  tier: 2 | 3;
  startRef: string;
  endRef: string;
  sourceText: string;
  topic: string;
  blocks: CompressionBlock[];
} | undefined {
  const plan = kernelTurnPlan(sessionId, messages, tokenCount, contextWindow, { preserve });
  const nudge = plan.nudge;
  if (!nudge?.shouldInject || (nudge.tier !== 2 && nudge.tier !== 3)) return undefined;
  const blocks = nudge.tierTargetBlocks;
  if (!blocks?.length) return undefined;
  const startRef = blocks[0]!.blockId;
  const endRef = blocks[blocks.length - 1]!.blockId;
  const sourceText = blocks.map((b) => b.summary).join("\n\n");
  const topic = nudge.tier === 3 ? "t3:auto" : "t2:auto";
  return { tier: nudge.tier, startRef, endRef, sourceText, topic, blocks };
}

/** Test hook. */
export function clearKernelSessions(): void {
  SESSIONS.clear();
}
