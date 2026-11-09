/** Shared fake Cursor agent helpers for session integration tests. */
import { CursorAdapter } from "../src/adapter.ts";

export function fakeCursor(script: (ctx: any) => AsyncGenerator<any, any, void>) {
  const created: any[] = [];
  const sends: any[] = [];
  const sendOpts: any[] = [];
  const createAgent = async (opts: any) => {
    created.push(opts);
    const agentTools = opts.local?.customTools ?? {};
    return {
      send: async (msg: any, options?: any) => {
        sends.push(msg);
        sendOpts.push(options);
        const tools = options?.local?.customTools ?? agentTools;
        let status: any = { status: "finished", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 } };
        const queue: any[] = [];
        let wake: (() => void) | undefined;
        let finished = false;
        let cancelled = false;
        const ctx = {
          msg,
          opts,
          callTool: async (name: string, args: any, id: string) => {
            if (!tools[name]) throw new Error(`unknown tool ${name}`);
            return tools[name].execute(args, { toolCallId: id });
          },
          setStatus: (s: any) => (status = s),
        };
        (async () => {
          for await (const ev of script(ctx)) {
            if (cancelled) return;
            queue.push(ev);
            wake?.();
          }
          finished = true;
          wake?.();
        })();
        return {
          stream: async function* () {
            for (;;) {
              while (queue.length) yield queue.shift();
              if (finished) return;
              await new Promise<void>((r) => (wake = r));
            }
          },
          wait: async () => {
            while (!finished) await new Promise((r) => setTimeout(r, 1));
            return status;
          },
          cancel: async () => {
            if (finished) return;
            cancelled = true;
            status = { status: "cancelled" };
            finished = true;
            wake?.();
          },
        };
      },
      close: () => {},
      agentId: `agent-${created.length}`,
      getUsage: () => ({}),
    };
  };
  return { createAgent, created, sends, sendOpts };
}

const catalog = [
  { id: "m", displayName: "M" },
  {
    id: "claude",
    displayName: "Claude",
    parameters: [
      { id: "thinking", values: [{ value: "true" }, { value: "false" }] },
      { id: "effort", values: [{ value: "low" }, { value: "high" }] },
      { id: "fast", values: [{ value: "true" }, { value: "false" }] },
      { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
    ],
  },
];

export function adapterFor(cursor: { createAgent: any }, deps: any = {}) {
  return new CursorAdapter({
    createAgent: cursor.createAgent,
    listModels: async () => catalog,
    resolveApiKey: async () => "k",
    cwdFor: () => "/work",
    ...deps,
  });
}

let seq = 0;
export const nextId = () => `msg-${++seq}`;
export const text = (t: string) => [{ type: "text", text: t }];
export const sys = (t: string) => ({ id: nextId(), role: "system", content: text(t), source: { kind: "system-prompt" } });
export const user = (t: string) => ({ id: nextId(), role: "user", content: text(t), source: { kind: "user" } });
export const toolResult = (callId: string, t: string, isError = false) => ({
  id: nextId(),
  role: "tool",
  toolCallId: callId,
  isError,
  content: text(t),
  source: { kind: "tool", callId },
});

export const say = (body: string) => ({ type: "assistant", message: { content: [{ type: "text", text: body }] } });
