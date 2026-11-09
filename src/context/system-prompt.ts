/**
 * Register acp standing prompt via DSH system-prompt assembly (visible in session trajectory).
 */
import type { Context } from "@deepseek-ai/cordis";

import { PROVIDER_ID } from "../models.ts";
import { acpContextSectionText } from "./acp-prompts.ts";

interface AssembleRouteContext {
  modelSelection?: { provider?: string };
  agent?: { options?: { provider?: string } };
}

export function registerAcpSystemPrompt(ctx: Context, contextEnabled?: () => boolean): void {
  const sp = (ctx as any).systemPrompt as
    | {
        section: (section: {
          name: string;
          order: number;
          interpolate?: boolean;
          text: string | ((context: AssembleRouteContext) => string);
        }) => () => void;
        getSectionOrder: (name: string) => number;
      }
    | undefined;
  if (!sp?.section) return;

  const order = typeof sp.getSectionOrder === "function" ? sp.getSectionOrder("MCP_SERVERS") + 50 : 3150;
  ctx.effect(
    () =>
      sp.section({
        name: "cursor:acp-context",
        order,
        interpolate: false,
        text: (assembleContext) => {
          if (contextEnabled?.() === false) return "";
          const provider = assembleContext?.modelSelection?.provider ?? assembleContext?.agent?.options?.provider;
          if (provider && provider !== PROVIDER_ID) return "";
          return acpContextSectionText();
        },
      }),
    "cursor-to-dsh: acp context system prompt",
  );
}
