// Live verification for "Test de reglas: referencias, antepasados y reglas
// de esquema prohibido" (pasada «Official Default CMP ATA - 1000BR 4.2 -
// 009»), with the real rules:
//   - BRDP-EXT-00039 (//internalRef[not(@internalRefId = //figure/@id or …)]):
//     the prompt names the destinations and the way to the first ones, the
//     examples go inside <levelledPara>, verdict correct, the rejected
//     <internalRef> highlighted, recorded as passed.
//   - BRDP-EXT-00088 (//dmodule flag 0 in an sb context block): no call to
//     the LLM; a minimal sb document rejected and one of another schema
//     accepted, both built by the application, no Edit; verdict correct.
//   - BRDP-EXT-00272 (//footnote | //footnoteRef in an ipd context block):
//     "Already covered by the schema" with the reason, in EN and ES, no LLM
//     call.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to
// SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-rule-test-cmp.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { ruleCmp39 } from "./prompt-snapshot/cases.mjs";
import { keepAccountLanguage } from "./lib/seeds.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
// Gives the account back its language when the process exits (see lib/seeds.mjs).
keepAccountLanguage(ADMIN_EMAIL);
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

const inContext = (schema, body) => `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${schema}.xsd"><structureObjectRuleGroup>${body}</structureObjectRuleGroup></contextRules>`;
const EXT39 = ruleCmp39.replace("<structureObjectRule>", '<structureObjectRule id="BRDP-EXT-00039">');
const EXT88 = inContext("sb", '<structureObjectRule id="BRDP-EXT-00088"><objectPath allowedObjectFlag="0">//dmodule</objectPath><objectUse>BREX-CMMST-00006: The sb schema is not allowed.</objectUse></structureObjectRule>');
const EXT272 = inContext("ipd", '<structureObjectRule id="BRDP-EXT-00272"><objectPath allowedObjectFlag="0">//footnote | //footnoteRef</objectPath><objectUse>BREX-CMMST-00272: Footnotes are not allowed in IPD.</objectUse></structureObjectRule>');
// «Reglas que prohíben un tipo de documento por su raíz»: EXT-00154
// corrected to a general rule, no context block.
const EXT154 = '<structureObjectRule id="BRDP-EXT-00154"><objectPath allowedObjectFlag="0">/scormContentPackage</objectPath><objectUse>BREX-CMMST-00006: The scorm content package schema is not allowed.</objectUse></structureObjectRule>';
const COVERED_EN = "Already covered by the schema: the ipd schema has no <footnote> or <footnoteRef>.";
const COVERED_ES = "El esquema ya lo incluye: en el esquema ipd no existen <footnote> ni <footnoteRef>.";

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

  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `CMP rule test ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  async function makeBrdp(fields, rule) {
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ validation: "Validated", ...fields }),
    }).then((r) => r.json());
    const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: rule, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
    return b;
  }
  await makeBrdp({ identifier: "BRDP-EXT-00039", title: "Targets of internal references", definition: "Decide which elements an internal reference can target.", proposal: "An internal reference can only target a figure, a table, a multimedia object, a support equipment, supply or spare description, a levelled paragraph, a procedural step, a graphic or a hotspot." }, EXT39);
  await makeBrdp({ identifier: "BRDP-EXT-00088", title: "Use of the service bulletin schema", definition: "Decide whether the service bulletin schema is used.", proposal: "The sb schema shall not be used." }, EXT88);
  await makeBrdp({ identifier: "BRDP-EXT-00154", title: "Use of the scorm content package schema", definition: "Decide whether the scorm content package schema is used.", proposal: "The scorm content package schema shall not be used." }, EXT154);
  await makeBrdp({ identifier: "BRDP-EXT-00272", title: "Footnotes in the parts catalog", definition: "Decide whether footnotes are used in the illustrated parts data.", proposal: "Footnotes shall not be used in the illustrated parts data." }, EXT272);
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 80; i++) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  const language = (lng) => page.locator("header select, nav select").first().selectOption(lng);
  const chatCalls = async () => (await fetch(`${MOCK}/chat-calls`).then((r) => r.json())).calls;
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForTimeout(600); // rule approval fetch
  }
  async function openTest(identifier) {
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select(identifier);
    await page.getByRole("button", { name: /^(Test rule|Probar regla)$/ }).click();
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 1. EXT-00039: the destinations of the reference.
    await openTest("BRDP-EXT-00039");
    await verdict().waitFor({ timeout: 20000 });
    const req = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    const system = req.messages.find((m) => m.role === "system").content;
    assert(system.includes("The rule compares @internalRefId of <internalRef> with the @id of <figure>, <figureAlts>, <table>"), "EXT-00039: the prompt names the destinations");
    assert(system.includes("The valid way to the first of them from <levelledPara>: levelledPara/figure"), "EXT-00039: the prompt gives the way to the first ones");
    assert(!system.includes("SEVERAL NODES"), "EXT-00039: no request for several <figure>");
    const v = await verdict().textContent();
    assert(v.startsWith("Correct"), `EXT-00039: verdict correct (${v})`);
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "EXT-00039: the reference to a figure accepted");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00039: the reference to a paragraph rejected");
    const marks = (await example(1).locator("mark").allTextContents()).join(" ");
    assert(marks.includes("internalRef"), `EXT-00039: the rejected <internalRef> highlighted (${marks})`);
    assert(/<levelledPara>[\s\S]*<figure id="fig-0001">/.test(await example(0).locator("pre").textContent()), "EXT-00039: the figure written inside <levelledPara>");
    let indicator = "";
    for (let i = 0; i < 40 && !indicator.includes("Tested"); i++) {
      indicator = (await page.getByTestId("rule-test-indicator").textContent()) || "";
      if (!indicator.includes("Tested")) await page.waitForTimeout(250);
    }
    assert(indicator.includes("Tested"), `EXT-00039: recorded as passed (${indicator})`);
    await panel().screenshot({ path: shot("rule-test-cmp-reference-destinations.png") });

    // 2. EXT-00088: a schema forbidden by a context block, no LLM call.
    await openTest("BRDP-EXT-00088");
    await verdict().waitFor({ timeout: 20000 });
    assert((await chatCalls()) === 0, "EXT-00088: no LLM call");
    assert((await verdict().textContent()).startsWith("Correct"), "EXT-00088: verdict correct");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00088: the minimal sb document rejected");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "EXT-00088: the document of another schema accepted");
    assert((await example(0).getByTestId("rule-test-minimal-document").textContent()).startsWith("Built by the application: the minimal sb document"), "EXT-00088: built by the application");
    assert((await example(0).getByRole("button", { name: "Edit" }).count()) === 0, "EXT-00088: no Edit");
    await panel().screenshot({ path: shot("rule-test-cmp-forbidden-schema-en.png") });
    await language("es");
    await page.waitForTimeout(400);
    assert((await example(0).getByTestId("rule-test-minimal-document").textContent()).startsWith("Montado por la aplicación: el documento mínimo de tipo sb"), "EXT-00088: built by the application (ES)");
    await language("en");
    await page.waitForTimeout(300);

    // 3. EXT-00272: none of its elements exists in ipd.
    await openTest("BRDP-EXT-00272");
    await verdict().waitFor({ timeout: 20000 });
    assert((await chatCalls()) === 0, "EXT-00272: no LLM call");
    const covered = (await verdict().textContent()).trim();
    assert(covered.startsWith(COVERED_EN), `EXT-00272: covered by the schema, with the reason (${covered})`);
    assert((await example(0).getByTestId("rule-test-minimal-document").textContent()).includes("the rule looks for <footnote>, <footnoteRef>, which no ipd document can contain."), "EXT-00272: the note says what the rule looks for");
    await panel().screenshot({ path: shot("rule-test-cmp-absent-in-ipd-en.png") });
    await language("es");
    await page.waitForTimeout(400);
    const coveredEs = (await verdict().textContent()).trim();
    assert(coveredEs.startsWith(COVERED_ES), `EXT-00272: the reason in ES (${coveredEs})`);
    await panel().screenshot({ path: shot("rule-test-cmp-absent-in-ipd-es.png") });
    await language("en");
    await page.waitForTimeout(300);

    // 4. EXT-00154 corrected: /scormContentPackage flag 0, no context
    // block -- like a forbidden schema, no LLM call (not even the Proposal check).
    await openTest("BRDP-EXT-00154");
    await verdict().waitFor({ timeout: 20000 });
    assert((await chatCalls()) === 0, "EXT-00154: no LLM call, not even the Proposal check");
    assert((await verdict().textContent()).startsWith("Correct"), `EXT-00154: verdict correct (${await verdict().textContent()})`);
    assert((await page.getByTestId("rule-test-description").textContent()).includes("No document may be a <scormContentPackage> (scormcontentpackage schema)."), "EXT-00154: what the rule checks (EN)");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00154: the minimal scormcontentpackage document rejected");
    assert((await example(0).getByTestId("rule-test-minimal-document").textContent()).startsWith("Built by the application: the minimal scormcontentpackage document"), "EXT-00154: built by the application");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "EXT-00154: the document of another schema accepted");
    assert((await example(1).getByTestId("rule-test-minimal-document").textContent()).startsWith("Built by the application: the minimal descript document"), "EXT-00154: the accepted one is a descript document");
    assert((await panel().getByRole("button", { name: "Edit" }).count()) === 0, "EXT-00154: no Edit");
    let indicator154 = "";
    for (let i = 0; i < 40 && !indicator154.includes("Tested"); i++) {
      indicator154 = (await page.getByTestId("rule-test-indicator").textContent()) || "";
      if (!indicator154.includes("Tested")) await page.waitForTimeout(250);
    }
    assert(indicator154.includes("Tested"), `EXT-00154: recorded as passed (${indicator154})`);
    await panel().screenshot({ path: shot("rule-test-cmp-root-document-en.png") });
    await language("es");
    await page.waitForTimeout(400);
    assert((await page.getByTestId("rule-test-description").textContent()).includes("Ningún documento puede ser un <scormContentPackage> (esquema scormcontentpackage)."), "EXT-00154: what the rule checks (ES)");
    assert((await verdict().textContent()).startsWith("Correcto"), "EXT-00154: verdict correct (ES)");
    assert((await example(0).getByTestId("rule-test-minimal-document").textContent()).startsWith("Montado por la aplicación: el documento mínimo de tipo scormcontentpackage"), "EXT-00154: built by the application (ES)");
    await panel().screenshot({ path: shot("rule-test-cmp-root-document-es.png") });
    await language("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
