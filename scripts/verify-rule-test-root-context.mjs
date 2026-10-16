// Live verification for "Test de reglas DITA: el contexto en la raíz decide
// a qué documentos se aplica": Navantia BRDP-EXT-00034 of a "DITA 1.3
// Xpath3.0" project (real contexts, /*[matches(… concat(@base, ' ', title)
// …)]), read from scripts/rule-test-fixtures/navantia-dita3-reconstructed.sch.
//   1. Test rule: the examples prompt says the rule applies only to
//      documents whose own <title> (or @base) meets the context, and never
//      in a <section>; the simulator writes the title in the root, so the
//      rejected examples are rejected, verdict Correct, recorded as passed;
//      no "several <title>" warning.
//   2. ROOTSTUBBORN in the Proposal: the simulator keeps the title in a
//      <section> (the real run), also after the correction round. One
//      correction round that says "must be a document the rule applies to";
//      verdict "Inconclusive: the rule applies to none of the examples …",
//      never "does not cover the decision"; the cause under each example
//      meant to be rejected; recorded as inconclusive.
//   3. Spanish texts.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR
// (default: the system's temp directory).
//
//     node scripts/verify-rule-test-root-context.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { readTextFile } from "./lib/textFile.mjs";
import { keepAccountLanguage } from "./lib/seeds.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
// Gives the account back its language when the process exits (the
// language selector saves it on the account; see lib/seeds.mjs).
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

const SCH = readTextFile(new URL("./rule-test-fixtures/navantia-dita3-reconstructed.sch", import.meta.url));
const RULE = SCH.match(/<sch:pattern id="p-BRDP-EXT-00034"[\s\S]*?<\/sch:pattern>/)[0].replace("<sch:pattern", '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const PROPOSAL = "Las tablas de los registros de inspecciones, pruebas y acciones llevan las columnas Fecha y Firma.";
const CASES = [
  { id: "BRDP-EXT-00034", proposal: PROPOSAL },
  { id: "BRDP-EXT-90034", proposal: `${PROPOSAL} ROOTSTUBBORN` },
];

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Root context rule test ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const brdps = {};
  for (const c of CASES) {
    const brdp = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({
        identifier: c.id,
        title: "Campos de los registros de inspecciones",
        definition: "Decidir qué campos llevan las tablas de los registros de inspecciones, pruebas y acciones.",
        proposal: c.proposal,
        validation: "Validated",
      }),
    }).then((x) => x.json());
    const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: RULE, source: "manual", status: "pending_review" }),
    });
    if (!put.ok) throw new Error(`seeding failed: ${put.status} ${await put.text()}`);
    brdps[c.id] = brdp;
  }
  const approval = (id) => api(`/api/projects/${project.id}/brdps/${brdps[id].id}/approvals/SCH-DITA`).then((r) => r.json());
  {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const panel = () => page.getByTestId("rule-test-panel").first();
  const resultsOf = () =>
    panel()
      .locator('[data-testid^="rule-test-example-"]')
      .evaluateAll((els) => els.filter((e) => /^rule-test-example-\d+$/.test(e.dataset.testid)).map((e) => e.querySelector('[data-testid="rule-test-result"]')?.textContent || ""));
  const language = () => page.locator("header select, nav select").first();
  const proxyBodies = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") proxyBodies.push(req.postData() || "");
  });
  const messagesOf = (body) => JSON.parse(body).payload.messages;
  const examplesRequests = () => proxyBodies.map(messagesOf).filter((m) => m[0]?.content?.includes("EACH EXAMPLE"));
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await page.getByTestId("rule-test-indicator").waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  async function runTest(label) {
    proxyBodies.length = 0;
    await page.getByRole("button", { name: label }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 40000 });
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 1. The title goes in the root: Correct.
    await select("BRDP-EXT-00034");
    await runTest("Test rule");
    {
      const reqs = examplesRequests();
      assert(reqs.length === 1, `EXT-00034: one examples call, no correction round (${reqs.length})`);
      const sys = reqs[0] ? reqs[0][0].content : "";
      assert(sys.includes("the rule applies only to documents whose own <title> (or @base)\nmeets one of:"), "EXT-00034: the prompt says the rule applies only to documents whose own <title> (or @base) meets …");
      assert(sys.includes("write\nthat text in the topic's own <title> (or @base). Never put it in a <section>."), "EXT-00034: the prompt says to write it in the topic's own <title>, never in a <section>");
      const results = await resultsOf();
      assert(results.length === 3 && results[0].startsWith("Result: accepted") && results.slice(1).every((r) => r.startsWith("Result: rejected")), `EXT-00034: accepted, rejected, rejected (${results.join(" | ")})`);
      const verdict = await panel().getByTestId("rule-test-verdict").textContent();
      assert(verdict.startsWith("Correct"), `EXT-00034: verdict Correct (${verdict})`);
      const text = await page.locator("body").textContent();
      assert(!text.includes("which can give several <title>"), "EXT-00034: no \"several <title>\" warning");
      await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 15000 });
      assert((await approval("BRDP-EXT-00034")).last_test_result === "passed", "EXT-00034: recorded as passed");
      await panel().screenshot({ path: shot("rule-test-root-context-correct-en.png") });
      await panel().getByRole("button", { name: "Close" }).click();
    }

    // 2. The title stays in a <section>: Inconclusive, not "does not cover".
    await select("BRDP-EXT-90034");
    await runTest("Test rule");
    {
      const reqs = examplesRequests();
      assert(reqs.length === 2, `stubborn: one correction round (${reqs.length} examples calls)`);
      const correction = reqs[1] ? reqs[1][reqs[1].length - 1].content : "";
      assert(correction.includes("This example must be a document the rule applies to: its root <topic> must meet one of"), "stubborn: the correction says the example must be a document the rule applies to");
      assert(!/sch:assert|\$campos/.test(correction), "stubborn: the correction never names the assert's test");
      const verdict = await panel().getByTestId("rule-test-verdict").textContent();
      assert(verdict.startsWith("Inconclusive: the rule applies to none of the examples (its context asks the root for"), `stubborn: verdict inconclusive, not applicable (${verdict.slice(0, 140)})`);
      assert(!(await panel().textContent()).includes("does not cover the decision"), "stubborn: never \"does not cover the decision\"");
      const causes = await panel().getByTestId("rule-test-accept-cause").allTextContents();
      assert(causes.length === 2 && causes.every((c) => c.includes("the root <topic> does not meet the rule's context (it is not a document the rule applies to)")), `stubborn: the cause under each example meant to be rejected (${causes.join(" | ")})`);
      await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "inconclusive", null, { timeout: 15000 });
      const saved = await approval("BRDP-EXT-90034");
      assert(saved.last_test_result === "inconclusive" && saved.last_test_reason?.code === "test_not_applicable", `stubborn: recorded as inconclusive, test_not_applicable (${saved.last_test_result} ${saved.last_test_reason?.code})`);
      await panel().screenshot({ path: shot("rule-test-root-context-inconclusive-en.png") });
      await panel().getByRole("button", { name: "Close" }).click();
    }

    // 3. Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    await select("BRDP-EXT-90034");
    await runTest("Probar regla");
    {
      const verdict = await panel().getByTestId("rule-test-verdict").textContent();
      assert(verdict.startsWith("No concluyente: la regla no se aplica a ningún ejemplo (su contexto pide"), `ES: veredicto no concluyente (${verdict.slice(0, 120)})`);
      const causes = await panel().getByTestId("rule-test-accept-cause").allTextContents();
      assert(causes.length === 2 && causes.every((c) => c.includes("la raíz <topic> no cumple el contexto de la regla (no es un documento al que se aplique)")), `ES: la causa (${causes.join(" | ")})`);
      await panel().screenshot({ path: shot("rule-test-root-context-inconclusive-es.png") });
      await panel().getByRole("button", { name: "Cerrar" }).click();
    }
    await select("BRDP-EXT-00034");
    await runTest("Probar regla");
    assert((await panel().getByTestId("rule-test-verdict").textContent()).startsWith("Correcto"), "ES: EXT-00034 Correcto");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
