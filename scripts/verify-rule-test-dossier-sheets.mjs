// Live verification for "Test de reglas DITA: funciones XPath que faltan y
// dosier con fichas": Navantia-shaped rules of a "DITA 1.3 Xpath3.0" project
// (scripts/rule-test-fixtures/navantia-dita3-reconstructed.sch -- the real
// file is not in the repo).
//   1. In Chromium (DOMParser), the 26 rules are executable (before: 8, the
//      other 18 "Not executable: XPST0017"), sort(('b','a','c')) and
//      matches(…, 'i') work, and collection() is still not executable.
//   2. BRDP-EXT-00017 (codes FT-nnn cited in a topic's table must be topics
//      of the dossier; each topic finds its ditamap going up the folders with
//      sort(uri-collection(...))): Test rule is not "Not executable", the
//      prompt says where the ditamap goes, the reject example's violation is
//      shown with the file it is in and its node highlighted in that file,
//      verdict Correct, recorded as passed.
//   3. Spanish texts.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs writes
// dossiers with sheets for this rule).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR
// (default: the system's temp directory).
//
//     node scripts/verify-rule-test-dossier-sheets.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { readTextFile } from "./lib/textFile.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
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
const navRule = (id) =>
  SCH.match(new RegExp(`<sch:pattern id="p-${id}"[\\s\\S]*?</sch:pattern>`))[0].replace("<sch:pattern", '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const NAV_IDS = [...SCH.matchAll(/<sch:pattern id="p-(BRDP-EXT-\d+)"/g)].map((m) => m[1]);

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Dossier sheets rule test ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const brdp = await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({
      identifier: "BRDP-EXT-00017",
      title: "Códigos de ficha citados",
      definition: "Decidir si los códigos de ficha citados en las tablas deben existir en el dosier.",
      proposal: "Todo código de ficha citado en una tabla debe corresponder a una ficha del dosier.",
      validation: "Validated",
    }),
  }).then((x) => x.json());
  const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: navRule("BRDP-EXT-00017"), source: "manual", status: "pending_review" }),
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
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await page.getByTestId("rule-test-indicator").waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  // The reject example: the card whose expectation is "reject".
  async function rejectCard() {
    const n = await panel().locator('[data-testid^="rule-test-example-"][data-testid$="-dossier"]').count();
    for (let i = 0; i < n; i++) {
      const text = (await panel().getByTestId(`rule-test-example-${i}`).textContent()) || "";
      if (/Expected: rejected|Esperado: rechazado/.test(text)) return { card: panel().getByTestId(`rule-test-example-${i}`), i };
    }
    return null;
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.waitForTimeout(300);

    // 1. The engine in Chromium.
    const engineResults = await page.evaluate(async (rules) => {
      const engine = await import("/src/utils/ruleTestEngine.js");
      const analyses = rules.map(([id, xml]) => {
        const a = engine.analyzeRule(xml, "SCH-DITA");
        return { id, status: a.status, dossier: a.dossier === true, reason: a.reason?.code ?? null };
      });
      const probe = (expr) =>
        `<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p"><sch:rule context="/*"><sch:report id="U" test="true()"><sch:value-of select="${expr}"/></sch:report></sch:rule></sch:pattern>`;
      const run = (expr) => engine.runRuleOnFragment(probe(expr), "SCH-DITA", "<topic id='t'><title>x</title></topic>", null, {});
      const sorted = run("string-join(sort(('b','a','c')), ',')");
      const ci = run("string(matches('NOTA: x', '^nota\\s*:', 'i'))");
      const coll = engine.analyzeRule(probe("count(collection())"), "SCH-DITA");
      return { analyses, sorted: sorted.violations[0]?.message, ci: ci.violations[0]?.message, collection: { status: coll.status, reason: coll.reason?.code } };
    }, NAV_IDS.map((id) => [id, navRule(id)]));
    assert(engineResults.analyses.length === 26, "Chromium: the 26 Navantia-shaped rules");
    const notExec = engineResults.analyses.filter((a) => a.status !== "executable");
    assert(notExec.length === 0, `Chromium: all 26 executable (before: 8) ${JSON.stringify(notExec)}`);
    assert(engineResults.analyses.filter((a) => a.dossier).length === 17, "Chromium: 17 dossier rules (the ditamap search)");
    assert(engineResults.sorted === "a,b,c", `Chromium: sort(('b','a','c')) = a,b,c (${engineResults.sorted})`);
    assert(engineResults.ci === "true", `Chromium: matches(…, 'i') (${engineResults.ci})`);
    assert(engineResults.collection.status === "not_executable" && engineResults.collection.reason === "external_document", `Chromium: collection() still not executable (${JSON.stringify(engineResults.collection)})`);

    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 2. EXT-00017 in the panel.
    await select("BRDP-EXT-00017");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 30000 });
    const panelText = (await panel().textContent()) || "";
    assert(!/Not executable/.test(panelText), "EXT-00017: not \"Not executable\"");
    const desc = await panel().getByTestId("rule-test-description").textContent();
    assert(desc.includes("Reads other files of the dossier"), `description: the dossier line (${desc.slice(0, 160)})`);
    const req = await lastRequest();
    const prompt = systemOf(req).replace(/\s+/g, " ");
    assert(/each example is a\s+DOSSIER/.test(prompt), "prompt: the dossier block");
    assert(prompt.includes("The rule runs on EVERY document of the dossier"), "prompt: the rule runs on every document");
    assert(prompt.includes("going up the folders from each file (uri-collection())"), "prompt: where the ditamap goes (going up the folders)");
    const verdict = await panel().getByTestId("rule-test-verdict").textContent();
    assert(verdict.startsWith("Correct"), `EXT-00017: verdict Correct (${verdict})`);
    const rej = await rejectCard();
    assert(rej !== null, "a reject example");
    const rejText = (await rej.card.textContent()) || "";
    assert(/Result: rejected/.test(rejText), "the reject example is rejected");
    assert(/Rule's message, in fichas\/[\w.-]+\.dita: La ficha cita el código FT-\d{3}, que no corresponde a ninguna ficha del dosier\./.test(rejText), `the violation names its file (${rejText.match(/Rule's message[^\n]*/)?.[0] ?? rejText.slice(0, 300)})`);
    const dossier = panel().getByTestId(`rule-test-example-${rej.i}-dossier`);
    const fileMarks = await dossier.locator('details[data-path^="fichas/"] mark').count();
    assert(fileMarks > 0, "the selected <entry> is highlighted in the sheet it is in");
    const mainBlock = panel().getByTestId(`rule-test-example-${rej.i}-file-main`);
    assert((await mainBlock.count()) === 1, "the ditamap block is shown first");
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 15000 });
    assert((await approval()).last_test_result === "passed", "EXT-00017: recorded as passed");
    await panel().screenshot({ path: shot("rule-test-dossier-sheets-en.png") });
    await panel().getByRole("button", { name: "Close" }).click();

    // 3. Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    await select("BRDP-EXT-00017");
    await page.getByRole("button", { name: "Probar regla" }).first().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 30000 });
    const verdictEs = await panel().getByTestId("rule-test-verdict").textContent();
    assert(verdictEs.startsWith("Correcto"), `veredicto en español (${verdictEs})`);
    const rejEs = await rejectCard();
    const rejEsText = (await rejEs.card.textContent()) || "";
    assert(/Mensaje de la regla, en fichas\/[\w.-]+\.dita: La ficha cita el código FT-\d{3}/.test(rejEsText), `mensaje con el fichero en español (${rejEsText.match(/Mensaje de la regla[^\n]*/)?.[0] ?? rejEsText.slice(0, 300)})`);
    const descEs = await panel().getByTestId("rule-test-description").textContent();
    assert(descEs.includes("Lee otros ficheros del dosier"), "descripción en español");
    await panel().screenshot({ path: shot("rule-test-dossier-sheets-es.png") });
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
