// Live verification of every Excel path of the v2 app. Excel files are read
// and written by the backend (app/services/excel_io.py, openpyxl) --
// SheetJS (xlsx) is no longer in the project, and this script checks that
// too. Files are read back here with backend/scripts/read_template.py
// (scripts/lib/readXlsx.mjs), the same reading as the import.
//   0. Own minimal case (S1000D 4.2): a rule with &lt;x&gt;, a bare &gt;,
//      character references (&#237;), several lines and both quotes, plus a
//      multi-line Definition -- imported through the page, stored exactly,
//      exported exactly, re-imported unchanged. (SheetJS 0.20.3 altered
//      these on export and then rejected the rules with &lt;.)
//   1. Import a real Excel file: the five curated templates of public/
//      (made in Excel by the project) through the real Project
//      Configuration import (parse + analyze + apply): 10 BRDPs, 10 rules
//      approved under the standard's format, 0 rejected.
//   2. Export (Project Configuration's "Export to Excel"): every cell of
//      the downloaded file must be exactly what the API stores AND exactly
//      the cell of the template it was imported from (ID, Title,
//      Definition, Proposal, Proposal Status, Rule Status, Rule -- the
//      multi-line rule XML byte for byte).
//   3. Round trip: the exported file imported again into the same project is
//      analysed as 10 rows unchanged, 0 rejected, no rule override.
//   4. Download template: the curated file is served byte for byte; for a
//      standard without one (S1000D 5.0) the generic template the backend
//      builds downloads, has the import columns and imports with 0
//      rejected. A file that is not an .xlsx is refused with its reason and
//      nothing is imported.
//
// Preconditions: uvicorn on 8000, Vite on 5173 (no LLM involved). Cleans up
// the projects it creates.
//
// User: PROMPT_EVAL_EMAIL / PROMPT_EVAL_PASSWORD (the same variables as the
// prompt eval), or the dev seed admin (admin@example.com) when they are not
// set. The user must be able to create and delete projects, i.e. have the
// global role admin, and must not be waiting to change its password.
//
//     node scripts/verify-xlsx-roundtrip.mjs
//     PROMPT_EVAL_EMAIL=me@example.com PROMPT_EVAL_PASSWORD=... node scripts/verify-xlsx-roundtrip.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { readXlsxRows } from "./lib/readXlsx.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
// fileURLToPath, not URL.pathname: on Windows .pathname gives "/C:/...".
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const CURATED = {
  "S1000D 3.0.1": ["brdp-template-3-0-1.xlsx", "BREX-3.0.1"],
  "S1000D 4.1": ["brdp-template-4-1.xlsx", "BREX-4.1"],
  "S1000D 4.2": ["brdp-template-4-2.xlsx", "BREX-4.2"],
  "DITA 1.3 Xpath2.0": ["brdp-template-dita-xpath2.xlsx", "SCH-DITA"],
  "DITA 1.3 Xpath3.0": ["brdp-template-dita-xpath3.xlsx", "SCH-DITA"],
};
const EXPORT_COLUMNS = ["ID", "Title", "Definition", "Proposal", "Proposal Status", "Rule Status", "Rule"];
// Informative export column ("S1000D 4.1" for an identifier only in another
// edition's catalog); the import ignores it.
const EXPORTED_COLUMNS = [...EXPORT_COLUMNS, "Catalog Edition"];
const RULE_STATUS = { approved: "Verified", pending_review: "Draft" };

let failures = 0;
function assert(condition, message, detail = "") {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ""}`);
  }
}

function readSheet(file) {
  const rows = readXlsxRows(file);
  return { rows, header: rows.length ? Object.keys(rows[0]) : [] };
}

// The own minimal case: everything SheetJS 0.20.3 altered.
// Text that looks like a formula ("=", "+", "-", "@" at the start):
// openpyxl used to write "=…" as a formula, which came back empty on
// reimport and would run when the export is opened in Excel. Only the
// free-text fields (the statuses must be real values to import).
const FORMULA_ROW = {
  id: "BRDP-XL-00002",
  title: "=1+1",
  definition: '=HYPERLINK("http://x","y")',
  proposal: "+x -y @z",
  proposalStatus: "Validated",
  ruleStatus: "To Do",
  rule: "",
};

const ENTITY_ROW = {
  id: "BRDP-XL-00001",
  title: 'Entities "double" and \'single\' quotes',
  definition: "Line one\nLine two with &amp; and <b>\n\nLine four",
  proposal: "Keep &lt;parameter&gt; as written.",
  proposalStatus: "Validated",
  ruleStatus: "Verified",
  rule: [
    '<structureObjectRule id="BRDP-XL-00001">',
    "  <objectPath allowedObjectFlag=\"0\">//para[. = '&lt;x&gt;' or . = 'a &gt; b']</objectPath>",
    "  <objectUse>No &lt;parameter&gt; element, a &gt; b, acci&#243;n con tilde (&#237;), \"comillas\" y 'simples'.</objectUse>",
    "</structureObjectRule>",
  ].join("\n"),
};

async function main() {
  assert(!fs.existsSync(new URL("../node_modules/xlsx", import.meta.url)), "SheetJS (xlsx) is not installed in node_modules");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert(!pkg.dependencies?.xlsx && !pkg.devDependencies?.xlsx, "xlsx is not in package.json");
  console.log(`user: ${ADMIN_EMAIL}`);
  const loginResponse = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const loginBody = await loginResponse.json().catch(() => ({}));
  if (!loginResponse.ok || !loginBody.access_token) {
    const detail = typeof loginBody.detail === "string" ? loginBody.detail : JSON.stringify(loginBody.detail ?? loginBody);
    throw new Error(
      `login failed for ${ADMIN_EMAIL} (HTTP ${loginResponse.status}: ${detail}). ` +
        "Set PROMPT_EVAL_EMAIL / PROMPT_EVAL_PASSWORD to an existing user with the global role admin."
    );
  }
  const token = loginBody.access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const me = await api("/api/auth/me").then((r) => r.json());
  if (me.global_role !== "admin") {
    throw new Error(`${ADMIN_EMAIL} cannot create projects: its global role is "${me.global_role}", it must be "admin".`);
  }
  if (me.must_change_password) {
    throw new Error(`${ADMIN_EMAIL} must change its password first: log in once in the app and change it.`);
  }
  const suffix = Math.random().toString(36).slice(2, 8);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-roundtrip-"));
  const projects = [];
  const newProject = async (standard) => {
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `xlsx ${standard} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(project.id);
    return project;
  };

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const openConfig = async (project) => {
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });
  };
  const download = async (buttonText, target) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click(`button:has-text("${buttonText}")`)]);
    await dl.saveAs(target);
    return dl.suggestedFilename();
  };
  // Picks a file in the import section and waits for the analysis summary.
  const analyse = async (file) => {
    // A finished import job's panel takes the section's place until closed.
    const close = page.locator('button:has-text("Close")');
    if (await close.count()) await close.first().click();
    await page.locator('input[type="file"][accept=".xlsx"]').setInputFiles(file);
    await page.waitForSelector('button:has-text("Apply import")', { timeout: 20000 });
    return page.locator("body").innerText();
  };
  const apply = async () => {
    await page.click('button:has-text("Apply import")');
    await page.waitForSelector("text=Import complete", { timeout: 60000 });
    const text = await page.locator("ul").filter({ hasText: /created|updated|rejected/i }).first().innerText();
    await page.click('button:has-text("Close")').catch(() => {});
    return text;
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    try {
      await page.waitForSelector("table", { timeout: 10000 });
    } catch {
      throw new Error(`login failed for ${ADMIN_EMAIL} in the browser (the project list never appeared at ${BASE_URL})`);
    }
    await page.locator("header select, nav select").first().selectOption("en");

    // 0. Own minimal case. The input file is written by the export endpoint.
    console.log("\nOwn case: entities, line breaks, quotes (S1000D 4.2)");
    {
      const project = await newProject("S1000D 4.2");
      const input = path.join(tmp, "entities-input.xlsx");
      const res = await api(`/api/projects/${project.id}/export.xlsx`, { method: "POST", body: JSON.stringify({ rows: [ENTITY_ROW] }) });
      assert(res.ok, `input file written (HTTP ${res.status})`);
      fs.writeFileSync(input, Buffer.from(await res.arrayBuffer()));
      await openConfig(project);
      const analysis = await analyse(input);
      assert(analysis.includes("1 row ready to import"), "import: 1 row ready", analysis.match(/\d+ rows? [a-z ]+/g)?.join(" | "));
      assert(!/rows? rejected/.test(analysis) || /\b0 rows rejected/.test(analysis), "import: not rejected");
      await apply();
      const [brdp] = await api(`/api/projects/${project.id}/brdps`).then((r) => r.json());
      const approval = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`).then((r) => r.json());
      assert(approval.rule_xml === ENTITY_ROW.rule, "stored rule identical (&lt;x&gt;, &gt;, &#237;, lines, quotes)", JSON.stringify(approval.rule_xml));
      assert(brdp.definition === ENTITY_ROW.definition, "stored Definition identical (\\n kept, no \\r, no _x000D_)", JSON.stringify(brdp.definition));
      assert(brdp.title === ENTITY_ROW.title && brdp.proposal === ENTITY_ROW.proposal, "stored Title and Proposal identical");
      const exportPath = path.join(tmp, "entities-export.xlsx");
      await openConfig(project);
      await download("Export to Excel", exportPath);
      const [row] = readSheet(exportPath).rows;
      const sent = { ID: ENTITY_ROW.id, Title: ENTITY_ROW.title, Definition: ENTITY_ROW.definition, Proposal: ENTITY_ROW.proposal, "Proposal Status": "Validated", "Rule Status": "Verified", Rule: ENTITY_ROW.rule };
      const diffs = Object.entries(sent).filter(([col, value]) => row[col] !== value).map(([col]) => col);
      assert(diffs.length === 0, "export: every cell identical to what was imported", diffs.join(", "));
      assert(!/_x000d_|\r/i.test(Object.values(row).join("")), "export: no _x000D_ and no \\r added");
      await openConfig(project);
      const again = await analyse(exportPath);
      assert(again.includes("1 row unchanged"), "re-import: unchanged", again.match(/\d+ rows? [a-z ()]+/g)?.join(" | "));
      assert(!/rows? rejected/.test(again) || /\b0 rows rejected/.test(again), "re-import: the rule with &lt; is not rejected");
      assert(!/replace an existing Rule|will replace the Rule/i.test(again), "re-import: no rule override");

      // A cell over Excel's 32,767-character limit: the export is refused
      // with the BRDP and the field, nothing downloaded, nothing cut.
      const big = await api(`/api/projects/${project.id}/brdps`, {
        method: "POST",
        body: JSON.stringify({ identifier: "BRDP-XL-BIG", title: "Big", definition: "d", proposal: "p", validation: "Validated" }),
      }).then((r) => r.json());
      const longRule = `<structureObjectRule id="BRDP-XL-BIG"><objectPath allowedObjectFlag="0">//para</objectPath><objectUse>${"x".repeat(33000)}</objectUse></structureObjectRule>`;
      const put = await api(`/api/projects/${project.id}/brdps/${big.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: longRule, source: "manual" }) });
      assert(put.ok, `a ${longRule.length}-character rule is stored (HTTP ${put.status})`);
      await openConfig(project);
      let downloaded = false;
      page.once("download", () => { downloaded = true; });
      await page.click('button:has-text("Export to Excel")');
      await page.waitForSelector("text=cannot be exported", { timeout: 20000 });
      const refusedText = await page.locator("body").innerText();
      assert(refusedText.includes("BRDP-XL-BIG (Rule column)"), "export refused naming the BRDP and the field: BRDP-XL-BIG (Rule column)");
      await page.waitForTimeout(500);
      assert(!downloaded, "no file downloaded");
      await page.screenshot({ path: path.join(os.tmpdir(), "xlsx-export-cell-too-large.png") });
    }

    // 0b. Text that looks like a formula: stays text end to end.
    console.log("\nOwn case: text that looks like a formula (S1000D 4.2)");
    {
      const project = await newProject("S1000D 4.2");
      const input = path.join(tmp, "formula-input.xlsx");
      const res = await api(`/api/projects/${project.id}/export.xlsx`, { method: "POST", body: JSON.stringify({ rows: [FORMULA_ROW] }) });
      assert(res.ok, `input file written (HTTP ${res.status})`);
      fs.writeFileSync(input, Buffer.from(await res.arrayBuffer()));
      const [written] = readSheet(input).rows;
      assert(written.Title === "=1+1" && written.Definition === FORMULA_ROW.definition, "the written file keeps the text (not an empty formula)", JSON.stringify(written));
      await openConfig(project);
      const analysis = await analyse(input);
      assert(analysis.includes("1 row ready to import"), "import: 1 row ready", analysis.match(/\d+ rows? [a-z ]+/g)?.join(" | "));
      await apply();
      const [brdp] = await api(`/api/projects/${project.id}/brdps`).then((r) => r.json());
      assert(
        brdp.title === FORMULA_ROW.title && brdp.definition === FORMULA_ROW.definition && brdp.proposal === FORMULA_ROW.proposal,
        'stored as text: "=1+1", "=HYPERLINK(…)", "+x -y @z"',
        JSON.stringify({ title: brdp.title, definition: brdp.definition, proposal: brdp.proposal })
      );
      const exportPath = path.join(tmp, "formula-export.xlsx");
      await openConfig(project);
      await download("Export to Excel", exportPath);
      const [row] = readSheet(exportPath).rows;
      assert(
        row.Title === FORMULA_ROW.title && row.Definition === FORMULA_ROW.definition && row.Proposal === FORMULA_ROW.proposal,
        "export: the same text in every cell",
        JSON.stringify(row)
      );
      await openConfig(project);
      const again = await analyse(exportPath);
      assert(again.includes("1 row unchanged"), "re-import: unchanged", again.match(/\d+ rows? [a-z ()]+/g)?.join(" | "));
    }

    for (const [standard, [file, format]] of Object.entries(CURATED)) {
      console.log(`\n${standard}`);
      const project = await newProject(standard);
      await openConfig(project);

      // 4. Template: the curated file, byte for byte.
      const templatePath = path.join(tmp, `template-${format}-${standard.length}.xlsx`);
      const templateName = await download("Download Excel template", templatePath);
      assert(templateName === file, `template: ${templateName}`);
      assert(Buffer.compare(fs.readFileSync(templatePath), fs.readFileSync(path.join(PUBLIC_DIR, file))) === 0, "template: identical to public/" + file);

      // 1. Import the real Excel file.
      const analysis = await analyse(path.join(PUBLIC_DIR, file));
      assert(analysis.includes("10 rows ready to import"), "import: 10 rows ready", analysis.match(/\d+ rows? [a-z ]+/g)?.join(" | "));
      assert(!/rows? rejected/.test(analysis) || /\b0 rows rejected/.test(analysis), "import: no row rejected");
      const result = await apply();
      assert(/10 BRDPs created/i.test(result), `import applied (${result.replace(/\n/g, " | ")})`);
      const brdps = await api(`/api/projects/${project.id}/brdps`).then((r) => r.json());
      const approvals = await api(`/api/projects/${project.id}/approvals/${format}/export`).then((r) => r.json());
      assert(brdps.length === 10, `10 BRDPs stored (${brdps.length})`);
      assert(approvals.filter((a) => a.status === "approved").length === 10, `10 rules approved under ${format}`);

      // 2. Export, read back, compare every cell with what the API stores.
      const exportPath = path.join(tmp, `export-${format}-${standard.length}.xlsx`);
      const exportName = await download("Export to Excel", exportPath);
      assert(exportName === "brdps-export.xlsx", `export: ${exportName}`);
      const { rows, header } = readSheet(exportPath);
      assert(JSON.stringify(header) === JSON.stringify(EXPORTED_COLUMNS), `export: columns ${header.join(", ")}`);
      assert(rows.length === 10, `export: 10 rows (${rows.length})`);
      const approvalByBrdp = Object.fromEntries(approvals.map((a) => [a.brdp_id, a]));
      const mismatches = [];
      for (const b of brdps) {
        const row = rows.find((r) => r.ID === b.identifier);
        if (!row) {
          mismatches.push(`${b.identifier}: missing`);
          continue;
        }
        const a = approvalByBrdp[b.id];
        const expected = { Title: b.title, Definition: b.definition, Proposal: b.proposal, "Proposal Status": b.validation, "Rule Status": a ? RULE_STATUS[a.status] : "To Do", Rule: a?.rule_xml || "", "Catalog Edition": b.catalog_edition || "" };
        for (const [col, value] of Object.entries(expected)) if (String(row[col]) !== value) mismatches.push(`${b.identifier} ${col}: ${JSON.stringify(String(row[col]).slice(0, 60))} != ${JSON.stringify(value.slice(0, 60))}`);
      }
      assert(mismatches.length === 0, "export: every cell equals the stored value (multi-line rules included)", mismatches.slice(0, 5).join("\n       "));
      const templateRows = readXlsxRows(path.join(PUBLIC_DIR, file));
      const templateDiffs = [];
      for (const t of templateRows) {
        const row = rows.find((r) => r.ID === t.ID);
        for (const col of EXPORT_COLUMNS) if (!row || row[col] !== t[col]) templateDiffs.push(`${t.ID} ${col}`);
      }
      assert(templateDiffs.length === 0, "export: every cell byte for byte the cell of the template it came from", templateDiffs.slice(0, 5).join(", "));
      assert(rows.some((r) => String(r.Rule).includes("\n")), "export: at least one multi-line rule survived the round trip");

      // 3. Round trip: re-import the exported file.
      await openConfig(project);
      const again = await analyse(exportPath);
      assert(again.includes("10 rows unchanged"), "re-import of the export: 10 rows unchanged", again.match(/\d+ rows? [a-z ()]+/g)?.join(" | "));
      assert(!/rows? rejected/.test(again) || /\b0 rows rejected/.test(again), "re-import of the export: no row rejected");
      assert(!/replace an existing Rule|will replace the Rule/i.test(again), "re-import of the export: no rule override");
    }

    // 4. Generic template (no curated file): built by the backend
    // (GET /api/brdp-template.xlsx).
    console.log("\nS1000D 5.0 (generic template)");
    const generic = await newProject("S1000D 5.0");
    await openConfig(generic);
    const genericPath = path.join(tmp, "generic-template.xlsx");
    const genericName = await download("Download Excel template", genericPath);
    assert(genericName === "brdp-template.xlsx", `generic template: ${genericName}`);
    const { rows: gRows, header: gHeader } = readSheet(genericPath);
    assert(EXPORT_COLUMNS.every((c) => gHeader.includes(c)), `generic template: import columns (${gHeader.join(", ")})`);
    assert(gRows.length > 0, `generic template: ${gRows.length} example rows`);
    const genericAnalysis = await analyse(genericPath);
    assert(genericAnalysis.includes(`${gRows.length} row${gRows.length === 1 ? "" : "s"} ready to import`), `generic template imports: ${gRows.length} rows ready`, genericAnalysis.match(/\d+ rows? [a-z ]+/g)?.join(" | "));
    assert(!/rows? rejected/.test(genericAnalysis) || /\b0 rows rejected/.test(genericAnalysis), "generic template: no row rejected");
    assert(gRows.every((r) => r["Rule Status"] === "To Do" && r.Rule === ""), "generic template: Rule Status To Do and an empty Rule on every row");

    // A file that is not an .xlsx: refused with its reason, nothing imported.
    console.log("\nA file that is not an .xlsx");
    await openConfig(generic);
    const fake = path.join(tmp, "not-a-workbook.xlsx");
    fs.writeFileSync(fake, "ID,Title\nBRDP-X,y\n");
    await page.locator('input[type="file"][accept=".xlsx"]').setInputFiles(fake);
    await page.waitForSelector("text=not an .xlsx workbook", { timeout: 10000 }).catch(() => {});
    const refused = await page.locator("body").innerText();
    assert(refused.includes("The file is not an .xlsx workbook"), "the page shows the reason from the server (422)");
    assert(!refused.includes("Apply import"), "nothing to apply");
    const genericBrdps = await api(`/api/projects/${generic.id}/brdps`).then((r) => r.json());
    assert(genericBrdps.length === 0, `nothing imported (${genericBrdps.length} BRDPs)`);
  } finally {
    await browser.close();
    for (const id of projects) await api(`/api/projects/${id}?permanent=true`, { method: "DELETE" }).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
