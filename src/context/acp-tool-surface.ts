/**
 * Map acp-kernel canonical tool surface → DSH cursor_context_* tool names.
 */
import {
  ACP_STATUS_TOOL_NAME,
  ACP_TOOLS_RESPONSES,
  COMPRESS_TOOL_NAME as ACP_COMPRESS,
  DECOMPRESS_TOOL_NAME as ACP_DECOMPRESS,
  SEARCH_CONTEXT_TOOL_NAME,
} from "acp-kernel";

import {
  COMPRESS_TOOL_NAME,
  DECOMPRESS_TOOL_NAME,
  SEARCH_TOOL_NAME,
  STATUS_TOOL_NAME,
} from "./names.ts";

const ACP_BY_DSH: Record<string, string> = {
  [COMPRESS_TOOL_NAME]: ACP_COMPRESS,
  [STATUS_TOOL_NAME]: ACP_STATUS_TOOL_NAME,
  [DECOMPRESS_TOOL_NAME]: ACP_DECOMPRESS,
  [SEARCH_TOOL_NAME]: SEARCH_CONTEXT_TOOL_NAME,
};

/** Param names differ on the wire (startId) vs DSH (startRef). */
const PARAM_ALIASES: Record<string, string> = {
  startId: "startRef",
  endId: "endRef",
  blockId: "chunkId",
  imageRef: "imageRef",
  query: "query",
  summary: "summary",
  topic: "topic",
  offset: "offset",
  limit: "limit",
};

function acpTool(acpName: string) {
  return ACP_TOOLS_RESPONSES.find((t) => t.name === acpName);
}

export function cursorContextToolDescription(dshName: string): string | undefined {
  const acpName = ACP_BY_DSH[dshName];
  if (!acpName) return undefined;
  const hit = acpTool(acpName);
  const desc = hit?.description?.trim();
  if (!desc) return undefined;
  return desc.replace(/\bcompress\b/g, "cursor_context_compress")
    .replace(/\bdecompress\b/g, "cursor_context_decompress")
    .replace(/\bsearch_context\b/g, "cursor_context_search")
    .replace(/\bacp_status\b/g, "cursor_context_status");
}

export function cursorContextParamDescription(dshParam: string, dshName: string): string | undefined {
  const acpName = ACP_BY_DSH[dshName];
  if (!acpName) return undefined;
  const hit = acpTool(acpName);
  const props = hit?.parameters as { properties?: Record<string, { description?: string }> } | undefined;
  if (!props?.properties) return undefined;
  for (const [acpKey, meta] of Object.entries(props.properties)) {
    const mapped = PARAM_ALIASES[acpKey] ?? acpKey;
    if (mapped === dshParam && typeof meta?.description === "string") return meta.description;
  }
  return undefined;
}
