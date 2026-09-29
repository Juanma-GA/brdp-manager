// Live verification for "Test rule on the DM metadata": rules about the data
// module's identification and status section (the Lufthansa S1000D 4.2
// cases S1-00052 //dmIdent/dmCode/@infoCode, S1-00070
// //responsiblePartnerCompany/@enterpriseCode (real template rule) and
// S1-00316 //dmStatus/applicRef | //pmStatus/applicRef), a 3.0.1 rule on
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
import { readPublicTemplate } from "./lib/readXlsx.mjs";

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
const R70 = readPublicTemplate("brdp-template-4-2.xlsx").find((r) => r.ID === "BRDP-S1-00070").Rule;
const R316 = `<structureObjectRule id="BRDP-S1-00316">
  <objectPath allowedObjectFlag="0">//dmStatus/applicRef | //pmStatus/applicRef</objectPath>
  <objectUse>Applicability is written in the status, never referenced.</objectUse>
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
  const p301 = await makeProject("Rule test metadata 3.0.1", "S1000D 3.0.1");
  const b301 = await makeBrdp(p301, { identifier: "BRDP-MD-301", title: "Issue types", proposal: "Only new and changed issues shall be delivered." });
  await putDraft(p301, b301, "BREX-3.0.1", R301);
  for (const p of [p42, p301]) await embed(p);

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
    assert((await colorOf(example(0).locator("pre span", { hasText: "<dmStatus" }).first())) !== "rgb(148, 163, 184)", "S1-00052: the written section is shown as content, not skeleton");
    assert((await colorOf(example(0).locator("pre span", { hasText: "<levelledPara" }).first())) === "rgb(148, 163, 184)", "S1-00052: the content chain is dimmed skeleton");
    await panel().screenshot({ path: "/tmp/rule-test-metadata-infocode.png" });
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Tested"), "S1-00052: recorded as passed");

    // 2. S1-00070 (real template rule): tested for real.
    await select("BRDP-S1-00070");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys70 = systemOf(await lastRequest());
    assert(sys70.includes("The rule also looks at the data module's identification and status section:"), "S1-00070: section and content both offered");
    assert((await verdict().textContent()).startsWith("Correct"), `S1-00070: verdict correct (${await verdict().textContent()})`);
    assert((await example(1).textContent()).includes("Rule's message: BRDP-S1-00070."), "S1-00070: the other partner rejected with the rule's message");
    const mark70 = (await example(1).locator("mark").allTextContents()).join(" ");
    assert(mark70.includes('enterpriseCode="K0001"'), `S1-00070: the partner's @enterpriseCode highlighted (${mark70})`);

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
    assert((await colorOf(example(0).locator("pre span", { hasText: "<dmStatus" }).first())) === "rgb(148, 163, 184)", "content-only rule: the section is dimmed skeleton");

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
