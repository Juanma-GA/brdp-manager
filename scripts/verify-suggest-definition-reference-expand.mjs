// Verification for "Referencias de Suggest Definition legibles: título +
// definición desplegable" (docs request). Confirms, through the real
// running app + real Postgres (embeddings transport mocked, same
// convention as every other round in this branch):
//   1. Each reference row shows ID — Title (truncated to one line, full
//      text in `title=`) — origin[ — similarity].
//   2. Clicking the identifier expands that row's Definition below it;
//      clicking again collapses it. Several rows can be open at once.
//   3. Requesting a new suggestion resets all rows back to collapsed.
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

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Ref Expand Verify ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  const sourceBrdp = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-REFEXP-SOURCE",
      title: "Reference expand source",
      definition: "",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  const longTitle =
    "Numbering of procedural steps within a maintenance task that spans multiple pages and sub-procedures, including exceptions";
  const closeDefinition = "This is the full Definition text for the close reference candidate, shown when expanded.";
  const close1 = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-REFEXP-CLOSE-1",
      title: longTitle,
      definition: closeDefinition,
      proposal: "Proposal text.",
      validation: "Validated",
    }),
  }).then((r) => r.json());
  const close2Definition = "A second, different Definition text for the other close reference candidate.";
  const close2 = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-REFEXP-CLOSE-2",
      title: "Short title",
      definition: close2Definition,
      proposal: "Proposal text.",
      validation: "Validated",
    }),
  }).then((r) => r.json());
  console.log("Seeded Project (S1000D 4.2): 1 source BRDP + 2 Validated Records candidates (1 with a long title)");

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
    const row = page.locator("tr", { hasText: `Ref Expand Verify ${suffix}` });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tr", { hasText: "BRDP-REFEXP-SOURCE" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

    await resetMock();
    await page.getByRole("button", { name: "Suggest Definition" }).click();
    await page.waitForSelector("text=Similar", { timeout: 15000 });

    // ---- 1. Row shows ID + truncated title (full text in title=) + origin + score ----
    const closeRow = page.locator("li", { hasText: "BRDP-REFEXP-CLOSE-1" }).first();
    const titleSpan = closeRow.locator("span[title]").first();
    const titleAttr = await titleSpan.getAttribute("title");
    assert(titleAttr === longTitle, `full title present in title= attribute (got "${titleAttr}")`);
    const titleBox = await titleSpan.boundingBox();
    const rowBox = await closeRow.locator("div").first().boundingBox();
    console.log("title span box:", titleBox, "row box:", rowBox);
    assert(titleBox.height < 24, `title renders on a single line (height=${titleBox.height})`);
    const overflow = await titleSpan.evaluate((el) => getComputedStyle(el).textOverflow);
    assert(overflow === "ellipsis", `title has text-overflow:ellipsis (got ${overflow})`);
    const scrollWidthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(scrollWidthBefore <= 1442, "no horizontal page overflow from a long title");

    // ---- 2. Click identifier -> expands Definition; click again -> collapses ----
    assert((await closeRow.locator("text=" + closeDefinition).count()) === 0, "Definition NOT visible before clicking");
    const identifierButton1 = closeRow.getByRole("button", { name: "BRDP-REFEXP-CLOSE-1" });
    await identifierButton1.click();
    await page.waitForSelector(`text=${closeDefinition}`, { timeout: 3000 });
    assert(true, "Definition text appears after clicking the identifier");
    await closeRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/suggest-definition-reference-expanded.png", fullPage: true });
    console.log("Screenshot (one reference expanded): /tmp/suggest-definition-reference-expanded.png");

    // Open the second row too -- confirms several can be open at once.
    const close2Row = page.locator("li", { hasText: "BRDP-REFEXP-CLOSE-2" }).first();
    await close2Row.getByRole("button", { name: "BRDP-REFEXP-CLOSE-2" }).click();
    await page.waitForSelector(`text=${close2Definition}`, { timeout: 3000 });
    assert((await page.locator(`text=${closeDefinition}`).count()) > 0, "first row's Definition is STILL visible (both open at once)");

    await identifierButton1.click();
    await page.waitForTimeout(200);
    assert((await page.locator(`text=${closeDefinition}`).count()) === 0, "clicking again collapses that row's Definition");
    assert((await page.locator(`text=${close2Definition}`).count()) > 0, "the OTHER row stays open (independent state)");

    // ---- 3. Requesting a new suggestion resets everything to collapsed ----
    // Suggest is now blocked while a suggestion is pending for this BRDP
    // (docs request, "la sugerencia se queda en su BRDP hasta aceptarla o
    // descartarla" round) -- Discard the current one first, same as any
    // real user regenerating a suggestion would have to.
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(200);
    await resetMock();
    await page.getByRole("button", { name: "Suggest Definition" }).click();
    await page.waitForSelector("text=Similar", { timeout: 15000 });
    assert(
      (await page.locator(`text=${closeDefinition}`).count()) === 0 &&
        (await page.locator(`text=${close2Definition}`).count()) === 0,
      "a fresh suggestion starts with every reference row collapsed again"
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
