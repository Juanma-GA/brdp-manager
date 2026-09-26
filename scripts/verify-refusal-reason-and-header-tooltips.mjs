// Verification for: Part 1 (a <textarea> for brdps.comments -- already
// existed end-to-end in the backend, never wired up in the frontend --
// appears under Proposal Status only when it's Refused, and hides again
// without discarding a saved reason) and Part 2 (BRDP Projects' two-level
// header: group headers centered over their 3-column groups, and a
// title tooltip on each of the 6 leaf letters naming its full state).
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
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // ---- Seed one real BRDP on Demo Project to exercise the textbox ----
  const projects = await fetch(`${API}/api/projects`, { headers: auth }).then((r) => r.json());
  const demo = projects.find((p) => p.name.startsWith("Demo Project"));
  const created = await fetch(`${API}/api/projects/${demo.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-REFUSAL-TEST",
      title: "Refusal reason textbox test",
      definition: "d",
      proposal: "p",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  console.log("Seeded BRDP-REFUSAL-TEST on Demo Project");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // ---- Part 1: Refusal reason textbox ----
    const row = page.locator("tr", { hasText: "Demo Project" });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    await page.locator("tr", { hasText: "BRDP-REFUSAL-TEST" }).click();
    await page.waitForSelector("text=/Reason for refusal/i", { state: "detached", timeout: 5000 }).catch(() => {});
    let textboxCount = await page.locator("text=/Reason for refusal/i").count();
    assert(textboxCount === 0, "Textbox is NOT shown while Proposal Status is Pending");

    // Switch to Refused via the real <select>
    const validationSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "Refused" }) }).last();
    await validationSelect.selectOption("Refused");
    await page.waitForTimeout(500);
    await page.waitForSelector("text=/Reason for refusal/i", { timeout: 5000 });
    assert(true, "Textbox appears immediately after switching Proposal Status to Refused");

    const textarea = page.locator("label", { hasText: "Reason for refusal" }).locator("xpath=following-sibling::textarea[1]");
    await textarea.fill("Refused because the applicability logic conflicts with BRDP-S1-00042.");
    await textarea.blur();
    await page.waitForTimeout(600);

    await page.screenshot({ path: "/tmp/refusal-textbox-visible.png" });

    // Reload and confirm the save persisted server-side, not just in local state
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tr", { hasText: "BRDP-REFUSAL-TEST" }).click();
    await page.waitForSelector("text=/Reason for refusal/i", { timeout: 5000 });
    const savedValue = await page.locator("label", { hasText: "Reason for refusal" }).locator("xpath=following-sibling::textarea[1]").inputValue();
    assert(savedValue === "Refused because the applicability logic conflicts with BRDP-S1-00042.", `Comment persisted server-side after reload (got: "${savedValue}")`);

    // Hover the Refused badge in the table row -- tooltip shows the reason
    const badgeTitle = await page.locator("tr", { hasText: "BRDP-REFUSAL-TEST" }).locator("span", { hasText: "Refused" }).getAttribute("title");
    assert(badgeTitle === savedValue, `Refused badge in the table carries the same reason as its title/tooltip (got: "${badgeTitle}")`);

    // Switch back to Validated -- textbox disappears
    const validationSelect2 = page.locator("select").filter({ has: page.locator("option", { hasText: "Validated" }) }).last();
    await validationSelect2.selectOption("Validated");
    await page.waitForTimeout(500);
    textboxCount = await page.locator("text=/Reason for refusal/i").count();
    assert(textboxCount === 0, "Textbox disappears again after switching away from Refused");
    await page.screenshot({ path: "/tmp/refusal-textbox-hidden.png" });

    // Confirm the comment was NOT discarded server-side (docs request edge case)
    const brdpAfter = await fetch(`${API}/api/projects/${demo.id}/brdps`, { headers: auth })
      .then((r) => r.json())
      .then((list) => list.find((b) => b.identifier === "BRDP-REFUSAL-TEST"));
    assert(
      brdpAfter.comments === "Refused because the applicability logic conflicts with BRDP-S1-00042.",
      `Switching Proposal Status away from Refused does NOT clear the already-saved comments field (got: "${brdpAfter.comments}")`
    );

    // Switch back to Refused -- the old reason is still there, unprompted
    const validationSelect3 = page.locator("select").filter({ has: page.locator("option", { hasText: "Refused" }) }).last();
    await validationSelect3.selectOption("Refused");
    await page.waitForTimeout(500);
    const textareaAgain = page.locator("label", { hasText: "Reason for refusal" }).locator("xpath=following-sibling::textarea[1]");
    const valueOnReturn = await textareaAgain.inputValue();
    assert(valueOnReturn === "Refused because the applicability logic conflicts with BRDP-S1-00042.", `Re-selecting Refused shows the old reason still there, unprompted (got: "${valueOnReturn}")`);

    // Cleanup the seeded BRDP
    await fetch(`${API}/api/projects/${demo.id}/brdps/${created.id}`, { method: "DELETE", headers: auth });
    await fetch(`${API}/api/trash/${created.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up BRDP-REFUSAL-TEST");

    // ---- Part 2: BRDP Projects header centering + tooltips ----
    await page.goto(`${BASE_URL}/projects`);
    await page.waitForSelector("table", { timeout: 10000 });
    await page.waitForTimeout(300);

    // Group header centered over its 3-column span: its own text center-x
    // should land near the center-x of the 3 leaf columns it spans.
    const headRows = page.locator("thead tr");
    const proposalGroupHeader = headRows.nth(0).locator("th", { hasText: "Proposal Status" });
    const groupBox = await proposalGroupHeader.boundingBox();
    const leafHeaders = headRows.nth(1).locator("th");
    const firstLeafBox = await leafHeaders.nth(0).boundingBox();
    const lastLeafBox = await leafHeaders.nth(2).boundingBox();
    const groupCenterX = groupBox.x + groupBox.width / 2;
    const leafSpanCenterX = firstLeafBox.x + (lastLeafBox.x + lastLeafBox.width - firstLeafBox.x) / 2;
    console.log(`Proposal Status group header center x=${groupCenterX.toFixed(1)}, leaf span center x=${leafSpanCenterX.toFixed(1)}`);
    assert(Math.abs(groupCenterX - leafSpanCenterX) <= 1, "'Proposal Status' group header text is centered over its 3 leaf columns");

    // Each leaf <th> letter carries the right tooltip.
    const expectedTitles = [
      ["V", "Validated"],
      ["P", "Pending"],
      ["R", "Refused"],
      ["V", "Verified"],
      ["D", "Draft"],
      ["T", "To Do"],
    ];
    for (let i = 0; i < 6; i++) {
      const th = leafHeaders.nth(i);
      const text = await th.innerText();
      const title = await th.getAttribute("title");
      assert(text === expectedTitles[i][0], `Leaf header ${i} reads "${expectedTitles[i][0]}" (got "${text}")`);
      assert(title === expectedTitles[i][1], `Leaf header ${i} ("${text}") has title="${expectedTitles[i][1]}" (got "${title}")`);
    }

    await page.screenshot({ path: "/tmp/projects-header-centered-tooltips.png" });

    // Hover one letter for a real visible tooltip in the screenshot
    await leafHeaders.nth(3).hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "/tmp/projects-header-tooltip-hover.png" });

    console.log("\nALL CHECKS PASSED");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
