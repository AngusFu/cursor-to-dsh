/**
 * Smoke the running `dsh web` host APIs (does not drive Cursor).
 *
 *   DSH_WEB=http://127.0.0.1:3080 DSH_TOKEN=... node --experimental-strip-types scripts/dsh-web-smoke.ts
 */
const base = (process.env.DSH_WEB ?? "http://127.0.0.1:3080").replace(/\/$/, "");
const token = process.env.DSH_TOKEN ?? "";

let failed = 0;
const ok = (what: string, detail = "") => console.log(`  PASS ${what}${detail ? ` — ${detail}` : ""}`);
const bad = (what: string, detail = "") => {
  failed += 1;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
};

const jar = new Map<string, string>();
function remember(res: Response) {
  const raw = res.headers.get("set-cookie");
  if (!raw) return;
  for (const part of raw.split(",")) {
    const seg = part.split(";")[0]?.trim();
    const eq = seg?.indexOf("=");
    if (eq && eq > 0) jar.set(seg.slice(0, eq), seg.slice(eq + 1));
  }
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${base}${path}`, { headers, redirect: "manual" });
  remember(res);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, body };
}

console.log(`DSH_WEB=${base} token=${token ? "set" : "unset"}`);

if (token) {
  const login = await get(`/?token=${encodeURIComponent(token)}`);
  if (login.status >= 200 && login.status < 400) ok("token login", String(login.status));
  else bad("token login", String(login.status));
} else {
  bad("DSH_TOKEN", "set DSH_TOKEN from dsh web startup log");
}

const statusRes = await get("/api/cursor-to-dsh/status");
const statusPayload = statusRes.body as { ok?: boolean; value?: { contextManagement?: unknown } };
if (statusRes.status === 200 && statusPayload?.ok && statusPayload.value?.contextManagement) {
  ok("GET /status", "contextManagement present");
} else {
  bad("GET /status", JSON.stringify(statusRes.body).slice(0, 120));
}

const panelsRes = await get("/api/cursor-to-dsh/context/panel-sessions");
const ps = panelsRes.body as { ok?: boolean; value?: { sqlite?: boolean; sessions?: unknown[] } };
if (panelsRes.status === 200 && ps?.ok && ps.value?.sqlite === true) {
  ok("GET /context/panel-sessions", `sessions=${ps.value?.sessions?.length ?? 0}`);
} else {
  bad("GET /context/panel-sessions", JSON.stringify(panelsRes.body).slice(0, 120));
}

const sampleId =
  (ps?.value?.sessions?.[0] as { sessionId?: string } | undefined)?.sessionId ?? "sess-1";
const panelRes = await get(`/api/cursor-to-dsh/context/panel?sessionId=${encodeURIComponent(sampleId)}&modelId=claude-haiku-5-5`);
const pb = panelRes.body as { ok?: boolean; value?: { panel?: string; error?: string } };
if (panelRes.status === 200 && pb?.ok && pb.value?.panel?.includes("ACP")) ok("GET /context/panel", sampleId);
else if (pb?.value?.error) ok("GET /context/panel", pb.value.error);
else bad("GET /context/panel", JSON.stringify(panelRes.body).slice(0, 120));

const fillRes = await get(`/api/cursor-to-dsh/context/fill?sessionId=${encodeURIComponent(sampleId)}`);
const fb = fillRes.body as { ok?: boolean; value?: { percent?: number; error?: string } };
if (fillRes.status === 200 && fb?.ok && typeof fb.value?.percent === "number") ok("GET /context/fill", `${fb.value.percent}%`);
else if (fb?.value?.error === "no live reading yet") {
  ok("GET /context/fill", "no reading yet (expected until a DSH-web Cursor turn)");
} else {
  bad("GET /context/fill", JSON.stringify(fill.body).slice(0, 120));
}

console.log(failed ? `\nFAILED ${failed}` : "\nDSH WEB API SMOKE OK");
console.log("\nBrowser-only (not automated here): Cursor-routed turn → fill pill + /cursor-context-fill");
process.exit(failed ? 1 : 0);
