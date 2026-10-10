// Live verification for "Test de reglas sobre un dosier": Test rule on the
// real dossier rules of the DITA XPath 3.0 template (BRDP-EXT-00007 and
// BRDP-EXT-00008, read from public/brdp-template-dita-xpath3.xlsx) in the
// real app.
//   1. The engine in Chromium (DOMParser) gives, on the hand-written
//      dossiers of scripts/lib/dossierFixtures.mjs, the same verdicts as in
//      Node (scripts/test-rule-test-dossier.mjs).
//   2. EXT-00007: the dossier line in "What the rule checks", the dossier
//      block in the prompt, the files of each example in the panel (the
//      ditamap first, each collapsible, with Copy XML and Edit), verdict
//      Correct, recorded as passed; editing one file and Run again changes
//      that example's result.
//   3. EXT-00008: the first answer gives the common notes file an unknown
//      root; the correction round names that file; the warning reached by
//      conref to it is read; verdict Correct.
//   4. The saved passed test shows the files; "Run with the saved
//      examples" re-runs the dossiers without the LLM.
//   5. Spanish texts.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs writes
// dossiers for these rules).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR
// (default: the system's temp directory).
//
//     node scripts/verify-rule-test-dossier.mjs
import { chromium } from "playwright-core";
import { readPublicTemplate } from "./lib/readXlsx.mjs";
import { shot } from "./lib/shots.mjs";
import { DOSSIER_CASES } from "./lib/dossierFixtures.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const rows = readPublicTemplate("brdp-template-dita-xpath3.xlsx");
const row = (id) => rows.find((r) => r.ID === id);

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Dossier rule test ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const brdps = {};
  for (const id of ["BRDP-EXT-00007", "BRDP-EXT-00008"]) {
    const r = row(id);
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier: id, title: r.Title, definition: r.Definition, proposal: r.Proposal, validation: "Validated" }),
    }).then((x) => x.json());
    brdps[id] = b;
    const put = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/SCH-DITA`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: r.Rule, source: "manual", status: "pending_review" }),
    });
    if (!put.ok) throw new Error(`seeding ${id} failed: ${put.status} ${await put.text()}`);
  }
  const approvalOf = (id) => api(`/api/projects/${project.id}/brdps/${brdps[id].id}/approvals/SCH-DITA`).then((r) => r.json());
  {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1700 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const panel = () => page.getByTestId("rule-test-panel").first();
  const indicator = () => page.getByTestId("rule-test-indicator");
  const language = () => page.locator("header select, nav select").first();
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await indicator().waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  async function waitIndicator(state) {
    await page.waitForFunction((s) => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === s, state, { timeout: 15000 });
  }
  const examples = () => panel().locator('[data-testid^="rule-test-example-"][data-testid$="-dossier"]');

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.waitForTimeout(300);

    // 1. The engine in Chromium gives the same verdicts as in Node.
    const cases = Object.entries(DOSSIER_CASES).flatMap(([id, list]) => list.map((c) => ({ id, rule: row(id).Rule, ...c, message: c.message ? c.message.source : null })));
    const browserResults = await page.evaluate(async (all) => {
      const engine = await import("/src/utils/ruleTestEngine.js");
      const fixtures = await import("/scripts/lib/dossierFixtures.mjs");
      return all.map((c) => {
        const r = engine.runRuleOnFragment(c.rule, "SCH-DITA", c.main || fixtures.DOSSIER_MAP, null, { dossier: { mainPath: "dosier.ditamap", files: c.files } });
        return { name: `${c.id} — ${c.name}`, status: r.status, ids: r.violations.map((v) => v.ruleId).sort().join(","), messages: r.violations.map((v) => v.message) };
      });
    }, cases);
    cases.forEach((c, i) => {
      const got = browserResults[i];
      assert(got.status === c.status, `Chromium: ${got.name} → ${c.status} (got ${got.status})`);
      if (c.ids) assert(got.ids === [...c.ids].sort().join(","), `Chromium: ${got.name} violates ${c.ids.join(",")}`);
      if (c.message) assert(got.messages.some((m) => new RegExp(c.message).test(m)), `Chromium: ${got.name} message`);
    });

    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 2. EXT-00007.
    await select("BRDP-EXT-00007");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    const desc = await panel().getByTestId("rule-test-description").textContent();
    assert(desc.includes("Reads other files of the dossier: the examples include the ditamap and the topics it points to."), `description: the dossier line (${desc.slice(0, 160)})`);
    const prompt7 = systemOf(await lastRequest());
    assert(prompt7.includes("each example is a DOSSIER") && prompt7.includes('"files": at most 4 more files'), "prompt: the dossier block");
    const verdict7 = await panel().getByTestId("rule-test-verdict").textContent();
    assert(verdict7.startsWith("Correct"), `EXT-00007: verdict Correct (${verdict7})`);
    assert((await examples().count()) === 2, "two dossier examples");
    const first = panel().getByTestId("rule-test-example-0-dossier");
    const fileHeads = await first.locator("details > summary").allTextContents();
    assert(fileHeads[0].includes("dossier.ditamap") && fileHeads[0].includes("the ditamap the rule runs on"), `the ditamap first (${fileHeads.join(" | ")})`);
    assert(fileHeads.some((h) => h.includes("fichas/precauciones.dita")) && fileHeads.some((h) => h.includes("fichas/procedimiento.dita")), "each file with its path as the header");
    assert((await first.locator("details[open]").count()) === 3, "every file open (collapsible)");
    await first.locator("details > summary").nth(1).click();
    assert((await first.locator("details[open]").count()) === 2, "a file collapses");
    await first.locator("details > summary").nth(1).click();
    assert((await first.getByRole("button", { name: "Copy XML" }).count()) === 3, "Copy XML per file");
    const mainMark = await first.getByTestId("rule-test-example-0-file-main").locator("mark").count();
    assert(mainMark > 0, "the ditamap's selected node is highlighted");
    await waitIndicator("passed");
    assert((await approvalOf("BRDP-EXT-00007")).last_test_result === "passed", "EXT-00007: recorded as passed");
    await panel().screenshot({ path: shot("rule-test-dossier-ext-00007.png") });

    // Edit one file (the safety topic loses its title) and Run again.
    const precBlock = first.locator('details[data-path="fichas/precauciones.dita"]');
    await precBlock.getByRole("button", { name: "Edit" }).click();
    const editor = precBlock.locator("textarea");
    const text = await editor.inputValue();
    await editor.fill(text.replace("PRECAUCIONES DE SEGURIDAD", "OTRA FICHA"));
    await precBlock.getByRole("button", { name: "Run again" }).click();
    await page.waitForTimeout(400);
    const card0 = panel().getByTestId("rule-test-example-0");
    assert((await card0.getByTestId("rule-test-result").textContent()).startsWith("Result: rejected"), "edited file: the example is now rejected");
    assert((await card0.getByTestId("rule-test-edited-mark").count()) === 1, "edited file: the example is marked as edited");
    assert((await approvalOf("BRDP-EXT-00007")).last_test_result === "passed", "edited file: the recorded result does not change");
    await panel().getByRole("button", { name: "Close" }).click();

    // 3. EXT-00008: the correction round names the file.
    await select("BRDP-EXT-00008");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    const req8 = await lastRequest();
    const correction8 = req8.messages.filter((m) => m.role === "user").at(-1).content;
    assert(correction8.startsWith("Some examples are not valid.") && correction8.includes('file "comunes/notas.dita": <notes> is not the root of a DITA document type'), `correction names the file (${correction8.slice(0, 300)})`);
    assert(correction8.includes('"content" and "files"'), "correction asks for the files too");
    const verdict8 = await panel().getByTestId("rule-test-verdict").textContent();
    assert(verdict8.startsWith("Correct"), `EXT-00008: verdict Correct after the correction (${verdict8})`);
    assert((await panel().getByTestId("rule-test-correction").textContent()).includes("1 example was corrected"), "one example corrected");
    assert(((await panel().getByTestId("rule-test-example-0").textContent()) || "").includes("comunes/notas.dita"), "the conref target file is part of the dossier");
    await waitIndicator("passed");
    await panel().screenshot({ path: shot("rule-test-dossier-ext-00008.png") });
    await panel().getByRole("button", { name: "Close" }).click();

    // 4. The saved passed test, re-run without the LLM.
    await select("BRDP-EXT-00007");
    await page.getByTestId("saved-rule-test-open").click();
    const saved = page.getByTestId("saved-rule-test-panel");
    await saved.waitFor({ timeout: 5000 });
    assert((await saved.locator('details[data-path="fichas/precauciones.dita"]').count()) >= 1, "saved test: the files are shown");
    assert((await saved.getByRole("button", { name: /^Edit$/ }).count()) === 0, "saved test: read-only");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByTestId("saved-rule-test-rerun").click();
    await page.getByTestId("saved-rule-test-verdict").waitFor({ timeout: 5000 });
    assert((await page.getByTestId("saved-rule-test-verdict").getAttribute("data-kind")) === "correct", "saved dossiers re-run: Correct");
    assert((await lastRequest()) === null, "saved dossiers re-run: no LLM call");
    await saved.screenshot({ path: shot("rule-test-dossier-saved.png") });

    // 5. Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /^(Close|Cerrar)$/ }).first().click().catch(() => {});
    await select("BRDP-EXT-00007");
    await page.getByRole("button", { name: "Probar regla" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    const descEs = await panel().getByTestId("rule-test-description").textContent();
    assert(descEs.includes("Lee otros ficheros del dosier: los ejemplos incluyen el ditamap y las fichas a las que apunta."), "description in Spanish");
    const headEs = await panel().getByTestId("rule-test-example-0-dossier").locator("details > summary").first().textContent();
    assert(headEs.includes("el ditamap sobre el que se ejecuta la regla"), `ditamap header in Spanish (${headEs})`);
    await panel().screenshot({ path: shot("rule-test-dossier-es.png") });
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
