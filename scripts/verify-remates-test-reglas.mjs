// Live verification for "Remates del test de reglas y limpieza":
//   1. A DITA rule on <step>: the simulator writes the accept example with a
//      <table> straight in <cmd> (the real case). The application no longer
//      wraps it in <draft-comment> (a non-content element); the example goes
//      to the correction round, which says where the table can go inside
//      <step> ("Inside <step> it can go in <info>, …"). The simulator moves
//      it to <info>; verdict Correct, recorded as passed. English and Spanish.
//   2. "¿Quisiste decir…?": "La etiqueta y los numerales…" in a DITA project
//      (where @y does not exist… but a conjunction is never a name anyway)
//      offers no chip; "el elemento table" still offers <table>.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR
// (default: the system's temp directory).
//
//     node scripts/verify-remates-test-reglas.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
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

const RULE =
  '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p-BRDP-EXT-09101">' +
  '<sch:rule context="step"><sch:assert id="BRDP-EXT-09101" role="error" test="not(stepxmp//table)">' +
  "Una tabla de un paso va en info, no en stepxmp.</sch:assert></sch:rule></sch:pattern>";

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Remates rule test ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const create = (body) => api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify(body) }).then((x) => x.json());
  const brdp = await create({
    identifier: "BRDP-EXT-09101",
    title: "Tablas de un paso",
    definition: "Decidir dónde va una tabla que acompaña a un paso.",
    proposal: "Una tabla que acompaña a un paso va en info, nunca en stepxmp. TABLEINCMD",
    validation: "Validated",
  });
  const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: RULE, source: "manual", status: "pending_review" }),
  });
  if (!put.ok) throw new Error(`seeding failed: ${put.status} ${await put.text()}`);
  await create({ identifier: "BRDP-EXT-09102", title: "La etiqueta y los numerales deben ir juntos.", definition: "", proposal: "", validation: "Pending" });
  await create({ identifier: "BRDP-EXT-09103", title: "Uso del elemento table en los pasos", definition: "", proposal: "", validation: "Pending" });
  {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const approval = () => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`).then((r) => r.json());

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

    // 1. <table> in <cmd>.
    await select("BRDP-EXT-09101");
    proxyBodies.length = 0;
    await page.getByRole("button", { name: "Test rule" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 60000 });
    const lastUsers = proxyBodies.map(messagesOf).map((m) => [...m].reverse().find((x) => x.role === "user")?.content || "");
    const correction = lastUsers.find((u) => u.startsWith("Some examples are not valid."));
    assert(!!correction, "there is a correction round");
    assert(
      correction?.includes("<table> is not allowed inside <cmd>. Inside <step> it can go in <info>"),
      `the correction says where the table can go inside <step> (${(correction || "").split("\n").find((l) => l.includes("<table>")) || "none"})`,
    );
    assert(!(await panel().textContent()).includes("draft-comment"), "nothing is put in <draft-comment>");
    assert(!(await panel().getByTestId("rule-test-wrapped-loose").count()), "no 'put in a container' note");
    assert((await panel().getByTestId("rule-test-correction").textContent()).includes("1 example was corrected"), "the correction fixed the example");
    const results = await resultsOf();
    assert(results[0]?.startsWith("Result: accepted") && results[1]?.startsWith("Result: rejected"), `accepted, rejected (${results.join(" | ")})`);
    assert((await panel().textContent()).includes("<info>"), "the accept example now has the table in <info>");
    const verdict = await panel().getByTestId("rule-test-verdict").textContent();
    assert(verdict.startsWith("Correct"), `verdict Correct (${verdict})`);
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 15000 });
    assert((await approval()).last_test_result === "passed", "recorded as passed");
    await panel().screenshot({ path: shot("remates-table-in-cmd-en.png") });
    await panel().getByRole("button", { name: "Close" }).click();

    // 2. "¿Quisiste decir…?".
    await select("BRDP-EXT-09102");
    assert((await page.getByText("Did you mean @y?").count()) === 0, "EN: 'La etiqueta y los numerales' offers no @y chip");
    assert((await page.getByText(/^Did you mean/).count()) === 0, "EN: no chip at all for that title");
    await select("BRDP-EXT-09103");
    assert((await page.getByText("Did you mean <table>?").count()) >= 1, "EN: 'el elemento table' still offers <table>");

    // Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    await select("BRDP-EXT-09102");
    assert((await page.getByText(/^¿Quisiste decir/).count()) === 0, "ES: sin chip para 'La etiqueta y los numerales'");
    await page.screenshot({ path: shot("remates-no-conjunction-chip-es.png") });
    await select("BRDP-EXT-09101");
    proxyBodies.length = 0;
    await page.getByRole("button", { name: "Probar regla" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 60000 });
    assert((await panel().getByTestId("rule-test-verdict").textContent()).startsWith("Correcto"), "ES: veredicto Correcto");
    assert(!(await panel().textContent()).includes("draft-comment"), "ES: nada en <draft-comment>");
    await panel().screenshot({ path: shot("remates-table-in-cmd-es.png") });
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
