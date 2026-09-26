// Verification for the "alignment" fix round: Part 1 (BRDP Records'
// Proposal/Rule Status filters now live in a second <thead> row, in the
// same table as their columns, instead of a separate flex row in
// .createForm whose width had to coincidentally match the table's) and
// Part 2 (StatusCountsSummary's numeric values get a fixed min-width
// right-aligned span, so P/R/D/T start at the same horizontal position
// regardless of digit count). Real browser, real backend, real Postgres
// data -- 10 projects spanning 2 to 2819 BRDPs (seeded by
// backend/scripts/seed_alignment_check_projects.py), including the exact
// extremes the encargo named (a SOPTE-sized, mostly-Validated project
// next to a 2-BRDP project).
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
// Sub-pixel differences are real (font hinting/subpixel positioning), not
// misalignment -- 0.5px is well below anything a human eye would notice
// and far below what "same column" needs to mean here.
const ALIGN_TOLERANCE_PX = 0.5;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

function assertAllClose(values, label) {
  const first = values[0];
  for (const v of values) {
    assert(Math.abs(v - first) <= ALIGN_TOLERANCE_PX, `${label}: all x-positions within ${ALIGN_TOLERANCE_PX}px of each other (got ${values.map((n) => n.toFixed(1)).join(", ")})`);
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
    // Force a known language state regardless of what an earlier session
    // left the admin account's preferred_language as (it's persisted
    // server-side, not per-browser -- see AppSettings/User.preferred_language).
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(400);

    // ---- Part 2: BRDP Projects summary column alignment ----
    await page.waitForTimeout(300);
    await page.screenshot({ path: "/tmp/projects-alignment-final.png", fullPage: true });

    const rows = await page.locator("tbody tr").all();
    assert(rows.length >= 10, `at least 10 real project rows present for the alignment check (found ${rows.length})`);

    const pX = [];
    const rX = [];
    const dX = [];
    const tX = [];
    for (const row of rows) {
      const proposalTd = row.locator("td").nth(2);
      const ruleTd = row.locator("td").nth(3);
      const pBox = await proposalTd.locator("span", { hasText: /^P/ }).first().boundingBox();
      const rBox = await proposalTd.locator("span", { hasText: /^R/ }).first().boundingBox();
      const dBox = await ruleTd.locator("span", { hasText: /^D/ }).first().boundingBox();
      const tBox = await ruleTd.locator("span", { hasText: /^T/ }).first().boundingBox();
      pX.push(pBox.x);
      rX.push(rBox.x);
      dX.push(dBox.x);
      tX.push(tBox.x);
    }
    assertAllClose(pX, "Proposal Status 'P' label");
    assertAllClose(rX, "Proposal Status 'R' label");
    assertAllClose(dX, "Rule Status 'D' label");
    assertAllClose(tX, "Rule Status 'T' label");

    // ---- Part 1: BRDP Records filter alignment with its columns ----
    const row = page.locator("tr", { hasText: "Alignment Check - Boeing-scale" });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: "/tmp/records-alignment-en.png", fullPage: true });

    const propHeaderBox = await page.locator("th", { hasText: "Proposal Status" }).boundingBox();
    const propSelectBox = await page.locator('select[aria-label="Filter by Proposal Status"]').boundingBox();
    assert(
      Math.abs(propHeaderBox.x - propSelectBox.x) <= ALIGN_TOLERANCE_PX &&
        Math.abs(propHeaderBox.width - propSelectBox.width) <= ALIGN_TOLERANCE_PX,
      `Proposal Status filter <select> matches its column header exactly (header x/w ${propHeaderBox.x.toFixed(1)}/${propHeaderBox.width.toFixed(1)}, select x/w ${propSelectBox.x.toFixed(1)}/${propSelectBox.width.toFixed(1)})`
    );

    const ruleHeaderBox = await page.locator("th", { hasText: "Rule Status" }).boundingBox();
    const ruleSelectBox = await page.locator('select[aria-label="Filter by Rule Status"]').boundingBox();
    assert(
      Math.abs(ruleHeaderBox.x - ruleSelectBox.x) <= ALIGN_TOLERANCE_PX &&
        Math.abs(ruleHeaderBox.width - ruleSelectBox.width) <= ALIGN_TOLERANCE_PX,
      `Rule Status filter <select> matches its column header exactly (header x/w ${ruleHeaderBox.x.toFixed(1)}/${ruleHeaderBox.width.toFixed(1)}, select x/w ${ruleSelectBox.x.toFixed(1)}/${ruleSelectBox.width.toFixed(1)})`
    );

    // Filters still functional after being moved into <thead> -- not just
    // visually relocated.
    await page.locator('select[aria-label="Filter by Rule Status"]').selectOption("verified");
    await page.waitForTimeout(800);
    const infoText = await page.locator("[class*='tableFooterInfo']").innerText();
    console.log("rule_status=verified pagination info:", infoText);
    assert(/463/.test(infoText), "Rule Status=Verified filter still works from its new <thead> location (Boeing-scale's real 463 verified BRDPs)");
    await page.locator('select[aria-label="Filter by Rule Status"]').selectOption("");
    await page.waitForTimeout(400);

    // ---- Same check in Spanish (longer option text is the edge case) ----
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(500);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: "/tmp/records-alignment-es.png", fullPage: true });

    const propHeaderEs = await page.locator("th", { hasText: "Estado de propuesta" }).boundingBox();
    const propSelectEs = await page.locator('select[aria-label="Filtrar por Estado de la propuesta"]').boundingBox();
    assert(
      Math.abs(propHeaderEs.x - propSelectEs.x) <= ALIGN_TOLERANCE_PX &&
        Math.abs(propHeaderEs.width - propSelectEs.width) <= ALIGN_TOLERANCE_PX,
      "ES: Proposal Status filter still matches its column exactly with longer Spanish option text"
    );
    const ruleHeaderEs = await page.locator("th", { hasText: "Estado de la regla" }).first().boundingBox();
    const ruleSelectEs = await page.locator('select[aria-label="Filtrar por Estado de la regla"]').boundingBox();
    assert(
      Math.abs(ruleHeaderEs.x - ruleSelectEs.x) <= ALIGN_TOLERANCE_PX &&
        Math.abs(ruleHeaderEs.width - ruleSelectEs.width) <= ALIGN_TOLERANCE_PX,
      "ES: Rule Status filter still matches its column exactly with longer Spanish option text"
    );

    // Restore EN so the account isn't left in Spanish for the next session/script.
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // ---- Cleanup: the 10 synthetic alignment-check projects are a
    // throwaway stand-in (this sandbox has no real SOPTE/Navantia/etc
    // projects) -- delete them so they don't linger in the real projects
    // list. Rerun seed_alignment_check_projects.py to bring them back.
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
