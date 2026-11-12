import { test } from "node:test";
import assert from "node:assert/strict";

import { isBiliAcpTool, withoutBiliAcpTools } from "../src/context/bili-tools.ts";
const COMPRESS_TOOL_NAME = "cursor_context_compress";
const DECOMPRESS_TOOL_NAME = "cursor_context_decompress";
import { fakeCursor, adapterFor, say, sys, user } from "./session-harness.ts";
import { closeAllCursorSessions } from "../src/session.ts";


const biliCompress = {
  name: "compress",
  description: "Compress a conversation block by startId/endId into a summary.",
  parameters: {
    type: "object",
    properties: {
      startId: { type: "string" },
      endId: { type: "string" },
      summary: { type: "string" },
    },
  },
};
const biliDecompress = {
  name: "decompress",
  description: "Restore a compressed block by blockId",
  parameters: { type: "object", properties: { blockId: { type: "string" }, imageRef: { type: "string" } } },
};
const zipCompress = {
  name: "compress",
  description: "Zip the given files",
  parameters: { type: "object", properties: { files: { type: "array" }, format: { type: "string" } } },
};

test("isBiliAcpTool matches reserved ACP/retired names and fingerprinted generic names only", () => {
  assert.equal(isBiliAcpTool(biliCompress), true);
  assert.equal(isBiliAcpTool(biliDecompress), true);
  assert.equal(isBiliAcpTool({ name: "search_context", description: "search" }), true);
  assert.equal(isBiliAcpTool({ name: "acp_status" }), true);
  assert.equal(isBiliAcpTool({ name: "acp_cache" }), true);
  assert.equal(isBiliAcpTool(zipCompress), false);
  assert.equal(isBiliAcpTool({ name: COMPRESS_TOOL_NAME, description: "compress", parameters: { type: "object", properties: { summary: { type: "string" } } } }), true);
  assert.equal(isBiliAcpTool({ name: DECOMPRESS_TOOL_NAME, parameters: { type: "object", properties: { imageRef: { type: "string" } } } }), true);
  assert.equal(isBiliAcpTool({ name: "read_file" }), false);
});

test("withoutBiliAcpTools keeps unrelated compress, drops retired local and global bili tools", () => {
  const kept = withoutBiliAcpTools([
    { name: COMPRESS_TOOL_NAME, description: "compress" },
    biliCompress,
    zipCompress,
    { name: "search_context" },
    { name: "read_file" },
  ]);
  assert.deepEqual(
    kept.map((t) => t.name),
    ["compress", "read_file"],
  );
  assert.equal(kept[0], zipCompress);
});

test("Cursor createAgent customTools omit bili ACP and retired local tools, retaining normal DSH tools", async () => {
  closeAllCursorSessions();
  const cursor = fakeCursor(async function* () {
    yield say("ok");
  });
  const adapter = adapterFor(cursor);
  const chunks: unknown[] = [];
  for await (const chunk of adapter.stream({
    provider: "cursor",
    model: "m",
    sessionId: `bili-filter-${Date.now()}`,
    messages: [sys("SYS"), user("hello")],
    tools: [
      { name: COMPRESS_TOOL_NAME, description: "cursor compress", parameters: { type: "object", properties: {} } },
      biliCompress,
      { name: "search_context", description: "search archive", parameters: { type: "object", properties: { query: { type: "string" } } } },
      { name: "acp_status", description: "status", parameters: { type: "object", properties: {} } },
      zipCompress,
      { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ],
  })) {
    chunks.push(chunk);
  }
  const custom = cursor.created[0]?.local?.customTools ?? {};
  assert.equal(custom[COMPRESS_TOOL_NAME], undefined, "retired local compress tool cannot reach Cursor");
  assert.ok(custom.read_file, "unrelated host tools stay");
  assert.ok(custom.compress, "unrelated compress (zip) stays");
  assert.equal(custom.search_context, undefined, "search_context must not reach Cursor");
  assert.equal(custom.acp_status, undefined, "acp_status must not reach Cursor");
  // The zip compress is the one that remains under the generic name.
  assert.match(String(custom.compress.description), /Zip/i);
  closeAllCursorSessions();
});
