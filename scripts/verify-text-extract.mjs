// AI Extract (2/2): BRDPs from free text -- in a real browser, against the
// real backend and Postgres (the LLM and the embeddings through the local
// simulators, scripts/mock-mistral-chat-server.mjs and
// mock-mistral-embed-server.mjs; uvicorn started with MISTRAL_ENDPOINT /
// MISTRAL_EMBED_ENDPOINT pointing at them):
//   - pasted text (the Spanish DITA style guide) in a DITA project: the
//     decisions found, the quotes checked, the identifier read by code, the
//     "Fragment" column, import (Pending, no rule) and History with the
//     quote; the same text again (from its .docx) warns of the fragments
//     already imported;
//   - the English BREXdoc as a .pdf in an S1000D 4.2 project: a catalog
//     identifier; then a text naming an existing BRDP ("Already exists"),
//     BRDP-S1-00012 (in the 4.1 catalog only) and a quote the AI made up;
//   - the word limit (5,000 accepted, 5,001 rejected with no AI call, the
//     server rejecting a direct request), an empty text, files that cannot
//     be read (scanned PDF, password, damaged, old .doc), an answer cut by
//     its length (asked again in halves; cut again: a readable error), no
//     decision, a text job resumed after a reload, the backend restarted
//     while the AI writes, no AI provider, and the Spanish interface.
// Needs the 4.2 and 4.1 catalogs (seed_extract_catalog_42.py;
// import_brdp_catalog.py catalog_sources/s1000d_4.1.xlsx "S1000D 4.1").
//
//     node scripts/verify-text-extract.mjs
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
const FIX = path.join(ROOT, "scripts/prompt-eval/fixtures/text-extract");
const SHOTS = os.tmpdir();
const ES_TEXT = fs.readFileSync(path.join(FIX, "guia-estilo-dita-es.md"), "utf8");

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
const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());

async function createProject(name, standard) {
  return api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${Date.now()}`, standard, project_config: {}, seed_from_catalog: false }) });
}
async function openConfig(page, projectId) {
  await page.goto(`${BASE_URL}/projects/${projectId}/config`);
  await page.getByTestId("text-extract").waitFor();
}
async function candidatesOf(projectId) {
  const job = await api(`/api/projects/${projectId}/ai-extract/jobs/active`);
  return { job, cands: (await api(`/api/projects/${projectId}/ai-extract/jobs/${job.id}/candidates`)).candidates };
}
async function waitDrafted(page, timeout = 120000) {
  await page.getByTestId("rule-extract-table").waitFor({ timeout });
  await page.waitForTimeout(400);
  await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout });
}
function rowWithQuote(page, text) {
  return page.locator('[data-testid="rule-extract-row"]', { has: page.getByTestId("rule-extract-quote-summary").filter({ hasText: text }) });
}
const words = (n) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(" ");

function uvicornPid() {
  const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
  // The server itself (python … uvicorn app.main:app), never a shell whose
  // command line merely mentions it.
  const line = out.split("\n").find((l) => /^\s*\d+\s+\S*(python[\d.]*|uvicorn)\s.*uvicorn app\.main:app/.test(l));
  return line ? Number(line.trim().split(/\s+/)[0]) : null;
}
async function waitBackend(up, tries = 160) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await fetch(`${API}/docs`).then((r) => r.ok).catch(() => false);
    if (ok === up) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (tries < 160) return false;
  throw new Error(`backend did not come ${up ? "up" : "down"}`);
}
async function restartBackend() {
  const pid = uvicornPid();
  if (!pid) throw new Error("uvicorn not found");
  // A graceful stop waits for the requests in flight (the page keeps
  // writing); after 15 s it is stopped hard, by its exact PID -- like a crash.
  process.kill(pid, "SIGTERM");
  if (!(await waitBackend(false, 60))) {
    process.kill(pid, "SIGKILL");
    await waitBackend(false);
  }
  const log = fs.openSync(path.join(os.tmpdir(), "uvicorn-restarted.log"), "a");
  spawn(path.join(ROOT, "backend/.venv/bin/uvicorn"), ["app.main:app", "--host", "0.0.0.0", "--port", "8000"], {
    cwd: path.join(ROOT, "backend"),
    env: { ...process.env, MISTRAL_ENDPOINT: process.env.MISTRAL_ENDPOINT || "http://localhost:8902", MISTRAL_EMBED_ENDPOINT: process.env.MISTRAL_EMBED_ENDPOINT || "http://localhost:8901" },
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
  await waitBackend(true);
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
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
    await mock("/reset");
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);

    // ── Pasted text, DITA project ──────────────────────────────────────────
    console.log("\nPasted text (Spanish DITA style guide) → DITA 1.3 Xpath2.0 project");
    const dita = await createProject("Text extract DITA", "DITA 1.3 Xpath2.0");
    projects.push(dita);
    await openConfig(page, dita.id);
    const submit = page.getByTestId("text-extract-submit");
    assert(await submit.isDisabled(), "empty box: the button is disabled");
    await page.getByTestId("text-extract-box").fill("   \n\t  ");
    assert(await submit.isDisabled(), "whitespace only: still disabled");
    await page.getByTestId("text-extract-box").fill(ES_TEXT);
    const count = await page.getByTestId("text-extract-count").innerText();
    assert(count === "334 / 5,000 words", `counter "${count}"`);
    await mock("/reset");
    await submit.click();
    await waitDrafted(page);
    let { job, cands } = await candidatesOf(dita.id);
    assert(job.source_kind === "text" && job.filename === "" && job.word_count === 334, "a text job, pasted, 334 words");
    const counts = await page.getByTestId("rule-extract-counts").innerText();
    assert(counts.startsWith(`${cands.length} candidates from Pasted text.`), `counts name the source "Pasted text" (${counts.slice(0, 60)})`);
    console.log(`       sample ES: ${cands.length} candidates (5 decisions + 1 repeated in other words + 1 sentence the simulator splits)`);
    assert(cands.length >= 5 && cands.every((c) => c.quote_found), `${cands.length} candidates, every quote found literally in the text`);
    const cmd = cands.find((c) => c.origin_identifier === "BRDP-D1-00020");
    assert(!!cmd && /<cmd>/.test(cmd.quote), "BRDP-D1-00020 read from the quote by code");
    assert(!cands.some((c) => /revisa los procedimientos|editor XML compartido|responsable de la documentación/.test(c.quote)), "the paragraphs with no decision are not extracted");
    const header = await page.locator('[data-testid="rule-extract-table"] thead').innerText();
    assert(header.includes("Fragment") && !header.includes("Rule"), "the table has a Fragment column instead of Rule");
    const first = cands.find((c) => c.classification === "new_ext");
    const r = rowWithQuote(page, first.quote.slice(0, 40));
    assert((await r.getByTestId("rule-extract-source-title").innerText()) === "written by AI", "Title from step 1: 'written by AI'");
    await r.getByTestId("rule-extract-quote-summary").click();
    assert((await r.getByTestId("rule-extract-quote").innerText()) === first.quote, "the quote expands in full");
    assert((await page.getByTestId("rule-extract-text-counts").innerText()).startsWith("Texts: "), "fixed line 'Texts: N written by AI · P pending · F failed'");
    assert((await page.getByTestId("rule-extract-import-as").count()) === 0, "no 'Import as: Already in force' for a free text");
    await page.getByTestId("rule-extract-table").screenshot({ path: path.join(SHOTS, "text-extract-review-es-text.png") });
    const selected = cands.filter((c) => c.selected).length;
    await page.getByTestId("rule-extract-apply").click();
    await page.getByTestId("rule-extract-result").waitFor();
    const result = await page.getByTestId("rule-extract-result-summary").innerText();
    assert(result === `Checked ${selected} · Created ${selected} · Updated 0 · Omitted 0`, `summary adds up: ${result}`);
    const brdps = await api(`/api/projects/${dita.id}/brdps`);
    assert(brdps.length === selected && brdps.every((b) => b.validation === "Pending"), `${selected} BRDPs created, Proposal Pending`);
    const approvals = await Promise.all(brdps.map((b) => api(`/api/projects/${dita.id}/brdps/${b.id}/approvals/SCH-DITA`).catch(() => null)));
    assert(approvals.every((a) => !a), "none has a rule");
    const created = brdps.find((b) => b.identifier === "BRDP-D1-00020") || brdps[0];
    await page.addInitScript(() => sessionStorage.setItem("brdp-records-history-open", "1"));
    await page.goto(`${BASE_URL}/projects/${dita.id}/records`);
    await page.getByText(created.identifier, { exact: true }).first().click();
    await page.getByText("Extracted from").first().waitFor();
    const panel = await page.locator("body").innerText();
    assert(/Pasted text( \(source ID BRDP-D1-00020\))?: “/.test(panel), "History: Extracted from Pasted text: “quote”");
    await page.screenshot({ path: path.join(SHOTS, "text-extract-history.png") });

    // Same text again, from its .docx: the fragments already imported warn.
    console.log("\nThe same text again, from its .docx");
    await openConfig(page, dita.id);
    await page.getByTestId("text-extract-file").setInputFiles(path.join(FIX, "guia-estilo-dita-es.docx"));
    await page.getByTestId("text-extract-filename").waitFor();
    assert((await page.getByTestId("text-extract-filename").innerText()) === "From the file guia-estilo-dita-es.docx", "file read in the browser, its name shown");
    await page.getByTestId("text-extract-submit").click();
    await waitDrafted(page);
    ({ job, cands } = await candidatesOf(dita.id));
    assert(job.filename === "guia-estilo-dita-es.docx", "the job carries the file name");
    const again = cands.filter((c) => c.warnings.some((w) => w.code === "quote_already_imported"));
    assert(again.length >= 4 && again.every((c) => !c.selected), `${again.length} fragments already imported: warned and unchecked`);
    assert((await page.getByTestId("rule-extract-table").innerText()).includes("This fragment was already imported as"), "the warning shows in the table");

    // ── PDF, S1000D 4.2 project ────────────────────────────────────────────
    console.log("\nEnglish BREXdoc (.pdf) → S1000D 4.2 project");
    const s42 = await createProject("Text extract 4.2", "S1000D 4.2");
    projects.push(s42);
    await openConfig(page, s42.id);
    await page.getByTestId("text-extract-file").setInputFiles(path.join(FIX, "brexdoc-s1000d-en.pdf"));
    await page.getByTestId("text-extract-filename").waitFor();
    assert((await page.getByTestId("text-extract-box").inputValue()).includes("Warnings shall always be placed before the step"), "PDF text read into the box");
    await page.getByTestId("text-extract-submit").click();
    await waitDrafted(page);
    ({ cands } = await candidatesOf(s42.id));
    console.log(`       sample EN: ${cands.length} candidates`);
    const s187 = cands.find((c) => c.origin_identifier === "BRDP-S1-00187");
    assert(s187?.classification === "catalog" && s187.title === "Minimum number of substeps in a step" && s187.ai_fields.join() === "proposal",
      "BRDP-S1-00187 (named in the text): From catalog, Title from the catalog, only the Proposal by the AI");
    assert(cands.every((c) => c.quote_found), "every quote of the PDF found literally (line breaks of the PDF do not count)");
    await page.getByTestId("rule-extract-apply").click();
    await page.getByTestId("rule-extract-result").waitFor();

    console.log("\nExisting BRDP, other edition's catalog, a quote the AI made up");
    await openConfig(page, s42.id);
    await page.getByTestId("text-extract-box").fill(
      "In line with BRDP-S1-00187, a step that has sub-steps shall contain at least two.\n\nAs decided in BRDP-S1-00012, the applicability shall always be given in the status section.\n\nINVENTQUOTE"
    );
    await page.getByTestId("text-extract-submit").click();
    await waitDrafted(page);
    ({ cands } = await candidatesOf(s42.id));
    const exists = cands.find((c) => c.origin_identifier === "BRDP-S1-00187");
    assert(exists?.classification === "same" && !exists.selected, "BRDP-S1-00187 already in the project: 'Already exists', unchecked");
    const existsRow = rowWithQuote(page, "a step that has sub-steps");
    assert((await existsRow.getByTestId("rule-extract-class").locator("option:checked").innerText()) === "Already exists", "labelled 'Already exists'");
    assert((await existsRow.getByTestId("rule-extract-warnings").innerText()).includes("the import never changes its texts"), "with its warning");
    const ed = cands.find((c) => c.origin_identifier === "BRDP-S1-00012");
    assert(ed?.classification === "catalog_edition" && !ed.selected && ed.catalog_edition === "S1000D 4.1", "BRDP-S1-00012: 'From catalog (S1000D 4.1)', unchecked");
    const invented = cands.find((c) => !c.quote_found);
    assert(!!invented && !invented.selected, "the made-up quote: unchecked, never hidden");
    const invRow = rowWithQuote(page, "Every figure shall have a caption");
    assert((await invRow.getByTestId("rule-extract-warnings").innerText()).includes("Quote not found in the text"), "with 'Quote not found in the text'");
    await page.getByTestId("rule-extract-table").screenshot({ path: path.join(SHOTS, "text-extract-edge-rows.png") });
    // Import the existing one too: reported, its texts never changed.
    const before = (await api(`/api/projects/${s42.id}/brdps`)).find((b) => b.identifier === "BRDP-S1-00187");
    await existsRow.getByTestId("rule-extract-select").check();
    await page.waitForTimeout(400);
    await page.getByTestId("rule-extract-apply").click();
    await page.getByTestId("rule-extract-result").waitFor();
    await page.getByTestId("rule-extract-result-omitted").locator("summary").click();
    const omitted = await page.getByTestId("rule-extract-result-omitted").innerText();
    assert(omitted.includes("BRDP-S1-00187: already exists: its texts are not changed"), "reported as omitted: already exists");
    const after = (await api(`/api/projects/${s42.id}/brdps`)).find((b) => b.identifier === "BRDP-S1-00187");
    assert(after.proposal === before.proposal && after.title === before.title, "its texts are unchanged");

    // ── Word limit ─────────────────────────────────────────────────────────
    console.log("\nWord limit");
    await openConfig(page, s42.id);
    await page.getByTestId("text-extract-box").fill(words(5000));
    assert((await page.getByTestId("text-extract-count").innerText()) === "5,000 / 5,000 words" && (await page.getByTestId("text-extract-submit").isEnabled()), "5,000 words: accepted");
    await page.getByTestId("text-extract-box").fill(words(5001));
    await mock("/reset");
    assert(await page.getByTestId("text-extract-submit").isDisabled(), "5,001 words: the button is disabled");
    assert((await page.getByTestId("text-extract-too-long").innerText()) === "This text has 5,001 words; the maximum is 5,000. Split it into sections and import them one by one.", "5,001 words: the message with the count");
    assert((await lastRequest()) === null, "no AI call");
    const direct = await fetch(`${API}/api/projects/${s42.id}/ai-extract/text`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ text: words(5001) }),
    });
    assert(direct.status === 422 && (await direct.json()).detail.includes("5001 words; the limit is 5000"), "a direct request with 5,001 words: rejected by the server");
    await page.getByTestId("text-extract").screenshot({ path: path.join(SHOTS, "text-extract-too-long.png") });

    // ── Files that cannot be read ──────────────────────────────────────────
    console.log("\nFiles that cannot be read");
    const jobBefore = (await api(`/api/projects/${s42.id}/ai-extract/jobs/active`)).id;
    for (const [file, text] of [
      ["scanned.pdf", "The PDF has no selectable text"],
      ["protected.pdf", "The PDF is password-protected"],
      ["damaged.docx", "The file could not be read:"],
      ["old-format.doc", "Old Word documents (.doc) cannot be read"],
    ]) {
      await page.getByTestId("text-extract-clear").click().catch(() => {});
      await page.getByTestId("text-extract-file").setInputFiles(path.join(FIX, file));
      await page.getByTestId("text-extract-read-error").waitFor();
      assert((await page.getByTestId("text-extract-read-error").innerText()).startsWith(text), `${file}: "${text}…"`);
    }
    assert((await api(`/api/projects/${s42.id}/ai-extract/jobs/active`)).id === jobBefore, "nothing was created");

    // ── Cut by its length; no decision ─────────────────────────────────────
    console.log("\nAnswer cut by its length; no decision");
    await openConfig(page, s42.id);
    await page.getByTestId("text-extract-box").fill(`TRUNCATEFIND-START\n\nNotes shall be short.\n\nFigures must be numbered.\n\nTRUNCATEFIND-END`);
    await page.getByTestId("text-extract-submit").click();
    await waitDrafted(page);
    ({ cands } = await candidatesOf(s42.id));
    assert(cands.length === 2, "cut once: asked again in two halves, both decisions found");
    await page.getByTestId("text-extract-clear").click();
    await page.getByTestId("text-extract-box").fill("TRUNCATEALWAYS\n\nNotes shall be short.\n\nFigures must be numbered.");
    await page.getByTestId("text-extract-submit").click();
    await page.getByTestId("rule-extract-find-error").waitFor();
    assert((await page.getByTestId("rule-extract-find-error").innerText()).includes("cut by its length even after splitting the text in two halves"), "cut again: a readable error");
    assert(await page.getByTestId("rule-extract-find-retry").isVisible(), "with 'Search again'");
    await page.getByTestId("rule-extract-find-error").screenshot({ path: path.join(SHOTS, "text-extract-find-truncated.png") });
    await page.getByTestId("text-extract-clear").click();
    await page.getByTestId("text-extract-box").fill("Our team reviews the modules twice a year and meets every month.");
    await page.getByTestId("text-extract-submit").click();
    await page.getByTestId("rule-extract-no-decisions").waitFor();
    assert((await page.getByTestId("rule-extract-no-decisions").innerText()) === "No decisions were found in the text (Pasted text).", "no decision: the message");

    // ── A text job resumed after a reload; restart while the AI writes ─────
    console.log("\nResumed after a reload; backend restarted while the AI writes");
    const res = await api(`/api/projects/${s42.id}/ai-extract/text`, { method: "POST", body: JSON.stringify({ text: "Notes shall be short.\n\nFigures must be numbered.\n\nTables shall have a title.", filename: "minutes.txt" }) });
    assert((await api(`/api/projects/${s42.id}/ai-extract/jobs/${res.job_id}`)).status === "awaiting_decisions", "a text job waiting for step 1");
    await mock("/extract-delay", { ms: 2500 });
    await openConfig(page, s42.id);
    await page.getByTestId("rule-extract-drafting").waitFor({ timeout: 30000 });
    assert(true, "opening the page finds its decisions by itself and starts writing");
    await restartBackend();
    await page.reload();
    await mock("/extract-delay", { ms: 0 });
    await waitDrafted(page);
    ({ job, cands } = await candidatesOf(s42.id));
    assert(job.id === res.job_id && cands.length === 3 && cands.every((c) => c.ai_fields.every((f) => c[f])), "after the restart the candidates stayed and the writing finished");

    // ── Part 0 leftovers: filter label, texts line, count mismatch ────────
    console.log("\nLeftovers: 'Blocking the import' filter, texts line, rows that do not add up");
    assert((await page.getByTestId("rule-extract-filter").locator('option[value="blocking"]').innerText()) === "Blocking the import", "filter option 'Blocking the import'");
    assert((await page.getByTestId("rule-extract-text-counts").innerText()) === "Texts: 3 written by AI · 0 pending · 0 failed", "the texts line stays after the writing: 'Texts: 3 written by AI · 0 pending · 0 failed'");
    await page.route("**/ai-extract/jobs/*/candidates", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const resp = await route.fetch();
      const body = await resp.json();
      body.candidates = body.candidates.slice(0, -1);
      await route.fulfill({ response: resp, body: JSON.stringify(body) });
    });
    await openConfig(page, s42.id);
    await page.getByTestId("rule-extract-count-mismatch").waitFor();
    assert((await page.getByTestId("rule-extract-count-mismatch").innerText()).startsWith("The screen shows 2 of 3 rows"), "a short list: 'The screen shows 2 of 3 rows', with Reload");
    await page.getByTestId("rule-extract-count-mismatch").screenshot({ path: path.join(SHOTS, "text-extract-count-mismatch.png") });
    await page.unroute("**/ai-extract/jobs/*/candidates");
    await page.getByTestId("rule-extract-reload").click();
    await page.getByTestId("rule-extract-count-mismatch").waitFor({ state: "detached" });
    assert(true, "Reload loads every row: the error goes away");

    // ── No AI provider ─────────────────────────────────────────────────────
    console.log("\nNo AI provider");
    await page.route("**/api/config/ai-provider", (route) => route.fulfill({ status: 500, body: "{}" }));
    await openConfig(page, s42.id);
    await page.getByTestId("text-extract-disabled").waitFor();
    assert((await page.getByTestId("text-extract-disabled").innerText()).includes("finding the decisions of a text needs the AI"), "input disabled, with the reason");
    assert(await page.getByTestId("text-extract-box").isDisabled(), "the box is disabled");
    await page.unroute("**/api/config/ai-provider");

    // ── Spanish ────────────────────────────────────────────────────────────
    console.log("\nSpanish");
    await openConfig(page, s42.id);
    await page.locator("header select, nav select").first().selectOption("es");
    await page.getByTestId("text-extract-box").fill(words(1240));
    await page.getByTestId("rule-extract-table").waitFor();
    const es = await page.getByTestId("rule-extract-section").innerText();
    assert(es.includes("Importar desde texto o documento") && es.includes("Pega el texto o adjunta un fichero (.txt, .md, .docx o .pdf). Máximo 5 000 palabras."), "ES: title and hint");
    assert((await page.getByTestId("text-extract-count").innerText()) === "1 240 / 5 000 palabras", "ES counter: 1 240 / 5 000 palabras");
    const esCounts = await page.getByTestId("rule-extract-text-counts").innerText();
    assert(es.includes("Fragmento") && esCounts === "Textos: 3 redactados por IA · 0 pendientes · 0 fallidos", "ES: Fragment column and texts line", esCounts);
    assert((await page.getByTestId("rule-extract-filter").locator('option[value="blocking"]').innerText()) === "Bloquean la importación", "ES: 'Bloquean la importación'");
    await page.getByText("¿Por qué hay límite?").click();
    assert((await page.getByTestId("rule-extract-section").innerText()).includes("Cada BRDP propuesta la revisa una persona."), "ES: why there is a limit");
    await page.getByTestId("text-extract-box").fill(words(7320));
    assert((await page.getByTestId("text-extract-too-long").innerText()) === "Este texto tiene 7 320 palabras; el máximo es 5 000. Divídelo por secciones e impórtalas una a una.", "ES: too long");
    await page.getByTestId("text-extract").screenshot({ path: path.join(SHOTS, "text-extract-es.png") });
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await mock("/extract-delay", { ms: 0 }).catch(() => {});
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
