// Live verification for "Test de reglas DITA: contenido suelto en el cuerpo
// de las fichas del dosier": Navantia BRDP-EXT-00014 (every figure with an
// @id is cited) and BRDP-EXT-00015 (every table) of a "DITA 1.3 Xpath3.0"
// project, reconstructed with the reported shape in
// scripts/rule-test-fixtures/navantia-dita3-cited-figures-tables.sch.
//   1. Test rule on each: the examples prompt says how each sheet type is
//      built (SHEETS); the simulator writes <p>/<fig>/<table> straight in
//      <taskbody>, as Mistral did, and never corrects it; the application
//      puts them in a <context> itself, with a note on each sheet, no
//      correction round, both examples run, verdict Correct, recorded as
//      passed.
//   2. Spanish texts.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR
// (default: the system's temp directory).
//
//     node scripts/verify-rule-test-loose-content.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { readTextFile } from "./lib/textFile.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
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

const SCH = readTextFile(new URL("./rule-test-fixtures/navantia-dita3-cited-figures-tables.sch", import.meta.url));
const ruleOf = (id) => SCH.match(new RegExp(`<sch:pattern id="p-${id}"[\\s\\S]*?</sch:pattern>`))[0].replace("<sch:pattern", '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const CASES = [
  { id: "BRDP-EXT-00014", what: "figura", loose: "<p> and <fig>", looseEs: "<p> y <fig>", message: "La figura f1 no se cita en ninguna ficha del dosier." },
  { id: "BRDP-EXT-00015", what: "tabla", loose: "<p> and <table>", looseEs: "<p> y <table>", message: "La tabla t1 no se cita en ninguna ficha del dosier." },
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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Loose content rule test ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const brdps = {};
  for (const c of CASES) {
    const brdp = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({
        identifier: c.id,
        title: `${c.what} citada`,
        definition: `Decidir si toda ${c.what} de una ficha debe citarse en el texto.`,
        proposal: `Toda ${c.what} con identificador de una ficha se cita con una referencia cruzada en alguna ficha del dosier.`,
        validation: "Validated",
      }),
    }).then((x) => x.json());
    const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: ruleOf(c.id), source: "manual", status: "pending_review" }),
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
  const examplesRequests = () => proxyBodies.map(messagesOf).filter((m) => m[0]?.content?.includes("each example is a"));
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await page.getByTestId("rule-test-indicator").waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
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

    for (const c of CASES) {
      await select(c.id);
      proxyBodies.length = 0;
      await page.getByRole("button", { name: "Test rule" }).first().click();
      await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 40000 });
      const reqs = examplesRequests();
      assert(reqs.length === 1, `${c.id}: one examples call, no correction round (${reqs.length})`);
      const sys = reqs[0] ? reqs[0][0].content.replace(/\s+/g, " ") : "";
      assert(sys.includes("- SHEETS: each file is one of these types"), `${c.id}: the prompt has the SHEETS block`);
      assert(sys.includes("- <task>: its content goes in task/taskbody/context") && sys.includes("never directly in <taskbody>"), `${c.id}: the prompt says how a task sheet is built`);
      assert(sys.includes("Write each sheet as <topic> with <body> unless the rule needs another type."), `${c.id}: the prompt says <topic> with <body> by default`);
      const notes = await panel().getByTestId("rule-test-wrapped-loose").allTextContents();
      const expected = `Adjusted by the app: ${c.loose} were put in <context> (they do not go directly in <taskbody>).`;
      assert(notes.length === 2 && notes.every((n) => n === expected), `${c.id}: the note on each sheet (${notes.join(" | ")})`);
      assert(!(await panel().textContent()).includes("corrected automatically"), `${c.id}: no correction round shown`);
      const results = await resultsOf();
      assert(results[0]?.startsWith("Result: accepted") && results[1]?.startsWith("Result: rejected"), `${c.id}: accepted, rejected (${results.join(" | ")})`);
      assert((await panel().textContent()).includes(c.message), `${c.id}: the rule's message on the rejected example`);
      const verdict = await panel().getByTestId("rule-test-verdict").textContent();
      assert(verdict.startsWith("Correct"), `${c.id}: verdict Correct (${verdict})`);
      await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 15000 });
      const saved = await approval(c.id);
      assert(saved.last_test_result === "passed", `${c.id}: recorded as passed`);
      if (c.id === "BRDP-EXT-00014") await panel().screenshot({ path: shot("rule-test-loose-content-en.png") });
      await panel().getByRole("button", { name: "Close" }).click();
    }

    // 2. Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    await select("BRDP-EXT-00014");
    await page.getByRole("button", { name: "Probar regla" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 40000 });
    const notesEs = await panel().getByTestId("rule-test-wrapped-loose").allTextContents();
    const expectedEs = `Ajustado por la app: ${CASES[0].looseEs} se metieron en <context> (no van directamente en <taskbody>).`;
    assert(notesEs.length === 2 && notesEs.every((n) => n === expectedEs), `ES: la nota en cada ficha (${notesEs.join(" | ")})`);
    assert((await panel().getByTestId("rule-test-verdict").textContent()).startsWith("Correcto"), "ES: veredicto Correcto");
    await panel().screenshot({ path: shot("rule-test-loose-content-es.png") });
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
