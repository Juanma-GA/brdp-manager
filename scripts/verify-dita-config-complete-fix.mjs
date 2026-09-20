// Throwaway regression check for the isConfigComplete bug found this round:
// a DITA 1.3 project's Generate button was permanently disabled because
// GeneratePage.jsx gated on project_config.modelIdentCode regardless of
// standard, but DITA's own Project Configuration page never shows/saves
// that field. Confirms live (real UI, real backend) that after saving just
// projectName via the real Project Configuration form, the Generate button
// becomes enabled and a real generation succeeds.
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

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage();
  let projectId;
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });

    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `DITA ConfigFix ${suffix}`;
    await page.click('button:has-text("Create project")');
    await page.waitForSelector("form select", { timeout: 10000 });
    await page.locator("form input").first().fill(name);
    await page.locator("form select").first().selectOption("DITA 1.3 Xpath2.0");
    await page.click('form button[type="submit"]');
    await page.waitForSelector(`text=${name}`, { timeout: 10000 });

    const row = page.locator("tr", { hasText: name });
    await row.getByRole("button", { name: "Generate BREX / Schematron" }).click();
    await page.waitForURL(/\/projects\/.+\/generate/, { timeout: 10000 });
    projectId = page.url().match(/\/projects\/([^/]+)\/generate/)[1];
    await page.waitForSelector(`p:has-text("DITA 1.3")`, { timeout: 10000 });

    // Before the fix: this would stay disabled forever (no field in the
    // DITA config page can ever set modelIdentCode).
    const generateBtn = page.locator('button:has-text("Generate")').first();
    await page.waitForTimeout(500);
    assert(await generateBtn.isDisabled(), "Generate button starts disabled before project_config.projectName is set (config incomplete warning expected)");
    const warningVisible = await page.locator("text=/configuration incomplete/i").count();
    assert(warningVisible > 0, "shows the 'Project configuration incomplete' warning before projectName is set");

    // Go set projectName via the REAL Project Configuration UI (not a direct API PUT).
    await page.goto(`${BASE_URL}/projects/${projectId}/config`);
    await page.waitForSelector("input", { timeout: 10000 });
    // The DITA config form's only field: projectName.
    const projectNameInput = page.locator("input").first();
    await projectNameInput.fill("Navantia S80 ConfigFix");
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(500);

    await page.goto(`${BASE_URL}/projects/${projectId}/generate`);
    await page.waitForSelector(`p:has-text("DITA 1.3")`, { timeout: 10000 });
    await page.waitForTimeout(500);
    const generateBtn2 = page.locator('button:has-text("Generate")').first();
    assert(!(await generateBtn2.isDisabled()), "Generate button becomes ENABLED once projectName is saved via the real DITA config form");

    // Need at least one BRDP or generation throws "No validated BRDPs" --
    // create one with validation=Validated via API (fast, not the point of
    // this particular check) and regenerate.
    const loginResp = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    const { access_token } = await loginResp.json();
    const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
    await fetch(`${API}/api/projects/${projectId}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ identifier: "BRDP-CFGFIX-1", title: "t", definition: "d" }),
    });

    await page.goto(`${BASE_URL}/projects/${projectId}/generate`);
    await page.waitForSelector(`p:has-text("DITA 1.3")`, { timeout: 10000 });
    const onlyValidatedCb = page.locator('input[type="checkbox"]').first();
    if (await onlyValidatedCb.isChecked()) await onlyValidatedCb.uncheck();
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 15000 });
    const xml = await page.locator("pre").innerText();
    assert(xml.includes("<sch:schema"), "a real generation succeeds end to end once the fix is in place");

    console.log("\nisConfigComplete fix verified live for DITA 1.3.");
  } finally {
    if (projectId) {
      const loginResp = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      const { access_token } = await loginResp.json();
      await fetch(`${API}/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${access_token}` },
      }).catch(() => {});
    }
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
