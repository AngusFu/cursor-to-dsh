// PoC helper: load an existing agent's latest checkpoint and dump every field
// with proper bytes -> utf8 decoding, so we can see where the plaintext prompt
// actually lives (the earlier JSON.stringify-based hunt made bytes look empty).
//
//   CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-dump.ts <agentId> [token]
//
// No model calls, no writes: read-only inspection of the checkpoint graph.

import { createAgentPlatform } from "@cursor/sdk";

const agentId = process.argv[2];
const token = process.argv[3];

if (!agentId) {
  console.error("usage: poc-dump.ts <agentId> [token]");
  process.exit(2);
}

const decode = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  if (Array.isArray(v) && v.every((n) => typeof n === "number")) {
    return new TextDecoder().decode(new Uint8Array(v as number[]));
  }
  return String(v);
};

const preview = (s: string, n = 240) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…(${flat.length}ch)` : flat;
};

const platform = await createAgentPlatform();

const state = (await platform.checkpointStore.loadLatest(agentId)) as Record<
  string,
  unknown
>;

console.log(`state class=${(state as { constructor: { name: string } }).constructor.name}`);
const keys = Object.keys(state);
console.log(`fields(${keys.length}): ${keys.join(", ")}\n`);

for (const key of keys) {
  const value = state[key];
  const type = Array.isArray(value) ? `array[${value.length}]` : typeof value;
  if (value == null) {
    console.log(`${key}: ${value}`);
    continue;
  }
  if (key === "turns") {
    console.log(`${key}: array[${value.length}]`);
    continue;
  }
  const text = decode(value);
  const hit = token && text.includes(token) ? "  <== TOKEN HERE" : "";
  console.log(`${key}: ${type} len=${text.length}${hit}`);
  console.log(`    ${preview(text)}`);
}

if (token) {
  console.log(`\n=== token "${token}" search across decoded fields ===`);
  let found = 0;
  for (const key of keys) {
    const text = decode(state[key]);
    if (text.includes(token)) {
      found += 1;
      console.log(`HIT field=${key} count=${text.split(token).length - 1}`);
    }
  }
  console.log(found === 0 ? "no field contains the token" : `${found} field(s) hit`);

  // Also walk every turn blob through the public reader.
  const turns = (state.turns ?? []) as unknown[];
  console.log(`\n=== turn blobs via getFullConversation ===`);
  try {
    const full = (await platform.checkpointStore.getFullConversation(
      agentId,
    )) as { turns?: unknown[] };
    console.log(`full turns=${full?.turns?.length}`);
    const blob = JSON.stringify(full);
    console.log(
      `full conversation contains token: ${blob.includes(token)}`,
    );
  } catch (error) {
    console.log(`getFullConversation failed: ${String(error)}`);
  }
  console.log(`turn blob ids: ${turns.length}`);
}

process.exit(0);
