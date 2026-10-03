// AI Extract: rows that go missing, stopping the AI writing, and decisions
// written twice in a free text -- in a real browser, against the real
// backend and Postgres (LLM and embeddings through the local simulators):
//   - the screen shows fewer rows than the job read (the candidates answer
//     cut on its way): the warning names each missing row and its
//     classification; "Reload" asks for the job and its rows again and says
//     "all 533 rows are here";
//   - rows the server itself lost (deleted under it): named from the job's
//     manifest; "Reload" says "still missing 6: …";
//   - a slow list of the previous extraction never lands in the table of a
//     new one (keys repeat between jobs);
//   - "Stop" with batches on their way: they are saved, nothing else is sent,
//     the rest stays pending; a reload keeps it stopped; "Continue writing"
//     sends only the pending rows; the import stays blocked meanwhile;
//   - another file while stopped (and while writing): asks first; "Cancel"
//     keeps the current extraction, "OK" discards it;
//   - the Spanish style guide: the decision repeated in the closing reminder
//     comes back as a candidate warned "possible repetition of «…»",
//     unchecked, never merged; in Spanish and in English.
// Needs both catalogs loaded (see verify-rule-extract-safe-import.mjs).
//
//     node scripts/verify-rule-extract-stop-and-rows.mjs
import { execFileSync } from "node:child_process";
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
const GUIDE_ES = path.join(ROOT, "scripts/prompt-eval/fixtures/text-extract/guia-estilo-dita-es.md");
const PYTHON = fs.existsSync(path.join(ROOT, "backend/.venv/bin/python")) ? path.join(ROOT, "backend/.venv/bin/python") : path.join(ROOT, "backend/.venv/Scripts/python.exe");
const SMALL = path.join(os.tmpdir(), "brex-42-five-ext-stop.xml");
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
const extractCalls = () => fetch(`${MOCK}/extract-calls`).then((r) => r.json()).then((b) => b.count ?? b.calls ?? 0);

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = (await res.json()).access_token;
  if (!token) throw new Error(`login failed for ${EMAIL}`);
}
const setLanguage = (lang) => api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: lang }) });

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

// Deletes candidate rows on the server, as if they had been lost there.
function deleteRows(jobId, keys) {
  const code = `
import asyncio, uuid
from sqlalchemy import delete
from app.db.base import async_session_factory
from app.models import RuleExtractCandidate
async def main():
    async with async_session_factory() as s:
        await s.execute(delete(RuleExtractCandidate).where(RuleExtractCandidate.job_id == uuid.UUID(${JSON.stringify(jobId)}), RuleExtractCandidate.key.in_(${JSON.stringify(keys)})))
        await s.commit()
asyncio.run(main())
`;
  execFileSync(PYTHON, ["-c", code], { cwd: path.join(ROOT, "backend") });
}

const complete = (c) =>
  ["same", "changed", "empty"].includes(c.classification) || (c.ai_fields || []).every((f) => (c[f] || "").trim());

async function main() {
  await login();
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const dialogs = [];
  let dialogAnswer = true;
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    if (dialogAnswer) await d.accept();
    else await d.dismiss();
  });
  const projects = [];
  try {
    await setLanguage("es");
    await mock("/reset");
    await mock("/extract-delay", { ms: 0 });
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);

    // ── 6 BRDPs from an earlier import, then the same BREX again ──────────
    console.log("\nRows missing on the screen: named, and Reload says what it found");
    const p = await createProject("AI Extract rows", "S1000D 4.2");
    projects.push(p);
    const base = `/api/projects/${p.id}/ai-extract`;
    await page.goto(`${BASE_URL}/projects/${p.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(CA);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 120000 });
    let { job, cands } = await candidatesOf(p.id);
    const ed = cands.filter((c) => c.classification === "catalog_edition").slice(0, 6);
    await api(`${base}/jobs/${job.id}/candidates`, {
      method: "PATCH",
      body: JSON.stringify({ items: ed.slice(0, 3).map((c) => ({ key: c.key, classification: "catalog_edition_marked", selected: true })).concat(ed.slice(3).map((c) => ({ key: c.key, selected: true }))) }),
    });
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 300000 }).catch(() => {});
    await api(`${base}/jobs/${job.id}/apply`, { method: "POST", body: JSON.stringify({ keys: ed.map((c) => c.key), import_as: "pending" }) });

    // The candidates answer loses the 6 "Already exists" rows on its way once.
    let cutOnce = true;
    await page.route(/\/ai-extract\/jobs\/[^/]+\/candidates$/, async (route) => {
      if (route.request().method() !== "GET" || !cutOnce) return route.continue();
      cutOnce = false;
      const res = await route.fetch();
      const body = await res.json();
      body.candidates = body.candidates.filter((c) => c.classification !== "same");
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${BASE_URL}/projects/${p.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(CA);
    await page.getByTestId("rule-extract-count-mismatch").waitFor({ timeout: 120000 });
    await page.getByTestId("rule-extract-missing-rows").waitFor({ timeout: 10000 });
    const warning = await page.getByTestId("rule-extract-count-mismatch").innerText();
    ({ job, cands } = await candidatesOf(p.id));
    const same = cands.filter((c) => c.classification === "same");
    console.log(`       ${warning.replace(/\s+/g, " ").slice(0, 300)}`);
    assert(same.length === 6, "the server has the 6 'Already exists (same)' rows");
    assert(warning.includes("La pantalla muestra 527 de 533 filas."), "warning: 527 of 533");
    assert(same.every((c) => warning.includes(`${c.identifier} (Ya existe (igual))`)), "each missing row named with its classification");
    assert(warning.includes("Faltan en pantalla (6)"), "'Faltan en pantalla (6)'");
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-missing-rows-named.png") });
    await page.getByTestId("rule-extract-reload").click();
    await page.getByTestId("rule-extract-reload-result").waitFor();
    const reloaded = await page.getByTestId("rule-extract-reload-result").innerText();
    assert(reloaded === "Recargado: ya están las 533 filas.", `Reload: "${reloaded}"`);
    assert((await page.getByTestId("rule-extract-count-mismatch").count()) === 0, "the warning is gone");
    assert((await page.getByTestId("rule-extract-counts").innerText()).includes("533 candidatas"), "the table shows the 533");
    await page.unroute(/\/ai-extract\/jobs\/[^/]+\/candidates$/);

    // ── Rows the server lost: named from the manifest ──────────────────────
    console.log("\nRows lost on the server: named from the job's manifest");
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 300000 }).catch(() => {});
    deleteRows(job.id, same.map((c) => c.key));
    await page.reload();
    await page.getByTestId("rule-extract-server-missing-rows").waitFor({ timeout: 30000 });
    const lost = await page.getByTestId("rule-extract-count-mismatch").innerText();
    assert(lost.includes("El servidor no tiene guardadas (6)") && same.every((c) => lost.includes(c.identifier)), "the 6 rows the server lacks are named", lost.slice(0, 300));
    await page.getByTestId("rule-extract-reload").click();
    await page.getByTestId("rule-extract-reload-result").waitFor();
    const still = await page.getByTestId("rule-extract-reload-result").innerText();
    assert(still.startsWith("Recargado: siguen faltando 6: ") && same.every((c) => still.includes(c.identifier)), `Reload: "${still.slice(0, 160)}…"`);

    // ── A slow list of the previous extraction never lands in the new one ─
    console.log("\nA late list of the previous extraction is dropped");
    let delayed = false;
    await page.route(/\/ai-extract\/jobs\/[^/]+\/candidates$/, async (route) => {
      if (route.request().method() !== "GET" || delayed) return route.continue();
      delayed = true;
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    });
    dialogs.length = 0;
    await page.reload();
    await page.getByTestId("rule-extract-file").setInputFiles(SMALL);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    await page.waitForTimeout(5000);
    const small = await page.getByTestId("rule-extract-counts").innerText();
    assert(small.startsWith("5 candidatas"), `the new extraction's 5 rows stay (${small.slice(0, 40)})`);
    assert((await page.getByTestId("rule-extract-count-mismatch").count()) === 0, "no mismatch warning");
    await page.unroute(/\/ai-extract\/jobs\/[^/]+\/candidates$/);

    // ── Stop with batches on their way ─────────────────────────────────────
    console.log("\nStop: the batches on their way are saved, nothing else is sent");
    const s = await createProject("AI Extract stop", "S1000D 4.2");
    projects.push(s);
    const sbase = `/api/projects/${s.id}/ai-extract`;
    await mock("/extract-delay", { ms: 2500 });
    const callsBase = await extractCalls();
    await page.goto(`${BASE_URL}/projects/${s.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(CA);
    await page.getByTestId("rule-extract-drafting").waitFor({ timeout: 120000 });
    await page.waitForTimeout(800); // the three first batches are on their way
    const callsAtStop = await extractCalls();
    await page.getByTestId("rule-extract-stop").click();
    await page.getByTestId("rule-extract-stopping").waitFor();
    assert((await page.getByTestId("rule-extract-stopping").innerText()).startsWith("Deteniendo"), "'Deteniendo: terminando los lotes ya enviados…'");
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 60000 });
    await page.waitForTimeout(3500);
    const callsAfter = await extractCalls();
    let { job: sjob, cands: scands } = await candidatesOf(s.id);
    const drafted = scands.filter((c) => (c.ai_fields || []).length && complete(c)).length;
    const pending = scands.filter((c) => !complete(c)).length;
    console.log(`       calls when stopped: ${callsAtStop}, after: ${callsAfter}; written ${drafted}, pending ${pending}`);
    assert(callsAfter === callsAtStop, "no batch sent after Stop");
    assert(drafted === (callsAtStop - callsBase) * 10, `the batches on their way were saved (${drafted} rows = ${callsAtStop - callsBase} batches)`);
    assert(pending === 250 - drafted, "the rest stays pending");
    assert(sjob.drafting_stopped === true, "kept on the job (drafting_stopped)");
    assert((await page.getByTestId("rule-extract-stopped").innerText()) === "Redacción detenida.", "'Redacción detenida.'");
    // The checked rows (other specification) were written first; check a
    // pending one: the import is blocked while it waits.
    const waiting = scands.find((c) => !complete(c));
    await api(`${sbase}/jobs/${sjob.id}/candidates`, { method: "PATCH", body: JSON.stringify({ items: [{ key: waiting.key, selected: true }] }) });

    console.log("\nStopped and reloaded: stays stopped");
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    await page.waitForTimeout(4000);
    assert((await page.getByTestId("rule-extract-drafting").count()) === 0, "no writing after the reload");
    assert((await extractCalls()) === callsAfter, "no call to the AI after the reload");
    assert(await page.getByTestId("rule-extract-stopped").isVisible(), "still 'Redacción detenida.'");
    assert(await page.getByTestId("rule-extract-apply").isDisabled(), "import blocked: a checked row is still pending");
    assert((await page.getByTestId("rule-extract-blocked").innerText()).includes("1 fila"), "the blocked message counts it");
    await page.screenshot({ path: path.join(SHOTS, "rule-extract-stopped.png") });

    console.log("\nStopped, another file: asks first");
    dialogs.length = 0;
    dialogAnswer = false;
    await page.getByTestId("rule-extract-file").setInputFiles(SMALL);
    await page.waitForTimeout(1500);
    assert(dialogs.length === 1 && dialogs[0].includes("se descarta"), `asked: "${dialogs[0] || ""}"`);
    assert((await page.getByTestId("rule-extract-counts").innerText()).startsWith("533 candidatas"), "Cancel keeps the current extraction");
    assert((await api(`${sbase}/jobs/active`)).id === sjob.id, "nothing started on the server");

    console.log("\nContinue writing: only the pending rows");
    await mock("/extract-delay", { ms: 0 });
    const before = await extractCalls();
    await page.getByTestId("rule-extract-continue").click();
    await page.getByTestId("rule-extract-drafting").waitFor({ timeout: 20000 }).catch(() => {});
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 300000 });
    ({ job: sjob, cands: scands } = await candidatesOf(s.id));
    const sent = (await extractCalls()) - before;
    assert(sent === Math.ceil(pending / 10), `${sent} batches for the ${pending} pending rows (none for the ${drafted} already written)`);
    assert(scands.every(complete), "every row written now");
    assert(sjob.drafting_stopped === false, "no longer stopped");

    console.log("\nWhile writing, another file: asks first, OK discards");
    await mock("/extract-delay", { ms: 2500 });
    const t2 = await createProject("AI Extract discard", "S1000D 4.2");
    projects.push(t2);
    await page.goto(`${BASE_URL}/projects/${t2.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(CA);
    await page.getByTestId("rule-extract-drafting").waitFor({ timeout: 120000 });
    const old = await api(`/api/projects/${t2.id}/ai-extract/jobs/active`);
    dialogs.length = 0;
    dialogAnswer = true;
    assert(await page.getByTestId("rule-extract-file").isEnabled(), "the file input is enabled while the AI writes");
    await page.getByTestId("rule-extract-file").setInputFiles(SMALL);
    await page.waitForFunction(() => /^5 candidatas/.test(document.querySelector('[data-testid="rule-extract-counts"]')?.innerText || ""), null, { timeout: 60000 });
    assert(dialogs.length === 1, "asked once");
    const fresh = await api(`/api/projects/${t2.id}/ai-extract/jobs/active`);
    assert(fresh.id !== old.id, "a new extraction replaced the previous one");
    await page.waitForTimeout(6000);
    assert((await page.getByTestId("rule-extract-counts").innerText()).startsWith("5 candidatas"), "the previous extraction's last batches never land in the new table");
    await mock("/extract-delay", { ms: 0 });

    // ── Free text: a decision written twice ────────────────────────────────
    for (const lang of ["es", "en"]) {
      console.log(`\nFree text, the decision repeated in the closing reminder (${lang})`);
      await setLanguage(lang);
      const d = await createProject(`AI Extract repeat ${lang}`, "DITA 1.3 Xpath2.0");
      projects.push(d);
      await page.goto(`${BASE_URL}/projects/${d.id}/config`);
      await page.getByTestId("text-extract-box").fill(fs.readFileSync(GUIDE_ES, "utf8"));
      await page.getByTestId("text-extract-submit").click();
      await page.getByTestId("rule-extract-table").waitFor({ timeout: 120000 });
      await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 120000 }).catch(() => {});
      const { cands: tc } = await candidatesOf(d.id);
      const repeated = tc.filter((c) => c.warnings.some((w) => w.code === "possible_repetition"));
      console.log(`       ${tc.length} candidates, ${repeated.length} warned as a possible repetition`);
      assert(repeated.length >= 1 && repeated.every((c) => c.selected === false), "the repeated decision is warned and unchecked");
      const first = tc.find((c) => c.key === repeated[repeated.length - 1].repeat_of);
      assert(first && first.selected === true, `the first one stays checked (${first?.title})`);
      assert(tc.length === repeated.length + 5, "never merged: 5 decisions plus the repetitions");
      const row = page.locator(`[data-testid="rule-extract-row"][data-key="${repeated[repeated.length - 1].key}"]`);
      const text = await row.getByTestId("rule-extract-warnings").innerText();
      const expected = lang === "es" ? `Posible repetición de «${first.title}»: desmarcada, revísala.` : `Possible repetition of «${first.title}»: unchecked, review it.`;
      assert(text.includes(expected), `warning: "${expected}"`, text);
      assert(!(await row.getByTestId("rule-extract-select").isChecked()), "unchecked in the table");
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, `rule-extract-text-repetition-${lang}.png`) });
    }
  } finally {
    await setLanguage(null).catch(() => {});
    await mock("/extract-delay", { ms: 0 }).catch(() => {});
    for (const pr of projects) await api(`/api/projects/${pr.id}`, { method: "DELETE" }).catch(() => {});
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
