// Live verification for "Test de reglas (T3 de 4): registro del test y aviso
// en Verified": the recorded result of Test rule, the indicator in the Rule
// Status box, the warning before Verify, the History entry, and the reason
// shown in the interface language -- against the real app (Vite + FastAPI +
// Postgres). Only the Mistral TRANSPORT is mocked: mock-mistral-chat-server
// .mjs answers the examples prompt with fixed <emphasis> examples, so
//   //emphasis flag 0            -> the engine agrees  -> passed
//   //emphasis flag 2, no values -> accepts the reject -> failed
//   //table flag 0               -> selects nothing    -> inconclusive
//   document()                   -> not executable (no LLM call at all)
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to /tmp.
//
//     node scripts/verify-rule-test-registry.mjs
import { chromium } from "playwright-core";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";

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

const rule = (id, path, flag = "0") =>
  `<structureObjectRule id="${id}">\n  <objectPath allowedObjectFlag="${flag}">${path}</objectPath>\n  <objectUse>Rule ${id}.</objectUse>\n</structureObjectRule>`;

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

  const project = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `Rule test registry ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());
  const brdps = {};
  async function makeBrdp(identifier, fields = {}) {
    brdps[identifier] = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({
        identifier,
        title: `Emphasis ${identifier}`,
        definition: "Decide how emphasis is used.",
        proposal: "The element <emphasis> shall not be used.",
        validation: "Validated",
        ...fields,
      }),
    }).then((r) => r.json());
    return brdps[identifier];
  }
  async function putDraft(identifier, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdps[identifier].id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const approvalOf = (identifier) =>
    api(`/api/projects/${project.id}/brdps/${brdps[identifier].id}/approvals/BREX-4.2`).then((r) => r.json());

  await makeBrdp("BRDP-T3-GOOD");
  await putDraft("BRDP-T3-GOOD", rule("BRDP-T3-GOOD", "//emphasis"));
  await makeBrdp("BRDP-T3-FAIL");
  await putDraft("BRDP-T3-FAIL", rule("BRDP-T3-FAIL", "//emphasis", "2"));
  await makeBrdp("BRDP-T3-INC");
  await putDraft("BRDP-T3-INC", rule("BRDP-T3-INC", "//table"));
  await makeBrdp("BRDP-T3-DOC");
  await putDraft("BRDP-T3-DOC", rule("BRDP-T3-DOC", "document('common.xml')//emphasis"));
  await makeBrdp("BRDP-T3-SUG");
  await makeBrdp("BRDP-T3-REGEN");
  // Suggest Rule needs the BRDPs embedded.
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 80; i++) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  // History starts collapsed ("Historial desplegable"); this script reads
  // its entries, so it opens it with a click on each page load.
  await openHistoryOnEachLoad(page);
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const indicator = () => page.getByTestId("rule-test-indicator");
  const dialog = () => page.getByTestId("verify-warning-dialog");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const language = () => page.locator("header select, nav select").first();
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await indicator().waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  async function waitIndicator(state) {
    await page.waitForFunction((s) => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === s, state, { timeout: 15000 });
  }
  async function historyEntries() {
    return page.locator('[class*="historyItem"]').allTextContents();
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

    // 1. A passed test: recorded, indicator, History.
    await select("BRDP-T3-GOOD");
    assert((await indicator().textContent()) === "Not tested", `never tested: "${await indicator().textContent()}"`);
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    await waitIndicator("passed");
    const today = new Date().toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
    assert((await indicator().textContent()) === `Tested ✓ (${today})`, `after the test: "${await indicator().textContent()}"`);
    let a = await approvalOf("BRDP-T3-GOOD");
    assert(a.last_test_result === "passed" && a.last_test_up_to_date === true, `API: passed and up to date (${a.last_test_result}, ${a.last_test_up_to_date})`);
    await page.waitForTimeout(500);
    let history = await historyEntries();
    assert(history.some((h) => h.includes("Rule test") && h.includes("Not tested") && h.includes("Passed")), `History: Rule test Not tested → Passed (${history.find((h) => h.includes("Rule test"))})`);
    await page.locator('[class*="ruleStatusRow"]').first().screenshot({ path: "/tmp/rule-test-indicator-passed.png" });

    // 2. "Run again" on an edited example never changes the recorded result.
    const recordedAt = a.last_test_at;
    await page.getByTestId("rule-test-example-0").getByRole("button", { name: "Edit" }).click();
    await page.getByTestId("rule-test-example-0").locator("textarea").fill("Torque the <emphasis>bolts</emphasis>.");
    await page.getByTestId("rule-test-example-0").getByRole("button", { name: "Run again" }).click();
    await page.waitForTimeout(800);
    assert((await verdict().textContent()).startsWith("The rule rejected an example meant to comply"), "Run again: the panel verdict changes");
    a = await approvalOf("BRDP-T3-GOOD");
    assert(a.last_test_result === "passed" && a.last_test_at === recordedAt, "Run again: the recorded result is unchanged");

    // 3. Test, edit the rule, reopen it → "Test outdated"; Verify warns.
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator('textarea[class*="ruleTextarea"]').first();
    await editor.fill(rule("BRDP-T3-GOOD", "//emphasis").replace("Rule BRDP-T3-GOOD.", "No emphasis anywhere."));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(800);
    await select("BRDP-T3-FAIL");
    await select("BRDP-T3-GOOD");
    assert((await indicator().textContent()) === "Test outdated", `edited after the test: "${await indicator().textContent()}"`);
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().waitFor({ timeout: 3000 });
    assert((await dialog().getAttribute("data-kind")) === "outdated", "Verify with an outdated test: dialog");
    assert((await dialog().textContent()).includes("The rule changed after it was last tested"), "dialog: outdated message");
    // "Test now" opens the Test rule panel on the saved rule.
    await dialog().getByRole("button", { name: "Test now" }).click();
    await verdict().waitFor({ timeout: 15000 });
    await waitIndicator("passed");
    assert(true, "Test now: the panel ran and the test is recorded again");

    // 4. Verify with a passed, up-to-date test: no dialog.
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await page.waitForTimeout(1200);
    assert((await dialog().count()) === 0, "passed and up to date: no dialog");
    a = await approvalOf("BRDP-T3-GOOD");
    assert(a.status === "approved", "passed and up to date: verified directly");

    // 5. A failed test: dialog with the reason; Cancel keeps Draft; Verify anyway works.
    await select("BRDP-T3-FAIL");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    await waitIndicator("failed");
    assert((await indicator().textContent()) === "Test failed", `failed: "${await indicator().textContent()}"`);
    assert(
      (await indicator().getAttribute("title")).includes("failed: the rule accepted an example meant to violate it"),
      `failed indicator title carries the reason (${await indicator().getAttribute("title")})`
    );
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().waitFor({ timeout: 3000 });
    const failedText = await dialog().textContent();
    assert(failedText.includes("The last test failed: the rule accepted an example meant to violate it."), `dialog: failed reason (${failedText})`);
    const buttons = await dialog().getByRole("button").allTextContents();
    assert(buttons.join("|") === "Test now|Verify anyway|Cancel", `dialog buttons: ${buttons.join(" | ")}`);
    await dialog().screenshot({ path: "/tmp/rule-test-verify-dialog-failed.png" });
    await dialog().getByRole("button", { name: "Cancel" }).click();
    assert((await approvalOf("BRDP-T3-FAIL")).status === "pending_review", "Cancel: still Draft");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().getByRole("button", { name: "Verify anyway" }).click();
    await page.waitForTimeout(1000);
    assert((await approvalOf("BRDP-T3-FAIL")).status === "approved", "Verify anyway: verified (warn, never block)");

    // 6. An inconclusive test.
    await select("BRDP-T3-INC");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    await waitIndicator("inconclusive");
    assert((await indicator().textContent()) === "Inconclusive", "inconclusive indicator");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().waitFor({ timeout: 3000 });
    assert((await dialog().textContent()).includes("The last test was inconclusive: the rule's path selected nothing in any example."), "dialog: inconclusive reason");
    await dialog().getByRole("button", { name: "Cancel" }).click();

    // 7. A non-executable rule never tested: the dialog explains why, in the
    //    interface language, with no "Test now".
    await select("BRDP-T3-DOC");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await dialog().waitFor({ timeout: 3000 });
    assert((await dialog().getAttribute("data-kind")) === "not_executable", "document(): not_executable dialog without any test");
    assert(
      (await dialog().textContent()).includes("This rule could not be tested: The rule reads another file (document()), which is not available in a test."),
      `document() dialog in English (${await dialog().textContent()})`
    );
    assert((await dialog().getByRole("button").allTextContents()).join("|") === "Verify anyway|Cancel", "document(): only Verify anyway / Cancel");
    await language().selectOption("es");
    await page.waitForTimeout(300);
    assert(
      (await dialog().textContent()).includes("Esta regla no se pudo probar: La regla lee otro fichero (document()), que no está disponible en una prueba."),
      `document() dialog in Spanish (${await dialog().textContent()})`
    );
    await dialog().screenshot({ path: "/tmp/rule-test-verify-dialog-document-es.png" });
    await dialog().getByRole("button", { name: "Cancelar" }).click();
    // Opening Test rule records "not executable" at once, with no LLM call.
    await page.getByRole("button", { name: "Probar regla" }).click();
    await waitIndicator("not_executable");
    const lastReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    assert(lastReq === null, "document(): recorded without calling the LLM");
    assert(
      (await indicator().textContent()) === "No ejecutable: La regla lee otro fichero (document()), que no está disponible en una prueba.",
      `indicator in Spanish (${await indicator().textContent()})`
    );
    await page.waitForTimeout(500);
    history = await historyEntries();
    const esEntry = history.find((h) => h.includes("Prueba de la regla"));
    assert(esEntry && esEntry.includes("Sin probar") && esEntry.includes("No ejecutable: La regla lee otro fichero"), `History in Spanish (${esEntry})`);
    // Switching the interface to English changes the recorded reason's text too.
    await language().selectOption("en");
    await page.waitForTimeout(300);
    assert(
      (await indicator().textContent()) === "Not executable: The rule reads another file (document()), which is not available in a test.",
      `indicator back in English (${await indicator().textContent()})`
    );
    history = await historyEntries();
    const enEntry = history.find((h) => h.includes("Rule test"));
    assert(enEntry && enEntry.includes("Not executable: The rule reads another file (document())"), `History in English (${enEntry})`);
    a = await approvalOf("BRDP-T3-DOC");
    assert(a.last_test_result === "not_executable" && a.last_test_reason.code === "external_document", "API: the reason is stored as a code");
    await page.locator('[class*="ruleStatusRow"]').first().screenshot({ path: "/tmp/rule-test-indicator-not-executable.png" });

    // 8. Test a suggestion, then accept it → recorded as tested.
    await select("BRDP-T3-SUG");
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    await page.getByRole("button", { name: "Discard" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    assert((await verdict().textContent()).startsWith("Correct"), "suggestion: test passed");
    assert((await approvalOf("BRDP-T3-SUG")) === null, "suggestion: nothing saved or recorded before Accept");
    await page.getByRole("button", { name: "Accept" }).click();
    await waitIndicator("passed");
    a = await approvalOf("BRDP-T3-SUG");
    assert(a.last_test_result === "passed" && a.last_test_up_to_date === true && a.source === "llm", "accepted suggestion: recorded as tested");

    // 9. Test it, regenerate, accept the new one → "Not tested".
    await select("BRDP-T3-REGEN");
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    await page.getByRole("button", { name: "Discard" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Discard" }).click();
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    await page.getByRole("button", { name: "Accept" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Accept" }).click();
    await indicator().waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    assert((await indicator().textContent()) === "Not tested", `regenerated then accepted: "${await indicator().textContent()}"`);
    a = await approvalOf("BRDP-T3-REGEN");
    assert(a.last_test_result === null, "regenerated then accepted: nothing recorded");
  } finally {
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
    console.log("Cleaned up the seeded project.");
    await browser.close();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
