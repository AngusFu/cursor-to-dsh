/**
 * billion-context / acp-kernel tools must not be forwarded to Cursor.
 *
 * DSH tools reach Cursor only through session syncTools customTools; this
 * filter is applied there, not by unregistering tools for other providers.
 * Verified reserved ACP names and the retired local surface are dropped by name.
 * Generic `compress` / `decompress` / `absorb` / legacy `image_full`
 * are dropped only when the schema or description looks like the ACP tools,
 * so an unrelated host tool of the same name is not hidden.
 */

export const BILI_ACP_TOOL_NAMES = new Set([
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  "acp_cache",
  "absorb",
  "image_full",
  "acp_rule",
  "acp_retrieve",
  "acp_read_original_image",
  // Retired local compression surface: never reconnect stale definitions.
  "cursor_context_compress",
  "cursor_context_status",
  "cursor_context_decompress",
  "cursor_context_search",
]);

const GENERIC_BILI_NAMES = new Set(["compress", "decompress", "absorb", "image_full"]);

const ACP_PARAM_HINTS = new Set([
  "blockId",
  "startId",
  "endId",
  "startRef",
  "endRef",
  "toFile",
  "imageRef",
]);

export type ToolLike = {
  name?: string;
  description?: string;
  parameters?: unknown;
};

function schemaPropertyKeys(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const props = (parameters as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props);
}

function looksLikeBiliAcpSchema(tool: ToolLike): boolean {
  const keys = schemaPropertyKeys(tool.parameters);
  if (keys.some((key) => ACP_PARAM_HINTS.has(key))) return true;
  const desc = String(tool.description ?? "");
  // 0.1.213 default manifest uses literal examples m00150/m00220, not
  // the mNNNNN placeholder the earlier filter expected.
  if (tool.name === "compress" && keys.includes("content") && /Replace consumed conversation ranges with self-contained summaries/i.test(desc)) return true;
  return /(?:\bblockId\b|mNNNNN|billion-context|<acp_|\[ACP absorb\]|compressed conversation section|startId\s*\/\s*endId)/i.test(desc);
}

/** True when this tool is a bili/ACP tool that must stay off the Cursor route. */
export function isBiliAcpTool(tool: ToolLike | null | undefined): boolean {
  const name = tool?.name;
  if (!name) return false;
  // The installed manifest permits aliases for absorb/retrieve, but preserves
  // these exact protocol descriptions and argument schemas. Match that proven
  // combination, not arbitrary names/prefixes or a bare mention of ACP.
  const keys = schemaPropertyKeys(tool.parameters);
  const desc = String(tool.description ?? "");
  if (keys.includes("ref") && keys.includes("summary") && desc.startsWith("Distill a tool result into a compact summary you write.") && desc.includes("[ACP absorb]")) return true;
  if (keys.length === 1 && keys[0] === "ref" && desc.startsWith("Retrieve the full original text of a stored message by its id.") && desc.includes("[acp-stored")) return true;
  if (!BILI_ACP_TOOL_NAMES.has(name)) return false;
  if (!GENERIC_BILI_NAMES.has(name)) return true;
  return looksLikeBiliAcpSchema(tool);
}

export function withoutBiliAcpTools<T extends ToolLike>(tools: readonly T[] | undefined): T[] {
  if (!tools?.length) return [];
  return tools.filter((tool) => !isBiliAcpTool(tool));
}
