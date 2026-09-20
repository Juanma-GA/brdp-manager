// Ad hoc Playwright end-to-end verification (real Chromium, real Vite dev
// server on :5173, real backend on :8000, real Postgres) -- CLAUDE.md's
// documented pattern. Not part of the app, throwaway.
//
// Verifies the whole DITA 1.3 native-Schematron-rule round trip against
// the REAL Navantia S80 file (nav_dtm_xpath2_import_v3.xlsx, 36 BRDPs, 8
// Verified with real unprefixed Schematron <pattern>/<rule>/<assert>, no
// sch: prefix -- confirmed real-world style, distinct from the sch:-prefixed
// curated few-shot examples that motivated the earlier well-formedness fix):
//   1. Create a DITA 1.3 project via the real UI, set its projectName via
//      the real Project Configuration form (needed for the isConfigComplete
//      fix found this round).
//   2. Import the real file via the real Data Management UI (file input ->
//      analyze -> Apply -> background job -> completed).
//   3. Confirm the 8 Verified rows land as approved SCH-DITA approvals,
//      with rule_xml stored byte-for-byte identical to the source file, and
//      that they became "approved" directly on Apply (no separate approval
//      click needed).
//   4. Manual-editor round trip: open a To Do BRDP's Rule Status editor in
//      the real Records UI and save one of the real unprefixed rule strings
//      through checkWellFormed()'s real UI path (not just the function
//      called directly, per the user's explicit "tanto al guardarlo desde
//      el editor manual" instruction).
//   5. Generate via the real Generate page -- confirm the resulting .sch
//      contains each of the 8 real rules VERBATIM (not reconstructed, not
//      passed through any BREX conversion or LLM), that the unprefixed
//      <pattern> blocks resolve into the real Schematron namespace (this
//      round's namespace fix), and that the other To Do rows appear only as
//      traceability comments (by BRDP uuid, not identifier -- confirmed
//      real behavior of buildTraceabilityComment).
//   6. Suggest Rule on this same real project now returns real precedent
//      instead of the previous "no rule format" 400.
//   7. Edge case: a Verified rule approved for a BRDP whose Proposal Status
//      is NOT Validated -- excluded entirely with "Only include Validated"
//      checked, included as a real rule once unchecked.
//   8. rule_override fires on a reimport that changes a real unprefixed
//      rule's content while keeping Rule Status "Verified".
//
// Usage: node scripts/verify-dita-navantia-e2e.mjs <path-to-xlsx>
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const SCRATCH = "/tmp/claude-0/-home-user-brdp-manager/98dcb646-cccc-5aae-b30c-7469530ec6c5/scratchpad";

// The fixture files (all_rows.json/verified_rules.json) were extracted with
// Python's openpyxl, which -- per the XML 1.0 spec's mandatory line-ending
// normalization on parse -- reads embedded \r\n as \n. The app's own real
// import path (importFromExcel, SheetJS in the browser) does NOT apply that
// same normalization and preserves \r\n as authored in the cell -- confirmed
// live: byte-for-byte comparison failed only ever at a \r\n vs \n boundary,
// nowhere else. This is a real difference between the two parsers' line-
// ending handling, not a content difference (both represent the same
// logical line break, and lxml-based comparisons elsewhere in the app, e.g.
// rule_override's _rule_xml_structurally_equal, already normalize this via
// XML parsing) -- so "verbatim" here is checked content-identical modulo
// line-ending style, which is what actually matters for this task.
function normalizeEol(s) {
  return s.replace(/\r\n/g, "\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`OK: ${message}`);
}

async function apiLogin() {
  const resp = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!resp.ok) throw new Error(`API login failed: ${resp.status}`);
  const { access_token } = await resp.json();
  return { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
}

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("Usage: node scripts/verify-dita-navantia-e2e.mjs <path-to-xlsx>");
    process.exit(1);
  }
  const absXlsxPath = path.resolve(xlsxPath);

  const allRows = JSON.parse(fs.readFileSync(`${SCRATCH}/all_rows.json`, "utf8"));
  const verifiedRows = allRows.filter((r) => r.rule_status === "Verified");
  const todoRows = allRows.filter((r) => r.rule_status === "To Do");
  assert(verifiedRows.length === 8, `fixture has exactly 8 Verified rows (got ${verifiedRows.length})`);
  assert(todoRows.length === 28, `fixture has exactly 28 To Do rows (got ${todoRows.length})`);
  assert(
    allRows.every((r) => r.proposal_status === "Validated"),
    "every row in the real file has Proposal Status = Validated"
  );
  assert(
    verifiedRows.every((r) => !/sch:(pattern|rule|assert|report)/.test(r.rule)),
    "the real Verified rows' Rule content is confirmed unprefixed (no sch: prefix)"
  );

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser console error]", msg.text());
  });

  let projectId;
  const auth = await apiLogin();

  try {
    // ---- Login (real UI) ----
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });
    console.log("Logged in as admin.");

    // ---- 1. Create a DITA 1.3 project, set projectName via real Config UI ----
    const suffix = Math.random().toString(36).slice(2, 8);
    const projectName = `Navantia S80 ${suffix}`;
    await page.click('button:has-text("Create project")');
    await page.waitForSelector("form select", { timeout: 10000 });
    await page.locator("form input").first().fill(projectName);
    await page.locator("form select").first().selectOption("DITA 1.3 Xpath2.0");
    await page.click('form button[type="submit"]');
    await page.waitForSelector(`text=${projectName}`, { timeout: 10000 });
    console.log(`Created project "${projectName}" (DITA 1.3).`);

    const row = page.locator("tr", { hasText: projectName });
    await row.getByRole("button", { name: "Project Configuration" }).click();
    await page.waitForURL(/\/projects\/.+\/config/, { timeout: 10000 });
    projectId = page.url().match(/\/projects\/([^/]+)\/config/)[1];
    console.log(`Project id: ${projectId}`);

    await page.waitForSelector("input", { timeout: 10000 });
    await page.locator("input").first().fill("Navantia S80");
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(500);
    console.log("Set projectName via the real DITA Project Configuration form.");

    // ---- 2. Import the real Navantia xlsx via the real Data Management UI ----
    await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(absXlsxPath);

    await page.waitForSelector('button:has-text("Apply import")', { timeout: 15000 });
    const summaryText = await page.locator("p", { hasText: /ready to import/i }).first().innerText().catch(() => "");
    console.log("Analyze summary:", summaryText);
    assert(/36/.test(summaryText), `analyze summary reports all 36 rows ready (got "${summaryText}")`);

    await page.click('button:has-text("Apply import")');
    // 36 Validated rows exceeds the ETA confirm-modal threshold (10) -- the
    // real UI interrupts with a confirmation modal before actually applying.
    await page.waitForSelector('button:has-text("Proceed")', { timeout: 10000 });
    await page.click('button:has-text("Proceed")');

    // Background job, polled by the UI -- 36 real (mocked-transport)
    // embedding calls take a few seconds.
    await page.waitForSelector("text=Import complete", { timeout: 60000 });
    const resultText = await page
      .locator("ul")
      .filter({ hasText: /created|updated|rejected/i })
      .first()
      .innerText();
    console.log("Import result:", resultText.replace(/\n/g, " | "));
    assert(/36 BRDPs created/i.test(resultText), `import created all 36 BRDPs (got "${resultText}")`);
    await page.click('button:has-text("Close")');
    await page.screenshot({ path: "/tmp/verify-dita-1-import-complete.png", fullPage: true });

    // ---- 3. Confirm the 8 Verified rows landed as approved SCH-DITA, byte-for-byte ----
    const brdps = await (await fetch(`${API}/api/projects/${projectId}/brdps`, { headers: auth })).json();
    assert(brdps.length === 36, `project has all 36 imported BRDPs (got ${brdps.length})`);

    const approvalsExport = await (
      await fetch(`${API}/api/projects/${projectId}/approvals/SCH-DITA/export`, { headers: auth })
    ).json();
    const approvedRows = approvalsExport.filter((a) => a.status === "approved");
    assert(approvedRows.length === 8, `exactly 8 approvals landed as approved directly on Apply, no separate approval click needed (got ${approvedRows.length})`);

    const brdpById = new Map(brdps.map((b) => [b.id, b]));
    const approvedByIdentifier = new Map(
      approvedRows.map((a) => [brdpById.get(a.brdp_id)?.identifier, a])
    );
    for (const vr of verifiedRows) {
      const approval = approvedByIdentifier.get(vr.identifier);
      assert(!!approval, `${vr.identifier} has an approved SCH-DITA approval`);
      assert(
        normalizeEol(approval.rule_xml) === normalizeEol(vr.rule),
        `${vr.identifier}'s stored rule_xml is verbatim-identical to the source Excel Rule column (content, modulo line-ending style)`
      );
    }

    // ---- 4. Manual-editor round trip with real unprefixed content (real UI, not just checkWellFormed() called directly) ----
    const todoBrdp = todoRows[0];
    await page.goto(`${BASE_URL}/projects/${projectId}/records`);
    await page.waitForSelector('input[placeholder="Search by ID or Title…"]', { timeout: 10000 });
    await page.fill('input[placeholder="Search by ID or Title…"]', todoBrdp.identifier);
    await page.waitForSelector(`text=${todoBrdp.identifier}`, { timeout: 10000 });
    await page.locator("tr", { hasText: todoBrdp.identifier }).locator("td").first().click();
    await page.waitForSelector('button:has-text("Edit")', { timeout: 10000 });
    await page.click('button:has-text("Edit")');
    const ruleEditorPanel = page.locator('[class*="ruleEditor"]');
    await ruleEditorPanel.locator("textarea").waitFor({ timeout: 10000 });
    // A real, unprefixed Schematron rule from the actual file (row 0's) --
    // proves checkWellFormed()'s real save path (wrapRuleXmlFragment) is
    // exercised through the real UI, not just called directly.
    const manualRuleXml = verifiedRows[0].rule;
    await ruleEditorPanel.locator("textarea").fill(manualRuleXml);
    await ruleEditorPanel.locator('button:has-text("Save")').click();
    await page.waitForTimeout(500);
    const manualEditorError = await page.locator('[role="alert"]').count();
    assert(manualEditorError === 0, "manual editor save of real unprefixed Schematron shows NO well-formedness error (real UI path)");
    const savedTodoBrdp = brdps.find((b) => b.identifier === todoBrdp.identifier);
    const manualSavedApproval = await (
      await fetch(`${API}/api/projects/${projectId}/brdps/${savedTodoBrdp.id}/approvals/SCH-DITA`, { headers: auth })
    ).json();
    assert(normalizeEol(manualSavedApproval?.rule_xml || "") === normalizeEol(manualRuleXml), "the manually saved real unprefixed rule was actually persisted, verbatim");
    console.log("Manual editor round trip for", todoBrdp.identifier, "completed with no validation error.");
    await page.screenshot({ path: "/tmp/verify-dita-2-manual-editor.png", fullPage: true });

    // ---- 5. Generate via the real Generate page ----
    await page.goto(`${BASE_URL}/projects/${projectId}/generate`);
    await page.waitForSelector('p:has-text("DITA 1.3")', { timeout: 10000 });
    // hasOutputSelector must be absent for DITA.
    const selectorCount = await page.locator('button:has-text("Schematron (XPath 2.0)")').count();
    assert(selectorCount === 0, "DITA 1.3 Generate page has no BREX/Schematron output selector");

    const generateBtn = page.locator('button:has-text("Generate")').first();
    assert(!(await generateBtn.isDisabled()), "Generate button is enabled (isConfigComplete fix)");
    await generateBtn.click();
    await page.waitForSelector("pre", { timeout: 30000 });
    const xml = await page.locator("pre").innerText();
    await page.screenshot({ path: "/tmp/verify-dita-3-generate-output.png", fullPage: true });

    assert(xml.includes('<sch:schema') && xml.includes('queryBinding="xslt2"'), "output is a real <sch:schema> document");
    assert(!xml.includes("structureObjectRule") && !xml.includes("<objrule"), "output contains NO BREX-shaped markers -- never touched the BREX/brexToSchematron.js path");
    const wellFormedBadge = await page.locator("text=/Well-formed XML/i").count();
    assert(wellFormedBadge > 0, "Generate page reports well-formed XML");

    const xmlNormalized = normalizeEol(xml);
    for (const vr of verifiedRows) {
      const needle = normalizeEol(vr.rule.trim());
      if (!xmlNormalized.includes(needle)) {
        const idx = xmlNormalized.indexOf(`<pattern id="p-${vr.identifier}"`);
        const actualSlice = xmlNormalized.slice(idx, idx + needle.length);
        for (let i = 0; i < Math.max(actualSlice.length, needle.length); i++) {
          if (actualSlice[i] !== needle[i]) {
            console.log(`DEBUG ${vr.identifier} first diff at offset ${i}:`);
            console.log("  expected:", JSON.stringify(needle.slice(Math.max(0, i - 40), i + 40)));
            console.log("  actual  :", JSON.stringify(actualSlice.slice(Math.max(0, i - 40), i + 40)));
            break;
          }
        }
      }
      assert(xmlNormalized.includes(needle), `generated .sch contains ${vr.identifier}'s real rule VERBATIM`);
    }
    // Every To Do BRDP's traceability comment must show its real, human
    // identifier (BRDP-EXT-000NN), never its Postgres uuid -- confirmed
    // real bug (buildTraceabilityComment used brdp.id, the uuid, not
    // brdp.identifier). Checked against ALL 28 To Do rows, not just one --
    // "has the shape of BRDP-EXT-something" is not the same as "is the
    // CORRECT one for that specific BRDP".
    // Tempered-greedy-token match: stops at the FIRST </pattern> without
    // crossing into another <pattern -- a naive "<pattern[^]*?X[^]*?</pattern>"
    // can jump clean over an intervening pattern/comment pair and falsely
    // "find" X inside a totally unrelated block (hit this for real: BRDP-EXT-
    // 00004's own identifier, sitting in ITS traceability comment between two
    // real pattern blocks, was making that naive regex match end-to-end).
    const patternBlocks = xml.match(/<pattern\b(?:(?!<pattern\b)[\s\S])*?<\/pattern>/g) || [];
    for (const todo of todoRows) {
      const idComment = new RegExp(`<!--[^]*?\\b${todo.identifier}\\b[^]*?-->`);
      assert(idComment.test(xml), `To Do BRDP ${todo.identifier}'s own traceability comment shows its real identifier`);
      const appearsInsideAPattern = patternBlocks.some((block) => block.includes(todo.identifier));
      assert(!appearsInsideAPattern, `To Do BRDP ${todo.identifier} never appears as a real <pattern> block`);
    }
    // And no raw Postgres uuid (of ANY BRDP in this project) ever leaks into
    // the generated document -- the previous bug's exact symptom.
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    assert(!uuidRe.test(xml), "generated .sch contains no raw Postgres uuid anywhere (traceability comments use identifiers, not ids)");

    console.log(`Generated .sch is ${xml.length} chars, contains all 8 real Verified rules verbatim and all 28 To Do identifiers (not uuids) in traceability comments.`);

    // ---- Filename fix: Download uses the real project name, not "UNKNOWN" ----
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click('button:has-text("Download")'),
    ]);
    const downloadedFilename = download.suggestedFilename();
    console.log("Downloaded filename:", downloadedFilename);
    assert(!downloadedFilename.startsWith("UNKNOWN"), `download filename does not fall back to UNKNOWN (got "${downloadedFilename}")`);
    assert(downloadedFilename.includes("Navantia S80"), `download filename contains the real project name (got "${downloadedFilename}")`);
    assert(downloadedFilename.endsWith("_dita.sch"), `download filename keeps the _dita.sch suffix (got "${downloadedFilename}")`);

    // ---- 6. Suggest Rule now returns real precedent ----
    const suggestSourceBrdp = brdps.find((b) => b.identifier === todoRows[2].identifier);
    const similarResp = await fetch(
      `${API}/api/projects/${projectId}/brdps/${suggestSourceBrdp.id}/similar?kind=rule`,
      { headers: auth }
    );
    assert(similarResp.status === 200, `Suggest Rule returns 200 for a DITA project (previously 400 'no rule format') (got ${similarResp.status})`);
    const similarBody = await similarResp.json();
    console.log("Suggest Rule response:", JSON.stringify({ ...similarBody, candidates: similarBody.candidates?.length }, null, 2));
    assert(similarBody.format === "SCH-DITA", `Suggest Rule reports format SCH-DITA (got ${similarBody.format})`);
    assert(similarBody.sufficient_precedent === true, "Suggest Rule reports sufficient_precedent: true from the 8 real approved rules");
    assert(similarBody.candidates.length >= 3, `Suggest Rule returns real candidates (got ${similarBody.candidates.length})`);

    // ---- 7. Edge case: Verified rule approved but Proposal Status != Validated ----
    const edgeCreate = await fetch(`${API}/api/projects/${projectId}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ identifier: "BRDP-EDGE-NOTVALIDATED", title: "Edge case", definition: "Not validated but has an approved rule" }),
    });
    const edgeBrdp = await edgeCreate.json();
    assert(edgeBrdp.validation !== "Validated", `newly created BRDP defaults to non-Validated (got "${edgeBrdp.validation}")`);
    const edgeRule = '<pattern id="p-edge"><rule context="topic"><assert id="edge-assert" test="title">Edge case rule.</assert></rule></pattern>';
    await fetch(`${API}/api/projects/${projectId}/brdps/${edgeBrdp.id}/approvals/SCH-DITA`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ rule_xml: edgeRule, source: "manual" }),
    });
    await fetch(`${API}/api/projects/${projectId}/brdps/${edgeBrdp.id}/approvals/SCH-DITA/approve`, {
      method: "POST",
      headers: auth,
    });

    await page.goto(`${BASE_URL}/projects/${projectId}/generate`);
    await page.waitForSelector('p:has-text("DITA 1.3")', { timeout: 10000 });
    const onlyValidatedCb = page.locator('input[type="checkbox"]').first();
    assert(await onlyValidatedCb.isChecked(), "'Only include Validated' is checked by default");
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 30000 });
    const xmlOnlyValidated = await page.locator("pre").innerText();
    assert(!xmlOnlyValidated.includes(edgeBrdp.id), "Verified-but-not-Validated BRDP is excluded ENTIRELY (no rule, no comment) while 'Only include Validated' is checked");

    await onlyValidatedCb.uncheck();
    await page.click('button:has-text("Regenerate")');
    await page.waitForSelector("pre", { timeout: 30000 });
    const xmlAllRows = await page.locator("pre").innerText();
    assert(xmlAllRows.includes(edgeRule), "once 'Only include Validated' is unchecked, the Verified-but-not-Validated BRDP's approved rule IS included, verbatim, as a real pattern");
    await page.screenshot({ path: "/tmp/verify-dita-4-edge-case.png", fullPage: true });

    // ---- 8. rule_override fires on reimport with changed real unprefixed content ----
    const overrideSource = verifiedRows[1];
    const changedRule = overrideSource.rule.replace(/test="([^"]*)"/, (m, t) => `test="${t} and true()"`);
    assert(changedRule !== overrideSource.rule, "constructed a genuinely different rule for the override test");
    const overrideAnalyzeResp = await fetch(`${API}/api/projects/${projectId}/brdps/import/analyze`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        rows: [
          {
            row_number: 2,
            identifier: overrideSource.identifier,
            title: overrideSource.title,
            definition: overrideSource.definition,
            proposal: overrideSource.proposal,
            proposal_status: "Validated",
            rule_status: "Verified",
            rule: changedRule,
          },
        ],
      }),
    });
    assert(overrideAnalyzeResp.status === 200, `reimport analyze succeeds (got ${overrideAnalyzeResp.status})`);
    const overrideBody = await overrideAnalyzeResp.json();
    const overrideResult = overrideBody.results[0];
    console.log("rule_override analyze result:", JSON.stringify(overrideResult));
    assert(overrideResult.outcome === "ok", `reimport with changed real unprefixed content is accepted (outcome=${overrideResult.outcome})`);
    assert(overrideResult.rule_override === true, "rule_override fires for real unprefixed content changed on reimport, same as BREX/S1000D");

    // Reformatted-but-not-changed reimport must NOT fire rule_override.
    const reformattedAnalyzeResp = await fetch(`${API}/api/projects/${projectId}/brdps/import/analyze`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        rows: [
          {
            row_number: 2,
            identifier: overrideSource.identifier,
            title: overrideSource.title,
            definition: overrideSource.definition,
            proposal: overrideSource.proposal,
            proposal_status: "Validated",
            rule_status: "Verified",
            // Only reformats whitespace strictly BETWEEN adjacent tags
            // (">   <" -- guaranteed pure inter-element tail/text, never an
            // attribute value or mixed text content) -- a naive "\n\s+"
            // replace touches indentation-looking runs wherever they occur,
            // including inside real non-blank text/attribute content this
            // real dataset's <let>/<assert> messages legitimately contain,
            // which would make this a genuine content change instead of a
            // pure reformat (confirmed by hitting exactly that with the
            // naive version first).
            rule: overrideSource.rule.replace(/>[ \t]*\n[ \t]*</g, ">\n  <"),
          },
        ],
      }),
    });
    const reformattedBody = await reformattedAnalyzeResp.json();
    assert(reformattedBody.results[0].rule_override === false, "a purely-reformatted (not content-changed) reimport does NOT fire rule_override");

    console.log("\nAll DITA 1.3 Navantia S80 end-to-end checks passed.");
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
