// Live verification for "El bloque general del BREX 4.x sin rulesContext"
// against the real app (Vite + FastAPI + Postgres), Mistral transport mocked.
//
// A 4.2 project with a general rule (//footnote), a rule stored wrapped in
// <contextRules rulesContext=""> (old data) and a rule limited to proced:
// Generate writes the general rules in <contextRules> WITHOUT the attribute
// (the stored rulesContext="" rule included), the proced block unchanged, no
// rulesContext="" anywhere, no safety-net warning; the BREX validates against
// brex4.2.xsd (the app's check and xmllint); s1kd-brexcheck's selection
// (scripts/lib/brexcheckEmulation.mjs, XPath copied from its source) applies
// the general rule to a descriptive DM with a <footnote> and reports it; the
// Schematron output has no schema condition on the general rule. A second
// project whose stored block nests an empty rulesContext shows the
// safety-net warning (EN and ES). "Test rule" on a Draft stored as
// <contextRules rulesContext=""> says up front, without any LLM call, that it
// would apply to no schema (EN and ES), and Verify explains it.
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks, Vite on 5173.
// Cleans up the projects it creates.
//
//     node scripts/verify-brex-general-block.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { chromium } from "playwright-core";
import { brexcheckErrors, selectedRules } from "./lib/brexcheckEmulation.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = os.tmpdir();

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}
const FLAT42 = (s) => `http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${s}.xsd`;
const parseXml = (text) => new DOMParser().parseFromString(text, "text/xml");

const FOOTNOTE = '<structureObjectRule id="BRDP-GB-FOOT"><objectPath allowedObjectFlag="0">//footnote</objectPath><objectUse>BRDP-GB-FOOT. Footnotes must not be used.</objectUse></structureObjectRule>';
const OLD_EMPTY = '<contextRules rulesContext="">\n  <structureObjectRuleGroup>\n    <structureObjectRule id="BRDP-GB-OLD"><objectPath allowedObjectFlag="0">//randomList</objectPath><objectUse>BRDP-GB-OLD. No random lists.</objectUse></structureObjectRule>\n  </structureObjectRuleGroup>\n</contextRules>';
const PROC = `<contextRules rulesContext="${FLAT42("proced")}">\n  <structureObjectRuleGroup>\n    <structureObjectRule id="BRDP-GB-PROC"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>BRDP-GB-PROC.</objectUse></structureObjectRule>\n  </structureObjectRuleGroup>\n</contextRules>`;
const NESTED_EMPTY = `<contextRules rulesContext="${FLAT42("descript")}"><contextRules rulesContext=""><structureObjectRuleGroup><structureObjectRule id="BRDP-GB-NEST"><objectPath allowedObjectFlag="0">//acronym</objectPath><objectUse>u</objectUse></structureObjectRule></structureObjectRuleGroup></contextRules></contextRules>`;

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
  const projects = [];
  async function makeProject(name) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
    projects.push(p);
    await api(`/api/projects/${p.id}/config`, { method: "PUT", body: JSON.stringify({ project_config: { ...(p.project_config || {}), projectName: p.name, modelIdentCode: "GENBLK" } }) });
    return p;
  }
  const makeBrdp = (project, fields) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ definition: "A definition.", validation: "Validated", ...fields }) }).then((r) => r.json());
  async function putRule(project, brdp, ruleXml, approve) {
    const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: ruleXml, source: "manual" }) });
    if (!put.ok) throw new Error(`PUT rule ${brdp.identifier}: ${put.status} ${await put.text()}`);
    if (approve) {
      const ok = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2/approve`, { method: "POST" });
      if (!ok.ok) throw new Error(`approve ${brdp.identifier}: ${ok.status}`);
    }
  }

  const p = await makeProject("General block 4.2");
  await putRule(p, await makeBrdp(p, { identifier: "BRDP-GB-FOOT", title: "Footnotes", proposal: "<footnote> shall not be used." }), FOOTNOTE, true);
  await putRule(p, await makeBrdp(p, { identifier: "BRDP-GB-OLD", title: "Random lists", proposal: "<randomList> shall not be used." }), OLD_EMPTY, true);
  await putRule(p, await makeBrdp(p, { identifier: "BRDP-GB-PROC", title: "Emphasis in procedures", proposal: "In procedural data modules, <emphasis> shall not be used." }), PROC, true);
  await putRule(p, await makeBrdp(p, { identifier: "BRDP-GB-DRAFT", title: "Acronyms", proposal: "<acronym> shall not be used." }), OLD_EMPTY.replaceAll("BRDP-GB-OLD", "BRDP-GB-DRAFT"), false);
  const pNest = await makeProject("General block nested empty");
  await putRule(pNest, await makeBrdp(pNest, { identifier: "BRDP-GB-NEST", title: "Nested", proposal: "x" }), NESTED_EMPTY, true);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1300 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const language = (lng) => page.locator("header select, nav select").first().selectOption(lng);
  async function generate(project) {
    await page.goto(`${BASE_URL}/projects/${project.id}/generate`);
    const btn = page.locator('button:has-text("Generate")').first();
    await btn.waitFor({ timeout: 10000 });
    await btn.click();
    await page.waitForSelector("pre", { timeout: 30000 });
    await page.waitForSelector("text=/Valid against XSD schema|XSD validation issue|XSD validation failed|Válido|validación/", { timeout: 60000 });
    return page.locator("pre").innerText();
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.waitForTimeout(300);

    // 1. Generate BREX 4.2.
    const xml = await generate(p);
    assert(!/rulesContext\s*=\s*""/.test(xml), 'Generate: no rulesContext="" in the output');
    const general = /<contextRules>([\s\S]*?)<\/contextRules>/.exec(xml)?.[1] || "";
    assert(general.includes('id="BRDP-GB-FOOT"'), "Generate: general rule in <contextRules> without the attribute");
    assert(general.includes('id="BRDP-GB-OLD"'), 'Generate: the rule stored in rulesContext="" goes to the general block');
    assert(xml.includes(`<contextRules rulesContext="${FLAT42("proced")}">`) && !general.includes("BRDP-GB-PROC"), "Generate: the proced block unchanged");
    assert(await page.locator("text=Valid against XSD schema").isVisible(), "Generate: valid against the XSD (app check)");
    assert((await page.getByTestId("empty-context-blocks").count()) === 0, "Generate: no safety-net warning");
    const file = path.join(os.tmpdir(), `general-block-${suffix}.xml`);
    fs.writeFileSync(file, xml);
    let lint = "valid";
    try {
      execFileSync("xmllint", ["--noout", "--schema", path.join(ROOT, "sources/S4.2/brex4.2.xsd"), file], { stdio: "pipe" });
    } catch (err) {
      lint = String(err.stderr || err.message).slice(0, 600);
    }
    assert(lint === "valid", `xmllint against brex4.2.xsd (${lint})`);
    await page.screenshot({ path: path.join(SHOTS, "brex-general-block-generate.png"), fullPage: true });

    // 2. s1kd-brexcheck's selection on the generated BREX.
    const brexDoc = parseXml(xml);
    const ids = (schema) => selectedRules(brexDoc, FLAT42(schema)).map((r) => r.getAttribute("id")).sort().join();
    assert(ids("descript") === "BRDP-GB-FOOT,BRDP-GB-OLD", `s1kd: descript DM gets the two general rules (${ids("descript")})`);
    assert(ids("proced") === "BRDP-GB-FOOT,BRDP-GB-OLD,BRDP-GB-PROC", `s1kd: proced DM gets general + proced (${ids("proced")})`);
    const dm = parseXml(`<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${FLAT42("descript")}"><content><description><levelledPara><para>Text<footnote><para>Note</para></footnote></para></levelledPara></description></content></dmodule>`);
    const errors = brexcheckErrors(brexDoc, dm);
    assert(errors.some((e) => e.id === "BRDP-GB-FOOT"), `s1kd: <footnote> in a descriptive DM is an error (${JSON.stringify(errors)})`);
    const old = parseXml(xml.replace("<contextRules>", '<contextRules rulesContext="">'));
    assert(brexcheckErrors(old, dm).length === 0, 's1kd: with the old rulesContext="" the same DM passed');

    // 3. Schematron output: the general rule without a schema condition.
    await page.getByRole("button", { name: "Schematron (XPath 2.0)" }).click();
    await page.locator('button:has-text("Generate")').first().click();
    await page.waitForFunction(() => document.querySelector("pre")?.textContent.includes("sch:schema"), null, { timeout: 30000 });
    const sch = await page.locator("pre").innerText();
    const tests = [...sch.matchAll(/<sch:assert[^>]*test="([^"]*)"/g)].map((m) => m[1]);
    assert(tests.length === 3 && tests.filter((t) => t.includes("noNamespaceSchemaLocation")).length === 1, `Schematron: only the proced rule has a schema condition (${tests.join(" | ")})`);

    // 4. Safety net: a stored block nesting an empty rulesContext.
    await generate(pNest);
    const warn = page.getByTestId("empty-context-blocks");
    assert((await warn.count()) === 1, "safety net: warning shown");
    const warnText = await warn.textContent();
    assert(warnText.includes("The BREX has 1 context block with an empty schema attribute") && warnText.includes("s1kd-brexcheck"), `safety net EN (${warnText})`);
    await language("es");
    await page.waitForTimeout(300);
    const warnEs = await warn.textContent();
    assert(warnEs.includes("El BREX tiene 1 bloque de contexto con el atributo de esquema vacío"), `safety net ES (${warnEs})`);
    await page.screenshot({ path: path.join(SHOTS, "brex-general-block-safety-net-es.png"), fullPage: true });
    await language("en");
    await page.waitForTimeout(300);

    // 5. Test rule on a Draft stored as <contextRules rulesContext="">.
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.fill('input[placeholder="Search by ID or Title…"]', "BRDP-GB-DRAFT");
    await page.locator("tbody tr", { hasText: "BRDP-GB-DRAFT" }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(500);
    await fetch(`${MOCK}/reset`, { method: "POST" });
    const panel = page.getByTestId("rule-test-panel");
    await page.getByRole("button", { name: "Test rule" }).click();
    await panel.getByTestId("rule-test-analysis").waitFor({ timeout: 5000 });
    const analysis = await panel.getByTestId("rule-test-analysis").textContent();
    assert(analysis.includes("The rule is inside a <contextRules> with an empty rulesContext") && analysis.includes("would apply to no schema"), `Test rule: clear message up front (${analysis})`);
    await page.waitForTimeout(1000);
    assert((await fetch(`${MOCK}/last-request`).then((r) => r.json())) === null, "Test rule: no LLM call");
    assert(!analysis.includes("Examples could only illustrate it.") && (await panel.getByTestId("rule-test-show-examples").count()) === 0, "Test rule: no illustrative examples offered for a rule that applies nowhere");
    await panel.screenshot({ path: path.join(SHOTS, "brex-general-block-test-rule.png") });
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    const dialog = page.getByTestId("verify-warning-dialog");
    await dialog.waitFor({ timeout: 5000 });
    assert((await dialog.textContent()).includes("empty rulesContext"), "Verify dialog explains it");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await language("es");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Probar regla" }).click();
    await panel.getByTestId("rule-test-analysis").waitFor({ timeout: 5000 });
    const es = await panel.getByTestId("rule-test-analysis").textContent();
    assert(es.includes("con el rulesContext vacío") && es.includes("no se aplicarían a ningún esquema"), `Test rule ES (${es})`);
    await language("en");
  } finally {
    await browser.close();
    for (const pr of projects) await api(`/api/projects/${pr.id}`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
