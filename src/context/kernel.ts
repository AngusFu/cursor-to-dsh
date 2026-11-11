/**
 * acp-kernel adapter (billion-context alignment): refs, protect zone, nudge, blocks.
 */
import {
  createContentStore,
  coveredMessageIds,
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

import { incrementText, textOf, estimateTextTokens } from "../prompt.ts";
import { loadContentStore, loadKernelState, persistContentStore, persistKernelState } from "./ledger-persist.ts";
import { contextMessages, contextMessageKey, coreMessageOwner } from "./message-shape.ts";
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
  /** Each semantic piece, indexed back to its owning DSH message. */
  messageRefs: { ref: string; index: number; fingerprint: string; text: string; ownerKey: string }[];
  coveredIndexes: Set<number>;
  coveredCoreIds: Set<string>;
  compactedPrefix: number;
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

export function toCoreMessages(messages: readonly any[]): CoreMessage[] {
  return contextMessages(messages).flatMap((m) => {
    const id = contextMessageKey(m);
    if (m.role === "toolResult") {
      return [{ id, role: "tool", contentType: "tool-result", text: textOf(m.content), toolName: m.toolName, toolCallId: m.toolCallId } satisfies CoreMessage];
    }
    if (m.role !== "assistant") {
      return [{ id, role: "user", contentType: "text", text: incrementText(m) } satisfies CoreMessage];
    }
    const blocks = m.content ?? [];
    const calls = blocks.filter((b: any) => b.type === "toolCall");
    if (!calls.length) return [{ id, role: "assistant", contentType: blocks.some((b: any) => b.type === "thinking") ? "reasoning" : "text", text: textOf(blocks) } satisfies CoreMessage];
    const parts: CoreMessage[] = [];
    const text = textOf(blocks);
    if (text) parts.push({ id: `${id}:text`, role: "assistant", contentType: "text", text });
    for (const [index, b] of calls.entries()) {
      parts.push({ id: index === 0 ? id : `${id}:call:${index}`, role: "assistant", contentType: "tool-call", text: JSON.stringify(b.arguments ?? {}), toolName: b.name, toolCallId: b.id });
    }
    return parts;
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
  if (preserve || hit.config.modelContextLimit !== contextWindow) hit.config = acpConfig(contextWindow, preserve);
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
  messages = contextMessages(messages);
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

  const owners = new Map(messages.map((m, i) => [contextMessageKey(m), i]));
  const covered = coveredMessageIds(sk.state);
  const coveredIndexes = new Set<number>();
  const messageRefs: KernelTurnPlan["messageRefs"] = [];
  const coverageByIndex = new Map<number, boolean>();
  let keepFromIndex = messages.length;
  for (const cm of coreMessages) {
    const ownerKey = coreMessageOwner(cm.id);
    const index = owners.get(ownerKey)!;
    coverageByIndex.set(index, (coverageByIndex.get(index) ?? true) && covered.has(cm.id));
    const ref = byRaw[cm.id];
    if (ref && ref !== "BLOCKED") messageRefs.push({ ref, index, fingerprint: cm.id, ownerKey, text: cm.contentType === "tool-call" ? `calls ${cm.toolName} (${cm.toolCallId}) with ${cm.text}` : cm.text ?? "" });
    if (ref && protectedRefs.has(ref)) keepFromIndex = Math.min(keepFromIndex, index);
  }
  for (const [index, fullyCovered] of coverageByIndex) {
    if (fullyCovered) coveredIndexes.add(index);
  }
  let compactedPrefix = 0;
  while (coveredIndexes.has(compactedPrefix)) compactedPrefix++;
  const keepTurns = Math.max(1, messages.length - keepFromIndex);

  flushKernelState(sessionId);
  return {
    keepFromIndex,
    keepTurns,
    compressibleRanges: contextRanges.compressible,
    protectedRanges: contextRanges.protected,
    refsByFingerprint,
    messageRefs,
    coveredIndexes,
    coveredCoreIds: covered,
    compactedPrefix,
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

/** Prepare without publishing: no transport side effects on a kernel rejection. */
export function prepareKernelCompression(
  sessionId: string,
  messages: readonly any[],
  opts: { startRef: string; endRef: string; summary: string; topic?: string; revision: number },
  contextWindow: number,
  preserve?: AcpPreserveConfig,
) {
  const sk = sessionKernel(sessionId, contextWindow, preserve);
  const before = sk.appliedRevision;
  const coreMessages = toCoreMessages(messages);
  const out = core.applyCompression({
    ranges: [{ startRef: opts.startRef, endRef: opts.endRef, summary: opts.summary, topic: opts.topic ?? `T${tierOfTopic(opts.topic)}` }],
    messages: coreMessages, state: sk.state, config: sk.config,
  });
  if (out.result.errors.length || out.result.blocksCreated !== 1) throw new Error(`Kernel compression rejected: ${out.result.errors.join("; ") || "no block created"}`);
  const oldIds = coveredMessageIds(sk.state);
  const covered = coveredMessageIds(out.state);
  const newIds = new Set([...covered].filter((id) => !oldIds.has(id)));
  const processed = core.processTurn({ messages: coreMessages, state: out.state, config: sk.config, tokenCount: sk.lastTokenCount, renderTags: "text-only", contentStore: structuredClone(sk.contentStore) });
  return {
    newIds, view: buildAcpWireView(processed.messages),
    commit() {
      if (sk.appliedRevision !== before) throw new Error("Kernel compression changed while transport was preparing");
      sk.state = processed.state;
      sk.contentStore = processed.contentStore;
      sk.appliedRevision = opts.revision;
      flushKernelState(sessionId);
    },
  };
}

export function kernelApplyCompression(
  sessionId: string,
  messages: readonly any[],
  opts: { startRef: string; endRef: string; summary: string; topic?: string; revision: number },
  contextWindow: number,
  preserve?: AcpPreserveConfig,
): void {
  prepareKernelCompression(sessionId, messages, opts, contextWindow, preserve).commit();
}

/** Budget comes from the same kernel model view as transport, never a prefix cursor. */
export function kernelResidentTokens(sessionId: string, messages: readonly any[], system: string, tools: any[], contextWindow: number): number {
  const plan = kernelTurnPlan(sessionId, messages, sessionKernel(sessionId, contextWindow).lastTokenCount, contextWindow);
  return estimateTextTokens(system) + estimateTextTokens(JSON.stringify(tools)) + plan.wireMessages.reduce((n, m) => n + estimateTextTokens(m.text ?? ""), 0);
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
