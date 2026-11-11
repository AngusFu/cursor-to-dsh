/**
 * billion-context / acp-kernel tools must not be forwarded to Cursor.
 *
 * DSH tools reach Cursor only through session syncTools customTools; this
 * filter is applied there, not by unregistering tools for other providers.
 * Unique ACP names are dropped by name. Generic `compress` / `decompress`
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
]);

const GENERIC_BILI_NAMES = new Set(["compress", "decompress"]);

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
  return /(?:\bblockId\b|mNNNNN|billion-context|<acp_|compressed conversation section|startId\s*\/\s*endId)/i.test(desc);
}

/** True when this tool is a bili/ACP tool that must stay off the Cursor route. */
export function isBiliAcpTool(tool: ToolLike | null | undefined): boolean {
  const name = tool?.name;
  if (!name || !BILI_ACP_TOOL_NAMES.has(name)) return false;
  if (name.startsWith("cursor_context_")) return false;
  if (!GENERIC_BILI_NAMES.has(name)) return true;
  return looksLikeBiliAcpSchema(tool);
}

export function withoutBiliAcpTools<T extends ToolLike>(tools: readonly T[] | undefined): T[] {
  if (!tools?.length) return [];
  return tools.filter((tool) => !isBiliAcpTool(tool));
}
