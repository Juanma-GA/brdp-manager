// Live verification for "Test de reglas DITA: reglas que solo avisan, y
// fichas del dosier válidas": Navantia BRDP-EXT-00012 and 00013 of a
// "DITA 1.3 Xpath3.0" project (role="warning" assert, context
// row[…][ancestor::*[normalize-space(title) = 'LISTA DE …']], dossier rule;
// reconstructed with the real shape in
// scripts/rule-test-fixtures/navantia-dita3-reconstructed.sch).
//   1. Test rule on EXT-00012: "This rule only warns", no "cannot reject";
//      the examples prompt says the rule only warns and where the list
//      title can go in a task file; the simulator repeats the real failure
//      (<sectiondiv><title> in <taskbody>), the correction round carries the
//      card of <taskbody> and where the title goes, the sheets come back
//      valid; named and exempt items "did not warn", the leftover "warned"
//      with the rule's warning under it; verdict Correct, recorded as passed.
//   2. EXT-00013, the same.
//   3. Spanish texts.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR
// (default: the system's temp directory).
//
//     node scripts/verify-rule-test-warning-dossier.mjs
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

const SCH = readTextFile(new URL("./rule-test-fixtures/navantia-dita3-reconstructed.sch", import.meta.url));
const ruleOf = (id) => SCH.match(new RegExp(`<sch:pattern id="p-${id}"[\\s\\S]*?</sch:pattern>`))[0].replace("<sch:pattern", '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const CASES = [
  { id: "BRDP-EXT-00012", title: "LISTA DE MATERIAL OBLIGATORIO", what: "material" },
  { id: "BRDP-EXT-00013", title: "LISTA DE HERRAMIENTAS ESPECIALES", what: "herramienta" },
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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Warning rule test ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const brdps = {};
  for (const c of CASES) {
    const brdp = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({
        identifier: c.id,
        title: `${c.what} que sobra en la lista`,
        definition: `Decidir si se avisa del ${c.what} de la lista que ningún paso nombra.`,
        proposal: `Se da aviso (no error) cuando un ${c.what} de la lista no se nombra en ningún paso de la ficha, salvo que esté marcado como exento.`,
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
  // One card per example (the dossier's files carry rule-test-example-N-…).
  const examples = () => ({ nth: (i) => panel().getByTestId(`rule-test-example-${i}`) });
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
      const only = await panel().getByTestId("rule-test-warning-only").textContent();
      assert(only === "This rule only warns (role=warning): it does not reject documents; the test checks when it warns.", `${c.id}: the 'only warns' line`);
      assert((await panel().getByTestId("rule-test-cannot-reject").count()) === 0, `${c.id}: no 'cannot reject' warning`);
      const examplesReq = proxyBodies.map(messagesOf).find((m) => m[0]?.content?.includes("each example is a"));
      const sys = examplesReq ? examplesReq[0].content.replace(/\s+/g, " ") : "";
      assert(sys.includes("THE RULE ONLY WARNS"), `${c.id}: the examples prompt says the rule only warns`);
      assert(sys.includes("- in a task file: the <task> itself (its own <title>, its first child), or task/taskbody/"), `${c.id}: the prompt says where the title goes in a task file`);
      const correction = proxyBodies.map(messagesOf).find((m) => m.length > 2);
      const fix = correction ? correction.at(-1).content : "";
      assert(fix.includes('file "fichas/ft-001.dita": <sectiondiv> is not allowed inside <taskbody>'), `${c.id}: the correction names the file and the <sectiondiv>`);
      assert(/card of <taskbody> in the task schema: allowed children: [^;]*example/.test(fix), `${c.id}: the correction carries the card of <taskbody>`);
      assert(fix.includes(`The title the rule looks for ("${c.title}") goes on the file's own <task>`), `${c.id}: the correction says where the title goes`);
      assert((await panel().textContent()).includes("3 examples were corrected automatically"), `${c.id}: 3 of 3 corrected`);
      const results = await resultsOf();
      assert(results[0].startsWith("Result: did not warn") && results[1].startsWith("Result: did not warn") && results[2].startsWith("Result: warned"), `${c.id}: did not warn, did not warn, warned (${results.join(" | ")})`);
      assert((await examples().nth(2).textContent()).includes("Expected: warns"), `${c.id}: the leftover is expected to warn`);
      assert((await examples().nth(2).textContent()).includes("Rule's warning, in fichas/ft-001.dita: Da aviso (warning, no error):"), `${c.id}: the rule's warning under the example, with its file`);
      const verdict = await panel().getByTestId("rule-test-verdict").textContent();
      assert(verdict.startsWith("Correct"), `${c.id}: verdict Correct (${verdict})`);
      await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 15000 });
      const saved = await approval(c.id);
      assert(saved.last_test_result === "passed", `${c.id}: recorded as passed`);
      if (c.id === "BRDP-EXT-00012") await panel().screenshot({ path: shot("rule-test-warning-dossier-en.png") });
      await panel().getByRole("button", { name: "Close" }).click();
    }

    // 3. Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    await select("BRDP-EXT-00012");
    await page.getByRole("button", { name: "Probar regla" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 40000 });
    assert((await panel().getByTestId("rule-test-warning-only").textContent()) === "Esta regla solo avisa (role=warning): no rechaza documentos; la prueba comprueba cuándo avisa.", "ES: línea de solo avisa");
    const third = await examples().nth(2).textContent();
    assert(third.includes("Esperado: avisa") && third.includes("Resultado: avisó"), `ES: esperado avisa / resultado avisó (${third.slice(0, 200)})`);
    assert(third.includes("Aviso de la regla, en fichas/ft-001.dita:"), "ES: aviso de la regla con su fichero");
    assert((await examples().nth(0).textContent()).includes("Resultado: no avisó"), "ES: no avisó");
    assert((await panel().getByTestId("rule-test-verdict").textContent()).startsWith("Correcto"), "ES: veredicto Correcto");
    await panel().screenshot({ path: shot("rule-test-warning-dossier-es.png") });
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
