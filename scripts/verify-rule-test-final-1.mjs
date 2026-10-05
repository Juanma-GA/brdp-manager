// Live verification for "Barrido final 1/2" (Parts 1-3) in the real app:
// 1. Tables with merged rows (the real template rule BRDP-EXT-00001, DITA
//    XPath 3.0): the app fixes what has one fix (colnames with no colspec,
//    cols lower than the columns, a morerows past the last row) and says
//    so; a row entirely covered by the morerows above goes to the
//    correction round with the exact cells and the pointer to the MODEL
//    TABLE the prompt carries; when the correction does not fix it, the
//    example shows the exact reason (EN/ES).
// 2. "Review": the Proposal is checked by its own call (temperature 0) --
//    "at most three substeps" vs a rule that only forbids exactly one →
//    Review with what is missing, every time; a rule that implements its
//    Proposal → Correct; a check that fails → "the Proposal could not be
//    checked", never Correct (EN/ES), recorded as review.
// 3. Ask: "SCHEMA FACTS" never reaches the user (the two real patterns).
//
// Against the real app (Vite + FastAPI + Postgres); only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs: MERGEDROWS,
// MERGEDROWSSTUBBORN, the Proposal check, the <warning> answer).
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks, Vite on 5173.
// Cleans up the projects it creates. Screenshots go to the temp dir.
//
//     node scripts/verify-rule-test-final-1.mjs
import os from "node:os";
import path from "node:path";
import { readPublicTemplate } from "./lib/readXlsx.mjs";
import { chromium } from "playwright-core";

const EXT1 = readPublicTemplate("brdp-template-dita-xpath3.xlsx").find((r) => r.ID === "BRDP-EXT-00001");
const R187 = readPublicTemplate("brdp-template-4-2.xlsx").find((r) => r.ID === "BRDP-S1-00187");
const ONE_SUBSTEP = '<structureObjectRule id="BRDP-FIN-REVIEW"><objectPath allowedObjectFlag="0">//proceduralStep[count(proceduralStep) = 1]</objectPath><objectUse>A step must not have a single substep.</objectUse></structureObjectRule>';

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const shot = (name) => path.join(os.tmpdir(), name);

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else console.log("OK:", msg);
}

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const projects = [];
  const brdps = {};
  async function makeProject(name, standard) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    return p;
  }
  async function makeBrdp(project, format, identifier, fields, ruleXml) {
    const b = await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier, validation: "Validated", ...fields }) }).then((r) => r.json());
    brdps[identifier] = { project, brdp: b, format };
    if (ruleXml) {
      const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/${format}`, { method: "PUT", body: JSON.stringify({ rule_xml: ruleXml, source: "manual", status: "pending_review" }) });
      if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
    }
  }
  const approvalOf = (id) => {
    const { project, brdp, format } = brdps[id];
    return api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`).then((r) => r.json());
  };
  async function embed(project) {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const pDita = await makeProject("Final 1-2 DITA", "DITA 1.3 Xpath3.0");
  await makeBrdp(pDita, "SCH-DITA", "BRDP-FIN-MERGED", { title: EXT1.Title, definition: EXT1.Definition, proposal: `${EXT1.Proposal} MERGEDROWS` }, EXT1.Rule);
  await makeBrdp(pDita, "SCH-DITA", "BRDP-FIN-STUBBORN", { title: EXT1.Title, definition: EXT1.Definition, proposal: `${EXT1.Proposal} MERGEDROWSSTUBBORN` }, EXT1.Rule);
  const p42 = await makeProject("Final 1-2 S1000D", "S1000D 4.2");
  await makeBrdp(p42, "BREX-4.2", "BRDP-FIN-REVIEW", { title: "Substeps", definition: "Number of substeps in a step.", proposal: "A step shall have at most three substeps." }, ONE_SUBSTEP);
  await makeBrdp(p42, "BREX-4.2", "BRDP-FIN-OK", { title: R187.Title, definition: R187.Definition, proposal: R187.Proposal }, R187.Rule);
  // Barrido final 3: the judge answers "partly" (PARTLY) and writes raw
  // line breaks inside its JSON strings and inside the examples' (CTRLCHARS).
  await makeBrdp(p42, "BREX-4.2", "BRDP-FIN-PARTLY", { title: R187.Title, definition: R187.Definition, proposal: `${R187.Proposal} PARTLY CTRLCHARS` }, R187.Rule);
  await makeBrdp(p42, "BREX-4.2", "BRDP-FIN-FAIL", { title: R187.Title, definition: R187.Definition, proposal: R187.Proposal }, R187.Rule);
  await makeBrdp(p42, "BREX-4.2", "BRDP-FIN-ASK", { title: "Use of warnings in procedural steps", definition: "Decide when a warning shall be placed before a procedural step.", proposal: "", validation: "Pending" });
  for (const p of projects) await embed(p);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const panels = () => page.getByTestId("rule-test-panel");
  const language = () => page.locator("header select, nav select").first();
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const checkCalls = () => fetch(`${MOCK}/proposal-check-calls`).then((r) => r.json()).then((j) => j.calls);
  async function openProject(p) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await page.waitForTimeout(400);
  }
  async function waitIndicator(state) {
    await page.waitForFunction((s) => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === s, state, { timeout: 15000 });
  }
  async function testDraft() {
    await page.getByRole("button", { name: /^(Test rule|Probar regla)$/ }).first().click();
    await panels().first().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    return panels().first();
  }
  const examplesOf = (panel) => panel.locator('[data-testid^="rule-test-example-"]');

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.waitForTimeout(300);

    // ---- 1. Tables with merged rows ----
    await openProject(pDita);
    await select("BRDP-FIN-MERGED");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    const panel1 = await testDraft();
    const req1 = await lastRequest();
    const sys1 = req1.messages.find((m) => m.role === "system").content;
    assert(sys1.includes("MODEL TABLE:") && sys1.includes('<entry colname="c1" morerows="1">A-100</entry>'), "prompt: the MODEL TABLE built from the DITA topic schema");
    assert(!sys1.includes("proposalMismatch"), "prompt: no proposalMismatch any more");
    const correction1 = req1.messages.filter((m) => m.role === "user").at(-1).content;
    assert(correction1.includes("row 2 is entirely covered by morerows from above (column c2, by the morerows of row 1)"), `correction: the exact cells (${correction1.slice(0, 400)})`);
    assert(correction1.includes("Write the table like the MODEL TABLE in the instructions"), "correction: points at the MODEL TABLE");
    assert(!correction1.includes('Example 1 ("Merged quantity")'), "correction: the accept example (fixed by the app) is not sent back");
    const accept1 = examplesOf(panel1).nth(0);
    assert((await accept1.getByTestId("rule-test-colspecs-added").textContent()).includes("added 3 colspecs"), "app note: colspecs added");
    assert((await accept1.getByTestId("rule-test-cols-raised").textContent()).includes("(2 → 3)"), "app note: cols raised 2 → 3");
    assert((await accept1.getByTestId("rule-test-morerows-lowered").textContent()).includes("row 3"), "app note: morerows past the last row shortened (row 3)");
    assert((await accept1.getByTestId("rule-test-result").textContent()).startsWith("Result: accepted"), "accept example (merged quantity) runs and is accepted");
    assert((await panel1.getByTestId("rule-test-correction").textContent()).includes("1 example was corrected automatically."), "1 of 1 corrected");
    assert((await examplesOf(panel1).nth(1).getByTestId("rule-test-result").textContent()).startsWith("Result: rejected"), "reject example (valid merged row now) rejected");
    assert((await panel1.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), `verdict correct (${await panel1.getByTestId("rule-test-verdict").textContent()})`);
    assert((await checkCalls()) === 1, "one Proposal check call for the test");
    await waitIndicator("passed");
    await panel1.screenshot({ path: shot("rule-test-final-merged-rows.png") });
    await panel1.getByRole("button", { name: "Close" }).click();

    await select("BRDP-FIN-STUBBORN");
    const panel2 = await testDraft();
    const reject2 = examplesOf(panel2).nth(1);
    assert((await reject2.textContent()).includes("row 2 is entirely covered by morerows from above (column c2, by the morerows of row 1): give row 2 its own entries or lower the morerows"), "still invalid: the example says the exact reason");
    await language().selectOption("es");
    await page.waitForTimeout(400);
    assert((await examplesOf(panels().first()).nth(1).textContent()).includes("la fila 2 queda entera bajo el morerows de arriba (columna c2, por el morerows de la fila 1)"), "the exact reason in Spanish");
    await panels().first().screenshot({ path: shot("rule-test-final-covered-row-es.png") });
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await panels().first().getByRole("button", { name: "Close" }).click();

    // ---- 2. Review from its own call ----
    await openProject(p42);
    await select("BRDP-FIN-REVIEW");
    for (let i = 1; i <= 3; i++) {
      await fetch(`${MOCK}/reset`, { method: "POST" });
      const panel = i === 1 ? await testDraft() : panels().first();
      if (i > 1) {
        await panel.getByRole("button", { name: /Regenerate examples/ }).click();
        await page.waitForTimeout(300);
        await panel.getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
        if (await page.getByRole("button", { name: /Record this result|Registrar este resultado/ }).count()) {
          await page.getByRole("button", { name: /Record this result|Registrar este resultado/ }).click();
        }
      }
      const verdict = await panel.getByTestId("rule-test-verdict").textContent();
      assert(verdict.startsWith("Review: the examples pass, but the rule does not seem to implement the Proposal.") && verdict.includes("at most three substeps"), `review ${i}/3 with what is missing (${verdict})`);
      assert((await checkCalls()) === 1, `review ${i}/3: one Proposal check call`);
    }
    const check = await fetch(`${MOCK}/last-proposal-check`).then((r) => r.json());
    assert(check.temperature === 0 && check.messages.find((m) => m.role === "system").content.includes("<proceduralStep> must not appear"), "the check gets the deterministic description, at temperature 0");
    await waitIndicator("review");
    assert((await approvalOf("BRDP-FIN-REVIEW")).last_test_reason?.code === "test_proposal_mismatch", "recorded as review (test_proposal_mismatch)");
    await panels().first().screenshot({ path: shot("rule-test-final-review.png") });
    await panels().first().getByRole("button", { name: "Close" }).click();

    await select("BRDP-FIN-OK");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    const panelOk = await testDraft();
    assert((await panelOk.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), "a rule that implements its Proposal: Correct, no extra Review");
    await waitIndicator("passed");
    await panelOk.getByRole("button", { name: "Close" }).click();

    // "partly": the examples' verdict stands, with an informative note;
    // both answers came with raw line breaks inside their strings.
    await select("BRDP-FIN-PARTLY");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    const panelPartly = await testDraft();
    const vPartly = await panelPartly.getByTestId("rule-test-verdict").textContent();
    assert(vPartly.startsWith("Correct"), `partly: the verdict stays Correct (${vPartly})`);
    const note = await panelPartly.getByTestId("rule-test-partial").textContent();
    assert(note.startsWith("The rule covers part of the Proposal: First line.") && note.includes("cannot be checked by a rule"), `partly: informative note with its reason (${note})`);
    assert((await panelPartly.getByTestId("rule-test-mismatch").count()) === 0, "partly: no Review/indicative mismatch line");
    await waitIndicator("passed");
    await language().selectOption("es");
    await page.waitForTimeout(400);
    assert((await panels().first().getByTestId("rule-test-partial").textContent()).startsWith("La regla cubre parte de la Propuesta:"), "partly: Spanish note");
    await panels().first().screenshot({ path: shot("rule-test-final-3-partly-es.png") });
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await panels().first().getByRole("button", { name: "Close" }).click();

    await select("BRDP-FIN-FAIL");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await fetch(`${MOCK}/proposal-check-fail-next`, { method: "POST" });
    const panelFail = await testDraft();
    const vFail = await panelFail.getByTestId("rule-test-verdict").textContent();
    assert(vFail.startsWith("Review: the examples pass, but the Proposal could not be checked (The answer contains no JSON object.)"), `check failed: never Correct (${vFail})`);
    await waitIndicator("review");
    assert((await approvalOf("BRDP-FIN-FAIL")).last_test_reason?.code === "test_proposal_unchecked", "recorded as review (test_proposal_unchecked)");
    await language().selectOption("es");
    await page.waitForTimeout(400);
    assert((await panels().first().getByTestId("rule-test-verdict").textContent()).startsWith("Revisar: los ejemplos pasan, pero no se pudo comprobar la Propuesta"), "check failed: Spanish text");
    await panels().first().screenshot({ path: shot("rule-test-final-unchecked-es.png") });
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await panels().first().getByRole("button", { name: "Close" }).click();

    // ---- 3. Ask: the internal name never shown ----
    await select("BRDP-FIN-ASK");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    const askTextarea = page.locator("label", { hasText: /Ask a question|Haz una pregunta/ }).locator("xpath=following::textarea[1]");
    await askTextarea.fill("¿Para qué sirve <warning> y cuándo conviene usarlo?");
    await askTextarea.press("Enter");
    await page.getByText("sirve para avisar de un peligro").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    const raw = (await lastRequest()) && (await fetch(`${MOCK}/last-request`).then((r) => r.json()));
    assert(Boolean(raw), "Ask went to the LLM");
    const answer = await page.locator("div", { hasText: "sirve para avisar de un peligro" }).last().textContent();
    assert(!answer.includes("SCHEMA FACTS"), "the answer shown has no SCHEMA FACTS");
    assert(answer.includes("según las fichas del esquema:") && answer.includes("como indica la tarjeta de esquema proporcionada."), `both real patterns cleaned, sentences well formed (${answer})`);
    await page.locator("div", { hasText: "sirve para avisar de un peligro" }).last().screenshot({ path: shot("ask-final-no-internal-name.png") });
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}`, { method: "DELETE" });
  }
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
