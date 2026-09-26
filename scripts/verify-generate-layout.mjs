// Ad hoc Playwright verification (real Chromium, real Vite dev server on
// :5173, real backend on :8000) -- CLAUDE.md's documented pattern.
// Not part of the app, throwaway.
//
// Verifies the GeneratePage layout fix: no page-level scroll is needed to
// reach the form/Regenerate button even with a long result (only the
// result panel scrolls internally), and a short result doesn't leave the
// panel looking broken, at a typical laptop viewport (~800px tall).
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`OK: ${message}`);
}

function ruleXmlFor(i) {
  return `<structureObjectRule id="BRDP-LAYOUT-${i}"><objectPath allowedObjectFlag="1">//dmodule[${i}]</objectPath></structureObjectRule>`;
}

async function apiSetupProject(auth, name, ruleCount) {
  const project = await (
    await fetch(`${API}/api/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name, standard: "S1000D 4.2" }),
    })
  ).json();

  await fetch(`${API}/api/projects/${project.id}/config`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({
      project_config: {
        projectName: "Layout Verify",
        modelIdentCode: "LYT",
        enterpriseCode: "ABC12",
        systemDiffCode: "A",
        issueNumber: "001",
        inWork: "00",
        languageIsoCode: "en",
        countryIsoCode: "US",
        securityClassification: "01",
      },
    }),
  });

  for (let i = 1; i <= ruleCount; i++) {
    const brdp = await (
      await fetch(`${API}/api/projects/${project.id}/brdps`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ identifier: `BRDP-LAYOUT-${i}` }),
      })
    ).json();
    const approveUrl = `${API}/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`;
    await fetch(approveUrl, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ rule_xml: ruleXmlFor(i), source: "manual" }),
    });
    await fetch(`${approveUrl}/approve`, { method: "POST", headers: auth });
  }
  return project;
}

async function main() {
  const loginResp = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const { access_token: token } = await loginResp.json();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const longProject = await apiSetupProject(auth, `Layout Long ${suffix}`, 25);
  const shortProject = await apiSetupProject(auth, `Layout Short ${suffix}`, 1);
  console.log(`Long-result project: ${longProject.id} (25 rules)`);
  console.log(`Short-result project: ${shortProject.id} (1 rule)`);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  // A typical laptop viewport, ~800px tall, per the docs request.
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });
    console.log("Logged in.");

    // ---- Long result: 25 approved rules ----
    await page.goto(`${BASE_URL}/projects/${longProject.id}/generate`);
    await page.waitForSelector('button:has-text("Schematron (XPath 2.0)")', { timeout: 10000 });
    const onlyValidated = page.locator('input[type="checkbox"]').first();
    if (await onlyValidated.isChecked()) await onlyValidated.uncheck();
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 30000 });

    // Page itself must not need scrolling -- its scrollHeight must not
    // exceed its clientHeight (the viewport-bound .mainContent).
    const pageScrollable = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollHeight > el.clientHeight + 1; // +1 for subpixel rounding
    });
    assert(!pageScrollable, "long-result page does NOT need page-level scroll");

    // The Regenerate button and the form above must be visible without
    // scrolling anything but the result panel.
    const regenerateBox = await page.locator('button:has-text("Regenerate")').boundingBox();
    assert(regenerateBox !== null && regenerateBox.y >= 0 && regenerateBox.y < 800, "Regenerate button is visible within the 800px viewport");

    // The <pre> itself must be the thing that scrolls (its content is
    // taller than its own box).
    const preScrollable = await page.locator("pre").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    assert(preScrollable, "the result <pre> panel itself scrolls internally (25 rules don't fit its box)");

    await page.screenshot({ path: "/tmp/verify-layout-long.png", fullPage: false });
    console.log("Screenshot (viewport only, no full-page): /tmp/verify-layout-long.png");

    // ---- Short result: 1 approved rule ----
    await page.goto(`${BASE_URL}/projects/${shortProject.id}/generate`);
    await page.waitForSelector('button:has-text("Schematron (XPath 2.0)")', { timeout: 10000 });
    const onlyValidated2 = page.locator('input[type="checkbox"]').first();
    if (await onlyValidated2.isChecked()) await onlyValidated2.uncheck();
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 30000 });

    const shortPageScrollable = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollHeight > el.clientHeight + 1;
    });
    assert(!shortPageScrollable, "short-result page does NOT need page-level scroll either");
    await page.screenshot({ path: "/tmp/verify-layout-short.png", fullPage: false });
    console.log("Screenshot (viewport only, no full-page): /tmp/verify-layout-short.png");

    // ---- Resize sanity check: shrink then grow the viewport ----
    await page.setViewportSize({ width: 1000, height: 500 });
    await page.waitForTimeout(200);
    const resizedScrollable = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollHeight > el.clientHeight + 1;
    });
    assert(!resizedScrollable, "after shrinking the window to 500px tall, still no page-level scroll");
    const regenerateStillVisible = await page.locator('button:has-text("Regenerate")').isVisible();
    assert(regenerateStillVisible, "Regenerate button still present (not destroyed) after resize");
    await page.screenshot({ path: "/tmp/verify-layout-resized-500.png", fullPage: false });

    await page.setViewportSize({ width: 1366, height: 800 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: "/tmp/verify-layout-resized-back.png", fullPage: false });

    console.log("\nAll layout checks passed.");
  } finally {
    await browser.close();
    // Cleanup.
    await fetch(`${API}/api/projects/${longProject.id}`, { method: "DELETE", headers: auth });
    await fetch(`${API}/api/projects/${shortProject.id}`, { method: "DELETE", headers: auth });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
