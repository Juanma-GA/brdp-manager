// Ad hoc Playwright end-to-end verification (real Chromium, real Vite dev
// server, real backend, real Postgres) of the "reimport with no real
// changes must not recompute embeddings" fix.
//
// Uses the real Navantia S80 file (nav_dtm_xpath2_import_v3.xlsx, 36 rows,
// ALL Proposal Status = Validated -- confirmed in an earlier round) as a
// real multi-Validated-row project. Imports it once via the real UI (N
// real embedding calls against the mock Mistral server), then reimports
// the EXACT same file a second time and confirms:
//   1. The mock server's call counter does NOT increase at all.
//   2. The Apply result shows all 36 rows as "unchanged", 0 "updated".
//   3. The real "Import complete" panel visibly shows the unchanged count.
//
// Usage: node scripts/verify-reimport-unchanged-skips-embeddings.mjs <path-to-xlsx>
import { chromium } from "playwright-core";
import path from "node:path";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK_MISTRAL = "http://localhost:8901";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function mockCallCount() {
  const resp = await fetch(`${MOCK_MISTRAL}/calls`);
  return (await resp.json()).count;
}

async function apiLogin() {
  const resp = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const { access_token } = await resp.json();
  return { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
}

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("Usage: node scripts/verify-reimport-unchanged-skips-embeddings.mjs <path-to-xlsx>");
    process.exit(1);
  }
  const absXlsxPath = path.resolve(xlsxPath);

  await fetch(`${MOCK_MISTRAL}/reset-calls`, { method: "POST" });
  assert((await mockCallCount()) === 0, "mock Mistral call counter reset to 0");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser console error]", msg.text());
  });

  let projectId;
  const auth = await apiLogin();

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });

    const suffix = Math.random().toString(36).slice(2, 8);
    const projectName = `Reimport Unchanged Test ${suffix}`;
    await page.click('button:has-text("Create project")');
    await page.waitForSelector("form select", { timeout: 10000 });
    await page.locator("form input").first().fill(projectName);
    await page.locator("form select").first().selectOption("DITA 1.3");
    await page.click('form button[type="submit"]');
    await page.waitForSelector(`text=${projectName}`, { timeout: 10000 });

    const row = page.locator("tr", { hasText: projectName });
    await row.getByRole("button", { name: "Project Configuration" }).click();
    await page.waitForURL(/\/projects\/.+\/config/, { timeout: 10000 });
    projectId = page.url().match(/\/projects\/([^/]+)\/config/)[1];
    console.log(`Project id: ${projectId}`);

    // ---- 1. First import: real embedding calls expected ----
    await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });
    await page.locator('input[type="file"]').setInputFiles(absXlsxPath);
    await page.waitForSelector('button:has-text("Apply import")', { timeout: 15000 });
    await page.click('button:has-text("Apply import")');
    const proceedBtn = page.locator('button:has-text("Proceed")');
    if (await proceedBtn.count()) await proceedBtn.click();
    await page.waitForSelector("text=Import complete", { timeout: 60000 });
    const firstResultText = await page
      .locator("ul")
      .filter({ hasText: /created|updated|rejected/i })
      .first()
      .innerText();
    console.log("First import result:", firstResultText.replace(/\n/g, " | "));
    assert(/36 BRDPs created/i.test(firstResultText), "first import created all 36 BRDPs");

    const callsAfterFirst = await mockCallCount();
    console.log("Mock Mistral calls after first import:", callsAfterFirst);
    assert(callsAfterFirst === 36, `first import triggered exactly 36 real embedding calls (got ${callsAfterFirst})`);

    await page.click('button:has-text("Close")');

    // ---- 2. Reimport the EXACT same file: must be a no-op ----
    await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });
    await page.locator('input[type="file"]').setInputFiles(absXlsxPath);
    await page.waitForSelector('button:has-text("Apply import")', { timeout: 15000 });

    const summaryText = await page.locator("p", { hasText: /ready to import/i }).first().innerText();
    console.log("Reimport analyze summary:", summaryText);
    assert(/36 rows unchanged/i.test(summaryText), `analyze phase's own summary already shows all 36 as unchanged (got "${summaryText}")`);

    await page.click('button:has-text("Apply import")');
    const proceedBtn2 = page.locator('button:has-text("Proceed")');
    if (await proceedBtn2.count()) await proceedBtn2.click();
    await page.waitForSelector("text=Import complete", { timeout: 60000 });
    // waitForSelector above can resolve while the PREVIOUS "Import
    // complete" panel (from the first import) is still on screen for one
    // more paint before React swaps in the new result -- confirmed real:
    // an unguarded screenshot here once caught the stale first-import
    // numbers even though the innerText() reads immediately below already
    // saw the correct, updated second-import content. Wait for the actual
    // updated text to be present before capturing, not just for the panel
    // heading to exist.
    await page.waitForSelector("text=/36 rows unchanged/i", { timeout: 10000 });
    await page.screenshot({ path: "/tmp/verify-reimport-unchanged-summary.png", fullPage: true });

    const secondResultText = await page
      .locator("ul")
      .filter({ hasText: /created|updated|unchanged|rejected/i })
      .first()
      .innerText();
    console.log("Reimport result:", secondResultText.replace(/\n/g, " | "));
    assert(/0 BRDPs created/i.test(secondResultText), "reimport created 0 new BRDPs");
    assert(/0 BRDPs updated/i.test(secondResultText), "reimport updated 0 BRDPs");
    assert(/36 rows unchanged/i.test(secondResultText), "reimport reports all 36 rows as unchanged");

    const callsAfterSecond = await mockCallCount();
    console.log("Mock Mistral calls after reimport:", callsAfterSecond);
    assert(
      callsAfterSecond === callsAfterFirst,
      `reimporting the exact same file triggered ZERO additional embedding calls (before=${callsAfterFirst}, after=${callsAfterSecond})`
    );

    console.log("\nAll reimport-unchanged checks passed.");
  } finally {
    if (projectId) {
      await fetch(`${API}/api/projects/${projectId}`, { method: "DELETE", headers: auth }).catch(() => {});
      console.log(`Cleaned up: deleted project ${projectId}.`);
    }
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
