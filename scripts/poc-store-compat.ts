// Does a checkpoint store from `createAgentPlatform()` see an agent created by the
// static `Agent.create()`? The plugin creates sessions through the static stub
// (`src/sdk.ts`), while compaction has to rewrite the checkpoint through a
// platform — if the two resolve to different stores, `loadLatest` returns null
// and compaction can never fire.
//
// v1 of this script reported MISS for both paths, but it never finished the run:
// `send()` alone does not make the runner write its checkpoint, so the result
// said nothing about the store. v2 drains the stream and waits first.
//
//   CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-store-compat.ts [model]

import { Agent, createAgentPlatform } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("CURSOR_API_KEY is required");
  process.exit(1);
}
const model = process.argv[2] ?? "claude-haiku-5-5";
const cwd = process.cwd();

console.log(`model=${model} cwd=${cwd}`);

async function turn(agent: any, text: string): Promise<string> {
  const run = await agent.send(text);
  for await (const _ of run.stream()) {
    /* drain: the runner only checkpoints when the run ends */
  }
  const res = await run.wait();
  return `${res.status}${res.error ? ` ${res.error.message}` : ""}`;
}

const platform = await createAgentPlatform();

// --- path A: how `src/sdk.ts` creates every session today ---
const a = await Agent.create({
  model: { id: model },
  apiKey,
  tools: [],
  local: { cwd, settingSources: [] },
} as any);
const idA = (a as any).agentId as string;
console.log(`static Agent.create -> ${idA}`);
console.log(`  seed: ${await turn(a, "Reply with exactly OK.")}`);
const viaPlatformA = await (platform as any).checkpointStore.loadLatest(idA);
console.log(
  `  platform.loadLatest(static agent) -> ${
    viaPlatformA ? `HIT turns=${(viaPlatformA as any).turns?.length ?? "?"}` : "MISS (null)"
  }`,
);

// --- path B: an agent the platform itself created ---
const b = await (platform as any).createAgent({
  model: { id: model },
  apiKey,
  tools: [],
  local: { cwd, settingSources: [] },
} as any);
const idB = (b as any).agentId as string;
console.log(`platform.createAgent -> ${idB}`);
console.log(`  seed: ${await turn(b, "Reply with exactly OK.")}`);
const viaPlatformB = await (platform as any).checkpointStore.loadLatest(idB);
console.log(
  `  platform.loadLatest(platform agent) -> ${
    viaPlatformB ? `HIT turns=${(viaPlatformB as any).turns?.length ?? "?"}` : "MISS (null)"
  }`,
);

// --- what does each store think exists? ---
try {
  const runs = await (platform as any).store?.listRuns?.(idA);
  console.log(`  platform.store.listRuns(${idA.slice(0, 14)}…) -> ${Array.isArray(runs) ? runs.length : String(runs)}`);
} catch (err) {
  console.log(`  platform.store.listRuns threw: ${(err as Error).message}`);
}

console.log(`\nagents kept: ${idA} ${idB}`);
try {
  a.close();
} catch {}
try {
  b.close();
} catch {}
