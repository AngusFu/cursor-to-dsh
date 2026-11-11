import { after, before } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLedgerDb } from "../src/context/ledger-persist.ts";

/**
 * Parallel test files share one process HOME ledger. Call at file scope so
 * this file writes under a temp HOME and resets the SQLite handle around it.
 */
export function isolateLedgerHome(prefix = "cursor-ledger-"): void {
  const previousHome = process.env.HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), prefix));
  before(() => {
    process.env.HOME = isolatedHome;
    resetLedgerDb();
  });
  after(() => {
    resetLedgerDb();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(isolatedHome, { recursive: true, force: true });
  });
}
