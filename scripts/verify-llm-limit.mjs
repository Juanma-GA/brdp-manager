// Protecciones 2a, Part 3: the per-user limit on AI requests in a real
// browser. Needs postgres, vite (5173) and the Mistral simulators
// (mock-mistral-chat-server.mjs on 8902, mock-mistral-embed-server.mjs on
// 8901). The script restarts the backend itself (by its exact PID) with a
// low limit -- LLM_CALLS_PER_MINUTE=1 and a per-day limit just above the
// admin's calls of the last 24 h -- and restarts it with the normal limits
// at the end.
//
//   1. Per minute: "Test rule" sends two requests at once (the examples and
//      the Proposal check); one is refused with 429, llmAPI.js waits what
//      the server says and sends it again, and the test ends well -- a
//      verdict, no error -- with a rate_limited row in the usage.
//   2. Per day: once the day's limit is reached, Ask shows the error with
//      the limit and when to try again, in English and in Spanish.
//
// Run: node scripts/verify-llm-limit.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { startUvicorn, uvicornPid } from "./lib/backendProcess.mjs";
import { BACKEND_DIR, backendPython, pythonEnv } from "./lib/backendPython.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const MOCKS = {
  MISTRAL_ENDPOINT: process.env.MISTRAL_ENDPOINT || "http://localhost:8902",
  MISTRAL_EMBED_ENDPOINT: process.env.MISTRAL_EMBED_ENDPOINT || "http://localhost:8901",
};
// Marks the rows this script adds to llm_calls, so it removes only those.
const MARKER_CHARS = -7;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

async function waitBackend(up, tries = 160) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await fetch(`${API}/docs`).then((r) => r.ok).catch(() => false);
    if (ok === up) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not come ${up ? "up" : "down"}`);
}

async function restartBackend(extraEnv) {
  const pid = uvicornPid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    await waitBackend(false);
  }
  const log = fs.openSync(path.join(os.tmpdir(), "uvicorn-llm-limit.log"), "a");
  startUvicorn({ env: { ...MOCKS, ...extraEnv }, log });
  await waitBackend(true);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${ADMIN_EMAIL}: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

function sql(statement, params) {
  const code = [
    "import asyncio, json, sys",
    "from sqlalchemy import text",
    "from app.db.base import engine",
    "async def main():",
    "    async with engine.begin() as conn:",
    "        await conn.execute(text(sys.argv[1]), json.loads(sys.argv[2]))",
    "asyncio.run(main())",
  ].join("\n");
  execFileSync(backendPython(), ["-c", code, statement, JSON.stringify(params)], { cwd: BACKEND_DIR, env: pythonEnv() });
}

async function main() {
  let token = await login();
  const api = (p, init = {}) =>
    fetch(`${API}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const me = await api("/api/auth/me").then((r) => r.json());
  const usage = async () => (await api("/api/admin/llm-usage?days=1").then((r) => r.json())).rows.filter((r) => r.user_id === me.id);
  const sum = (rows, kind, result) => rows.filter((r) => r.kind === kind && (!result || r.result === result)).reduce((a, r) => a + r.calls, 0);

  // The day's limit: just above the chat calls the admin already has in
  // the last 24 h (refused ones never count), so the rule test fits and one
  // more call reaches it.
  const before = await usage();
  const counted = sum(before, "chat") - sum(before, "chat", "rate_limited");
  const dayLimit = counted + 3;
  await restartBackend({ LLM_CALLS_PER_MINUTE: "1", LLM_CALLS_PER_DAY: String(dayLimit) });
  token = await login();

  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `LLM limit ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const brdp = await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({
      identifier: "BRDP-LIM-EMPH",
      title: "Use of the element <emphasis>",
      definition: "Decide how emphasis is used.",
      proposal: "The element <emphasis> shall not be used.",
      validation: "Validated",
    }),
  }).then((r) => r.json());
  const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
    method: "PUT",
    body: JSON.stringify({
      rule_xml: `<structureObjectRule id="BRDP-LIM-EMPH">
  <objectPath allowedObjectFlag="0">//emphasis</objectPath>
  <objectUse>No emphasis.</objectUse>
</structureObjectRule>`,
      source: "manual",
      status: "pending_review",
    }),
  });
  if (!put.ok) throw new Error(`seeding the rule failed: ${put.status}`);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1300 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const responses = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/llm-proxy")) responses.push(r.status());
  });

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-LIM-EMPH" }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(500);

    // 1. Per minute: the test waits and ends well.
    const started = Date.now();
    await page.getByRole("button", { name: "Test rule" }).click();
    await page.getByTestId("rule-test-verdict").waitFor({ timeout: 150000 });
    const seconds = Math.round((Date.now() - started) / 1000);
    const verdict = await page.getByTestId("rule-test-verdict").textContent();
    assert(verdict.startsWith("Correct"), `rule test ends well after waiting (${seconds} s): ${verdict}`);
    assert(responses.includes(429), `one request was refused with 429 on the way (${responses.join(", ")})`);
    assert(responses.filter((s) => s === 200).length >= 2, "both requests answered in the end");
    assert(seconds >= 1, "the operation waited before sending again");
    assert((await page.getByTestId("rule-test-panel").getByRole("alert").count()) === 0, "no error in the test panel");
    const after = await usage();
    assert(sum(after, "chat", "rate_limited") > sum(before, "chat", "rate_limited"), "the refused request is in the usage as rate_limited");
    await page.getByTestId("rule-test-panel").screenshot({ path: shot("llm-limit-minute-wait-ok.png") });

    // 2. Per day: fill the day's limit (rows older than a minute, so the
    //    minute limit is not the one reached), then Ask.
    const now = await usage();
    const missing = dayLimit - (sum(now, "chat") - sum(now, "chat", "rate_limited"));
    for (let i = 0; i < Math.max(0, missing); i += 1) {
      sql(
        "INSERT INTO llm_calls (id, user_id, created_at, kind, result, request_chars) VALUES (gen_random_uuid(), CAST(:uid AS uuid), now() - interval '2 hours', 'chat', 'ok', :marker)",
        { uid: me.id, marker: MARKER_CHARS }
      );
    }
    const askBox = () => page.locator("label", { hasText: /Ask a question|Haz una pregunta/ }).locator("xpath=following::textarea[1]");
    await askBox().fill("What is this decision about?");
    await askBox().press("Enter");
    const alert = page.locator('[role="alert"]', { hasText: /AI requests per day|peticiones a la IA por día/ });
    await alert.waitFor({ timeout: 20000 });
    const en = (await alert.textContent()).trim();
    assert(
      new RegExp(`You have reached the limit of ${dayLimit} AI requests per day\\. Try again in \\d+ (s|min|h)`).test(en),
      `day error in English: ${en}`
    );
    await page.screenshot({ path: shot("llm-limit-day-en.png") });

    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(300);
    await askBox().fill("¿De qué trata esta decisión?");
    await askBox().press("Enter");
    const alertEs = page.locator('[role="alert"]', { hasText: /peticiones a la IA por día/ });
    await alertEs.waitFor({ timeout: 20000 });
    const es = (await alertEs.textContent()).trim();
    assert(
      new RegExp(`Has alcanzado el límite de ${dayLimit} peticiones a la IA por día\\. Vuelve a intentarlo en \\d+ (s|min|h)`).test(es),
      `day error in Spanish: ${es}`
    );
    await page.screenshot({ path: shot("llm-limit-day-es.png") });
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    try {
      await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
    } catch (err) {
      console.error("cleanup (project):", err.message);
    }
    sql("DELETE FROM llm_calls WHERE request_chars = :marker", { marker: MARKER_CHARS });
    await restartBackend({});
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
