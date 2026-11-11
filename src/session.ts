/**
 * One Cursor agent per DSH session, fed only what is new.
 *
 * - The first send carries the system prompt and the history; later sends carry only the
 *   new user and context text, so Cursor's prompt cache covers the whole conversation.
 * - A DSH tool call keeps the Cursor run alive: the custom tool's `execute` waits until DSH
 *   sends the result back on the next request, so the model sees a normal tool result.
 * - Tools changed mid-session keep the agent: every send carries the current tools, and
 *   system prompt lines that were only added are prepended to the next send. A run waiting
 *   for tool results is cancelled and continued with the new tools.
 * - Anything else that does not match what Cursor saw (compaction, edit, model or param
 *   change, rewritten system prompt, lost run) starts a new agent from the full history, so
 *   correctness never depends on the cache.
 *
 * Calls without a session id, and auxiliary calls (titles, compaction), get a session keyed
 * by their opening, closed once they finish.
 */
import { isRejectedParams, modelParams, resolveModelId, smallerContext, workingContext, type Param } from "./models.ts";
import {
  estimateTextTokens,
  estimateTranscript,
  fingerprint,
  hash,
  imagesOf,
  incrementText,
  currentTurnImages,
  renderTranscript,
  systemPromptAddition,
  textOf,
  toolResultForCursor,
  asObject,
  type Image,
} from "./prompt.ts";
import { ERROR_CODES, Reply } from "./reply.ts";
import type { Transcript } from "./transcript.ts";
import { calibrateOverhead, cursorOverhead, runUsage } from "./usage.ts";
import type { CheckpointStoreLike } from "./context/checkpoint.ts";
import { acpWireViewForSend } from "./context/kernel.ts";
import { incrementFromAcpView, renderTranscriptWithAcpView, type AcpWireView } from "./context/acp-wire.ts";
import { assessContextPressure } from "./context/budget.ts";
import { contextWindow } from "./models.ts";
import {
  prepareKernelCompression,
  kernelResidentTokens,
  kernelNudgeForTurn,
  kernelStatus,
  kernelTurnPlan,
  type AcpPreserveConfig,
} from "./context/kernel.ts";
import { planCompaction, runHostCompaction } from "./context/compact.ts";
import { autoTierDistillIfReady } from "./context/distill.ts";
import { renderLiveContextPanel } from "./context/panel.ts";
import { runPreflightSummary } from "./context/preflight.ts";
import type { ContextManagementConfig } from "./ui-state.ts";
import {
  archiveCompression,
  compressibleRefs,
  ledgerStats,
  refsInRange,
  syncMessageRefs,
} from "./context/ledger.ts";
import { setContextFillSnapshot } from "./context/fill-cache.ts";
import { coreMessageOwner, contextMessageKey } from "./context/message-shape.ts";
import { COMPRESS_TOOL_NAME } from "./context/names.ts";
import {
  peekModelCompress,
  rescheduleModelCompress,
  scheduleModelCompress,
  takeModelCompress,
  type PendingModelCompress,
} from "./context/pending.ts";
import { SUMMARY_PREFIX } from "./context/summarizer.ts";

const SLOTS_PER_KEY = 3;
const IDLE_CLOSE_MS = 20 * 60_000;
const PENDING_CLOSE_MS = 60 * 60_000;
const HANDOFF_DEBOUNCE_MS = 50;
const CANCEL_WAIT_MS = 15_000;
const ANON_PREFIX = "anon:";

export function debug(line: string): void {
  if (process.env.DSH_CURSOR_DEBUG) process.stderr.write(`[cursor-to-dsh] ${line}\n`);
}

interface PendingCall {
  id: string;
  name: string;
  args: Record<string, any>;
  handed: boolean;
  resolve: (result: any) => void;
}

class CursorSession {
  agent: any;
  run: any;
  events: any[] = [];
  runDone = true;
  runResult: any;
  runError: unknown;
  /** Model calls DSH can see in the current run: its start plus each tool-result handoff. */
  modelCalls = 0;
  /** False for a run that re-delivers tool results: Cursor saw part of that turn twice. */
  runCalibrates = true;
  sentFirst = false;
  /** Full effective kernel view to replay after a destructive M2 rebuild. */
  replayView?: AcpWireView;
  pending: PendingCall[] = [];
  lastCallAt = 0;
  toolsKey = "";
  toolNames: string[] = [];
  /** The system prompt as Cursor knows it: the first send plus later additions. */
  systemPrompt = "";
  /** Fingerprints of the messages Cursor has seen, including its own replies. */
  seen: string[] = [];
  /** DSH history index Cursor no longer holds verbatim; folded into `summary`. */
  compactedAt = 0;
  /** What replaced that history. Prepend to the next incremental send. */
  summary = "";
  /** Size of `summary` in estimated tokens, for the rolling budget. */
  summaryTokens = 0;
  /** Bumps on M3 commit or M2 rebuild after compression. */
  generation = 0;
  /** Last pending.revision successfully applied to the Cursor checkpoint. */
  appliedViewRevision = 0;
  /** Resident estimate when a growth nudge was last injected. */
  lastNudgeResident = 0;
  /** Hard preflight sidecar attempts since last successful compress. */
  preflightAttempts = 0;
  busy = false;
  closed = false;
  private wakers: (() => void)[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  readonly key: string;
  readonly signature: string;
  readonly params: Param[] | undefined;

  constructor(key: string, signature: string, params: Param[] | undefined) {
    this.key = key;
    this.signature = signature;
    this.params = params;
  }

  wake(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const fn of wakers) fn();
  }

  waitForChange(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
      this.wakers.push(() => {
        if (timer) clearTimeout(timer);
        resolve();
      });
    });
  }

  registerCall(name: string, args: unknown, toolCallId: string | undefined): Promise<any> {
    return new Promise((resolve) => {
      this.pending.push({
        id: toolCallId || `call_${name}_${Date.now().toString(36)}_${this.pending.length}`,
        name,
        args: asObject(args),
        handed: false,
        resolve,
      });
      this.lastCallAt = Date.now();
      this.wake();
    });
  }

  startRun(run: any, calibrates = true): void {
    Object.assign(this, { run, events: [], runDone: false, runResult: undefined, runError: undefined, modelCalls: 1, runCalibrates: calibrates });
    void (async () => {
      try {
        const sent = Date.now();
        let waiting = true;
        for await (const msg of run.stream()) {
          if (waiting && msg?.type !== "status") {
            waiting = false;
            debug(`first ${msg?.type} key=${this.key.slice(0, 12)} after ${Date.now() - sent}ms`);
          }
          this.events.push(msg);
          this.wake();
        }
      } catch (err) {
        this.runError = err;
      }
      try {
        this.runResult = await run.wait();
      } catch (err) {
        this.runError ??= err;
      }
      this.runDone = true;
      this.wake();
    })();
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => dropSession(this), this.pending.length ? PENDING_CLOSE_MS : IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const p of this.pending) settle(() => p.resolve({ content: [{ type: "text", text: "Cancelled by the host." }], isError: true }));
    this.pending = [];
    settle(() => void Promise.resolve(this.run?.cancel?.()).catch(() => {}));
    settle(() => this.agent?.close?.());
    this.wake();
  }
}

function settle(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best effort */
  }
}

const SESSIONS = new Map<string, CursorSession[]>();

function dropSession(s: CursorSession): void {
  s.close();
  const rest = (SESSIONS.get(s.key) ?? []).filter((x) => x !== s);
  if (rest.length) SESSIONS.set(s.key, rest);
  else SESSIONS.delete(s.key);
}

function storeSession(s: CursorSession): void {
  const slots = (SESSIONS.get(s.key) ?? []).filter((x) => x.signature !== s.signature);
  slots.unshift(s);
  while (slots.length > SLOTS_PER_KEY) slots.pop()?.close();
  SESSIONS.set(s.key, slots);
}

export function closeAllCursorSessions(): void {
  for (const slots of SESSIONS.values()) for (const s of slots) s.close();
  SESSIONS.clear();
}

/** Test hook. */
export function cursorSessionCount(): number {
  let n = 0;
  for (const slots of SESSIONS.values()) n += slots.length;
  return n;
}

/** Live Cursor sessions for a DSH session id (every signature slot). */
export function liveCursorSessions(sessionKey: string): CursorSession[] {
  return (SESSIONS.get(sessionKey) ?? []).filter((s) => !s.closed);
}

type Results = { call: PendingCall; message: any; extra?: string }[];
type Plan = { kind: "fresh" } | { kind: "send"; text: string; images?: Image[] } | { kind: "results"; results: Results };

const sendable = (m: any) => m?.role === "user" || m?.role === "developer";

/** How the new messages map onto the live Cursor session. */
export function planIncrement(s: CursorSession | undefined, messages: any[], acpView?: AcpWireView): Plan {
  if (!s || s.closed || !s.sentFirst || messages.length <= s.seen.length) return { kind: "fresh" };
  if (s.seen.some((fp, i) => fingerprint(messages[i]) !== fp)) return { kind: "fresh" };
  const added = messages.slice(s.seen.length);
  const handed = s.pending.filter((p) => p.handed);

  if (handed.length) {
    if (s.runDone) return { kind: "fresh" };
    const results: Results = [];
    let i = 0;
    for (; i < added.length && added[i]?.role === "toolResult"; i++) {
      const call = handed.find((p) => p.id === added[i].toolCallId);
      if (!call || results.some((r) => r.call === call)) return { kind: "fresh" };
      results.push({ call, message: added[i] });
    }
    if (results.length !== handed.length) return { kind: "fresh" };
    const steering = added.slice(i);
    if (!steering.every(sendable)) return { kind: "fresh" };
    const text = steering
      .map((m) => (acpView ? incrementFromAcpView(m, acpView) : incrementText(m)))
      .filter(Boolean)
      .join("\n\n");
    if (text) results[results.length - 1].extra = `[The user sent this message while the tool was running]\n${text}`;
    return { kind: "results", results };
  }

  if (!s.runDone || s.pending.length || !added.every(sendable)) return { kind: "fresh" };
  return {
    kind: "send",
    text: added
      .map((m) => (acpView ? incrementFromAcpView(m, acpView) : incrementText(m)))
      .filter(Boolean)
      .join("\n\n"),
    images: imagesOf(added),
  };
}

function acpWireView(
  sessionKey: string,
  t: Transcript,
  systemPrompt: string,
  contextWindowTokens: number,
  deps: CompactDeps | undefined,
  compactedAt: number,
): AcpWireView | undefined {
  if (!deps || sessionKey.startsWith(ANON_PREFIX)) return undefined;
  const tokenCount = estimateTranscript(systemPrompt, t.tools, t.messages);
  return acpWireViewForSend(
    sessionKey,
    t.messages,
    systemPrompt,
    t.tools,
    tokenCount,
    contextWindowTokens,
    deps.preserveConfig(),
    compactedAt,
  );
}

/**
 * Cursor checkpoint rewrite for model-initiated compression (`cursor_context_compress`).
 */
export interface CompactDeps {
  store: CheckpointStoreLike;
  readBudget: () => ContextManagementConfig;
  preserveConfig: () => { preserveRecentMessages: number; preserveRecentTokens: number };
  resolveKeepTurns: (
    sessionKey: string,
    messages: readonly any[],
    tokenCount: number,
    contextWindowTokens: number,
    compactedAt: number,
  ) => number;
  createAgent: (opts: any) => Promise<any>;
  deleteAgent: (id: string, opts: { apiKey: string; local?: { cwd?: string } }) => Promise<void>;
}

export interface TurnDeps {
  createAgent: (opts: any) => Promise<any>;
  /** Absent = every session behaves exactly as it did before compaction existed. */
  compact?: CompactDeps;
}

/** Auxiliary calls (titles, compaction) carry the session id but must not touch its agent. */
export function sessionKeyFor(sessionId: unknown, t: Transcript, purpose?: string): string {
  if (!purpose && typeof sessionId === "string" && sessionId) return sessionId;
  return ANON_PREFIX + hash(`${purpose ?? ""}\n${t.systemPrompt}\n${t.messages.length ? fingerprint(t.messages[0]) : ""}`);
}

function toolsKeyOf(tools: any[]): string {
  return hash(JSON.stringify(tools.map((t) => [t?.name, t?.description ?? "", t?.parameters ?? {}])));
}

/** Point the session at the current tools; returns the send options that carry them. */
function syncTools(s: CursorSession, tools: any[]): any {
  s.toolsKey = toolsKeyOf(tools);
  s.toolNames = tools.map((t) => t?.name).filter(Boolean);
  const custom: Record<string, any> = {};
  for (const tool of tools) {
    if (!tool?.name) continue;
    custom[tool.name] = {
      description: tool.description || tool.name,
      inputSchema: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} },
      execute: (args: unknown, ctx: any) => s.registerCall(tool.name, args, ctx?.toolCallId),
    };
  }
  return Object.keys(custom).length ? { local: { customTools: custom } } : {};
}

async function openSession(
  key: string,
  modelId: string,
  params: Param[] | undefined,
  t: Transcript,
  apiKey: string,
  cwd: string,
  deps: TurnDeps,
): Promise<CursorSession> {
  const s = new CursorSession(key, signatureOf(modelId, params), params);
  s.systemPrompt = t.systemPrompt;
  const { local } = syncTools(s, t.tools);
  s.agent = await deps.createAgent({
    model: { id: modelId, ...(params?.length ? { params } : {}) },
    apiKey,
    // "mcp" always: DSH tools are MCP custom tools. Cursor built-ins stay off.
    tools: ["mcp"],
    local: { cwd, settingSources: [], customTools: local?.customTools },
  });
  storeSession(s);
  return s;
}

function signatureOf(modelId: string, params: Param[] | undefined): string {
  return hash(JSON.stringify([modelId, params ?? []]));
}

/**
 * Cursor fixes a run's tools when it starts. Cancel the waiting run and deliver its tool
 * results in a follow-up send that carries the new tools. False if the run would not stop.
 */
/**
 * Cursor lists the custom tools to the model when a conversation starts and does not announce
 * later ones (measured: the model said a tool added on the second send did not exist).
 */
function addedToolsNote(s: CursorSession, tools: any[]): string {
  const added = tools.map((t) => t?.name).filter((n) => n && !s.toolNames.includes(n));
  return added.length ? `[Tool update: these tools were added and are now available: ${added.join(", ")}. Look up their schemas before calling them.]` : "";
}

async function continueWithNewTools(
  s: CursorSession,
  results: Results,
  tools: any[],
  note: string,
  send: (s: CursorSession, text: string, images: Image[] | undefined, options: any) => Promise<any>,
): Promise<boolean> {
  settle(() => void Promise.resolve(s.run?.cancel?.()).catch(() => {}));
  const deadline = Date.now() + CANCEL_WAIT_MS;
  while (!s.runDone && Date.now() < deadline) await s.waitForChange(deadline - Date.now());
  if (!s.runDone) return false;
  for (const p of s.pending) settle(() => p.resolve({ content: [{ type: "text", text: "Delivered in the next message." }], isError: false }));
  s.pending = [];
  const parts = ["[Tool results for your last tool calls. The run was restarted because the host's tools or system prompt changed; the tools on this request are current.]"];
  for (const r of results) {
    parts.push(`### ${r.call.name} (${r.call.id})${r.message.isError ? " [error]" : ""}\n${textOf(r.message.content) || "(no output)"}`);
    if (r.extra) parts.push(r.extra);
  }
  if (note) parts.push(note);
  const added = addedToolsNote(s, tools);
  if (added) parts.push(added);
  parts.push("Continue the task.");
  const run = await send(s, parts.join("\n\n"), imagesOf(results.map((r) => r.message)), syncTools(s, tools));
  s.startRun(run, false);
  return true;
}

const COMPRESS_HANDOFF_NOTE =
  "[Context compressed. Earlier turns are folded into the summary above. Do not repeat assistant text already emitted in the interrupted run; continue from this handoff point only.]";

/**
 * Rewrite the Cursor checkpoint from a model-scheduled compression.
 * Returns the summary block to inject, or undefined when nothing committed.
 */
function buildCompactionPlan(
  sessionKey: string,
  s: CursorSession,
  t: Transcript,
  pending: PendingModelCompress,
  keepTurns: number,
) {
  syncMessageRefs(sessionKey, t.messages, { compactedAt: s.compactedAt });
  let refRange: { startRef: string; endRef: string; startIndex: number; endIndex: number } | undefined;
  if (pending.startRef && pending.endRef) {
    const span = refsInRange(sessionKey, pending.startRef, pending.endRef);
    if (!span?.length) return undefined;
    refRange = {
      startRef: pending.startRef,
      endRef: pending.endRef,
      startIndex: span[0]!.index,
      endIndex: span[span.length - 1]!.index,
    };
  }
  return planCompaction({
    messages: t.messages,
    compactedAt: s.compactedAt,
    keepTurns,
    previousSummary: s.summary,
    refRange,
  });
}

async function rebuildAgentM2(opts: {
  s: CursorSession;
  t: Transcript;
  agentId: string;
  modelId: string;
  params: Param[] | undefined;
  apiKey: string;
  cwd: string;
  deps: CompactDeps;
}): Promise<boolean> {
  const { s, t, agentId, modelId, params, apiKey, cwd, deps } = opts;
  void Promise.resolve(s.agent?.getUsage?.()).catch(() => {
    /* usage snapshot best-effort before delete */
  });
  try {
    await deps.deleteAgent(agentId, { apiKey, local: { cwd } });
  } catch (err) {
    debug(`M2 delete failed key=${s.key.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const { local } = syncTools(s, t.tools);
  try {
    s.agent = await deps.createAgent({
      model: { id: modelId, ...(params?.length ? { params } : {}) },
      apiKey,
      agentId,
      tools: ["mcp"],
      local: { cwd, settingSources: [], customTools: local?.customTools },
    });
  } catch (err) {
    debug(`M2 recreate failed key=${s.key.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  s.generation++;
  s.sentFirst = false;
  debug(`M2 rebuild key=${s.key.slice(0, 12)} gen=${s.generation}`);
  return true;
}

async function commitModelCompress(opts: {
  s: CursorSession;
  t: Transcript;
  sessionKey: string;
  cwd: string;
  deps?: CompactDeps;
  apiKey: string;
  modelId: string;
  params: Param[] | undefined;
  contextWindowTokens?: number;
}): Promise<string | undefined> {
  const { s, t, sessionKey, cwd, deps, apiKey, modelId, params } = opts;
  const agentId = String(s.agent?.agentId ?? "");
  if (!deps || s.closed || !agentId) return undefined;

  const pending = takeModelCompress(sessionKey);
  if (!pending?.summary) return undefined;

  const keepTurns =
    pending.keepTurns ||
    deps.resolveKeepTurns(
      sessionKey,
      t.messages,
      estimateTranscript(t.systemPrompt, t.tools, t.messages),
      opts.contextWindowTokens ?? 200_000,
      s.compactedAt,
    );
  const plan = buildCompactionPlan(sessionKey, s, t, pending, keepTurns);
  if (!plan) {
    rescheduleModelCompress(sessionKey, pending);
    return undefined;
  }

  const preserve = deps.preserveConfig();
  const windowTokens = opts.contextWindowTokens ?? 200_000;
  const refs = syncMessageRefs(sessionKey, t.messages, { contextWindow: windowTokens, preserve });
  const selected = refs.filter((r) => plan.drop.includes(t.messages[r.index]));
  if (!selected.length) return undefined;
  let staged;
  try {
    staged = prepareKernelCompression(sessionKey, t.messages, {
      startRef: pending.startRef ?? selected[0]!.ref,
      endRef: pending.endRef ?? selected[selected.length - 1]!.ref,
      summary: pending.summary, topic: pending.topic, revision: pending.revision,
    }, windowTokens, preserve);
  } catch (err) {
    debug(`model-compress rejected key=${s.key.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const dropped = refs.filter((r) => staged.newIds.has(r.fingerprint));
  const visibleOwners = new Set(staged.view.messages.map((m) => coreMessageOwner(m.id)));
  const kept = t.messages.filter((m) => visibleOwners.has(contextMessageKey(m)));
  let outcome;
  let usedM2 = false;
  try {
    outcome = imagesOf(kept)?.length ? undefined : await runHostCompaction({
      store: deps.store, agentId, cwd, keepTurns,
      summary: pending.summary, keepFrom: plan.keepFrom,
      needles: [...dropped.map((r) => r.text), s.summary].filter(Boolean),
      keepNeedles: [t.systemPrompt, ...kept.map(incrementText), ...staged.view.messages.filter((m) => m.contentType === "tool-call").map((m) => m.text ?? "")].filter(Boolean),
    });
  } catch (err) {
    debug(`model-compress M3 error key=${s.key.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Retained images cannot be safely associated with prompt blobs by text needles.
  if (!outcome) {
    usedM2 = await rebuildAgentM2({ s, t, agentId, modelId, params, apiKey, cwd, deps });
    if (!usedM2) {
      rescheduleModelCompress(sessionKey, pending);
      return undefined;
    }
  } else {
    s.generation++;
  }
  try {
    staged.commit();
  } catch (err) {
    // A concurrent accepted compression won. Do not publish this archive/view;
    // the next host call must rebuild from the current kernel truth.
    dropSession(s);
    throw err;
  }
  if (usedM2) s.replayView = staged.view;
  archiveCompression({
    sessionId: sessionKey, revision: pending.revision,
    summary: pending.summary, dropRefs: dropped.map((r) => r.ref),
    dropText: dropped.map((r) => r.text).join("\n\n"), topic: pending.topic,
  });
  const applied = kernelTurnPlan(sessionKey, t.messages, staged.view.messages.reduce((n, m) => n + estimateTextTokens(m.text ?? ""), 0), windowTokens, { preserve });
  s.compactedAt = applied.compactedPrefix;
  // All active summaries, not a claim that every earlier raw message is covered.
  s.summary = staged.view.messages.filter((m) => m.text?.startsWith("[Compressed conversation section]"))
    .map((m) => m.text).join("\n\n") || pending.summary;
  s.summaryTokens = estimateTextTokens(s.summary);
  s.appliedViewRevision = pending.revision;
  s.preflightAttempts = 0;
  s.seen = t.messages.map(fingerprint);
  debug(
    `model-compressed key=${s.key.slice(0, 12)} keepFrom=${s.compactedAt} summaryTokens=${s.summaryTokens} rev=${pending.revision} path=${usedM2 ? "M2" : "M3"}`,
  );
  if (deps && !sessionKey.startsWith(ANON_PREFIX)) {
    void autoTierDistillIfReady({
      sessionKey,
      messages: t.messages,
      tokenCount: estimateTranscript(t.systemPrompt, t.tools, t.messages),
      contextWindowTokens: opts.contextWindowTokens ?? 200_000,
      preserve: deps.preserveConfig(),
      apiKey,
      modelId,
      params,
      cwd,
      deps: { createAgent: deps.createAgent, deleteAgent: deps.deleteAgent },
    }).catch(() => {});
  }
  return `${SUMMARY_PREFIX}\n${s.summary}`;
}

/** Fallback when handoff did not run: prepend summary on a later idle incremental send. */
async function applyModelCompress(opts: {
  s: CursorSession;
  t: Transcript;
  sessionKey: string;
  cwd: string;
  deps?: CompactDeps;
  apiKey: string;
  modelId: string;
  params: Param[] | undefined;
  contextWindowTokens?: number;
}): Promise<string> {
  const { s } = opts;
  if (!s.runDone) return "";
  return (await commitModelCompress(opts)) ?? "";
}

/**
 * billion-context §7.2: after the compress tool result is delivered with its
 * batch, stop the old run, rewrite the checkpoint, and continue on a handoff send.
 */
async function handoffAfterCompressTool(opts: {
  s: CursorSession;
  t: Transcript;
  sessionKey: string;
  cwd: string;
  apiKey: string;
  modelId: string;
  params: Param[] | undefined;
  contextWindowTokens: number;
  deps?: CompactDeps;
  send: (s: CursorSession, text: string, images: Image[] | undefined, options: any) => Promise<any>;
  tools: any[];
}): Promise<boolean> {
  const { s, t, sessionKey, cwd, apiKey, modelId, params, contextWindowTokens, deps, send, tools } = opts;
  if (!deps || !peekModelCompress(sessionKey)) return false;

  if (s.pending.some((p) => !p.handed)) {
    debug(`compress handoff deferred key=${s.key.slice(0, 12)}: cursor still has unhanded tool calls`);
    return false;
  }

  const pending = peekModelCompress(sessionKey);
  if (!pending) return false;
  const keepTurns =
    pending.keepTurns ||
    deps.resolveKeepTurns(
      sessionKey,
      t.messages,
      estimateTranscript(t.systemPrompt, t.tools, t.messages),
      contextWindowTokens,
      s.compactedAt,
    );
  if (!buildCompactionPlan(sessionKey, s, t, pending, keepTurns)) {
    takeModelCompress(sessionKey);
    debug(`compress handoff skipped key=${s.key.slice(0, 12)}: nothing to compact (keepTurns=${keepTurns})`);
    return false;
  }

  const candidate = buildCompactionPlan(sessionKey, s, t, pending, keepTurns)!;
  const candidateRefs = syncMessageRefs(sessionKey, t.messages, { contextWindow: contextWindowTokens, preserve: deps.preserveConfig() })
    .filter((r) => candidate.drop.includes(t.messages[r.index]));
  try {
    if (!candidateRefs.length) throw new Error("no compressible refs");
    prepareKernelCompression(sessionKey, t.messages, {
      startRef: pending.startRef ?? candidateRefs[0]!.ref,
      endRef: pending.endRef ?? candidateRefs[candidateRefs.length - 1]!.ref,
      summary: pending.summary, topic: pending.topic, revision: pending.revision,
    }, contextWindowTokens, deps.preserveConfig());
  } catch (err) {
    takeModelCompress(sessionKey);
    debug(`compress handoff rejected without cancelling key=${s.key.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  settle(() => void Promise.resolve(s.run?.cancel?.()).catch(() => {}));
  const deadline = Date.now() + CANCEL_WAIT_MS;
  while (!s.runDone && Date.now() < deadline) await s.waitForChange(deadline - Date.now());
  if (!s.runDone) {
    debug(`compress handoff blocked key=${s.key.slice(0, 12)}: run did not stop`);
    return false;
  }

  const summary = await commitModelCompress({
    s,
    t,
    sessionKey,
    cwd,
    deps,
    apiKey,
    modelId,
    params,
    contextWindowTokens,
  });
  if (!summary) return false;

  let emittedChars = 0;
  for (const msg of s.events) {
    if (msg?.type !== "assistant") continue;
    for (const b of msg.message?.content ?? []) {
      if (b?.type === "text" && b.text) emittedChars += b.text.length;
    }
  }
  const dedup =
    emittedChars > 0
      ? `Do not repeat the ${emittedChars} characters of assistant text already emitted in the interrupted run.`
      : "";
  const text = [summary, COMPRESS_HANDOFF_NOTE, dedup, "Continue the task."].filter(Boolean).join("\n\n");
  const run = await send(s, text, undefined, syncTools(s, tools));
  s.startRun(run, false);
  if (!s.sentFirst) s.sentFirst = true;
  debug(`compress handoff sent key=${s.key.slice(0, 12)} chars=${text.length} gen=${s.generation}`);
  return true;
}

/** Test hook. */
export function batchIncludesCompress(results: Results): boolean {
  return results.some((r) => r.call.name === COMPRESS_TOOL_NAME);
}

function publishContextFill(
  sessionKey: string,
  t: Transcript,
  modelId: string,
  contextWindowTokens: number,
  compact: CompactDeps | undefined,
): void {
  if (!compact?.preserveConfig) return;
  const snap = sessionSnapshot(sessionKey, t.messages, t.systemPrompt, t.tools, modelId, compact.preserveConfig());
  const retained = snap.estimatedRetainedTokens ?? 0;
  const limit = contextWindowTokens;
  const percent = limit > 0 ? Math.min(100, Math.round((retained / limit) * 100)) : 0;
  setContextFillSnapshot({
    sessionId: sessionKey,
    modelId,
    percent,
    retainedTokens: retained,
    limitTokens: limit,
    viewPending: snap.viewPending,
    updatedAt: Date.now(),
  });
}

/** Live Cursor session metadata for context tools. */
export function sessionSnapshot(
  sessionKey: string,
  messages: any[],
  systemPrompt: string,
  tools: any[],
  modelId: string,
  preserve?: AcpPreserveConfig,
) {
  const s = liveCursorSessions(sessionKey)[0];
  const pending = peekModelCompress(sessionKey);
  const windowTokens = contextWindow({ id: modelId });
  const retained = kernelResidentTokens(sessionKey, messages, systemPrompt, tools, windowTokens) + cursorOverhead(modelId);
  const acpPlan =
    s && !sessionKey.startsWith(ANON_PREFIX)
      ? kernelTurnPlan(sessionKey, messages, retained, windowTokens, { compactedAt: s.compactedAt, preserve })
      : undefined;
  const keepFrom = pending?.keepTurns
    ? Math.max(0, messages.length - pending.keepTurns)
    : (acpPlan?.keepFromIndex ?? Math.max(0, messages.length - 5));
  const stats = ledgerStats(sessionKey);
  const droppable = compressibleRefs(sessionKey, s?.compactedAt ?? 0, keepFrom).map((r) => r.ref);
  const desired = pending?.revision ?? null;
  return {
    generation: s?.generation ?? 0,
    appliedViewRevision: s?.appliedViewRevision ?? 0,
    desiredViewRevision: desired,
    viewPending: desired !== null && desired !== (s?.appliedViewRevision ?? 0),
    compactedAt: s?.compactedAt ?? 0,
    previousSummary: s?.summary ?? "",
    summaryChars: s?.summary.length ?? 0,
    summaryTokens: s?.summaryTokens ?? 0,
    pendingRevision: pending?.revision ?? null,
    pendingKeepTurns: pending?.keepTurns ?? null,
    pendingRange:
      pending?.startRef && pending?.endRef ? { start: pending.startRef, end: pending.endRef } : null,
    runDone: s?.runDone ?? null,
    busy: s?.busy ?? null,
    unhandedTools: s?.pending.filter((p) => !p.handed).map((p) => p.name) ?? [],
    messageCount: messages.length,
    retainedMessages: messages.length - (acpPlan?.coveredIndexes.size ?? 0),
    compressibleRefs: droppable,
    acpCompressibleRanges: acpPlan?.compressibleRanges ?? [],
    acpProtectedRanges: acpPlan?.protectedRanges ?? [],
    preserveKeepFrom: keepFrom,
    estimatedRetainedTokens: s ? retained : null,
    ledger: stats,
    kernel: s && !sessionKey.startsWith(ANON_PREFIX) ? kernelStatus(sessionKey, windowTokens, retained, preserve) : null,
    panel:
      s && !sessionKey.startsWith(ANON_PREFIX)
        ? renderLiveContextPanel({
            sessionId: sessionKey,
            messages,
            systemPrompt,
            tools,
            modelId,
            preserve,
            compactedAt: s.compactedAt,
          })
        : null,
  };
}

function residentTokens(s: CursorSession | undefined, t: Transcript, modelId: string, replyDraft: any[] = []): number {
  if (!s) return estimateTranscript(t.systemPrompt, t.tools, t.messages, replyDraft) + cursorOverhead(modelId);
  return kernelResidentTokens(s.key, t.messages, t.systemPrompt, t.tools, contextWindow({ id: modelId })) +
    estimateTranscript("", [], [], replyDraft) + cursorOverhead(modelId);
}

function attachContextNudge(s: CursorSession | undefined, text: string, nudge: string | undefined, resident: number): string {
  if (!nudge || !s) return text;
  s.lastNudgeResident = resident;
  return [nudge, text].filter(Boolean).join("\n\n");
}

/** §8 hard preflight when over budget; returns summary block, false on fatal budget error, undefined if skipped. */
async function autoPreflightIfOverBudget(opts: {
  s: CursorSession;
  t: Transcript;
  sessionKey: string;
  cwd: string;
  deps: CompactDeps;
  apiKey: string;
  modelId: string;
  params: Param[] | undefined;
  contextWindowTokens: number;
  reply: Reply;
}): Promise<string | false | undefined> {
  const { s, t, sessionKey, deps, reply } = opts;
  if (peekModelCompress(sessionKey)) return undefined;
  const budgetCfg = deps.readBudget();
  const resident = residentTokens(s, t, opts.modelId, []);
  const pressure = assessContextPressure({
    modelContextTokens: opts.contextWindowTokens,
    params: opts.params,
    modelId: opts.modelId,
    estimatedResident: resident,
    lastNudgeResident: s.lastNudgeResident,
    settings: { outputReserve: budgetCfg.outputReserve, safetyMargin: budgetCfg.safetyMargin },
  });
  if (!pressure.overHard) return undefined;
  if (s.preflightAttempts >= budgetCfg.preflightMaxAttempts) {
    reply.finish(
      "error",
      "Cursor context budget exceeded. Call cursor_context_compress with a continuation summary or reduce history.",
      ERROR_CODES.contextBudget,
    );
    return false;
  }
  if (!s.runDone) return undefined;
  const keepTurns = deps.resolveKeepTurns(
    sessionKey,
    t.messages,
    residentTokens(s, t, opts.modelId, []),
    opts.contextWindowTokens,
    s.compactedAt,
  );
  const plan = planCompaction({
    messages: t.messages,
    compactedAt: s.compactedAt,
    keepTurns,
    previousSummary: s.summary,
  });
  if (!plan?.history) return undefined;
  const summary = await runPreflightSummary({
    history: plan.history,
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    params: opts.params,
    cwd: opts.cwd,
    deps: { createAgent: deps.createAgent, deleteAgent: deps.deleteAgent },
  });
  s.preflightAttempts++;
  if (!summary || summary.length < 32) return undefined;
  scheduleModelCompress(sessionKey, summary, { keepTurns, topic: "preflight" });
  debug(`preflight compress key=${s.key.slice(0, 12)} attempt=${s.preflightAttempts}`);
  return (
    (await commitModelCompress({
      s,
      t,
      sessionKey,
      cwd: opts.cwd,
      deps,
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      params: opts.params,
      contextWindowTokens: opts.contextWindowTokens,
    })) ?? undefined
  );
}

function contextPressure(
  s: CursorSession | undefined,
  t: Transcript,
  modelId: string,
  params: Param[] | undefined,
  contextWindowTokens: number,
  deps: CompactDeps | undefined,
) {
  if (!deps || !s) return undefined;
  const budgetCfg = deps.readBudget();
  return assessContextPressure({
    modelContextTokens: contextWindowTokens,
    params,
    modelId,
    estimatedResident: residentTokens(s, t, modelId, []),
    lastNudgeResident: s.lastNudgeResident,
    settings: { outputReserve: budgetCfg.outputReserve, safetyMargin: budgetCfg.safetyMargin },
  });
}

function pickContextNudge(
  sessionKey: string,
  s: CursorSession,
  t: Transcript,
  modelId: string,
  params: Param[] | undefined,
  contextWindowTokens: number,
  deps: CompactDeps,
): string | undefined {
  const resident = residentTokens(s, t, modelId, []);
  const kernel = kernelNudgeForTurn(sessionKey, t.messages, resident, contextWindowTokens, deps.preserveConfig());
  if (kernel) return kernel;
  const pressure = contextPressure(s, t, modelId, params, contextWindowTokens, deps);
  if (!pressure?.nudge) return undefined;
  if (pressure.overHard || pressure.softNudge) return pressure.nudge;
  return undefined;
}

async function deliverBudgetHandoffSend(opts: {
  s: CursorSession;
  t: Transcript;
  summary: string;
  send: (s: CursorSession, text: string, images: Image[] | undefined, options: any) => Promise<any>;
  tools: any[];
}): Promise<void> {
  const { s, send, tools, summary } = opts;
  let emittedChars = 0;
  for (const msg of s.events) {
    if (msg?.type !== "assistant") continue;
    for (const b of msg.message?.content ?? []) {
      if (b?.type === "text" && b.text) emittedChars += b.text.length;
    }
  }
  const dedup =
    emittedChars > 0
      ? `Do not repeat the ${emittedChars} characters of assistant text already emitted in the interrupted run.`
      : "";
  const text = [summary, COMPRESS_HANDOFF_NOTE, dedup, "Continue the task."].filter(Boolean).join("\n\n");
  const run = await send(s, text, undefined, syncTools(s, tools));
  s.startRun(run, false);
  if (!s.sentFirst) s.sentFirst = true;
}

/** Run one DSH model call on a persistent Cursor session; every chunk goes to `reply`. */
export async function runTurn(opts: {
  model: { id: string; cursorParameters?: unknown };
  transcript: Transcript;
  reasoning?: string;
  signal?: AbortSignal;
  apiKey: string | undefined;
  sessionKey: string;
  cwd: string;
  deps: TurnDeps;
  reply: Reply;
  contextWindowTokens?: number;
}): Promise<void> {
  const { model, apiKey, sessionKey, cwd, reply, signal, deps } = opts;
  const t = opts.transcript;
  const modelId = resolveModelId(model.id);
  const contextWindowTokens = opts.contextWindowTokens ?? 200_000;
  const budgetActive = Boolean(deps.compact) && !sessionKey.startsWith(ANON_PREFIX);
  const effectiveSystem = t.systemPrompt;
  if (!apiKey) {
    return reply.finish("error", "No Cursor API key. Store CURSOR_API_KEY in DSH credentials or export it before launching DSH.", ERROR_CODES.missingKey);
  }

  if (!sessionKey.startsWith(ANON_PREFIX)) {
    syncMessageRefs(sessionKey, t.messages, {
      tokenCount: estimateTranscript(t.systemPrompt, t.tools, t.messages),
      contextWindow: contextWindowTokens,
      compactedAt: liveCursorSessions(sessionKey)[0]?.compactedAt ?? 0,
      preserve: deps.compact?.preserveConfig(),
    });
  }

  let params = modelParams(model, opts.reasoning);
  const known = workingContext.get(modelId);
  if (known) params = params?.map((p) => (p.id === "context" ? { id: p.id, value: known } : p));
  const signature = signatureOf(modelId, params);

  const transcriptTokens = () => estimateTranscript(t.systemPrompt, t.tools, t.messages, reply.content);
  const contextTokens = () => transcriptTokens() + cursorOverhead(modelId);

  const send = async (s: CursorSession, text: string, images: Image[] | undefined, sendOptions: any) => {
    if (s.replayView) {
      const view = s.replayView;
      const owners = new Set(view.messages.map((m) => coreMessageOwner(m.id)));
      text = [renderTranscriptWithAcpView(effectiveSystem, t.messages, view.messages), COMPRESS_HANDOFF_NOTE, "Continue the task."].join("\n\n");
      images = imagesOf(t.messages.filter((m) => owners.has(contextMessageKey(m))));
      s.replayView = undefined;
      s.sentFirst = true;
    }
    return s.agent.send(images?.length ? { text, images } : text, sendOptions);
  };
  const sendFirst = async (s: CursorSession, prefix = "", acpView?: AcpWireView) => {
    s.sentFirst = true;
    const body = acpView
      ? renderTranscriptWithAcpView(effectiveSystem, t.messages, acpView.messages)
      : renderTranscript(effectiveSystem, t.messages);
    const text = [prefix, body].filter(Boolean).join("\n\n");
    s.startRun(await send(s, text, currentTurnImages(t.messages), {}));
  };

  let s = (SESSIONS.get(sessionKey) ?? []).find((x) => x.signature === signature && !x.closed && !x.busy);
  const wireView = acpWireView(
    sessionKey,
    t,
    effectiveSystem,
    contextWindowTokens,
    deps.compact,
    liveCursorSessions(sessionKey)[0]?.compactedAt ?? 0,
  );
  let plan = planIncrement(s, t.messages, wireView);
  let note = "";
  if (s && plan.kind !== "fresh") {
    const addition = systemPromptAddition(s.systemPrompt, effectiveSystem);
    if (addition === undefined) plan = { kind: "fresh" };
    else note = addition;
  }
  debug(`turn key=${sessionKey.slice(0, 12)} msgs=${t.messages.length} seen=${s?.seen.length ?? "-"} plan=${plan.kind}`);
  if (s && plan.kind === "fresh") {
    dropSession(s);
    s = undefined;
  }

  let freshRun = false;
  let emitted = false;
  const onAbort = () => s?.wake();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    if (!s || plan.kind === "fresh") {
      const started = Date.now();
      s = await openSession(sessionKey, modelId, params, t, apiKey, cwd, deps);
      s.systemPrompt = effectiveSystem;
      const created = Date.now();
      s.busy = true;
      let prefix = "";
      if (budgetActive && deps.compact) {
        const auto = await autoPreflightIfOverBudget({
          s,
          t,
          sessionKey,
          cwd,
          deps: deps.compact,
          apiKey,
          modelId,
          params,
          contextWindowTokens,
          reply,
        });
        if (auto === false) return;
        if (typeof auto === "string") prefix = auto;
        else prefix = pickContextNudge(sessionKey, s, t, modelId, params, contextWindowTokens, deps.compact) ?? "";
        if (prefix) s.lastNudgeResident = residentTokens(s, t, modelId, []);
      }
      await sendFirst(s, prefix, wireView);
      debug(`fresh key=${sessionKey.slice(0, 12)} create=${created - started}ms send=${Date.now() - created}ms chars=${renderTranscript(t.systemPrompt, t.messages).length} tools=${t.tools.length}`);
      freshRun = true;
    } else if (plan.kind === "send") {
      s.busy = true;
      // Between runs only: a run in flight writes its own checkpoint when it
      // ends and would undo the rewrite.
      let compressed = "";
      if (budgetActive && deps.compact) {
        const auto = await autoPreflightIfOverBudget({
          s,
          t,
          sessionKey,
          cwd,
          deps: deps.compact,
          apiKey,
          modelId,
          params,
          contextWindowTokens,
          reply,
        });
        if (auto === false) return;
        if (typeof auto === "string") compressed = auto;
      }
      if (!compressed) {
        compressed = await applyModelCompress({
          s,
          t,
          sessionKey,
          cwd,
          deps: deps.compact,
          apiKey,
          modelId,
          params,
          contextWindowTokens,
        });
      }
      let text = [compressed, note, addedToolsNote(s, t.tools), plan.text].filter(Boolean).join("\n\n");
      if (budgetActive && deps.compact && !compressed) {
        const nudge = pickContextNudge(sessionKey, s, t, modelId, params, contextWindowTokens, deps.compact);
        if (nudge) text = attachContextNudge(s, text, nudge, residentTokens(s, t, modelId, []));
      }
      s.startRun(await send(s, text, plan.images, syncTools(s, t.tools)));
      s.systemPrompt = t.systemPrompt;
    } else if (note || s.toolsKey !== toolsKeyOf(t.tools)) {
      s.busy = true;
      debug(`tools or system prompt changed mid-run key=${sessionKey.slice(0, 12)}`);
      if (await continueWithNewTools(s, plan.results, t.tools, note, send)) {
        s.systemPrompt = t.systemPrompt;
      } else {
        dropSession(s);
        s = await openSession(sessionKey, modelId, params, t, apiKey, cwd, deps);
        s.systemPrompt = effectiveSystem;
        s.busy = true;
        await sendFirst(s, "", wireView);
        freshRun = true;
      }
    } else {
      s.busy = true;
      s.modelCalls++;
      const compressBatch = batchIncludesCompress(plan.results);
      for (const r of plan.results) {
        s.pending = s.pending.filter((p) => p !== r.call);
        r.call.resolve(toolResultForCursor(r.message, r.extra));
      }
      if (!compressBatch && budgetActive && deps.compact) {
        const auto = await autoPreflightIfOverBudget({
          s,
          t,
          sessionKey,
          cwd,
          deps: deps.compact,
          apiKey,
          modelId,
          params,
          contextWindowTokens,
          reply,
        });
        if (auto === false) return;
        if (typeof auto === "string") {
          await deliverBudgetHandoffSend({ s, t, summary: auto, send, tools: t.tools });
          s.systemPrompt = t.systemPrompt;
        }
      }
      if (compressBatch) {
        const handed = await handoffAfterCompressTool({
          s,
          t,
          sessionKey,
          cwd,
          apiKey,
          modelId,
          params,
          contextWindowTokens,
          deps: deps.compact,
          send,
          tools: t.tools,
        });
        if (handed) s.systemPrompt = t.systemPrompt;
      }
    }
    s.touch();
    // What Cursor has now seen; this call's reply is appended when it ends.
    s.seen = t.messages.map(fingerprint);

    for (;;) {
      while (s.events.length) {
        const msg = s.events.shift();
        if (msg?.type === "thinking") {
          reply.thinking(msg.text);
          emitted ||= Boolean(msg.text);
        } else if (msg?.type === "assistant") {
          for (const b of msg.message?.content ?? []) {
            if (b?.type === "text" && b.text) {
              reply.text(b.text);
              emitted = true;
            }
          }
        }
      }
      if (signal?.aborted) {
        dropSession(s);
        return reply.finish("aborted");
      }

      const fresh = s.pending.filter((p) => !p.handed);
      if (fresh.length) {
        // Parallel calls arrive a few ms apart; hand them to DSH together.
        const wait = s.lastCallAt + HANDOFF_DEBOUNCE_MS - Date.now();
        if (wait > 0) {
          await s.waitForChange(wait);
          continue;
        }
        for (const p of fresh) p.handed = true;
        reply.toolCalls(fresh.map((p) => ({ id: p.id, name: p.name, arguments: p.args })));
        // Cursor reports usage only when the run ends; a mid-run estimate would count as spend.
        reply.finish("toolUse");
        s.seen.push(fingerprint(reply.message));
        return;
      }

      if (!s.runDone) {
        await s.waitForChange();
        continue;
      }

      const result = s.runResult;
      const status = result?.status ?? (s.runError ? "error" : "finished");
      if (status === "finished") {
        reply.usage = runUsage(result?.usage, s.modelCalls, contextTokens());
        if (s.modelCalls === 1 && s.runCalibrates) calibrateOverhead(modelId, result?.usage, transcriptTokens());
        s.run = undefined;
        reply.finish("stop");
        s.seen.push(fingerprint(reply.message));
        if (sessionKey.startsWith(ANON_PREFIX)) dropSession(s);
        return;
      }

      const error = result?.error?.message ?? (s.runError instanceof Error ? s.runError.message : s.runError ? String(s.runError) : undefined);
      const lower = freshRun && !emitted && s.modelCalls === 1 && isRejectedParams(error) ? smallerContext(model, s.params) : undefined;
      if (lower) {
        workingContext.set(modelId, lower.find((p) => p.id === "context")!.value);
        dropSession(s);
        s = await openSession(sessionKey, modelId, lower, t, apiKey, cwd, deps);
        s.systemPrompt = effectiveSystem;
        s.busy = true;
        await sendFirst(s, "", wireView);
        s.seen = t.messages.map(fingerprint);
        continue;
      }
      dropSession(s);
      return reply.finish(status === "cancelled" ? "aborted" : "error", error);
    }
  } catch (err) {
    if (s) dropSession(s);
    reply.finish(signal?.aborted ? "aborted" : "error", err instanceof Error ? err.message : String(err));
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    if (s) {
      s.busy = false;
      if (!s.closed) s.touch();
    }
    if (budgetActive && deps.compact) {
      try {
        publishContextFill(sessionKey, t, modelId, contextWindowTokens, deps.compact);
      } catch {
        /* snapshot is best-effort for the UI pill */
      }
    }
    if (!reply.stopReason) {
      reply.finish("error", "Cursor turn ended without a result");
    }
  }
}
