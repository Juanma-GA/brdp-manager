// Ad hoc Playwright verification (real Chromium, real Vite dev server on
// :5173, real Postgres via the backend on :8000) -- CLAUDE.md's documented
// pattern for frontend verification since there is no JS test runner.
// Not part of the app, not wired into anything, throwaway.
//
// Verifies:
//   1. Create Project dropdown offers exactly the 7 renamed standards
//      (S1000D 3.0.1/4.1/4.2, S1000D 5.0/6.0 disabled, DITA 1.3 Xpath2.0,
//      DITA 1.3 Xpath3.0 -- migration 0013_split_dita_xpath_standards.py),
//      no "Schematron 1.0 — S1000D" entry anywhere, no bare "DITA 1.3".
//   2. Generate page shows the BREX / Schematron selector for the three
//      real S1000D standards, and for NEITHER DITA standard.
//   3. A real S1000D 4.2 project with one approved rule generates correct
//      BREX AND (after switching the selector, no reload) correct
//      Schematron -- proving generateBREXSch.js now picks the 4.2 base
//      generator instead of always assuming 3.0.1.
//
// Usage: node scripts/verify-standards-rename.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

const RULE_XML =
  '<structureObjectRule id="BRDP-VERIFY-4-2"><objectPath allowedObjectFlag="1">//dmodule</objectPath></structureObjectRule>';

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`OK: ${message}`);
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser console error]", msg.text());
  });

  try {
    // ---- Login ----
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(projects)?$/, { timeout: 10000 }).catch(() => {});
    await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });
    console.log("Logged in as admin.");

    // ---- 1. Dropdown offers exactly the 7 renamed standards ----
    await page.goto(`${BASE_URL}/`);
    await page.click('button:has-text("Create project")');
    await page.waitForSelector("select", { timeout: 10000 });
    const options = await page.locator("form select").first().locator("option").allTextContents();
    console.log("Dropdown options:", options);
    const cleaned = options.map((o) => o.replace(/\s+/g, " ").trim());
    for (const expected of ["S1000D 3.0.1", "S1000D 4.1", "S1000D 4.2", "DITA 1.3 Xpath2.0", "DITA 1.3 Xpath3.0"]) {
      assert(
        cleaned.some((o) => o === expected),
        `dropdown includes "${expected}"`
      );
    }
    assert(
      cleaned.some((o) => o.startsWith("S1000D 5.0")),
      "dropdown includes S1000D 5.0 (coming soon)"
    );
    assert(
      cleaned.some((o) => o.startsWith("S1000D 6.0")),
      "dropdown includes S1000D 6.0 (coming soon)"
    );
    assert(
      !cleaned.some((o) => o.includes("Schematron")),
      'dropdown has NO "Schematron 1.0 — S1000D" (or any Schematron) entry'
    );
    assert(
      !cleaned.some((o) => o === "DITA 1.3"),
      'dropdown has NO bare "DITA 1.3" entry any more (split into Xpath2.0/Xpath3.0)'
    );
    assert(cleaned.length === 7, `dropdown has exactly 7 options (got ${cleaned.length})`);

    // ---- Create one project per renamed S1000D standard + both DITA standards ----
    const createdNames = {};
    const suffix = Math.random().toString(36).slice(2, 8);
    for (const standard of ["S1000D 3.0.1", "S1000D 4.1", "S1000D 4.2", "DITA 1.3 Xpath2.0", "DITA 1.3 Xpath3.0"]) {
      const name = `Verify ${standard} ${suffix}`;
      createdNames[standard] = name;
      await page.locator("form input").first().fill(name);
      await page.locator("form select").first().selectOption(standard);
      await page.click('form button[type="submit"]');
      await page.waitForSelector(`text=${name}`, { timeout: 10000 });
      console.log(`Created project "${name}" with standard "${standard}".`);
      // Re-open the create form for the next iteration.
      await page.click('button:has-text("Create project")');
    }
    // Close the (now empty) create form before screenshotting the list.
    await page.click('button:has-text("Cancel")').catch(() => {});
    await page.screenshot({ path: "/tmp/verify-1-projects-list.png", fullPage: true });

    // ---- 2. Generate-page selector: present for the 3 S1000D standards, absent for both DITA standards ----
    const projectIds = {};
    for (const standard of ["S1000D 3.0.1", "S1000D 4.1", "S1000D 4.2", "DITA 1.3 Xpath2.0", "DITA 1.3 Xpath3.0"]) {
      const name = createdNames[standard];
      const row = page.locator("tr", { hasText: name });
      await row.getByRole("button", { name: "Generate BREX / Schematron" }).click();
      await page.waitForURL(/\/projects\/.+\/generate/, { timeout: 10000 });
      projectIds[standard] = page.url().match(/\/projects\/([^/]+)\/generate/)[1];
      // The project itself (and its standard) loads asynchronously via
      // ProjectLayout's outlet context -- wait for the real page content
      // (the subtitle line echoes project.standard) before checking for
      // the selector, otherwise a `count()` taken before that fetch
      // resolves would always read 0 regardless of the real outcome.
      // Wait for the page's own fixed-format line (inside the same card as
      // the selector) rather than just the subtitle -- both come from the
      // same `project` state, but waiting on the field actually adjacent to
      // the selector avoids a race against React's render commit order.
      await page.waitForSelector(`p:has-text("${standard}")`, { timeout: 10000 });
      let selectorVisible;
      if (standard.startsWith("DITA 1.3")) {
        // Give the page a beat to settle, then confirm it never appears.
        await page.waitForTimeout(500);
        selectorVisible = await page.locator('button:has-text("Schematron (XPath 2.0)")').count();
        assert(selectorVisible === 0, `${standard} Generate page has NO BREX/Schematron selector`);
      } else {
        await page.waitForSelector('button:has-text("Schematron (XPath 2.0)")', { timeout: 10000 });
        selectorVisible = await page.locator('button:has-text("Schematron (XPath 2.0)")').count();
        assert(selectorVisible === 1, `${standard} Generate page HAS the BREX/Schematron selector`);
      }
      await page.goBack();
      await page.waitForSelector('button:has-text("Create project")', { timeout: 10000 });
    }
    console.log("Project ids:", projectIds);

    // ---- 3. Real generation from the S1000D 4.2 project: BREX, then Schematron, no reload ----
    const loginResp = await fetch("http://localhost:8000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (!loginResp.ok) throw new Error(`API login failed: ${loginResp.status}`);
    const { access_token: token } = await loginResp.json();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const projectId42 = projectIds["S1000D 4.2"];

    const configResp = await fetch(`http://localhost:8000/api/projects/${projectId42}/config`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        project_config: {
          projectName: "Verify 4.2",
          modelIdentCode: "VRFY",
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
    if (!configResp.ok) throw new Error(`Config update failed: ${configResp.status} ${await configResp.text()}`);

    const brdpResp = await fetch(`http://localhost:8000/api/projects/${projectId42}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ identifier: "BRDP-VERIFY-4-2", title: "Verify title", definition: "Verify definition" }),
    });
    if (!brdpResp.ok) throw new Error(`BRDP create failed: ${brdpResp.status} ${await brdpResp.text()}`);
    const brdp = await brdpResp.json();
    console.log(`Created BRDP ${brdp.identifier} (validation=${brdp.validation}) in the S1000D 4.2 project.`);

    const approveUrl = `http://localhost:8000/api/projects/${projectId42}/brdps/${brdp.id}/approvals/BREX-4.2`;
    const putResp = await fetch(approveUrl, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ rule_xml: RULE_XML, source: "manual" }),
    });
    if (!putResp.ok) throw new Error(`Propose rule failed: ${putResp.status} ${await putResp.text()}`);
    const approveResp = await fetch(`${approveUrl}/approve`, { method: "POST", headers: auth });
    if (!approveResp.ok) throw new Error(`Approve failed: ${approveResp.status} ${await approveResp.text()}`);
    console.log("Rule approved under BREX-4.2.");

    // Navigate (fresh load) to the Generate page now that the project has a
    // real approved rule -- the BRDP stays "Pending", so "Only include
    // Validated BRDPs" must be unchecked for it to be included (avoids
    // needing a real Mistral embeddings call in this dev environment).
    await page.goto(`${BASE_URL}/projects/${projectId42}/generate`);
    await page.waitForSelector('button:has-text("Schematron (XPath 2.0)")', { timeout: 10000 });
    const onlyValidatedCheckbox = page.locator('input[type="checkbox"]').first();
    if (await onlyValidatedCheckbox.isChecked()) await onlyValidatedCheckbox.uncheck();

    // BREX output (selector defaults to BREX).
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 30000 });
    const brexOutput = await page.locator("pre").innerText();
    assert(brexOutput.includes("structureObjectRule"), "BREX output contains the approved structureObjectRule");
    assert(brexOutput.includes('id="BRDP-VERIFY-4-2"'), "BREX output contains the approved rule's real content");
    const brexBadgeOk = await page.locator("text=/Well-formed XML/i").count();
    assert(brexBadgeOk > 0, "BREX output reports well-formed XML");
    await page.screenshot({ path: "/tmp/verify-2-brex-4-2-output.png", fullPage: true });

    // Switch to Schematron -- same page, no reload -- and regenerate.
    await page.click('button:has-text("Schematron (XPath 2.0)")');
    await page.click('button:has-text("Regenerate")');
    await page.waitForSelector("pre", { timeout: 30000 });
    const schOutput = await page.locator("pre").innerText();
    assert(schOutput.includes("<sch:schema"), "Schematron output is a real <sch:schema> document");
    assert(schOutput.includes("sch:pattern"), "Schematron output contains at least one sch:pattern");
    assert(!schOutput.includes("structureObjectRule"), "Schematron output is converted, not raw BREX");
    const schBadgeOk = await page.locator("text=/Well-formed XML/i").count();
    assert(schBadgeOk > 0, "Schematron output reports well-formed XML");
    await page.screenshot({ path: "/tmp/verify-3-schematron-4-2-output.png", fullPage: true });

    console.log("\nAll checks passed: standards rename, selector presence/absence, and real BREX+Schematron generation from an S1000D 4.2 project.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
