// Live verification for "Test de reglas (T2 de 4)": the Test rule button on
// a Suggest Rule suggestion and on a saved Draft rule, the panel (verdict,
// explanation, examples with results, highlighted nodes, the rule's
// message, "Run again" on an edited example, Regenerate, Copy test prompt),
// against the real app (Vite + FastAPI + Postgres). Only the Mistral
// TRANSPORT is mocked: mock-mistral-chat-server.mjs answers the examples
// prompt with fixed examples chosen from the rule it quotes.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the projects it creates. Screenshots go to /tmp.
//
//     node scripts/verify-rule-test.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
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

const RULE_TYPE = `<structureObjectRule id="BRDP-RT-TYPE" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="BRDP-RT-TYPE"/>
  <objectPath allowedObjectFlag="2">//@emphasisType</objectPath>
  <objectUse>Only emphasis types em01 and em02 are allowed.</objectUse>
  <objectValue valueForm="single" valueAllowed="em01"/>
  <objectValue valueForm="single" valueAllowed="em02"/>
</structureObjectRule>`;
const RULE_PROCED = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">
  <structureObjectRuleGroup>
    <structureObjectRule id="BRDP-RT-PROCED">
      <objectPath allowedObjectFlag="0">//emphasis</objectPath>
      <objectUse>No emphasis in procedural data modules.</objectUse>
    </structureObjectRule>
  </structureObjectRuleGroup>
</contextRules>`;
const RULE_DOC = `<structureObjectRule id="BRDP-RT-DOC">
  <objectPath allowedObjectFlag="0">document('common.xml')//emphasis</objectPath>
  <objectUse>No emphasis in the common file.</objectUse>
</structureObjectRule>`;
const RULE_BROKEN = `<structureObjectRule id="BRDP-RT-BROKEN">
  <objectPath allowedObjectFlag="0">//emphasis</objectPath>
  <objectUse>No emphasis.</objectUse>
</structureObjectRule>`;

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
  const projects = [];

  async function makeProject(name, standard) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    return p;
  }
  async function makeBrdp(project, fields) {
    return api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ definition: "Decide how emphasis is used.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
  }
  async function putDraft(project, brdp, format, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
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

  // ---- seed ----
  const p42 = await makeProject("Rule test 4.2", "S1000D 4.2");
  const emph = await makeBrdp(p42, { identifier: "BRDP-RT-EMPH", title: "Use of the element <emphasis>", proposal: "The element <emphasis> shall not be used." });
  const type = await makeBrdp(p42, { identifier: "BRDP-RT-TYPE", title: "Emphasis types", proposal: "@emphasisType shall only take em01 and em02." });
  const proced = await makeBrdp(p42, { identifier: "BRDP-RT-PROCED", title: "Emphasis in procedures", proposal: "In procedural data modules, <emphasis> shall not be used." });
  const doc = await makeBrdp(p42, { identifier: "BRDP-RT-DOC", title: "Common file", proposal: "The common file shall not use emphasis." });
  const broken = await makeBrdp(p42, { identifier: "BRDP-RT-BROKEN", title: "Broken answer", proposal: "BROKENJSON: the mock returns a truncated answer." });
  await putDraft(p42, type, "BREX-4.2", RULE_TYPE);
  await putDraft(p42, proced, "BREX-4.2", RULE_PROCED);
  await putDraft(p42, doc, "BREX-4.2", RULE_DOC);
  await putDraft(p42, broken, "BREX-4.2", RULE_BROKEN);
  const pDita = await makeProject("Rule test DITA", "DITA 1.3 Xpath2.0");
  const dita = await makeBrdp(pDita, { identifier: "BRDP-RT-DITA", title: "Notes", proposal: "Every note shall declare a type." });
  await putDraft(pDita, dita, "SCH-DITA", '<sch:pattern id="p1"><sch:rule context="note"><sch:assert id="a1" test="@type">Type.</sch:assert></sch:rule></sch:pattern>');
  for (const p of [p42, pDita]) await embed(p);
  void emph;

  // ---- UI ----
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  async function openProject(p) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(500); // rule approval fetch
  }
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  async function waitVerdict() {
    await verdict().waitFor({ timeout: 15000 });
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    await openProject(p42);

    // 1. //emphasis flag 0, on a Suggest Rule suggestion (before Accept).
    await select("BRDP-RT-EMPH");
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    await page.getByRole("button", { name: "Discard" }).waitFor({ timeout: 15000 });
    const actions = page.locator("div", { has: page.getByRole("button", { name: "Test rule" }) }).last();
    const labels = await actions.getByRole("button").allTextContents();
    assert(labels.indexOf("Test rule") >= 0 && labels.indexOf("Test rule") < labels.indexOf("Accept"), `suggestion: "Test rule" sits before Accept (${labels.join(" | ")})`);
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    const req1 = await lastRequest();
    const sys1 = req1.messages.find((m) => m.role === "system").content;
    assert(req1.temperature === 0.5, `examples prompt sent with RULE_TEST_TEMPERATURE (got ${req1.temperature})`);
    assert(sys1.includes("<objectPath allowedObjectFlag=\"0\">//emphasis</objectPath>"), "the prompt quotes the suggested rule (in memory, not saved)");
    assert(sys1.includes("SCHEMA FACTS") && sys1.includes("<emphasis>"), "the prompt carries the schema facts of the rule's element");
    assert((await verdict().textContent()).startsWith("Correct"), `//emphasis: verdict correct (${await verdict().textContent()})`);
    assert((await panel().textContent()).includes("La regla prohíbe el elemento <emphasis>"), "explanation shown");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("Result: accepted ✓"), "//emphasis: accept example accepted");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("Result: rejected ✓"), "//emphasis: reject example rejected");
    const marks1 = await example(1).locator("mark").allTextContents();
    assert(marks1.join("") === "<emphasis></emphasis>", `//emphasis: <emphasis> highlighted in the rejected example (${JSON.stringify(marks1)})`);
    assert((await example(0).locator("mark").count()) === 0, "//emphasis: nothing highlighted in the accepted example");
    assert((await example(1).textContent()).includes("Rule's message: MOCK-RULE: <emphasis> is not used."), "rejected example shows the rule's own message");
    const resultColor = await example(1).getByTestId("rule-test-result").evaluate((el) => getComputedStyle(el).color);
    assert(resultColor === "rgb(185, 28, 28)", `rejected result in red (${resultColor})`);
    const okColor = await example(0).getByTestId("rule-test-result").evaluate((el) => getComputedStyle(el).color);
    assert(okColor === "rgb(22, 163, 74)", `accepted result in green (${okColor})`);
    const approvalBefore = await api(`/api/projects/${p42.id}/brdps/${emph.id}/approvals/BREX-4.2`);
    assert(approvalBefore.status === 404 || (await approvalBefore.json()) === null, "testing a suggestion saves nothing");
    await panel().screenshot({ path: "/tmp/rule-test-emphasis.png" });
    await page.getByRole("button", { name: "Discard" }).first().click();

    // 2. @emphasisType em01/em02, on a saved Draft rule.
    await select("BRDP-RT-TYPE");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    assert((await verdict().textContent()).startsWith("Correct"), "@emphasisType: verdict correct");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected"), "@emphasisType: em05 rejected");
    assert((await example(1).textContent()).includes("Rule's message: Only emphasis types em01 and em02 are allowed."), "@emphasisType: em05 shows the rule's message");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("accepted"), "@emphasisType: em01 accepted");
    const marks2 = await example(1).locator("mark").allTextContents();
    assert(JSON.stringify(marks2) === JSON.stringify(['emphasisType="em05"']), `@emphasisType: only the attribute highlighted (${JSON.stringify(marks2)})`);
    await panel().screenshot({ path: "/tmp/rule-test-emphasis-type.png" });

    // Edit em05 → em02 and Run again: no LLM call, result becomes accepted.
    const before = JSON.stringify(await lastRequest());
    await example(1).getByRole("button", { name: "Edit" }).click();
    const editor = example(1).locator("textarea");
    await editor.fill((await editor.inputValue()).replace("em05", "em02"));
    await example(1).getByRole("button", { name: "Run again" }).click();
    await page.waitForTimeout(300);
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("Result: accepted ✗"), "edited to em02 + Run again → accepted (no longer what the example expected)");
    assert((await verdict().textContent()).startsWith("The rule accepted an example meant to violate it."), "verdict now says the rule accepted an example meant to violate it");
    assert(JSON.stringify(await lastRequest()) === before, "Run again made no LLM call");
    const saved = await api(`/api/projects/${p42.id}/brdps/${type.id}/approvals/BREX-4.2`).then((r) => r.json());
    assert(saved.rule_xml === RULE_TYPE && saved.status === "pending_review", "Run again saved nothing");

    // Copy test prompt = the prompt that was sent + the user message.
    await page.getByRole("button", { name: "Copy test prompt" }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const req2 = await lastRequest();
    const sys2 = req2.messages.find((m) => m.role === "system").content;
    assert(clip === `${sys2}\n\nWrite the test examples for this rule.`, "Copy test prompt copies exactly the prompt sent");

    // Regenerate: a new LLM call, the edit is gone.
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});
    await page.getByRole("button", { name: "Regenerate examples" }).click();
    await waitVerdict();
    assert((await verdict().textContent()).startsWith("Correct"), "Regenerate: fresh examples, verdict correct again");
    await page.getByRole("button", { name: "Close" }).click();
    assert((await panel().count()) === 0, "Close hides the panel");

    // 3. <emphasis> forbidden only in proced: the descript example is accepted.
    await select("BRDP-RT-PROCED");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    const sys3 = (await lastRequest()).messages.find((m) => m.role === "system").content;
    assert(sys3.includes('Add a third example from the descript schema ("schema": "descript",'), "context rule: the prompt asks for a descript example");
    assert((await verdict().textContent()).startsWith("Correct"), "proced-only: verdict correct");
    assert((await example(2).getByTestId("rule-test-result").textContent()).includes("Result: accepted ✓"), "descript example with <emphasis> accepted");
    assert((await example(2).textContent()).includes("The rule does not apply to the descript schema."), "descript example says the rule does not apply there");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected"), "proced example with <emphasis> rejected");
    await panel().screenshot({ path: "/tmp/rule-test-proced-context.png" });

    // 4. document(): reason visible, examples visible, no results.
    await select("BRDP-RT-DOC");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    assert((await verdict().textContent()).includes("The rule reads another file (document())"), `document(): the engine's reason is shown (${await verdict().textContent()})`);
    assert((await example(0).locator("pre").count()) === 1 && (await example(1).locator("pre").count()) === 1, "document(): the examples stay visible");
    assert((await panel().getByTestId("rule-test-result").count()) === 0, "document(): no result lines");

    // 5. Broken JSON: error with Regenerate, nothing run.
    await select("BRDP-RT-BROKEN");
    await page.getByRole("button", { name: "Test rule" }).click();
    await panel().getByRole("alert").waitFor({ timeout: 15000 });
    assert((await panel().getByRole("alert").textContent()).includes("The examples could not be used: The answer is not valid JSON"), "broken JSON: error visible");
    assert((await panel().getByRole("button", { name: "Regenerate examples" }).count()) === 1, "broken JSON: Regenerate offered");
    assert((await page.getByTestId("rule-test-example-0").count()) === 0, "broken JSON: nothing executed or shown");

    // 6. DITA: no Test rule (the engine runs BREX only).
    await openProject(pDita);
    await select("BRDP-RT-DITA");
    assert((await page.getByRole("button", { name: "Test rule" }).count()) === 0, "DITA Draft rule: no Test rule button");

    // 7. Spanish UI.
    await openProject(p42);
    await select("BRDP-RT-TYPE");
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Probar regla" }).click();
    await waitVerdict();
    assert((await verdict().textContent()).startsWith("Correcto"), "Spanish: verdict translated");
    assert((await example(1).textContent()).includes("Esperado: rechazado"), "Spanish: expected/result translated");
    await page.locator("header select, nav select").first().selectOption("en");
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
