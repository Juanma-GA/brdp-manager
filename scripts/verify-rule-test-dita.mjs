// Live verification for "Test de reglas" T4: Test rule on DITA Schematron
// rules (SCH-DITA) in the real app -- the examples built on topic-type
// skeletons, the Schematron engine's verdicts and messages, role="warning",
// sch:let with an inline function and sch:value-of (XPath 3.0), the XPath
// 3.x warning in an XPath 2.0 project, a rule reading the ditamap with
// doc() (not executable from the start, recorded without calling the LLM,
// explained by Verify), and the wrong rule loop: inverted assert →
// incorrect → review (cause rule) → Suggest a corrected rule (with the
// PREVIOUS RULE FAILED ITS TEST block) → correct test → Accept records it.
// T4b: the topic's own <title> in the skeleton (dimmed), the real template
// rule BRDP-EXT-00001 (XPath 3.0, context on a title): the first answer
// puts the title on the table, nothing matches, the correction round asks
// for a node the rule matches and the reject example ends in a titled
// <section> -- verdict correct; and the real BRDP-EXT-00009 (XPath 2.0,
// @@URI-CARPETA-DOSIER@@): not executable from the start with its reason.
//
// Against the real app (Vite + FastAPI + Postgres); only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs: DITA examples by the
// rule's context, review cause "rule" for an inverted assert, the note rule
// for a DITA Proposal about <note>/@type).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the projects it creates. Screenshots go to /tmp.
//
//     node scripts/verify-rule-test-dita.mjs
import { readPublicTemplate } from "./lib/readXlsx.mjs";
import { chromium } from "playwright-core";

// T4b: two real rules of the curated DITA templates.
const templateRule = (file, id) => {
  return readPublicTemplate(file).find((r) => r.ID === id);
};
const EXT1_XPATH3 = templateRule("brdp-template-dita-xpath3.xlsx", "BRDP-EXT-00001");
const EXT9_XPATH2 = templateRule("brdp-template-dita-xpath2.xlsx", "BRDP-EXT-00009");

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
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

const NOTE_RULE = (id, { prefix = "sch:", test = "@type", role = "error" } = {}) =>
  `<${prefix}pattern id="p-${id}">
  <${prefix}rule context="note">
    <${prefix}assert id="${id}" role="${role}" test="${test}">Every note must declare its type (@type).</${prefix}assert>
  </${prefix}rule>
</${prefix}pattern>`;
const STEP_LET_RULE = (id) => `<sch:pattern id="p-${id}">
  <sch:rule context="step">
    <sch:let name="cuenta" value="function($s as element()) as xs:integer { count($s/cmd) }"/>
    <sch:let name="n" value="$cuenta(.)"/>
    <sch:assert id="${id}" role="error" test="$n = 1">Each step has exactly one command; found <sch:value-of select="$n"/>.</sch:assert>
  </sch:rule>
</sch:pattern>`;
const LANG_RULE = (id) => `<pattern id="p-${id}">
  <rule context="/*[not(parent::*)]">
    <assert id="${id}" role="error" test="@xml:lang and normalize-space(@xml:lang) != ''">The topic must declare xml:lang.</assert>
  </rule>
</pattern>`;
const MAP_DOC_RULE = (id) => `<sch:pattern id="p-${id}">
  <sch:rule context="map">
    <sch:let name="docs" value="for $tr in //topicref[@href] return if (doc-available(resolve-uri($tr/@href, base-uri($tr)))) then doc(resolve-uri($tr/@href, base-uri($tr))) else ()"/>
    <sch:assert id="${id}" role="error" test="empty($docs//note[not(@type)])">Some topics of the map have notes without a type.</sch:assert>
  </sch:rule>
</sch:pattern>`;

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
  const brdps = {};

  async function makeProject(name, standard) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    return p;
  }
  async function makeBrdp(project, identifier, proposal, ruleXml) {
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title: `Notes ${identifier}`, definition: "Decide how notes and steps are written.", proposal, validation: "Validated" }),
    }).then((r) => r.json());
    brdps[identifier] = { project, brdp: b };
    const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/SCH-DITA`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: ruleXml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const approvalOf = (identifier) => {
    const { project, brdp } = brdps[identifier];
    return api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`).then((r) => r.json());
  };
  async function embed(project) {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // ---- seed ----
  const p2 = await makeProject("Rule test DITA XPath 2.0", "DITA 1.3 Xpath2.0");
  await makeBrdp(p2, "BRDP-DT-NOTE", "Every <note> shall declare its type with @type.", NOTE_RULE("BRDP-DT-NOTE", { prefix: "" }));
  await makeBrdp(p2, "BRDP-DT-WARN", "Every <note> should declare its type with @type (a recommendation).", NOTE_RULE("BRDP-DT-WARN", { role: "warning" }));
  await makeBrdp(p2, "BRDP-DT-WRONG", "INVERTED: Every <note> shall declare its type with @type.", NOTE_RULE("BRDP-DT-WRONG", { test: "not(@type)" }));
  await makeBrdp(p2, "BRDP-DT-LANG", "Every topic shall declare its language with xml:lang on the root.", LANG_RULE("BRDP-DT-LANG"));
  await makeBrdp(p2, "BRDP-DT-X3", "Each <step> shall contain exactly one <cmd>.", STEP_LET_RULE("BRDP-DT-X3"));
  const p3 = await makeProject("Rule test DITA XPath 3.0", "DITA 1.3 Xpath3.0");
  await makeBrdp(p3, "BRDP-DT-LET", "Each <step> shall contain exactly one <cmd>.", STEP_LET_RULE("BRDP-DT-LET"));
  await makeBrdp(p3, "BRDP-DT-DOC", "Notes reused from the map's topics shall declare their type.", MAP_DOC_RULE("BRDP-DT-DOC"));
  await makeBrdp(p3, "BRDP-DT-TITLED", EXT1_XPATH3.Proposal, EXT1_XPATH3.Rule);
  await makeBrdp(p2, "BRDP-DT-PLACEHOLDER", EXT9_XPATH2.Proposal, EXT9_XPATH2.Rule);
  for (const p of projects) await embed(p);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const panels = () => page.getByTestId("rule-test-panel");
  const indicator = () => page.getByTestId("rule-test-indicator");
  const dialog = () => page.getByTestId("verify-warning-dialog");
  const language = () => page.locator("header select, nav select").first();
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;
  async function openProject(p) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await indicator().waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  async function waitIndicator(state) {
    await page.waitForFunction((s) => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === s, state, { timeout: 15000 });
  }
  async function testDraft() {
    await page.getByRole("button", { name: "Test rule" }).first().click();
    await panels().first().getByTestId("rule-test-verdict").waitFor({ timeout: 15000 });
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
    await openProject(p2);

    // 1. context="note" + assert test="@type" (no sch: prefix, like the
    //    XPath 2.0 template): note without @type rejected with the rule's
    //    message, with @type accepted; examples on the topic skeleton.
    await select("BRDP-DT-NOTE");
    assert((await page.getByRole("button", { name: "Verify", exact: true }).count()) === 1, "DITA: Verify available on a Draft rule");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().waitFor({ timeout: 3000 });
    assert((await dialog().getAttribute("data-kind")) === "not_tested", "DITA rule never tested: the Verify warning applies (not tested)");
    await dialog().getByRole("button", { name: "Test now" }).click();
    const panel1 = panels().first();
    await panel1.getByTestId("rule-test-verdict").waitFor({ timeout: 15000 });
    const desc1 = await panel1.getByTestId("rule-test-description").textContent();
    assert(desc1.includes('For each note: @type must hold — message: "Every note must declare its type (@type)."'), `describeRule: exact statement (${desc1})`);
    const prompt1 = systemOf(await lastRequest());
    assert(prompt1.includes('Every example is a DITA topic ("schema": "topic").') && prompt1.includes('- topic type "topic": your content goes directly inside <body>'), "examples prompt: topic type + topic/body insertion");
    assert(prompt1.includes("a ship or aircraft maintenance manual") && !prompt1.includes("dmRef"), "examples prompt: naval/aeronautical content, no S1000D references");
    assert((await panel1.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), `verdict correct (${await panel1.getByTestId("rule-test-verdict").textContent()})`);
    const ex0 = examplesOf(panel1).nth(0);
    const ex1 = examplesOf(panel1).nth(1);
    assert((await ex0.textContent()).includes("Topic type: topic"), "example labelled with its topic type");
    assert((await ex0.textContent()).includes("<topic>") && (await ex0.textContent()).includes("<body>"), "example built on the topic skeleton");
    assert((await ex1.getByTestId("rule-test-result").textContent()).startsWith("Result: rejected"), "note without @type: rejected");
    assert((await ex1.textContent()).includes("Rule's message: Every note must declare its type (@type)."), "rejected example shows the rule's message");
    assert((await ex0.getByTestId("rule-test-result").textContent()).startsWith("Result: accepted"), "note with @type: accepted");
    // T4b: the topic's mandatory <title>, part of the dimmed skeleton.
    assert((await ex0.textContent()).includes("<title>Example topic</title>"), "T4b: the topic skeleton carries its <title>");
    const titleSpan = ex0.locator("span", { hasText: /^Example topic$/ }).first();
    assert(/ruleTestSkeleton/.test((await titleSpan.getAttribute("class")) || ""), "T4b: the skeleton title is dimmed like the rest of the skeleton");
    await waitIndicator("passed");
    assert((await approvalOf("BRDP-DT-NOTE")).last_test_result === "passed", "DITA test recorded as passed");
    await panel1.screenshot({ path: "/tmp/rule-test-dita-note.png" });
    await language().selectOption("es");
    await page.waitForTimeout(300);
    const desc1es = await panels().first().getByTestId("rule-test-description").textContent();
    assert(desc1es.includes('Para cada note: debe cumplirse @type — mensaje: "Every note must declare its type (@type)."'), `describeRule in Spanish (${desc1es})`);
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await panels().first().getByRole("button", { name: "Close" }).click();

    // 2. role="warning": a warning, never a rejection.
    await select("BRDP-DT-WARN");
    const panel2 = await testDraft();
    const desc2 = await panel2.getByTestId("rule-test-description").textContent();
    assert(desc2.includes("(warning: does not reject)") && desc2.includes("This rule cannot reject any content."), `warning rule: described as not rejecting (${desc2})`);
    const warnEx = examplesOf(panel2).nth(1);
    assert((await warnEx.getByTestId("rule-test-result").textContent()).startsWith("Result: accepted"), "role=warning: the untyped note is accepted");
    assert((await warnEx.getByTestId("rule-test-rule-warning").textContent()).includes("Rule warning (does not reject): Every note must declare its type (@type)."), "role=warning: the warning is shown");
    await panel2.screenshot({ path: "/tmp/rule-test-dita-warning.png" });
    await panel2.getByRole("button", { name: "Close" }).click();

    // 3. Whole-document rule (root context): the LLM writes the whole topic.
    await select("BRDP-DT-LANG");
    const panel3 = await testDraft();
    assert(systemOf(await lastRequest()).includes("your content is the WHOLE document"), "root context: whole-document prompt");
    assert((await panel3.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), "root context: verdict correct");
    await panel3.getByRole("button", { name: "Close" }).click();

    // 4. XPath 3.x syntax in an XPath 2.0 project: warned, still run.
    await select("BRDP-DT-X3");
    const panel4 = await testDraft();
    const x3 = await panel4.getByTestId("rule-test-analysis-warning").textContent();
    assert(x3.includes("This project uses XPath 2.0, but the rule uses XPath 3.x syntax (inline function, dynamic function call)") && x3.includes("The test runs it anyway."), `XPath 3.x warning (${x3})`);
    assert((await panel4.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), "XPath 3.x rule still runs in the XPath 2.0 project");
    await panel4.getByRole("button", { name: "Close" }).click();

    // 5. The wrong rule: inverted assert → incorrect → review (cause rule)
    //    → Suggest a corrected rule → correct test → Accept records it.
    await select("BRDP-DT-WRONG");
    const panel5 = await testDraft();
    assert((await panel5.getByTestId("rule-test-verdict").textContent()).startsWith("The rule accepted an example meant to violate it"), "inverted assert: verdict incorrect");
    await waitIndicator("failed");
    await panel5.getByTestId("rule-test-review").click();
    await panel5.getByTestId("rule-test-review-result").waitFor({ timeout: 15000 });
    const reviewPrompt = systemOf(await lastRequest());
    assert(reviewPrompt.includes("- For each note: not(@type) must hold"), "review prompt carries the Schematron description");
    assert((await panel5.getByTestId("rule-test-review-result").getAttribute("data-cause")) === "rule", "review: cause rule");
    await panel5.getByTestId("rule-test-suggest-corrected").click();
    await page.getByTestId("rule-corrected-note").waitFor({ timeout: 15000 });
    const sugPrompt = systemOf(await lastRequest());
    assert(sugPrompt.includes("FORMAT — ISO Schematron") && sugPrompt.includes("PREVIOUS RULE FAILED ITS TEST") && sugPrompt.includes('test="not(@type)"'), "Suggest Rule (Schematron) prompt carries the failed rule");
    const suggested = await page.locator('[class*="suggestionCode"]').first().textContent();
    assert(suggested.includes('test="@type"'), `corrected rule asserts @type (${suggested})`);
    await panel5.getByRole("button", { name: "Close" }).click();
    const sugBox = page.locator('xpath=//*[@data-testid="rule-corrected-note"]/..');
    await sugBox.getByRole("button", { name: "Test rule" }).click();
    const sugPanel = sugBox.getByTestId("rule-test-panel");
    await sugPanel.getByTestId("rule-test-verdict").waitFor({ timeout: 15000 });
    assert((await sugPanel.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), "corrected rule: verdict correct");
    await page.screenshot({ path: "/tmp/rule-test-dita-corrected.png", fullPage: true });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await waitIndicator("passed");
    const wrongAfter = await approvalOf("BRDP-DT-WRONG");
    assert(wrongAfter.last_test_result === "passed" && wrongAfter.last_test_up_to_date && wrongAfter.rule_xml.includes('test="@type"'), "accepted corrected rule recorded as passed");

    // 6. XPath 3.0: sch:let with an inline function; the message shows the
    //    evaluated sch:value-of; examples on the task skeleton.
    await openProject(p3);
    await select("BRDP-DT-LET");
    const panel6 = await testDraft();
    assert((await panel6.getByTestId("rule-test-analysis-warning").count()) === 0, "XPath 3.0 project: no XPath 3.x warning");
    assert((await panel6.getByTestId("rule-test-description").textContent()).includes("For each step: variables cuenta, n."), "description lists the sch:let variables");
    assert((await examplesOf(panel6).nth(0).textContent()).includes("Topic type: task"), "step rule: task topic type");
    assert((await examplesOf(panel6).nth(1).textContent()).includes("Rule's message: Each step has exactly one command; found 2."), "message with the evaluated sch:value-of");
    assert((await panel6.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), "sch:let + inline function: verdict correct");
    await panel6.screenshot({ path: "/tmp/rule-test-dita-let.png" });
    await panel6.getByRole("button", { name: "Close" }).click();

    // 7. doc() on the ditamap: not executable from the start, explained by
    //    Verify, recorded without calling the LLM when the panel opens.
    await select("BRDP-DT-DOC");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().waitFor({ timeout: 3000 });
    assert((await dialog().getAttribute("data-kind")) === "not_executable", "doc(): Verify explains it is not executable");
    assert((await dialog().textContent()).includes("The rule reads another file (doc-available()), which is not available in a test."), `doc() dialog reason (${await dialog().textContent()})`);
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Test rule" }).first().click();
    const panel7 = panels().first();
    await panel7.getByTestId("rule-test-analysis").waitFor({ timeout: 5000 });
    assert((await panel7.getByTestId("rule-test-analysis").textContent()).includes("reads another file"), "doc(): reason shown from the start");
    assert((await panel7.getByTestId("rule-test-show-examples").count()) === 1, "doc(): illustrative examples only on demand");
    await waitIndicator("not_executable");
    assert((await lastRequest()) === null, "doc(): recorded without calling the LLM");
    assert((await approvalOf("BRDP-DT-DOC")).last_test_result === "not_executable", "doc(): recorded as not executable");
    await panel7.screenshot({ path: "/tmp/rule-test-dita-doc.png" });
    await panel7.getByRole("button", { name: "Close" }).click();

    // 8. T4b: the real BRDP-EXT-00001 (XPath 3.0), a context on a title.
    await select("BRDP-DT-TITLED");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    const panel8 = await testDraft();
    const req8 = await lastRequest();
    const sys8 = systemOf(req8);
    assert(sys8.includes("THE RULE DEPENDS ON A TITLE") && sys8.includes("<section><title>Parts list</title><table>…</table></section>"), "EXT-00001: prompt asks for a titled section, generic example");
    const correction8 = req8.messages.filter((m) => m.role === "user").at(-1).content;
    assert(correction8.startsWith("Some examples are not valid.") && correction8.includes('Example 2 ("Part row without quantity")') && correction8.includes("This example must contain a node matched by: `*[title = ('LISTA DE MATERIAL OBLIGATORIO',") && correction8.includes("Nothing in it matches, so the rule never runs."), `EXT-00001: one correction round, for the reject example (${correction8})`);
    // C3, Part 1c: EXT-00001 checks cell values, so the accept example (the
    // title on the table: nothing selected in it either) goes back too.
    assert(correction8.includes('Example 1 ("Part row with quantity"):\n- The rule checks values, so at least one example meant to be accepted must contain a node matched by:'), "EXT-00001: the accept example without a selected node is sent back (value rule)");
    assert((await panel8.getByTestId("rule-test-correction").textContent()).includes("2 examples were corrected automatically."), "EXT-00001: 2 of 2 corrected");
    const rej8 = examplesOf(panel8).nth(1);
    const rej8Text = await rej8.textContent();
    assert(rej8Text.includes("<section>") && rej8Text.includes("<title>LISTA DE MATERIAL OBLIGATORIO</title>") && rej8Text.includes("<title>Example topic</title>"), "EXT-00001: reject example in a titled section inside the titled topic");
    assert((await rej8.getByTestId("rule-test-result").textContent()).startsWith("Result: rejected"), "EXT-00001: the row without quantity is rejected");
    assert(rej8Text.includes("Rule's message: En tablas con columna"), "EXT-00001: the rule's own message");
    assert((await panel8.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), `EXT-00001: verdict correct (${await panel8.getByTestId("rule-test-verdict").textContent()})`);
    await waitIndicator("passed");
    await panel8.screenshot({ path: "/tmp/rule-test-dita-titled-section.png" });
    await panel8.getByRole("button", { name: "Close" }).click();

    // 9. T4b: the real BRDP-EXT-00009 (XPath 2.0), @@URI-CARPETA-DOSIER@@.
    await openProject(p2);
    await select("BRDP-DT-PLACEHOLDER");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().waitFor({ timeout: 3000 });
    const reason9 = "The rule contains a value that is replaced outside the app (@@URI-CARPETA-DOSIER@@); it cannot be tested here.";
    assert((await dialog().getAttribute("data-kind")) === "not_executable" && (await dialog().textContent()).includes(reason9), `@@…@@: Verify explains it is not executable (${await dialog().textContent()})`);
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Test rule" }).first().click();
    const panel9 = panels().first();
    await panel9.getByTestId("rule-test-analysis").waitFor({ timeout: 5000 });
    assert((await panel9.getByTestId("rule-test-analysis").textContent()).includes(reason9), "@@…@@: reason shown from the start");
    assert((await panel9.getByTestId("rule-test-cannot-reject").count()) === 0, "@@…@@: never described as 'cannot reject'");
    await waitIndicator("not_executable");
    assert((await lastRequest()) === null, "@@…@@: recorded without calling the LLM");
    await language().selectOption("es");
    await page.waitForTimeout(300);
    assert((await panels().first().getByTestId("rule-test-analysis").textContent()).includes("La regla contiene un valor que se sustituye fuera de la app (@@URI-CARPETA-DOSIER@@); no se puede probar aquí."), "@@…@@: reason in Spanish");
    await panels().first().screenshot({ path: "/tmp/rule-test-dita-placeholder-es.png" });
    await language().selectOption("en");
  } finally {
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
    console.log("Cleaned up the seeded projects.");
    await browser.close();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
