// Verification for the CSS specificity bug fix: .table th's own
// text-align:left (specificity 0,1,1 -- one class + one element) was
// silently beating .groupHeader/.subHeader alone (0,1,0 -- one class, no
// element), so the previous round's "centering" never actually applied
// even though the code read correctly and a prior verification script
// wrongly passed (it measured the <th> cell's own boundingBox(), which
// trivially matches its colSpan regardless of text-align -- it never
// checked where the TEXT itself renders). This script checks the ACTUAL
// computed style and the ACTUAL glyph-level text position, not the cell
// box, so it can't be fooled the same way again.
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

    const headRows = page.locator("thead tr");

    // ---- Step 1: the actual computed CSS, not the source CSS ----
    // This is the real proof: what the browser's cascade actually
    // resolved to for this element, after every rule (including .table
    // th) has been applied and specificity/order have been settled.
    const proposalGroupTh = headRows.nth(0).locator("th", { hasText: "Proposal Status" });
    const proposalComputedAlign = await proposalGroupTh.evaluate((el) => getComputedStyle(el).textAlign);
    console.log("Proposal Status <th> computed text-align:", proposalComputedAlign);
    assert(proposalComputedAlign === "center", `'Proposal Status' <th>'s ACTUAL computed text-align is "center" (got "${proposalComputedAlign}") -- this is the cascade-resolved value, not the source CSS`);

    const ruleGroupTh = headRows.nth(0).locator("th", { hasText: "Rule Status" });
    const ruleComputedAlign = await ruleGroupTh.evaluate((el) => getComputedStyle(el).textAlign);
    assert(ruleComputedAlign === "center", `'Rule Status' <th>'s ACTUAL computed text-align is "center" (got "${ruleComputedAlign}")`);

    const leafHeaders = headRows.nth(1).locator("th");
    for (let i = 0; i < 6; i++) {
      const align = await leafHeaders.nth(i).evaluate((el) => getComputedStyle(el).textAlign);
      assert(align === "center", `Leaf sub-header ${i} has ACTUAL computed text-align "center" (got "${align}")`);
    }

    // ---- Step 2: real glyph-level text position, not the cell box ----
    // The mistake last round: comparing the <th> element's own
    // boundingBox() to the leaf column span -- since the <th> IS the
    // colSpan=3 cell, that box trivially spans the right columns
    // regardless of text-align, so it can never actually catch a
    // left-vs-center bug. This uses a real DOM Range around the text
    // node to get the actual rendered glyph bounding box, then compares
    // ITS center to the cell's center -- only true when text-align is
    // genuinely applied.
    async function textCenterX(locator) {
      return locator.evaluate((el) => {
        const textNode = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rect = range.getBoundingClientRect();
        return rect.x + rect.width / 2;
      });
    }
    async function cellCenterX(locator) {
      const box = await locator.boundingBox();
      return box.x + box.width / 2;
    }

    const proposalTextCenterX = await textCenterX(proposalGroupTh);
    const proposalCellCenterX = await cellCenterX(proposalGroupTh);
    console.log(`'Proposal Status' text center x=${proposalTextCenterX.toFixed(1)}, cell center x=${proposalCellCenterX.toFixed(1)}`);
    assert(Math.abs(proposalTextCenterX - proposalCellCenterX) <= 2, `'Proposal Status' TEXT glyphs are actually centered within their cell (text center vs cell center within 2px) -- the real, glyph-level check the previous round's script never did`);

    const ruleTextCenterX = await textCenterX(ruleGroupTh);
    const ruleCellCenterX = await cellCenterX(ruleGroupTh);
    assert(Math.abs(ruleTextCenterX - ruleCellCenterX) <= 2, `'Rule Status' TEXT glyphs are actually centered within their cell (text center=${ruleTextCenterX.toFixed(1)}, cell center=${ruleCellCenterX.toFixed(1)})`);

    // Each leaf letter's text center vs its own <td> column's number center
    const dataRow = page.locator("tbody tr").first();
    for (let i = 0; i < 6; i++) {
      const th = leafHeaders.nth(i);
      const thTextCenterX = await textCenterX(th);
      const thCellCenterX = await cellCenterX(th);
      assert(Math.abs(thTextCenterX - thCellCenterX) <= 2, `Leaf header ${i}'s letter is centered within its own <th> (text center=${thTextCenterX.toFixed(1)}, cell center=${thCellCenterX.toFixed(1)})`);

      // And that <th> is really the same column as the data <td> below it
      // (same x range), confirming the letter sits over its real number.
      const td = dataRow.locator("td").nth(2 + i);
      const thBox = await th.boundingBox();
      const tdBox = await td.boundingBox();
      assert(Math.abs(thBox.x - tdBox.x) <= 1 && Math.abs(thBox.width - tdBox.width) <= 1, `Leaf header ${i}'s <th> occupies the exact same column x/width as the data <td> below it (th x=${thBox.x.toFixed(1)}/w=${thBox.width.toFixed(1)}, td x=${tdBox.x.toFixed(1)}/w=${tdBox.width.toFixed(1)})`);
    }

    await page.screenshot({ path: "/tmp/projects-header-truly-centered.png", fullPage: true });
    console.log("Screenshot saved to /tmp/projects-header-truly-centered.png");

    console.log("\nALL CHECKS PASSED");
  } finally {
    // cleanup
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
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
