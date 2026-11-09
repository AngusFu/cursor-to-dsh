/**
 * End-to-end proof that the shipped `runCompaction` shrinks a real Cursor agent.
 *
 * Everything else is unit-tested against fakes; this is the one place where the
 * real store, real blobs and a real model have to agree. It does what
 * `maybeCompact` does minus the DSH runtime: same module, same call shape.
 *
 * CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-e2e.ts [model]
 */
import { Agent, createAgentPlatform } from "@cursor/sdk";
import { runCompaction } from "../src/context/compact.ts";

const apiKey = process.env.CURSOR_API_KEY ?? "";
const model = process.argv[2] ?? "claude-haiku-5-5";
const cwd = process.cwd();

if (!apiKey) {
  console.error("CURSOR_API_KEY is required");
  process.exit(2);
}

const token = `E2E-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
let failed = 0;

const ok = (what: string, detail = "") => console.log(`  PASS ${what}${detail ? ` — ${detail}` : ""}`);
const bad = (what: string, detail = "") => {
  failed += 1;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
};

async function turn(agent: any, text: string) {
  const run = await agent.send(text);
  for await (const _ of run.stream()) {
    /* drain: the runner only checkpoints once the run ends */
  }
  const res = await run.wait();
  return { status: res.status as string, text: (res.result ?? "") as string, error: res.error?.message as string | undefined };
}

console.log(`model=${model} token=${token}`);

const platform = await createAgentPlatform();
const agentId = `agent-${crypto.randomUUID()}`;

// --- seed a conversation the way the plugin does: static Agent.create -------
const agent = await Agent.create({
  model: { id: model },
  apiKey,
  tools: [],
  local: { cwd, settingSources: [] },
});
const id = String(agent.agentId);
console.log(`agent=${id}`);

const seed = await turn(agent, `Remember this code word: ${token}. Reply with OK.`);
console.log(`  seed: ${seed.status}`);
if (seed.status !== "finished") {
  bad("seed run", seed.error ?? "");
  process.exit(1);
}

const control = await turn(agent, "What code word did I give you earlier?");
if (control.text.includes(token)) ok("control remembers", token);
else bad("control remembers", control.text.slice(0, 120));

// The turn that must survive: nothing about it may match a dropped needle.
const tail = await turn(agent, "Reply with just OK.");
console.log(`  tail: ${tail.status} ${tail.text.slice(0, 40)}`);

try {
  agent.close();
} catch {
  /* close() is synchronous and may throw if already closed */
}

// --- run the shipped code path --------------------------------------------
// Mirrors the real transcript, which carries Cursor's replies too: the
// assistant echoed the token in its answer, and that echo is a ref of its own.
const messages = [
  { role: "user", content: `Remember this code word: ${token}. Reply with OK.` },
  { role: "assistant", content: "OK" },
  { role: "user", content: "What code word did I give you earlier?" },
  { role: "assistant", content: control.text },
  { role: "user", content: "Reply with just OK." },
  { role: "assistant", content: "OK" },
];

const outcome = await runCompaction({
  store: platform.checkpointStore,
  agentId: id,
  cwd,
  messages,
  compactedAt: 0,
  keepTurns: 1,
  previousSummary: "",
  summarize: async () => "The user was given a code word and asked for a reply; the code word itself is not preserved.",
});

if (!outcome) {
  bad("runCompaction produced an outcome");
} else {
  ok("runCompaction", `keepFrom=${outcome.keepFrom} summary=${outcome.summary.length} chars`);
}

// --- read back what Cursor now holds ---------------------------------------
const state: any = await platform.checkpointStore.loadLatest(id);
const turns = state?.turns?.length ?? -1;
if (turns === 1) ok("checkpoint shrunk", `turns=${turns}`);
else bad("checkpoint shrunk", `turns=${turns}`);

// --- and ask the model ------------------------------------------------------
const fresh = await platform.resumeAgent(id, {
  model: { id: model },
  apiKey,
  tools: [],
  local: { cwd, settingSources: [] },
});
const probe = await turn(fresh, "What code word did I give you earlier?");
console.log(`  probe: ${probe.status} ${probe.text.slice(0, 120)}`);
if (probe.status !== "finished") bad("probe run", probe.error ?? "");
else if (probe.text.includes(token)) bad("model forgot", token);
else ok("model forgot");

try {
  fresh.close();
} catch {
  /* ditto */
}

console.log(failed === 0 ? "\n=== RESULT: PASS ===" : `\n=== RESULT: FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
