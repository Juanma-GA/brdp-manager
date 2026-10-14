// Live verification of "Project Configuration: importar Excel no debe mostrar
// "Exportando…"" against the real app (Vite + FastAPI + Postgres); no LLM.
//
// The responses are held with page.route so the intermediate states are on
// screen while the checks run. In English and in Spanish:
//   - choosing an Excel file (analysis held): "Analyzing…" is shown, the
//     Export button is disabled with no spinner and no "Exporting…", and the
//     file input is disabled;
//   - exporting (export held): "Exporting…" with the spinner, the file input
//     disabled and no "Analyzing…";
//   - when each one ends (and when it fails, with the error shown as today),
//     the Export button and the file input are enabled again.
//
// Preconditions: uvicorn on 8000, Vite on 5173. Cleans up its project.
//
//     node scripts/verify-import-export-busy.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

const TEXT = {
  en: { analyzing: "Analyzing…", exporting: "Exporting…", exportButton: "Export to Excel (.xlsx)", exportFailed: "Export failed:", cancel: "Cancel" },
  es: { analyzing: "Analizando…", exporting: "Exportando…", exportButton: "Exportar a Excel (.xlsx)", exportFailed: "Error al exportar:", cancel: "Cancelar" },
};
const ANY_BUSY_TEXT = /Exporting…|Exportando…/;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

// A route that holds every matching request until release() is called.
async function hold(page, pattern) {
  let release;
  const released = new Promise((r) => (release = r));
  let seen;
  const arrived = new Promise((r) => (seen = r));
  await page.route(pattern, async (route) => {
    seen();
    await released;
    await route.continue();
  });
  return { arrived, release: () => release(), unroute: () => page.unroute(pattern) };
}

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Import export busy ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({ identifier: "BRDP-IEB-1", title: "Title", definition: "Definition.", proposal: "Proposal.", validation: "Pending" }),
  });
  const rows = [{ id: "BRDP-IEB-2", title: "Other title", definition: "Definition.", proposal: "Proposal.", proposalStatus: "Pending", ruleStatus: "To Do", rule: "", catalogEdition: "" }];
  const xlsx = await api(`/api/projects/${project.id}/export.xlsx`, { method: "POST", body: JSON.stringify({ rows }) });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "import-export-busy-")), "import.xlsx");
  fs.writeFileSync(file, Buffer.from(await xlsx.arrayBuffer()));

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, acceptDownloads: true });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const fileInput = page.locator('input[type="file"][accept=".xlsx"]');
  const exportButton = page.getByRole("button", { name: /Export to Excel|Exportar a Excel|Exporting…|Exportando…/ });

  async function state() {
    return {
      exportDisabled: await exportButton.isDisabled(),
      exportText: (await exportButton.textContent()).trim(),
      exportSpinner: await exportButton.locator('[class*="spinner"]').count(),
      fileDisabled: (await fileInput.count()) ? await fileInput.isDisabled() : null,
    };
  }

  async function bothEnabled(label) {
    const s = await state();
    assert(!s.exportDisabled && s.exportSpinner === 0 && !ANY_BUSY_TEXT.test(s.exportText), `${label}: Export enabled, no spinner ("${s.exportText}")`);
    assert(s.fileDisabled === false, `${label}: file input enabled`);
  }

  async function run(lang) {
    const T = TEXT[lang];
    await page.locator("header select, nav select").first().selectOption(lang);
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await fileInput.waitFor({ state: "attached", timeout: 10000 });
    await exportButton.waitFor({ timeout: 10000 });
    await bothEnabled(`[${lang}] at start`);

    // 1. Analysis in progress.
    const parse = await hold(page, "**/brdps/import/parse");
    await fileInput.setInputFiles(file);
    await parse.arrived;
    await page.getByText(T.analyzing, { exact: true }).waitFor({ timeout: 5000 });
    let s = await state();
    assert(s.exportDisabled, `[${lang}] analyzing: Export disabled`);
    assert(s.exportSpinner === 0, `[${lang}] analyzing: no spinner on Export`);
    assert(s.exportText === T.exportButton && !ANY_BUSY_TEXT.test(s.exportText), `[${lang}] analyzing: Export reads "${s.exportText}", never Exporting…`);
    assert(s.fileDisabled === true, `[${lang}] analyzing: file input disabled`);
    await page.screenshot({ path: shot(`import-export-busy-analyzing-${lang}.png`), fullPage: true });
    parse.release();
    const cancelImport = page.getByRole("button", { name: T.cancel, exact: true });
    await cancelImport.waitFor({ timeout: 30000 });
    await parse.unroute();
    const sa = await state();
    assert(!sa.exportDisabled && sa.exportSpinner === 0, `[${lang}] analysis done: Export enabled`);
    assert((await page.getByText(T.analyzing, { exact: true }).count()) === 0, `[${lang}] analysis done: no "${T.analyzing}"`);
    await cancelImport.click();
    await fileInput.waitFor({ state: "attached", timeout: 5000 });
    await bothEnabled(`[${lang}] after cancelling the import`);

    // 2. Export in progress.
    const exp = await hold(page, "**/export.xlsx");
    const download = page.waitForEvent("download", { timeout: 30000 });
    await exportButton.click();
    await exp.arrived;
    s = await state();
    assert(s.exportDisabled && s.exportSpinner === 1 && s.exportText === T.exporting, `[${lang}] exporting: "${s.exportText}" with spinner`);
    assert(s.fileDisabled === true, `[${lang}] exporting: file input disabled`);
    assert((await page.getByText(T.analyzing, { exact: true }).count()) === 0, `[${lang}] exporting: no "${T.analyzing}"`);
    await page.screenshot({ path: shot(`import-export-busy-exporting-${lang}.png`), fullPage: true });
    exp.release();
    await download;
    await page.waitForFunction(() => !document.querySelector('button [class*="spinner"]'), null, { timeout: 10000 });
    await exp.unroute();
    await bothEnabled(`[${lang}] export done`);

    // 3. Analysis fails: the error is shown as today, both enabled again.
    await page.route("**/brdps/import/parse", (route) =>
      route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "Simulated: this file cannot be read." }) }),
    );
    await fileInput.setInputFiles(file);
    await page.getByText("Simulated: this file cannot be read.").waitFor({ timeout: 10000 });
    await page.unroute("**/brdps/import/parse");
    assert(true, `[${lang}] analysis failure: error shown`);
    await bothEnabled(`[${lang}] after the analysis fails`);

    // 4. Export fails: the error is shown as today, both enabled again.
    await page.route("**/export.xlsx", (route) =>
      route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "Simulated export failure." }) }),
    );
    await exportButton.click();
    const err = page.getByText(new RegExp(`${T.exportFailed}.*Simulated export failure`));
    await err.waitFor({ timeout: 10000 });
    await page.unroute("**/export.xlsx");
    assert(true, `[${lang}] export failure: "${(await err.textContent()).trim()}"`);
    await bothEnabled(`[${lang}] after the export fails`);
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await run("en");
    await run("es");
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
