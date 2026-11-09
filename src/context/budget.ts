/**
 * §8 window budget: conservative resident estimate vs effective context tier.
 */
import { workingContext } from "../models.ts";
import type { Param } from "../models.ts";

export interface BudgetSettings {
  outputReserve: number;
  safetyMargin: number;
}

export const DEFAULT_BUDGET: BudgetSettings = {
  outputReserve: 8_192,
  safetyMargin: 8_192,
};

export interface ContextPressure {
  effectiveWindow: number;
  inputBudget: number;
  estimatedResident: number;
  fillRatio: number;
  growthSince: number;
  softNudge: boolean;
  overHard: boolean;
  nudge: string;
}

function parseContextTokens(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
  return m ? Math.round(Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : 1e3)) : undefined;
}

/** Active context tier in tokens: session params beat catalog default. */
export function effectiveContextWindow(modelContextTokens: number, params: Param[] | undefined, modelId: string): number {
  const fromParams = parseContextTokens(params?.find((p) => p.id === "context")?.value);
  const fromWorking = parseContextTokens(workingContext.get(modelId));
  return fromParams ?? fromWorking ?? modelContextTokens;
}

export function inputBudget(effectiveWindow: number, settings: BudgetSettings = DEFAULT_BUDGET): number {
  const reserve = settings.outputReserve + settings.safetyMargin;
  return Math.max(16_000, effectiveWindow - reserve);
}

/** RFC soft growth trigger: min(30K, 15% of effective window). */
export function growthNudgeThreshold(effectiveWindow: number): number {
  return Math.min(30_000, Math.floor(effectiveWindow * 0.15));
}

export const GROWTH_NUDGE_TEXT = [
  "[Context pressure: the retained window is large. Before it overflows, call `cursor_context_status` for compressible refs,",
  "then `cursor_context_compress` with a detailed continuation summary (and optional startRef/endRef).]",
].join(" ");

export const HARD_NUDGE_TEXT = [
  "[Context budget exceeded. You must call `cursor_context_compress` with a detailed summary on this turn",
  "or the host may auto-compact on your behalf.]",
].join(" ");

export function assessContextPressure(opts: {
  modelContextTokens: number;
  params: Param[] | undefined;
  modelId: string;
  estimatedResident: number;
  lastNudgeResident?: number;
  settings?: BudgetSettings;
  softFillRatio?: number;
}): ContextPressure {
  const settings = opts.settings ?? DEFAULT_BUDGET;
  const effectiveWindow = effectiveContextWindow(opts.modelContextTokens, opts.params, opts.modelId);
  const budget = inputBudget(effectiveWindow, settings);
  const fillRatio = budget > 0 ? opts.estimatedResident / budget : 1;
  const growthSince = Math.max(0, opts.estimatedResident - (opts.lastNudgeResident ?? 0));
  const growthThreshold = growthNudgeThreshold(effectiveWindow);
  const softFillRatio = opts.softFillRatio ?? 0.85;
  const softNudge = fillRatio >= softFillRatio || growthSince >= growthThreshold;
  const overHard = opts.estimatedResident > budget;
  let nudge = "";
  if (overHard) nudge = HARD_NUDGE_TEXT;
  else if (softNudge) nudge = GROWTH_NUDGE_TEXT;
  return {
    effectiveWindow,
    inputBudget: budget,
    estimatedResident: opts.estimatedResident,
    fillRatio,
    growthSince,
    softNudge,
    overHard,
    nudge,
  };
}
