// Live verification for "Mejoras E" against the real app (Vite + FastAPI +
// Postgres); only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
// S1000D 3.0.1, the two real rules the schema already covers:
//   (1) BRDP-EXT-02805 //inlineapplics[not(ancestor::idstatus)]
//   (2) BRDP-EXT-02802 //avee/*[not(self::modelic or … or self::itemloc)]
// "Test rule" → "Already covered by the schema", with the accept example run
// and the reason why there is no reject example; recorded as its own result;
// Verify without a warning; and the Records header counts it apart and
// filters by it. EN and ES.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates.
//
//     node scripts/verify-mejoras-e.mjs
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

const CASE1 = '<objrule id="XML-R-2817"><objpath objappl="0">//inlineapplics[not(ancestor::idstatus)]</objpath><objuse>Prohibir inlineapplics fuera de idstatus</objuse></objrule>';
const CASE2 = '<objrule id="XML-R-2814"><objpath objappl="0">//avee/*[not(self::modelic or self::sdc or self::chapnum or self::section or self::subsect or self::subject or self::discode or self::discodev or self::incode or self::incodev or self::itemloc)]</objpath><objuse>Prohibir avee con hijos no permitidos</objuse></objrule>';

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Mejoras E ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());
  const makeBrdp = (fields) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
  async function putDraft(brdp, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`, { method: "PUT", body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }) });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const b1 = await makeBrdp({ identifier: "BRDP-EXT-02805", title: "Inline applicabilities", definition: "Decidir dónde se declaran las aplicabilidades en línea.", proposal: "Las aplicabilidades en línea solo se declaran en la sección de identificación y estado." });
  const b2 = await makeBrdp({ identifier: "BRDP-EXT-02802", title: "Hijos del código de módulo", definition: "Decidir qué hijos admite el código de módulo de datos.", proposal: "El código de módulo de datos solo contiene sus elementos de código." });
  await putDraft(b1, CASE1);
  await putDraft(b2, CASE2);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.accept();
  });
  const prompts = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") prompts.push(req.postData() || "");
  });
  const verdict = () => page.getByTestId("rule-test-verdict");
  const indicator = () => page.getByTestId("rule-test-indicator");
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
  const approvalOf = async (brdp) => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`).then((r) => r.json());

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    for (const [brdp, id, label] of [
      [b1, "BRDP-EXT-02805", "<inlineapplics> can only go inside <idstatus>"],
      [b2, "BRDP-EXT-02802", "the schema only allows the listed children in <avee>"],
    ]) {
      await select(id);
      prompts.length = 0;
      await page.getByRole("button", { name: "Test rule" }).click();
      await verdict().waitFor({ timeout: 20000 });
      await page.waitForTimeout(500);
      const v = await verdict().textContent();
      assert(v.startsWith("Already covered by the schema") && v.includes(label), `${id}: verdict "Already covered by the schema" (${v})`);
      const examplesCall = prompts.find((p) => p.includes("Write the test examples for this rule.")) || "";
      assert(examplesCall.includes("NO example meant to be rejected"), `${id}: only accept examples asked for`);
      assert(prompts.filter((p) => p.includes("Some examples are not valid.")).length === 0, `${id}: no correction round`);
      const note = await page.getByTestId("rule-test-no-reject-example").textContent();
      assert(note.startsWith("There is no example meant to be rejected"), `${id}: says why there is no reject example`);
      const results = await page.getByTestId("rule-test-result").allTextContents();
      assert(results.length >= 1 && results.every((r) => /accepted/i.test(r)), `${id}: the accept example ran and was accepted (${results.join(" | ")})`);
      await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "schema_covered", null, { timeout: 15000 });
      assert((await indicator().textContent()).includes("Already covered by the schema"), `${id}: indicator`);
      const approval = await approvalOf(brdp);
      assert(approval.last_test_result === "schema_covered" && approval.last_test_reason?.code === "test_schema_covered", `${id}: recorded as its own result (${approval.last_test_result})`);
      if (id === "BRDP-EXT-02805") await page.getByTestId("rule-test-panel").screenshot({ path: shot("mejoras-e-schema-covered-en.png") });
      // Verify: no warning dialog for a rule the schema covers.
      const before = dialogs.length;
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await page.waitForTimeout(800);
      assert((await page.getByTestId("verify-warning-dialog").count()) === 0 && dialogs.length === before, `${id}: Verify without a warning`);
      assert((await approvalOf(brdp)).status === "approved", `${id}: verified`);
    }

    // History entry, in Spanish.
    await select("BRDP-EXT-02805");
    await language("es");
    await page.getByTestId("history-toggle").click();
    await page.waitForTimeout(500);
    const history = (await page.getByTestId("history-item").allTextContents()).join(" | ");
    assert(/El esquema ya lo incluye/.test(history), "History: the test entry in Spanish");

    // Records header: own count, apart from not executable, and the filter.
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.getByTestId("verified-breakdown").waitFor({ timeout: 15000 });
    const line = await page.getByTestId("verified-breakdown").textContent();
    assert(/2 ya incluidas por el esquema/.test(line), `header: own count in Spanish (${line})`);
    assert(!/no ejecutable/i.test(line), "header: not counted as not executable");
    await page.getByTestId("verified-breakdown-schema_covered").click();
    await page.getByTestId("verified-breakdown-filter").waitFor({ timeout: 5000 });
    await page.waitForTimeout(800);
    const rows = await page.locator("tbody tr").count();
    assert(rows === 2, `filter: the two covered rules (${rows})`);
    await page.getByTestId("verified-breakdown").screenshot({ path: shot("mejoras-e-header-es.png") });
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
