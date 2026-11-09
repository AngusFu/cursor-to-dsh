import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessContextPressure,
  growthNudgeThreshold,
  inputBudget,
  effectiveContextWindow,
  GROWTH_NUDGE_TEXT,
} from "../src/context/budget.ts";

test("inputBudget subtracts reserves from effective window", () => {
  assert.equal(inputBudget(200_000), 200_000 - 8_192 - 8_192);
});

test("growth nudge threshold follows RFC min(30K, 15%W)", () => {
  assert.equal(growthNudgeThreshold(200_000), 30_000);
  assert.equal(growthNudgeThreshold(100_000), 15_000);
});

test("assessContextPressure flags soft nudge before hard overflow", () => {
  const budget = inputBudget(200_000);
  const soft = assessContextPressure({
    modelContextTokens: 200_000,
    params: undefined,
    modelId: "claude-sonnet-5-5",
    estimatedResident: Math.floor(budget * 0.9),
    lastNudgeResident: 0,
  });
  assert.equal(soft.softNudge, true);
  assert.equal(soft.overHard, false);
  assert.equal(soft.nudge, GROWTH_NUDGE_TEXT);

  const hard = assessContextPressure({
    modelContextTokens: 200_000,
    params: undefined,
    modelId: "claude-sonnet-5-5",
    estimatedResident: budget + 1,
    lastNudgeResident: 0,
  });
  assert.equal(hard.overHard, true);
});

test("effectiveContextWindow prefers session params over catalog default", () => {
  assert.equal(
    effectiveContextWindow(200_000, [{ id: "context", value: "300k" }], "m1"),
    300_000,
  );
});
