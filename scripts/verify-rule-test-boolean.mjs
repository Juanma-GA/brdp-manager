// Live verification for "Plantillas, Part 4": BREX paths that are a
// true/false condition, evaluated like s1kd-brexcheck -- S1-00316 written
// with "or" next to its "|" twin (same verdict; the node highlighted with
// "|", the condition message with "or"), and EXT-00019 as the 4.1 template
// had it before the rewrite (//updateCode[…] and (//zoneSpec or …), flag
// 0): the description explains the condition (EN/ES), the examples say
// whether it holds, the verdict is correct and recorded. Only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the projects it creates. Screenshots go to /tmp.
//
//     node scripts/verify-rule-test-boolean.mjs
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

const R_OR = `<structureObjectRule id="BRDP-S1-00316">
  <objectPath allowedObjectFlag="0">//dmStatus/applicRef or //pmStatus/applicRef</objectPath>
  <objectUse>Applicability is written in the status, never referenced.</objectUse>
</structureObjectRule>`;
const R_BAR = R_OR.replace(" or ", " | ").replace("BRDP-S1-00316", "BRDP-BOOL-BAR");
const R19B = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-1/xml_schema_flat/update.xsd">
  <structureObjectRuleGroup>
    <structureObjectRule>
      <objectPath allowedObjectFlag="0">//updateCode[attribute::infoCode="00N"] and (//zoneSpec or //partSpec or //circuitBreakerSpec or //zoneIdent or //partIdent)</objectPath>
      <objectUse>Only toolSpec, toolIdent, figure elements can be used in the Data update file representing the tool CIR.</objectUse>
    </structureObjectRule>
  </structureObjectRuleGroup>
</contextRules>`;

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
  const p42 = await makeProject("Rule test boolean 4.2", "S1000D 4.2");
  const bOr = await makeBrdp(p42, { identifier: "BRDP-S1-00316", title: "Applicability in the status", proposal: "The applicability of a data module shall be written in its status, never referenced with <applicRef>." });
  const bBar = await makeBrdp(p42, { identifier: "BRDP-BOOL-BAR", title: "Applicability in the status", proposal: "The applicability of a data module shall be written in its status, never referenced with <applicRef>." });
  await putDraft(p42, bOr, "BREX-4.2", R_OR);
  await putDraft(p42, bBar, "BREX-4.2", R_BAR);
  const p41 = await makeProject("Rule test boolean 4.1", "S1000D 4.1");
  const b19 = await makeBrdp(p41, { identifier: "BRDP-EXT-00019", title: "Elements in the tool CIR", proposal: "Only toolSpec, toolIdent, figure, figureIdent, multimedia, multimediaIdent, applicIdent, applicRefIdent, applic, applicRef elements can be used in the Data update file representing the tool CIR." });
  await putDraft(p41, b19, "BREX-4.1", R19B);
  for (const p of [p42, p41]) await embed(p);

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
  const colorOf = (loc) => loc.evaluate((el) => getComputedStyle(el).color);

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    await openProject(p42);

    // 1. S1-00316 with "or": a condition.
    await select("BRDP-S1-00316");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const descOr = await page.getByTestId("rule-test-description").textContent();
    assert(descOr.includes("The rule rejects a document in which this condition is true: //dmStatus/applicRef or //pmStatus/applicRef") && !/not (checked|executable)/i.test(descOr), `"or": the description explains the condition (${descOr})`);
    assert((await page.getByTestId("rule-test-analysis").count()) === 0, '"or": no "not executable" notice');
    const sysOr = systemOf(await lastRequest());
    assert(sysOr.includes("THE RULE CHECKS A CONDITION ON THE WHOLE DOCUMENT") && sysOr.includes("the reject example makes it\n  true"), '"or": the prompt says which condition each example meets or avoids');
    const vOr = await verdict().textContent();
    assert(vOr.startsWith("Correct"), `"or": verdict correct (${vOr})`);
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓") && (await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), '"or": applicRef rejected, applic accepted');
    assert((await example(1).getByTestId("rule-test-condition").textContent()) === "The rule's condition holds in this document.", '"or": the reject example says the condition holds');
    assert((await example(0).getByTestId("rule-test-condition").textContent()) === "The rule's condition does not hold in this document.", '"or": the accept example says it does not hold');
    assert((await example(1).locator("mark").count()) === 0, '"or": no node to highlight');
    assert((await page.getByTestId("rule-test-indicator").textContent()).includes("Tested"), '"or": recorded as passed');
    await panel().screenshot({ path: "/tmp/rule-test-boolean-or.png" });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(400);
    assert((await example(1).getByTestId("rule-test-condition").textContent()) === "La condición de la regla se cumple en este documento.", '"or": condition message in ES');
    assert((await page.getByTestId("rule-test-description").textContent()).includes("La regla rechaza un documento en el que se cumple esta condición"), '"or": description in ES');
    await panel().screenshot({ path: "/tmp/rule-test-boolean-or-es.png" });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // 2. The same rule with "|": same verdict, the node highlighted.
    await select("BRDP-BOOL-BAR");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const vBar = await verdict().textContent();
    assert(vBar.startsWith("Correct") && vBar === vOr, `"|": the same verdict as "or" (${vBar})`);
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), '"|": applicRef rejected');
    const markBar = await example(1).locator("mark").allTextContents();
    assert(markBar.some((m) => m.includes("<applicRef")), `"|": the applicRef node highlighted (${JSON.stringify(markBar)})`);
    assert((await page.getByTestId("rule-test-condition").count()) === 0, '"|": no condition message');

    // 3. EXT-00019 as the 4.1 template had it: boolean, flag 0.
    await openProject(p41);
    await select("BRDP-EXT-00019");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const desc19 = await page.getByTestId("rule-test-description").textContent();
    assert(desc19.includes('The rule rejects a document in which this condition is true: //updateCode[attribute::infoCode="00N"] and') && desc19.includes("<zoneSpec>"), `EXT-00019: the description explains the condition and names what it looks at (${desc19.slice(0, 200)})`);
    const v19 = await verdict().textContent();
    assert(v19.startsWith("Correct"), `EXT-00019: verdict correct, not "not executable" (${v19})`);
    assert((await example(1).locator("pre").textContent()).includes('infoCode="00N"') && (await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00019: a part in the tool CIR (condition met) rejected");
    assert((await example(1).getByTestId("rule-test-condition").textContent()).includes("holds"), "EXT-00019: the reject example says the condition holds");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("accepted ✓") && (await example(0).getByTestId("rule-test-condition").textContent()).includes("does not hold"), "EXT-00019: a tool in the tool CIR (condition not met) accepted");
    await panel().screenshot({ path: "/tmp/rule-test-boolean-tool-cir.png" });
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
