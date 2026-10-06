// Live verification for "Ruta del esquema para las reglas sobre la sección de
// identificación y estado": BRDP-S1-00065 (Lufthansa, //copyright) against
// the real app (Vite + FastAPI + Postgres). Only the Mistral TRANSPORT is
// mocked (mock-mistral-chat-server.mjs):
//   1. 4.2: the prompt gives the way dmStatus/dataRestrictions/
//      restrictionInfo/copyright with the required restrictionInstructions/
//      dataDistribution; the mock follows it → both examples valid, the
//      current notice accepted, the wrong year rejected, recorded as passed.
//   2. 4.2 with MISPLACED in the Proposal: the mock repeats the real run's
//      mistake (<copyright> straight in <dmStatus>); the application moves it
//      along the only way, without a correction round, and says so (EN/ES).
//   3. 3.0.1: the way status/datarest/inform/copyright.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite
// on 5173. Cleans up the projects it creates. Screenshots go to SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-rule-test-schema-route.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
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

const R65 = `<structureObjectRule id="BRDP-S1-00065">
  <objectPath allowedObjectFlag="0">//copyright[not(contains(., 'Copyright © 2024 by Lufthansa Technik AG'))]</objectPath>
  <objectUse>BRDP-S1-00065. The copyright notice must be the Lufthansa Technik AG one of 2024.</objectUse>
</structureObjectRule>`;
const R65_301 = `<objrule id="BRDP-S1-00065">
  <objpath objappl="0">//copyright[not(contains(., 'Copyright © 2024 by Lufthansa Technik AG'))]</objpath>
  <objuse>BRDP-S1-00065. The copyright notice must be the Lufthansa Technik AG one of 2024.</objuse>
</objrule>`;
const PROPOSAL = 'Projects creating their own documentation shall have the copyright incorporated: "Copyright © 2024 by Lufthansa Technik AG."';

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
  const projects = [];
  async function makeProject(name, standard) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    return p;
  }
  async function makeBrdp(project, fields) {
    return api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ definition: "Decide whether and how to use the element <copyright>.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
  }
  async function putDraft(project, brdp, format, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  async function embed(project) {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const p42 = await makeProject("Schema route 4.2", "S1000D 4.2");
  const b65 = await makeBrdp(p42, { identifier: "BRDP-S1-00065", title: "Use of the element <copyright> and source of copyright information", proposal: PROPOSAL });
  const bMis = await makeBrdp(p42, { identifier: "BRDP-S1-00065-MIS", title: "Use of the element <copyright> (misplaced)", proposal: `${PROPOSAL} MISPLACED` });
  await putDraft(p42, b65, "BREX-4.2", R65);
  await putDraft(p42, bMis, "BREX-4.2", R65);
  const p301 = await makeProject("Schema route 3.0.1", "S1000D 3.0.1");
  const b301 = await makeBrdp(p301, { identifier: "BRDP-S1-00065", title: "Use of the element <copyright>", proposal: PROPOSAL });
  await putDraft(p301, b301, "BREX-3.0.1", R65_301);
  for (const p of [p42, p301]) await embed(p);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  async function openProject(p) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr").filter({ has: page.locator("td", { hasText: new RegExp(`^${identifier}$`) }) }).first().click();
    await page.waitForTimeout(700);
  }
  let calls = 0;
  const countCalls = () => {
    calls = 0;
  };
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy")) calls += 1;
  });
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    await openProject(p42);

    // 1. The way in the prompt; the mock follows it.
    await select("BRDP-S1-00065");
    countCalls();
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys = systemOf(await lastRequest());
    assert(sys.includes("<copyright> is not directly inside any element of that section.") && sys.includes("    dmStatus/dataRestrictions/restrictionInfo/copyright"), "4.2: the prompt gives the way down to <copyright>");
    assert(sys.includes("<dataRestrictions> goes inside <dmStatus>, right after <security>,") && sys.includes("<dataDistribution>…</dataDistribution>"), "4.2: …where <dataRestrictions> goes and its required children");
    assert((await verdict().textContent()).startsWith("Correct"), `4.2: verdict correct (${await verdict().textContent()})`);
    assert(calls === 1, `4.2: one LLM call, no correction round (${calls})`);
    const x0 = await example(0).locator("pre").textContent();
    assert(/<dataRestrictions>\s*<restrictionInstructions>\s*<dataDistribution>/.test(x0) && /<restrictionInfo>\s*<copyright>/.test(x0), "4.2: the example has the whole way with the required children");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓") && (await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "4.2: current notice accepted, wrong year rejected");
    assert((await page.getByTestId("rule-test-relocated").count()) === 0, "4.2: nothing to move when the LLM follows the way");
    await panel().screenshot({ path: shot("rule-test-schema-route-copyright.png") });
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Tested"), "4.2: recorded as passed");

    // 2. The real run's mistake: moved by the application.
    await select("BRDP-S1-00065-MIS");
    countCalls();
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    assert(calls === 1, `misplaced: one LLM call, no correction round (${calls})`);
    assert((await verdict().textContent()).startsWith("Correct"), `misplaced: verdict correct (${await verdict().textContent()})`);
    const note = await example(0).getByTestId("rule-test-relocated").textContent();
    assert(note === "Corrected by the application (placement according to the schema): <copyright> → dmStatus/dataRestrictions/restrictionInfo.", `misplaced: the note says what was moved (${note})`);
    assert((await example(1).getByTestId("rule-test-relocated").count()) === 1, "misplaced: the reject example corrected too");
    const xm = await example(1).locator("pre").textContent();
    assert(/<restrictionInfo>\s*<copyright>[\s\S]*2023/.test(xm) && !/<security [^>]*\/>\s*<copyright>/.test(xm), "misplaced: <copyright> now along its way, with its text");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "misplaced: wrong year rejected");
    await panel().screenshot({ path: shot("rule-test-schema-route-relocated.png") });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(400);
    const noteEs = await example(0).getByTestId("rule-test-relocated").textContent();
    assert(noteEs === "Corregido por la aplicación (colocación según el esquema): <copyright> → dmStatus/dataRestrictions/restrictionInfo.", `misplaced: the note in Spanish (${noteEs})`);
    await panel().screenshot({ path: shot("rule-test-schema-route-relocated-es.png") });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // 3. 3.0.1: its own way.
    await openProject(p301);
    await select("BRDP-S1-00065");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const sys301 = systemOf(await lastRequest());
    assert(sys301.includes("    status/datarest/inform/copyright") && sys301.includes("<distrib>…</distrib>"), "3.0.1: the prompt gives status/datarest/inform/copyright with instruct/distrib");
    assert((await verdict().textContent()).startsWith("Correct"), `3.0.1: verdict correct (${await verdict().textContent()})`);
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
