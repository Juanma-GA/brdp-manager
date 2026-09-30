// Live verification for "Test de reglas: registrar la prueba corregida con
// ejemplos editados" -- S1-00507, //randomList//randomList.
//  1. The generation writes the "nested" list as two sibling lists (the real
//     failure; the mock keeps it so after the correction round): recorded
//     as not passed (inconclusive: the rule selects nothing).
//  2. An edit that leaves it not correct: nothing recorded, "not saved".
//  3. Editing it to a really nested list: recorded ONCE as passed with 1
//     example edited by hand -- notice, indicator (EN/ES), History entry
//     with the edited XML, approval.last_test_edited_examples.
//  4. More edits (correct or not): nothing more recorded.
//  5. Verify: the warning says the last test includes 1 example edited by
//     hand; Cancel keeps the rule Draft.
//  6. Regenerate: a normal record, with no edit mark.
// Against the real app (Vite + FastAPI + Postgres); only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs, marker SIBLINGLISTS).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902,
// the chat mock running, Vite on 5173. Cleans up the project it creates.
//
//     node scripts/verify-rule-test-edited-record.mjs
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const SHOTS = os.tmpdir();

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures += 1;
    console.log(`  FAIL ${msg}`);
  }
}

const RULE =
  '<structureObjectRule id="BRDP-S1-00507"><objectPath allowedObjectFlag="0">//randomList//randomList</objectPath><objectUse>Random lists must not be nested.</objectUse></structureObjectRule>';
const SIBLINGS =
  "<randomList><listItem><para>Remove the access panel.</para></listItem></randomList><randomList><listItem><para>Remove the screws.</para></listItem></randomList>";
const NESTED =
  "<randomList><listItem><para>Remove the access panel.<randomList><listItem><para>Remove the screws.</para></listItem></randomList></para></listItem></randomList>";
const NESTED_2 =
  "<randomList><listItem><para>Open the panel.<randomList><listItem><para>Remove the four screws.</para></listItem></randomList></para></listItem></randomList>";
const RECORDED_EN = "Recorded as tested with 1 example edited by hand.";
const NOT_SAVED_EN = "This result includes examples edited by hand and is not saved. Regenerate the examples to record a test.";

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Rule test edited ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const brdp = await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({
      identifier: "BRDP-S1-00507",
      title: "Nested random lists",
      definition: "Decide whether a random list may contain another random list.",
      proposal: "Random lists shall not be nested. SIBLINGLISTS",
      validation: "Validated",
    }),
  }).then((r) => r.json());
  const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: RULE, source: "manual", status: "pending_review" }),
  });
  if (!put.ok) throw new Error(`seeding rule failed: ${put.status} ${await put.text()}`);
  const approval = () => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`).then((r) => r.json());
  const ruleTestHistory = async () =>
    (await api(`/api/projects/${project.id}/brdps/${brdp.id}/history`).then((r) => r.json())).filter((h) => h.field_name === "rule_test");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const verdict = () => page.getByTestId("rule-test-verdict");
  const notice = () => page.getByTestId("rule-test-edited-notice");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  const indicator = () => page.getByTestId("rule-test-indicator");
  const language = () => page.locator("header select, nav select").first();
  const editAndRun = async (i, content) => {
    await example(i).getByRole("button", { name: /^(Edit|Editar)$/ }).click();
    await example(i).locator("textarea").first().fill(content);
    await example(i).getByRole("button", { name: /^(Run again|Ejecutar de nuevo)$/ }).click();
    await page.waitForTimeout(900);
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-S1-00507" }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

    // 1. The generation: sibling lists, not passed.
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    const first = await approval();
    assert(first.last_test_result && first.last_test_result !== "passed", `generation recorded as not passed (${first.last_test_result})`);
    assert(!first.last_test_edited_examples, "no edited examples recorded by the generation");
    assert((await example(1).textContent()).includes("Remove the screws"), "reject example written by the generation");
    assert((await ruleTestHistory()).length === 1, "History: one rule test entry");

    // 2. An edit that is still not correct: nothing recorded.
    await editAndRun(1, SIBLINGS.replace("Remove the screws.", "Remove the two screws."));
    assert(!(await verdict().textContent()).startsWith("Correct"), `still not correct (${await verdict().textContent()})`);
    assert((await notice().textContent()) === NOT_SAVED_EN, "notice: not saved");
    assert((await ruleTestHistory()).length === 1 && (await approval()).last_test_result === first.last_test_result, "still failing: nothing recorded");

    // 3. Edited to really nested lists: recorded once.
    await editAndRun(1, NESTED);
    assert((await verdict().textContent()).startsWith("Correct"), `edited → correct (${await verdict().textContent()})`);
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-edited-notice"]')?.dataset.kind === "recorded", null, { timeout: 10000 });
    assert((await notice().textContent()) === RECORDED_EN, `notice: ${await notice().textContent()}`);
    assert((await example(1).getByTestId("rule-test-edited-mark").textContent()) === "Edited", "the edited example keeps its Edited mark");
    const rec = await approval();
    assert(rec.last_test_result === "passed" && rec.last_test_up_to_date === true, "recorded as passed and up to date");
    assert(rec.last_test_edited_examples?.length === 1, `one edited example recorded (${rec.last_test_edited_examples?.length})`);
    assert(rec.last_test_edited_examples?.[0].label === "List inside a list", "its label");
    assert(rec.last_test_edited_examples?.[0].xml.includes(NESTED), "its XML as run (skeleton + the edited content)");
    const hist = await ruleTestHistory();
    assert(hist.length === 2, `History: a second rule test entry (${hist.length})`);
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 10000 });
    const indText = (await indicator().textContent()) || "";
    assert(/^Tested ✓ \(.+\) · 1 example edited by hand$/.test(indText), `indicator: ${indText}`);
    assert((await indicator().getAttribute("class")).includes("ruleTestToneOk"), "indicator green like Tested");
    // History: the text and the edited XML.
    const histItem = page.locator("li", { has: page.getByTestId("history-edited-examples") }).first();
    assert((await histItem.textContent()).includes("Passed with 1 example edited by hand"), "History: Passed with 1 example edited by hand");
    const details = histItem.getByTestId("history-edited-examples");
    assert(!(await details.locator("pre").isVisible()), "History: the XML is collapsed");
    await details.locator("summary").click();
    const pre = (await details.locator("pre").textContent()) || "";
    assert(pre.includes("Remove the screws.</para></listItem></randomList></para>"), "History: shows the edited XML");
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-edited-recorded.png") });
    await histItem.screenshot({ path: path.join(SHOTS, "rule-test-edited-history.png") });

    // 4. More edits in the same generation: nothing more recorded.
    await editAndRun(1, NESTED_2);
    assert((await verdict().textContent()).startsWith("Correct"), "a further correct edit");
    await editAndRun(1, SIBLINGS.replace("Remove the access panel.", "Open the access panel."));
    assert(!(await verdict().textContent()).startsWith("Correct"), "a further failing edit");
    assert((await notice().textContent()) === NOT_SAVED_EN, "notice after further edits: not saved");
    const after = await approval();
    assert((await ruleTestHistory()).length === 2 && after.last_test_at === rec.last_test_at && after.last_test_edited_examples[0].xml === rec.last_test_edited_examples[0].xml, "further edits: nothing more recorded");

    // Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(500);
    const indEs = (await indicator().textContent()) || "";
    assert(/^Probada ✓ \(.+\) · 1 ejemplo editado a mano$/.test(indEs), `indicator (ES): ${indEs}`);
    assert((await page.locator("li", { has: page.getByTestId("history-edited-examples") }).first().textContent()).includes("Probada con 1 ejemplo editado a mano"), "History (ES)");

    // 5. Verify: the warning mentions the edited example.
    await page.getByRole("button", { name: "Verificar", exact: true }).click();
    const dialog = page.getByTestId("verify-warning-dialog");
    await dialog.waitFor({ timeout: 5000 });
    assert((await dialog.getAttribute("data-kind")) === "passed_edited", "Verify: passed_edited warning");
    assert((await dialog.textContent()).includes("El último test incluye 1 ejemplo editado a mano"), `Verify text (ES): ${await dialog.textContent()}`);
    await dialog.screenshot({ path: path.join(SHOTS, "rule-test-edited-verify-es.png") });
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    assert((await approval()).status === "pending_review", "Cancel keeps the rule Draft");
    await language().selectOption("en");
    await page.waitForTimeout(400);

    // 6. Regenerate: a normal record, no edit mark.
    if (!(await page.getByTestId("rule-test-panel").isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Test rule" }).click();
      await verdict().waitFor({ timeout: 20000 });
    } else {
      await page.getByRole("button", { name: "Regenerate examples" }).click();
      await page.waitForTimeout(300);
      await verdict().waitFor({ timeout: 20000 });
    }
    await page.waitForTimeout(900);
    const regen = await approval();
    assert(regen.last_test_result !== "passed" && !regen.last_test_edited_examples, `regenerate: normal record without edits (${regen.last_test_result})`);
    assert((await notice().count()) === 0 && (await page.getByTestId("rule-test-edited-mark").count()) === 0, "regenerate: no notice, no marks");
    assert(!((await indicator().textContent()) || "").includes("edited"), "indicator without the edited mention");
    assert((await ruleTestHistory()).length === 3, "History: a third rule test entry");
  } finally {
    await api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
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
