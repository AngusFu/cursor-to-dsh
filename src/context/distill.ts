/**
 * T2/T3 tier distillation: sidecar summary + kernel block merge (billion-context).
 */
import { TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES, type CompressionBlock } from "acp-kernel";
import type { RequestMessage } from "@deepseek-ai/dsh-llm";

import {
  kernelApplyCompression,
  kernelAppliedRevision,
  kernelTierDistillPlan,
  type AcpPreserveConfig,
} from "./kernel.ts";
import { archiveCompression } from "./ledger.ts";
import { peekModelCompress } from "./pending.ts";
import { runPreflightSummary, type PreflightDeps } from "./preflight.ts";
import { debug } from "../session.ts";

export interface TierDistillPlan {
  tier: 2 | 3;
  startRef: string;
  endRef: string;
  sourceText: string;
  topic: string;
  blocks: CompressionBlock[];
}

export function renderTierDistillMessages(tier: 2 | 3, sourceText: string): RequestMessage[] {
  const rules = tier === 3 ? TIER3_CONDENSE_RULES : TIER2_DISTILL_RULES;
  const text = [
    rules,
    "",
    "Output only the distilled summary: no preamble, no markdown fence.",
    "",
    "--- SOURCE BLOCKS ---",
    sourceText.trim() || "(empty)",
  ].join("\n");
  return [{ role: "user", content: [{ type: "text", text }] }];
}

export async function runTierDistillSummary(opts: {
  tier: 2 | 3;
  sourceText: string;
  apiKey: string;
  modelId: string;
  params: { id: string; value: string }[] | undefined;
  cwd: string;
  deps: PreflightDeps;
}): Promise<string | undefined> {
  const history = renderTierDistillMessages(opts.tier, opts.sourceText)
    .map((m) => (typeof m.content === "string" ? m.content : (m.content as any[])?.map((b) => b?.text ?? "").join("")))
    .join("\n");
  return runPreflightSummary({ ...opts, history });
}

/** Kernel-only tier merge (block boundaries); does not rewrite the Cursor checkpoint. */
export async function applyTierDistillation(opts: {
  sessionKey: string;
  messages: readonly any[];
  plan: TierDistillPlan;
  summary: string;
  revision: number;
  contextWindowTokens: number;
  preserve?: AcpPreserveConfig;
}): Promise<void> {
  kernelApplyCompression(
    opts.sessionKey,
    opts.messages,
    {
      startRef: opts.plan.startRef,
      endRef: opts.plan.endRef,
      summary: opts.summary,
      topic: opts.plan.topic,
      revision: opts.revision,
    },
    opts.contextWindowTokens,
    opts.preserve,
  );
  archiveCompression({
    sessionId: opts.sessionKey,
    revision: opts.revision,
    summary: opts.summary,
    dropRefs: opts.plan.blocks.map((b) => b.blockId),
    dropText: opts.plan.sourceText,
    topic: opts.plan.topic,
  });
  debug(
    `tier-${opts.plan.tier} distill key=${opts.sessionKey.slice(0, 12)} blocks=${opts.plan.blocks.length} rev=${opts.revision}`,
  );
}

/**
 * When acp nudge says T2/T3 is ready, run a sidecar distill and merge blocks.
 * Skips if a model compress is already pending.
 */
export async function autoTierDistillIfReady(opts: {
  sessionKey: string;
  messages: readonly any[];
  tokenCount: number;
  contextWindowTokens: number;
  preserve?: AcpPreserveConfig;
  apiKey: string;
  modelId: string;
  params: { id: string; value: string }[] | undefined;
  cwd: string;
  deps: PreflightDeps;
}): Promise<boolean> {
  if (peekModelCompress(opts.sessionKey)) return false;
  const plan = kernelTierDistillPlan(
    opts.sessionKey,
    opts.messages,
    opts.tokenCount,
    opts.contextWindowTokens,
    opts.preserve,
  );
  if (!plan) return false;
  const summary = await runTierDistillSummary({
    tier: plan.tier,
    sourceText: plan.sourceText,
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    params: opts.params,
    cwd: opts.cwd,
    deps: opts.deps,
  });
  if (!summary || summary.length < 32) return false;
  const revision = kernelAppliedRevision(opts.sessionKey) + 1;
  await applyTierDistillation({
    sessionKey: opts.sessionKey,
    messages: opts.messages,
    plan,
    summary,
    revision,
    contextWindowTokens: opts.contextWindowTokens,
    preserve: opts.preserve,
  });
  return true;
}
