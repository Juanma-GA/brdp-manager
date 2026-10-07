// Live verification of "Corrección propuesta de reglas con defecto"
// against the real app (Vite + FastAPI + Postgres); no LLM involved.
//
// A S1000D 3.0.1 project with the real defects (rules as described in the
// encargo; see scripts/test-rule-correction.mjs for where each text comes
// from):
//   BRDP-EXT-02816  //figure//legend/def[...]            -> add <deflist> (tested: becomes outdated)
//   BRDP-EXT-02815  //figure//...term[not(. = //figure…)] -> ancestor::figure; id XML-R-2826 shared
//   BRDP-EXT-02814  same id XML-R-2826                     -> defect without fix (shared id)
//   BRDP-EXT-02656  @cheksum                               -> @checksum (discarded here)
//   BRDP-EXT-02773  <schemaRef>/<schemaInfo>               -> defect without fix
//   BRDP-CP-VERIF   legend/def, Verified + tested          -> accept asks first, back to Draft
//   BRDP-CP-CLEAN   a rule without defect                  -> nothing shown
// Checks: the project counters and filters, the ficha block (fixed /
// remaining / before-after), Accept (rule saved, test outdated, History),
// Discard (stays discarded after a reload, discreet line), the defect
// without fix with access to Suggest Rule, a viewer (block, no buttons),
// Spanish texts.
//
// Preconditions: uvicorn on 8000, Vite on 5173. Uses
// backend/scripts/seed_compare_verification.py for a viewer account (and
// its cleanup at the end). Cleans up its project.
//
//     node scripts/verify-rule-correction.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright-core";
import { BACKEND_DIR, pythonCandidates, pythonEnv } from "./lib/backendPython.mjs";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const FORMAT = "BREX-3.0.1";

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
const objrule = (id, p, use = "x") => `<objrule id="${id}"><objpath objappl="0">${p}</objpath><objuse>${use}</objuse></objrule>`;
const RULES = {
  "BRDP-EXT-02816": objrule("XML-R-2828", "//figure//legend/def[not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)]", "Prohibir &lt;def&gt; que no coincida"),
  "BRDP-EXT-02815": objrule("XML-R-2826", "//figure//legend/deflist/term[not(. = //figure//graphic//hotspot/@apsname)]", "Prohibir &lt;term&gt; que no coincida"),
  "BRDP-EXT-02814": objrule("XML-R-2826", "//figure//legend/deflist/term[not(normalize-space(.))]", "Prohibir &lt;term&gt; vacío"),
  "BRDP-EXT-02656": objrule("XML-R-2656", "//cb[not(@cheksum)]", "Obligatorio @checksum"),
  "BRDP-EXT-02773": objrule("XML-R-2773", "//schemaRef[not(schemaInfo)]", "x"),
  "BRDP-CP-VERIF": objrule("XML-R-9001", "//figure//legend/def[not(normalize-space(.))]", "x"),
  "BRDP-CP-CLEAN": objrule("XML-R-9002", "//randlist", "x"),
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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Rule correction ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());
  const viewer = seedViewer();
  await api(`/api/users/${viewer.viewer_id}/project-roles`, { method: "PUT", body: JSON.stringify({ project_id: project.id, role: "viewer" }) });

  const ids = {};
  for (const [identifier, xml] of Object.entries(RULES)) {
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title: `Title ${identifier}`, definition: "Definition.", proposal: "Proposal.", validation: "Validated" }),
    }).then((r) => r.json());
    ids[identifier] = b.id;
    const url = `/api/projects/${project.id}/brdps/${b.id}/approvals/${FORMAT}`;
    const verified = identifier === "BRDP-CP-VERIF";
    let r = await api(url, { method: "PUT", body: JSON.stringify({ rule_xml: xml, source: "manual", status: verified ? "approved" : "pending_review" }) });
    if (!r.ok) throw new Error(`seeding ${identifier}: ${r.status} ${await r.text()}`);
    if (identifier === "BRDP-EXT-02816" || verified) {
      r = await api(`${url}/test`, { method: "POST", body: JSON.stringify({ result: "passed", rule_hash: sha(xml) }) });
      if (!r.ok) throw new Error(`seeding test: ${r.status}`);
    }
  }
  const approvalOf = (identifier) => api(`/api/projects/${project.id}/brdps/${ids[identifier]}/approvals/${FORMAT}`).then((r) => r.json());

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
    await page.getByTestId("rule-test-indicator").or(page.locator("[data-testid='rule-correction'], [data-testid='rule-defect']")).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
  };
  const openRecords = async () => {
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.getByTestId("correction-counts").waitFor({ timeout: 30000 });
  };
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");

    // ---- Project list: counters and filters ----
    const t0 = Date.now();
    await openRecords();
    console.log(`  rules checked in ${Date.now() - t0} ms (page load included)`);
    const count = async (kind) => Number(await page.getByTestId(`correction-count-${kind}`).getAttribute("data-count"));
    assert((await count("proposed")) === 4, `4 rules with a proposed correction (${await count("proposed")})`);
    assert((await count("unfixable")) === 2, `2 rules with a defect without fix (${await count("unfixable")})`);
    await page.screenshot({ path: shot("rule-correction-counts.png") });
    await page.getByTestId("correction-count-proposed").click();
    const rows = await page.locator("tbody tr").allTextContents();
    assert(rows.length === 4 && ["02816", "02815", "02656", "CP-VERIF"].every((id) => rows.some((r) => r.includes(id))), `proposed filter shows the 4 (${rows.length})`);
    await page.getByTestId("correction-count-unfixable").click();
    const rows2 = await page.locator("tbody tr").allTextContents();
    assert(rows2.length === 2 && rows2.some((r) => r.includes("02814")) && rows2.some((r) => r.includes("02773")), `unfixable filter shows 02814 and 02773 (${rows2.length})`);
    await page.getByTestId("correction-filter-clear").click();

    // ---- 02816: add <deflist>, Accept ----
    await select("BRDP-EXT-02816");
    const block = page.getByTestId("rule-correction");
    await block.waitFor({ timeout: 15000 });
    const fixed = await page.getByTestId("rule-correction-fixed").textContent();
    assert(fixed.includes("<def> does not go inside <legend>; it goes inside <deflist>") && fixed.includes("Add <deflist> to the path"), `02816 reason: ${fixed}`);
    assert((await page.locator("[data-testid='rule-correction-line'][data-kind='changed']").count()) >= 1, "02816 before/after with the change marked");
    await page.screenshot({ path: shot("rule-correction-block.png"), fullPage: true });
    await page.getByTestId("rule-correction-accept").click();
    await page.getByTestId("rule-correction").waitFor({ state: "detached", timeout: 15000 });
    const a16 = await approvalOf("BRDP-EXT-02816");
    assert(a16.rule_xml.includes("//figure//legend/deflist/def[") && a16.status === "pending_review", "02816 saved corrected, Draft");
    assert(a16.test_category === "outdated", `02816 test outdated (${a16.test_category})`);
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Test outdated"), "02816 indicator: Test outdated");
    await page.getByText("Correction accepted").first().waitFor({ timeout: 10000 });
    const historyText = await page.locator("body").textContent();
    assert(historyText.includes("Add <deflist> to the path"), "History: the reason of the accepted correction");

    // ---- 02815: ancestor::figure, the shared id stays to fix ----
    await select("BRDP-EXT-02815");
    const fixed15 = await page.getByTestId("rule-correction-fixed").textContent();
    assert(fixed15.includes("ancestor::figure"), "02815: //figure -> ancestor::figure");
    const remaining15 = await page.getByTestId("rule-correction-remaining").textContent();
    assert(remaining15.includes("XML-R-2826") && remaining15.includes("BRDP-EXT-02814"), `02815: shared id still to fix (${remaining15})`);

    // ---- 02814: defect without fix (shared id) ----
    await select("BRDP-EXT-02814");
    const defect14 = await page.getByTestId("rule-defect").textContent();
    assert(defect14.includes("Defect detected") && defect14.includes("BRDP-EXT-02815"), "02814: defect without fix names 02815");

    // ---- 02773: no similar name, access to Suggest Rule ----
    await select("BRDP-EXT-02773");
    const defect73 = await page.getByTestId("rule-defect").textContent();
    assert(defect73.includes("<schemaRef> does not exist in the S1000D 3.0.1 schema, and there is no similar name"), "02773: no similar name");
    assert((await page.getByTestId("rule-defect-suggest-rule").count()) === 1, "02773: access to Suggest Rule");
    await page.screenshot({ path: shot("rule-correction-defect.png"), fullPage: true });

    // ---- 02656: Discard, remembered ----
    await select("BRDP-EXT-02656");
    assert((await page.getByTestId("rule-correction-fixed").textContent()).includes("Change @cheksum to @checksum"), "02656: @cheksum -> @checksum");
    await page.getByTestId("rule-correction-discard").click();
    await page.getByTestId("rule-correction-dismissed").waitFor({ timeout: 10000 });
    const a56 = await approvalOf("BRDP-EXT-02656");
    assert(a56.correction_dismissed_hash === sha(RULES["BRDP-EXT-02656"]) && a56.rule_xml === RULES["BRDP-EXT-02656"], "02656: dismissal stored by hash, rule untouched");
    await openRecords();
    assert((await count("proposed")) === 2, `after accept + discard: 2 proposed (${await count("proposed")})`);
    await select("BRDP-EXT-02656");
    assert((await page.getByTestId("rule-correction").count()) === 0 && (await page.getByTestId("rule-correction-dismissed").count()) === 1, "02656 after reload: discreet line, no block");

    // ---- Verified rule: Accept asks, back to Draft ----
    await select("BRDP-CP-VERIF");
    let dialogText = "";
    page.once("dialog", async (d) => {
      dialogText = d.message();
      await d.accept();
    });
    await page.getByTestId("rule-correction-accept").click();
    await page.getByTestId("rule-correction").waitFor({ state: "detached", timeout: 15000 });
    assert(dialogText.includes("Verified") && dialogText.includes("Draft"), "Verified rule: Accept asks first");
    const av = await approvalOf("BRDP-CP-VERIF");
    assert(av.status === "pending_review" && av.test_category === "outdated", "Verified rule: back to Draft, test outdated");

    // ---- Clean rule ----
    await select("BRDP-CP-CLEAN");
    assert((await page.locator("[data-testid='rule-correction'], [data-testid='rule-defect']").count()) === 0, "clean rule: nothing shown");

    // ---- Spanish ----
    await language("es");
    await select("BRDP-EXT-02815");
    assert((await page.getByTestId("rule-correction").textContent()).includes("Corrección propuesta"), "ES: block title");
    assert((await page.getByTestId("correction-count-proposed").textContent()).includes("con corrección propuesta"), "ES: counter");
    await page.screenshot({ path: shot("rule-correction-block-es.png"), fullPage: true });
    await language("en");

    // ---- Viewer: sees, cannot act ----
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
    await vpage.fill('input[placeholder="Search by ID or Title…"]', "BRDP-EXT-02815");
    await vpage.locator("tbody tr", { hasText: "BRDP-EXT-02815" }).first().click();
    await vpage.getByTestId("rule-correction").waitFor({ timeout: 15000 });
    assert((await vpage.getByTestId("rule-correction-accept").count()) === 0 && (await vpage.getByTestId("rule-correction-discard").count()) === 0, "viewer: block without buttons");
    assert((await vpage.getByTestId("rule-correction-viewer").count()) === 1, "viewer: says only an editor can act");
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
