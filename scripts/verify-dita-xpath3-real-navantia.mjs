// Ad hoc Playwright end-to-end verification (real Chromium, real Vite dev
// server, real backend, real Postgres) of the DITA 1.3 Xpath3.0 standard
// against REAL Navantia data -- nav_dtm_xpath3_import.xlsx (36 rows, 9
// Verified/Validated with real native XPath 3.0 Schematron content).
//
// This replaces the earlier synthetic-only coverage
// (verify-dita-xpath3-querybinding.mjs) for the encargo's own explicit
// closure requirement: "no lo des por hecho" -- confirm queryBinding,
// verbatim content injection, and vocabulary-warning behavior against a
// REAL Xpath3.0 project, not constructed content.
//
// Verifies:
//   1. A real DITA 1.3 Xpath3.0 project can be created and configured.
//   2. Importing the real file creates all 36 BRDPs (27 To Do, 9 Verified).
//   3. Generate produces queryBinding="xslt3" (not the xslt2 default).
//   4. Real XPath 3.0 constructs from the file (fn:head, the inline
//      "function($t as element()) as xs:string { ... }" function-item
//      expression, the "!" simple map operator, "for ... return") are
//      injected verbatim -- not stripped, not mangled.
//   5. Zero false-positive vocabulary warnings (confirms the
//      XPATH3_ONLY_VOCAB / XPATH_FUNCTIONS/XPATH_KEYWORDS additions made
//      after reading this real file: head, function, exists, empty,
//      distinct-values, analyze-string, local-name, element, as).
//   6. The genuine data issue this file surfaces -- rows BRDP-EXT-00007,
//      00008 and 00009 share byte-identical Rule content (same
//      sch:pattern id, same three sch:assert ids) -- is caught as a real
//      "Duplicate sch:assert/sch:report id" well-formedness error, not
//      silently swallowed. This is expected: it is a data problem in the
//      test file, not a code bug, and does not block download.
//
// Usage: node scripts/verify-dita-xpath3-real-navantia.mjs <path-to-xlsx>
import { chromium } from "playwright-core";
import path from "node:path";

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
    console.error("Usage: node scripts/verify-dita-xpath3-real-navantia.mjs <path-to-xlsx>");
    process.exit(1);
  }
  const absXlsxPath = path.resolve(xlsxPath);

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
    const projectName = `Navantia Xpath3 Real ${suffix}`;
    await page.click('button:has-text("Create project")');
    await page.waitForSelector("form select", { timeout: 10000 });
    await page.locator("form input").first().fill(projectName);
    await page.locator("form select").first().selectOption("DITA 1.3 Xpath3.0");
    await page.click('form button[type="submit"]');
    await page.waitForSelector(`text=${projectName}`, { timeout: 10000 });

    const row = page.locator("tr", { hasText: projectName });
    await row.getByRole("button", { name: "Project Configuration" }).click();
    await page.waitForURL(/\/projects\/.+\/config/, { timeout: 10000 });
    projectId = page.url().match(/\/projects\/([^/]+)\/config/)[1];
    console.log(`Project id: ${projectId}`);

    // ---- Set projectName via the real DITA config form (isConfigComplete gate) ----
    const projectNameInput = page.locator("input").first();
    await projectNameInput.fill(projectName);
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(500);

    // ---- Import the REAL Navantia Xpath3.0 file ----
    await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });
    await page.locator('input[type="file"]').setInputFiles(absXlsxPath);
    await page.waitForSelector('button:has-text("Apply import")', { timeout: 15000 });
    await page.click('button:has-text("Apply import")');
    const proceedBtn = page.locator('button:has-text("Proceed")');
    if (await proceedBtn.count()) await proceedBtn.click();
    await page.waitForSelector("text=Import complete", { timeout: 60000 });
    const importResultText = await page
      .locator("ul")
      .filter({ hasText: /created|updated|rejected/i })
      .first()
      .innerText();
    console.log("Import result:", importResultText.replace(/\n/g, " | "));
    assert(/36 BRDPs created/i.test(importResultText), "import created all 36 BRDPs");
    await page.click('button:has-text("Close")');

    // ---- Confirm 9 Verified (approved) / 27 To Do (no approval row) via the API ----
    // Rule Status lives in rule_approvals, not on the BRDP itself -- "Verified"
    // means an approval row exists with status="approved" (see approvals.py's
    // _rule_state); a BRDP with no approval row at all is "To Do".
    const brdpsResp = await fetch(`${API}/api/projects/${projectId}/brdps`, { headers: auth });
    const brdps = await brdpsResp.json();
    assert(brdps.length === 36, `36 BRDPs total (got ${brdps.length})`);

    const approvalsResp = await fetch(`${API}/api/projects/${projectId}/approvals/SCH-DITA`, { headers: auth });
    const approvals = await approvalsResp.json();
    const approvedCount = approvals.filter((a) => a.status === "approved").length;
    assert(approvedCount === 9, `9 approval rows with status="approved" (Verified) (got ${approvedCount})`);
    assert(brdps.length - approvedCount === 27, `27 BRDPs with no approved rule (To Do) (got ${brdps.length - approvedCount})`);

    // ---- Generate: real queryBinding, real content, real vocabulary check ----
    await page.goto(`${BASE_URL}/projects/${projectId}/generate`);
    await page.waitForSelector(`p:has-text("DITA 1.3 Xpath3.0")`, { timeout: 10000 });
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 30000 });
    const xml = await page.locator("pre").innerText();

    assert(xml.includes('queryBinding="xslt3"'), 'generated document header uses queryBinding="xslt3"');
    assert(!xml.includes('queryBinding="xslt2"'), "generated document does NOT carry the xslt2 default");

    // Real XPath 3.0 constructs from the actual file, verbatim.
    assert(xml.includes("head($docs"), "real fn:head() call from BRDP-EXT-00007/8/9 is present verbatim");
    assert(
      xml.includes('function($t as element()) as xs:string'),
      "real inline function-item expression from BRDP-EXT-00004 (escalonPlan) is present verbatim"
    );
    assert(xml.includes("$docPrec//cmd ! normalize-space(.)"), 'real "!" simple map operator usage is present verbatim');
    assert(xml.includes("for $tr in //topicref[@href] return $docFicha($tr)"), 'real "for ... return" expression is present verbatim');
    // The source cell's literal text already contains the raw XML numeric
    // entity ("&#211;" for U+00D3 "Ó", written by whoever authored the rule
    // to safely embed accented text in an XML attribute/fragment) -- React
    // renders result.xml as a plain text node inside <pre>, so it is never
    // HTML-decoded; the DOM's own innerText carries the literal entity
    // characters verbatim, not a rendered "Ó" glyph.
    assert(xml.includes("ESCAL&#211;N DE MANTENIMIENTO"), "real Spanish domain text (with its literal XML entity) from BRDP-EXT-00004 is present verbatim");
    assert(xml.includes('id="BRDP-EXT-00001"'), "real BRDP id BRDP-EXT-00001 is present");
    assert(xml.includes('id="BRDP-EXT-00004a"'), "real BRDP id BRDP-EXT-00004a is present");

    // Well-formedness badge: expected to be an ERROR here, because rows
    // 00007/00008/00009 share identical Rule content -- a real data
    // problem in the source file, not a code bug. The check must catch
    // it, not silently pass.
    const errorBadge = await page.locator("text=/XML error|error de XML/i").count();
    assert(errorBadge > 0, "well-formedness badge correctly reports an error (duplicate ids from the real data's 00007/00008/00009 duplication)");
    const errorBadgeText = await page.locator("[class*=badgeError]").first().innerText();
    console.log("Error badge text:", errorBadgeText);
    assert(/Duplicate/i.test(errorBadgeText), "error message names the real duplicate-id problem");
    assert(/BRDP-EXT-00007/.test(errorBadgeText), "error message names the real duplicated ids");

    // Vocabulary warnings: must be ZERO for this real xslt3 content --
    // confirms head/function/exists/empty/distinct-values/analyze-string/
    // local-name/element/as no longer produce false positives.
    const vocabWarningsToggle = page.locator("text=/vocabulary warning/i");
    const vocabCount = await vocabWarningsToggle.count();
    if (vocabCount > 0) {
      const toggleText = await vocabWarningsToggle.first().innerText();
      console.log("Vocabulary warnings toggle text:", toggleText);
      throw new Error(`ASSERTION FAILED: expected zero vocabulary warnings for real Xpath3.0 content, but found a warnings panel: "${toggleText}"`);
    }
    console.log("OK: zero vocabulary warnings for the real Xpath3.0 content (no warnings panel rendered)");

    await page.screenshot({ path: "/tmp/verify-dita-xpath3-real-output.png", fullPage: true });

    // ---- Real download: filename uses projectName (DITA convention) ----
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click('button:has-text("Download")'),
    ]);
    const filename = download.suggestedFilename();
    console.log("Downloaded filename:", filename);
    assert(filename.startsWith(projectName), `downloaded filename starts with the real project name (got "${filename}")`);
    assert(filename.endsWith("_dita.sch"), `downloaded filename ends with _dita.sch (got "${filename}")`);

    console.log("\nAll real Navantia Xpath3.0 checks passed.");
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
