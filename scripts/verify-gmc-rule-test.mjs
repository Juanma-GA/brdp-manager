// Live verification for the GMC pass ("Official Default GMC ATA - 1000BR
// 4.2 - 015"): BRDP-EXT-00057 (//@pmType, pt01-pt03) -- @pmType only goes
// on the <pm> root, so the examples give it in "rootAttributes": the
// application writes it on the root, shown as the example's content (not
// dimmed skeleton) and highlighted where the rule selects it, pt02 accepted
// and pt09 rejected, verdict correct and recorded; the value can be edited
// in the root-attributes editor. BRDP-EXT-00154 (a context block pointing to
// scormContentPackage.xsd, not an S1000D 4.2 schema): "Not executable" with
// the reason, in EN and ES, and no call to the LLM. Only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to
// SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-gmc-rule-test.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const SKELETON_COLOR = "rgb(100, 116, 139)";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

// The real rules of the pass (only the id added).
const EXT57 =
  '<structureObjectRule id="BRDP-EXT-00057"><objectPath allowedObjectFlag="2">//@pmType</objectPath><objectUse>The attribute "pmType" can only have codes "pt01" thru "pt03".</objectUse><objectValue valueAllowed="pt01" valueForm="single">Component Maintenance Publication</objectValue><objectValue valueAllowed="pt02" valueForm="single">x</objectValue><objectValue valueAllowed="pt03" valueForm="single">y</objectValue></structureObjectRule>';
const EXT154 =
  '<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/scormContentPackage.xsd"><structureObjectRuleGroup><structureObjectRule id="BRDP-EXT-00154"><objectPath allowedObjectFlag="0">/dmodule</objectPath><objectUse>The scorm content package module shall not be used.</objectUse></structureObjectRule></structureObjectRuleGroup></contextRules>';
const REASON_EN =
  "Not executable: the context block points to scormContentPackage.xsd, which is not one of the S1000D 4.2 schemas (scormcontentpackage.xsd is, written in lower case). Validators compare the exact URL, so they would never apply this block.";
const REASON_ES =
  "No ejecutable: el bloque de contexto apunta a scormContentPackage.xsd, que no es un esquema de S1000D 4.2 (scormcontentpackage.xsd sí lo es, en minúsculas). Los validadores comparan la URL exacta, así que nunca aplicarían este bloque.";

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

  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `GMC rule test ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
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
  await makeBrdp({ identifier: "BRDP-EXT-00057", title: "Publication module types", definition: "Decide which publication module types are used.", proposal: "The attribute pmType can only have the codes pt01 (Component Maintenance Publication), pt02 and pt03." }, EXT57);
  await makeBrdp({ identifier: "BRDP-EXT-00154", title: "SCORM content package module", definition: "Decide whether the SCORM content package module is used.", proposal: "The SCORM content package module shall not be used." }, EXT154);
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
  const colorOf = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
  const language = (lng) => page.locator("header select, nav select").first().selectOption(lng);
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForTimeout(600); // rule approval fetch
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

    // 1. EXT-00057: rootAttributes on <pm>.
    await select("BRDP-EXT-00057");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    const req = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    const system = req.messages.find((m) => m.role === "system").content;
    assert(system.includes('@pmType goes only on <pm>, which the application writes: give its value in the example\'s "rootAttributes"'), "EXT-00057: the prompt asks for the value in rootAttributes");
    const v = await verdict().textContent();
    assert(v.startsWith("Correct"), `EXT-00057: verdict correct (${v})`);
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "EXT-00057: pt02 accepted");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00057: pt09 rejected");
    const xml0 = await example(0).locator("pre").textContent();
    assert(/<pm [^>]*pmType="pt02"/.test(xml0), "EXT-00057: pmType written on the <pm> root");
    assert(xml0.includes('xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/pm.xsd"'), "EXT-00057: the root keeps its schema location");
    const attrSpan = example(0).locator("pre span, pre mark", { hasText: 'pmType="pt02"' }).first();
    const rootSpan = example(0).locator("pre span", { hasText: "<pm" }).first();
    assert((await colorOf(attrSpan)) !== SKELETON_COLOR, "EXT-00057: the root attribute is shown as the example's content");
    assert((await colorOf(rootSpan)) === SKELETON_COLOR, "EXT-00057: the rest of the root is dimmed skeleton");
    const marks1 = (await example(1).locator("mark").allTextContents()).join(" ");
    assert(marks1.includes('pmType="pt09"'), `EXT-00057: the rejected value highlighted (${marks1})`);
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Tested"), "EXT-00057: recorded as passed");
    await panel().screenshot({ path: shot("gmc-rule-test-root-attributes.png") });

    // Edit: the root-attributes editor, run again with pt03 -> accepted.
    await example(1).getByRole("button", { name: "Edit" }).click();
    const editor = example(1).getByTestId("rule-test-root-attributes-editor");
    assert((await editor.inputValue()).includes('"pmType": "pt09"'), "EXT-00057: the editor shows the root attributes");
    await editor.fill('{ "pmType": "pt03" }');
    await example(1).getByRole("button", { name: "Run again" }).click();
    await page.waitForTimeout(400);
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("accepted"), "EXT-00057: edited to pt03 -> accepted");
    assert(/<pm [^>]*pmType="pt03"/.test(await example(1).locator("pre").textContent()), "EXT-00057: the edited value written on the root");
    await example(1).getByRole("button", { name: "Edit" }).click();
    await example(1).getByTestId("rule-test-root-attributes-editor").fill("pmType: pt03");
    await example(1).getByRole("button", { name: "Run again" }).click();
    assert(await example(1).getByTestId("rule-test-root-attributes-error").isVisible(), "EXT-00057: invalid JSON in the editor says so");
    await page.getByRole("button", { name: "Close" }).first().click().catch(() => {});

    // 2. EXT-00154: unknown context schema, EN and ES, no LLM call.
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-EXT-00154");
    await page.getByRole("button", { name: "Test rule" }).click();
    await page.getByTestId("rule-test-analysis").waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const textEn = (await page.getByTestId("rule-test-analysis").textContent()).trim();
    assert(textEn === REASON_EN, `EXT-00154: not executable with the reason in EN (${textEn})`);
    assert((await page.getByTestId("rule-test-show-examples").count()) === 0, "EXT-00154: no illustrative examples offered");
    const calls = await fetch(`${MOCK}/chat-calls`).then((r) => r.json());
    assert(calls.calls === 0, `EXT-00154: no LLM call (${calls.calls})`);
    await panel().screenshot({ path: shot("gmc-rule-test-unknown-context-en.png") });
    await language("es");
    await page.waitForTimeout(400);
    const textEs = (await page.getByTestId("rule-test-analysis").textContent()).trim();
    assert(textEs === REASON_ES, `EXT-00154: the reason in ES (${textEs})`);
    await panel().screenshot({ path: shot("gmc-rule-test-unknown-context-es.png") });
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
