// AI Extract: Proposal from the file, texts in every row, safe import and
// another edition's catalog -- in a real browser, against the real backend
// and Postgres (LLM and embeddings through the local simulators):
//   - the "CA" BREX into an empty S1000D 4.2 project: 175 From catalog, 108
//     From catalog (S1000D 4.1), 7 Other specification, 243 Default rule;
//     533 Proposals from the file; the AI writes 250 rows (checked first),
//     "Writing texts: N / 250";
//   - the backend restarted while the AI is writing: no row lost or
//     unchecked, the page resumes by itself after a reload, the import stays
//     blocked until every checked row has its texts; the summary adds up;
//   - failed rows: the block with its counts, "Show them", "Retry the
//     failed", unchecking one, writing one by hand; a direct /apply with a
//     row still failed is a 409 with its identifier;
//   - "From catalog (S1000D 4.1)": unchecked, with its warning and the 4.1
//     catalog's texts; two options only ("marked" was retired: a direct
//     request with it is a 422); bulk classify the shown rows as New EXT
//     and back; imported with the original identifier and as new EXT;
//     History; a re-import finds them, also a BRDP with the old suffix
//     (BRDP-S1-xxxxx-4.1), which keeps its label, BRDP Records search, Ask
//     and the Excel export;
//   - bulk classify offers only the options valid for every shown row.
// Needs both catalogs loaded -- 4.2 from sources/, and the real 4.1 one of
// the repo (552 identifiers; it has the 108 BRDP-S1 identifiers of the "CA"
// BREX that the 4.2 catalog lacks):
//     cd backend && .venv/bin/python scripts/seed_extract_catalog_42.py
//     cd backend && .venv/bin/python scripts/import_brdp_catalog.py catalog_sources/s1000d_4.1.xlsx "S1000D 4.1"
// and restarts the backend once (kills the uvicorn process by its exact
// PID and starts it again with the same mock endpoints).
//
//     node scripts/verify-rule-extract-safe-import.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CA = path.join(ROOT, "backend/tests/fixtures/brex/DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml");
// Five project decisions (EXT identifiers, one objectUse each): new EXT,
// checked, the AI writes their Title and Definition.
const SMALL = path.join(os.tmpdir(), "brex-42-five-ext.xml");
fs.writeFileSync(
  SMALL,
  '<?xml version="1.0"?><dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd"><identAndStatusSection/><content><brex><contextRules><structureObjectRuleGroup>' +
    [1, 2, 3, 4, 5]
      .map((i) => `<structureObjectRule><objectPath allowedObjectFlag="0">//elem${i}</objectPath><objectUse>BRDP-EXT-0000${i}. Element ${i} shall not be used.</objectUse></structureObjectRule>`)
      .join("") +
    "</structureObjectRuleGroup></contextRules></brex></content></dmodule>"
);
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
const mock = (p, body) => fetch(`${MOCK}${p}`, { method: "POST", body: JSON.stringify(body || {}) }).then((r) => r.json());

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = (await res.json()).access_token;
  if (!token) throw new Error(`login failed for ${EMAIL}`);
}

async function createProject(name, standard) {
  return api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `${name} ${Date.now()}`, standard, project_config: {}, seed_from_catalog: false }),
  });
}

async function candidatesOf(projectId) {
  const job = await api(`/api/projects/${projectId}/ai-extract/jobs/active`);
  return { job, cands: (await api(`/api/projects/${projectId}/ai-extract/jobs/${job.id}/candidates`)).candidates };
}

const complete = (c) =>
  ["same", "changed", "empty"].includes(c.classification) || (c.ai_fields || []).every((f) => (c[f] || "").trim());

// The backend restarted: kill uvicorn by its exact PID, start it again with
// the same environment (the mock endpoints), wait until it answers.
function uvicornPid() {
  const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => /uvicorn app\.main:app/.test(l) && !/ps -eo/.test(l));
  return line ? Number(line.trim().split(/\s+/)[0]) : null;
}
async function waitBackend(up) {
  for (let i = 0; i < 120; i += 1) {
    const ok = await fetch(`${API}/docs`).then((r) => r.ok).catch(() => false);
    if (ok === up) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not come ${up ? "up" : "down"}`);
}
async function restartBackend() {
  const pid = uvicornPid();
  if (!pid) throw new Error("uvicorn not found");
  process.kill(pid, "SIGTERM");
  await waitBackend(false);
  const venv = path.join(ROOT, "backend/.venv/bin/uvicorn");
  const log = fs.openSync(path.join(os.tmpdir(), "uvicorn-restarted.log"), "a");
  spawn(venv, ["app.main:app", "--host", "0.0.0.0", "--port", "8000"], {
    cwd: path.join(ROOT, "backend"),
    env: {
      ...process.env,
      MISTRAL_ENDPOINT: process.env.MISTRAL_ENDPOINT || "http://localhost:8902",
      MISTRAL_EMBED_ENDPOINT: process.env.MISTRAL_EMBED_ENDPOINT || "http://localhost:8901",
    },
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
  await waitBackend(true);
  return pid;
}

function row(page, origin) {
  return page.locator(`[data-testid="rule-extract-row"][data-origin="${origin}"]`);
}

async function main() {
  await login();
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
    await mock("/reset");
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);

    // ── CA into an empty 4.2 project, the backend restarted mid-writing ────
    console.log('\n"CA" BREX → empty S1000D 4.2 project; backend restarted while the AI writes');
    const ca = await createProject("AI Extract safe import", "S1000D 4.2");
    projects.push(ca);
    await mock("/extract-delay", { ms: 1200 });
    await page.goto(`${BASE_URL}/projects/${ca.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(CA);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 120000 });
    let { job, cands } = await candidatesOf(ca.id);
    const byClass = {};
    for (const c of cands) byClass[c.classification] = (byClass[c.classification] || 0) + 1;
    console.log(`       classifications: ${JSON.stringify(byClass)}`);
    assert(byClass.catalog === 175 && byClass.catalog_edition === 108 && byClass.other_spec === 7 && byClass.default_rule === 243,
      "175 From catalog, 108 From catalog (S1000D 4.1), 7 Other specification, 243 Default rule", JSON.stringify(byClass));
    const fromFile = cands.filter((c) => c.text_sources?.proposal === "file").length;
    const forAi = cands.filter((c) => (c.ai_fields || []).length > 0).length;
    console.log(`       Proposals from the file: ${fromFile} of ${cands.length}; rows the AI writes: ${forAi}`);
    assert(fromFile === 533, "533 of 533 Proposals from the file");
    assert(forAi === 250, "250 rows for the AI (Title and Definition: 7 other spec + 243 default rules)");
    const counts = await page.getByTestId("rule-extract-counts").innerText();
    assert(counts.includes("From catalog (S1000D 4.1): 108"), "counts name the edition: 'From catalog (S1000D 4.1): 108'", counts);

    await page.getByTestId("rule-extract-drafting").waitFor();
    const progress = await page.getByTestId("rule-extract-drafting").innerText();
    assert(/Writing texts: \d+ \/ 250/.test(progress), `progress with the real total: "${progress.trim()}"`);
    assert(await page.getByTestId("rule-extract-apply").isDisabled(), "import disabled while writing");
    // Checked rows are written first: the 7 other-spec rows (checked) before
    // the 243 default rules (unchecked).
    await page.waitForFunction(() => /Writing texts: (?:[3-9]\d|1\d\d)/.test(document.body.innerText), null, { timeout: 120000 });
    ({ cands } = await candidatesOf(ca.id));
    const otherSpecDone = cands.filter((c) => c.classification === "other_spec").every(complete);
    assert(otherSpecDone, "the checked rows (Other specification) were written first");
    const selectedBefore = new Set(cands.filter((c) => c.selected).map((c) => c.key));
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-drafting-progress.png") });

    const oldPid = await restartBackend();
    console.log(`       backend restarted (old PID ${oldPid}, new PID ${uvicornPid()})`);
    // The page keeps going: batches whose answer or save failed go back to
    // pending. Wait for this round to end, then come back to the screen.
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 300000 });
    await login();
    ({ cands } = await candidatesOf(ca.id));
    const selectedAfter = new Set(cands.filter((c) => c.selected).map((c) => c.key));
    assert(cands.length === 533, "no row lost: 533 candidates after the restart");
    assert(selectedAfter.size === selectedBefore.size && [...selectedBefore].every((k) => selectedAfter.has(k)),
      `no row unchecked (${selectedBefore.size} checked before and after)`);
    const pendingAfterRestart = cands.filter((c) => !complete(c)).length;
    console.log(`       rows still without texts after the restart: ${pendingAfterRestart}`);
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    if (pendingAfterRestart > 0) {
      await page.getByTestId("rule-extract-drafting").waitFor({ timeout: 20000 });
      assert(true, "after a reload the pending rows keep being written by themselves");
      assert(await page.getByTestId("rule-extract-apply").isDisabled(), "import still blocked while writing");
    }
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 300000 });
    ({ cands } = await candidatesOf(ca.id));
    // A batch whose AI call failed twice while the backend was down, and
    // whose "failed" was saved once it was back, is a failed row: it waits
    // for "Retry the failed" (never re-sent on its own).
    const pendingNow = cands.filter((c) => !complete(c) && c.draft_status !== "failed").length;
    const failedNow = cands.filter((c) => !complete(c) && c.draft_status === "failed").length;
    console.log(`       after resuming: ${pendingNow} pending, ${failedNow} failed`);
    assert(pendingNow === 0, "no row left pending after resuming");
    if (failedNow > 0) {
      await page.getByTestId("rule-extract-retry-failed").click();
      await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 300000 }).catch(() => {});
      await page.waitForTimeout(1000);
      ({ cands } = await candidatesOf(ca.id));
    }
    assert(cands.every(complete), "every row has its texts now, checked or not (default rules included)");
    await mock("/extract-delay", { ms: 0 });

    // ── Another edition's catalog + bulk classify ──────────────────────────
    console.log("\nFrom catalog (S1000D 4.1)");
    await page.getByTestId("rule-extract-filter").selectOption("catalog_edition");
    const ed = cands.filter((c) => c.classification === "catalog_edition");
    const first = ed[0];
    const r1 = row(page, first.origin_identifier);
    assert((await r1.getByTestId("rule-extract-class").locator("option:checked").innerText()) === "From catalog (S1000D 4.1)", "label 'From catalog (S1000D 4.1)'");
    assert(!(await r1.getByTestId("rule-extract-select").isChecked()), "unchecked by default");
    assert((await r1.getByTestId("rule-extract-warnings").innerText()).includes(`${first.origin_identifier} is not in the S1000D 4.2 catalog; it is in S1000D 4.1.`), "with its warning");
    assert((await r1.getByTestId("rule-extract-source-title").innerText()) === "from the S1000D 4.1 catalog", "Title tagged 'from the S1000D 4.1 catalog'");
    const catalog41 = new Map((await api(`/api/brdp-catalog?standard=${encodeURIComponent("S1000D 4.1")}`)).map((e) => [e.identifier, e]));
    assert(catalog41.size === 552, `the real S1000D 4.1 catalog is loaded (${catalog41.size} identifiers)`);
    assert(first.title === catalog41.get(first.origin_identifier)?.title && first.title && first.text_sources.proposal === "file", "Title from the 4.1 catalog, Proposal from the file", first.title);
    const opts = await r1.getByTestId("rule-extract-class").locator("option").allInnerTexts();
    assert(opts.join(" | ") === "From catalog (S1000D 4.1) | New EXT", `two options: ${opts.join(" | ")}`);
    await r1.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-catalog-edition.png") });
    const filterOpts = await page.getByTestId("rule-extract-filter").locator("option").allInnerTexts();
    assert(!filterOpts.some((o) => /marked/.test(o)), `the "Show" filter has no "marked" (${filterOpts.length} options)`);
    // The retired classification in a direct request: refused with its reason.
    const refused = await fetch(`${API}/api/projects/${ca.id}/ai-extract/jobs/${job.id}/candidates`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: [{ key: first.key, classification: "catalog_edition_marked" }] }),
    });
    const refusedBody = await refused.json();
    assert(refused.status === 422 && /retired/.test(refusedBody.detail || ""), `direct PATCH with the retired option: ${refused.status} ${refusedBody.detail}`);
    // Bulk classify the 108 shown as New EXT and back.
    const bulkOpts = await page.getByTestId("rule-extract-classify-shown").locator("option").allInnerTexts();
    assert(bulkOpts.slice(1).join(" | ") === "From catalog (S1000D 4.1) | New EXT", `bulk classify offers the two: ${bulkOpts.slice(1).join(" | ")}`);
    await page.getByTestId("rule-extract-classify-shown").selectOption("new_ext");
    await page.waitForTimeout(1500);
    ({ cands } = await candidatesOf(ca.id));
    const edKeys = new Set(ed.map((e) => e.key));
    assert(cands.filter((c) => edKeys.has(c.key)).every((c) => c.classification === "new_ext" && /^BRDP-EXT-/.test(c.identifier)), "the 108 as New EXT");
    await page.getByTestId("rule-extract-filter").selectOption("new_ext");
    await page.getByTestId("rule-extract-search").fill("BRDP-S1-");
    await page.waitForTimeout(300);
    await page.getByTestId("rule-extract-classify-shown").selectOption("catalog_edition");
    await page.waitForTimeout(1500);
    await page.getByTestId("rule-extract-search").fill("");
    ({ cands } = await candidatesOf(ca.id));
    const back = cands.filter((c) => edKeys.has(c.key));
    assert(back.every((c) => c.classification === "catalog_edition" && c.identifier === c.origin_identifier), "and back: the 108 with their original identifier");
    // Choose: o1 imported as is, o3 as New EXT; o2 already in the project
    // with the old suffix (as an earlier extraction left it): not imported now.
    const [o1, o2, o3] = back;
    const suffixed = `${o2.origin_identifier}-4.1`;
    await api(`/api/projects/${ca.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: suffixed, title: catalog41.get(o2.origin_identifier).title }) });
    await api(`/api/projects/${ca.id}/ai-extract/jobs/${job.id}/candidates`, {
      method: "PATCH",
      body: JSON.stringify({ items: [
        { key: o1.key, selected: true },
        { key: o3.key, classification: "new_ext", selected: true },
      ] }),
    });
    // Mixed rows: only the options valid for all of them.
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor();
    await page.getByTestId("rule-extract-filter").selectOption("all");
    const mixed = await page.getByTestId("rule-extract-classify-shown").locator("option").allInnerTexts();
    assert(mixed.slice(1).join(" | ") === "New EXT", `mixed rows: only 'New EXT' offered (${mixed.slice(1).join(" | ")})`);
    await page.getByTestId("rule-extract-search").fill("zzz-nothing");
    await page.waitForTimeout(200);
    assert(await page.getByTestId("rule-extract-classify-shown").isDisabled(), "no row shown: bulk classify disabled");
    await page.getByTestId("rule-extract-search").fill("");

    // ── Import: the summary adds up ─────────────────────────────────────────
    console.log("\nImport");
    ({ cands } = await candidatesOf(ca.id));
    const checked = cands.filter((c) => c.selected);
    assert(!(await page.getByTestId("rule-extract-apply").isDisabled()), `import enabled: every checked row (${checked.length}) has its texts`);
    await page.getByTestId("rule-extract-apply").click();
    await page.getByTestId("rule-extract-result").waitFor({ timeout: 60000 });
    const summary = await page.getByTestId("rule-extract-result-summary").innerText();
    const m = summary.match(/Checked (\d+) · Created (\d+) · Updated (\d+) · Omitted (\d+)/);
    assert(!!m && Number(m[1]) === checked.length && Number(m[2]) + Number(m[3]) + Number(m[4]) === Number(m[1]), `summary adds up: "${summary}"`);
    assert(!(await page.getByTestId("rule-extract-result-missing").count()), "no 'went nowhere' error");
    const brdps = await api(`/api/projects/${ca.id}/brdps`);
    assert(brdps.length === Number(m[2]) + 1, `the project has the ${m[2]} created BRDPs and the suffixed one`);
    await page.getByTestId("rule-extract-result").screenshot({ path: path.join(SHOTS, "rule-extract-import-summary.png") });
    const ids = new Set(brdps.map((b) => b.identifier));
    assert(ids.has(o1.origin_identifier) && [...ids].some((i) => /^BRDP-EXT-/.test(i)) && ![...ids].some((i) => i !== suffixed && /-4\.1$/.test(i)),
      `imported: ${o1.origin_identifier} and a new EXT for ${o3.origin_identifier}, never a suffixed identifier`);
    const b1 = brdps.find((b) => b.identifier === o1.origin_identifier);
    const b2 = brdps.find((b) => b.identifier === suffixed);
    assert(b1.title === catalog41.get(o1.origin_identifier).title, "with the 4.1 catalog's Title");
    assert(b1.catalog_edition === "S1000D 4.1" && b2.catalog_edition === "S1000D 4.1", "both carry the 4.1 edition label (the suffixed one too)");

    // History, Records search, Ask.
    await page.addInitScript(() => sessionStorage.setItem("brdp-records-history-open", "1"));
    await page.goto(`${BASE_URL}/projects/${ca.id}/records`);
    await page.getByPlaceholder(/Search/).first().fill("-4.1");
    await page.waitForTimeout(300);
    const shown = await page.locator("tbody tr").allInnerTexts();
    assert(shown.length === 1 && shown[0].includes(b2.identifier), `search "-4.1" finds only ${b2.identifier}`);
    assert((await page.locator("tbody tr").first().getByTestId("catalog-edition-tag").innerText()) === "4.1", "the suffixed BRDP keeps its '4.1' label");
    await page.getByPlaceholder(/Search/).first().fill(o1.origin_identifier);
    await page.waitForTimeout(300);
    await page.getByText(b1.identifier, { exact: true }).first().click();
    await page.getByText("Extracted from").first().waitFor();
    const panel = await page.locator("body").innerText();
    assert(panel.includes(`(source ID ${o1.origin_identifier}); S1000D 4.1 catalog, not in S1000D 4.2`), "History: '…; S1000D 4.1 catalog, not in S1000D 4.2'");
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-history-catalog-edition.png") });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.getByText("catálogo S1000D 4.1, no existe en S1000D 4.2", { exact: false }).first().waitFor();
    assert(true, "ES: 'catálogo S1000D 4.1, no existe en S1000D 4.2'");
    await page.locator("header select, nav select").first().selectOption("en");
    await mock("/reset");
    const askBox = page.locator("textarea").filter({ hasNot: page.locator("[readonly]") }).last();
    await page.getByPlaceholder(/Search/).first().fill("-4.1");
    await page.waitForTimeout(300);
    await page.getByText(b2.identifier, { exact: true }).first().click();
    await page.getByPlaceholder(/Ask about this BRDP/).fill("What is this decision about?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("MOCK-ANSWER"), null, { timeout: 30000 });
    const last = await (await fetch(`${MOCK}/last-request`)).json();
    const system = last?.messages?.find((x) => x.role === "system")?.content || "";
    assert(system.includes(`ID: ${b2.identifier}`), `Ask sends the whole identifier (${b2.identifier})`);
    void askBox;

    // Excel export → import: the suffixed identifier comes back whole.
    const exportRows = brdps.map((b) => ({ id: b.identifier, title: b.title, definition: b.definition, proposal: b.proposal, proposalStatus: b.validation, ruleStatus: "Draft", rule: "" }));
    const xlsx = await fetch(`${API}/api/projects/${ca.id}/export.xlsx`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rows: exportRows }),
    });
    const form = new FormData();
    form.append("file", new Blob([await xlsx.arrayBuffer()]), "export.xlsx");
    const parsed = await (await fetch(`${API}/api/projects/${ca.id}/brdps/import/parse`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form })).json();
    assert(parsed.rows?.some((r) => r.identifier === b2.identifier), `Excel export → import keeps ${b2.identifier}`);

    // Re-import: found again by their origin.
    await page.goto(`${BASE_URL}/projects/${ca.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(CA);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 120000 });
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 300000 }).catch(() => {});
    ({ cands } = await candidatesOf(ca.id));
    const again = Object.fromEntries(cands.map((c) => [c.origin_identifier, c]));
    assert([o1, o3].every((o) => again[o.origin_identifier].classification === "same"), "re-import: the two imported are 'Already exists (same)'");
    assert(again[o2.origin_identifier].classification === "changed" && again[o2.origin_identifier].identifier === b2.identifier,
      `the suffixed one found as ${b2.identifier}, 'Already exists (changes)' (it had no rule): ${again[o2.origin_identifier].classification}`);

    // ── Failed rows ─────────────────────────────────────────────────────────
    console.log("\nFailed rows (the AI answers something that is not JSON)");
    const lh = await createProject("AI Extract failed rows", "S1000D 4.2");
    projects.push(lh);
    await mock("/extract-broken", { on: true });
    await page.goto(`${BASE_URL}/projects/${lh.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(SMALL);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
    await page.getByTestId("rule-extract-blocked").waitFor({ timeout: 30000 });
    ({ job, cands } = await candidatesOf(lh.id));
    const failed = cands.filter((c) => c.draft_status === "failed");
    const checkedFailed = failed.filter((c) => c.selected);
    assert(failed.length > 0 && checkedFailed.length >= 2, `${failed.length} rows failed (${checkedFailed.length} checked)`);
    const blocked = await page.getByTestId("rule-extract-blocked").innerText();
    assert(blocked.includes(`Cannot import: 0 checked rows with texts pending, ${checkedFailed.length} failed`), `blocked: "${blocked}"`);
    assert(await page.getByTestId("rule-extract-apply").isDisabled(), "import disabled");
    assert((await page.getByTestId("rule-extract-retry-failed").innerText()).includes(`Retry the ${failed.length} failed`), "'Retry the N failed' button");
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-failed-blocked.png") });
    // A direct /apply with a failed row: 409 with its identifier.
    const direct = await fetch(`${API}/api/projects/${lh.id}/ai-extract/jobs/${job.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ keys: [checkedFailed[0].key] }),
    });
    const directBody = await direct.json();
    assert(direct.status === 409 && directBody.detail.failed.length === 1, `direct /apply → 409 with ${JSON.stringify(directBody.detail.failed)}`);
    // "Show them" filters the blocking rows.
    await page.getByTestId("rule-extract-show-blocking").click();
    assert((await page.locator('[data-testid="rule-extract-row"]').count()) === checkedFailed.length, "'Show them' lists exactly the blocking rows");
    // Uncheck one (it leaves the list of blocking rows), write another by
    // hand: the block goes down accordingly.
    await page.getByTestId("rule-extract-filter").selectOption("all");
    const [u, h, ...rest] = checkedFailed;
    await row(page, u.origin_identifier).getByTestId("rule-extract-select").uncheck();
    await page.waitForTimeout(500);
    const hr = row(page, h.origin_identifier);
    for (const f of h.ai_fields) {
      await hr.getByTestId(`rule-extract-${f}`).fill(`Hand ${f} ${h.origin_identifier}`);
      await hr.getByTestId(`rule-extract-${f}`).blur();
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(500);
    const blocked2 = await page.getByTestId("rule-extract-blocked").innerText().catch(() => "");
    assert(rest.length === 0 ? blocked2 === "" : blocked2.includes(`${rest.length} failed`), `after unchecking one and writing one by hand: ${rest.length} still block`);
    await mock("/extract-broken", { on: false });
    await page.getByTestId("rule-extract-filter").selectOption("all");
    await page.getByTestId("rule-extract-retry-failed").click();
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1000);
    assert(!(await page.getByTestId("rule-extract-blocked").count()), "retried: nothing blocks the import any more");
    assert(!(await page.getByTestId("rule-extract-apply").isDisabled()), "import enabled");
    ({ cands } = await candidatesOf(lh.id));
    const hand = cands.find((c) => c.key === h.key);
    assert(hand.text_sources[h.ai_fields[0]] === "manual" && hand[h.ai_fields[0]].startsWith("Hand "), "the row written by hand kept its texts after the retry");
    const unchecked = cands.find((c) => c.key === u.key);
    assert(!unchecked.selected, "the unchecked failed row stayed unchecked");
  } finally {
    await mock("/reset").catch(() => {});
    await browser.close();
    await login().catch(() => {});
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
