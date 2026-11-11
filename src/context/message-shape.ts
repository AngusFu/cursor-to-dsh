/** One host-neutral identity/shape boundary shared by request and tool paths. */
import { fingerprint } from "../prompt.ts";
import { readRequest } from "../transcript.ts";

export function contextMessages(messages: readonly any[]): any[] {
  return readRequest({ messages }).messages;
}

/** Preserve existing fingerprint identities; attachment bytes are not text identity. */
export function contextMessageKey(message: any): string {
  if (!Array.isArray(message?.content)) return fingerprint(message);
  return fingerprint({ ...message, content: message.content.filter((b: any) => !(b?.type === "text" && b.text === "[image attachment not forwarded to Cursor]")) });
}

/** Semantic pieces share an owner, but every parallel call has its own kernel id/ref. */
export function coreMessageOwner(id: string): string {
  return id.split(":", 1)[0]!;
}
