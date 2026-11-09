/**
 * Live E2E: long transcript → model compress path (M3) + ledger persistence.
 *
 * CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-context-e2e.ts [model]
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Agent, createAgentPlatform } from "@cursor/sdk";

import { archiveCompression, clearLedgers, loadMessageRefs, searchArchive, syncMessageRefs } from "../src/context/ledger.ts";
import { clearKernelSessions } from "../src/context/kernel.ts";
import {
  ledgerPersistenceEnabled,
  loadContentStore,
  loadKernelState,
  resetLedgerDb,
} from "../src/context/ledger-persist.ts";
import { runHostCompaction } from "../src/context/compact.ts";
import { resolveCompressionLayer } from "../src/context/layers.ts";
import { fingerprint, incrementText } from "../src/prompt.ts";

const apiKey = process.env.CURSOR_API_KEY ?? "";
const model = process.argv[2] ?? "claude-haiku-5-5";
const cwd = process.cwd();
const sessionId = `e2e-${Date.now()}`;

if (!apiKey) {
  console.error("CURSOR_API_KEY is required");
  process.exit(2);
}

let failed = 0;
const ok = (what: string, detail = "") => console.log(`  PASS ${what}${detail ? ` — ${detail}` : ""}`);
const bad = (what: string, detail = "") => {
  failed += 1;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
};

async function turn(agent: any, text: string) {
  const run = await agent.send(text);
  for await (const _ of run.stream()) {
    /* drain */
  }
  const res = await run.wait();
  return { status: res.status as string, text: (res.result ?? "") as string };
}

console.log(`model=${model} session=${sessionId} sqlite=${ledgerPersistenceEnabled()}`);
console.log(`ledger db: ${join(homedir(), ".dsh", "cursor-context-ledger.db")}`);

clearLedgers();
clearKernelSessions();
resetLedgerDb();

const messages: any[] = [];
for (let i = 0; i < 8; i++) {
  messages.push({ role: "user", content: `Step ${i}: remember code WORD-${i}` });
  messages.push({ role: "assistant", content: `Acknowledged WORD-${i}` });
}
const refs = syncMessageRefs(sessionId, messages, { contextWindow: 200_000 });
if (refs.length === messages.length) ok("acp refs aligned", `${refs[0]!.ref}..${refs[refs.length - 1]!.ref}`);
else bad("acp refs aligned", `got ${refs.length}/${messages.length}`);
const keepFrom = Math.max(0, messages.length - 2);
const dropRefs = refs.filter((r) => r.index < keepFrom).map((r) => r.ref);
const dropText = messages.slice(0, keepFrom).map(incrementText).join("\n\n");
const summary =
  "Eight exchange drill: user assigned WORD-0..WORD-6; assistant acknowledged each; latest tail kept verbatim.";

const platform = await createAgentPlatform();
const agent = await Agent.create({
  model: { id: model },
  apiKey,
  tools: [],
  local: { cwd, settingSources: [] },
});
const agentId = String(agent.agentId);
console.log(`agent=${agentId}`);

for (let i = 0; i < Math.min(4, messages.length); i++) {
  const m = messages[i]!;
  if (m.role === "user") await turn(agent, incrementText(m) || String(m.content));
}
try {
  agent.close();
} catch {
  /* ignore */
}

const chunk = archiveCompression({
  sessionId,
  revision: 1,
  summary,
  dropRefs,
  dropText,
  topic: "t1:e2e",
});
const tier = resolveCompressionLayer("t1:e2e") === "T1" ? 1 : 2;
if (chunk.tier === tier) ok("archive tier", `T${chunk.tier}`);

const needles = messages.slice(0, keepFrom).map(incrementText).filter(Boolean);
const outcome = await runHostCompaction({
  store: platform.checkpointStore,
  agentId,
  cwd,
  keepTurns: 1,
  summary,
  keepFrom,
  needles,
});
if (outcome) ok("M3 host compact", `keepFrom=${outcome.keepFrom}`);
else bad("M3 host compact");

const hits = searchArchive(sessionId, "WORD-3", 3);
if (hits.length) ok("ledger search", hits[0]!.snippet.slice(0, 40));
else bad("ledger search");

clearLedgers();
const reloaded = loadMessageRefs(sessionId);
if (reloaded.length >= dropRefs.length) ok("sqlite refs reload", String(reloaded.length));
else if (!ledgerPersistenceEnabled()) ok("sqlite refs skipped", "node:sqlite unavailable");
else bad("sqlite refs reload");

const ks = loadKernelState(sessionId);
if (ks?.state?.messageRefs?.byRaw) ok("kernel state persist", `rev=${ks.appliedRevision}`);
else if (!ledgerPersistenceEnabled()) ok("kernel state skipped", "sqlite off");
else bad("kernel state persist");

const cs = loadContentStore(sessionId);
if (cs?.version === 1) ok("content store persist", `entries=${Object.keys(cs.byRef ?? {}).length}`);
else if (!ledgerPersistenceEnabled()) ok("content store skipped", "sqlite off");
else ok("content store empty", "no CCR stores yet");

mkdirSync(join(homedir(), ".dsh"), { recursive: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
