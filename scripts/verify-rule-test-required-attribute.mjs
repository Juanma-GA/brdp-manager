// Live verification for "Test de reglas: la comprobación estructural no
// detecta atributos obligatorios que faltan" (GMC 4.2 BRDP-EXT-00160,
// (not(//qualityAssurance/firstVerification)) and not(/ddn or /dml or
// /comment), flag 0). Like the real run, the simulator writes the example
// meant to be rejected as <firstVerification/> without its required
// @verificationType: the example is not run and not corrected, its note says
// the schema already requires the attribute, the verdict is "Already covered
// by the schema: @verificationType is required in <firstVerification>"
// (recorded), and the Proposal check is told the attribute is required --
// in EN and ES. Only the Mistral TRANSPORT is mocked
// (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to
// SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-rule-test-required-attribute.mjs
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

// The real rule of the pass (only the id added).
const EXT160 =
  '<structureObjectRule id="BRDP-EXT-00160"><objectPath allowedObjectFlag="0">(not(//qualityAssurance/firstVerification)) and not(/ddn or /dml or /comment)</objectPath><objectUse>BRDP-EXT-00160 The first verification and its type shall be stated.</objectUse></structureObjectRule>';
const PROPOSAL = "The type of the first verification (@verificationType: tabtop, onobject or ttandoo) shall be stated in every data module.";
const VERDICT_EN = "Already covered by the schema: @verificationType is required in <firstVerification>.";
const VERDICT_ES = "El esquema ya lo incluye: @verificationType es obligatorio en <firstVerification>.";
const NOTE_EN = "The schema already requires this: @verificationType is required in <firstVerification>, so no valid document can leave it out.";
const NOTE_ES = "El esquema ya lo exige: @verificationType es obligatorio en <firstVerification>, así que ningún documento válido puede omitirlo.";

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

  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Required attribute ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const brdp = await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({
      identifier: "BRDP-EXT-00160",
      title: "First verification",
      definition: "Decide whether the first verification of a data module and its type are stated.",
      proposal: PROPOSAL,
      validation: "Validated",
    }),
  }).then((r) => r.json());
  const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: EXT160, source: "manual", status: "pending_review" }),
  });
  if (!put.ok) throw new Error(`seeding rule failed: ${put.status} ${await put.text()}`);
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 80; i++) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const language = (lng) => page.locator("header select, nav select").first().selectOption(lng);
  const exampleLabelled = (label) => panel().locator('[data-testid^="rule-test-example-"]', { hasText: label }).first();

  try {
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-EXT-00160" }).first().click();
    await page.waitForTimeout(600);

    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    const calls = await fetch(`${MOCK}/chat-calls`).then((r) => r.json());
    const v = (await verdict().textContent()).trim();
    assert(v.startsWith(VERDICT_EN), `EN: verdict "already covered by the schema" with the attribute (${v})`);
    const reject = exampleLabelled("First verification without its type");
    const note = (await reject.getByTestId("rule-test-schema-covered-example").textContent()).trim();
    assert(note.startsWith(NOTE_EN), `EN: the reject example says the schema requires the attribute (${note})`);
    assert((await reject.getByTestId("rule-test-result").count()) === 0 || !(await reject.getByTestId("rule-test-result").textContent()).includes("accepted"), "EN: the reject example was not run");
    const accept = exampleLabelled("First verification stated with its type");
    assert((await accept.getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "EN: the accept example (with @verificationType) accepted");
    assert(calls.calls === 2, `EN: no correction round: one call for the examples and one for the Proposal check (${calls.calls})`);
    const check = await fetch(`${MOCK}/last-proposal-check`).then((r) => r.json());
    const checkSystem = check?.messages?.find((m) => m.role === "system")?.content || "";
    assert(/REQUIRED ATTRIBUTES[^\n]*\n- <firstVerification>: @verificationType/.test(checkSystem), "Proposal check: told @verificationType is required on <firstVerification>");
    assert((await page.getByTestId("rule-test-partial").count()) === 0, "Proposal check: no 'covers part of the Proposal' note");
    await page.getByTestId("rule-test-indicator").filter({ hasText: "Already covered by the schema" }).waitFor({ timeout: 10000 });
    assert(true, "EN: recorded as already covered by the schema");
    await panel().screenshot({ path: shot("rule-test-required-attribute-en.png") });

    await language("es");
    await page.waitForTimeout(400);
    const vEs = (await verdict().textContent()).trim();
    assert(vEs.startsWith(VERDICT_ES), `ES: veredicto (${vEs})`);
    const noteEs = (await exampleLabelled("First verification without its type").getByTestId("rule-test-schema-covered-example").textContent()).trim();
    assert(noteEs.startsWith(NOTE_ES), `ES: nota del ejemplo (${noteEs})`);
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("El esquema ya lo incluye"), "ES: indicador");
    await panel().screenshot({ path: shot("rule-test-required-attribute-es.png") });
    await language("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
