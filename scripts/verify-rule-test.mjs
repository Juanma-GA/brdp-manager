// Live verification for "Test de reglas" (T2, T2b): the Test rule button on
// a Suggest Rule suggestion and on a saved Draft rule, the panel (what cannot
// be tested shown from the start, verdict, description, "does not implement
// the Proposal" warning, examples built on the application's skeleton with
// the skeleton dimmed and the content highlighted, highlighted nodes, the
// rule's message, structural problems, the one automatic correction round,
// "Run again" on an edited example, Copy XML with its indentation,
// Regenerate, Copy test prompt), against the real app (Vite + FastAPI +
// Postgres). Only the Mistral TRANSPORT is mocked:
// mock-mistral-chat-server.mjs answers the examples prompt with fixed
// content chosen from the rule it quotes (and BROKENSTRUCT/STUBBORN/MISMATCH
// markers in the Proposal).
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

const RULE_TYPE = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">
  <structureObjectRuleGroup>
    <structureObjectRule id="BRDP-RT-TYPE" brSeverityLevel="brsl01">
      <brDecisionRef brDecisionIdentNumber="BRDP-RT-TYPE"/>
      <objectPath allowedObjectFlag="2">//emphasis/@emphasisType</objectPath>
      <objectUse>Only emphasis types em01 and em02 are allowed.</objectUse>
      <objectValue valueForm="single" valueAllowed="em01"/>
      <objectValue valueForm="single" valueAllowed="em02"/>
    </structureObjectRule>
  </structureObjectRuleGroup>
</contextRules>`;
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
const RULE_PARTIAL = `<structureObjectRule id="BRDP-RT-PART">
  <objectPath allowedObjectFlag="0">//emphasis</objectPath>
  <objectUse>No emphasis.</objectUse>
</structureObjectRule>
<nonContextRule id="BRDP-RT-PART-N">
  <simplePara>Checked manually in the review.</simplePara>
</nonContextRule>`;
const RULE_EMPH = `<structureObjectRule id="BRDP-RT-X">
  <objectPath allowedObjectFlag="0">//emphasis</objectPath>
  <objectUse>No emphasis.</objectUse>
</structureObjectRule>`;
const RULE_301 = `<objrule id="BRDP-RT-301">
  <objpath objappl="0">//emphasis</objpath>
  <objuse>No emphasis.</objuse>
</objrule>`;

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
  const type = await makeBrdp(p42, { identifier: "BRDP-RT-TYPE", title: "Emphasis types", proposal: "In procedural data modules, @emphasisType shall only take em01 and em02." });
  const proced = await makeBrdp(p42, { identifier: "BRDP-RT-PROCED", title: "Emphasis in procedures", proposal: "In procedural data modules, <emphasis> shall not be used." });
  const doc = await makeBrdp(p42, { identifier: "BRDP-RT-DOC", title: "Common file", proposal: "The common file shall not use emphasis." });
  const partial = await makeBrdp(p42, { identifier: "BRDP-RT-PART", title: "Emphasis (partly manual)", proposal: "The element <emphasis> shall not be used." });
  const broken = await makeBrdp(p42, { identifier: "BRDP-RT-BROKEN", title: "Broken answer", proposal: "BROKENJSON: the mock returns a truncated answer." });
  const fixable = await makeBrdp(p42, { identifier: "BRDP-RT-FIX", title: "Emphasis types (fix)", proposal: "BROKENSTRUCT: in procedural data modules, @emphasisType shall only take em01 and em02." });
  const stubborn = await makeBrdp(p42, { identifier: "BRDP-RT-STUB", title: "Emphasis types (stubborn)", proposal: "STUBBORN: in procedural data modules, @emphasisType shall only take em01 and em02." });
  const mismatch = await makeBrdp(p42, { identifier: "BRDP-RT-MISM", title: "CAGE codes", proposal: "MISMATCH: permitted CAGE codes shall be listed in the front matter." });
  await putDraft(p42, type, "BREX-4.2", RULE_TYPE);
  await putDraft(p42, proced, "BREX-4.2", RULE_PROCED);
  await putDraft(p42, doc, "BREX-4.2", RULE_DOC);
  await putDraft(p42, partial, "BREX-4.2", RULE_PARTIAL);
  await putDraft(p42, broken, "BREX-4.2", RULE_EMPH);
  await putDraft(p42, fixable, "BREX-4.2", RULE_TYPE.replaceAll("BRDP-RT-TYPE", "BRDP-RT-FIX"));
  await putDraft(p42, stubborn, "BREX-4.2", RULE_TYPE.replaceAll("BRDP-RT-TYPE", "BRDP-RT-STUB"));
  await putDraft(p42, mismatch, "BREX-4.2", RULE_EMPH.replace("BRDP-RT-X", "BRDP-RT-MISM"));
  const p301 = await makeProject("Rule test 3.0.1", "S1000D 3.0.1");
  const b301 = await makeBrdp(p301, { identifier: "BRDP-RT-301", title: "Use of <emphasis>", proposal: "The element <emphasis> shall not be used." });
  await putDraft(p301, b301, "BREX-3.0.1", RULE_301);
  const pDita = await makeProject("Rule test DITA", "DITA 1.3 Xpath2.0");
  const dita = await makeBrdp(pDita, { identifier: "BRDP-RT-DITA", title: "Notes", proposal: "Every note shall declare a type." });
  await putDraft(pDita, dita, "SCH-DITA", '<sch:pattern id="p1"><sch:rule context="note"><sch:assert id="a1" test="@type">Type.</sch:assert></sch:rule></sch:pattern>');
  for (const p of [p42, p301, pDita]) await embed(p);

  // ---- UI ----
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
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

    // 1. //emphasis flag 0 in 4.2, on a Suggest Rule suggestion (before
    //    Accept): as before, now inside a real descript skeleton.
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
    assert(sys1.includes('<objectPath allowedObjectFlag="0">//emphasis</objectPath>'), "the prompt quotes the suggested rule (in memory, not saved)");
    assert(sys1.includes('your content goes directly inside <para>, at\n  dmodule/content/description/levelledPara/para.'), "general rule: the prompt offers the descript skeleton's <para>");
    assert(sys1.includes("SCHEMA FACTS") && sys1.includes("<emphasis>"), "the prompt carries the schema facts of the rule's element");
    assert((await verdict().textContent()).startsWith("Correct"), `//emphasis: verdict correct (${await verdict().textContent()})`);
    assert((await page.getByTestId("rule-test-description").textContent()).includes("<emphasis> must not appear (path //emphasis)."), "deterministic description shown (T3b: no LLM explanation)");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("Result: accepted ✓"), "//emphasis: accept example accepted");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("Result: rejected ✓"), "//emphasis: reject example rejected");
    assert((await example(1).locator("pre").textContent()).includes("<levelledPara>"), "//emphasis: example built on the real descript skeleton");
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
    assert((await panel().getByTestId("rule-test-analysis").count()) === 0, "an executable rule shows no analysis warning");
    await panel().screenshot({ path: "/tmp/rule-test-emphasis.png" });
    await page.getByRole("button", { name: "Discard" }).first().click();

    // 2. @emphasisType em01/em02 limited to proced, on a saved Draft rule.
    await select("BRDP-RT-TYPE");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    const sys2 = (await lastRequest()).messages.find((m) => m.role === "system").content;
    assert(sys2.includes('schema "proced": your content goes directly inside <para>, at\n  dmodule/content/procedure/mainProcedure/proceduralStep/para.'), "proced skeleton offered to the LLM");
    assert(sys2.includes('Add a third example of the descript schema ("schema": "descript",'), "context rule: the prompt asks for a descript example");
    assert((await verdict().textContent()).startsWith("Correct"), `proced @emphasisType: verdict correct (${await verdict().textContent()})`);
    const xml1 = await example(1).locator("pre").textContent();
    assert(xml1.includes("<proceduralStep>") && xml1.includes("<mainProcedure>") && xml1.includes('emphasisType="em03"'), "examples with proceduralStep/para/emphasis");
    assert(xml1.includes('xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"'), "the skeleton carries the proced schema location");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected"), "em03 rejected");
    assert((await example(1).textContent()).includes("Rule's message: Only emphasis types em01 and em02 are allowed."), "em03 shows the rule's message");
    assert((await example(2).getByTestId("rule-test-result").textContent()).includes("Result: accepted ✓"), "descript example accepted");
    assert((await example(2).textContent()).includes("The rule does not apply to the descript schema."), "descript example: does not apply");
    const marks2 = await example(1).locator("mark").allTextContents();
    assert(JSON.stringify(marks2) === JSON.stringify(['emphasisType="em03"']), `only the attribute highlighted (${JSON.stringify(marks2)})`);
    // Skeleton dimmed, content highlighted.
    const skeletonSpan = example(1).locator("pre span", { hasText: "<proceduralStep" }).first();
    const skColor = await skeletonSpan.evaluate((el) => getComputedStyle(el).color);
    assert(skColor === "rgb(148, 163, 184)", `skeleton dimmed (${skColor})`);
    const contentSpan = example(1).locator("pre span", { hasText: "sealant" }).first();
    const ctBg = await contentSpan.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(ctBg === "rgb(224, 242, 254)", `content highlighted (${ctBg})`);
    // Part 6: whole, indented, inside its block -- on screen and copied.
    const fits = await example(1).locator("pre").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    assert(fits, "the multi-line example fits its block (no hidden overflow)");
    // (the document now starts with its identification and status section)
    const indented = await example(1).locator("pre > div", { hasText: /^\s*<para>/ }).first().evaluate((el) => getComputedStyle(el).paddingLeft);
    assert(parseFloat(indented) > 50, `deep lines indented on screen (${indented})`);
    await example(1).getByRole("button", { name: "Copy XML" }).click();
    const copiedXml = await page.evaluate(() => navigator.clipboard.readText());
    assert(copiedXml.split("\n").some((l) => l.startsWith("          <para>")) && copiedXml.split("\n")[1] === "  <identAndStatusSection>", `Copy XML keeps the indentation (${JSON.stringify(copiedXml.split("\n").slice(0, 3))})`);
    const selectedText = await example(1).locator("pre").evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });
    assert(/\n {8}<proceduralStep>/.test(selectedText), "a mouse selection copies the indentation too");
    await panel().screenshot({ path: "/tmp/rule-test-emphasis-type.png" });

    // Edit the content em03 → em02 and Run again: no LLM call.
    const before = JSON.stringify(await lastRequest());
    await example(1).getByRole("button", { name: "Edit" }).click();
    const editor = example(1).locator("textarea");
    assert(!(await editor.inputValue()).includes("<dmodule"), "Edit opens the content only (the skeleton is the application's)");
    await editor.fill((await editor.inputValue()).replace("em03", "em02"));
    await example(1).getByRole("button", { name: "Run again" }).click();
    await page.waitForTimeout(300);
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("Result: accepted ✗"), "edited to em02 + Run again → accepted");
    assert((await verdict().textContent()).startsWith("The rule accepted an example meant to violate it."), "verdict: the rule accepted an example meant to violate it");
    assert((await example(1).locator("pre").textContent()).includes("<proceduralStep>"), "the edited content is rebuilt on the skeleton");
    assert(JSON.stringify(await lastRequest()) === before, "Run again made no LLM call");
    const saved = await api(`/api/projects/${p42.id}/brdps/${type.id}/approvals/BREX-4.2`).then((r) => r.json());
    assert(saved.rule_xml === RULE_TYPE && saved.status === "pending_review", "Run again saved nothing");

    // Copy test prompt = the prompt that was sent + the user message.
    await page.getByRole("button", { name: "Copy test prompt" }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip === `${sys2}\n\nWrite the test examples for this rule.`, "Copy test prompt copies exactly the prompt sent");

    await page.getByRole("button", { name: "Regenerate examples" }).click();
    await waitVerdict();
    assert((await verdict().textContent()).startsWith("Correct"), "Regenerate: fresh examples, verdict correct again");
    await page.getByRole("button", { name: "Close" }).click();
    assert((await panel().count()) === 0, "Close hides the panel");

    // 3. <warning><content>: one correction round fixes it.
    await select("BRDP-RT-FIX");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    const req3 = await lastRequest();
    const nonSystem = req3.messages.filter((m) => m.role !== "system");
    assert(nonSystem.length === 3 && nonSystem[1].role === "assistant", "correction round: first answer sent back + the problems");
    const correction = nonSystem[2].content;
    assert(correction.includes('Example 2 ("Hot surface warning with em03"):') && correction.includes("- <content> is not allowed inside <warning>") && correction.includes("- <warning> is not allowed inside <para>") && correction.includes("- @emphasisType does not exist on <warning>"), `correction lists the exact problems (${correction})`);
    assert((await page.getByTestId("rule-test-correction").textContent()) === "1 example was corrected automatically.", "correction note shown");
    assert((await verdict().textContent()).startsWith("Correct"), "after the correction the verdict is correct");

    // 4. Still broken after the correction: shown with concrete messages, not run.
    await select("BRDP-RT-STUB");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    assert((await page.getByTestId("rule-test-correction").textContent()).includes("fixed 0 of 1"), "correction note: 0 of 1 fixed");
    const stubText = await example(1).textContent();
    assert(stubText.includes("Not run:") && stubText.includes("<content> is not allowed inside <warning>") && stubText.includes("@emphasisType does not exist on <warning>"), `structural problems shown on the example (${stubText})`);
    assert((await example(1).getByTestId("rule-test-result").count()) === 0, "the broken example is not run");
    assert((await example(1).locator("pre").count()) === 1, "the broken example stays visible");
    await panel().screenshot({ path: "/tmp/rule-test-structure-problems.png" });

    // 5. document(): the whole rule is not executable -> the reason at the
    // top and a "Show illustrative examples" button; no LLM call until it
    // is clicked ("ejemplos bajo demanda en reglas no ejecutables").
    await select("BRDP-RT-DOC");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).click();
    await panel().getByTestId("rule-test-analysis").waitFor({ timeout: 5000 });
    const early = await panel().getByTestId("rule-test-analysis").textContent();
    assert(early.includes("This rule can't be tested: The rule reads another file (document())") && early.includes("Examples could only illustrate it."), `document(): reason shown on top (${early})`);
    const showExamples = panel().getByTestId("rule-test-show-examples");
    assert((await showExamples.textContent()) === "Show illustrative examples", "document(): the on-demand button is shown");
    await page.waitForTimeout(1500);
    assert((await lastRequest()) === null, "document(): no LLM call before the button is clicked");
    assert((await example(0).count()) === 0 && (await panel().getByText("Writing example fragments…").count()) === 0, "document(): no examples and nothing being written");
    assert((await panel().getByRole("button", { name: "Regenerate examples" }).count()) === 0, "document(): no Regenerate before the first generation");
    await panel().screenshot({ path: "/tmp/rule-test-document-on-demand.png" });
    await fetch(`${MOCK}/slow-next`, { method: "POST" });
    await showExamples.click();
    await panel().getByText("Writing example fragments…").waitFor({ timeout: 5000 });
    assert((await showExamples.count()) === 0, "document(): the button goes away once clicked");
    await example(0).waitFor({ timeout: 15000 });
    assert((await lastRequest()).messages.some((m) => m.content === "Write the test examples for this rule."), "document(): the click made the LLM call");
    assert((await example(0).locator("pre").count()) === 1 && (await example(1).locator("pre").count()) === 1, "document(): the illustrative examples are shown");
    assert((await panel().getByTestId("rule-test-result").count()) === 0, "document(): no result lines");
    assert((await panel().getByTestId("rule-test-verdict").count()) === 0, "document(): the reason is not repeated as a verdict");
    assert((await panel().getByRole("button", { name: "Regenerate examples" }).count()) === 1, "document(): Regenerate available after the first generation");
    await panel().screenshot({ path: "/tmp/rule-test-document-reason.png" });

    // 5b. Only part of the rule is not executable: unchanged behaviour --
    // the examples are generated straight away and the rest is judged.
    await select("BRDP-RT-PART");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    assert((await panel().getByTestId("rule-test-analysis").textContent()).startsWith("Part of this rule can't be tested:"), "partial: the partial note is shown");
    assert((await panel().getByTestId("rule-test-show-examples").count()) === 0, "partial: no on-demand button");
    assert((await lastRequest())?.messages?.some((m) => m.content === "Write the test examples for this rule."), "partial: examples generated without a click");
    assert((await verdict().textContent()).startsWith("Correct"), "partial: the executable part is judged");

    // 6. A rule that does not implement the Proposal.
    await select("BRDP-RT-MISM");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    // "Revisar": the examples pass, so the mismatch turns the verdict into
    // review (amber) and the separate indicative note is not repeated.
    const mism = await verdict().textContent();
    assert((await verdict().getAttribute("data-kind")) === "review", `mismatch: verdict is review (${mism})`);
    assert(mism.startsWith("Review: the examples pass, but the rule does not seem to implement the Proposal.") && /the Proposal is about CAGE codes; the rule checks <emphasis>/i.test(mism), `mismatch verdict text (${mism})`);
    assert((await page.getByTestId("rule-test-mismatch").count()) === 0, "mismatch: note not repeated under a review verdict");
    const sys6 = (await lastRequest()).messages.find((m) => m.role === "system").content;
    assert(sys6.includes("written from the Proposal's DECISION") && sys6.includes("<dmRef>"), "prompt: examples from the decision, no text in references");

    // 7. Broken JSON: error with Regenerate, nothing run.
    await select("BRDP-RT-BROKEN");
    await page.getByRole("button", { name: "Test rule" }).click();
    await panel().getByRole("alert").waitFor({ timeout: 15000 });
    assert((await panel().getByRole("alert").textContent()).includes("The examples could not be used: The answer is not valid JSON"), "broken JSON: error visible");
    assert((await panel().getByRole("button", { name: "Regenerate examples" }).count()) === 1, "broken JSON: Regenerate offered");
    assert((await page.getByTestId("rule-test-example-0").count()) === 0, "broken JSON: nothing executed or shown");

    // 8. 3.0.1: its own skeleton.
    await openProject(p301);
    await select("BRDP-RT-301");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    const xml301 = await example(1).locator("pre").textContent();
    assert(xml301.includes("<para0>") && xml301.includes("<descript>") && !xml301.includes("levelledPara"), "3.0.1: descript/para0/para skeleton");
    assert((await verdict().textContent()).startsWith("Correct"), `3.0.1: verdict correct (${await verdict().textContent()})`);

    // 9. DITA: since T4 the engine runs Schematron too, so a DITA Draft rule
    //    has Test rule (the DITA flow itself: verify-rule-test-dita.mjs).
    await openProject(pDita);
    await select("BRDP-RT-DITA");
    await page.getByRole("button", { name: "Test rule" }).click();
    await waitVerdict();
    assert((await verdict().textContent()).startsWith("Correct"), `DITA Draft rule: Test rule runs (${await verdict().textContent()})`);

    // 10. Spanish UI.
    await openProject(p42);
    await select("BRDP-RT-STUB");
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Probar regla" }).click();
    await waitVerdict();
    const es = await example(1).textContent();
    assert(es.includes("No ejecutado:") && es.includes("<content> no está permitido dentro de <warning>"), "Spanish: structural problems translated");
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
