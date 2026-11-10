/**
 * Shared Cursor-route gates for context tools and runtime prompt.
 */
import { PROVIDER_ID } from "../models.ts";

/** Whether the step's model selection is on the Cursor provider route. */
export function cursorContextToolsWhen(context: { modelSelection?: { provider?: string } }): boolean {
  return context.modelSelection?.provider === PROVIDER_ID;
}
