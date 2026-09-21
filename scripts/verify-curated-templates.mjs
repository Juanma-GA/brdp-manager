// Ad hoc Playwright end-to-end verification (real Chromium, real Vite dev
// server, real backend, real Postgres) of the "Download Excel template"
// button now serving a real, curated per-standard template instead of the
// generic mock-BRDP one.
//
// Verifies:
//   1. For each of the 5 standards with a curated file (S1000D 3.0.1/4.1/
//      4.2, DITA 1.3 Xpath2.0/Xpath3.0), clicking "Download Excel template"
//      downloads the real curated file (correct filename, 10 rows, Rule
//      column populated -- not the generic empty-Rule mock).
//   2. S1000D 5.0/6.0 (no curated file, no generation engine) still
//      downloads the OLD generic template unchanged (fallback intact).
//   3. At least one downloaded curated template, reimported as-is into a
//      fresh project of the SAME standard, imports clean: 0 rejected.
//
// Usage: node scripts/verify-curated-templates.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as XLSX from "xlsx";

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

const CURATED = {
  "S1000D 3.0.1": "brdp-template-3-0-1.xlsx",
  "S1000D 4.1": "brdp-template-4-1.xlsx",
  "S1000D 4.2": "brdp-template-4-2.xlsx",
  "DITA 1.3 Xpath2.0": "brdp-template-dita-xpath2.xlsx",
  "DITA 1.3 Xpath3.0": "brdp-template-dita-xpath3.xlsx",
};

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser console error]", msg.text());
  });

  const auth = await apiLogin();
  const createdProjectIds = [];
  const downloadedPaths = {};

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });

    const suffix = Math.random().toString(36).slice(2, 8);

    // ---- 1. Each of the 5 curated standards downloads the real file ----
    for (const [standard, expectedFilename] of Object.entries(CURATED)) {
      const projectName = `Template Test ${standard} ${suffix}`;
      const createResp = await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: projectName, standard }),
      });
      if (!createResp.ok) throw new Error(`Project create failed for ${standard}: ${createResp.status} ${await createResp.text()}`);
      const project = await createResp.json();
      createdProjectIds.push(project.id);

      await page.goto(`${BASE_URL}/projects/${project.id}/config`);
      await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click('button:has-text("Download Excel template")'),
      ]);
      const filename = download.suggestedFilename();
      assert(filename === expectedFilename, `${standard}: downloaded filename is the real curated file (got "${filename}", expected "${expectedFilename}")`);

      const savePath = path.join(os.tmpdir(), `verify-template-${standard.replace(/[^a-z0-9]/gi, "_")}.xlsx`);
      await download.saveAs(savePath);
      await page.screenshot({ path: `/tmp/verify-template-download-${standard.replace(/[^a-z0-9]/gi, "_")}.png`, fullPage: true });
      downloadedPaths[standard] = savePath;

      const buf = fs.readFileSync(savePath);
      assert(buf.length > 2000, `${standard}: downloaded file is a real, non-trivial xlsx (${buf.length} bytes)`);

      // Direct content check, not just byte size: 10 rows, every Rule cell
      // populated (not the generic template's empty Rule), Rule Status
      // Verified throughout.
      const wb = XLSX.read(buf, { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      assert(rows.length === 10, `${standard}: downloaded file has 10 real rows (got ${rows.length})`);
      const emptyRuleRows = rows.filter((r) => !r["Rule"] || String(r["Rule"]).trim() === "");
      assert(emptyRuleRows.length === 0, `${standard}: every row's Rule column is populated, none empty (got ${emptyRuleRows.length} empty)`);
      const nonVerified = rows.filter((r) => r["Rule Status"] !== "Verified");
      assert(nonVerified.length === 0, `${standard}: every row is Rule Status "Verified" (got ${nonVerified.length} not Verified)`);
      console.log(`  ${standard} real ids:`, rows.map((r) => r["ID"]).join(", "));
    }

    // ---- 2. S1000D 5.0/6.0 still get the OLD generic template ----
    for (const standard of ["S1000D 5.0", "S1000D 6.0"]) {
      const projectName = `Template Test ${standard} ${suffix}`;
      const createResp = await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: projectName, standard }),
      });
      if (!createResp.ok) throw new Error(`Project create failed for ${standard}: ${createResp.status} ${await createResp.text()}`);
      const project = await createResp.json();
      createdProjectIds.push(project.id);

      await page.goto(`${BASE_URL}/projects/${project.id}/config`);
      await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click('button:has-text("Download Excel template")'),
      ]);
      const filename = download.suggestedFilename();
      assert(filename === "brdp-template.xlsx", `${standard}: still downloads the generic fallback filename (got "${filename}")`);
    }

    // ---- 3. Reimport EVERY curated template into a fresh project of the same standard: 0 rejected ----
    // Exceeds the encargo's "at least one" -- verifying all 5 (not just
    // S1000D) confirms the DITA generators' own rule-format/approval path
    // (SCH-DITA) accepts these real files too, not only the BREX one.
    const RULE_FORMAT_BY_STANDARD = {
      "S1000D 3.0.1": "BREX-3.0.1",
      "S1000D 4.1": "BREX-4.1",
      "S1000D 4.2": "BREX-4.2",
      "DITA 1.3 Xpath2.0": "SCH-DITA",
      "DITA 1.3 Xpath3.0": "SCH-DITA",
    };
    for (const standard of Object.keys(CURATED)) {
      const format = RULE_FORMAT_BY_STANDARD[standard];
      const reimportProjectName = `Reimport Template Test ${standard} ${suffix}`;
      const createResp = await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: reimportProjectName, standard }),
      });
      if (!createResp.ok) throw new Error(`Project create failed: ${createResp.status} ${await createResp.text()}`);
      const reimportProject = await createResp.json();
      createdProjectIds.push(reimportProject.id);

      await page.goto(`${BASE_URL}/projects/${reimportProject.id}/config`);
      await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });
      await page.locator('input[type="file"]').setInputFiles(downloadedPaths[standard]);
      await page.waitForSelector('button:has-text("Apply import")', { timeout: 15000 });
      await page.click('button:has-text("Apply import")');
      const proceedBtn = page.locator('button:has-text("Proceed")');
      if (await proceedBtn.count()) await proceedBtn.click();
      await page.waitForSelector("text=Import complete", { timeout: 60000 });
      const resultText = await page
        .locator("ul")
        .filter({ hasText: /created|updated|rejected/i })
        .first()
        .innerText();
      console.log(`Reimport result (${standard}):`, resultText.replace(/\n/g, " | "));
      assert(/10 BRDPs created/i.test(resultText), `${standard}: reimporting the curated template creates all 10 real BRDPs`);
      assert(/0.*rejected/i.test(resultText), `${standard}: reimporting the curated template rejects 0 rows`);

      const brdpsResp = await fetch(`${API}/api/projects/${reimportProject.id}/brdps`, { headers: auth });
      const brdps = await brdpsResp.json();
      assert(brdps.length === 10, `${standard}: reimported project has 10 real BRDPs (got ${brdps.length})`);
      const approvalsResp = await fetch(`${API}/api/projects/${reimportProject.id}/approvals/${format}`, { headers: auth });
      const approvals = await approvalsResp.json();
      const approvedCount = approvals.filter((a) => a.status === "approved").length;
      assert(approvedCount === 10, `${standard}: all 10 rows' real Rule content was accepted and auto-approved (got ${approvedCount})`);
      await page.click('button:has-text("Close")').catch(() => {});
    }

    console.log("\nAll curated template checks passed.");
  } finally {
    for (const id of createdProjectIds) {
      await fetch(`${API}/api/projects/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log(`Cleaned up: deleted ${createdProjectIds.length} projects.`);
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
