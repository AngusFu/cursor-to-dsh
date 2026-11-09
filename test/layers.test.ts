import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveCompressionLayer } from "../src/context/layers.ts";

test("resolveCompressionLayer defaults to T1", () => {
  assert.equal(resolveCompressionLayer(), "T1");
  assert.equal(resolveCompressionLayer("auth refactor"), "T1");
});

test("resolveCompressionLayer honours t2/t3 topic prefixes", () => {
  assert.equal(resolveCompressionLayer("t2:integrations"), "T2");
  assert.equal(resolveCompressionLayer("T3:long-memory"), "T3");
});
