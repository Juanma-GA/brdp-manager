// Verification for the "alignment" fix round, Part 1: BRDP Records'
// Proposal/Rule Status filters live in a second <thead> row, in the same
// table as their columns, so each <select> lines up exactly with its
// column header (EN and ES -- the longer Spanish option text is the edge
// case), and the filters still work from there. Real browser, real
// backend, real Postgres data -- 10 projects spanning 2 to 2819 BRDPs
// (seeded by backend/scripts/seed_alignment_check_projects.py; rerun it
// first, this script deletes them at the end).
//
// Part 2 of that round (the compact "V 120 · P 45 · R 3" summary in BRDP
// Projects) no longer exists: the Projects table now has a two-level
// header with one number per column, and its alignment is checked by
// scripts/verify-two-level-header-and-full-labels.mjs.
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
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
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
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

    // ---- Part 1: BRDP Records filter alignment with its columns ----
    const row = page.locator("tr", { hasText: "Alignment Check - Boeing-scale" });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: shot("records-alignment-en.png"), fullPage: true });

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
    await page.screenshot({ path: shot("records-alignment-es.png"), fullPage: true });

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
        await fetch(`${API}/api/projects/${p.id}?permanent=true`, { method: "DELETE", headers: auth });
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
