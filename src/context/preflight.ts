/**
 * §8.3 hard preflight: sidecar Cursor agent (no custom tools) produces a T1 summary.
 */
import { collectSummaryText, renderSummaryMessages } from "./summarizer.ts";

export interface PreflightDeps {
  createAgent: (opts: any) => Promise<any>;
  deleteAgent: (id: string, opts: { apiKey: string; local?: { cwd?: string } }) => Promise<void>;
}

export interface PreflightRun {
  history: string;
  apiKey: string;
  modelId: string;
  params: { id: string; value: string }[] | undefined;
  cwd: string;
  deps: PreflightDeps;
}

/**
 * One-shot Cursor run that returns a continuation summary. Uses a throwaway agent id.
 */
export async function runPreflightSummary(input: PreflightRun): Promise<string | undefined> {
  const history = input.history.trim();
  if (!history) return undefined;
  const text = renderSummaryMessages({ history })
    .map((m) => (typeof m.content === "string" ? m.content : (m.content as any[])?.map((b) => b?.text ?? "").join("")))
    .join("\n");
  let agent: any;
  const local = { cwd: input.cwd, settingSources: [] as string[] };
  try {
    agent = await input.deps.createAgent({
      model: { id: input.modelId, ...(input.params?.length ? { params: input.params } : {}) },
      apiKey: input.apiKey,
      tools: ["mcp"],
      local,
    });
    const cursorRun = await agent.send(text);
    const parts: string[] = [];
    for await (const msg of cursorRun.stream()) {
      if (msg?.type === "assistant") {
        for (const b of msg.message?.content ?? []) {
          if (b?.type === "text" && b.text) parts.push(b.text);
        }
      }
    }
    const summary = parts.join("").trim();
    return summary || undefined;
  } catch {
    return undefined;
  } finally {
    try {
      agent?.close?.();
    } catch {
      /* ignore */
    }
    const id = agent?.agentId;
    if (id) await input.deps.deleteAgent(id, { apiKey: input.apiKey, local }).catch(() => {});
  }
}

/** Test hook: collect from a fake stream. */
export { collectSummaryText };
