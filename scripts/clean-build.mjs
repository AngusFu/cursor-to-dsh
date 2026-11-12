// lib/ is generated output. Drop retired modules before tsc so an in-place
// update/pack cannot ship stale compression code from an older build.
// This path is fixed relative to this script, never cwd, DSH_HOME or user data.
import { rmSync } from "node:fs";
rmSync(new URL("../lib/", import.meta.url), { recursive: true, force: true });
