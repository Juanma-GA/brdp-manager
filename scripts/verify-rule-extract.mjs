// AI Extract (1/2) in a real browser, against the real backend and Postgres
// (LLM and embeddings through the local simulators, as in every other
// verify script):
//   - the Lufthansa client BREX into an empty S1000D 4.2 project: the
//     review table, the AI's texts, a few rows imported, one opened in BRDP
//     Records (Proposal Pending, rule Draft, history with the source), and
//     a re-import that finds everything already there ("same");
//   - the "CA" BREX (5,536 rules) into another empty 4.2 project, timed;
//   - a 3.0.1 BREX refused in a 4.2 project; the screen in EN and ES.
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
    assert(/From catalog: \d+/.test(counts) && /New EXT: \d+/.test(counts), "classified as From catalog / New EXT", counts);

    let r = await showRowOf(page, "BRDP-S1-00117");
    assert((await r.getByTestId("rule-extract-class").inputValue()) === "catalog", "S1-00117 is From catalog");
    assert((await r.getByTestId("rule-extract-proposal").inputValue()).includes("Captions shall not be used"), "S1-00117 Proposal written from its nonContextRule decision text");
    await r.getByTestId("rule-extract-rule-summary").click();
    assert((await r.innerText()).includes("//caption"), "S1-00117 rule visible when expanded");

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
    assert(result.includes("Created: 4"), "summary: 4 created", result);
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

    // ── 3.0.1 BREX in a 4.2 project ────────────────────────────────────────
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
    for (const p of projects) await api(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
