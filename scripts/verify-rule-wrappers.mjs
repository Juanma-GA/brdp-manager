// Legacy rule wrappers, end to end against the real app (no LLM involved).
//
// Real cases BRDP-S1-00507 (<rules>) and BRDP-S1-00070 (a bare
// <structureObjectRuleGroup>), S1000D 4.2: stored like that by older
// imports, Generate took them apart, the format check and the rule test
// rejected them. This script:
//   1. stores wrapped rules the way old data has them (straight into
//      Postgres: the save endpoint refuses them) in a 4.2, a 4.1 and a 3.0.1
//      project, next to a clean rule with context blocks;
//   2. report_invalid_rules.py lists exactly the wrapped ones;
//   3. Generate BREX in each project (the app's own XSD check passes);
//   4. backend/scripts/normalize_rule_wrappers.py --dry-run changes nothing,
//      then the real run cleans them: status kept, "Rule" history entry;
//   5. report_invalid_rules.py lists none of them, and Generate gives the
//      same document as before the cleanup;
//   6. the Excel import of the template AS IT WAS (wrapped cells, from
//      git) stores both rules clean.
//
// Preconditions: uvicorn on 8000, Vite on 5173. Cleans up its projects.
// User: PROMPT_EVAL_EMAIL / PROMPT_EVAL_PASSWORD, or the dev seed admin
// (global role admin: it creates projects).
//
//     node scripts/verify-rule-wrappers.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { readXlsxRows } from "./lib/readXlsx.mjs";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BACKEND = fileURLToPath(new URL("../backend/", import.meta.url));
const CASES = JSON.parse(fs.readFileSync(new URL("../backend/tests/fixtures/rule_wrapper_cases.json", import.meta.url), "utf8")).cases;
const REAL = Object.fromEntries(CASES.filter((c) => c.name.startsWith("real ")).map((c) => [c.name.split(":")[0].replace("real ", ""), c]));

let failures = 0;
function assert(condition, message, detail = "") {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ""}`);
  }
}

const python = (args) => execFileSync(".venv/bin/python", args, { cwd: BACKEND }).toString();
function writeRuleXmlDirectly(brdpId, format, ruleXml) {
  const code = `
import asyncio, sys, uuid
from sqlalchemy import update
from app.db.base import async_session_factory
from app.models import RuleApproval
async def main():
    async with async_session_factory() as s:
        await s.execute(update(RuleApproval).where(RuleApproval.brdp_id == uuid.UUID(sys.argv[1]), RuleApproval.format == sys.argv[2]).values(rule_xml=sys.argv[3]))
        await s.commit()
asyncio.run(main())
`;
  python(["-c", code, brdpId, format, ruleXml]);
}

const SOR41 = (id) => `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">//randomList//randomList</objectPath><objectUse>No nested random lists.</objectUse></structureObjectRule>`;
const NCR41 = (id) => `<nonContextRule id="${id}-nc"><simplePara>Decided by the project.</simplePara></nonContextRule>`;
const OBJ301 = `<objrule><objpath objappl="0">//randlist//randlist</objpath><objuse>No nested random lists.</objuse></objrule>`;
const NC301 = `<!-- nonContextRule id="BRDP-WR-301": decided by the project -->`;

async function main() {
  const login = await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!login.ok) throw new Error(`login failed for ${EMAIL} (HTTP ${login.status})`);
  const token = (await login.json()).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  // One retry when Node reuses a keep-alive connection uvicorn has already
  // closed after a few idle seconds (the steps before some calls take
  // longer than that): "fetch failed (other side closed)". The request
  // never reached the server, so repeating it is safe.
  const api = async (p, init = {}) => {
    try {
      return await fetch(`${API}${p}`, { headers: auth, ...init });
    } catch (err) {
      if (err.cause?.code !== "UND_ERR_SOCKET") throw err;
      return fetch(`${API}${p}`, { headers: auth, ...init });
    }
  };
  const suffix = Math.random().toString(36).slice(2, 8);
  const projects = [];
  const makeProject = async (name, standard) => {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    // Generate needs the identification fields filled in.
    await api(`/api/projects/${p.id}/config`, {
      method: "PUT",
      body: JSON.stringify({ project_config: { ...(p.project_config || {}), projectName: p.name, modelIdentCode: "WRAPPERS" } }),
    });
    return p;
  };
  // A Verified rule stored as old data has it: saved clean through the API,
  // approved, then overwritten with the wrapped text.
  const seed = async (project, format, identifier, storedXml, placeholder) => {
    const brdp = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title: identifier, definition: "Decide.", proposal: "Decided.", validation: "Validated" }),
    }).then((r) => r.json());
    const url = `/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`;
    const put = await api(url, { method: "PUT", body: JSON.stringify({ rule_xml: placeholder, source: "manual", status: "pending_review" }) });
    if (!put.ok) throw new Error(`seeding ${identifier}: ${put.status} ${await put.text()}`);
    await api(`${url}/approve`, { method: "POST" });
    if (storedXml !== placeholder) writeRuleXmlDirectly(brdp.id, format, storedXml);
    return { ...brdp, url };
  };

  const p42 = await makeProject("Wrappers 4.2", "S1000D 4.2");
  const p41 = await makeProject("Wrappers 4.1", "S1000D 4.1");
  const p301 = await makeProject("Wrappers 3.0.1", "S1000D 3.0.1");
  const placeholder42 = SOR41("BRDP-WR-PLACEHOLDER");
  const b507 = await seed(p42, "BREX-4.2", "BRDP-S1-00507", REAL["BRDP-S1-00507"].input, placeholder42);
  const b070 = await seed(p42, "BREX-4.2", "BRDP-S1-00070", REAL["BRDP-S1-00070"].input, placeholder42);
  await seed(p42, "BREX-4.2", "BRDP-S1-00006", REAL["BRDP-S1-00006"].input, REAL["BRDP-S1-00006"].input);
  const b41 = await seed(p41, "BREX-4.1", "BRDP-WR-41", `<rules>\n${SOR41("BRDP-WR-41")}\n<nonContextRules>${NCR41("BRDP-WR-41")}</nonContextRules>\n</rules>`, SOR41("BRDP-WR-41"));
  const b301 = await seed(p301, "BREX-3.0.1", "BRDP-WR-301", `<rules>\n${OBJ301}\n${NC301}\n</rules>`, OBJ301);

  console.log("\nBefore the cleanup");
  let report = python(["scripts/report_invalid_rules.py"]);
  const ours = (text) => text.split("\n").filter((l) => l.includes(suffix));
  assert(ours(report).length === 4, `report_invalid_rules.py lists the 4 wrapped rules`, ours(report).join("\n"));
  assert(ours(report).every((l) => l.includes("is not allowed around the rule")), "all of them as wrappers");
  assert(!report.includes(`BRDP-S1-00006`) || !ours(report).some((l) => l.includes("BRDP-S1-00006")), "the clean S1-00006 is not listed");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  // History starts collapsed ("Historial desplegable"); this script reads
  // its entries, so it opens it with a click on each page load.
  await openHistoryOnEachLoad(page);
  const generate = async (project) => {
    await page.goto(`${BASE_URL}/projects/${project.id}/generate`);
    const btn = page.locator('button:has-text("Generate")').first();
    await btn.waitFor({ timeout: 10000 });
    await btn.click();
    await page.waitForSelector("pre", { timeout: 30000 });
    await page.waitForSelector("text=/Valid against XSD schema|XSD validation issue|XSD validation failed/", { timeout: 60000 });
    const valid = await page.locator("text=Valid against XSD schema").isVisible();
    return { xml: await page.locator("pre").innerText(), valid };
  };
  const before = {};
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");

    for (const p of [p42, p41, p301]) {
      before[p.id] = await generate(p);
      assert(before[p.id].valid, `${p.standard}: Generate with the wrapped rules is valid against the XSD`);
    }
    const x42 = before[p42.id].xml;
    assert(x42.includes("//randomList//randomList") && x42.includes("pf02"), "4.2 Generate: S1-00507's rule and nonContextRule are in the BREX");
    assert(x42.includes("//responsiblePartnerCompany/@enterpriseCode") && x42.includes("//responsiblePartnerCompany/enterpriseName"), "4.2 Generate: both S1-00070 rules are in the BREX");
    assert(!/<rules>/.test(x42), "4.2 Generate: no <rules> wrapper in the BREX");
    assert(before[p41.id].xml.includes('id="BRDP-WR-41-nc"') && before[p41.id].xml.includes('id="BRDP-WR-41"'), "4.1 Generate: rule and nonContextRule in the BREX");
    assert(before[p301.id].xml.includes("//randlist//randlist") && before[p301.id].xml.includes("nonContextRule"), "3.0.1 Generate: objrule and nonContextRule comment in the BREX");

    console.log("\nMigration");
    const stored = async (b) => (await api(b.url).then((r) => r.json())).rule_xml;
    const dry = python(["scripts/normalize_rule_wrappers.py", "--dry-run"]);
    assert(/Would clean \d+ stored rule/.test(dry) && ["BRDP-S1-00507", "BRDP-S1-00070", "BRDP-WR-41", "BRDP-WR-301"].every((id) => dry.includes(`${suffix} / ${id}`)), "--dry-run lists the 4 rules", dry.split("\n")[0]);
    assert((await stored(b507)) === REAL["BRDP-S1-00507"].input, "--dry-run wrote nothing");
    const run = python(["scripts/normalize_rule_wrappers.py"]);
    assert(/^Cleaned \d+ stored rule/.test(run), `real run: ${run.split("\n")[0]}`);
    assert((await stored(b507)) === REAL["BRDP-S1-00507"].expected, "S1-00507 stored clean (its two rules, text as written)");
    assert((await stored(b070)) === REAL["BRDP-S1-00070"].expected, "S1-00070 stored clean");
    assert((await stored(b41)) === `${SOR41("BRDP-WR-41")}\n${NCR41("BRDP-WR-41")}`, "4.1 rule stored clean");
    assert((await stored(b301)) === `${OBJ301}\n${NC301}`, "3.0.1 rule stored clean");
    const approval507 = await api(b507.url).then((r) => r.json());
    assert(approval507.status === "approved", "status kept (Verified)");
    const history = await api(`/api/projects/${p42.id}/brdps/${b507.id}/history`).then((r) => r.json());
    const ruleEntry = history.find((h) => h.field_name === "rule" && h.old_value === REAL["BRDP-S1-00507"].input);
    assert(ruleEntry && ruleEntry.new_value === REAL["BRDP-S1-00507"].expected, "history: Rule entry with the old and new text");

    console.log("\nAfter the cleanup");
    report = python(["scripts/report_invalid_rules.py"]);
    assert(ours(report).length === 0, "report_invalid_rules.py lists none of them", ours(report).join("\n"));
    assert(/ 0 are not a rule of their format/.test(report), `report_invalid_rules.py: ${report.split("\n")[0]}`);
    for (const p of [p42, p41, p301]) {
      const after = await generate(p);
      assert(after.valid, `${p.standard}: Generate still valid against the XSD`);
      assert(after.xml === before[p.id].xml, `${p.standard}: Generate gives the same BREX as before the cleanup`);
    }

    // History shows it in the interface too.
    await page.goto(`${BASE_URL}/projects/${p42.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr").filter({ hasText: "BRDP-S1-00507" }).first().click();
    await page.getByText("History", { exact: false }).first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(800);
    assert((await page.locator("body").innerText()).includes("RULE"), "Records: the Rule entry is in the History panel");
    await page.screenshot({ path: path.join(os.tmpdir(), "rule-wrappers-history.png"), fullPage: true });

    // The template as it was before the cleanup commit (5fde400), with the
    // wrapped cells of S1-00507 and S1-00070.
    console.log("\nExcel import of the template as it was");
    const old = execFileSync("git", ["show", "5fde400^:public/brdp-template-4-2.xlsx"], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
    const rows = readXlsxRows(old);
    const wrappedCell = rows.find((r) => r.ID === "BRDP-S1-00507").Rule;
    if (wrappedCell.startsWith("<rules>")) {
      const pImport = await makeProject("Wrappers import", "S1000D 4.2");
      const importRows = rows.map((r, i) => ({
        row_number: i + 2,
        identifier: r.ID,
        title: r.Title,
        definition: r.Definition,
        proposal: r.Proposal,
        proposal_status: r["Proposal Status"],
        rule_status: r["Rule Status"],
        rule: r.Rule,
      }));
      const apply = await api(`/api/projects/${pImport.id}/brdps/import/apply`, { method: "POST", body: JSON.stringify({ rows: importRows, conflict_resolution: "keep" }) }).then((r) => r.json());
      let job;
      for (let i = 0; i < 40; i += 1) {
        job = await api(`/api/projects/${pImport.id}/brdps/import/status/${apply.job_id}`).then((r) => r.json());
        if (job.status !== "running") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert(job.status === "completed", `import of the old template: ${job.status}`);
      const brdps = await api(`/api/projects/${pImport.id}/brdps`).then((r) => r.json());
      for (const id of ["BRDP-S1-00507", "BRDP-S1-00070"]) {
        const b = brdps.find((x) => x.identifier === id);
        const rule = (await api(`/api/projects/${pImport.id}/brdps/${b.id}/approvals/BREX-4.2`).then((r) => r.json())).rule_xml;
        assert(rule === REAL[id].expected, `${id}: imported clean`);
      }
      report = python(["scripts/report_invalid_rules.py"]);
      assert(ours(report).length === 0, "report_invalid_rules.py: nothing from the import either");
    } else {
      console.log("  (HEAD already has the clean template; the import of wrapped cells is covered by backend/tests/test_rule_wrappers.py)");
    }
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}${err.cause ? ` (${err.cause.message || err.cause})` : ""}`);
  process.exit(1);
});
