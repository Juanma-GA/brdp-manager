// Verification for the "Status counts + Rule/Proposal Status filter" round:
// Part 1 (BRDP Projects columns), Part 2 (BRDP Records header summary),
// Part 3 (BRDP Records Proposal/Rule Status filters). Real browser, real
// backend, real Postgres data -- the SOPTE Scale Verification project
// (2819 synthetic-but-realistic BRDPs, seeded by
// backend/scripts/seed_sopte_scale_verification.py, with a known exact
// ground-truth distribution) stands in for the literal SOPTE/Lufthansa
// projects this sandbox doesn't have; Demo Project (S1000D 4.2) with a
// handful of real BRDPs covers the combined-filter/search interaction and
// screenshots. Run the seed script first (or after any DB reset) before
// running this: `cd backend && python scripts/seed_sopte_scale_verification.py`.
// This script deletes the SOPTE project again at the end so it doesn't
// linger in the projects list -- rerun the seed script to bring it back.
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function login(page) {
  await page.goto(BASE_URL);
  await page.fill("#login-email", ADMIN_EMAIL);
  await page.fill("#login-password", ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });
}

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const data = await res.json();
  return data.access_token;
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await login(page);

    // ---- Part 1: BRDP Projects table columns ----
    await page.waitForSelector("table", { timeout: 10000 });
    await page.screenshot({ path: "/tmp/verify-projects-page.png", fullPage: true });

    const sopteRow = page.locator("tr", { hasText: "SOPTE Scale Verification" });
    await sopteRow.waitFor({ timeout: 10000 });
    const rowText = await sopteRow.innerText();
    console.log("SOPTE row text:\n" + rowText);
    assert(rowText.includes("1400") && rowText.includes("1200") && rowText.includes("219"), "Projects row shows Proposal Status counts (1400/1200/219)");
    assert(rowText.includes("1500") && rowText.includes("600") && rowText.includes("719"), "Projects row shows Rule Status counts (1500/600/719)");

    const demoRow = page.locator("tr", { hasText: "Demo Project" });
    const demoRowText = await demoRow.innerText();
    console.log("Demo row text:\n" + demoRowText);

    // Confirm real query count for GET /api/projects stays fixed regardless
    // of project count -- browser-side proof to complement the backend
    // pytest QueryCounter proof already run. We can't instrument Postgres
    // from here, so instead confirm wall-clock time doesn't blow up with
    // the 2819-row project in the mix (a real N+1 over BRDPs would be slow).
    const t0 = Date.now();
    await page.reload();
    await page.waitForSelector("table", { timeout: 10000 });
    const t1 = Date.now();
    console.log(`Projects page reload (includes SOPTE's 2819-row project): ${t1 - t0}ms`);
    assert(t1 - t0 < 3000, "Projects page loads in well under 3s even with a 2819-BRDP project in the list");

    // ---- Part 2: BRDP Records header summary ----
    await sopteRow.getByRole("button", { name: /Records|Registros/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("table", { timeout: 15000 });
    // Header summary comes from a separate GET .../stats fetch, independent
    // of the table's own load -- wait for the real figure to actually land
    // instead of a fixed short timeout (avoids a flaky race in this test).
    await page.waitForFunction(
      () => /V\s*1400/.test(document.body.innerText),
      { timeout: 10000 }
    );
    const headerText = await page.locator("h1", { hasText: /Records|Registros/i }).locator("xpath=../..").innerText();
    console.log("Records header text:\n" + headerText);
    assert(headerText.includes("1400") && headerText.includes("1500"), "Records header shows real Proposal/Rule Status summary figures");
    await page.screenshot({ path: "/tmp/verify-records-page-sopte.png", fullPage: true });

    // ---- Part 3: filters on SOPTE (exact ground truth) ----
    // Scoped by aria-label, not select-index -- the app shell's
    // LanguageSwitcher also renders a <select> earlier in the DOM.
    const proposalSelect = page.locator('select[aria-label="Filter by Proposal Status"]');
    const ruleSelect = page.locator('select[aria-label="Filter by Rule Status"]');

    // rule_status = verified alone -> exactly 1500
    await ruleSelect.selectOption("verified");
    await page.waitForTimeout(1000);
    let infoText = await page.locator("text=/of \\d+ results|de \\d+ resultados/i").first().innerText().catch(() => null);
    if (!infoText) infoText = await page.locator("[class*='tableFooterInfo']").innerText();
    console.log("rule_status=verified pagination info:", infoText);
    assert(/1500/.test(infoText), "Filtering Rule Status=Verified on SOPTE returns exactly 1500 (the real ground truth)");

    // reset, then proposal_status = Refused alone -> exactly 219
    await ruleSelect.selectOption("");
    await proposalSelect.selectOption("Refused");
    await page.waitForTimeout(1000);
    infoText = await page.locator("[class*='tableFooterInfo']").innerText();
    console.log("proposal_status=Refused pagination info:", infoText);
    assert(/219/.test(infoText), "Filtering Proposal Status=Refused on SOPTE returns exactly 219");

    // combine: proposal_status=Validated + rule_status=draft -> exactly 600 (AND)
    await proposalSelect.selectOption("Validated");
    await ruleSelect.selectOption("draft");
    await page.waitForTimeout(1000);
    infoText = await page.locator("[class*='tableFooterInfo']").innerText();
    console.log("Validated + draft combined pagination info:", infoText);
    assert(/600/.test(infoText), "Combining Proposal Status=Validated AND Rule Status=Draft returns exactly 600, not either individual count");

    // reset filters
    await proposalSelect.selectOption("");
    await ruleSelect.selectOption("");
    await page.waitForTimeout(1000);
    infoText = await page.locator("[class*='tableFooterInfo']").innerText();
    console.log("unfiltered pagination info:", infoText);
    assert(/2819/.test(infoText), "Clearing both filters (All/All) returns the full 2819 again");

    // ---- combined with text search too, on Demo Project (real small data) ----
    await page.goto(`${BASE_URL}/projects`);
    await page.waitForSelector("table", { timeout: 10000 });
    const demoRow2 = page.locator("tr", { hasText: "Demo Project" });
    await demoRow2.getByRole("button", { name: /Records|Registros/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("table", { timeout: 15000 });
    const demoProjectId = page.url().match(/\/projects\/([^/]+)\/records/)[1];

    // Seed a couple of small real BRDPs on Demo Project via the real API so
    // there's something concrete to filter+search together, then clean up.
    const token = await apiLogin();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const seeded = [];
    for (const [suffix, title, validation] of [
      ["AAA01", "Alpha Widget Rule", "Validated"],
      ["AAA02", "Alpha Widget Extra", "Pending"],
      ["BBB01", "Beta Gadget Rule", "Validated"],
    ]) {
      const created = await fetch(`${API}/api/projects/${demoProjectId}/brdps`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          identifier: `BRDP-FILTERTEST-${suffix}`,
          title,
          definition: "d",
          proposal: "p",
          validation,
        }),
      }).then((r) => r.json());
      seeded.push(created.id);
    }

    await page.reload();
    await page.waitForSelector("table", { timeout: 15000 });
    const searchInput = page.locator('input[placeholder]').first();
    await searchInput.fill("Alpha");
    const proposalSelect2 = page.locator('select[aria-label="Filter by Proposal Status"]');
    await proposalSelect2.selectOption("Validated");
    await page.waitForTimeout(1000);
    const visibleRows = await page.locator("tbody tr").allInnerTexts();
    console.log("search=Alpha + proposal_status=Validated rows:", visibleRows);
    assert(
      visibleRows.some((r) => r.includes("Alpha Widget Rule")) &&
        !visibleRows.some((r) => r.includes("Alpha Widget Extra")) &&
        !visibleRows.some((r) => r.includes("Beta Gadget Rule")),
      "Text search 'Alpha' AND Proposal Status=Validated combine correctly: only 'Alpha Widget Rule' shows, not the Pending Alpha row or the non-matching Beta row"
    );

    // cleanup seeded BRDPs
    for (const id of seeded) {
      await fetch(`${API}/api/projects/${demoProjectId}/brdps/${id}`, { method: "DELETE", headers: auth });
      await fetch(`${API}/api/trash/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }

    // SOPTE Scale Verification is a throwaway stand-in (see header comment)
    // -- delete it so it doesn't linger in the real projects list; rerun
    // seed_sopte_scale_verification.py to bring it back for a future round.
    const projectsAfter = await fetch(`${API}/api/projects`, { headers: auth }).then((r) => r.json());
    const sopte = projectsAfter.find((p) => p.name === "SOPTE Scale Verification");
    if (sopte) {
      await fetch(`${API}/api/projects/${sopte.id}`, { method: "DELETE", headers: auth });
      console.log("Cleaned up SOPTE Scale Verification project.");
    }

    console.log("\nALL CHECKS PASSED");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
