// Live verification for "Mejoras F" against the real app (Vite + FastAPI +
// Postgres); only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
// S1000D 3.0.1, the real rules of the encargo:
//   (1) BRDP-EXT-02770 /*[not(self::dmodule)] -- examples built by the app
//       (no LLM call for them), "Correct", and the minimal-documents line
//   (2) BRDP-EXT-02651 the condition on proced/schedule -- the examples are
//       written in proced, "Correct"; the inverted rule fails, the assistant
//       blames the rule, and the corrected rule it offers (objappl="1" on
//       //reqconds) gets the red "newly rejects a descript document" warning
//   (4a) /*[ not(//dmaddres/issno)) ] -- "There is an extra closing parenthesis"
//   (4b) //dmaddres[not(issno)] -- "Already covered by the schema"
// EN and ES.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates.
//
//     node scripts/verify-mejoras-f.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const FORMAT = "BREX-3.0.1";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const CASE1 = '<objrule id="XML-R-2770"><objpath objappl="0">/*[not(self::dmodule)]</objpath><objuse>El elemento raíz debe ser dmodule</objuse></objrule>';
const CASE2 = '<objrule id="XML-R-2651"><objpath objappl="0">/*[ ( /dmodule/content/proced or /dmodule/content/schedule ) and not(//reqconds) ]</objpath><objuse>Los DM de procedimiento y de mantenimiento programado deben llevar reqconds</objuse></objrule>';
const CASE2_INVERTED = '<objrule id="XML-R-2651"><objpath objappl="0">/*[ ( /dmodule/content/proced or /dmodule/content/schedule ) and //reqconds ]</objpath><objuse>Los DM de procedimiento y de mantenimiento programado deben llevar reqconds</objuse></objrule>';
const CASE4A = '<objrule id="XML-R-2640"><objpath objappl="0">/*[ not(//dmaddres/issno)) ]</objpath><objuse>Todo DM lleva issno</objuse></objrule>';
const CASE4B = '<objrule id="XML-R-2640"><objpath objappl="0">//dmaddres[not(issno)]</objpath><objuse>Todo DM lleva issno</objuse></objrule>';

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Mejoras F ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());
  const makeBrdp = (fields) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
  async function putDraft(brdp, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`, { method: "PUT", body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }) });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const b1 = await makeBrdp({ identifier: "BRDP-EXT-02770", title: "Elemento raíz", definition: "Decidir qué elemento raíz llevan los módulos de datos.", proposal: "El elemento raíz debe ser <dmodule>." });
  const b2 = await makeBrdp({ identifier: "BRDP-EXT-02651", title: "Condiciones requeridas", definition: "Decidir si los procedimientos declaran sus condiciones requeridas.", proposal: "Los DM de procedimiento y de mantenimiento programado deben llevar <reqconds>." });
  const b2b = await makeBrdp({ identifier: "BRDP-EXT-02652", title: "Condiciones requeridas (al revés)", definition: "Decidir si los procedimientos declaran sus condiciones requeridas.", proposal: "Los DM de procedimiento y de mantenimiento programado deben llevar <reqconds>." });
  const b4a = await makeBrdp({ identifier: "BRDP-EXT-02640", title: "Número de edición", definition: "Decidir si todo módulo de datos lleva su número de edición.", proposal: "Todo DM lleva <issno>." });
  const b4b = await makeBrdp({ identifier: "BRDP-EXT-02641", title: "Número de edición (b)", definition: "Decidir si todo módulo de datos lleva su número de edición.", proposal: "Todo DM lleva <issno>." });
  await putDraft(b1, CASE1);
  await putDraft(b2, CASE2);
  await putDraft(b2b, CASE2_INVERTED);
  await putDraft(b4a, CASE4A);
  await putDraft(b4b, CASE4B);
  // Suggest a corrected rule needs the embeddings of the Validated BRDPs.
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 60; i += 1) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1700 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const prompts = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") prompts.push(req.postData() || "");
  });
  const language = async (lng) => {
    await page.locator("header select, nav select").first().selectOption(lng);
    await page.waitForTimeout(400);
  };
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente/i", { timeout: 5000 });
    await page.waitForTimeout(500);
  }
  const panel = () => page.getByTestId("rule-test-panel").first();
  async function testRule(name = "Test rule") {
    prompts.length = 0;
    await page.getByRole("button", { name, exact: true }).first().click();
    await panel().getByTestId("rule-test-description").waitFor({ timeout: 20000 });
  }
  const examplesCalls = () => prompts.filter((p) => p.includes("Write the test examples for this rule."));

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // (1) Root rule: minimal documents built by the app, no examples call.
    await select("BRDP-EXT-02770");
    await testRule();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    const v1 = await panel().getByTestId("rule-test-verdict").textContent();
    assert(v1.startsWith("Correct"), `case 1: verdict Correct (${v1})`);
    assert(examplesCalls().length === 0, `case 1: no examples call to the LLM (${examplesCalls().length})`);
    const built = await panel().getByTestId("rule-test-minimal-document").allTextContents();
    assert(built.length === 2 && built.some((t) => t.includes("minimal descript document")) && built.some((t) => t.includes("minimal pm document")), `case 1: two documents built by the app (${built.join(" | ")})`);
    const desc1 = await panel().getByTestId("rule-test-description").textContent();
    assert(desc1.includes("The document's root element must be <dmodule>"), `case 1: description (${desc1})`);
    const line1 = await panel().getByTestId("rule-test-minimal-documents").textContent();
    assert(line1 === "With nothing written for the test, the rule already rejects the documents of type: comment, ddn, dml, pm (4 of 19).", `case 1: minimal-documents line (${line1})`);
    await panel().screenshot({ path: shot("mejoras-f-root-rule.png") });
    await panel().getByRole("button", { name: "Close" }).click();

    // (2) Condition on proced: examples in proced, Correct.
    await select("BRDP-EXT-02651");
    await testRule();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    const v2 = await panel().getByTestId("rule-test-verdict").textContent();
    assert(v2.startsWith("Correct"), `case 2: verdict Correct (${v2})`);
    const call2 = examplesCalls()[0] || "";
    assert(/proced/.test(call2) && !/"descript"/.test(call2.split("The rule under test")[1] || ""), "case 2: examples asked for in proced");
    const line2 = await panel().getByTestId("rule-test-minimal-documents").textContent();
    assert(line2.includes("proced, schedul"), `case 2: minimal proced and schedul rejected (${line2})`);
    await panel().getByRole("button", { name: "Close" }).click();

    // (2, inverted) Incorrect → review: the rule → corrected rule with the red warning.
    await select("BRDP-EXT-02652");
    await testRule();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    const v2b = await panel().getByTestId("rule-test-verdict").textContent();
    assert(/rejected an example meant to comply with it/.test(v2b), `inverted: verdict incorrect (${v2b})`);
    await panel().getByTestId("rule-test-review").click();
    await panel().getByTestId("rule-test-review-result").waitFor({ timeout: 15000 });
    assert((await panel().getByTestId("rule-test-review-result").getAttribute("data-cause")) === "rule", "inverted: the review blames the rule");
    await panel().getByTestId("rule-test-suggest-corrected").click();
    await page.getByTestId("rule-corrected-note").waitFor({ timeout: 20000 });
    const red = page.getByTestId("suggested-rule-minimal-documents-newly-rejected");
    await red.waitFor({ timeout: 15000 });
    const redText = await red.textContent();
    // Mejoras G, Part 2.4 b: up to 5 names, then "and N more" (descript is among them).
    assert(/rejects documents of type (\w+, ){4}\w+ and \d+ more with nothing written for the test; the previous rule accepted them/.test(redText), `corrected rule: red warning (${redText})`);
    const color = await red.evaluate((el) => getComputedStyle(el).color);
    assert(color === "rgb(185, 28, 28)", `corrected rule: warning in red (${color})`);
    assert(await page.getByRole("button", { name: "Accept", exact: true }).isEnabled(), "corrected rule: Accept not blocked");
    await page.getByTestId("rule-corrected-note").locator("..").screenshot({ path: shot("mejoras-f-corrected-rule-warning.png") });
    await language("es");
    const redEs = await red.textContent();
    assert(/Esta regla rechaza documentos de tipo (\w+, ){4}\w+ y \d+ más sin nada escrito para la prueba; la regla anterior los aceptaba/.test(redEs), `corrected rule: red warning in Spanish (${redEs})`);
    await language("en");
    await page.getByRole("button", { name: "Discard", exact: true }).first().click();

    // (4a) Extra closing parenthesis.
    await select("BRDP-EXT-02640");
    await testRule();
    const a4 = page.getByTestId("rule-test-analysis").first();
    await a4.waitFor({ timeout: 15000 });
    const a4Text = await a4.textContent();
    assert(a4Text.includes("There is an extra closing parenthesis.") && a4Text.includes("XPST0003"), `case 4a: reason (${a4Text})`);
    assert(examplesCalls().length === 0, "case 4a: no examples call");
    await language("es");
    const a4Es = await page.getByTestId("rule-test-analysis").first().textContent();
    assert(a4Es.includes("Sobra un paréntesis de cierre."), `case 4a: reason in Spanish (${a4Es})`);
    await language("en");
    await panel().getByRole("button", { name: "Close" }).click();

    // (4b) <issno> is required: already covered by the schema.
    await select("BRDP-EXT-02641");
    await testRule();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    const v4b = await panel().getByTestId("rule-test-verdict").textContent();
    assert(v4b.startsWith("Already covered by the schema") && v4b.includes("<issno>"), `case 4b: verdict (${v4b})`);
    await panel().screenshot({ path: shot("mejoras-f-required-issno.png") });
    await language("es");
    const v4bEs = await panel().getByTestId("rule-test-verdict").textContent();
    assert(v4bEs.startsWith("El esquema ya lo incluye"), `case 4b: verdict in Spanish (${v4bEs})`);
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
