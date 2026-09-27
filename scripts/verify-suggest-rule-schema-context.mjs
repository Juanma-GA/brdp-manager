// Live verification for "Suggest Rule, parte 2 de 2: contexto de esquema"
// (docs request) -- the edge-case table against the real app (Vite +
// FastAPI + Postgres), only the Mistral TRANSPORT mocked
// (mock-mistral-chat-server.mjs answers a Proposal naming <emphasis> or
// <partSegment> with a prohibition rule on that element).
//
// Covers: no selector for an element present in every schema; selector with
// the mentioned schema pre-checked; "Limit to specific schemas…" with two
// schemas -> two context blocks with their own ids; an element present in
// only some schemas -> selector open, the others disabled with the reason;
// Cancel; per-schema warning on a pasted rule; DITA never shows it; and
// Generate BREX for 4.2, 4.1 and 3.0.1 with the blocks in place, valid
// against the XSD (the app's own check AND xmllint against sources/).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks, Vite on 5173.
// Cleans up the projects it creates.
//
//     node scripts/verify-suggest-rule-schema-context.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const XSD = {
  "S1000D 4.2": "sources/S4.2/brex4.2.xsd",
  "S1000D 4.1": "sources/S4.1/brex4.1.xsd",
  "S1000D 3.0.1": "sources/S3.0.1/brex.xsd",
};

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
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
  const projects = [];

  async function makeProject(name, standard) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    await api(`/api/projects/${p.id}/config`, {
      method: "PUT",
      body: JSON.stringify({ project_config: { ...(p.project_config || {}), projectName: p.name, modelIdentCode: "SCHCTX" } }),
    });
    return p;
  }
  const makeBrdp = (project, fields) =>
    api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ definition: "A definition.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
  async function embed(project) {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") {
        if (s.status !== "completed") throw new Error(`embedding job ${s.status}: ${s.error}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("embedding job did not finish");
  }
  const getRule = (project, brdp, format) =>
    api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`).then((r) => r.json());
  const approve = (project, brdp, format) =>
    api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}/approve`, { method: "POST" });
  const lastSystemPrompt = async () =>
    (await fetch(`${MOCK}/last-request`).then((r) => r.json())).messages.find((m) => m.role === "system").content;

  // ---- seed ----
  const p42 = await makeProject("Schema ctx 4.2", "S1000D 4.2");
  const b = {
    gen: await makeBrdp(p42, { identifier: "BRDP-SC-GEN", title: "Emphasis", proposal: "<emphasis> shall not be used." }),
    proc: await makeBrdp(p42, { identifier: "BRDP-SC-PROC", title: "Emphasis in procedures", proposal: "In procedural data modules, <emphasis> shall not be used." }),
    two: await makeBrdp(p42, { identifier: "BRDP-SC-TWO", title: "Emphasis again", proposal: "Writers: <emphasis> shall not be used." }),
    part: await makeBrdp(p42, { identifier: "BRDP-SC-PART", title: "Part segments", proposal: "<partSegment> shall not be used." }),
  };
  const p41 = await makeProject("Schema ctx 4.1", "S1000D 4.1");
  const b41 = await makeBrdp(p41, { identifier: "BRDP-SC-41", title: "Emphasis in procedures", proposal: "In procedural data modules, <emphasis> shall not be used." });
  const p301 = await makeProject("Schema ctx 3.0.1", "S1000D 3.0.1");
  const b301 = await makeBrdp(p301, { identifier: "BRDP-SC-301", title: "Énfasis en procedimientos", proposal: "En los módulos de datos procedimentales no se usará <emphasis>." });
  const pDita = await makeProject("Schema ctx DITA", "DITA 1.3 Xpath2.0");
  await makeBrdp(pDita, { identifier: "BRDP-SC-DITA", title: "Notes", proposal: "In procedural topics every <note> shall declare @type." });
  for (const p of [p42, p41, p301, pDita]) await embed(p);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1300 } })).newPage();
  page.on("dialog", (d) => d.accept());
  const ruleButton = () => page.getByRole("button", { name: "Suggest Rule" });
  const limitLink = () => page.getByRole("button", { name: "Limit to specific schemas…" });
  const selector = () => page.getByTestId("rule-schema-selector");
  const checkbox = (schema) => selector().locator(`input[type="checkbox"][value="${schema}"]`);
  async function openProject(p) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
  async function select(identifier) {
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(400);
  }
  const waitForRule = () => page.getByRole("button", { name: "Discard" }).waitFor({ timeout: 15000 });
  async function acceptAndApprove(project, brdp, format) {
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForTimeout(800);
    const stored = await getRule(project, brdp, format);
    assert((await approve(project, brdp, format)).ok, `${brdp.identifier}: approved for Generate`);
    return stored.rule_xml;
  }
  async function generate(project) {
    await page.goto(`${BASE_URL}/projects/${project.id}/generate`);
    const btn = page.locator('button:has-text("Generate")').first();
    await btn.waitFor({ timeout: 10000 });
    await btn.click();
    await page.waitForSelector("pre", { timeout: 30000 });
    await page.waitForSelector("text=/Valid against XSD schema|XSD validation issue|XSD validation failed/", { timeout: 60000 });
    return page.locator("pre").innerText();
  }
  function xmllint(xml, standard) {
    const file = path.join(os.tmpdir(), `schema-ctx-${suffix}-${standard.replace(/\W/g, "")}.xml`);
    fs.writeFileSync(file, xml);
    try {
      execFileSync("xmllint", ["--noout", "--schema", path.join(ROOT, XSD[standard]), file], { stdio: "pipe" });
      return "valid";
    } catch (err) {
      return String(err.stderr || err.message).slice(0, 800);
    }
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // 1. <emphasis>, no schema mentioned -> general rule, no selector.
    await openProject(p42);
    await select("BRDP-SC-GEN");
    assert(await limitLink().isVisible(), "S1000D: 'Limit to specific schemas…' link shown");
    await ruleButton().click();
    await waitForRule();
    assert((await selector().count()) === 0, "<emphasis> without a schema mention: no selector");
    assert(await page.locator("text=Applies to: all schemas").isVisible(), "general rule: 'Applies to: all schemas'");
    let system = await lastSystemPrompt();
    assert(system.includes("The rule applies to every schema (it is a general rule,"), "general rule: prompt keeps the general wording");
    await page.getByRole("button", { name: "Discard" }).click();

    // 2. "In procedural data modules" -> selector, proced pre-checked.
    await select("BRDP-SC-PROC");
    await ruleButton().click();
    await selector().waitFor({ timeout: 10000 });
    assert(await checkbox("proced").isChecked(), "proced mention: proced pre-checked");
    assert(!(await checkbox("descript").isChecked()) && !(await checkbox("descript").isDisabled()), "other schemas unchecked and enabled (<emphasis> is in every 4.2 schema)");
    assert(await page.locator("text=/Pre-checked because the BRDP mentions them: proced/").isVisible(), "the mention is explained");
    await page.screenshot({ path: "/tmp/schema-ctx-selector-proced.png", fullPage: true });
    await selector().getByRole("button", { name: "Generate" }).click();
    await waitForRule();
    system = await lastSystemPrompt();
    assert(system.includes("The rule applies ONLY to documents written against the\nschema proced."), "chosen schema reaches the prompt");
    assert(await page.locator("text=Applies to: proced").isVisible(), "'Applies to: proced' shown");
    const shown = await page.locator('[class*="suggestionCode"]').first().innerText();
    assert(
      shown.startsWith('<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">') &&
        (shown.match(/<contextRules /g) || []).length === 1 &&
        shown.includes("<structureObjectRuleGroup>"),
      "one contextRules with the proced URL wraps the rule"
    );
    await page.screenshot({ path: "/tmp/schema-ctx-proced-rule.png", fullPage: true });
    const procStored = await acceptAndApprove(p42, b.proc, "BREX-4.2");
    assert(procStored === shown, "saved rule_xml is exactly the wrapped rule shown");

    // 3. "Limit to specific schemas…" by hand, two schemas -> two blocks.
    await select("BRDP-SC-TWO");
    await limitLink().click();
    await selector().waitFor({ timeout: 10000 });
    assert((await selector().locator("input:checked").count()) === 0, "manual selector: nothing pre-checked");
    await checkbox("proced").check();
    await checkbox("descript").check();
    await selector().getByRole("button", { name: "Generate" }).click();
    await waitForRule();
    const twoShown = await page.locator('[class*="suggestionCode"]').first().innerText();
    assert((twoShown.match(/<contextRules /g) || []).length === 2, "two schemas -> two context blocks");
    assert(twoShown.includes('id="BRDP-SC-TWO-proced"') && twoShown.includes('id="BRDP-SC-TWO-descript"'), "each block's rule has its own xs:ID");
    assert((twoShown.match(/\/\/emphasis/g) || []).length === 2, "... with the same inner rule");
    await acceptAndApprove(p42, b.two, "BREX-4.2");

    // 4. Element only in some schemas -> selector opens, others disabled.
    await select("BRDP-SC-PART");
    await ruleButton().click();
    await selector().waitFor({ timeout: 10000 });
    assert(!(await checkbox("ipd").isDisabled()), "<partSegment>: ipd enabled");
    assert(await checkbox("fault").isDisabled(), "<partSegment>: fault disabled");
    const faultTitle = await selector().locator('label:has(input[value="fault"])').getAttribute("title");
    assert(/partSegment/.test(faultTitle || ""), `disabled schema says why (${faultTitle})`);
    await page.screenshot({ path: "/tmp/schema-ctx-selector-partial.png", fullPage: true });
    await selector().getByRole("button", { name: "Cancel" }).click();
    assert((await selector().count()) === 0 && !(await ruleButton().isDisabled()), "Cancel closes the selector and unblocks Suggest");

    // 5. Per-schema warning (Part 5) on a pasted rule: <table> is not in ipd.
    await ruleButton().click();
    await selector().waitFor({ timeout: 10000 });
    await checkbox("ipd").check();
    await selector().getByRole("button", { name: "Generate" }).click();
    await waitForRule();
    assert((await page.locator("text=/which does not exist in the ipd schema/").count()) === 0, "rule on <partSegment> limited to ipd: no per-schema warning");
    await page
      .locator("textarea[placeholder*='Paste a rule']")
      .fill('<structureObjectRule id="BRDP-SC-PART" brSeverityLevel="brsl01"><brDecisionRef brDecisionIdentNumber="BRDP-SC-PART"/><objectPath allowedObjectFlag="0">//table</objectPath><objectUse>No tables.</objectUse></structureObjectRule>');
    await page.waitForSelector("text=/The rule uses <table>, which does not exist in the ipd schema/", { timeout: 8000 });
    const warnColor = await page
      .locator("text=/which does not exist in the ipd schema/")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    assert(warnColor === "rgb(185, 28, 28)", `per-schema warning is red (${warnColor})`);
    assert(!(await page.getByRole("button", { name: "Accept pasted rule" }).isDisabled()), "per-schema warning never blocks Accept");
    const pastedPreview = await page.locator('[class*="suggestionCode"]').nth(1).innerText();
    assert(pastedPreview.includes("xml_schema_flat/ipd.xsd"), "pasted rule is shown wrapped in the chosen schema's block");
    await page.screenshot({ path: "/tmp/schema-ctx-pasted-warning.png", fullPage: true });
    await page.getByRole("button", { name: "Discard" }).click();

    // 6. Generate BREX 4.2 with the context blocks in place.
    let xml = await generate(p42);
    assert(await page.locator("text=Valid against XSD schema").isVisible(), "4.2 Generate: the app's own XSD check passes");
    const genericEnd = xml.indexOf("</contextRules>");
    const procIdx = xml.indexOf('rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"');
    assert(procIdx > genericEnd && genericEnd > 0, "4.2: context blocks placed after the generic contextRules");
    assert((xml.match(/xml_schema_flat\/proced\.xsd/g) || []).length === 2 && xml.includes("xml_schema_flat/descript.xsd"), "4.2: all three blocks (proced x2, descript) present");
    const nonCtx = xml.indexOf("<nonContextRules");
    assert(nonCtx === -1 || nonCtx > xml.lastIndexOf("</contextRules>"), "4.2: no nonContextRules before a contextRules sibling");
    assert(xmllint(xml, "S1000D 4.2") === "valid", `4.2: xmllint --schema brex4.2.xsd valid (${xmllint(xml, "S1000D 4.2")})`);
    await page.screenshot({ path: "/tmp/schema-ctx-generate-4-2.png", fullPage: true });

    // 7. 4.1: same flow, Generate, XSD.
    await openProject(p41);
    await select("BRDP-SC-41");
    await ruleButton().click();
    await selector().waitFor({ timeout: 10000 });
    assert(await checkbox("proced").isChecked(), "4.1: proced pre-checked");
    await selector().getByRole("button", { name: "Generate" }).click();
    await waitForRule();
    const s41 = await acceptAndApprove(p41, b41, "BREX-4.1");
    assert(s41.includes('rulesContext="http://www.s1000d.org/S1000D_4-1/xml_schema_flat/proced.xsd"'), "4.1: rulesContext uses the 4.1 URL");
    xml = await generate(p41);
    assert(await page.locator("text=Valid against XSD schema").isVisible(), "4.1 Generate: the app's own XSD check passes");
    assert(xml.includes("S1000D_4-1/xml_schema_flat/proced.xsd"), "4.1: block present in the BREX");
    assert(xmllint(xml, "S1000D 4.1") === "valid", `4.1: xmllint valid (${xmllint(xml, "S1000D 4.1")})`);

    // 8. 3.0.1 (Spanish mention): contextrules / structrules / objrule.
    await openProject(p301);
    await select("BRDP-SC-301");
    await ruleButton().click();
    await selector().waitFor({ timeout: 10000 });
    assert(await checkbox("proced").isChecked(), "3.0.1: Spanish 'procedimentales' pre-checks proced");
    await selector().getByRole("button", { name: "Generate" }).click();
    await waitForRule();
    const s301 = await acceptAndApprove(p301, b301, "BREX-3.0.1");
    assert(
      s301.startsWith('<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd">') && s301.includes("<structrules>") && s301.includes("<objrule"),
      "3.0.1: contextrules context=… + structrules + objrule"
    );
    xml = await generate(p301);
    assert(await page.locator("text=Valid against XSD schema").isVisible(), "3.0.1 Generate: the app's own XSD check passes");
    const generic301End = xml.indexOf("</contextrules>");
    assert(xml.indexOf('context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd"') > generic301End, "3.0.1: block placed after the generic contextrules");
    assert(xmllint(xml, "S1000D 3.0.1") === "valid", `3.0.1: xmllint valid (${xmllint(xml, "S1000D 3.0.1")})`);
    await page.screenshot({ path: "/tmp/schema-ctx-generate-3-0-1.png", fullPage: true });

    // 9. DITA never shows the selector.
    await openProject(pDita);
    await select("BRDP-SC-DITA");
    assert((await limitLink().count()) === 0, "DITA: no 'Limit to specific schemas…' link");
    await ruleButton().click();
    await waitForRule();
    assert((await selector().count()) === 0, "DITA: Suggest Rule never shows the selector (even with 'procedural' in the text)");
    assert((await page.locator("text=/Applies to:/").count()) === 0, "DITA: no 'Applies to' line");
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
