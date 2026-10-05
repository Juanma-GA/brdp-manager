// Live verification for AACF 1, Part 1 (Records never loses a change; every
// failure is visible) against the real app (Vite + FastAPI + Postgres).
// A server failure is provoked by intercepting the request in the browser
// (page.route), the only way to make a real endpoint fail on demand here;
// the "text too long" case is the real server's 422.
//
// For each of: saving a field, Proposal Status, Verify, Revoke, deleting a
// BRDP -- (a) the message appears, (b) what was typed stays in the field /
// the optimistic change is undone, (c) the table shows the saved value,
// (d) Retry saves once the server answers again. Plus the edge cases: two
// fields at once, Retry failing again, a 422 (Retry disabled until the text
// changes), leaving a BRDP with an unsaved change, the browser's "leave the
// page?", a failed refresh after a save that worked, and an expired session
// (the typed text is still there after signing in again).
//
//     node scripts/verify-records-unsaved.mjs
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

const RULE = '<structureObjectRule id="BRDP-UNS-RULE"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>';
const SERVER_ERROR = { status: 500, contentType: "application/json", body: JSON.stringify({ detail: { code: "internal_error", ref: "deadbeef" } }) };

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF1 unsaved ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const make = (identifier, title, extra = {}) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier, title, definition: `${title} definition`, proposal: `${title} proposal`, ...extra }) }).then((r) => r.json());
  const A = await make("BRDP-UNS-A", "Alpha");
  const B = await make("BRDP-UNS-B", "Bravo");
  const C = await make("BRDP-UNS-C", "Charlie", { validation: "Validated" });
  const D = await make("BRDP-UNS-D", "Delta", { validation: "Validated" });
  const putRule = (brdp, status) =>
    api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: RULE, source: "manual", status }) });
  await putRule(C, "pending_review");
  await putRule(D, "approved");
  const stored = async (brdp) => (await api(`/api/projects/${project.id}/brdps`).then((r) => r.json())).find((b) => b.id === brdp.id);
  const approvalOf = async (brdp) => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`).then((r) => r.json());

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const dialogAnswers = [];
  page.on("dialog", async (dialog) => {
    const answer = dialogAnswers.shift();
    if (answer === false) await dialog.dismiss();
    else await dialog.accept();
  });

  const brdpUrl = (brdp) => `**/api/projects/${project.id}/brdps/${brdp.id}`;
  const failPut = (brdp, { delay = 0, response = SERVER_ERROR } = {}) =>
    page.route(brdpUrl(brdp), async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return route.fulfill(response);
    });
  const row = (identifier) => page.locator("tbody tr", { hasText: identifier });
  const titleCell = (identifier) => row(identifier).locator("td").nth(1);
  const select = async (identifier) => {
    await row(identifier).click();
    await page.waitForFunction((id) => document.body.innerText.includes(id), identifier);
  };
  const field = (name) => page.getByTestId(`records-field-${name}`);
  const notice = (testId) => page.getByTestId(testId);

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 10000 });

    // ---- 1. A field the server does not save ----
    console.log("1. Saving a field fails");
    await select("BRDP-UNS-A");
    await failPut(A);
    await field("title").fill("Alpha edited");
    await field("title").blur();
    await notice("records-unsaved-title").waitFor({ timeout: 5000 });
    const text1 = await notice("records-unsaved-title").textContent();
    assert(/Not saved/.test(text1) && text1.includes("ref. deadbeef"), `(a) the message, with the reference and no technical text: "${text1}"`);
    assert(!/internal_error|Internal Server Error|Traceback/.test(text1), "(a) no technical text in the message");
    assert((await field("title").inputValue()) === "Alpha edited", "(b) the typed text stays in the field");
    assert((await titleCell("BRDP-UNS-A").textContent()) === "Alpha", "(c) the table shows the saved value");
    assert((await field("title").getAttribute("aria-invalid")) === "true", "the field is marked");
    assert((await page.getByRole("alert").filter({ hasText: "Not saved" }).count()) === 1, 'role="alert"');
    assert((await stored(A)).title === "Alpha", "nothing was saved");
    await page.screenshot({ path: `${SHOTS}/records-unsaved-field.png` });
    await page.unroute(brdpUrl(A));
    await notice("records-unsaved-title-retry").click();
    await notice("records-unsaved-title").waitFor({ state: "detached", timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll("tbody tr td:nth-child(2)")].some((td) => td.textContent === "Alpha edited"));
    assert((await stored(A)).title === "Alpha edited", "(d) Retry saved it once the server answered again");
    assert((await titleCell("BRDP-UNS-A").textContent()) === "Alpha edited", "(d) the table shows the new saved value");

    // ---- 2. Two fields at once, Retry failing again ----
    console.log("2. Two fields fail at once; Retry fails again");
    await failPut(A);
    await field("title").fill("Alpha two");
    await field("title").blur();
    await field("definition").fill("Definition two");
    await field("definition").blur();
    await notice("records-unsaved-definition").waitFor({ timeout: 5000 });
    assert((await notice("records-unsaved-title").count()) === 1 && (await notice("records-unsaved-definition").count()) === 1, "each field has its own mark");
    await notice("records-unsaved-definition-retry").click();
    await page.waitForTimeout(500);
    assert((await notice("records-unsaved-definition").count()) === 1, "Retry failing again keeps one message (no pile-up)");
    await page.unroute(brdpUrl(A));
    await notice("records-unsaved-title-retry").click();
    await notice("records-unsaved-title").waitFor({ state: "detached", timeout: 5000 });
    assert((await notice("records-unsaved-definition").count()) === 1, "retrying one field leaves the other one marked");
    assert((await stored(A)).title === "Alpha two" && (await stored(A)).definition === "Alpha definition", "only the retried field was saved");
    await notice("records-unsaved-definition-discard").click();
    assert((await field("definition").inputValue()) === "Alpha definition", '"Discard change" puts the saved value back');

    // ---- 3. A text over the limit (the real server's 422) ----
    console.log("3. A text too long");
    await field("title").fill("x".repeat(2001));
    await field("title").blur();
    await notice("records-unsaved-title").waitFor({ timeout: 5000 });
    const text3 = await notice("records-unsaved-title").textContent();
    assert(/too long/.test(text3) && text3.includes("2000") && text3.includes("2001"), `the reason names the limit: "${text3}"`);
    assert(await notice("records-unsaved-title-retry").isDisabled(), "Retry cannot work until the text is shortened");
    await field("title").fill("Alpha three");
    await field("title").blur();
    await notice("records-unsaved-title").waitFor({ state: "detached", timeout: 5000 });
    assert((await stored(A)).title === "Alpha three", "shortened, it is saved");

    // ---- 4. Leaving a BRDP with a change that did not save ----
    console.log("4. Leaving a BRDP with an unsaved change");
    await failPut(A);
    await field("proposal").fill("Proposal not saved");
    await field("proposal").blur();
    await notice("records-unsaved-proposal").waitFor({ timeout: 5000 });
    const leaving = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    assert(leaving, "closing or reloading the tab gets the browser's 'leave the page?'");
    dialogAnswers.push(false);
    await row("BRDP-UNS-B").click();
    await page.waitForTimeout(300);
    assert((await field("proposal").inputValue()) === "Proposal not saved", "declining the confirmation stays on the BRDP, text intact");
    dialogAnswers.push(true);
    await row("BRDP-UNS-B").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="records-field-title"]')?.value === "Bravo");
    assert(true, "confirming leaves for the other BRDP");
    await page.unroute(brdpUrl(A));

    // ---- 5. Proposal Status, optimistic ----
    console.log("5. Proposal Status");
    await failPut(B, { delay: 800 });
    await field("validation").selectOption("Validated");
    await page.waitForTimeout(150);
    assert(/Validated/.test(await row("BRDP-UNS-B").locator("td").nth(2).textContent()), "the new status shows at once (table)");
    await notice("records-notice-status").waitFor({ timeout: 5000 });
    assert(/Pending/.test(await row("BRDP-UNS-B").locator("td").nth(2).textContent()), "(c) refused: the table shows the saved status again");
    assert((await field("validation").inputValue()) === "Pending", "(b) the control is back to the previous value");
    const text5 = await notice("records-notice-status").textContent();
    assert(text5.includes("Validated") && text5.includes("ref. deadbeef"), `(a) the message: "${text5}"`);
    await page.unroute(brdpUrl(B));
    await notice("records-notice-status-retry").click();
    await notice("records-notice-status").waitFor({ state: "detached", timeout: 5000 });
    assert((await stored(B)).validation === "Validated", "(d) Retry saved it");

    // ---- 6. Verify, optimistic ----
    console.log("6. Verify");
    await select("BRDP-UNS-C");
    const approveUrl = `**/api/projects/${project.id}/brdps/${C.id}/approvals/BREX-4.2/approve`;
    await page.route(approveUrl, async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      return route.fulfill(SERVER_ERROR);
    });
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    const dialog = page.getByTestId("verify-warning-dialog");
    if (await dialog.isVisible().catch(() => false)) await dialog.getByRole("button", { name: "Verify anyway" }).click();
    await page.waitForTimeout(150);
    const current = () => page.locator('[aria-current="step"]').last().getAttribute("aria-label");
    assert((await current()) === "Verified", "Verified shows at once");
    await notice("records-notice-rule").waitFor({ timeout: 5000 });
    assert((await current()) === "Draft", "(b) refused: back to Draft");
    assert(/not verified/.test(await notice("records-notice-rule").textContent()), "(a) the message");
    assert((await approvalOf(C)).status === "pending_review", "(c) nothing changed on the server");
    await page.unroute(approveUrl);
    await notice("records-notice-rule-retry").click();
    await notice("records-notice-rule").waitFor({ state: "detached", timeout: 5000 });
    assert((await approvalOf(C)).status === "approved", "(d) Retry verified it");

    // ---- 7. Revoke, optimistic ----
    console.log("7. Revoke");
    await select("BRDP-UNS-D");
    const revokeUrl = `**/api/projects/${project.id}/brdps/${D.id}/approvals/BREX-4.2/revoke`;
    await page.route(revokeUrl, async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      return route.fulfill(SERVER_ERROR);
    });
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.waitForTimeout(150);
    assert((await current()) === "Draft", "Draft shows at once");
    await notice("records-notice-rule").waitFor({ timeout: 5000 });
    assert((await current()) === "Verified", "(b) refused: the previous state comes back");
    assert(/not revoked/.test(await notice("records-notice-rule").textContent()), "(a) the message");
    await page.unroute(revokeUrl);
    await notice("records-notice-rule-retry").click();
    await notice("records-notice-rule").waitFor({ state: "detached", timeout: 5000 });
    assert((await approvalOf(D)).status === "pending_review", "(d) Retry revoked it");

    // ---- 8. Deleting a BRDP, optimistic ----
    console.log("8. Delete");
    await select("BRDP-UNS-B");
    const order = async () => (await page.locator("tbody tr td:first-child").allTextContents()).map((t) => t.replace(/[^A-Z0-9-]/g, ""));
    const before = await order();
    await page.route(brdpUrl(B), async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await new Promise((r) => setTimeout(r, 800));
      return route.fulfill(SERVER_ERROR);
    });
    dialogAnswers.push(true);
    await row("BRDP-UNS-B").getByRole("button").click();
    await page.waitForTimeout(150);
    assert(!(await order()).includes("BRDP-UNS-B"), "the row goes at once");
    await notice("records-notice-delete").waitFor({ timeout: 5000 });
    assert(JSON.stringify(await order()) === JSON.stringify(before), "(b) refused: the row is back in its place and order");
    assert((await field("title").inputValue()) === "Bravo", "(b) selected as it was");
    assert(/BRDP-UNS-B was not deleted/.test(await notice("records-notice-delete").textContent()), "(a) the message");
    await page.unroute(brdpUrl(B));
    await notice("records-notice-delete-retry").click();
    await notice("records-notice-delete").waitFor({ state: "detached", timeout: 5000 });
    assert(!(await order()).includes("BRDP-UNS-B"), "(d) Retry deleted it");
    assert((await api(`/api/projects/${project.id}/brdps`).then((r) => r.json())).every((b) => b.id !== B.id), "(d) deleted on the server");

    // ---- 9. The save works, the refresh after it fails ----
    console.log("9. Saved, refresh failed");
    await select("BRDP-UNS-A");
    const listUrl = `**/api/projects/${project.id}/brdps`;
    await page.route(listUrl, (route) => (route.request().method() === "GET" ? route.fulfill(SERVER_ERROR) : route.continue()));
    await field("title").fill("Alpha four");
    await field("title").blur();
    await notice("records-notice-refresh").waitFor({ timeout: 5000 });
    assert((await notice("records-unsaved-title").count()) === 0, "the field is saved (no 'Not saved')");
    assert((await stored(A)).title === "Alpha four", "really saved");
    assert(/BRDP list could not be loaded/.test(await notice("records-notice-refresh").textContent()), "the failed refresh is shown apart");
    await page.unroute(listUrl);
    await notice("records-notice-refresh-retry").click();
    await notice("records-notice-refresh").waitFor({ state: "detached", timeout: 5000 });

    // ---- 10. Spanish ----
    console.log("10. Spanish");
    await page.locator("header select, nav select").first().selectOption("es");
    await failPut(A);
    await field("title").fill("Alfa no guardado");
    await field("title").blur();
    await notice("records-unsaved-title").waitFor({ timeout: 5000 });
    const text10 = await notice("records-unsaved-title").textContent();
    assert(/No guardado/.test(text10) && /Error en el servidor/.test(text10) && /Reintentar/.test(text10) && /Descartar cambio/.test(text10), `ES: "${text10}"`);
    await page.screenshot({ path: `${SHOTS}/records-unsaved-field-es.png` });
    await notice("records-unsaved-title-discard").click();
    await page.unroute(brdpUrl(A));
    await page.locator("header select, nav select").first().selectOption("en");

    // ---- 11. The session expires during the save ----
    console.log("11. Session expired");
    await page.route(brdpUrl(A), (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Not authenticated"}' }) : route.continue()
    );
    await page.route("**/api/auth/refresh", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"expired"}' }));
    await field("title").fill("Alpha typed before the session expired");
    await field("title").blur();
    await page.waitForSelector("#login-email", { timeout: 10000 });
    assert(true, "the session ended: back to the login page");
    await page.unroute(brdpUrl(A));
    await page.unroute("**/api/auth/refresh");
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="records-field-title"]')?.value === "Alpha typed before the session expired", null, { timeout: 10000 });
    assert(true, "after signing in again, the typed text is still in the field");
    assert((await notice("records-unsaved-title").count()) === 1, "marked unsaved, with Retry");
    await notice("records-unsaved-title-retry").click();
    await notice("records-unsaved-title").waitFor({ state: "detached", timeout: 5000 });
    await page.waitForTimeout(500);
    const saved11 = (await stored(A)).title;
    assert(saved11 === "Alpha typed before the session expired", `Retry saved it (${saved11})`);

    // ---- 12. Trash: restore, optimistic ----
    console.log("12. Trash restore");
    await api(`/api/projects/${project.id}/brdps/${C.id}`, { method: "DELETE" });
    await page.goto(`${BASE_URL}/settings`);
    await page.getByText("Trash", { exact: true }).click();
    const trashRow = page.locator("tr", { hasText: "BRDP-UNS-C" });
    await trashRow.waitFor({ timeout: 10000 });
    const restoreUrl = `**/api/trash/${C.id}/restore`;
    await page.route(restoreUrl, async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      return route.fulfill(SERVER_ERROR);
    });
    await trashRow.getByRole("button", { name: "Restore" }).click();
    await page.waitForTimeout(150);
    assert((await trashRow.count()) === 0, "the row leaves the trash at once");
    await page.getByTestId("trash-error").waitFor({ timeout: 5000 });
    await trashRow.waitFor({ timeout: 5000 });
    assert(/BRDP-UNS-C was not restored/.test(await page.getByTestId("trash-error").textContent()), "refused: the row comes back, with the reason");
    await page.unroute(restoreUrl);
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
