// AI Extract with the two real Schematron files, the import table's search
// and sort, "Import as", and Generate with Draft rules -- in a real browser,
// against the real backend and Postgres (LLM and embeddings through the local
// simulators, as in every other verify script):
//   - BRDP-D1_schematron-xpath3.sch into an empty DITA 1.3 Xpath3.0 project:
//     7 candidates, each rule with the global functions it uses (and each
//     function's comment), imported "Already in force", generated (each
//     function, its comment and sch:ns once), and the
//     generated document imported back: everything "Already exists (same)";
//   - BRDP-D1_schematron-xpath2.sch into an empty DITA 1.3 Xpath2.0 project:
//     the file's EXT numbers kept (00004 is only a comment: file warning),
//     titles from the comments, 00007 as one candidate with its three
//     patterns; imported "Pending review"; Generate with the boxes checked
//     (nothing included, and why) and unchecked (Draft rules included);
//   - xpath3 refused in an Xpath2.0 project;
//   - Lufthansa's BREX: search (ID, source ID, title, accents) and sort,
//     "select / clear all shown" on the filtered rows only, imported
//     "Pending review" and generated with the boxes unchecked (61 rules +
//     469 nonContextRule, all Draft; one context block per schema) and
//     checked (nothing, and why);
//     imported "Already in force" in another project and generated with the
//     boxes checked; 4 rules sent back to Draft and left out, listed;
//   - EN and ES.
// Needs the 4.2 catalog of the repo loaded:
//     cd backend && .venv/bin/python scripts/seed_extract_catalog_42.py   (cleanup afterwards)
//
//     node scripts/verify-ai-extract-schematron-generate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const XPATH2 = path.join(ROOT, "backend/tests/fixtures/schematron/BRDP-D1_schematron-xpath2.sch");
const XPATH3 = path.join(ROOT, "backend/tests/fixtures/schematron/BRDP-D1_schematron-xpath3.sch");
const LUFTHANSA = path.join(ROOT, "backend/tests/fixtures/brex/DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml");
const SHOTS = os.tmpdir();
const FUNCTIONS = ["colDe", "colContiene", "colPart", "valor", "docFicha", "nodoConref", "textoNota", "esAdvertencia", "conrefRoto"];

let failures = 0;
function assert(condition, message, detail = "") {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ""}`);
  }
}

let token = null;
async function api(p, options = {}) {
  const res = await fetch(`${API}${p}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${options.method || "GET"} ${p} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function createProject(name, standard, config) {
  return api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `${name} ${Date.now()}`, standard, project_config: config, seed_from_catalog: false }),
  });
}

async function openConfig(page, projectId) {
  await page.goto(`${BASE_URL}/projects/${projectId}/config`);
  await page.getByTestId("rule-extract-section").waitFor();
}

async function uploadAndReview(page, file) {
  await page.getByTestId("rule-extract-file").setInputFiles(file);
  await page.getByTestId("rule-extract-table").waitFor({ timeout: 240000 });
  await page.waitForTimeout(500);
  await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 240000 });
}

// With the real S1000D 4.1 catalog loaded, the S1 identifiers of the
// Lufthansa BREX that the 4.2 catalog lacks are "From catalog (S1000D 4.1)",
// unchecked. This script was written for them as "New EXT" (checked by
// default): they are reclassified so, through the same PATCH the page uses.
async function lufthansaS1AsNewExt(page, projectId) {
  const { job, list } = await candidates(projectId);
  const items = list.filter((c) => c.classification === "catalog_edition").map((c) => ({ key: c.key, classification: "new_ext", selected: true }));
  if (!items.length) return;
  await api(`/api/projects/${projectId}/ai-extract/jobs/${job.id}/candidates`, { method: "PATCH", body: JSON.stringify({ items }) });
  await page.reload();
  await page.getByTestId("rule-extract-table").waitFor({ timeout: 240000 });
  await page.waitForTimeout(500);
  await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 240000 });
}

async function candidates(projectId) {
  const job = await api(`/api/projects/${projectId}/ai-extract/jobs/active`);
  return { job, list: (await api(`/api/projects/${projectId}/ai-extract/jobs/${job.id}/candidates`)).candidates };
}

function row(page, origin) {
  return page.locator(`[data-testid="rule-extract-row"][data-origin="${origin}"]`);
}

async function shownIdentifiers(page) {
  return page.getByTestId("rule-extract-identifier").allInnerTexts();
}

async function importAs(page, value, expectCount) {
  await page.getByTestId("rule-extract-import-as").selectOption(value);
  let dialogText = null;
  const onDialog = async (d) => {
    dialogText = d.message();
    await d.accept();
  };
  page.once("dialog", onDialog);
  await page.getByTestId("rule-extract-apply").click();
  await page.getByTestId("rule-extract-result").waitFor({ timeout: 120000 });
  page.off("dialog", onDialog);
  if (value === "in_force") assert(dialogText && dialogText.includes(String(expectCount)), `"Already in force" asks first, with the count (${expectCount})`, dialogText);
  else assert(dialogText === null, '"Pending review" imports without asking');
}

async function generate(page, projectId, { onlyValidated = true, onlyVerified = true } = {}) {
  await page.goto(`${BASE_URL}/projects/${projectId}/generate`);
  await page.getByRole("button", { name: /^(Generate|Generar)$/ }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="generate-rules-loading"]'));
  const v = page.locator('label:has-text("Validated"), label:has-text("validados")').locator("input");
  const r = page.locator('label:has-text("Verified XML"), label:has-text("verificadas")').locator("input");
  if ((await v.isChecked()) !== onlyValidated) await v.click();
  if ((await r.isChecked()) !== onlyVerified) await r.click();
  const counter = await page.locator("p", { hasText: /will be included|Se incluir/ }).innerText();
  await page.getByRole("button", { name: /^(Generate|Generar)$/ }).click();
  await page.locator('[data-testid="generate-rules-included"], [data-testid="generate-no-rules"], [class*="errorBox"]').first().waitFor({ timeout: 240000 });
  const xml = (await page.locator("pre").count()) ? await page.locator("pre").first().innerText() : null;
  return { counter, xml };
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = (await login.json()).access_token;
  if (!token) throw new Error(`login failed for ${EMAIL}`);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  // A new file or text over an extraction not imported yet asks first
  // ("the current one is discarded"): accepted, as a user starting over.
  // Any other dialog is left to its own handler (or dismissed, the default).
  page.on("dialog", (d) => {
    if (/new extraction|extracción nueva/.test(d.message())) d.accept();
    else if (page.listenerCount("dialog") === 1) d.dismiss();
  });
  const projects = [];
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);
    await page.locator("header select, nav select").first().selectOption("en");

    // ── xpath3 into an empty DITA 1.3 Xpath3.0 project ──────────────────────
    console.log("\nBRDP-D1_schematron-xpath3.sch → empty DITA 1.3 Xpath3.0 project");
    const p3 = await createProject("AI Extract SCH3", "DITA 1.3 Xpath3.0", { projectName: "Navantia X3" });
    projects.push(p3);
    await openConfig(page, p3.id);
    await uploadAndReview(page, XPATH3);
    assert((await page.getByTestId("rule-extract-counts").innerText()).includes("7 candidates"), "7 candidates");
    assert((await page.getByTestId("rule-extract-file-warnings").count()) === 0, "no file warning: every global function and the sch:ns are used");
    assert(JSON.stringify(await shownIdentifiers(page)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((n) => `BRDP-EXT-0000${n}`)), "the file's EXT numbers, kept", (await shownIdentifiers(page)).join(","));
    let r = row(page, "BRDP-EXT-00001");
    assert((await r.getByTestId("rule-extract-title").inputValue()) === "Campo cantidad de repuestos no vacío", "EXT-00001 Title from its comment");
    assert((await r.getByTestId("rule-extract-source-title").innerText()) === "from the file", "… tagged 'from the file'");
    r = row(page, "BRDP-EXT-00007");
    await r.getByTestId("rule-extract-rule-summary").click();
    const r7 = await r.innerText();
    assert(["docFicha", "nodoConref", "textoNota", "esAdvertencia", "conrefRoto"].every((f) => r7.includes(`name="${f}"`)), "EXT-00007's rule carries the functions it uses, nodoConref included");
    assert(r7.includes('xmlns:xs="http://www.w3.org/2001/XMLSchema"'), "… and declares the xs prefix it uses");
    await r.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-xpath3-review.png") });
    await importAs(page, "in_force", 7);
    assert(await page.getByTestId("rule-extract-result-in-force").isVisible(), "result says: imported as already in force");
    const records3 = await api(`/api/projects/${p3.id}/brdps`);
    assert(records3.length === 7 && records3.every((b) => b.validation === "Validated"), "7 BRDPs, Validated");

    let g = await generate(page, p3.id);
    assert(/^7 BRDPs will be included/.test(g.counter), "counter: 7 BRDPs will be included", g.counter);
    assert((await page.getByTestId("generate-rules-included").innerText()) === "7 rules included", "7 rules included");
    assert((await page.getByTestId("generate-drafts-included").count()) === 0, "no Draft warning");
    for (const f of FUNCTIONS) assert(g.xml.split(`<sch:let name="${f}"`).length - 1 === 1, `generated: ${f} declared once`);
    assert((g.xml.match(/<sch:ns prefix="xs"/g) || []).length === 1, "generated: sch:ns xs once");
    {
      // Each function's comment (right before it in the file) written once,
      // right before the function; the file's two header blocks not kept.
      const source = fs.readFileSync(XPATH3, "utf8").replace(/\r\n?/g, "\n");
      for (const f of FUNCTIONS) {
        const m = source.match(new RegExp(`(<!--(?:(?!-->)[\\s\\S])*-->)\\s*<sch:let name="${f}"`));
        const at = m ? g.xml.indexOf(m[1]) : -1;
        assert(!!m && g.xml.split(m[1]).length - 1 === 1 && /^\s*<sch:let name="/.test(g.xml.slice(at + m[1].length)) && g.xml.slice(at + m[1].length).trimStart().startsWith(`<sch:let name="${f}"`), `generated: ${f}'s comment once, right before it`);
      }
      assert(!g.xml.includes("QUÉ ES ESTE FICHERO") && !g.xml.includes("FUNCIONES COMPARTIDAS"), "generated: the file's header blocks are not kept");
    }
    assert(g.xml.includes('queryBinding="xslt3"'), "generated: queryBinding xslt3");
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-xpath3-generated.png") });
    const generated3 = path.join(SHOTS, "BRDP-D1-generated-xpath3.sch");
    fs.writeFileSync(generated3, g.xml);
    await openConfig(page, p3.id);
    await uploadAndReview(page, generated3);
    {
      const { list } = await candidates(p3.id);
      assert(list.length === 7 && list.every((c) => c.classification === "same"), "the generated document imported back: all 7 'Already exists (same)'", list.map((c) => `${c.origin_identifier}:${c.classification}`).join(" "));
    }

    // ── xpath2 into an empty DITA 1.3 Xpath2.0 project ──────────────────────
    console.log("\nBRDP-D1_schematron-xpath2.sch → empty DITA 1.3 Xpath2.0 project");
    const p2 = await createProject("AI Extract SCH2", "DITA 1.3 Xpath2.0", { projectName: "Navantia X2" });
    projects.push(p2);
    await openConfig(page, p2.id);
    await uploadAndReview(page, XPATH2);
    assert((await page.getByTestId("rule-extract-counts").innerText()).includes("6 candidates"), "6 candidates");
    assert(JSON.stringify(await shownIdentifiers(page)) === JSON.stringify([1, 2, 3, 5, 6, 7].map((n) => `BRDP-EXT-0000${n}`)), "IDs 00001, 00002, 00003, 00005, 00006, 00007 (not shifted)");
    assert((await page.getByTestId("rule-extract-file-warnings").innerText()).includes("BRDP-EXT-00004 is mentioned in a comment, but has no rule in this file."), "file warning for EXT-00004 (only a comment)");
    assert((await row(page, "BRDP-EXT-00001").getByTestId("rule-extract-title").inputValue()) === "Campo cantidad repuestos no vacío", "EXT-00001 Title 'Campo cantidad repuestos no vacío'");
    r = row(page, "BRDP-EXT-00007");
    assert((await r.getByTestId("rule-extract-rule-summary").innerText()).trim() === "3 rules", "EXT-00007: one candidate with its 3 patterns");
    await r.getByTestId("rule-extract-rule-summary").click();
    const x7 = await r.innerText();
    assert(["BRDP-EXT-00007a — EL CENTINELA", "BRDP-EXT-00007 — La comparacion", "BRDP-EXT-00007b — LA ADVERTENCIA"].every((s) => x7.includes(s)), "… each with its comment");
    assert(x7.includes("'@@URI-CARPETA-DOSIER@@'"), "… @@URI-CARPETA-DOSIER@@ kept literal");
    await r.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-xpath2-review.png") });
    // Search without accents and in another case: "VACIO" finds "vacío".
    await page.getByTestId("rule-extract-search").fill("VACIO");
    assert(JSON.stringify(await shownIdentifiers(page)) === '["BRDP-EXT-00001"]' && (await page.getByTestId("rule-extract-shown").innerText()) === "1 of 6", "search 'VACIO' (no accent, other case) finds 'Campo cantidad repuestos no vacío'");
    await page.getByTestId("rule-extract-search").fill("");
    await importAs(page, "pending", 6);

    g = await generate(page, p2.id, { onlyValidated: true, onlyVerified: true });
    assert(/^0 BRDPs will be included/.test(g.counter), "boxes checked: counter 0", g.counter);
    const noRules = await page.getByTestId("generate-no-rules").innerText();
    assert(noRules.includes("No rule has been included") && noRules.includes("6 BRDPs omitted because they are not Validated") && noRules.includes('Uncheck "Only include Validated BRDPs"'), "nothing included: why, and which box changes it", noRules);
    assert(g.xml === null, "… and no document");
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-generate-no-rules.png") });
    g = await generate(page, p2.id, { onlyValidated: false, onlyVerified: false });
    assert(/^6 BRDPs will be included/.test(g.counter), "boxes unchecked: counter 6", g.counter);
    assert((await page.getByTestId("generate-rules-included").innerText()) === "6 rules included", "6 rules included (the counter)");
    assert((await page.getByTestId("generate-drafts-included").locator("summary").innerText()).includes("6 Draft rules included"), "amber: 6 Draft rules included");
    assert((g.xml.match(/<pattern id="p-BRDP-EXT-/g) || []).length === 8, "the 8 patterns of the 6 Draft rules are in the document");
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-generate-drafts.png") });
    await page.locator("header select, nav select").first().selectOption("es");
    g = await generate(page, p2.id, { onlyValidated: false, onlyVerified: false });
    assert((await page.getByTestId("generate-drafts-included").locator("summary").innerText()).includes("6 reglas en Borrador incluidas"), "ES: 6 reglas en Borrador incluidas");
    g = await generate(page, p2.id, { onlyValidated: true, onlyVerified: true });
    const noRulesEs = await page.getByTestId("generate-no-rules").innerText();
    assert(noRulesEs.includes("No se ha incluido ninguna regla") && noRulesEs.includes("6 BRDPs omitidos por no estar validados"), "ES: No se ha incluido ninguna regla, with the reason", noRulesEs);
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-generate-no-rules-es.png") });
    await page.locator("header select, nav select").first().selectOption("en");

    // xpath3 refused in an Xpath2.0 project (a new file replaces nothing).
    await openConfig(page, p2.id);
    await page.getByTestId("rule-extract-file").setInputFiles(XPATH3);
    await page.getByTestId("rule-extract-error").waitFor();
    assert((await page.getByTestId("rule-extract-error").innerText()).includes('queryBinding="xslt3" (XPath 3.0); this project is DITA 1.3 Xpath2.0'), "xpath3 refused in an Xpath2.0 project, with the reason");

    // ── Lufthansa: search, sort, mark the shown ones ────────────────────────
    console.log("\nLufthansa BREX → empty S1000D 4.2 project (search, sort, generate)");
    const lh = await createProject("AI Extract LH search", "S1000D 4.2", { modelIdentCode: "LHTSTD" });
    projects.push(lh);
    await openConfig(page, lh.id);
    await uploadAndReview(page, LUFTHANSA);
    await lufthansaS1AsNewExt(page, lh.id);
    assert((await page.getByTestId("rule-extract-shown").innerText()) === "502 of 502", "counter 502 of 502");
    const search = page.getByTestId("rule-extract-search");
    await search.fill("00117");
    assert((await page.getByTestId("rule-extract-shown").innerText()) === "1 of 502" && (await row(page, "BRDP-S1-00117").count()) === 1, "search '00117': only S1-00117 (1 of 502)");
    await search.fill("CAPTION");
    const captionRows = await page.getByTestId("rule-extract-row").count();
    const captionTitles = await page.getByTestId("rule-extract-row").evaluateAll((rows) => rows.map((r) => r.querySelector('[data-testid="rule-extract-title"]')?.value || r.innerText));
    assert(captionRows > 0 && captionTitles.every((t) => /caption/i.test(t)), `search 'CAPTION' (any case): ${captionRows} rows, all with 'caption' in the title`, captionTitles.join(" | "));
    await page.getByRole("button", { name: "Clear all shown" }).click();
    await page.waitForTimeout(800);
    {
      const { list } = await candidates(lh.id);
      const cleared = list.filter((c) => !c.selected && /caption/i.test(c.title));
      const otherCleared = list.filter((c) => !c.selected && !/caption/i.test(c.title) && ["new_ext", "catalog", "other_spec", "changed"].includes(c.classification));
      assert(cleared.length === captionRows && otherCleared.length === 0, "'Clear all shown' cleared only the shown rows", `${cleared.length} cleared, ${otherCleared.length} others`);
    }
    await page.getByRole("button", { name: "Select all shown" }).click();
    await page.waitForTimeout(800);
    // A row whose source ID is an S1 identifier missing from the catalog is a
    // new EXT: searching its source ID finds it.
    {
      const { list } = await candidates(lh.id);
      const ext = list.find((c) => c.classification === "new_ext" && c.origin_identifier?.startsWith("BRDP-S1-"));
      await search.fill(ext.origin_identifier.replace("BRDP-", ""));
      const ids = await shownIdentifiers(page);
      assert(ids.length === 1 && ids[0] === ext.identifier, `search the source ID ${ext.origin_identifier} of a row now ${ext.identifier}: that row`, ids.join(","));
    }
    await search.fill("");
    await page.getByTestId("rule-extract-sort-id").click();
    let ids = await shownIdentifiers(page);
    assert(JSON.stringify(ids) === JSON.stringify([...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))), "ID header: ascending", ids.slice(0, 3).join(","));
    await page.getByTestId("rule-extract-sort-id").click();
    ids = await shownIdentifiers(page);
    assert(JSON.stringify(ids) === JSON.stringify([...ids].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))), "ID header again: descending", ids.slice(0, 3).join(","));
    await page.getByTestId("rule-extract-sort-id").click();
    {
      const { list } = await candidates(lh.id);
      ids = await shownIdentifiers(page);
      assert(JSON.stringify(ids) === JSON.stringify(list.slice(0, ids.length).map((c) => c.identifier)), "third click: file order", ids.slice(0, 3).join(","));
    }
    await page.getByTestId("rule-extract-sort-title").click();
    const titles = await page.getByTestId("rule-extract-row").evaluateAll((rows) => rows.map((r) => r.querySelector('[data-testid="rule-extract-title"]')?.value ?? r.querySelector('[data-testid="rule-extract-title-text"]').textContent));
    assert(JSON.stringify(titles) === JSON.stringify([...titles].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))), "Title header: ascending");
    await page.getByTestId("rule-extract-sort-title").click();
    await page.getByTestId("rule-extract-sort-title").click();
    await page.getByTestId("rule-extract-filter").selectOption("new_ext");
    await search.fill("00");
    const shown = await page.getByTestId("rule-extract-shown").innerText();
    const rows = await page.getByTestId("rule-extract-class").evaluateAll((s) => s.map((x) => x.value));
    assert(rows.every((v) => v === "new_ext") && /^\d+ of 502$/.test(shown), `search and 'Show: New EXT' together (${shown})`);
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-search-sort.png") });
    await page.getByTestId("rule-extract-filter").selectOption("all");
    await search.fill("");
    // Everything selected, then imported "Pending review".
    await page.getByRole("button", { name: "Select all shown" }).click();
    await page.waitForTimeout(1500);
    await importAs(page, "pending", 502);

    g = await generate(page, lh.id, { onlyValidated: false, onlyVerified: false });
    assert(/^502 BRDPs will be included/.test(g.counter), "Lufthansa pending, boxes unchecked: 502 included", g.counter);
    assert((g.xml.match(/<structureObjectRule\b/g) || []).length === 61 && (g.xml.match(/<nonContextRule\b/g) || []).length === 469, "61 structureObjectRule + 469 nonContextRule in the BREX");
    {
      // One context block per schema: general 40, ddn 2, condcrossreftable 1,
      // fault 1, prdcrossreftable 1, proced 4, ipd 3, pm 1, comrep 8.
      const blocks = [...g.xml.matchAll(/<contextRules\b([^>]*)>([\s\S]*?)<\/contextRules>/g)].map((b) => {
        const ctx = /rulesContext="([^"]*)"/.exec(b[1]);
        return `${ctx ? ctx[1].replace(/^.*\//, "").replace(/\.xsd$/, "") : "general"} ${(b[2].match(/<structureObjectRule\b/g) || []).length}`;
      });
      assert(blocks.join(", ") === "general 40, ddn 2, condcrossreftable 1, fault 1, prdcrossreftable 1, proced 4, ipd 3, pm 1, comrep 8", "one context block per schema, with its rules", blocks.join(", "));
      assert((await page.getByTestId("schema-urls-unrecognized").count()) === 0, "no schema URL warning");
    }
    assert((await page.getByTestId("generate-drafts-included").locator("summary").innerText()).includes("502 Draft rules included"), "amber: 502 Draft rules included");
    g = await generate(page, lh.id, { onlyValidated: true, onlyVerified: true });
    assert((await page.getByTestId("generate-no-rules").innerText()).includes("No rule has been included"), "boxes checked: No rule has been included, with the reason");

    // ── Lufthansa "Already in force" ────────────────────────────────────────
    console.log("\nLufthansa BREX imported 'Already in force'");
    const lf = await createProject("AI Extract LH in force", "S1000D 4.2", { modelIdentCode: "LHTSTD" });
    projects.push(lf);
    await openConfig(page, lf.id);
    await uploadAndReview(page, LUFTHANSA);
    await page.getByRole("button", { name: "Select all shown" }).click();
    await page.waitForTimeout(1500);
    await importAs(page, "in_force", 502);
    g = await generate(page, lf.id);
    assert(/^502 BRDPs will be included/.test(g.counter), "in force, boxes checked: 502 included", g.counter);
    assert((g.xml.match(/<structureObjectRule\b/g) || []).length === 61 && (g.xml.match(/<nonContextRule\b/g) || []).length === 469, "61 structureObjectRule + 469 nonContextRule");
    assert((await page.getByTestId("generate-drafts-included").count()) === 0 && (await page.getByTestId("generate-omitted-draft").count()) === 0, "no Draft warning");
    // 4 rules back to Draft, box checked: left out, listed.
    const brdps = (await api(`/api/projects/${lf.id}/brdps`)).slice(0, 4);
    for (const b of brdps) await api(`/api/projects/${lf.id}/brdps/${b.id}/approvals/BREX-4.2/revoke`, { method: "POST" });
    g = await generate(page, lf.id);
    const omitted = page.getByTestId("generate-omitted-draft");
    assert((await omitted.locator("summary").innerText()).includes("4 rules omitted because they are in Draft"), "4 rules omitted because they are in Draft");
    await omitted.locator("summary").click();
    const listed = await omitted.locator("li").allInnerTexts();
    assert(brdps.every((b) => listed.includes(b.identifier)) && listed.length === 4, "… with the list", listed.join(","));
    assert(/^498 BRDPs will be included/.test(g.counter) && (await page.getByTestId("generate-rules-included").innerText()) === "498 rules included", "counter 498 = rules included");
    await page.screenshot({ path: path.join(SHOTS, "ai-extract-generate-omitted-drafts.png") });
  } finally {
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" }).catch((e) => console.log(`cleanup: ${e.message}`));
    await browser.close();
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
