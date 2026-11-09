/**
 * Where does a Cursor agent's memory actually live?
 *
 * Phase A of poc-checkpoint.ts proved that truncating `state.turns` does not make
 * the model forget — but the `rootPromptMessagesJson` check was bogus (a proto
 * `bytes` field JSON-stringifies to `{"0":200,...}`, so plaintext can never match).
 * This script seeds one agent, keeps it alive, then:
 *   1. decodes every byte-like field of the checkpoint and hunts for the token
 *   2. prints the decoded root prompt
 *   3. prints where the store lives, so the raw files can be grepped from the shell
 *
 * Usage: CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-locate.ts [model]
 */
import { createAgentPlatform } from "@cursor/sdk";
import { Agent } from "@cursor/sdk";
import { configureRipgrep } from "../src/sdk.ts";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("CURSOR_API_KEY is not set.");
  process.exit(1);
}
const model = process.argv[2] ?? "claude-haiku-5-5";
const cwd = process.cwd();
const TOKEN = "LOCATE-9991";

configureRipgrep();

const platform = await createAgentPlatform();
const id = `poc-loc-${Date.now()}`;

function decode(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "number") {
    return Buffer.from(v as number[]).toString("utf8");
  }
  return undefined;
}

/** Recursively walk a value, decoding anything byte-shaped, and hunt for TOKEN. */
function hunt(node: unknown, path: string, hits: string[], depth = 0): void {
  if (depth > 6 || node == null) return;
  const asText = decode(node);
  if (asText !== undefined) {
    if (asText.includes(TOKEN)) hits.push(`${path} (text len=${asText.length})`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => hunt(v, `${path}[${i}]`, hits, depth + 1));
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      hunt(v, `${path}.${k}`, hits, depth + 1);
    }
  }
}

try {
  const agent = await platform.createAgent({
    agentId: id,
    model: { id: model },
    apiKey,
    name: "locate poc",
    tools: [],
    local: { cwd, settingSources: [] },
  });
  const run = await agent.send(`Remember this code word: ${TOKEN}. Reply with just OK.`);
  for await (const _ of run.stream()) {
    /* drain */
  }
  const res = await run.wait();
  console.log(`seed: status=${res.status} ${JSON.stringify(res.result ?? res.error)}`);

  const state: any = await platform.checkpointStore.loadLatest(id);
  console.log(`state class=${state?.constructor?.name}`);

  // 1. decoded root prompt + a token hunt across every field
  const rp = state?.rootPromptMessagesJson;
  const rpText = decode(rp);
  console.log(
    `rootPromptMessagesJson: bytes=${Array.isArray(rp) ? rp.length : rp instanceof Uint8Array ? rp.length : "?"} decoded=${rpText?.length ?? "?"}`,
  );
  if (rpText) console.log(`root prompt head: ${JSON.stringify(rpText.slice(0, 600))}`);

  const hits: string[] = [];
  hunt(state, "state", hits);
  console.log(`token hits inside checkpoint: ${hits.length ? hits.join(" | ") : "NONE"}`);

  // 2. where is the store?
  for (const label of ["store", "checkpointStore"] as const) {
    const obj: any = platform[label];
    console.log(`${label}: class=${obj?.constructor?.name} keys=${Object.keys(obj ?? {}).join(",")}`);
    for (const k of Object.keys(obj ?? {})) {
      const v = obj[k];
      if (typeof v === "string" && (v.includes("/") || v.includes("poc-"))) {
        console.log(`  ${label}.${k} = ${v}`);
      }
    }
  }
  // platform itself may carry stateRoot / workspaceRef
  for (const k of Object.keys(platform as any)) {
    const v = (platform as any)[k];
    if (typeof v === "string") console.log(`platform.${k} = ${v}`);
  }

  console.log(`\nAGENT_ID=${id}`);
  console.log(`TOKEN=${TOKEN}`);
} catch (e) {
  console.error("locate failed:", e);
  process.exit(1);
}
