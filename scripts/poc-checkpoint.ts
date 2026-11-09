/**
 * P0 PoC — does rewriting a local Cursor agent's checkpoint shrink what the model sees?
 *
 * Gates the RFC's main line (M3, checkpoint rewrite) against its fallback (M2, delete + recreate).
 *
 *   CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-checkpoint.ts [model] [--keep] [--summarize]
 *
 * Phase A (M3): build history -> control question proves retention -> truncate `state.turns`
 *               -> saveCheckpoint -> read back -> ask again. Forgetting the word = shrink took.
 * Phase B (M2): snapshot getUsage() -> Agent.delete -> Agent.create with the same id -> ask again.
 * Phase C:      saveCheckpoint while a run is active -> does the runner overwrite it?
 * Phase D:      official summarize() baseline (only with --summarize).
 *
 * Exits 0 only when A and B pass.
 */
import { createAgentPlatform } from "@cursor/sdk";
import type { SDKAgent } from "@cursor/sdk";
import { configureRipgrep } from "../src/sdk.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const withSummarize = args.includes("--summarize");
const model = args.find((a) => !a.startsWith("--")) ?? "claude-haiku-5-5";
const apiKey = process.env.CURSOR_API_KEY;
const cwd = process.cwd();

if (!apiKey) {
  console.error("FAIL: CURSOR_API_KEY is not set");
  process.exit(1);
}

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};
const info = (label: string, detail = ""): void => {
  console.log(`  ....  ${label}${detail ? `  — ${detail}` : ""}`);
};

console.log("=== P0 PoC: Cursor checkpoint rewrite ===");
console.log(`model=${model} cwd=${cwd} keep=${keep} summarize=${withSummarize}\n`);

configureRipgrep();
const platform = await createAgentPlatform();

async function makeAgent(agentId: string): Promise<SDKAgent> {
  return platform.createAgent({
    agentId,
    model: { id: model },
    apiKey,
    name: "checkpoint poc",
    tools: [], // no built-in tools: text only, zero side effects
    local: { cwd, settingSources: [] },
  });
}

/** Fresh handle on an EXISTING agentId: must load state from disk, not from the live object. */
async function resumeAgent(agentId: string): Promise<SDKAgent> {
  return platform.resumeAgent(agentId, {
    model: { id: model },
    apiKey,
    tools: [],
    local: { cwd, settingSources: [] },
  } as any);
}

interface Turn {
  text: string;
  status: string;
  error?: string;
  summary: { status: string; fallback?: boolean }[];
  types: string[];
  ms: number;
}

async function turn(agent: SDKAgent, text: string): Promise<Turn> {
  const started = Date.now();
  const types: string[] = [];
  const summary: { status: string; fallback?: boolean }[] = [];
  let streamError: string | undefined;
  let run: any;
  try {
    run = await agent.send(text);
  } catch (e) {
    return { text: "", status: "send-threw", error: String(e), summary, types, ms: Date.now() - started };
  }
  try {
    for await (const m of run.stream() as AsyncGenerator<any>) {
      types.push(String(m?.type));
      if (m?.type === "summary") summary.push({ status: m.status, fallback: m.fallback });
    }
  } catch (e) {
    streamError = String(e);
  }
  let res: any;
  try {
    res = await run.wait();
  } catch (e) {
    res = { status: "error", error: { message: String(e) } };
  }
  const status = String(res?.status ?? (streamError ? "error" : "?"));
  const error = res?.error?.message ?? streamError;
  return {
    text: typeof res?.result === "string" ? res.result : "",
    status,
    error,
    summary,
    types,
    ms: Date.now() - started,
  };
}

const showTurn = (label: string, t: Turn): void => {
  info(label, `status=${t.status} ${t.ms}ms${t.error ? ` error=${t.error}` : ""}`);
  console.log(`        ${JSON.stringify(t.text.slice(0, 300))}`);
};

/** Server-side "not your region" and friends are intermittent; retry before believing them. */
const TRANSIENT = /region|capacity|temporarily|rate limit|too many|unavailable|try again|resource/i;
async function turnRetry(agent: SDKAgent, text: string, tries = 3): Promise<Turn> {
  let last = await turn(agent, text);
  for (let i = 1; i < tries && (last.status === "error" || last.status === "send-threw") && TRANSIENT.test(last.error ?? ""); i++) {
    await new Promise((r) => setTimeout(r, 2000 * i));
    last = await turn(agent, text);
  }
  return last;
}

function preview(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return v.length > 90 ? `${JSON.stringify(`${v.slice(0, 90)}…`)}` : JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  try {
    const s = JSON.stringify(v, (_k, val) => (typeof val === "string" && val.length > 70 ? `${val.slice(0, 70)}…` : val));
    return (s ?? String(v)).slice(0, 500);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function stateInfo(label: string, state: any): { turnsLen: number; cls: string } {
  const proto = state == null ? undefined : Object.getPrototypeOf(state);
  const cls = proto?.constructor?.name ?? typeof state;
  const turns = state?.turns;
  const turnsLen = turns == null ? -1 : typeof turns.length === "number" ? turns.length : -1;
  const own = state == null ? [] : Object.getOwnPropertyNames(state);
  console.log(`        ${label}: cls=${cls} own=[${own.join(", ")}] turnsLen=${turnsLen}`);
  if (turnsLen > 0) {
    const tail = Array.from(turns as ArrayLike<unknown>).slice(-2);
    tail.forEach((t, i) => console.log(`          tail[${i}]: ${preview(t)}`));
  }
  return { turnsLen, cls };
}

/** Mutate `state.turns` down to the last `keep` entries. Returns which strategy worked. */
function truncate(state: any, keep: number): { state: any; how: string } {
  const turns = state?.turns;
  if (turns == null || typeof turns.length !== "number") throw new Error(`state.turns is not sized (got ${typeof turns})`);
  if (turns.length <= keep) return { state, how: `already ${turns.length}<=${keep}` };
  const tail = Array.from(turns as ArrayLike<unknown>).slice(-keep);

  try {
    state.turns = tail;
    if (state.turns?.length === keep) return { state, how: "assignment" };
  } catch {
    /* getter-only; fall through */
  }
  try {
    (turns as Array<unknown>).splice(0, (turns as Array<unknown>).length - keep);
    if (state.turns?.length === keep) return { state, how: "splice" };
  } catch {
    /* not a live array; fall through */
  }
  try {
    const Ctor: any = state.constructor;
    const fields: Record<string, unknown> = {};
    for (const k of Object.getOwnPropertyNames(state)) fields[k] = (state as any)[k];
    fields.turns = tail;
    const next = typeof Ctor?.create === "function" ? Ctor.create(fields) : new Ctor(fields);
    if (next?.turns?.length === keep) return { state: next, how: "rebuild" };
  } catch (e) {
    info("rebuild attempt threw", String(e));
  }
  throw new Error("could not mutate state.turns");
}

function flatten(v: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return "";
  if (Array.isArray(v)) return v.map((x) => flatten(x, depth + 1)).join("\n");
  return Object.values(v as Record<string, unknown>).map((x) => flatten(x, depth + 1)).join("\n");
}

async function fullText(agentId: string): Promise<string | undefined> {
  try {
    return flatten(await platform.checkpointStore.getFullConversation(agentId));
  } catch (e) {
    info("getFullConversation failed", String(e));
    return undefined;
  }
}

// ── Phase A: M3 checkpoint truncation ─────────────────────────────────────────
console.log("--- Phase A: M3 checkpoint truncation ---");
const idA = `poc-m3-${Date.now()}`;
let agentA: SDKAgent | undefined;
const CODE_A = "ZEBRA-7391";
try {
  agentA = await makeAgent(idA);
  info("created", idA);

  showTurn("A1 seed", await turn(agentA, `Remember this code word: ${CODE_A}. Reply with just OK.`));
  showTurn("A2 pad", await turn(agentA, "Reply with just OK."));
  showTurn("A3 pad", await turn(agentA, "Reply with just OK."));
  const controlA = await turn(agentA, "What code word did I give you earlier? Answer with only the word.");
  showTurn("A4 control", controlA);
  check(controlA.text.includes(CODE_A), "A4 control: model retains the code word", controlA.text.slice(0, 80));

  showTurn("A5 clean tail", await turn(agentA, "Reply with just OK."));

  const beforeA = await platform.checkpointStore.loadLatest(idA);
  const b4 = stateInfo("A6 loadLatest", beforeA);
  const refA = await platform.checkpointStore.saveCheckpoint(idA, truncate(beforeA, 1).state);
  info("A7 saveCheckpoint", preview(refA));

  const afterA = await platform.checkpointStore.loadLatest(idA);
  const af = stateInfo("A8 read-back", afterA);
  check(af.turnsLen === 1, "A8 read-back: turns shrank to 1", `before=${b4.turnsLen} after=${af.turnsLen}`);

  const retained = await fullText(idA);
  const retainedHasSecret = retained?.includes(CODE_A) ?? false;
  info("A9 retained tail contains code word?", String(retainedHasSecret));

  const probeA = await turnRetry(agentA, "What code word did I give you earlier? Answer with only the word.");
  showTurn("A10 probe", probeA);
  check(!probeA.error && probeA.status === "finished", "A10 probe: send succeeded (requestId continuity)", probeA.status);
  if (retainedHasSecret) {
    info("A10 probe INVALID", "retained tail still holds the code word, so this probe proves nothing");
  } else {
    check(!probeA.text.includes(CODE_A), "A10 probe: model no longer recalls the code word", probeA.text.slice(0, 80));
  }

  // A11 — where does the prompt actually come from? If rootPromptMessagesJson still
  // carries the transcript, truncating `turns` only trimmed an index, not the payload.
  const rp = (afterA as any)?.rootPromptMessagesJson;
  const rpStr = typeof rp === "string" ? rp : rp == null ? "" : JSON.stringify(rp);
  info("A11 rootPromptMessagesJson", `type=${typeof rp} len=${rpStr.length} hasSecret=${rpStr.includes(CODE_A)}`);
  if (rpStr.length > 0) info("A11 rootPrompt head", preview(rpStr.slice(0, 400)));
  const archives = (afterA as any)?.summaryArchives;
  const archStr = archives == null ? "" : JSON.stringify(archives);
  info("A11 summaryArchives", `type=${typeof archives} len=${archStr.length} hasSecret=${archStr.includes(CODE_A)}`);
  check(!rpStr.includes(CODE_A), "A11 rootPromptMessagesJson no longer holds the code word");

  // A12 — is the live SDKAgent caching state in memory? reload() then probe again.
  const reloaded = await (agentA as any).reload?.().catch((e: unknown) => e);
  info("A12 reload()", reloaded instanceof Error ? `THREW ${reloaded}` : String(reloaded));
  const probeReload = await turnRetry(agentA, "What code word did I give you earlier? Answer with only the word.");
  showTurn("A12 probe after reload", probeReload);
  check(
    probeReload.status === "finished" && !probeReload.text.includes(CODE_A),
    "A12 probe after reload: agent forgot the code word",
    probeReload.text.slice(0, 80),
  );

  // A13 — a brand-new handle on the same agentId must load from disk. If IT still
  // remembers, the memory lives on Cursor's server and M3 cannot work at all.
  try {
    agentA.close();
  } catch {
    /* already closed */
  }
  const freshA = await resumeAgent(idA);
  const probeFresh = await turnRetry(freshA, "What code word did I give you earlier? Answer with only the word.");
  showTurn("A13 probe via fresh handle", probeFresh);
  check(
    probeFresh.status === "finished" && !probeFresh.text.includes(CODE_A),
    "A13 probe via fresh handle: fresh load from disk forgot the code word",
    probeFresh.text.slice(0, 80),
  );
  agentA = freshA;
} catch (e) {
  check(false, "Phase A ran", String(e));
} finally {
  if (!keep) {
    try {
      agentA?.close();
      await platform.deleteAgent(idA);
      info("cleaned", idA);
    } catch (e) {
      info("cleanup failed", String(e));
    }
  }
}

// ── Phase B: M2 delete + recreate same id ─────────────────────────────────────
console.log("\n--- Phase B: M2 delete + recreate same id ---");
const idB = `poc-m2-${Date.now()}`;
const CODE_B = "TIGER-4482";
let agentB: SDKAgent | undefined;
try {
  agentB = await makeAgent(idB);
  info("created", idB);
  showTurn("B1 seed", await turn(agentB, `Remember this code word: ${CODE_B}. Reply with just OK.`));
  const controlB = await turn(agentB, "What code word did I give you earlier? Answer with only the word.");
  showTurn("B2 control", controlB);
  check(controlB.text.includes(CODE_B), "B2 control: model retains the code word", controlB.text.slice(0, 80));

  const usageBefore = await agentB.getUsage().catch((e) => ({ error: String(e) }));
  info("B3 usage before delete", preview(usageBefore));

  agentB.close();
  await platform.deleteAgent(idB);
  info("B4 deleted", idB);

  agentB = await makeAgent(idB);
  info("B5 recreated with same id", idB);
  const probeB = await turnRetry(agentB, "What code word did I give you earlier? Answer with only the word.");
  showTurn("B6 probe", probeB);
  check(probeB.status === "finished", "B6 probe: send succeeded on the recreated agent", probeB.status);
  check(!probeB.text.includes(CODE_B), "B6 probe: recreated agent has no memory", probeB.text.slice(0, 80));

  // B8 — control: does a BRAND-NEW id work right now? If yes, B6's region error is
  // specific to delete+recreate and M2 is broken; if no, the error is environmental.
  const idB8 = `poc-new-${Date.now()}`;
  try {
    const agentB8 = await makeAgent(idB8);
    const probeB8 = await turnRetry(agentB8, "Reply with exactly OK.");
    showTurn("B8 new-id control", probeB8);
    check(probeB8.status === "finished", "B8 control: a brand-new agent id sends fine", probeB8.status);
    try {
      agentB8.close();
      await platform.deleteAgent(idB8);
    } catch {
      /* best effort */
    }
  } catch (e) {
    check(false, "B8 control: a brand-new agent id sends fine", String(e));
  }

  const usageAfter = await agentB.getUsage().catch((e) => ({ error: String(e) }));
  info("B7 usage after recreate", preview(usageAfter));
} catch (e) {
  check(false, "Phase B ran", String(e));
} finally {
  if (!keep) {
    try {
      agentB?.close();
      await platform.deleteAgent(idB);
      info("cleaned", idB);
    } catch (e) {
      info("cleanup failed", String(e));
    }
  }
}

// ── Phase C: does a mid-run saveCheckpoint survive? ───────────────────────────
console.log("\n--- Phase C: mid-run checkpoint race ---");
const idC = `poc-race-${Date.now()}`;
let agentC: SDKAgent | undefined;
try {
  agentC = await makeAgent(idC);
  info("created", idC);
  await turn(agentC, "Remember this code word: RACER-1000. Reply with just OK.");
  await turn(agentC, "Reply with just OK.");
  await turn(agentC, "Reply with just OK.");

  const runC = await agentC.send("Write a 200-word essay about the ocean. No tools.");
  const preC = await platform.checkpointStore.loadLatest(idC);
  const preLen = preC?.turns?.length ?? -1;
  let raceError: string | undefined;
  let raceRef: unknown;
  try {
    raceRef = await platform.checkpointStore.saveCheckpoint(idC, truncate(preC, 1).state);
  } catch (e) {
    raceError = String(e);
  }
  info("C1 mid-run save", raceError ? `THREW ${raceError}` : `ok ref=${preview(raceRef)} turns ${preLen}->1`);

  let resC: any;
  try {
    for await (const _ of runC.stream()) {
      /* drain */
    }
    resC = await runC.wait();
  } catch (e) {
    resC = { status: "error", error: { message: String(e) } };
  }
  info("C2 run finished", `status=${resC?.status}${resC?.error?.message ? ` error=${resC.error.message}` : ""}`);

  const postC = await platform.checkpointStore.loadLatest(idC);
  const postLen = postC?.turns?.length ?? -1;
  check(
    postLen === 1,
    "C3 mid-run mutation survived (if FAIL the runner overwrote it)",
    `pre=${preLen} post=${postLen}`,
  );
} catch (e) {
  check(false, "Phase C ran", String(e));
} finally {
  if (!keep) {
    try {
      agentC?.close();
      await platform.deleteAgent(idC);
      info("cleaned", idC);
    } catch (e) {
      info("cleanup failed", String(e));
    }
  }
}

// ── Phase D (opt-in): official summarize() baseline ───────────────────────────
if (withSummarize) {
  console.log("\n--- Phase D: official summarize() baseline ---");
  const idD = `poc-sum-${Date.now()}`;
  let agentD: SDKAgent | undefined;
  try {
    agentD = await makeAgent(idD);
    await turn(agentD, "Remember this code word: SUMM-5521. Reply with just OK.");
    await turn(agentD, "Reply with just OK.");
    const beforeD = await platform.checkpointStore.loadLatest(idD);
    const d4 = stateInfo("D1 loadLatest", beforeD);
    const runD = await agentD.summarize();
    const dSummary: { status: string; fallback?: boolean }[] = [];
    for await (const m of runD.stream() as AsyncGenerator<any>) {
      if (m?.type === "summary") dSummary.push({ status: m.status, fallback: m.fallback });
    }
    const resD = await runD.wait().catch((e) => ({ status: "error", error: { message: String(e) } }));
    info("D2 summarize", `status=${resD?.status} events=${preview(dSummary)}`);
    const afterD = await platform.checkpointStore.loadLatest(idD);
    const d5 = stateInfo("D3 read-back", afterD);
    check(d5.turnsLen < d4.turnsLen, "D3 summarize shrank turns", `before=${d4.turnsLen} after=${d5.turnsLen}`);
  } catch (e) {
    check(false, "Phase D ran", String(e));
  } finally {
    if (!keep) {
      try {
        agentD?.close();
        await platform.deleteAgent(idD);
        info("cleaned", idD);
      } catch (e) {
        info("cleanup failed", String(e));
      }
    }
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────────
console.log(`\n=== RESULT: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`} ===`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
