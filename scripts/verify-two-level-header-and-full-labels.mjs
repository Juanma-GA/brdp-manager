// Verification for the "two-level header in BRDP Projects + full labels
// in BRDP Records" round. Real browser, real backend, real Postgres data
// -- reuses the 10 projects spanning 2 to 2819 BRDPs seeded by
// backend/scripts/seed_alignment_check_projects.py from the previous
// alignment round (that script is idempotent -- rerun it first if the
// projects aren't already there).
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const ALIGN_TOLERANCE_PX = 0.5;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

function assertAllClose(values, label) {
  const first = values[0];
  for (const v of values) {
    assert(
      Math.abs(v - first) <= ALIGN_TOLERANCE_PX,
      `${label}: all x-positions within ${ALIGN_TOLERANCE_PX}px (got ${values.map((n) => n.toFixed(1)).join(", ")})`
    );
  }
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(400);

    // ---- Part 1: BRDP Projects two-level header ----
    await page.waitForTimeout(300);

    // Two real header rows, second row has the 6 single-letter leaf
    // sub-headers in the right order.
    const headRows = page.locator("thead tr");
    assert((await headRows.count()) === 2, "BRDP Projects <thead> has exactly 2 rows (group header + leaf sub-header)");
    const leafHeaders = await headRows.nth(1).locator("th").allInnerTexts();
    console.log("Leaf sub-header row:", leafHeaders);
    assert(JSON.stringify(leafHeaders) === JSON.stringify(["V", "P", "R", "V", "D", "T"]), `Leaf sub-headers read V/P/R/V/D/T in that order (got ${leafHeaders})`);

    const groupHeaders = await headRows.nth(0).locator("th").allInnerTexts();
    console.log("Group header row:", groupHeaders);
    assert(groupHeaders.some((h) => /Proposal Status/i.test(h)), "Group header row includes 'Proposal Status'");
    assert(groupHeaders.some((h) => /Rule Status/i.test(h)), "Group header row includes 'Rule Status'");

    // colSpan/rowSpan sanity: the group cells really span 3 columns, and
    // Name/Standard/Actions really span both header rows.
    const proposalHeaderColSpan = await headRows.nth(0).locator("th", { hasText: "Proposal Status" }).getAttribute("colspan");
    const ruleHeaderColSpan = await headRows.nth(0).locator("th", { hasText: "Rule Status" }).getAttribute("colspan");
    assert(proposalHeaderColSpan === "3", `Proposal Status header has colspan=3 (got ${proposalHeaderColSpan})`);
    assert(ruleHeaderColSpan === "3", `Rule Status header has colspan=3 (got ${ruleHeaderColSpan})`);
    const nameHeaderRowSpan = await headRows.nth(0).locator("th", { hasText: "Project name" }).getAttribute("rowspan");
    assert(nameHeaderRowSpan === "2", `Project name header has rowspan=2 (got ${nameHeaderRowSpan})`);

    // Data rows show ONLY numbers, no letter -- confirmed by checking the
    // real cell text of a known row is exactly the number, nothing else.
    const sopteRow = page.locator("tr", { hasText: "Alignment Check - SOPTE-scale" });
    const sopteCells = await sopteRow.locator("td").allInnerTexts();
    console.log("SOPTE row cells:", sopteCells);
    // cells: [name, standard, V, P, R, V, D, T, actions...]
    assert(sopteCells[2] === "2818", `SOPTE row's first Proposal Status cell is the bare number "2818" (got "${sopteCells[2]}")`);
    assert(sopteCells[3] === "0", `SOPTE row's Pending cell is bare "0" (got "${sopteCells[3]}")`);
    assert(sopteCells[4] === "1", `SOPTE row's Refused cell is bare "1" (got "${sopteCells[4]}")`);
    assert(sopteCells[5] === "1500", `SOPTE row's Verified cell is bare "1500" (got "${sopteCells[5]}")`);
    assert(!/[VPRDT]/.test(sopteCells[2] + sopteCells[3] + sopteCells[4]), "No letter labels leak into the numbers-only data cells");

    // Cross-row alignment: real column x-position of each of the 6
    // numeric columns must be identical across all 11 rows (10 synthetic +
    // Demo Project), same proof style as the previous alignment round but
    // now via real <td> boundingBox() per column instead of a shared span.
    const rows = await page.locator("tbody tr").all();
    assert(rows.length >= 10, `at least 10 real project rows present (found ${rows.length})`);
    const colX = [[], [], [], [], [], []];
    for (const row of rows) {
      for (let col = 0; col < 6; col++) {
        const box = await row.locator("td").nth(2 + col).boundingBox();
        colX[col].push(box.x);
      }
    }
    const colNames = ["Validated", "Pending", "Refused", "Verified", "Draft", "To Do"];
    colX.forEach((xs, i) => assertAllClose(xs, `${colNames[i]} column`));

    await page.screenshot({ path: "/tmp/projects-two-level-header.png", fullPage: true });

    // ---- Part 2: BRDP Records full-label summary ----
    const row = page.locator("tr", { hasText: "Alignment Check - Boeing-scale" });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.waitForFunction(() => /Validated:\s*900/.test(document.body.innerText), { timeout: 10000 });

    const headerText = await page.locator("h1", { hasText: /Records/i }).locator("xpath=../..").innerText();
    console.log("Records header (EN):\n" + headerText);
    assert(headerText.includes("Validated: 900"), "Records header shows full label 'Validated: 900'");
    assert(headerText.includes("Pending: 50"), "Records header shows full label 'Pending: 50'");
    assert(headerText.includes("Refused: 13"), "Records header shows full label 'Refused: 13'");
    assert(headerText.includes("Verified: 463"), "Records header shows full label 'Verified: 463'");
    assert(headerText.includes("Draft: 200"), "Records header shows full label 'Draft: 200'");
    assert(headerText.includes("To Do: 300"), "Records header shows full label 'To Do: 300'");
    assert(!/\bV\s*900\b/.test(headerText), "Old compact 'V 900' format is gone");

    await page.screenshot({ path: "/tmp/records-full-labels-en.png", fullPage: true });

    // No horizontal overflow of the header row (layout didn't break).
    const headerBox = await page.locator("h1", { hasText: /Records/i }).locator("xpath=../..").boundingBox();
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log(`Header box width=${headerBox.width.toFixed(1)}, page scrollWidth=${pageWidth}, viewport=1440`);
    assert(pageWidth <= 1445, `Page does not horizontally overflow its 1440px viewport (scrollWidth=${pageWidth})`);

    // ---- Spanish: longer labels must not overflow/break ----
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(500);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.waitForFunction(() => /Validado:\s*900|Validada:\s*900/.test(document.body.innerText), { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);

    const headerTextEs = await page.locator("h1", { hasText: /Registros/i }).locator("xpath=../..").innerText();
    console.log("Records header (ES):\n" + headerTextEs);
    const pageWidthEs = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log(`ES page scrollWidth=${pageWidthEs}`);
    assert(pageWidthEs <= 1445, `ES: page does not horizontally overflow its 1440px viewport (scrollWidth=${pageWidthEs})`);

    // Confirm the header box didn't get clipped/collapsed to near-zero
    // (a real sign of broken layout) and that the h1 "Records" title is
    // still fully visible (not pushed offscreen by the longer summary).
    const titleEs = page.locator("h1", { hasText: /Registros/i });
    const titleBoxEs = await titleEs.boundingBox();
    assert(titleBoxEs.x >= 0 && titleBoxEs.x < 200, `ES: 'Registros BRDP' title stays near the left edge, not pushed off-layout (x=${titleBoxEs.x.toFixed(1)})`);

    await page.screenshot({ path: "/tmp/records-full-labels-es.png", fullPage: true });

    // restore EN
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // ---- Cleanup ----
    const token = await apiLogin();
    const auth = { Authorization: `Bearer ${token}` };
    const projects = await fetch(`${API}/api/projects`, { headers: auth }).then((r) => r.json());
    let deleted = 0;
    for (const p of projects) {
      if (p.name.startsWith("Alignment Check - ")) {
        await fetch(`${API}/api/projects/${p.id}`, { method: "DELETE", headers: auth });
        deleted++;
      }
    }
    console.log(`Cleaned up ${deleted} Alignment Check projects.`);

    console.log("\nALL CHECKS PASSED");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
