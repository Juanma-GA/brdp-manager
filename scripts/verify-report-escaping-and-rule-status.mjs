// Verification for the "Generate Report" round: Part 1 (real HTML-escaping
// bug confirmed with a real Lufthansa report -- BRDP-S1-00123's Title
// literally contains "<table>", which broke out of its own <tr> when
// inserted via innerHTML without escaping) and Part 2 (Comment column
// replaced with Rule Status, reusing the exact palette from
// StatusCountsSummary). This sandbox doesn't have the user's real
// Lufthansa project, so this reproduces the exact reported defect with a
// small synthesized project: a BRDP whose Title contains a literal
// "<table>" (the confirmed trigger), one with "&" (the encargo's other
// named edge case), and BRDPs spanning all three Rule Status states.
import { chromium } from "playwright-core";
import fs from "fs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const PROJECT_NAME = "Report Escaping Verification (Lufthansa-like)";

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

  // ---- Seed a small real project reproducing the exact reported bug ----
  let project = await fetch(`${API}/api/projects`, { headers: auth })
    .then((r) => r.json())
    .then((list) => list.find((p) => p.name === PROJECT_NAME));
  if (!project) {
    project = await fetch(`${API}/api/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: PROJECT_NAME, standard: "S1000D 4.2" }),
    }).then((r) => r.json());
    console.log(`Created project ${PROJECT_NAME} (id=${project.id})`);
  } else {
    // wipe existing BRDPs for a clean rerun
    const existing = await fetch(`${API}/api/projects/${project.id}/brdps`, { headers: auth }).then((r) => r.json());
    for (const b of existing) {
      await fetch(`${API}/api/projects/${project.id}/brdps/${b.id}`, { method: "DELETE", headers: auth });
      await fetch(`${API}/api/trash/${b.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log(`Reusing project ${PROJECT_NAME} (id=${project.id}), wiped ${existing.length} old BRDPs`);
  }

  const seedRows = [
    {
      identifier: "BRDP-S1-00123",
      title:
        'A structure object rule shall be created to check the value of the attribute applicRefId of the element <table>.',
      definition: 'Definition text mentioning the element <table> and <graphic> too.',
      proposal: 'Proposal referencing <copyright> element usage.',
      validation: 'Validated',
      ruleState: 'verified',
    },
    {
      identifier: "BRDP-S1-00124",
      title: 'Tools & Equipment applicability rule',
      definition: 'Covers Tools & Equipment cross-references.',
      proposal: 'Proposal for Tools & Equipment.',
      validation: 'Validated',
      ruleState: 'draft',
    },
    {
      identifier: "BRDP-S1-00125",
      title: 'Plain rule with no special characters',
      definition: 'Plain definition.',
      proposal: 'Plain proposal.',
      validation: 'Pending',
      ruleState: 'todo',
    },
    {
      identifier: "BRDP-S1-00126",
      title: 'Rule mentioning a pipe | character for Markdown table safety',
      definition: 'Definition with a | pipe character too.',
      proposal: 'Proposal | with a pipe.',
      validation: 'Refused',
      ruleState: 'todo',
    },
  ];

  const createdIds = [];
  for (const row of seedRows) {
    const created = await fetch(`${API}/api/projects/${project.id}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        identifier: row.identifier,
        title: row.title,
        definition: row.definition,
        proposal: row.proposal,
        validation: row.validation,
      }),
    }).then((r) => r.json());
    createdIds.push(created.id);
    if (row.ruleState !== "todo") {
      await fetch(`${API}/api/projects/${project.id}/brdps/${created.id}/approvals/BREX-4.2`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({
          rule_xml: `<structureObjectRule id="${row.identifier}"><objectPath allowedObjectFlag="1">//dmodule</objectPath></structureObjectRule>`,
          source: "manual",
          status: "pending_review",
        }),
      });
      if (row.ruleState === "verified") {
        await fetch(`${API}/api/projects/${project.id}/brdps/${created.id}/approvals/BREX-4.2/approve`, {
          method: "POST",
          headers: auth,
        });
      }
    }
  }
  console.log(`Seeded ${createdIds.length} BRDPs (1 verified, 1 draft, 2 to-do; includes the real <table> case, an & case, and a | case)`);

  // ---- Real browser: navigate to Generate Report, download both formats ----
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en").catch(() => {});
    await page.waitForTimeout(300);

    const row = page.locator("tr", { hasText: PROJECT_NAME });
    await row.getByRole("button", { name: /Generate Report/i }).click();
    await page.waitForURL(/\/projects\/.+\/brexdoc/, { timeout: 10000 });
    await page.waitForSelector("text=/Total/i", { timeout: 15000 });
    await page.waitForTimeout(500);

    // HTML download
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator('input[type="radio"]').first().check().then(() => page.getByRole("button", { name: /Download \.html/i }).click()),
    ]);
    const htmlPath = "/tmp/brexdoc-report-verify.html";
    await download.saveAs(htmlPath);
    console.log("Downloaded HTML report to", htmlPath);

    // ---- Open the DOWNLOADED report itself in a fresh page and inspect real DOM ----
    const reportPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await reportPage.goto("file://" + htmlPath);
    await reportPage.waitForSelector("#brdp-tbody tr", { timeout: 10000 });

    const headerTexts = await reportPage.locator("thead th").allInnerTexts();
    console.log("Report table headers:", headerTexts);
    assert(headerTexts.includes("Rule Status"), "HTML report's table header shows 'Rule Status'");
    assert(!headerTexts.includes("Comment"), "HTML report's table header no longer shows 'Comment'");

    // BRDP-S1-00123's row must still be a real <tr> INSIDE tbody, with exactly
    // 6 <td> children (id/title/definition/proposal/status/ruleStatus) -- if
    // the <table> text broke out unescaped, the browser's error-correction
    // would have restructured this row (fewer/extra cells, or the row
    // wouldn't be a direct child of #brdp-tbody at all).
    const targetRow = reportPage.locator("tr", { hasText: "BRDP-S1-00123" });
    await targetRow.waitFor({ timeout: 5000 });
    const isDirectChildOfTbody = await targetRow.evaluate((el) => el.parentElement.id === "brdp-tbody");
    assert(isDirectChildOfTbody, "BRDP-S1-00123's row is still a direct child of #brdp-tbody (did NOT float outside the table)");
    const cellCount = await targetRow.locator("td").count();
    assert(cellCount === 6, `BRDP-S1-00123's row has exactly 6 real <td> cells (got ${cellCount}) -- not corrupted by an unclosed <table> tag`);

    const titleCellText = await targetRow.locator("td").nth(1).innerText();
    assert(titleCellText.includes("<table>"), `BRDP-S1-00123's Title cell shows the literal text "<table>" visibly (got: ${titleCellText.slice(0, 80)}...)`);
    // Confirm there's no REAL nested <table> element inside that cell (would
    // exist if the browser had parsed "<table>" as markup instead of text).
    const nestedTableCount = await targetRow.locator("td").nth(1).locator("table").count();
    assert(nestedTableCount === 0, "No real nested <table> element was created inside the Title cell (confirms it rendered as escaped text, not markup)");

    // Confirm the whole table structure is sane: exactly as many rows as
    // BRDPs seeded, all real <tr> children of #brdp-tbody.
    const tbodyRowCount = await reportPage.locator("#brdp-tbody > tr").count();
    assert(tbodyRowCount === seedRows.length, `#brdp-tbody has exactly ${seedRows.length} direct <tr> children (got ${tbodyRowCount}) -- no row escaped its container`);

    // "&" case
    const ampRow = reportPage.locator("tr", { hasText: "BRDP-S1-00124" });
    const ampTitleText = await ampRow.locator("td").nth(1).innerText();
    assert(ampTitleText === "Tools & Equipment applicability rule", `"&" renders correctly as a literal ampersand, not corrupted (got: "${ampTitleText}")`);

    // Rule Status column: verify each row's real, correct value + badge class
    const checks = [
      ["BRDP-S1-00123", "Verified", "badge-rule-verified"],
      ["BRDP-S1-00124", "Draft", "badge-rule-draft"],
      ["BRDP-S1-00125", "To Do", "badge-rule-todo"],
      ["BRDP-S1-00126", "To Do", "badge-rule-todo"],
    ];
    for (const [id, expectedLabel, expectedClass] of checks) {
      const r = reportPage.locator("tr", { hasText: id });
      const ruleCell = r.locator("td").nth(5);
      const text = await ruleCell.innerText();
      assert(text === expectedLabel, `${id}'s Rule Status cell shows "${expectedLabel}" (got "${text}")`);
      const hasClass = await ruleCell.locator(`.${expectedClass}`).count();
      assert(hasClass === 1, `${id}'s Rule Status badge uses the correct class .${expectedClass}`);
    }

    await reportPage.screenshot({ path: "/tmp/brexdoc-report-html-fixed.png", fullPage: true });

    // ---- Markdown download: confirm pipe-escaping keeps the table intact ----
    await page.locator('input[type="radio"]').nth(1).check();
    const [mdDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download \.md/i }).click(),
    ]);
    const mdPath = "/tmp/brexdoc-report-verify.md";
    await mdDownload.saveAs(mdPath);
    const mdContent = fs.readFileSync(mdPath, "utf-8");
    assert(mdContent.includes("| Rule Status |"), "Markdown report's table header shows 'Rule Status'");
    assert(!mdContent.includes("| Comment |"), "Markdown report's table header no longer shows 'Comment'");
    const pipeRow = mdContent.split("\n").find((l) => l.includes("BRDP-S1-00126"));
    console.log("Row with a literal pipe in its content:", pipeRow);
    const columnCount = pipeRow.split(/(?<!\\)\|/).length; // split on unescaped pipes only
    assert(columnCount === 8, `The row containing a literal "|" in Title/Definition/Proposal still splits into exactly 8 markdown columns (got ${columnCount}) -- the pipe was escaped, not left to break the table`);
    assert(pipeRow.includes("\\|"), "The literal pipe character was escaped as \\| in the Markdown output");

    console.log("\nALL CHECKS PASSED");
  } finally {
    // cleanup: delete the synthetic verification project
    await fetch(`${API}/api/projects/${project.id}`, { method: "DELETE", headers: auth });
    console.log("Cleaned up verification project.");
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
