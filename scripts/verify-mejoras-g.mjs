// Live verification for "Mejoras G" against the real app (Vite + FastAPI +
// Postgres); only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
// S1000D 3.0.1, the real rules of the encargo:
//   (1) BRDP-EXT-02786 -- the prompt says "at most one <evaluate> inside
//       <applic>"; the LLM's two loose <evaluate> go to the correction round
//       with "<applic> allows at most 1 <evaluate>; the example has 2"; the
//       corrected example runs and the verdict is Correct
//   (1.5) BRDP-EXT-02792 corrected -- amber text-function warning in the
//       test panel and in the rule editor (EN/ES)
//   (2.1) BRDP-EXT-02656 -- what //reqconds/reqcblst//*[@checksum] reaches,
//       and "also reaches <cblst>, which the Proposal does not mention"
//   (2.2) BRDP-EXT-02651 -- the corrected rule keeps id XML-R-2655 (the
//       simulator answers XML-R-2652, BRDP-S1-00024's id); a pasted rule
//       with XML-R-2652 gets the red id-clash warning
//   (2.3) BRDP-EXT-02715 /*[not(//dmaddres)] -- app-built examples, no LLM
//       examples call, Correct, and "In comment, ddn, dml and pm …"
//   (2.4a) the rule editor flags an extra closing parenthesis while typing
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates.
//
//     node scripts/verify-mejoras-g.mjs
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

const objrule = (id, path, flag = "0", use = "x") => `<objrule id="${id}"><objpath objappl="${flag}">${path}</objpath><objuse>${use}</objuse></objrule>`;
const CASE1 = objrule("XML-R-2786", "//idstatus//applic[not(DRAGON) and count(displaytext/p) &gt; 1][count(evaluate/evaluate[@operator='and']) != count(displaytext/p)]", "0", "Cada párrafo del texto de aplicabilidad debe tener su propia evaluación");
const CASE2 = objrule("XML-R-2792", "//evaluate[normalize-space(concat(@actidref, ' ', @actreftype)) = normalize-space(ancestor::applic/displaytext/p)]", "0", "Una evaluación no repite su texto");
const CASE3 = objrule("XML-R-2656", "//reqconds/reqcblst//*[@checksum]", "0", "Sin checksum en reqcblst");
const CASE4_STORED = objrule("XML-R-2655", "/*[ ( /dmodule/content/proced or /dmodule/content/schedule ) and //reqconds ]", "0", "Los DM de procedimiento y de mantenimiento programado deben llevar reqconds");
const S1_00024 = objrule("XML-R-2652", "//status/qa/firstver[not(@type='tabtop')]", "0", "First verification is table-top");
const CASE5 = objrule("XML-R-2715", "/*[not(//dmaddres)]", "0", "Todo documento debe llevar dmaddres");
const TEXT_FN_EN = "normalize-space() receives ancestor::applic/displaytext/p, which can give several <p>.";
const TEXT_FN_ES =
  "normalize-space() recibe ancestor::applic/displaytext/p, que puede dar varios <p>. Con más de uno, la regla da error o mira solo el primero. Para «algún <p>» usa some $p in … satisfies …; para el primero, añade [1].";

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Mejoras G ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());
  const makeBrdp = (fields) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
  async function putDraft(brdp, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`, { method: "PUT", body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }) });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const getRule = (brdp) => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`).then((r) => r.json());
  const b1 = await makeBrdp({ identifier: "BRDP-EXT-02786", title: "Aplicabilidad con varios párrafos", definition: "Decidir cómo se evalúa una aplicabilidad con varios párrafos de texto.", proposal: "Cada párrafo del texto de aplicabilidad debe tener su propia evaluación." });
  const b2 = await makeBrdp({ identifier: "BRDP-EXT-02792", title: "Texto de una evaluación", definition: "Decidir si una evaluación puede repetir su texto.", proposal: "Una evaluación no repite el texto de su aplicabilidad." });
  const b3 = await makeBrdp({ identifier: "BRDP-EXT-02656", title: "Checksum de las listas de circuit breakers", definition: "Decidir si las listas de circuit breakers llevan checksum.", proposal: "Ningún <cbsublst> ni <cb> dentro de <reqcblst> puede llevar @checksum" });
  const b4 = await makeBrdp({ identifier: "BRDP-EXT-02651", title: "Condiciones requeridas", definition: "Decidir si los procedimientos declaran sus condiciones requeridas.", proposal: "Los DM de procedimiento y de mantenimiento programado deben llevar <reqconds>. CLASH2652" });
  const b4other = await makeBrdp({ identifier: "BRDP-S1-00024", title: "First verification", definition: "Decide how the first verification is done.", proposal: "First verification is table-top." });
  const b5 = await makeBrdp({ identifier: "BRDP-EXT-02715", title: "Dirección del módulo de datos", definition: "Decidir si todo documento lleva la dirección del módulo de datos.", proposal: "Todo documento debe llevar <dmaddres>." });
  await putDraft(b1, CASE1);
  await putDraft(b2, CASE2);
  await putDraft(b3, CASE3);
  await putDraft(b4, CASE4_STORED);
  await putDraft(b4other, S1_00024);
  await putDraft(b5, CASE5);
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
  async function testRule() {
    prompts.length = 0;
    await page.getByRole("button", { name: "Test rule", exact: true }).first().click();
    await panel().getByTestId("rule-test-description").waitFor({ timeout: 20000 });
  }
  const examplesCalls = () => prompts.filter((p) => p.includes("Write the test examples for this rule."));
  const correctionCalls = () => prompts.filter((p) => p.includes("Some examples are not valid."));

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // (1) BRDP-EXT-02786: at most one <evaluate> in <applic>.
    await select("BRDP-EXT-02786");
    await testRule();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    const call1 = examplesCalls()[0] || "";
    assert(call1.includes("at most one <evaluate> inside <applic>") && call1.includes("at most one <displaytext> inside <applic>"), "case 1: the examples prompt says at most one <evaluate>/<displaytext> inside <applic>");
    const corr1 = correctionCalls()[0] || "";
    assert(corr1.includes("<applic> allows at most 1 <evaluate>; the example has 2"), "case 1: the correction round says the maximum");
    assert(/at most 1 of each: <assert>, <displaytext>, <evaluate>/.test(corr1), "case 1: the correction round brings the card of <applic> with its maxima");
    const v1 = await panel().getByTestId("rule-test-verdict").textContent();
    assert(v1.startsWith("Correct"), `case 1: verdict Correct (${v1})`);
    await panel().screenshot({ path: shot("mejoras-g-applic-evaluate.png") });
    await panel().getByRole("button", { name: "Close" }).click();

    // (1.5) BRDP-EXT-02792: text function over several <p>.
    await select("BRDP-EXT-02792");
    await testRule();
    const tf = panel().locator('[data-testid="rule-test-path-warning"][data-kind="textFunction"]');
    await tf.first().waitFor({ timeout: 15000 });
    const tfText = await tf.first().textContent();
    assert(tfText.replace(/^⚠\s*/, '').startsWith(TEXT_FN_EN), `case 2: text-function warning in the test panel (${tfText})`);
    await language("es");
    const tfEs = await tf.first().textContent();
    assert(tfEs.replace(/^⚠\s*/, '') === TEXT_FN_ES, `case 2: warning in Spanish (${tfEs})`);
    await language("en");
    const call2 = examplesCalls()[0] || "";
    assert(call2.includes("SEVERAL NODES") && call2.includes("can give several <p>"), "case 2 (1.6): the prompt asks for examples with two or more <p>");
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 30000 });
    await panel().screenshot({ path: shot("mejoras-g-text-function.png") });
    await panel().getByRole("button", { name: "Close" }).click();
    // in the rule editor
    await page.getByRole("button", { name: "Edit", exact: true }).last().click();
    const editor = page.getByPlaceholder("Paste or write the rule text (raw XML/Schematron)…");
    await editor.waitFor({ timeout: 5000 });
    await editor.fill(CASE2);
    await page.waitForTimeout(800);
    const eTf = page.locator('[data-testid="rule-editor-path-warning"][data-kind="textFunction"]');
    assert((await eTf.count()) === 1 && (await eTf.textContent()).replace(/^⚠\s*/, '').startsWith(TEXT_FN_EN), "case 2: the same warning in the rule editor");
    // (2.4a) unbalanced parenthesis while typing
    await editor.fill(objrule("XML-R-2640", "/*[ not(//dmaddres/issno)) ]"));
    await page.waitForTimeout(800);
    const xErr = page.getByTestId("rule-editor-xpath-error");
    assert((await xErr.count()) >= 1 && (await xErr.first().textContent()).includes("There is an extra closing parenthesis."), `2.4a: the editor says the extra parenthesis (${(await xErr.count()) ? await xErr.first().textContent() : "none"})`);
    await page.screenshot({ path: shot("mejoras-g-editor-paren.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).last().click();

    // (2.1) BRDP-EXT-02656: what the rule reaches.
    await select("BRDP-EXT-02656");
    await testRule();
    const reach = panel().getByTestId("rule-test-reach");
    await reach.first().waitFor({ timeout: 15000 });
    const reachText = await reach.first().textContent();
    assert(reachText.includes("reaches <cb>, <cblst>, and <cbsublst>"), `2.1: the description lists what it reaches (${reachText})`);
    const beyond = panel().getByTestId("rule-test-reach-warning");
    assert((await beyond.count()) === 1 && (await beyond.textContent()).replace(/^⚠\s*/, "") === "The rule also reaches <cblst>, which the Proposal does not mention.", `2.1: warning (${(await beyond.count()) ? await beyond.textContent() : "none"})`);
    await language("es");
    assert((await beyond.textContent()).replace(/^⚠\s*/, "") === "La regla alcanza también a <cblst>, que la Propuesta no menciona.", "2.1: warning in Spanish");
    await language("en");
    await panel().screenshot({ path: shot("mejoras-g-reach.png") });
    await panel().getByRole("button", { name: "Close" }).click();

    // (2.2) BRDP-EXT-02651: the corrected rule keeps its id; a pasted clash.
    await select("BRDP-EXT-02651");
    await testRule();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 30000 });
    await panel().getByTestId("rule-test-review").click();
    await panel().getByTestId("rule-test-review-result").waitFor({ timeout: 15000 });
    await panel().getByTestId("rule-test-suggest-corrected").click();
    await page.getByTestId("rule-corrected-note").waitFor({ timeout: 20000 });
    const suggested = await page.getByTestId("rule-corrected-note").locator("..").textContent();
    assert(suggested.includes('id="XML-R-2655"') && !suggested.includes('id="XML-R-2652"'), "2.2a: the corrected rule keeps id XML-R-2655 (the simulator answered XML-R-2652)");
    assert((await page.getByTestId("suggested-rule-id-clash").count()) === 0, "2.2a: no id clash for the aligned suggestion");
    const pasteBox = page.getByPlaceholder(/Paste/);
    await pasteBox.fill(objrule("XML-R-2652", "//reqconds[ /dmodule/content/proced ]", "1", "x"));
    await page.waitForTimeout(800);
    const clash = page.getByTestId("pasted-rule-id-clash");
    assert((await clash.count()) === 1 && (await clash.textContent()).replace(/^⚠\s*/, "") === "The id XML-R-2652 is already used by the rule of BRDP-S1-00024. Two rules with the same id make an invalid BREX.", `2.2b: pasted clash (${(await clash.count()) ? await clash.textContent() : "none"})`);
    const clashColor = await clash.evaluate((el) => getComputedStyle(el).color);
    assert(clashColor === "rgb(185, 28, 28)", `2.2b: red (${clashColor})`);
    assert(await page.getByRole("button", { name: "Accept pasted rule" }).isEnabled(), "2.2b: not blocking");
    await language("es");
    assert((await clash.textContent()).replace(/^⚠\s*/, "") === "El id XML-R-2652 ya lo usa la regla de BRDP-S1-00024. Dos reglas con el mismo id dan un BREX no válido.", "2.2b: Spanish");
    await language("en");
    await page.screenshot({ path: shot("mejoras-g-id-clash.png"), fullPage: true });
    await page.getByRole("button", { name: "Discard", exact: true }).first().click();
    assert((await getRule(b4)).rule_xml === CASE4_STORED, "2.2: nothing saved");

    // (2.3) BRDP-EXT-02715: app-built examples.
    await select("BRDP-EXT-02715");
    await testRule();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    const v5 = await panel().getByTestId("rule-test-verdict").textContent();
    assert(v5.startsWith("Correct"), `case 5: verdict Correct (${v5})`);
    assert(examplesCalls().length === 0, `case 5: no examples call to the LLM (${examplesCalls().length})`);
    const built = await panel().getByTestId("rule-test-minimal-document").allTextContents();
    assert(built.length === 2 && built.every((b) => b.includes("the schema decides whether <dmaddres> is there") && !b.includes("only looks at the root")), `case 5: two documents built by the app (${built.join(" | ")})`);
    const never = await panel().getByTestId("rule-test-presence-never").textContent();
    assert(never === "In comment, ddn, dml, and pm, <dmaddres> cannot exist: the rule always rejects those documents.", `case 5: description line (${never})`);
    await language("es");
    const neverEs = await panel().getByTestId("rule-test-presence-never").textContent();
    assert(neverEs === "En comment, ddn, dml y pm, <dmaddres> no puede existir: la regla rechaza siempre esos documentos.", `case 5: Spanish (${neverEs})`);
    await language("en");
    await panel().screenshot({ path: shot("mejoras-g-document-presence.png") });
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
