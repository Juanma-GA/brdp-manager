// Verification for "Suggest: limpiar al cambiar de BRDP" (docs request).
// Confirms, through the real running app + real Postgres (chat transport
// mocked via mock-mistral-chat-server.mjs, same convention as every other
// round in this branch):
//   1. Suggest -> switch row (response already received) -> the Suggest
//      area is empty for the new row.
//   2. Suggest -> switch row BEFORE the response arrives (delayed via
//      POST /slow-next) -> when it lands, it appears nowhere (neither on
//      the row just left, nor -- since it never got the chance to render
//      -- on the newly selected one).
//   3. Switch back to the ORIGINAL row -> the suggestion still doesn't
//      reappear (it was discarded, not just hidden).
//   4. Accept is never offered a stale suggestion to write: by the time
//      any of the above completes, the Accept button is gone along with
//      the suggestion box.
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK_CHAT = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  return (await res.json()).access_token;
}

async function resetMock() {
  await fetch(`${MOCK_CHAT}/reset`, { method: "POST" });
}

async function armSlowNext() {
  await fetch(`${MOCK_CHAT}/slow-next`, { method: "POST" });
}

async function computeAndWait(auth, projectId) {
  const resp = await fetch(`${API}/api/projects/${projectId}/embeddings/compute`, { method: "POST", headers: auth });
  if (resp.status !== 202) throw new Error(`POST /compute expected 202, got ${resp.status}`);
  const { job_id } = await resp.json();
  for (let i = 0; i < 60; i++) {
    const body = await fetch(`${API}/api/projects/${projectId}/embeddings/status/${job_id}`, { headers: auth }).then(
      (r) => r.json()
    );
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Embedding job ${job_id} never left 'running' status`);
}

// Whether the Suggest area currently shows anything (a suggestion box, an
// insufficient-precedent notice, or an error) -- NOT whether the Suggest
// BUTTONS are visible (those are always there). The Accept button is the
// most direct signal: it only renders when `suggestion?.text` is truthy,
// which is exactly the state that would let Accept write to the wrong
// BRDP if a stale result were ever allowed to land.
async function suggestionAreaIsEmpty(page) {
  const hasSuggestionBox =
    (await page.getByRole("button", { name: "Accept" }).count()) > 0 ||
    (await page.locator("text=insufficient").count()) > 0 ||
    (await page.locator("text=Error:").count()) > 0;
  return !hasSuggestionBox;
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Suggest Clear Verify ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  // Two BRDPs the user will switch between. Both Pending (never
  // Validated) -- neither is a valid Suggest candidate for ITSELF, but
  // both can request a suggestion (Definition has no MIN_CANDIDATES gate,
  // so it always returns something -- an empty-corpus notice at worst --
  // which is enough to exercise "did a suggestion box render or not").
  const brdpA = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ identifier: "BRDP-SWITCH-A", title: "Row A", definition: "", proposal: "", validation: "Pending" }),
  }).then((r) => r.json());
  const brdpB = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ identifier: "BRDP-SWITCH-B", title: "Row B", definition: "", proposal: "", validation: "Pending" }),
  }).then((r) => r.json());
  console.log("Seeded Project (S1000D 4.2): 2 Pending BRDPs (A, B) to switch between");

  const job = await computeAndWait(auth, proj.id);
  assert(job.status === "completed", `embedding job completed (status=${job.status}, error=${job.error})`);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    await page.goto(`${BASE_URL}/projects`);
    await page.waitForSelector("table", { timeout: 10000 });
    const row = page.locator("tr", { hasText: `Suggest Clear Verify ${suffix}` });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // ---- Case 1: suggest -> switch row (response already received) -> empty ----
    await page.locator("tr", { hasText: "BRDP-SWITCH-A" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await resetMock();
    await page.getByRole("button", { name: "Suggest Definition" }).click();
    await page.getByRole("button", { name: "Accept" }).waitFor({ timeout: 15000 });
    assert(!(await suggestionAreaIsEmpty(page)), "row A shows a suggestion (Accept button) after Suggest Definition");

    await page.locator("tr", { hasText: "BRDP-SWITCH-B" }).click();
    await page.waitForTimeout(300);
    assert(await suggestionAreaIsEmpty(page), "switching to row B (response already landed) shows an EMPTY Suggest area");

    // ---- Case 2/3: suggest -> switch away BEFORE the response arrives ----
    await page.locator("tr", { hasText: "BRDP-SWITCH-A" }).click();
    await page.waitForTimeout(300);
    assert(await suggestionAreaIsEmpty(page), "row A starts empty again (sanity check before the delayed-response case)");

    await resetMock();
    await armSlowNext(); // next chat call is delayed SLOW_RESPONSE_DELAY_MS (2500ms)
    await page.getByRole("button", { name: "Suggest Definition" }).click();
    // Don't wait for the response -- switch away almost immediately, well
    // before the mock's 2500ms delay elapses.
    await page.waitForTimeout(300);
    await page.locator("tr", { hasText: "BRDP-SWITCH-B" }).click();
    assert(await suggestionAreaIsEmpty(page), "row B shows nothing right after switching, while A's request is still in flight");

    // Wait past the mock's delay so the stale response has definitely
    // landed by now -- it must not have appeared anywhere.
    await page.waitForTimeout(3000);
    assert(
      await suggestionAreaIsEmpty(page),
      "row B STILL shows nothing after the stale (row A) response has landed -- it was discarded, not just delayed"
    );
    assert(
      (await page.getByRole("button", { name: "Accept" }).count()) === 0,
      "no Accept button is offered anywhere -- nothing to (wrongly) write to row B"
    );

    await page.locator("tr", { hasText: "BRDP-SWITCH-A" }).click();
    await page.waitForTimeout(300);
    assert(
      await suggestionAreaIsEmpty(page),
      "switching BACK to row A (the one the stale request was actually for) still shows nothing -- truly discarded, not cached"
    );

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded project.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
