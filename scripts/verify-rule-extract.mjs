// AI Extract (1/2) in a real browser, against the real backend and Postgres
// (LLM and embeddings through the local simulators, as in every other
// verify script):
//   - the Lufthansa client BREX into an empty S1000D 4.2 project: the
//     review table, the AI's texts, a few rows imported, one opened in BRDP
//     Records (Proposal Pending, rule Draft, history with the source), and
//     a re-import that finds everything already there ("same");
//   - the "CA" BREX (5,536 rules) into another empty 4.2 project, timed;
//   - a 3.0.1 BREX refused in a 4.2 project; the screen in EN and ES;
//   - nonContextRules: part of the rule, their paragraphs taken literally
//     (no AI), and the whole Lufthansa BREX imported, approved and generated
//     again with its 469 nonContextRules;
//   - BREX-S1-… of the "CA" BREX: "Default rule of S1000D", unchecked, its
//     Title and Definition written by the AI anyway (its Proposal is its
//     objectUse).
// Needs the 4.2 catalog of the repo loaded:
//     cd backend && .venv/bin/python scripts/seed_extract_catalog_42.py   (cleanup afterwards)
//
//     node scripts/verify-rule-extract.mjs
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
const FIXTURES = fileURLToPath(new URL("../backend/tests/fixtures/brex/", import.meta.url));
const LUFTHANSA = path.join(FIXTURES, "DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml");
const CA = path.join(FIXTURES, "DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml");
const SHOTS = os.tmpdir();

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

async function createProject(name, standard) {
  return api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `${name} ${Date.now()}`, standard, project_config: {}, seed_from_catalog: false }),
  });
}

async function openConfig(page, projectId) {
  await page.goto(`${BASE_URL}/projects/${projectId}/config`);
  await page.getByTestId("rule-extract-section").waitFor();
}

async function upload(page, file) {
  await page.getByTestId("rule-extract-file").setInputFiles(file);
}

async function waitReviewDrafted(page, timeout = 240000) {
  await page.getByTestId("rule-extract-table").waitFor({ timeout });
  // Writing with the AI starts by itself; wait until it is over.
  await page.waitForTimeout(500);
  await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout });
}

function row(page, origin) {
  return page.locator(`[data-testid="rule-extract-row"][data-origin="${origin}"]`);
}

async function showRowOf(page, origin) {
  // The row may be on another page of the table: filter "all" and walk the pages.
  const pages = Number((await page.getByTestId("rule-extract-page").innerText()).match(/of (\d+)|de (\d+)/).slice(1).find(Boolean));
  for (let i = 0; i < pages; i += 1) {
    if (await row(page, origin).count()) return row(page, origin);
    await page.getByTestId("rule-extract-next").click();
  }
  throw new Error(`${origin} not found in the table`);
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = (await login.json()).access_token;
  if (!token) throw new Error(`login failed for ${EMAIL}`);
  const catalog = await api("/api/brdp-catalog/count?standard=S1000D%204.2").catch(() => null);
  console.log(`4.2 catalog rows: ${JSON.stringify(catalog)}`);

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

    // ── Lufthansa into an empty 4.2 project ────────────────────────────────
    console.log("\nLufthansa BREX → empty S1000D 4.2 project");
    const lh = await createProject("AI Extract LH", "S1000D 4.2");
    projects.push(lh);
    await openConfig(page, lh.id);
    await upload(page, LUFTHANSA);
    await waitReviewDrafted(page);
    const counts = await page.getByTestId("rule-extract-counts").innerText();
    assert(counts.includes("502 candidates"), "502 candidates from the Lufthansa BREX", counts);
    // With the real S1000D 4.1 catalog loaded, the 116 S1 identifiers the 4.2
    // catalog lacks are "From catalog (S1000D 4.1)"; without it, "New EXT".
    assert(/From catalog: \d+/.test(counts) && /(New EXT|From catalog \(S1000D 4\.1\)): \d+/.test(counts), "classified as From catalog / New EXT or From catalog (S1000D 4.1)", counts);
    {
      // This script tests the new-EXT path: those rows are reclassified as
      // "New EXT" (checked, as a new EXT is by default) -- the state it was
      // written for, before the real 4.1 catalog was loaded.
      const job = await api(`/api/projects/${lh.id}/ai-extract/jobs/active`);
      const all = (await api(`/api/projects/${lh.id}/ai-extract/jobs/${job.id}/candidates`)).candidates;
      const items = all.filter((c) => c.classification === "catalog_edition").map((c) => ({ key: c.key, classification: "new_ext", selected: true }));
      if (items.length) await api(`/api/projects/${lh.id}/ai-extract/jobs/${job.id}/candidates`, { method: "PATCH", body: JSON.stringify({ items }) });
      await page.reload();
      await waitReviewDrafted(page);
    }

    let r = await showRowOf(page, "BRDP-S1-00117");
    assert((await r.getByTestId("rule-extract-class").inputValue()) === "catalog", "S1-00117 is From catalog");
    assert((await r.getByTestId("rule-extract-proposal").inputValue()) === "Captions shall not be used.", "S1-00117 Proposal = its nonContextRule decision text, literally");
    assert((await r.getByTestId("rule-extract-source-proposal").innerText()) === "from the file", "S1-00117 Proposal tagged 'from the file'");
    assert((await r.getByTestId("rule-extract-source-title").innerText()) === "from the catalog", "S1-00117 Title tagged 'from the catalog'");
    assert((await r.getByTestId("rule-extract-rule-summary").innerText()).trim() === "1 rule + 1 nonContextRule", "S1-00117 rule = the rule + its nonContextRule");
    await r.getByTestId("rule-extract-rule-summary").click();
    assert((await r.innerText()).includes("//caption") && (await r.innerText()).includes("<nonContextRule>"), "S1-00117 rule visible when expanded, with its nonContextRule");
    await r.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-literal-s1-00117.png") });
    {
      const job = await api(`/api/projects/${lh.id}/ai-extract/jobs/active`);
      const all = (await api(`/api/projects/${lh.id}/ai-extract/jobs/${job.id}/candidates`)).candidates;
      const by = Object.fromEntries(all.map((c) => [c.origin_identifier, c]));
      const s1 = by["BRDP-S1-00001"];
      assert(s1.proposal === "Decision made by TDWG." && s1.text_sources.proposal === "file" && s1.noncontext_count === 1 && s1.rule_count === 0,
        "S1-00001 (only a nonContextRule): its rule is that nonContextRule, Proposal 'Decision made by TDWG.' from the file");
      const s52 = by["BRDP-S1-00052"];
      assert(s52.text_sources.proposal === "file" && s52.proposal === "Allowed LHT infocodes, including 055 and 930 which are not allowed in ATA CMP.",
        "S1-00052 (no nonContextRule): its one objectUse (without 'Decision by Company.') is the Proposal, from the file", s52.proposal);
      const s2 = by["BRDP-S1-00002"];
      assert(s2.text_sources.proposal === "ai" && /^MOCK-PROPOSAL/.test(s2.proposal), "S1-00002 (objectUse only 'Decision by Company.'): Proposal written by the AI", s2.proposal);
      const literal = all.filter((c) => c.text_sources?.proposal === "file").length;
      const sentToAi = all.filter((c) => (c.ai_fields || []).length > 0).length;
      const catalogLiteral = all.filter((c) => c.classification === "catalog" && c.text_sources?.proposal === "file").length;
      console.log(`       ${literal} candidates with a literal Proposal; ${catalogLiteral} catalog ones need nothing from the AI; ${sentToAi} sent to the AI (of ${all.length})`);
      assert(literal === 470 && sentToAi < all.length, "470 candidates have a literal Proposal (469 nonContextRule + S1-00052); fewer sent to the AI");
    }

    await page.goto(`${BASE_URL}/projects/${lh.id}/config`);
    await page.getByTestId("rule-extract-table").waitFor();
    r = await showRowOf(page, "BRDP-S1-00316");
    assert((await r.getByTestId("rule-extract-warnings").innerText()).includes("returns true/false"), "S1-00316 warned: the path returns true/false");
    await page.goto(`${BASE_URL}/projects/${lh.id}/config`);
    await page.getByTestId("rule-extract-table").waitFor();
    r = await showRowOf(page, "BRDP-S1-00006");
    assert((await r.getByTestId("rule-extract-rule-summary").innerText()).trim() === "4 rules", "S1-00006: general rule + 3 context blocks, one candidate");
    await r.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-lufthansa-review.png") });

    // Import only a few: clear all, then tick three.
    await page.goto(`${BASE_URL}/projects/${lh.id}/config`);
    await page.getByTestId("rule-extract-table").waitFor();
    await page.getByRole("button", { name: "Clear all shown" }).click();
    await page.waitForTimeout(500);
    const picked = ["BRDP-S1-00117", "BRDP-S1-00006", "BRDP-S1-00316"];
    for (const origin of picked) {
      await page.goto(`${BASE_URL}/projects/${lh.id}/config`);
      await page.getByTestId("rule-extract-table").waitFor();
      const target = await showRowOf(page, origin);
      await target.getByTestId("rule-extract-select").check();
      await page.waitForTimeout(300);
    }
    // A "not in catalog" S1 identifier → a new EXT: tick one too.
    const jobs = await api(`/api/projects/${lh.id}/ai-extract/jobs/active`);
    const cands = (await api(`/api/projects/${lh.id}/ai-extract/jobs/${jobs.id}/candidates`)).candidates;
    const ext = cands.find((c) => c.classification === "new_ext");
    await api(`/api/projects/${lh.id}/ai-extract/jobs/${jobs.id}/candidates`, { method: "PATCH", body: JSON.stringify({ items: [{ key: ext.key, selected: true }] }) });
    await page.goto(`${BASE_URL}/projects/${lh.id}/config`);
    await page.getByTestId("rule-extract-table").waitFor();
    assert((await page.getByTestId("rule-extract-apply").innerText()).includes("(4)"), "4 rows selected");
    await page.getByTestId("rule-extract-apply").click();
    await page.getByTestId("rule-extract-result").waitFor();
    const result = await page.getByTestId("rule-extract-result").innerText();
    assert(result.includes("Checked 4 · Created 4 · Updated 0 · Omitted 0"), "summary: checked 4 · created 4", result);
    await page.getByTestId("rule-extract-section").screenshot({ path: path.join(SHOTS, "rule-extract-lufthansa-result.png") });

    const brdps = await api(`/api/projects/${lh.id}/brdps`);
    const s117 = brdps.find((b) => b.identifier === "BRDP-S1-00117");
    assert(s117 && s117.validation === "Pending", "S1-00117 created with Proposal Pending");
    const approval = await api(`/api/projects/${lh.id}/brdps/${s117.id}/approvals/BREX-4.2`);
    assert(approval?.status === "pending_review" && approval.source === "extracted", "its rule is Draft, source extracted");
    const extBrdp = brdps.find((b) => b.identifier.startsWith("BRDP-EXT-"));
    assert(!!extBrdp && extBrdp.title.length > 0, `the new EXT got its number and title (${extBrdp?.identifier})`);

    // Open it in BRDP Records: Pending, Draft, history with the source.
    await page.addInitScript(() => sessionStorage.setItem("brdp-records-history-open", "1"));
    await page.goto(`${BASE_URL}/projects/${lh.id}/records`);
    await page.getByText("BRDP-S1-00117", { exact: true }).first().click();
    await page.getByText("Extracted from").first().waitFor();
    const panel = await page.locator("body").innerText();
    assert(panel.includes(`${path.basename(LUFTHANSA)} (source ID BRDP-S1-00117)`), "History: Extracted from <file> (source ID BRDP-S1-00117)");
    assert(/Pending/.test(panel) && /Draft/.test(panel), "Records shows Pending and Draft");
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-records-history.png") });
    // Embeddings: a Pending BRDP is never embedded in this app (only
    // Validated ones feed Suggest), so nothing is pending for the project.
    const pending = await api(`/api/projects/${lh.id}/embeddings/pending`);
    assert(pending.project_pending === 0, "the imported (Pending) BRDPs are not in the embeddings queue until validated", JSON.stringify(pending));

    // Re-import: what is already there is "same", unchecked.
    await openConfig(page, lh.id);
    await page.getByRole("button", { name: /Close|New import/ }).count();
    await upload(page, LUFTHANSA);
    await waitReviewDrafted(page);
    const job2 = await api(`/api/projects/${lh.id}/ai-extract/jobs/active`);
    const cands2 = (await api(`/api/projects/${lh.id}/ai-extract/jobs/${job2.id}/candidates`)).candidates;
    const byOrigin = Object.fromEntries(cands2.map((c) => [c.origin_identifier, c]));
    assert([...picked, ext.origin_identifier].every((o) => byOrigin[o].classification === "same" && !byOrigin[o].selected), "re-import: the 4 imported are 'Already exists (same)', unchecked");
    assert(byOrigin[ext.origin_identifier].identifier === extBrdp.identifier, "the new EXT is found again by its source ID, not given another number");

    // ── The whole Lufthansa BREX: import, approve, Generate ───────────────
    console.log("\nLufthansa BREX → import everything, approve, Generate BREX 4.2");
    const full = await createProject("AI Extract LH full", "S1000D 4.2");
    projects.push(full);
    await api(`/api/projects/${full.id}/config`, {
      method: "PUT",
      body: JSON.stringify({ project_config: { ...(full.project_config || {}), projectName: full.name, modelIdentCode: "LHTSTD" } }),
    });
    await openConfig(page, full.id);
    await upload(page, LUFTHANSA);
    await waitReviewDrafted(page);
    const fullJob = await api(`/api/projects/${full.id}/ai-extract/jobs/active`);
    const fullCands = (await api(`/api/projects/${full.id}/ai-extract/jobs/${fullJob.id}/candidates`)).candidates;
    const applied = await api(`/api/projects/${full.id}/ai-extract/jobs/${fullJob.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ keys: fullCands.map((c) => c.key) }),
    });
    assert(applied.created === 502 && applied.invalid_rule === 0, "all 502 imported, every rule valid", JSON.stringify(applied).slice(0, 200));
    const fullBrdps = await api(`/api/projects/${full.id}/brdps`);
    await Promise.all(fullBrdps.map((b) => api(`/api/projects/${full.id}/brdps/${b.id}/approvals/BREX-4.2/approve`, { method: "POST" })));
    await page.goto(`${BASE_URL}/projects/${full.id}/generate`);
    const genBtn = page.locator('button:has-text("Generate")').first();
    await genBtn.waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !document.body.innerText.includes("Loading the project's rules"), null, { timeout: 60000 });
    // The imported BRDPs are Pending: include them (their rules are approved).
    await page.getByLabel("Only include Validated BRDPs").uncheck();
    await genBtn.click();
    await page.waitForSelector("pre", { timeout: 120000 });
    await page.waitForSelector("text=/Valid against XSD schema|XSD validation issue|XSD validation failed/", { timeout: 120000 });
    const generated = await page.locator("pre").innerText();
    const ncr = (generated.match(/<nonContextRule>/g) || []).length;
    assert(ncr === 469, `the generated BREX has the 469 nonContextRules (${ncr})`);
    assert((generated.match(/<structureObjectRule>/g) || []).length === 61, "and the 61 structureObjectRules");
    assert(generated.includes("<simplePara>Decision made by Project. Captions shall not be used.</simplePara>"), "S1-00117's nonContextRule written back as it was");
    assert(await page.locator("text=Valid against XSD schema").isVisible(), "the generated BREX is valid against the XSD");
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-generate-noncontext.png") });

    // ── 3.0.1 BREX in a 4.2 project ────────────────────────────────────────
    await openConfig(page, lh.id);
    const tmp301 = path.join(os.tmpdir(), "brex-301-sample.xml");
    fs.writeFileSync(
      tmp301,
      '<?xml version="1.0"?><dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/brex.xsd"><content><brex><contextrules><structrules><objrule><objpath objappl="0">//randlist</objpath><objuse>x</objuse></objrule></structrules></contextrules></brex></content></dmodule>'
    );
    await upload(page, tmp301);
    await page.getByTestId("rule-extract-error").waitFor();
    assert((await page.getByTestId("rule-extract-error").innerText()).includes("This is a BREX for S1000D 3.0.1; this project is S1000D 4.2"), "3.0.1 BREX refused with the reason");

    // ── Spanish ─────────────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}/projects/${lh.id}/config`);
    await page.locator("header select, nav select").first().selectOption("es");
    await page.getByTestId("rule-extract-table").waitFor();
    const es = await page.getByTestId("rule-extract-section").innerText();
    assert(es.includes("Importar desde BREX / Schematron") && es.includes("Ya existe (igual)"), "ES: section title and classifications");
    assert(es.includes("del fichero") || es.includes("del proyecto"), "ES: text sources");
    await page.getByTestId("rule-extract-table").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-review-es.png") });
    await page.locator("header select, nav select").first().selectOption("en");

    // ── The CA BREX (5,536 rules, 533 IDs), timed ─────────────────────────
    console.log("\nCA BREX → empty S1000D 4.2 project");
    const ca = await createProject("AI Extract CA", "S1000D 4.2");
    projects.push(ca);
    await openConfig(page, ca.id);
    const t0 = Date.now();
    await upload(page, CA);
    await page.getByTestId("rule-extract-progress").waitFor().catch(() => {});
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 120000 });
    const tParsed = Date.now() - t0;
    await waitReviewDrafted(page, 600000);
    const tDrafted = Date.now() - t0;
    const caCounts = await page.getByTestId("rule-extract-counts").innerText();
    assert(caCounts.includes("533 candidates"), "533 candidates", caCounts);
    console.log(`       read + classified (background job, until the table): ${(tParsed / 1000).toFixed(1)} s; + AI texts for every candidate (simulator): ${(tDrafted / 1000).toFixed(1)} s; ${caCounts.match(/\(read[^)]*\)/)?.[0] || ""}`);
    const t1 = Date.now();
    await page.getByTestId("rule-extract-next").click();
    await page.getByTestId("rule-extract-page").filter({ hasText: "Page 2" }).waitFor();
    const tPage = Date.now() - t1;
    assert(tPage < 1500, `next page of 533 candidates in ${tPage} ms`);
    await page.getByTestId("rule-extract-prev").click();
    const s7 = await showRowOf(page, "BRDP-S1-00007");
    assert((await s7.getByTestId("rule-extract-rule-summary").innerText()).includes("4500 rules"), "S1-00007 shows 4500 rules");
    await s7.getByTestId("rule-extract-rule-summary").click();
    assert((await s7.getByTestId("rule-extract-rule-more").innerText()).trim() === "+4480 more", "and its first 20 rules, +4480 more");
    assert((await s7.getByTestId("rule-extract-warnings").innerText()).includes("schema URLs of S1000D 4.1"), "S1-00007 warned: S1000D 4.1 schema URLs");
    await s7.screenshot({ path: path.join(SHOTS, "rule-extract-ca-s1-00007.png") });
    const caJob = await api(`/api/projects/${ca.id}/ai-extract/jobs/active`);
    const caCands = (await api(`/api/projects/${ca.id}/ai-extract/jobs/${caJob.id}/candidates`)).candidates;
    const s2 = caCands.find((c) => c.origin_identifier === "BRDP-S2-00002");
    assert(s2.classification === "other_spec" && s2.identifier === "BRDP-S2-00002" && s2.title, "BRDP-S2-00002: Other specification (S2000M), same ID, title written by the AI");
    await page.goto(`${BASE_URL}/projects/${ca.id}/config`);
    await page.getByTestId("rule-extract-filter").selectOption("other_spec");
    const s2row = row(page, "BRDP-S2-00002");
    assert((await s2row.getByTestId("rule-extract-class").locator("option:checked").innerText()).includes("Other specification (S2000M)"), "shown as 'Other specification (S2000M)'");
    // BREX-S1-…: default rules of S1000D, unchecked, with the note.
    const defaults = caCands.filter((c) => c.origin_identifier.startsWith("BREX-S1-"));
    assert(defaults.length === 243 && defaults.every((c) => c.classification === "default_rule" && !c.selected), "243 BREX-S1-… as 'Default rule of S1000D', unchecked");
    assert(defaults.every((c) => c.draft_status === "drafted" && c.title && c.definition && c.text_sources.proposal === "file"),
      "unchecked default rules get their Title and Definition from the AI anyway; their Proposal is their objectUse");
    await page.goto(`${BASE_URL}/projects/${ca.id}/config`);
    await page.getByTestId("rule-extract-filter").selectOption("default_rule");
    const b1 = row(page, "BREX-S1-00001");
    assert((await b1.getByTestId("rule-extract-class").locator("option:checked").innerText()) === "Default rule of S1000D", "shown as 'Default rule of S1000D'");
    assert((await b1.getByTestId("rule-extract-warnings").innerText()).includes("default BREX; a project BREX normally inherits it"), "with the note");
    assert(!(await b1.getByTestId("rule-extract-select").isChecked()), "unchecked");
    const callsBefore = (await (await fetch("http://localhost:8902/extract-calls")).json()).calls;
    await b1.getByTestId("rule-extract-select").check();
    await page.waitForTimeout(1500);
    const b1After = (await api(`/api/projects/${ca.id}/ai-extract/jobs/${caJob.id}/candidates`)).candidates.find((c) => c.origin_identifier === "BREX-S1-00001");
    const callsAfter = (await (await fetch("http://localhost:8902/extract-calls")).json()).calls;
    assert(b1After.selected && b1After.draft_status === "drafted" && b1After.title && callsAfter === callsBefore, "checked → already written, no new AI call");
    await b1.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-default-rule.png") });
    // Import the 4,500-rule candidate: kept whole.
    await api(`/api/projects/${ca.id}/ai-extract/jobs/${caJob.id}/candidates`, {
      method: "PATCH",
      body: JSON.stringify({ items: caCands.map((c) => ({ key: c.key, selected: c.origin_identifier === "BRDP-S1-00007" })) }),
    });
    await page.goto(`${BASE_URL}/projects/${ca.id}/config`);
    await page.getByTestId("rule-extract-apply").click();
    await page.getByTestId("rule-extract-result").waitFor();
    const caBrdp = (await api(`/api/projects/${ca.id}/brdps`))[0];
    const caRule = await api(`/api/projects/${ca.id}/brdps/${caBrdp.id}/approvals/BREX-4.2`);
    assert((caRule.rule_xml.match(/<structureObjectRule>/g) || []).length === 4500, "S1-00007 imported with its 4500 rules");
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
