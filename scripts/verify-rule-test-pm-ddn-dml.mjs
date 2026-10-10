// Live verification for "Test de reglas: condiciones con raíz absoluta, y
// cabecera de pm/ddn/dml", against the real app (Vite + FastAPI + Postgres).
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs, which
// answers from the minimal sections the prompt quotes):
//   - BRDP-EXT-00029 of Official Default CMP ATA 4.2 (flag 1, a condition
//     with /ddn and /dml): runs -- descript All / assert / applicRef
//     accepted and "Some text" rejected, pm All accepted and free text
//     rejected, ddn and dml built whole by the app and accepted; verdict
//     "Correct", recorded as passed. Before: "Not executable: the path
//     starts at /ddn…".
//   - a node path whose only root is /pm: runs on a publication module,
//     with the pm's own identification and status section;
//   - a rule on the comment's section (not built yet): "Not executable",
//     with the reason, and no LLM call;
//   - a rule on the comment's section OR dmStatus: tested on descript, and
//     the panel says which part was not tested (EN and ES).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-rule-test-pm-ddn-dml.mjs
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

const status = (el) =>
  `(//${el}/applic/assert/@applicPropertyType or //${el}/applic//evaluate/assert/@applicPropertyType or //${el}/applicRef or //${el}/applic/displayText/simplePara[lower-case(.)[contains(.,'all')]])`;
const R29 = `<structureObjectRule id="BRDP-EXT-00029">
  <objectPath allowedObjectFlag="1">(/ddn or /dml or ${status("dmStatus").slice(1, -1)}) or ${status("pmStatus")}</objectPath>
  <objectUse>The applicability of a data module or publication module must be stated.</objectUse>
</structureObjectRule>`;
const R_PM = `<structureObjectRule id="BRDP-PMONLY">
  <objectPath allowedObjectFlag="0">/pm/identAndStatusSection/pmStatus/applicRef</objectPath>
  <objectUse>A publication module writes its applicability, never references it.</objectUse>
</structureObjectRule>`;
const R_COMMENT = `<structureObjectRule id="BRDP-COMMENT">
  <objectPath allowedObjectFlag="0">//commentStatus/commentResponse</objectPath>
  <objectUse>No response in the comment status.</objectUse>
</structureObjectRule>`;
const R_MIXED = `<structureObjectRule id="BRDP-MIXED">
  <objectPath allowedObjectFlag="0">//commentStatus/commentResponse | //dmStatus/applicRef</objectPath>
  <objectUse>Applicability is written in the status, never referenced.</objectUse>
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

  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Rule test pm ddn dml ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  async function makeBrdp(fields, rule) {
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ definition: "Decide how the applicability is stated.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
    const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: rule, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
    return b;
  }
  await makeBrdp({ identifier: "BRDP-EXT-00029", title: "Applicability of DMs and PMs", proposal: "The applicability of every data module and publication module shall be stated: All, an assertion or an applicability reference. DDNs and DMLs have none." }, R29);
  await makeBrdp({ identifier: "BRDP-PMONLY", title: "Publication module applicability", proposal: "A publication module shall write its applicability in its status, never reference it with <applicRef>." }, R_PM);
  await makeBrdp({ identifier: "BRDP-COMMENT", title: "Comment responses", proposal: "Comments shall carry no response in their status." }, R_COMMENT);
  await makeBrdp({ identifier: "BRDP-MIXED", title: "Applicability in the status", proposal: "The applicability of a data module shall be written in its status, never referenced with <applicRef>." }, R_MIXED);
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 80; i++) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(500);
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 1. EXT-00029.
    await select("BRDP-EXT-00029");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    const text29 = await panel().textContent();
    assert(!text29.includes("Not executable"), "EXT-00029: never 'Not executable' (/ddn on a <dmodule> is false)");
    assert((await verdict().textContent()).startsWith("Correct"), `EXT-00029: verdict correct (${await verdict().textContent()})`);
    const sys29 = systemOf(await lastRequest());
    assert(sys29.includes('- "ddn": for <ddn> — ONE example only') && sys29.includes('- "dml": for <dml> — ONE example only'), "EXT-00029: ddn and dml offered, one example only");
    assert(sys29.includes("looks at the publication module's identification and status section") && sys29.includes("<pmStatus>"), "EXT-00029: the pm's own section in the prompt");
    const results = [];
    for (let i = 0; i < 8; i++) results.push((await example(i).getByTestId("rule-test-result").textContent()).trim());
    assert(results.every((r) => r.endsWith("✓")), `EXT-00029: every example as expected (${results.join(" | ")})`);
    assert(results[1].includes("rejected") && results[5].includes("rejected"), "EXT-00029: descript and pm free text rejected");
    const pmXml = await example(4).locator("pre").textContent();
    assert(/<pm [\s\S]*<identAndStatusSection>[\s\S]*<pmStatus>[\s\S]*<content>/.test(pmXml) && !/<content>[\s\S]*<pmStatus>/.test(pmXml), "EXT-00029: the pm example has <pmStatus> in its section, not in <content>");
    for (const i of [6, 7]) {
      assert((await example(i).getByTestId("rule-test-root-only").count()) === 1, `EXT-00029: example ${i + 1} built by the app (note shown)`);
      assert((await example(i).getByRole("button", { name: "Edit" }).count()) === 0, `EXT-00029: example ${i + 1} has nothing to edit`);
    }
    const ddnXml = await example(6).locator("pre").textContent();
    assert(ddnXml.includes("<ddn ") && ddnXml.includes("<ddnStatus>") && ddnXml.includes("<authorization>"), "EXT-00029: the ddn is a whole document with its section");
    await panel().screenshot({ path: shot("rule-test-ext29-pm-ddn-dml.png") });
    await example(6).screenshot({ path: shot("rule-test-ext29-ddn-built-by-app.png") });
    await example(5).screenshot({ path: shot("rule-test-ext29-pm-rejected.png") });
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Tested"), "EXT-00029: recorded as passed");

    // 2. A node path rooted only at /pm, run on a pm.
    await select("BRDP-PMONLY");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    assert((await verdict().textContent()).startsWith("Correct"), `/pm only: verdict correct (${await verdict().textContent()})`);
    const pmOnly = await example(1).locator("pre").textContent();
    assert(pmOnly.trim().startsWith("<pm ") && pmOnly.includes("<applicRef"), "/pm only: the example is a pm with an applicRef in its status");
    const mark = (await example(1).locator("mark").allTextContents()).join(" ");
    assert(mark.includes("<applicRef"), `/pm only: the pm's applicRef highlighted (${mark})`);

    // 3. The comment's section (not built yet): not executable, no LLM call.
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await select("BRDP-COMMENT");
    await page.getByRole("button", { name: "Test rule" }).click();
    await page.waitForTimeout(2500);
    const cText = await panel().textContent();
    assert(cText.includes("looks inside the identification and status section of the comment schema"), `comment: not executable with the reason (${cText.slice(0, 300)})`);
    assert((await lastRequest()) === null || (await lastRequest()).messages === undefined, "comment: no LLM call");
    await panel().screenshot({ path: shot("rule-test-comment-section-unavailable.png") });

    // 4. comment OR dmStatus: tested on descript, the untested part said.
    await select("BRDP-MIXED");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    assert((await verdict().textContent()).startsWith("Correct"), `mixed: verdict correct on descript (${await verdict().textContent()})`);
    const untested = await page.getByTestId("rule-test-untested").textContent();
    assert(untested.includes("Part of the rule was not tested: <commentStatus>") && untested.includes("the comment schema"), `mixed: untested part named (${untested})`);
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(500);
    const untestedEs = await page.getByTestId("rule-test-untested").textContent();
    assert(untestedEs.includes("Parte de la regla no probada: <commentStatus>, <commentResponse> (esquema comment)"), `mixed: untested part in Spanish (${untestedEs})`);
    await panel().screenshot({ path: shot("rule-test-untested-part-es.png") });
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
