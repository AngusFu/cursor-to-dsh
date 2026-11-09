import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * DSH `connection.fetch.register` rejects GET routes without `requestBody: "buffered"`.
 * This caught panel routes returning HTTP 400 in the browser (Settings context panel).
 */
test("host-api panel GET routes declare requestBody buffered", () => {
  const src = readFileSync(new URL("../src/host-api.ts", import.meta.url), "utf8");
  for (const path of ["context/panel-sessions", "context/panel", "context/fill"]) {
    const marker = `${path}\``;
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `missing route ${path}`);
    const slice = src.slice(start, start + 400);
    assert.match(slice, /requestBody:\s*"buffered"/, `${path} must set requestBody: "buffered"`);
  }
});
