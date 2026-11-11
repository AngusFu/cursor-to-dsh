import { test } from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "acp-kernel";

import { renderContextPanel, renderPersistedContextPanel } from "../src/context/panel.ts";
import { ledgerPersistenceWritable, persistKernelState } from "../src/context/ledger-persist.ts";
import { clearKernelSessions, flushKernelState, kernelTurnPlan } from "../src/context/kernel.ts";

test("renderContextPanel emits cursor-to-dsh version header", () => {
  const text = renderContextPanel({
    state: createInitialState(),
    modelContextLimit: 200_000,
    tokenCount: 12_000,
    systemPromptTokens: 500,
  });
  assert.match(text, /cursor-to-dsh@/);
  assert.match(text, /200/);
});

test("persisted panel uses last_token_count from SQLite", () => {
  if (!ledgerPersistenceWritable()) return;
  clearKernelSessions();
  const sessionId = `panel-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const messages = [
    { role: "user", content: "x".repeat(4000) },
    { role: "assistant", content: "ok" },
  ];
  kernelTurnPlan(sessionId, messages, 12_000, 200_000);
  flushKernelState(sessionId);
  const panel = renderPersistedContextPanel(sessionId);
  assert.ok(panel);
  assert.match(panel!, /12/);
});

test("persistKernelState stores lastTokenCount explicitly", () => {
  if (!ledgerPersistenceWritable()) return;
  clearKernelSessions();
  const sessionId = `panel-explicit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  persistKernelState(sessionId, {
    state: createInitialState(),
    appliedRevision: 0,
    lastTokenCount: 48_000,
  });
  const panel = renderPersistedContextPanel(sessionId);
  assert.ok(panel);
  assert.match(panel!, /48k|48,000|48000/i);
});
