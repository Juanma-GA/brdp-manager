// Live verification for "Test de reglas DITA: el título del topic montado
// cuando la regla lo exige": Navantia BRDP-EXT-00011 of a "DITA 1.3
// Xpath3.0" project, real context
//   *[normalize-space(title) = 'LISTA DE REFERENCIAS CONSOLIDADAS'] //section//…
// (scripts/rule-test-fixtures/navantia-dita3-reconstructed.sch).
//   1. Test rule: the prompt says the application writes the topic's title
//      as the rule asks; every example carries <title>LISTA DE REFERENCIAS
//      CONSOLIDADAS</title> on the topic, with the note; the simulator
//      repeats the real answer (the same title on the <section>) and the
//      verdict is Correct, recorded as passed with those examples.
//   2. No "several <title>" warning for normalize-space(title).
//   3. Spanish texts.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR
// (default: the system's temp directory).
//
//     node scripts/verify-rule-test-topic-title.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { readTextFile } from "./lib/textFile.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const TITLE = "LISTA DE REFERENCIAS CONSOLIDADAS";

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
const RULE = SCH.match(/<sch:pattern id="p-BRDP-EXT-00011"[\s\S]*?<\/sch:pattern>/)[0].replace("<sch:pattern", '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Topic title rule test ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const brdp = await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({
      identifier: "BRDP-EXT-00011",
      title: "Orden de los apartados de la lista de referencias",
      definition: "Decidir cómo se ordenan los apartados de la lista de referencias consolidadas.",
      proposal: "Los apartados de la lista de referencias consolidadas van (a), (b), (c)… sin saltos ni repeticiones.",
      validation: "Validated",
    }),
  }).then((x) => x.json());
  const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: RULE, source: "manual", status: "pending_review" }),
  });
  if (!put.ok) throw new Error(`seeding failed: ${put.status} ${await put.text()}`);
  const approval = () => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`).then((r) => r.json());
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
  const language = () => page.locator("header select, nav select").first();
  // The examples request, as the browser sends it to /api/llm-proxy.
  const proxyBodies = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") proxyBodies.push(req.postData() || "");
  });
  const systemOf = (body) => JSON.parse(body).payload.messages.find((m) => m.role === "system").content;
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

    // 1. EXT-00011 in the panel.
    await select("BRDP-EXT-00011");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 30000 });
    const examplesBody = proxyBodies.find((b) => b.includes("THE RULE DEPENDS ON A TITLE"));
    assert(Boolean(examplesBody), "the examples request was sent");
    const prompt = examplesBody ? systemOf(examplesBody).replace(/\s+/g, " ") : "";
    assert(prompt.includes(`The application already writes the <title> of <topic> as "${TITLE}"`), "prompt: the app writes the topic's title");
    assert(prompt.includes("Here that element is the <topic> itself"), "prompt: the title block says the topic carries it");
    const verdict = await panel().getByTestId("rule-test-verdict").textContent();
    assert(verdict.startsWith("Correct"), `EXT-00011: verdict Correct (${verdict})`);
    const notes = await panel().getByTestId("rule-test-topic-title").allTextContents();
    assert(notes.length === 4, `the note on every example (${notes.length})`);
    assert(notes.every((n) => n === `Adjusted by the app: the topic's title is «${TITLE}», as the rule asks.`), `note text (${notes[0]})`);
    const pathWarnings = await panel().locator('[data-testid="rule-test-path-warning"][data-kind="textFunction"]').count();
    assert(pathWarnings === 0, `no "several <title>" warning (${pathWarnings})`);
    assert((await panel().getByTestId("rule-test-several-uncovered").count()) === 0, "no \"no example has more than one <title>\" note");
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 15000 });
    const saved = await approval();
    assert(saved.last_test_result === "passed", "EXT-00011: recorded as passed");
    const examples = saved.last_passed_test?.examples || [];
    assert(examples.length === 4, `four saved examples (${examples.length})`);
    assert(
      examples.every((e) => new RegExp(`^<topic\\b[^>]*>\\s*<title>${TITLE}</title>`).test(e.xml.replace(/^<\?xml[^>]*>\s*/, ""))),
      "every example's topic carries the rule's title",
    );
    const results = examples.map((e) => `${e.expected}:${e.result}`).sort().join(",");
    assert(results === "accept:accepted,reject:rejected,reject:rejected,reject:rejected", `(a)(b)(c) accepted, (a)(c) (b)(c) (a)(a) rejected (${results})`);
    await panel().screenshot({ path: shot("rule-test-topic-title-en.png") });
    await panel().getByRole("button", { name: "Close" }).click();

    // 3. Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    await select("BRDP-EXT-00011");
    await page.getByRole("button", { name: "Probar regla" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 30000 });
    const verdictEs = await panel().getByTestId("rule-test-verdict").textContent();
    assert(verdictEs.startsWith("Correcto"), `veredicto en español (${verdictEs})`);
    const noteEs = await panel().getByTestId("rule-test-topic-title").first().textContent();
    assert(noteEs === `Ajustado por la app: el título del topic es «${TITLE}», como pide la regla.`, `nota en español (${noteEs})`);
    await panel().screenshot({ path: shot("rule-test-topic-title-es.png") });
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
