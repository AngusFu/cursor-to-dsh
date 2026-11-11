/**
 * Render acp-kernel processTurn model view onto the Cursor wire transcript.
 */
import type { CoreMessage } from "acp-kernel";

import { contextMessages, contextMessageKey, coreMessageOwner } from "./message-shape.ts";
import { textOf, transcriptPreamble } from "../prompt.ts";

export interface AcpWireView {
  /** Messages after processTurn (filter, truncate, tags, …). */
  messages: CoreMessage[];
  byFingerprint: Map<string, CoreMessage>;
}

export function buildAcpWireView(messages: readonly CoreMessage[]): AcpWireView {
  const byFingerprint = new Map<string, CoreMessage>();
  for (const m of messages) byFingerprint.set(coreMessageOwner(m.id), m);
  return { messages: [...messages], byFingerprint };
}

function renderViewMessage(cm: CoreMessage, raw?: any): string {
  const body = cm.text ?? "";
  if (cm.contentType === "tool-result" || cm.role === "tool") {
    const err = Boolean(raw?.isError);
    return `### ${cm.toolName ?? raw?.toolName ?? "tool"} (${cm.toolCallId ?? raw?.toolCallId ?? ""})${
      err ? " [error]" : ""
    }\n${body || "(no output)"}`;
  }
  if (cm.contentType === "tool-call") {
    return `### assistant\ncalls ${cm.toolName} (${cm.toolCallId}) with ${body}`;
  }
  if (cm.role === "user" || (cm.role === "assistant" && cm.contentType === "text")) {
    return `### ${cm.role}\n${body}`;
  }
  if (cm.role === "system" || raw?.role === "developer") {
    return `### context\n${body}`;
  }
  if (raw) {
    switch (raw.role) {
      case "user":
        return `### user\n${body || textOf(raw.content)}`;
      case "developer":
        return `### context\n${body || textOf(raw.content)}`;
      case "assistant":
        return `### assistant\n${body || textOf(raw.content)}`;
      default:
        break;
    }
  }
  return body ? `### ${cm.role}\n${body}` : "";
}

/** First send: history follows acp model view (processed/truncated/filtered bodies). */
export function renderTranscriptWithAcpView(
  systemPrompt: string | undefined,
  rawMessages: readonly any[],
  view: readonly CoreMessage[],
): string {
  const rawByFp = new Map<string, any>();
  for (const m of contextMessages(rawMessages)) rawByFp.set(contextMessageKey(m), m);
  const parts = transcriptPreamble(systemPrompt);
  const history = view.map((cm) => renderViewMessage(cm, rawByFp.get(coreMessageOwner(cm.id)))).filter(Boolean);
  if (history.length) parts.push("Conversation so far:", ...history);
  return parts.join("\n\n");
}

/** Incremental user/context text from the acp view (undefined when filtered off the wire). */
export function incrementFromAcpView(m: any, view: AcpWireView): string | undefined {
  const cm = view.byFingerprint.get(contextMessageKey(m));
  if (!cm) return undefined;
  if (cm.contentType === "tool-result") return undefined;
  const body = cm.text ?? "";
  if (!body) return undefined;
  return m?.role === "developer" ? `[context]\n${body}` : body;
}
