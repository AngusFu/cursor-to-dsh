/**
 * Plan and run one compaction of a Cursor session.
 *
 * The ordering here is the whole point: summarise first, then rewrite the
 * checkpoint, and inject nothing unless the rewrite held. Summarising first
 * costs at most one wasted model call if the rewrite refuses; the other order
 * loses the text it was supposed to keep.
 *
 * The needles that decide which prompt refs to drop are taken from the same
 * rendering the session sends (`incrementText`), because that is the text that
 * actually ends up inside the blobs. A ref is dropped only when its payload
 * still holds one of them.
 */
import { incrementText } from "../prompt.ts";
import { compactCheckpoint, needlesFrom, type CheckpointStoreLike } from "./checkpoint.ts";

export interface CompactionPlan {
  /** Messages between the last compaction and the ones kept verbatim. */
  readonly drop: readonly any[];
  /** Rendered text of `drop`, folded through the previous summary if any. */
  readonly history: string;
  /** Index of the first message that survives. */
  readonly keepFrom: number;
}

export interface PlanInput {
  readonly messages: readonly any[];
  /** Index of the first message not yet folded into the summary. */
  readonly compactedAt: number;
  readonly keepTurns: number;
  readonly previousSummary: string;
}

/**
 * What to drop, or nothing when there is nothing new to fold in.
 *
 * A session compacts more than once over its life, so `compactedAt` matters:
 * without it the summary would be built from text that is already summarised,
 * and every later pass would shrink the summary itself.
 */
export function planCompaction(input: PlanInput): CompactionPlan | undefined {
  const keep = Math.max(1, Math.floor(input.keepTurns) || 1);
  const keepFrom = Math.max(0, input.messages.length - keep);
  if (keepFrom <= input.compactedAt) return undefined;

  const drop = Array.from(input.messages).slice(input.compactedAt, keepFrom);
  const history = [input.previousSummary, ...drop.map(incrementText)]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!history) return undefined;

  return { drop, history, keepFrom };
}

export interface CompactionRun extends PlanInput {
  readonly store: CheckpointStoreLike;
  readonly agentId: string;
  readonly cwd: string;
  /** Produces the summary. Any failure aborts before the checkpoint moves. */
  readonly summarize: (history: string) => Promise<string>;
}

export interface CompactionOutcome {
  readonly summary: string;
  readonly keepFrom: number;
}

/**
 * Summarise, then shrink the agent's prompt refs to match.
 *
 * Returns `undefined` for every "not worth it or not safe" case, so the caller
 * can carry on exactly as before: a compaction that did not happen must be
 * indistinguishable from one that was never attempted.
 */
export async function runCompaction(input: CompactionRun): Promise<CompactionOutcome | undefined> {
  const plan = planCompaction(input);
  if (!plan) return undefined;

  let summary: string;
  try {
    summary = (await input.summarize(plan.history)).trim();
  } catch {
    // A summariser that fails is a compaction that did not happen, not a turn
    // that may be lost: nothing has been written yet.
    return undefined;
  }
  if (!summary) return undefined;

  const needles = needlesFrom([...plan.drop.map(incrementText), input.previousSummary].filter(Boolean));
  const result = await compactCheckpoint({
    store: input.store,
    agentId: input.agentId,
    cwd: input.cwd,
    keepTurns: Math.max(1, Math.floor(input.keepTurns) || 1),
    needles,
  });
  if (!result.ok) return undefined;

  return { summary, keepFrom: plan.keepFrom };
}
