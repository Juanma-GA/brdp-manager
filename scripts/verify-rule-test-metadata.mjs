// Live verification for "Test rule on the DM metadata": rules about the data
// module's identification and status section (the Lufthansa S1000D 4.2
// cases S1-00052 //dmIdent/dmCode/@infoCode, S1-00070
// //responsiblePartnerCompany/@enterpriseCode (real template rule) and
// S1-00316 //dmStatus/applicRef | //pmStatus/applicRef, S1-00342
// //@disassyCodeVariant with the brexDmRef following the DM's own code, a
// //dmCode/@infoCode list without 022 (rejection attributed to the
// brexDmRef) and a rule on the brexDmRef itself), a 3.0.1 rule on
// idstatus, a content-only rule (unchanged, the minimal section dimmed as
// skeleton) and a rule that looks at nothing an example can contain ("Not
// executable", no LLM call), against the real app (Vite + FastAPI +
// Postgres). Only the Mistral TRANSPORT is mocked:
// mock-mistral-chat-server.mjs answers from the minimal section the prompt
// quotes.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the projects it creates. Screenshots go to /tmp.
//
//     node scripts/verify-rule-test-metadata.mjs
import { chromium } from "playwright-core";
import { readPublicTemplate, retiredTemplateRows } from "./lib/readXlsx.mjs";

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

const R52 = `<structureObjectRule id="BRDP-S1-00052">
  <objectPath allowedObjectFlag="2">//dmIdent/dmCode/@infoCode</objectPath>
  <objectUse>Only the information codes 055 and 930 are used.</objectUse>
  <objectValue valueForm="single" valueAllowed="055"/>
  <objectValue valueForm="single" valueAllowed="930"/>
</structureObjectRule>`;
// S1-00070 as the 4.2 template shipped it until the templates round (the row
// was replaced: Lufthansa's own CAGE code is no example for other projects);
// still a good case of a rule on the section and the content.
const R70 = `<structureObjectRule>
            <objectPath allowedObjectFlag="1">//responsiblePartnerCompany/@enterpriseCode</objectPath>
            <objectUse>BRDP-S1-00070. The responsible partner company's enterpriseCode must be C1008 (Lufthansa Technik AG's CAGE code). </objectUse>
            <objectValue valueForm="single" valueAllowed="C1008">CAGE code for LUFTHANSA TECHNIK AG is C1008</objectValue>
          </structureObjectRule>
<structureObjectRule>
            <objectPath allowedObjectFlag="1">//responsiblePartnerCompany/enterpriseName</objectPath>
            <objectUse>BRDP-S1-00070. The responsible partner company's enterpriseName must be 'LUFTHANSA TECHNIK AG'. </objectUse>
            <objectValue valueForm="single" valueAllowed="LUFTHANSA TECHNIK AG">Enterprise Name is LUFTHANSA TECHNIK AG</objectValue>
          </structureObjectRule>`;
const R316 = `<structureObjectRule id="BRDP-S1-00316">
  <objectPath allowedObjectFlag="0">//dmStatus/applicRef | //pmStatus/applicRef</objectPath>
  <objectUse>Applicability is written in the status, never referenced.</objectUse>
</structureObjectRule>`;
const R342 = `<structureObjectRule id="BRDP-S1-00342">
  <objectPath allowedObjectFlag="0">//@disassyCodeVariant[string-length(.) != 2]</objectPath>
  <objectUse>The disassembly code variant has two characters.</objectUse>
</structureObjectRule>`;
const R_INFO_ANY = `<structureObjectRule id="BRDP-MD-INFO">
  <objectPath allowedObjectFlag="2">//dmCode/@infoCode</objectPath>
  <objectUse>Only the information codes 055 and 930 are used.</objectUse>
  <objectValue valueForm="single" valueAllowed="055"/>
  <objectValue valueForm="single" valueAllowed="930"/>
</structureObjectRule>`;
const R_BREXREF = `<structureObjectRule id="BRDP-MD-BREXREF">
  <objectPath allowedObjectFlag="0">//brexDmRef//dmCode/@disassyCodeVariant[string-length(.) != 2]</objectPath>
  <objectUse>The BREX reference has a two-character disassembly code variant.</objectUse>
</structureObjectRule>`;
const R_EMPH = `<structureObjectRule id="BRDP-MD-EMPH">
  <objectPath allowedObjectFlag="0">//emphasis</objectPath>
  <objectUse>No emphasis.</objectUse>
</structureObjectRule>`;
const R_UNREACHABLE = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/descript.xsd">
  <structureObjectRuleGroup>
    <structureObjectRule id="BRDP-MD-PM">
      <objectPath allowedObjectFlag="0">//pmStatus/applicRef</objectPath>
      <objectUse>No applicability reference in the publication module status.</objectUse>
    </structureObjectRule>
  </structureObjectRuleGroup>
</contextRules>`;
const R301 = `<objrule id="BRDP-MD-301">
  <objpath>//dmaddres/issno/@type</objpath>
  <objuse>Only new and changed issues.</objuse>
  <objval valtype="single" val1="new"/>
  <objval valtype="single" val1="changed"/>
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
      body: JSON.stringify({ definition: "Decide how the data modules are identified.", validation: "Validated", ...fields }),
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
  const p42 = await makeProject("Rule test metadata 4.2", "S1000D 4.2");
  const b52 = await makeBrdp(p42, { identifier: "BRDP-S1-00052", title: "Information codes used", proposal: "Only the information codes 055 and 930 shall be used." });
  const b70 = await makeBrdp(p42, { identifier: "BRDP-S1-00070", title: "Responsible partner company", proposal: "CAGE C1008, enterprise name: 'LUFTHANSA TECHNIK AG'" });
  const b316 = await makeBrdp(p42, { identifier: "BRDP-S1-00316", title: "Applicability in the status", proposal: "The applicability of a data module shall be written in its status, never referenced with <applicRef>." });
  const bEmph = await makeBrdp(p42, { identifier: "BRDP-MD-EMPH", title: "Use of <emphasis>", proposal: "The element <emphasis> shall not be used." });
  const bPm = await makeBrdp(p42, { identifier: "BRDP-MD-PM", title: "Publication module applicability", proposal: "Publication modules shall not reference applicability in their status." });
  await putDraft(p42, b52, "BREX-4.2", R52);
  await putDraft(p42, b70, "BREX-4.2", R70);
  await putDraft(p42, b316, "BREX-4.2", R316);
  await putDraft(p42, bEmph, "BREX-4.2", R_EMPH);
  await putDraft(p42, bPm, "BREX-4.2", R_UNREACHABLE);
  const b342 = await makeBrdp(p42, { identifier: "BRDP-S1-00342", title: "Disassembly code variant", proposal: "The disassembly code variant shall always have two characters." });
  const bInfo = await makeBrdp(p42, { identifier: "BRDP-MD-INFO", title: "Information codes of any code", proposal: "Only the information codes 055 and 930 shall be used." });
  const bBrexRef = await makeBrdp(p42, { identifier: "BRDP-MD-BREXREF", title: "BREX reference", proposal: "The BREX reference shall have a two-character disassembly code variant." });
  await putDraft(p42, b342, "BREX-4.2", R342);
  await putDraft(p42, bInfo, "BREX-4.2", R_INFO_ANY);
  await putDraft(p42, bBrexRef, "BREX-4.2", R_BREXREF);
  const p301 = await makeProject("Rule test metadata 3.0.1", "S1000D 3.0.1");
  const b301 = await makeBrdp(p301, { identifier: "BRDP-MD-301", title: "Issue types", proposal: "Only new and changed issues shall be delivered." });
  await putDraft(p301, b301, "BREX-3.0.1", R301);
  // Templates round: the curated 4.1 rules that need the section -- the data
  // update file's (EXT-00019, tool CIR) and a content path whose predicate
  // reads dmStatus (EXT-00014) -- with their real template rows.
  // EXT-00019/00014 left the 4.1 template when it was rebuilt with the 10
  // project decisions: their real rules come from the retired-rows fixture.
  const t41 = [...readPublicTemplate("brdp-template-4-1.xlsx"), ...retiredTemplateRows("brdp-template-4-1.xlsx")];
  const row41 = (id) => t41.find((r) => r.ID === id);
  const p41 = await makeProject("Rule test metadata 4.1", "S1000D 4.1");
  const b19 = await makeBrdp(p41, { identifier: "BRDP-EXT-00019", title: row41("BRDP-EXT-00019").Title, proposal: row41("BRDP-EXT-00019").Proposal });
  const b14 = await makeBrdp(p41, { identifier: "BRDP-EXT-00014", title: row41("BRDP-EXT-00014").Title, proposal: row41("BRDP-EXT-00014").Proposal });
  await putDraft(p41, b19, "BREX-4.1", row41("BRDP-EXT-00019").Rule);
  await putDraft(p41, b14, "BREX-4.1", row41("BRDP-EXT-00014").Rule);
  for (const p of [p42, p301, p41]) await embed(p);

  // ---- UI ----
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
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
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;
  const colorOf = (loc) => loc.evaluate((el) => getComputedStyle(el).color);

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    await openProject(p42);

    // 1. S1-00052: the section is the insertion point.
    await select("BRDP-S1-00052");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys52 = systemOf(await lastRequest());
    assert(sys52.includes('your "metadata" is the WHOLE <identAndStatusSection>') && sys52.includes('write no "content"'), "S1-00052: the prompt asks for the whole identAndStatusSection and no content");
    assert(sys52.includes('infoCode="040"') && sys52.includes("<brexDmRef>"), "S1-00052: the prompt quotes the minimal section to start from");
    assert((await verdict().textContent()).startsWith("Correct"), `S1-00052: verdict correct, not inconclusive (${await verdict().textContent()})`);
    const x0 = await example(0).locator("pre").textContent();
    const x2 = await example(2).locator("pre").textContent();
    assert(x0.includes('infoCode="055"') && x2.includes('infoCode="040"'), "S1-00052: the examples carry their own dmCode values");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓") && (await example(1).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "S1-00052: 055 and 930 accepted");
    assert((await example(2).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "S1-00052: 040 rejected");
    const mark52 = await example(2).locator("mark").allTextContents();
    assert(JSON.stringify(mark52) === JSON.stringify(['infoCode="040"']), `S1-00052: the data module's own @infoCode highlighted (${JSON.stringify(mark52)})`);
    // The section is the LLM's content (not dimmed); the body is skeleton.
    assert((await colorOf(example(0).locator("pre span", { hasText: "<dmStatus" }).first())) !== "rgb(100, 116, 139)", "S1-00052: the written section is shown as content, not skeleton");
    assert((await colorOf(example(0).locator("pre span", { hasText: "<levelledPara" }).first())) === "rgb(100, 116, 139)", "S1-00052: the content chain is dimmed skeleton");
    await panel().screenshot({ path: "/tmp/rule-test-metadata-infocode.png" });
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Tested"), "S1-00052: recorded as passed");

    // 2. S1-00070 (the former template rule): tested for real.
    await select("BRDP-S1-00070");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys70 = systemOf(await lastRequest());
    assert(sys70.includes("The rule also looks at the data module's identification and status section:"), "S1-00070: section and content both offered");
    assert((await verdict().textContent()).startsWith("Correct"), `S1-00070: verdict correct (${await verdict().textContent()})`);
    assert((await example(1).textContent()).includes("Rule's message: BRDP-S1-00070."), "S1-00070: the other partner rejected with the rule's message");
    const mark70 = (await example(1).locator("mark").allTextContents()).join(" ");
    assert(mark70.includes('enterpriseCode="K0001"'), `S1-00070: the partner's @enterpriseCode highlighted (${mark70})`);

    // 2b. S1-00342: the brexDmRef follows the data module's own code.
    await select("BRDP-S1-00342");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    assert((await verdict().textContent()).startsWith("Correct"), `S1-00342: verdict correct (${await verdict().textContent()})`);
    const x342 = await example(0).locator("pre").textContent();
    const brex342 = x342.match(/<brexDmRef>[\s\S]*?(<dmCode [^>]*>)/)[1];
    assert(brex342.includes('disassyCodeVariant="AB"') && brex342.includes('infoCode="022"') && brex342.includes('itemLocationCode="D"'), `S1-00342: the brexDmRef's dmCode follows the own one (${brex342})`);
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "S1-00342: \"AB\" accepted");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "S1-00342: \"A\" rejected");
    assert((await example(0).getByTestId("rule-test-brex-normalized").count()) === 1, "S1-00342: the example says the app adjusted the brexDmRef");
    assert((await page.getByTestId("rule-test-brex-rejection").count()) === 0, "S1-00342: no 'rejection from the brexDmRef' note");
    await panel().screenshot({ path: "/tmp/rule-test-metadata-brex-follows.png" });

    // 2c. //dmCode/@infoCode (any dmCode) with a list without 022: the
    // brexDmRef keeps 022 and the rejection is attributed to it.
    await select("BRDP-MD-INFO");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const brexInfo = (await example(0).locator("pre").textContent()).match(/<brexDmRef>[\s\S]*?(<dmCode [^>]*>)/)[1];
    assert(brexInfo.includes('infoCode="022"'), "infoCode list without 022: the brexDmRef keeps infoCode=\"022\"");
    const noteEn = await example(0).getByTestId("rule-test-brex-rejection").textContent();
    assert(noteEn === "The rejection comes from the brexDmRef's data module code (the project's BREX): the rule would reject the real BREX too.", `infoCode list without 022: note in EN (${noteEn})`);
    assert((await example(2).getByTestId("rule-test-brex-rejection").count()) === 0, "infoCode list without 022: no note where the own code is rejected too");
    await panel().screenshot({ path: "/tmp/rule-test-metadata-brex-rejection.png" });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(400);
    const noteEs = await example(0).getByTestId("rule-test-brex-rejection").textContent();
    assert(noteEs === "El rechazo viene del dmCode del brexDmRef (el BREX del proyecto): la regla también rechazaría el BREX real.", `infoCode list without 022: note in ES (${noteEs})`);
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // 2d. A rule on the brexDmRef itself: what the LLM wrote there stays.
    await select("BRDP-MD-BREXREF");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    assert((await verdict().textContent()).startsWith("Correct"), `rule on brexDmRef: verdict correct (${await verdict().textContent()})`);
    const xRef = await example(0).locator("pre").textContent();
    assert(/<brexDmRef>[\s\S]*?<dmCode [^>]*disassyCodeVariant="AB"/.test(xRef) && /<dmIdent>\s*<dmCode [^>]*disassyCodeVariant="A"/.test(xRef), "rule on brexDmRef: the brexDmRef kept as written, the own code untouched");
    assert((await page.getByTestId("rule-test-brex-normalized").count()) === 0, "rule on brexDmRef: nothing adjusted");

    // 3. S1-00316: applicRef in dmStatus rejected, applic accepted.
    await select("BRDP-S1-00316");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    assert((await verdict().textContent()).startsWith("Correct"), `S1-00316: verdict correct (${await verdict().textContent()})`);
    assert((await example(1).locator("pre").textContent()).includes('<applicRef applicIdentValue="app-001"/>'), "S1-00316: the reject example has applicRef in dmStatus");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓") && (await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "S1-00316: applicRef rejected, applic accepted");
    await panel().screenshot({ path: "/tmp/rule-test-metadata-applicref.png" });

    // 4. A content-only rule: unchanged, the minimal section dimmed.
    await select("BRDP-MD-EMPH");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sysEmph = systemOf(await lastRequest());
    assert(!sysEmph.includes("identification and status") && sysEmph.includes("your content goes directly inside <para>"), "content-only rule: prompt as before");
    assert((await verdict().textContent()).startsWith("Correct"), `content-only rule: verdict correct (${await verdict().textContent()})`);
    assert((await example(0).locator("pre").textContent()).includes("<identAndStatusSection>"), "content-only rule: the document carries the minimal section");
    assert((await colorOf(example(0).locator("pre span", { hasText: "<dmStatus" }).first())) === "rgb(100, 116, 139)", "content-only rule: the section is dimmed skeleton");

    // 5. Nothing an example can contain: not executable, no LLM call.
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await select("BRDP-MD-PM");
    await page.getByRole("button", { name: "Test rule" }).click();
    await page.getByTestId("rule-test-analysis").waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    const analysisText = await page.getByTestId("rule-test-analysis").textContent();
    assert(analysisText === "Not executable: the rule looks at <pmStatus>, which the examples cannot contain.", `unreachable: honest reason (${analysisText})`);
    assert((await lastRequest()) === null, "unreachable: the LLM was never called");
    assert((await page.getByRole("button", { name: "Regenerate examples" }).count()) === 0 && (await page.getByTestId("rule-test-show-examples").count()) === 0, "unreachable: no regenerate, no illustrative examples");
    assert(!(await panel().textContent()).includes("Regenerate the examples"), "unreachable: never 'Regenerate the examples'");
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Not executable"), "unreachable: recorded as not executable");
    await panel().screenshot({ path: "/tmp/rule-test-metadata-unreachable.png" });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(400);
    const analysisEs = await page.getByTestId("rule-test-analysis").textContent();
    assert(analysisEs === "No ejecutable: la regla mira <pmStatus>, que los ejemplos no pueden contener.", `unreachable: Spanish (${analysisEs})`);
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // 6. 3.0.1: a rule on idstatus.
    await openProject(p301);
    await select("BRDP-MD-301");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys301 = systemOf(await lastRequest());
    assert(sys301.includes('your "metadata" is the WHOLE <idstatus>'), "3.0.1: idstatus is the insertion point");
    assert((await verdict().textContent()).startsWith("Correct"), `3.0.1: verdict correct (${await verdict().textContent()})`);
    assert((await example(1).locator("pre").textContent()).includes('type="revised"'), "3.0.1: the revised issue in idstatus");

    // 7. Templates round: 4.1 curated rules.
    await openProject(p41);
    await select("BRDP-EXT-00019");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys19 = systemOf(await lastRequest());
    assert(sys19.includes("<updateIdentAndStatusSection>") && sys19.includes('schema "update"'), "EXT-00019: the prompt offers the data update file's minimal section");
    assert((await verdict().textContent()).startsWith("Correct"), `EXT-00019: verdict correct (${await verdict().textContent()})`);
    assert((await example(1).locator("pre").textContent()).includes('infoCode="00N"') && (await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00019: a part in the tool CIR rejected");
    assert((await example(2).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "EXT-00019: a part in another CIR accepted");
    await panel().screenshot({ path: "/tmp/rule-test-template-tool-cir.png" });
    await select("BRDP-EXT-00014");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys14 = systemOf(await lastRequest());
    assert(sys14.includes("The rule also looks at the data module's identification and status section:"), "EXT-00014: section and content both offered (predicate on dmStatus)");
    assert((await verdict().textContent()).startsWith("Correct"), `EXT-00014: verdict correct (${await verdict().textContent()})`);
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00014: change mark in a new issue rejected");
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
