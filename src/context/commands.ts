/**
 * Slash commands for Cursor context (acp panel).
 */
import type { Context } from "@deepseek-ai/cordis";

import { PROVIDER_ID } from "../models.ts";
import { getContextFillSnapshot } from "./fill-cache.ts";
import { renderLiveContextPanel } from "./panel.ts";
import type { AcpPreserveConfig } from "./kernel.ts";

function sessionOf(inv: any): any {
  return inv?.session ?? inv?.agent?.session ?? inv?.context?.session;
}

function livePanelText(session: any, preserve: AcpPreserveConfig): string | { kind: "error"; text: string } {
  const provider = session?.requestContext?.()?.provider;
  const sessionId = session?.id;
  if (!sessionId) {
    return {
      kind: "error",
      text: "No active DSH session. Open a conversation, or view persisted sessions under Settings → Cursor → Context panel.",
    };
  }
  if (provider && provider !== PROVIDER_ID) {
    return {
      kind: "error",
      text: `This session uses provider "${provider}", not Cursor. Switch to a Cursor-routed model first.`,
    };
  }
  const messages = session?.deriveMessages ? Array.from(session.deriveMessages() ?? []) : [];
  const modelId = session?.requestContext?.()?.model ?? "unknown";
  const sys = messages.find((m: any) => m?.role === "system") as { content?: unknown } | undefined;
  const systemPrompt = typeof sys?.content === "string" ? sys.content : "";
  return renderLiveContextPanel({
    sessionId,
    messages,
    systemPrompt,
    tools: [],
    modelId,
    preserve,
  });
}

export interface ContextCommandDeps {
  preserveConfig: () => AcpPreserveConfig;
}

/** Register context slash commands; returns a disposer that unregisters them. */
export function registerContextCommands(ctx: Context, deps: ContextCommandDeps): (() => void) | undefined {
  const commands: any = (ctx as any).commands;
  if (!commands?.register) return undefined;

  const panelHandler = async (inv: any, alias: boolean) => {
    const session = sessionOf(inv);
    const out = livePanelText(session, deps.preserveConfig());
    if (typeof out !== "string") {
      return alias && !session?.id
        ? { kind: "error", text: "Requires an active Cursor-routed DSH session (or use cursor_context_status tool)." }
        : out;
    }
    return { kind: "success", text: out };
  };

  const dispose: Array<() => void> = [];
  dispose.push(
    commands.register({
      name: "cursor-acp-panel",
      description: "Show the acp-kernel context status panel (local; same layout as billion-context)",
      handler: (inv: any) => panelHandler(inv, false),
    }),
  );
  dispose.push(
    commands.register({
      name: "cursor-context-status",
      description: "Alias for /cursor-acp-panel",
      handler: (inv: any) => panelHandler(inv, true),
    }),
  );
  dispose.push(
    commands.register({
      name: "cursor-context-fill",
      description: "Show retained-token context fill % (updates after each Cursor turn)",
      handler: (inv: any) => {
        const session = sessionOf(inv);
        const sessionId = session?.id;
        if (!sessionId) {
          return {
            kind: "error",
            text: "No active DSH session. The fill pill appears after a Cursor-routed turn.",
          };
        }
        const provider = session?.requestContext?.()?.provider;
        if (provider && provider !== PROVIDER_ID) {
          return {
            kind: "error",
            text: `This session uses provider "${provider}", not Cursor.`,
          };
        }
        const snap = getContextFillSnapshot(sessionId);
        if (!snap) {
          return {
            kind: "error",
            text: "No fill reading yet — complete at least one Cursor turn in this session.",
          };
        }
        const pending = snap.viewPending ? " · compress pending" : "";
        return {
          kind: "success",
          text: `Context fill ${snap.percent}% — ${snap.retainedTokens.toLocaleString()} / ${snap.limitTokens.toLocaleString()} tokens (${snap.modelId})${pending}`,
        };
      },
    }),
  );

  return () => {
    for (const fn of dispose) fn();
  };
}
