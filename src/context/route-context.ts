/** Cursor-only projection of retired, attributable compression guidance.
 * Never edit stored history or regex-delete user/assistant/tool prose. */
const SNAPSHOT_PREFIX = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n";
const RETIRED_SECTION = "cursor:acp-context";

export function withoutRetiredContext(message: any): any | undefined {
  if (message?.source?.kind !== "runtime-context" || !["user", "developer"].includes(message.role)) return message;
  const source = message.source;
  const sections = source.sections;
  if (source.form !== "snapshot" || !Array.isArray(sections)) {
    // Older unattributed snapshots cannot be safely split from other guidance.
    // Do not silently discard the rest or pretend this is a clean context.
    if (Array.isArray(message.content) && message.content.some((b: any) => b?.type === "text" && /(?:^|\n)\[acp-context\](?:\n|$)/.test(b.text ?? ""))) {
      throw new Error("Legacy compression context lacks section attribution; regenerate host runtime context before continuing. Stored history was not changed.");
    }
    return message;
  }
  if (!sections.some((section: any) => section?.name === RETIRED_SECTION)) return message;
  if (sections.some((section: any) => typeof section?.name !== "string" || typeof section?.text !== "string") ||
      message.content?.length !== 1 || message.content[0]?.type !== "text" ||
      message.content[0].text !== SNAPSHOT_PREFIX + sections.map((section: any) => section.text).join("\n\n")) {
    throw new Error("Cannot safely separate retired compression guidance from host runtime context. Stored history was not changed.");
  }
  const kept = sections.filter((section: any) => section.name !== RETIRED_SECTION);
  if (!kept.length) return undefined;
  return { ...message, source: { ...source, sections: kept }, content: [{ type: "text", text: SNAPSHOT_PREFIX + kept.map((section: any) => section.text).join("\n\n") }] };
}
