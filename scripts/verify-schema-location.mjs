// Live verification for "Ubicación del esquema configurable (y sin 'Master'
// en 4.x)" against the real app (Vite + FastAPI + Postgres), only the
// Mistral TRANSPORT mocked.
//
// On a 4.2 project: Project Configuration offers Flat / Custom (no Master);
// an invalid pattern blocks the save with its reason (EN and ES); the pattern
// ../schemas/{schema}.xsd with its proced/descript preview is saved; a rule
// limited to proced is accepted with rulesContext="../schemas/proced.xsd";
// "Test rule" on it builds examples with that same xsi path and gives the
// correct verdict; Generate writes the rulesContext and the BREX's own
// brex.xsd in the project form, rewrites a copy of BRDP-S1-00006 (flat URLs)
// and lists it in the report, leaves an unrecognized rulesContext as written
// and warns about it, and the stored rules are unchanged; the BREX validates
// against the XSD (the app's check and xmllint). Also: a 4.2 project with
// "master" stored (old data) shows Flat; 3.0.1 still offers Master. And a
// 3.0.1 Master project whose rule allows each DM schema in flat AND master
// form (shape of BRDP-EXT-02772): Generate leaves its values as written and
// lists it in amber ("mixes schema URL forms"), in EN and ES, while a
// flat-only rule beside it is still rewritten.
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks, Vite on 5173,
// psql reachable (to store the old 4.x "master" value the API now refuses).
// Cleans up the projects it creates.
//
//     node scripts/verify-schema-location.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { retiredTemplateRows } from "./lib/readXlsx.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(os.tmpdir());

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
      body: JSON.stringify({ project_config: { ...(p.project_config || {}), projectName: p.name, modelIdentCode: "SCHLOC" } }),
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
  const getRule = (project, brdp) => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`).then((r) => r.json());
  async function putApproved(project, brdp, ruleXml, format = "BREX-4.2") {
    const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: ruleXml, source: "manual" }),
    });
    if (!put.ok) throw new Error(`PUT rule ${brdp.identifier}: ${put.status} ${await put.text()}`);
    const ok = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}/approve`, { method: "POST" });
    if (!ok.ok) throw new Error(`approve ${brdp.identifier}: ${ok.status}`);
  }

  // ---- seed ----
  const p42 = await makeProject("Schema location 4.2", "S1000D 4.2");
  const proc = await makeBrdp(p42, { identifier: "BRDP-SL-PROC", title: "Emphasis in procedures", proposal: "In procedural data modules, <emphasis> shall not be used." });
  const s6 = await makeBrdp(p42, { identifier: "BRDP-S1-00006", title: "Schemas", proposal: "Only the schemas listed are used." });
  const urn = await makeBrdp(p42, { identifier: "BRDP-SL-URN", title: "Imported rule", proposal: "Imported." });
  const S00006 = retiredTemplateRows().find((r) => r.ID === "BRDP-S1-00006").Rule;
  const s6Values = (S00006.match(/valueAllowed="/g) || []).length;
  await putApproved(p42, s6, S00006);
  const URN_RULE = `<contextRules rulesContext="urn:csdb:proced">\n  <structureObjectRuleGroup>\n    <structureObjectRule id="BRDP-SL-URN"><objectPath allowedObjectFlag="0">//acronym</objectPath><objectUse>No acronyms.</objectUse></structureObjectRule>\n  </structureObjectRuleGroup>\n</contextRules>`;
  await putApproved(p42, urn, URN_RULE);
  await embed(p42);
  const pOld = await makeProject("Schema location 4.2 old master", "S1000D 4.2");
  execFileSync("psql", ["-h", "localhost", "-U", "brdp", "brdp_manager", "-c",
    `UPDATE projects SET project_config = project_config || '{"schemaLocation":"master"}' WHERE id = '${pOld.id}'`], { env: { ...process.env, PGPASSWORD: "brdp" } });
  const p301 = await makeProject("Schema location 3.0.1", "S1000D 3.0.1");
  // Part 4: a 3.0.1 Master project with a rule that allows each DM schema in
  // flat AND master form (shape of BRDP-EXT-02772 of SOPTE: 17 + 17), and a
  // rule with flat URLs only beside it.
  const FLAT301 = (s) => `http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/${s}.xsd`;
  const MASTER301 = (s) => `http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/${s}Schema.xsd`;
  const SOPTE_SCHEMAS = ["appliccrossreftable", "brex", "checklist", "comrep", "condcrossreftable", "container", "crew", "descript", "fault", "frontmatter", "ipd", "prdcrossreftable", "proced", "process", "schedul", "techrep", "wrngdata"];
  const objvals = (urls) => urls.map((u) => `\n  <objval valtype="single" val1="${u}"/>`).join("");
  const MIXED_RULE = `<objrule id="BRDP-EXT-02772">\n  <objpath>//@xsi:noNamespaceSchemaLocation</objpath>\n  <objuse>Only the S1000D 3.0.1 DM schemas, flat or master.</objuse>${objvals([...SOPTE_SCHEMAS.map(FLAT301), ...SOPTE_SCHEMAS.map(MASTER301)])}\n</objrule>`;
  const FLAT_ONLY_RULE = `<objrule id="BRDP-SL-FLAT">\n  <objpath>//@xsi:noNamespaceSchemaLocation</objpath>\n  <objuse>Only the descriptive and procedural schemas.</objuse>${objvals([FLAT301("descript"), FLAT301("proced")])}\n</objrule>`;
  const pMaster = await makeProject("Schema location 3.0.1 master mixed", "S1000D 3.0.1");
  await api(`/api/projects/${pMaster.id}/config`, {
    method: "PUT",
    body: JSON.stringify({ project_config: { projectName: pMaster.name, modelIdentCode: "SCHLOC", schemaLocation: "master" } }),
  });
  const mixedBrdp = await makeBrdp(pMaster, { identifier: "BRDP-EXT-02772", title: "Schemas allowed", proposal: "Only the S1000D 3.0.1 DM schemas are used, flat or master." });
  const flatBrdp = await makeBrdp(pMaster, { identifier: "BRDP-SL-FLAT", title: "Schemas", proposal: "Only descript and proced." });
  await putApproved(pMaster, mixedBrdp, MIXED_RULE, "BREX-3.0.1");
  await putApproved(pMaster, flatBrdp, FLAT_ONLY_RULE, "BREX-3.0.1");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1300 } })).newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const locSelect = () => page.locator("#cfg-schemaLocation");
  const pattern = () => page.locator("#cfg-schemaLocationPattern");
  const patternError = () => page.getByTestId("schema-pattern-error");
  const save = () => page.getByTestId("config-save");
  const options = async () => locSelect().locator("option").evaluateAll((os) => os.map((o) => o.value));
  const language = (lng) => page.locator("header select, nav select").first().selectOption(lng);

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.waitForTimeout(300);

    // 1. Options per standard.
    await page.goto(`${BASE_URL}/projects/${p301.id}/config`);
    await locSelect().waitFor({ timeout: 10000 });
    assert((await options()).join() === "flat,master,custom", `3.0.1: Flat, Master, Custom (${await options()})`);
    await page.goto(`${BASE_URL}/projects/${pOld.id}/config`);
    await locSelect().waitFor({ timeout: 10000 });
    assert((await options()).join() === "flat,custom", `4.2: Flat, Custom, no Master (${await options()})`);
    assert((await locSelect().inputValue()) === "flat", "4.2 with 'master' stored (old data): shown as Flat");

    // 2. The custom pattern on the 4.2 project.
    await page.goto(`${BASE_URL}/projects/${p42.id}/config`);
    await locSelect().waitFor({ timeout: 10000 });
    await locSelect().selectOption("custom");
    await pattern().waitFor({ timeout: 5000 });
    await pattern().fill("../schemas/proced.xsd");
    assert((await patternError().textContent()) === "The pattern must contain {schema} where the schema name goes.", `no {schema}: reason shown (${await patternError().textContent()})`);
    assert(await save().isDisabled(), "no {schema}: Save disabled");
    await pattern().fill('../"{schema}.xsd');
    assert((await patternError().textContent()).includes('the character "'), "a quote: reason names the character");
    await page.screenshot({ path: path.join(SHOTS, "schema-location-invalid.png"), fullPage: true });
    await language("es");
    await page.waitForTimeout(300);
    assert((await patternError().textContent()).startsWith('El patrón no puede contener el carácter "'), `ES reason (${await patternError().textContent()})`);
    await pattern().fill("../schemas/{schema}.xsd{schema}");
    assert((await patternError().textContent()) === "El patrón debe contener {schema} exactamente una vez.", "ES: {schema} twice");
    assert((await locSelect().locator("option[value=custom]").textContent()) === "Personalizada — un patrón propio", "ES option label");
    await language("en");
    await page.waitForTimeout(300);
    await pattern().fill("../schemas/{schema}.xsd");
    assert((await patternError().count()) === 0 && !(await save().isDisabled()), "valid pattern: no reason, Save enabled");
    const preview = await page.getByTestId("schema-location-preview").textContent();
    assert(preview.includes("../schemas/proced.xsd") && preview.includes("../schemas/descript.xsd"), `preview with proced and descript (${preview})`);
    await page.screenshot({ path: path.join(SHOTS, "schema-location-custom.png"), fullPage: true });
    const [putRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p42.id}/config`) && r.request().method() === "PUT", { timeout: 10000 }),
      save().click(),
    ]);
    assert(putRes.ok(), "Save: PUT …/config 200");
    const cfg = (await api(`/api/projects/${p42.id}/config`).then((r) => r.json())).project_config;
    assert(cfg.schemaLocation === "custom" && cfg.schemaLocationPattern === "../schemas/{schema}.xsd" && cfg.modelIdentCode === "SCHLOC", "pattern saved, other fields kept");
    await page.reload();
    await pattern().waitFor({ timeout: 10000 });
    assert((await pattern().inputValue()) === "../schemas/{schema}.xsd", "pattern survives a reload");
    const bad = await api(`/api/projects/${p42.id}/config`, { method: "PUT", body: JSON.stringify({ project_config: { ...cfg, schemaLocationPattern: "../x.xsd" } }) });
    assert(bad.status === 422, "backend refuses an invalid pattern (422)");

    // 3. Accept a rule limited to proced.
    await page.goto(`${BASE_URL}/projects/${p42.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.fill('input[placeholder="Search by ID or Title…"]', "BRDP-SL-PROC");
    await page.locator("tbody tr", { hasText: "BRDP-SL-PROC" }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    const selector = page.getByTestId("rule-schema-selector");
    await selector.waitFor({ timeout: 10000 });
    assert(await selector.locator('input[value="proced"]').isChecked(), "proced pre-checked");
    await selector.getByRole("button", { name: "Generate" }).click();
    await page.getByRole("button", { name: "Discard" }).waitFor({ timeout: 15000 });
    const shown = await page.locator('[class*="suggestionCode"]').first().innerText();
    assert(shown.startsWith('<contextRules rulesContext="../schemas/proced.xsd">'), `suggestion wrapped with the pattern (${shown.split("\n")[0]})`);

    // 4. "Test rule" on that rule: examples with the same xsi path, verdict correct.
    await page.getByRole("button", { name: "Test rule" }).click();
    await page.getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    const verdict = await page.getByTestId("rule-test-verdict").textContent();
    assert(verdict.startsWith("Correct"), `test verdict correct (${verdict})`);
    const exampleXml = await page.getByTestId("rule-test-example-0").locator("pre").textContent();
    assert(exampleXml.includes('xsi:noNamespaceSchemaLocation="../schemas/proced.xsd"'), "test example carries ../schemas/proced.xsd");
    const allExamples = await page.getByTestId("rule-test-panel").textContent();
    assert(!allExamples.includes("xml_schema_flat"), "no flat URL in any test example");
    await page.screenshot({ path: path.join(SHOTS, "schema-location-test-rule.png"), fullPage: true });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForTimeout(800);
    const stored = await getRule(p42, proc);
    assert(stored.rule_xml === shown, "stored rule is exactly the one shown");
    assert((await api(`/api/projects/${p42.id}/brdps/${proc.id}/approvals/BREX-4.2/approve`, { method: "POST" })).ok, "rule approved");

    // 5. Generate.
    await page.goto(`${BASE_URL}/projects/${p42.id}/generate`);
    const btn = page.locator('button:has-text("Generate")').first();
    await btn.waitFor({ timeout: 10000 });
    await btn.click();
    await page.waitForSelector("pre", { timeout: 30000 });
    await page.waitForSelector("text=/Valid against XSD schema|XSD validation issue|XSD validation failed/", { timeout: 60000 });
    const xml = await page.locator("pre").innerText();
    assert(xml.includes('rulesContext="../schemas/proced.xsd"'), "Generate: rulesContext in the project form");
    assert(/<dmodule\b[^>]*xsi:noNamespaceSchemaLocation="\.\.\/schemas\/brex\.xsd"/.test(xml), "Generate: BREX DM brex.xsd in the project form");
    assert(!xml.includes("xml_schema_flat"), "Generate: no flat URL left (S1-00006 rewritten)");
    assert((xml.match(/valueAllowed="\.\.\/schemas\/[a-z]+\.xsd"/g) || []).length === s6Values, `Generate: the ${s6Values} valueAllowed of S1-00006 rewritten`);
    assert(xml.includes('rulesContext="urn:csdb:proced"'), "Generate: the unrecognized rulesContext is left as written");
    assert(await page.locator("text=Valid against XSD schema").isVisible(), "Generate: valid against the XSD (app check)");
    const rewritten = page.getByTestId("schema-urls-rewritten");
    await rewritten.locator("summary").click();
    const rewrittenText = await rewritten.textContent();
    assert(rewrittenText.includes("in 1 rule") && rewrittenText.includes("custom: ../schemas/{schema}.xsd"), `report: 1 rule rewritten (${rewrittenText.slice(0, 120)})`);
    assert(rewrittenText.includes("BRDP-S1-00006") && rewrittenText.includes(`${s6Values + 3} values`) && rewrittenText.includes("BRDP-SL-PROC") === false, "report lists BRDP-S1-00006 (its values + 3 contexts), and not the proced rule already in the project form");
    const unrec = await page.getByTestId("schema-urls-unrecognized").textContent();
    assert(unrec.includes("1 rule has schema URLs that were left as written") && unrec.includes("BRDP-SL-URN") && unrec.includes("urn:csdb:proced"), `report warns about the unrecognized value (${unrec.slice(0, 120)})`);
    await page.screenshot({ path: path.join(SHOTS, "schema-location-generate-report.png"), fullPage: true });
    assert((await getRule(p42, s6)).rule_xml === S00006, "stored BRDP-S1-00006 unchanged (flat URLs)");
    const file = path.join(os.tmpdir(), `schema-location-${suffix}.xml`);
    fs.writeFileSync(file, xml);
    let lint = "valid";
    try {
      execFileSync("xmllint", ["--noout", "--schema", path.join(ROOT, "sources/S4.2/brex4.2.xsd"), file], { stdio: "pipe" });
    } catch (err) {
      lint = String(err.stderr || err.message).slice(0, 600);
    }
    assert(lint === "valid", `xmllint against brex4.2.xsd (${lint})`);
    await language("es");
    await page.waitForTimeout(300);
    const es = await page.getByTestId("schema-urls-unrecognized").textContent();
    assert(es.includes("1 regla tiene URL de esquema que se han dejado como estaban"), `ES report (${es.slice(0, 100)})`);
    await page.screenshot({ path: path.join(SHOTS, "schema-location-generate-report-es.png"), fullPage: true });
    await language("en");

    // 6. Schematron output uses the same URLs.
    await page.getByRole("button", { name: "Schematron (XPath 2.0)" }).click();
    await page.locator('button:has-text("Generate")').first().click();
    await page.waitForSelector("pre", { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("pre")?.textContent.includes("sch:schema"), null, { timeout: 30000 });
    const sch = await page.locator("pre").innerText();
    assert(sch.includes("@xsi:noNamespaceSchemaLocation = '../schemas/proced.xsd'"), "Schematron: condition uses the pattern path");
    assert(!sch.includes("xml_schema_flat"), "Schematron: no flat URL left");
    assert((await page.getByTestId("schema-urls-unrecognized").count()) === 1, "Schematron: same report");

    // 7. Part 4: Generate in the 3.0.1 Master project -- the mixed list is
    // left as written and listed in amber; the flat-only rule is rewritten.
    await page.goto(`${BASE_URL}/projects/${pMaster.id}/generate`);
    const btn301 = page.locator('button:has-text("Generate")').first();
    await btn301.waitFor({ timeout: 10000 });
    await btn301.click();
    await page.waitForSelector("pre", { timeout: 30000 });
    await page.waitForSelector("text=/Valid against XSD schema|XSD validation issue|XSD validation failed/", { timeout: 60000 });
    const xml301 = await page.locator("pre").innerText();
    assert(SOPTE_SCHEMAS.every((s) => xml301.includes(`val1="${FLAT301(s)}"`) && xml301.includes(`val1="${MASTER301(s)}"`)), "3.0.1 Master Generate: EXT-02772 keeps its 17 flat + 17 master values");
    assert((xml301.match(/val1="[^"]*"/g) || []).length === 34 + 2, "3.0.1 Master Generate: no value duplicated or lost (36 values in all)");
    const flatBlock = (/<objrule id="BRDP-SL-FLAT">[\s\S]*?<\/objrule>/.exec(xml301) || [""])[0];
    assert(flatBlock.includes(`val1="${MASTER301("descript")}"`) && flatBlock.includes(`val1="${MASTER301("proced")}"`) && !flatBlock.includes("xml_schema_flat"), "3.0.1 Master Generate: the flat-only rule is rewritten to master");
    assert(await page.locator("text=Valid against XSD schema").isVisible(), "3.0.1 Master Generate: valid against the XSD (app check)");
    const mixed = page.getByTestId("schema-urls-mixed");
    const mixedText = await mixed.textContent();
    assert(mixedText.includes("1 rule mixes schema URL forms; it was left as written") && mixedText.includes("BRDP-EXT-02772") && mixedText.includes("mixes schema URL forms (flat, master, 34 values); left as written"), `amber report lists EXT-02772 (${mixedText.slice(0, 200)})`);
    assert(!mixedText.includes("BRDP-SL-FLAT"), "the flat-only rule is not listed as mixed");
    const summaryClass = await mixed.locator("summary").getAttribute("class");
    assert(/badgePending/.test(summaryClass || ""), `mixed report uses the amber badge (${summaryClass})`);
    assert(await mixed.evaluate((d) => d.open), "mixed report is open");
    const rew301 = page.getByTestId("schema-urls-rewritten");
    await rew301.locator("summary").click();
    const rew301Text = await rew301.textContent();
    assert(rew301Text.includes("BRDP-SL-FLAT") && !rew301Text.includes("BRDP-EXT-02772"), `rewritten report lists only the flat-only rule (${rew301Text.slice(0, 160)})`);
    await mixed.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "schema-location-mixed-forms.png"), fullPage: true });
    const file301 = path.join(os.tmpdir(), `schema-location-301-${suffix}.xml`);
    fs.writeFileSync(file301, xml301);
    let lint301 = "valid";
    try {
      execFileSync("xmllint", ["--noout", "--schema", path.join(ROOT, "sources/S3.0.1/brex.xsd"), file301], { stdio: "pipe" });
    } catch (err) {
      lint301 = String(err.stderr || err.message).slice(0, 600);
    }
    assert(lint301 === "valid", `xmllint against S3.0.1/brex.xsd (${lint301})`);
    await language("es");
    await page.waitForTimeout(300);
    const mixedEs = await page.getByTestId("schema-urls-mixed").textContent();
    assert(mixedEs.includes("1 regla mezcla formas de URL de esquema; se ha dejado como estaba") && mixedEs.includes("mezcla formas de URL de esquema (flat, master, 34 valores); se ha dejado como estaba"), `ES mixed report (${mixedEs.slice(0, 200)})`);
    await page.screenshot({ path: path.join(SHOTS, "schema-location-mixed-forms-es.png"), fullPage: true });
    await language("en");
    const storedMixed = await api(`/api/projects/${pMaster.id}/brdps/${mixedBrdp.id}/approvals/BREX-3.0.1`).then((r) => r.json());
    assert(storedMixed.rule_xml === MIXED_RULE, "stored EXT-02772 unchanged");
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
