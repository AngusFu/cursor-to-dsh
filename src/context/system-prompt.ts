/**
 * Register acp standing prompt as DSH runtime context (separate trajectory record, not system prompt).
 */
import type { Context } from "@deepseek-ai/cordis";

import { PROVIDER_ID } from "../models.ts";
import { acpContextSectionText } from "./acp-prompts.ts";

interface AssembleRouteContext {
  modelSelection?: { provider?: string };
  agent?: { options?: { provider?: string } };
}

/** Between approval policy (115) and harness source (200) in the runtime-context stack. */
const ACP_CONTEXT_ORDER = 130;

/**
 * Contribute compress/ACP guidance via `systemPrompt.context()` so DSH logs it as its
 * own context snapshot, not as part of the assembled system prompt.
 */
export function registerAcpContextPrompt(ctx: Context): (() => void) | undefined {
  const sp = (ctx as any).systemPrompt as
    | {
        context: (context: {
          name: string;
          order: number;
          interpolate?: boolean;
          text: string | ((context: AssembleRouteContext) => string);
        }) => () => void;
      }
    | undefined;
  if (!sp?.context) return undefined;

  return sp.context({
    name: "cursor:acp-context",
    order: ACP_CONTEXT_ORDER,
    interpolate: false,
    text: (assembleContext) => {
      const provider = assembleContext?.modelSelection?.provider ?? assembleContext?.agent?.options?.provider;
      if (provider && provider !== PROVIDER_ID) return "";
      return acpContextSectionText();
    },
  });
}
