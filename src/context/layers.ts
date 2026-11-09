/** T1/T2/T3 topic labels for archive + acp-kernel block tier. T2/T3 auto via distill.ts. */
export type CompressionLayer = "T1" | "T2" | "T3";

/** Map an optional topic label to a layer; explicit T2/T3 prefixes only. */
export function resolveCompressionLayer(topic?: string): CompressionLayer {
  const t = topic?.trim().toLowerCase() ?? "";
  if (t.startsWith("t3:") || t === "t3") return "T3";
  if (t.startsWith("t2:") || t === "t2") return "T2";
  return "T1";
}
