// Live verification of "Marcar como revisado un defecto sin arreglo
// mecánico" against the real app (Vite + FastAPI + Postgres); no LLM.
//
// A S1000D 4.2 project with:
//   BRDP-EXT-00108  //identNumber[child::refs or child::remarks]  -> defect without fix (reviewed here)
//   BRDP-EXT-00115  the real rule of the S1000D 4.2 default BREX  -> defect without fix (409 case)
//   BRDP-RV-CASE    //dmCode[not(@modelidentCode)]               -> correction proposed (Discard as before)
//   BRDP-RV-MIXED   a fixable name + an unfixable path            -> correction with "still to fix"
// Checks: "Mark as reviewed" on the defect, the discreet line and "Show the
// defect", the header figure drops by 1, survives a reload, History entry
// (EN/ES), editing the rule brings the full box back, the correction's
// Discard unchanged, a viewer sees the box without the button, and a rule
// changed in another tab before the click: 409 with the reason, nothing
// saved.
//
// Preconditions: uvicorn on 8000, Vite on 5173. Uses
// backend/scripts/seed_compare_verification.py for a viewer account (and
// its cleanup at the end). Cleans up its project.
//
//     node scripts/verify-rule-defect-review.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright-core";
import { BACKEND_DIR, pythonCandidates, pythonEnv } from "./lib/backendPython.mjs";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";
import { readTextFile } from "./lib/textFile.mjs";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const FORMAT = "BREX-4.2";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sor = (id, p, use = "x") => `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">${p}</objectPath><objectUse>${use}</objectUse></structureObjectRule>`;
const DEFAULT_BREX = JSON.parse(readTextFile(new URL("./rule-test-fixtures/default-brex-4-2.json", import.meta.url))).rules;
const RULES = {
  "BRDP-EXT-00108": sor("BREX-S1-00107", "//identNumber[child::refs or child::remarks]", "Elements refs and remarks must not be used in identNumber"),
  "BRDP-EXT-00115": DEFAULT_BREX["BRDP-EXT-00115"].rule_xml,
  "BRDP-RV-CASE": sor("RV-1", "//dmCode[not(@modelidentCode)]"),
  "BRDP-RV-MIXED": sor("RV-2", "//dmCode[not(@modelidentCode)] | //identNumber[child::remarks]"),
};

function seedViewer(action = "") {
  for (const python of pythonCandidates()) {
    try {
      const out = execFileSync(python, [path.join(BACKEND_DIR, "scripts", "seed_compare_verification.py"), ...(action ? [action] : [])], { cwd: BACKEND_DIR, env: pythonEnv() });
      return action ? null : JSON.parse(out.toString("utf8").trim().split("\n").pop());
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error("no Python for the backend");
}

async function main() {
  const login = async (email, password) =>
    (
      await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }).then((r) => r.json())
    ).access_token;
  const token = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Defect review ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const viewer = seedViewer();
  await api(`/api/users/${viewer.viewer_id}/project-roles`, { method: "PUT", body: JSON.stringify({ project_id: project.id, role: "viewer" }) });

  const ids = {};
  for (const [identifier, xml] of Object.entries(RULES)) {
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title: `Title ${identifier}`, definition: "Definition.", proposal: "Proposal.", validation: "Validated" }),
    }).then((r) => r.json());
    ids[identifier] = b.id;
    const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/${FORMAT}`, { method: "PUT", body: JSON.stringify({ rule_xml: xml, source: "manual", status: "approved" }) });
    if (!r.ok) throw new Error(`seeding ${identifier}: ${r.status} ${await r.text()}`);
  }
  const approvalUrl = (identifier) => `/api/projects/${project.id}/brdps/${ids[identifier]}/approvals/${FORMAT}`;
  const approvalOf = (identifier) => api(approvalUrl(identifier)).then((r) => r.json());
  const historyOf = (identifier) => api(`/api/projects/${project.id}/brdps/${ids[identifier]}/history`).then((r) => r.json());

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  await openHistoryOnEachLoad(page);
  const language = async (lng) => {
    await page.locator("header select, nav select").first().selectOption(lng);
    await page.waitForTimeout(300);
  };
  const select = async (identifier) => {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page
      .locator("[data-testid='rule-correction'], [data-testid='rule-defect'], [data-testid='rule-defect-reviewed'], [data-testid='rule-correction-dismissed']")
      .first()
      .waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
  };
  const openRecords = async () => {
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.getByTestId("correction-counts").waitFor({ timeout: 30000 });
  };
  const count = async (kind) => Number(await page.getByTestId(`correction-count-${kind}`).getAttribute("data-count"));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await openRecords();
    const unfixable0 = await count("unfixable");
    const proposed0 = await count("proposed");
    assert(unfixable0 === 2, `2 rules with a defect without fix (${unfixable0})`);
    assert(proposed0 === 2, `2 rules with a proposed correction (${proposed0})`);

    // ---- EXT-00108: Mark as reviewed ----
    await select("BRDP-EXT-00108");
    const defectBox = page.getByTestId("rule-defect");
    assert((await defectBox.textContent()).includes("Defect detected"), "00108: full defect box");
    assert((await page.getByTestId("rule-defect-review").textContent()) === "Mark as reviewed", "00108: 'Mark as reviewed' button");
    await page.screenshot({ path: shot("rule-defect-review-before.png"), fullPage: true });
    await page.getByTestId("rule-defect-review").click();
    await page.getByTestId("rule-defect-reviewed").waitFor({ timeout: 10000 });
    const line = await page.getByTestId("rule-defect-reviewed").textContent();
    assert(line.includes("Defect reviewed for this rule text:") && line.includes("<identNumber>") && line.includes("Show the defect"), `00108: discreet line (${line})`);
    assert((await page.getByTestId("rule-defect").count()) === 0, "00108: full box gone");
    const a108 = await approvalOf("BRDP-EXT-00108");
    assert(a108.correction_dismissed_hash === sha(RULES["BRDP-EXT-00108"]) && a108.rule_xml === RULES["BRDP-EXT-00108"] && a108.status === "approved", "00108: hash stored, rule and status untouched");
    const h108 = (await historyOf("BRDP-EXT-00108")).filter((h) => h.field_name === "rule_defect_reviewed");
    assert(h108.length === 1 && JSON.parse(h108[0].new_value).defects.length >= 1, "00108: one History event with the defects");
    await page.getByText("Defect marked as reviewed").first().waitFor({ timeout: 10000 });
    assert(true, "00108: History entry shown (EN)");
    await page.screenshot({ path: shot("rule-defect-review-line.png"), fullPage: true });
    // "Show the defect": the full box again, without the button.
    await page.getByTestId("rule-defect-show").click();
    await page.getByTestId("rule-defect").waitFor({ timeout: 5000 });
    assert((await page.getByTestId("rule-defect-review").count()) === 0, "00108: shown again, no button");

    // ---- Reload: still reviewed, the header figure dropped by 1 ----
    await openRecords();
    assert((await count("unfixable")) === unfixable0 - 1, `header: unfixable ${unfixable0} -> ${await count("unfixable")}`);
    assert((await count("proposed")) === proposed0, "header: proposed unchanged");
    await page.getByTestId("correction-count-unfixable").click();
    const rows = await page.locator("tbody tr").allTextContents();
    assert(rows.length === 1 && rows[0].includes("00115"), `unfixable filter: only 00115 (${rows.length})`);
    await page.getByTestId("correction-filter-clear").click();
    await select("BRDP-EXT-00108");
    assert((await page.getByTestId("rule-defect-reviewed").count()) === 1, "00108 after reload: discreet line");

    // ---- Spanish ----
    await language("es");
    await select("BRDP-EXT-00108");
    const lineEs = await page.getByTestId("rule-defect-reviewed").textContent();
    assert(lineEs.includes("Defecto revisado para este texto de la regla:") && lineEs.includes("Ver el defecto"), `ES: discreet line (${lineEs})`);
    await page.getByText("Defecto marcado como revisado").first().waitFor({ timeout: 10000 });
    assert(true, "ES: History entry");
    await select("BRDP-EXT-00115");
    assert((await page.getByTestId("rule-defect-review").textContent()) === "Marcar como revisado", "ES: button text");
    await page.screenshot({ path: shot("rule-defect-review-es.png"), fullPage: true });
    await language("en");

    // ---- 00115 changed in another tab before the click: 409, nothing saved ----
    await select("BRDP-EXT-00115");
    const changed = RULES["BRDP-EXT-00115"].replace("must not be used", "shall not be used");
    let r = await api(approvalUrl("BRDP-EXT-00115"), { method: "PUT", body: JSON.stringify({ rule_xml: changed, source: "manual", status: "approved" }) });
    assert(r.ok, "00115 changed through the API (another tab)");
    await page.getByTestId("rule-defect-review").click();
    await page.getByTestId("rule-defect-error").waitFor({ timeout: 10000 });
    const err = await page.getByTestId("rule-defect-error").textContent();
    assert(err.includes("The defect was not marked as reviewed") && err.includes("The rule changed since the defect was shown; nothing was marked"), `409 reason shown (${err})`);
    assert((await page.getByTestId("rule-defect").count()) === 1 && (await page.getByTestId("rule-defect-reviewed").count()) === 0, "409: full box back");
    const a115 = await approvalOf("BRDP-EXT-00115");
    assert(!a115.correction_dismissed_hash, "409: nothing saved");
    assert(!(await historyOf("BRDP-EXT-00115")).some((h) => h.field_name === "rule_defect_reviewed"), "409: no History event");
    await page.screenshot({ path: shot("rule-defect-review-409.png"), fullPage: true });

    // ---- Editing the reviewed rule brings the full box back ----
    const edited = RULES["BRDP-EXT-00108"].replace("must not be used", "shall not be used");
    r = await api(approvalUrl("BRDP-EXT-00108"), { method: "PUT", body: JSON.stringify({ rule_xml: edited, source: "manual", status: "pending_review" }) });
    assert(r.ok, "00108 edited");
    await openRecords();
    assert((await count("unfixable")) === unfixable0, `after the edit: unfixable back to ${unfixable0}`);
    await select("BRDP-EXT-00108");
    assert((await page.getByTestId("rule-defect").count()) === 1 && (await page.getByTestId("rule-defect-review").count()) === 1, "00108 edited: full box and button back");

    // ---- Correction with a fix: Discard as before, no review button ----
    await select("BRDP-RV-CASE");
    assert((await page.getByTestId("rule-correction").count()) === 1 && (await page.getByTestId("rule-defect-review").count()) === 0, "correction: its block, no review button");
    await page.getByTestId("rule-correction-discard").click();
    await page.getByTestId("rule-correction-dismissed").waitFor({ timeout: 10000 });
    assert((await page.getByTestId("rule-correction-dismissed").textContent()).includes("Show the correction"), "correction: Discard leaves the line of before");
    assert(!(await historyOf("BRDP-RV-CASE")).some((h) => h.field_name === "rule_defect_reviewed"), "correction: Discard writes no review event");

    // ---- Fixable + unfixable: unchanged (correction block with 'still to fix') ----
    await select("BRDP-RV-MIXED");
    const mixed = page.getByTestId("rule-correction");
    assert((await mixed.count()) === 1 && (await page.getByTestId("rule-correction-remaining").count()) === 1, "mixed: correction with 'still to fix'");
    assert((await page.getByTestId("rule-defect-review").count()) === 0, "mixed: no review button");

    // ---- Viewer: sees the box, no button ----
    const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
    const vpage = await ctx2.newPage();
    await vpage.goto(BASE_URL);
    await vpage.fill("#login-email", viewer.viewer_email);
    await vpage.fill("#login-password", viewer.viewer_password);
    await vpage.click('button[type="submit"]');
    await vpage.waitForSelector("table", { timeout: 10000 });
    await vpage.locator("header select, nav select").first().selectOption("en");
    await vpage.goto(`${BASE_URL}/projects/${project.id}/records`);
    await vpage.getByTestId("correction-counts").waitFor({ timeout: 30000 });
    await vpage.fill('input[placeholder="Search by ID or Title…"]', "BRDP-EXT-00115");
    await vpage.locator("tbody tr", { hasText: "BRDP-EXT-00115" }).first().click();
    await vpage.getByTestId("rule-defect").waitFor({ timeout: 15000 });
    assert((await vpage.getByTestId("rule-defect-review").count()) === 0, "viewer: defect box without the button");
    await ctx2.close();
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
    seedViewer("cleanup");
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
