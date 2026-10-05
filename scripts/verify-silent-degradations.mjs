// Live verification for AACF 1, Part 2 (no silent degradation): each load
// that fails is said, with Retry where it can work, and never shown as an
// empty or invented result. Against the real app (Vite + FastAPI +
// Postgres); each failure is provoked by intercepting the request in the
// browser (page.route).
//
//   - Records: the rule statuses (column without a status, "?"), the
//     header totals (hidden, said), the schema vocabulary (said, not "not
//     available"), the Add BRDP catalog.
//   - Delete project: a count that could not be loaded is never "0 BRDPs",
//     and deleting waits for the real count.
//   - Opening a project: "no access" (403/404) told apart from "could not
//     connect" (network, 5xx), with Retry for the second.
//
//     node scripts/verify-silent-degradations.mjs
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

const SERVER_ERROR = { status: 500, contentType: "application/json", body: JSON.stringify({ detail: { code: "internal_error", ref: "cafe0001" } }) };

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF1 degradations ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  for (const id of ["BRDP-DEG-A", "BRDP-DEG-B", "BRDP-DEG-C"]) {
    await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: id, title: id }) });
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const notice = (id) => page.getByTestId(id);
  const records = `${BASE_URL}/projects/${project.id}/records`;

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");

    // ---- Records: rule statuses, totals, vocabulary ----
    console.log("1. Records loads that fail");
    await page.route(`**/api/projects/${project.id}/approvals/BREX-4.2`, (r) => r.fulfill(SERVER_ERROR));
    await page.route(`**/api/projects/${project.id}/brdps/stats`, (r) => r.fulfill(SERVER_ERROR));
    await page.route("**/schema-vocabulary-4-2.json*", (r) => r.fulfill({ status: 503, body: "down" }));
    await page.goto(records);
    await page.waitForSelector("tbody tr", { timeout: 10000 });
    await notice("records-notice-approvals").waitFor({ timeout: 5000 });
    assert(/rule statuses could not be loaded/.test(await notice("records-notice-approvals").textContent()), "rule statuses: said, with Retry");
    assert((await page.getByTestId("rule-status-unknown").count()) === 3, "the column shows no status (never 'To Do')");
    assert((await page.locator('tbody [aria-current="step"]').count()) === 0, "no invented dots");
    await notice("records-notice-stats").waitFor({ timeout: 5000 });
    assert((await page.getByText(/Validated:\s*\d/).count()) === 0, "the totals are not shown as if they were current");
    await page.locator("tbody tr").first().click();
    await notice("records-notice-vocabulary").waitFor({ timeout: 5000 });
    const vocabText = await notice("records-notice-vocabulary").textContent();
    assert(/vocabulary could not be loaded/.test(vocabText) && /HTTP 503/.test(vocabText), `vocabulary: the load failed is said ("${vocabText}")`);
    assert((await page.getByText(/not available for S1000D 4.2/).count()) === 0, 'never "not available" for a load that failed');
    await page.screenshot({ path: `${SHOTS}/records-load-errors.png` });
    await page.unroute(`**/api/projects/${project.id}/approvals/BREX-4.2`);
    await page.unroute(`**/api/projects/${project.id}/brdps/stats`);
    await page.unroute("**/schema-vocabulary-4-2.json*");
    await notice("records-notice-approvals-retry").click();
    await notice("records-notice-approvals").waitFor({ state: "detached", timeout: 5000 });
    assert((await page.getByTestId("rule-status-unknown").count()) === 0, "Retry: the statuses are there");
    await notice("records-notice-stats-retry").click();
    await notice("records-notice-stats").waitFor({ state: "detached", timeout: 5000 });
    assert((await page.getByText(/Validated:\s*0/).count()) > 0, "Retry: the totals are there");
    await notice("records-notice-vocabulary-retry").click();
    await notice("records-notice-vocabulary").waitFor({ state: "detached", timeout: 5000 });
    assert(true, "Retry: the vocabulary loads");

    // ---- Add BRDP: the catalog ----
    console.log("2. Add BRDP catalog");
    await page.route("**/api/brdp-catalog?*", (r) => r.fulfill(SERVER_ERROR));
    await page.getByRole("button", { name: "Add BRDP" }).click();
    await notice("records-notice-catalog").waitFor({ timeout: 5000 });
    assert(/catalog could not be loaded/.test(await notice("records-notice-catalog").textContent()), "said, never an empty picker");
    await page.unroute("**/api/brdp-catalog?*");

    // ---- Delete project: the count ----
    console.log("3. Delete project");
    await page.goto(`${BASE_URL}/projects`);
    await page.waitForSelector("table");
    await page.route(`**/api/projects/${project.id}/brdps`, (r) => r.fulfill(SERVER_ERROR));
    await page.locator("tr", { hasText: project.name }).getByRole("button", { name: "Delete" }).click();
    await notice("delete-project-count-error").waitFor({ timeout: 5000 });
    assert((await page.getByText(/permanently delete 0 BRDP/).count()) === 0, 'never "0 BRDPs"');
    await page.getByPlaceholder("Project name").fill(project.name);
    const confirm = page.getByRole("button", { name: "Delete permanently" });
    assert(await confirm.isDisabled(), "cannot confirm until the count loads");
    await page.screenshot({ path: `${SHOTS}/delete-project-count-error.png` });
    await page.unroute(`**/api/projects/${project.id}/brdps`);
    await notice("delete-project-count-error-retry").click();
    await page.getByText(/permanently delete 3 BRDPs/).waitFor({ timeout: 5000 });
    assert(!(await confirm.isDisabled()), "with the real count, it can be confirmed");
    await page.getByRole("button", { name: "Cancel" }).click();

    // ---- Opening a project ----
    console.log("4. Opening a project");
    await page.route(`**/api/projects/${project.id}/config`, (r) => r.fulfill(SERVER_ERROR));
    await page.goto(records);
    await notice("project-load-error").waitFor({ timeout: 5000 });
    assert(/project could not be loaded/.test(await notice("project-load-error").textContent()), "could not connect: said, with Retry");
    await page.unroute(`**/api/projects/${project.id}/config`);
    await notice("project-load-error-retry").click();
    await page.waitForSelector("tbody tr", { timeout: 10000 });
    assert(true, "Retry opens the project");
    await page.goto(`${BASE_URL}/projects/00000000-0000-0000-0000-000000000000/records`);
    await page.getByTestId("project-denied").waitFor({ timeout: 5000 });
    assert(/do not have access/.test(await page.getByTestId("project-denied").textContent()), "no access / gone: said, with a link back");
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
