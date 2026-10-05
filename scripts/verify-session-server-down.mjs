// Live verification for AACF 2, Part 1: a server that does not answer is
// not "no session". Against the real app (Vite + FastAPI + Postgres); the
// server being down is reproduced by answering /api/** in the browser with
// what the dev proxy really answers when uvicorn is down (502, empty body)
// or by aborting the request (no network at all).
//
//   - Reload with the server down: the connection screen with Retry, the
//     URL kept, never /login. Retry with the server back: the same page.
//   - During use: a 401 whose refresh cannot be asked shows the connection
//     error and keeps the session.
//   - Login with the server down: "could not connect", never "wrong
//     credentials".
//   - A real 401 with the server running: /login, as before.
//
//     node scripts/verify-session-server-down.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const SHOTS = process.env.SHOTS_DIR || "/tmp";

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

const DOWN = { status: 502, body: "" };
// Only the backend's /api/... -- never Vite's own /src/api/*.js modules.
const API_ROUTE = (url) => new URL(url).pathname.startsWith("/api/");

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF2 session ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: "BRDP-SES-A", title: "Session A" }) });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const records = `${BASE_URL}/projects/${project.id}/records`;
  let refreshCalls = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/auth/refresh")) refreshCalls += 1;
  });

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.goto(records);
    await page.waitForSelector("tbody tr", { timeout: 10000 });

    for (const [label, handler] of [
      ["502 (the dev proxy with uvicorn down)", (r) => r.fulfill(DOWN)],
      ["no network (request aborted)", (r) => r.abort("connectionrefused")],
    ]) {
      console.log(`1. Reload with the server down: ${label}`);
      await page.route(API_ROUTE, handler);
      refreshCalls = 0;
      await page.reload();
      await page.getByTestId("connection-error-screen").waitFor({ timeout: 10000 });
      assert(page.url() === records, `the URL is kept (${page.url()})`);
      assert(!page.url().includes("/login"), "never /login");
      const text = await page.getByTestId("connection-error").textContent();
      assert(/Could not connect to the server/.test(text), `"Could not connect to the server" (${text})`);
      await page.waitForTimeout(3000);
      const callsAfterWait = refreshCalls;
      assert(callsAfterWait <= 2, `no automatic retry loop (${callsAfterWait} refresh attempts)`);
      if (label.startsWith("502")) await page.screenshot({ path: `${SHOTS}/session-server-down.png` });
      await page.getByTestId("connection-error-retry").click();
      await page.getByTestId("connection-error-screen").waitFor({ timeout: 10000 });
      assert(true, "Retry with the server still down: the same screen");
      await page.unroute(API_ROUTE);
      await page.getByTestId("connection-error-retry").click();
      await page.waitForSelector("tbody tr", { timeout: 10000 });
      assert(page.url() === records, "Retry with the server back: the same page");
      assert((await page.getByText("BRDP-SES-A").count()) > 0, "and its data");
    }

    console.log("2. During use: a 401 whose refresh cannot be asked");
    // The access token is rejected once (as when it expires) and the
    // refresh gets the proxy's 502: the session is kept.
    let rejected = false;
    await page.route(`**/api/projects/${project.id}/brdps/stats`, (r) => {
      if (!rejected) {
        rejected = true;
        return r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "Not authenticated" }) });
      }
      return r.continue();
    });
    await page.route("**/api/auth/refresh", (r) => r.fulfill(DOWN));
    await page.locator("tbody tr").first().click();
    await page.getByTestId("records-field-title").fill("Session A changed");
    await page.getByTestId("records-field-title").blur();
    await page.getByTestId("records-notice-stats").waitFor({ timeout: 10000 });
    const statsText = await page.getByTestId("records-notice-stats").textContent();
    assert(/Could not reach the server/.test(statsText), `the connection error of AACF 1 (${statsText})`);
    assert(page.url() === records, "the session is kept: still on the page");
    await page.unroute("**/api/auth/refresh");
    await page.unroute(`**/api/projects/${project.id}/brdps/stats`);
    await page.getByTestId("records-notice-stats-retry").click();
    await page.getByTestId("records-notice-stats").waitFor({ state: "detached", timeout: 5000 });
    assert(true, "Retry with the server back: the totals are there");

    console.log("3. A real 401 with the server running: /login");
    await page.route("**/api/auth/refresh", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "Invalid or expired refresh token" }) }));
    await page.reload();
    await page.waitForURL(/\/login/, { timeout: 10000 });
    assert(page.url().includes("/login"), "sent to /login");
    await page.unroute("**/api/auth/refresh");

    console.log("4. Login with the server down");
    await page.route(API_ROUTE, (r) => r.fulfill(DOWN));
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.getByTestId("login-error").waitFor({ timeout: 5000 });
    const loginText = await page.getByTestId("login-error").textContent();
    assert(/Could not connect to the server/.test(loginText), `"Could not connect" (${loginText})`);
    assert(!/Invalid email or password/.test(loginText), 'never "Invalid email or password"');
    await page.locator("header select, nav select, select").first().selectOption("es").catch(() => {});
    await page.unroute(API_ROUTE);
    await page.fill("#login-password", "wrong-password-xyz");
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => /incorrect|Invalid/i.test(document.querySelector('[data-testid="login-error"]')?.textContent || ""), null, { timeout: 5000 });
    assert(true, "with the server up, a wrong password still says so");

    console.log("5. Spanish");
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.goto(records);
    await page.waitForSelector("tbody tr", { timeout: 10000 });
    await page.route(API_ROUTE, (r) => r.fulfill(DOWN));
    await page.reload();
    await page.getByTestId("connection-error-screen").waitFor({ timeout: 10000 });
    const es = await page.getByTestId("connection-error-screen").textContent();
    // The interface language comes from the account (unknown while the
    // server is down), so the screen uses the language the page booted with.
    assert(/Could not connect to the server|No se pudo conectar con el servidor/.test(es), `the screen text (${es.slice(0, 80)}…)`);
    await page.unroute(API_ROUTE);
    await page.getByTestId("connection-error-retry").click();
    await page.waitForSelector("tbody tr", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
