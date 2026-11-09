/**
 * acp-kernel status panel (billion-context-style dashboard text, local only).
 */
import { createRequire } from "node:module";

import { defaultCountTokens } from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import type { CompressionState, NudgeDecision } from "acp-kernel";

import { kernelPanelInputs, toCoreMessages, type AcpPreserveConfig } from "./kernel.ts";
import { loadKernelState } from "./ledger-persist.ts";
import { estimateTranscript, estimateTextTokens } from "../prompt.ts";
import { contextWindow } from "../models.ts";

const require = createRequire(import.meta.url);
const PKG_VERSION = (require("../../package.json") as { version: string }).version;
const PANEL_VERSION = `cursor-to-dsh@${PKG_VERSION}`;

export interface ContextPanelInput {
  state: CompressionState;
  nudge?: NudgeDecision;
  modelContextLimit: number;
  /** Host session accounting (full history estimate). */
  tokenCount: number;
  systemPromptTokens?: number;
  unprunedTokens?: number;
}

export function renderContextPanel(input: ContextPanelInput): string {
  return buildStatusPanel({
    version: PANEL_VERSION,
    state: input.state,
    nudge: input.nudge,
    modelContextLimit: input.modelContextLimit,
    tokenCount: input.tokenCount,
    systemPromptTokens: input.systemPromptTokens ?? 0,
    unprunedTokens: input.unprunedTokens,
  });
}

/** Live session: run processTurn and render the acp status panel. */
export function renderLiveContextPanel(opts: {
  sessionId: string;
  messages: readonly any[];
  systemPrompt: string;
  tools: readonly any[];
  modelId: string;
  preserve?: AcpPreserveConfig;
  compactedAt?: number;
}): string {
  const windowTokens = contextWindow({ id: opts.modelId });
  const fullTokens = estimateTranscript(opts.systemPrompt, [...opts.tools], [...opts.messages]);
  const unpruned = toCoreMessages(opts.messages).reduce(
    (n, m) => n + defaultCountTokens(m.text ?? ""),
    0,
  );
  const kernel = kernelPanelInputs(opts.sessionId, opts.messages, fullTokens, windowTokens, opts.preserve, {
    compactedAt: opts.compactedAt,
  });
  return renderContextPanel({
    state: kernel.state,
    nudge: kernel.nudge,
    modelContextLimit: kernel.modelContextLimit,
    tokenCount: fullTokens,
    systemPromptTokens: estimateTextTokens(opts.systemPrompt),
    unprunedTokens: unpruned + estimateTextTokens(opts.systemPrompt),
  });
}

/** Settings / cold path: persisted kernel state only (no live nudge). */
export function renderPersistedContextPanel(
  sessionId: string,
  modelContextLimit = 200_000,
): string | undefined {
  const stored = loadKernelState(sessionId);
  if (!stored) return undefined;
  const tokenCount = stored.lastTokenCount > 0
    ? stored.lastTokenCount
    : Math.max(0, Math.floor(Number(stored.state.stats?.tokensCompressed ?? 0)));
  return renderContextPanel({
    state: stored.state,
    modelContextLimit,
    tokenCount,
    systemPromptTokens: 0,
  });
}
