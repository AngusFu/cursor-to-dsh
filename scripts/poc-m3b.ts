/**
 * PoC M3-decisive: after truncating the checkpoint, is the token still on disk
 * anywhere locally? If yes -> local residue, M3 is incomplete. If no and the
 * model still remembers -> the memory is server-side and M3 is impossible.
 *
 *   CURSOR_API_KEY=... node --experimental-strip-types scripts/poc-m3b.ts [model]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { createAgentPlatform } from "@cursor/sdk";

const model = process.argv[2] || "claude-haiku-5-5";
const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("CURSOR_API_KEY is required");
  process.exit(1);
}

const cwd = process.cwd();
const TOKEN = `M3B-${Date.now().toString(36).toUpperCase()}`;
const id = `poc-m3b-${Date.now()}`;

let failures = 0;
const info = (label: string, detail: unknown) => console.log(`  ${label}: ${detail}`);
const ok = (label: string, detail = "") => console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label: string, detail = "") => {
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Every file under ~/.cursor that currently contains the token. */
function grepLocal(needle: string): string[] {
  const roots = [join(homedir(), ".cursor"), cwd];
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p, depth + 1);
      } else if (st.isFile() && st.size < 64 * 1024 * 1024) {
        try {
          if (readFileSync(p).includes(needle)) hits.push(p);
        } catch {
          /* binary / unreadable */
        }
      }
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r, 0);
  return hits;
}

/** The transcript jsonl path for this workspace, mirroring the SDK layout. */
function transcriptPath(agentId: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return join(homedir(), ".cursor", "projects", slug, "agent-transcripts", agentId, `${agentId}.jsonl`);
}

async function turn(agent: any, text: string) {
  const run = await agent.send(text);
  for await (const _ of run.stream()) {
    /* drain */
  }
  const res = await run.wait();
  return { status: res.status, text: res.result ?? "", error: res.error?.message };
}

console.log(`model=${model} cwd=${cwd}\nagent=${id}\ntoken=${TOKEN}\n`);

const platform = await createAgentPlatform();

console.log("--- seed ---");
const agent = await platform.createAgent({
  model: { id: model },
  apiKey,
  tools: [],
  agentId: id,
  name: "m3b",
  local: { cwd, settingSources: [] },
} as any);

const seed = await turn(agent, `Remember this code word: ${TOKEN}. Reply with just OK.`);
info("seed", `${seed.status} ${seed.text}`);
const control = await turn(agent, `What code word did I give you earlier? Reply with just the code word.`);
info("control", `${control.status} ${control.text}`);
if (control.text.includes(TOKEN)) ok("control remembers", control.text);
else bad("control remembers", control.text);

console.log("\n--- residue before truncation ---");
const before = grepLocal(TOKEN);
info("files containing token", before.length);
for (const f of before) info("  ", f.replace(homedir(), "~"));

console.log("\n--- truncate checkpoint ---");
const state: any = await platform.checkpointStore.loadLatest(id);
info("turns before", state.turns?.length);
const tail = Array.from(state.turns as ArrayLike<unknown>).slice(-1);
try {
  state.turns = tail;
} catch {
  /* readonly */
}
info("turns after", state.turns?.length);
const ref = await platform.checkpointStore.saveCheckpoint(id, state);
info("saveCheckpoint", JSON.stringify(ref));
const reread: any = await platform.checkpointStore.loadLatest(id);
info("turns on read-back", reread.turns?.length);

console.log("\n--- drop local transcript residue ---");
const tp = transcriptPath(id);
if (existsSync(tp)) {
  rmSync(tp, { force: true });
  info("removed", tp.replace(homedir(), "~"));
} else {
  info("transcript not found", tp.replace(homedir(), "~"));
}

console.log("\n--- residue after cleanup ---");
const after = grepLocal(TOKEN);
info("files containing token", after.length);
for (const f of after) info("  ", f.replace(homedir(), "~"));
if (after.length === 0) ok("no local residue");
else bad("no local residue", `${after.length} file(s) still hold it`);

console.log("\n--- probe with a fresh handle ---");
try {
  agent.close();
} catch {
  /* close may be sync or absent */
}
const fresh: any = await platform.resumeAgent(id, {
  model: { id: model },
  apiKey,
  tools: [],
  local: { cwd, settingSources: [] },
} as any);
const probe = await turn(fresh, `What code word did I give you earlier? Reply with just the code word.`);
info("probe", `${probe.status} ${probe.text}`);
if (probe.text.includes(TOKEN)) bad("model forgot after truncation", probe.text);
else ok("model forgot after truncation", probe.text);
try {
  fresh.close();
} catch {
  /* ditto */
}

console.log("\n--- residue after probe (did the run rewrite it?) ---");
const post = grepLocal(TOKEN);
info("files containing token", post.length);
for (const f of post) info("  ", f.replace(homedir(), "~"));

console.log(`\n=== RESULT: ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
console.log(`agents kept: ${id}`);
process.exit(failures === 0 ? 0 : 1);
