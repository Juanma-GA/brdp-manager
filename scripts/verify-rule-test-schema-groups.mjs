// Live verification for "Test rule: one schema per part of the rule": a
// general rule whose parts look at elements of different schemas (Lufthansa
// S1-00120, //proceduralStep[…] | //levelledPara[…]) is tested with examples
// split by schema (levelledPara in descript, proceduralStep in proced),
// never in sb, and the verdict is "Correct"; when every example is invalid
// the verdict names the schema and the reason (EN / ES). Against the real app
// (Vite + FastAPI + Postgres); only the Mistral TRANSPORT is mocked
// (mock-mistral-chat-server.mjs: split examples, and ALLINVALID).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to /tmp.
//
//     node scripts/verify-rule-test-schema-groups.mjs
import { chromium } from "playwright-core";

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

const R120 = `<structureObjectRule id="BRDP-S1-00120">
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor-or-self::proceduralStep) &gt; 5] | //levelledPara[count(ancestor-or-self::levelledPara) &gt; 5]</objectPath>
  <objectUse>No more than five levels of procedural steps or paragraphs.</objectUse>
</structureObjectRule>
<structureObjectRule id="BRDP-S1-00120-b">
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor-or-self::proceduralStep) = 5]/title | //levelledPara[count(ancestor-or-self::levelledPara) = 5]/title</objectPath>
  <objectUse>The fifth level has no title.</objectUse>
</structureObjectRule>`;

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
      body: JSON.stringify({ definition: "Decide how the data modules are identified.", validation: "Validated", ...fields }),
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
      if (s.status !== "running") {
        if (s.status !== "completed") throw new Error(`embedding job ${s.status}: ${s.error}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("embedding job did not finish");
  }

  // ---- seed ----
  const p42 = await makeProject("Rule test schema groups 4.2", "S1000D 4.2");
  const b120 = await makeBrdp(p42, { identifier: "BRDP-S1-00120", title: "Levels of steps and paragraphs", proposal: "Procedural steps and paragraphs shall have at most five levels, and the fifth level shall have no title." });
  const bBad = await makeBrdp(p42, { identifier: "BRDP-SG-BAD", title: "Levels (invalid examples)", proposal: "At most five levels. ALLINVALID" });
  await putDraft(p42, b120, "BREX-4.2", R120);
  await putDraft(p42, bBad, "BREX-4.2", R120);
  await embed(p42);

  // ---- UI ----
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
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
    await page.fill('input[placeholder="Search by ID or Title…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(500); // rule approval fetch
  }
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

    // 1. S1-00120: examples split by schema, never sb, verdict correct.
    await select("BRDP-S1-00120");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    const sys = systemOf(await lastRequest());
    assert(sys.includes("examples are split by schema") && sys.includes('- "descript": for <levelledPara>, <title>') && sys.includes('- "proced": for <proceduralStep>, <title>'), "S1-00120: the prompt splits the examples by schema");
    assert(!sys.includes('- schema "sb"'), "S1-00120: sb is never offered");
    assert(sys.includes('- schema "descript": your content goes directly inside <description>') && sys.includes('- schema "proced": your content goes directly inside <mainProcedure>'), "S1-00120: one insertion point per schema");
    assert((await verdict().textContent()).startsWith("Correct"), `S1-00120: verdict correct (${await verdict().textContent()})`);
    const count = await page.locator('[data-testid^="rule-test-example-"]').count();
    const schemas = [];
    const results = [];
    for (let i = 0; i < count; i += 1) {
      schemas.push((await example(i).textContent()).match(/Schema: ([a-z]+)/)?.[1]);
      results.push((await example(i).getByTestId("rule-test-result").textContent()).replace(/^Result: /, ""));
    }
    assert(JSON.stringify(schemas) === '["descript","descript","descript","proced","proced","proced"]', `S1-00120: examples in descript and proced (${JSON.stringify(schemas)})`);
    assert(JSON.stringify(results) === '["accepted ✓","rejected ✓","rejected ✓","accepted ✓","rejected ✓","rejected ✓"]', `S1-00120: 5 levels accepted, 6 levels and a title on level 5 rejected (${JSON.stringify(results)})`);
    assert((await example(4).locator("pre").textContent()).includes("<mainProcedure>") && (await example(1).locator("pre").textContent()).includes("<description>"), "S1-00120: each example built on its own schema");
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Tested"), "S1-00120: recorded as passed");
    await panel().screenshot({ path: "/tmp/rule-test-schema-groups.png" });

    // 2. Every example invalid: the schema and the reason are named.
    await select("BRDP-SG-BAD");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    const text = await verdict().textContent();
    assert(text.startsWith("None of the examples could be run. The 2 examples of the descript schema are not valid there: ") && /sbSummary/.test(text), `no runnable: schema and reason named (${text})`);
    assert(!/^None of the examples could be run \(see each example\)/.test(text), "no runnable: not only 'regenerate'");
    await panel().screenshot({ path: "/tmp/rule-test-no-runnable-named.png" });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(400);
    const textEs = await verdict().textContent();
    assert(textEs.startsWith("No se pudo ejecutar ningún ejemplo. Los 2 ejemplos del esquema descript no son válidos en él: ") && /sbSummary/.test(textEs), `no runnable: Spanish (${textEs})`);
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
