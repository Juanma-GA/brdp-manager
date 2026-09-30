// Live verification for "Pendientes del test de reglas":
//  Part 1: //randomList//randomList (S1-00507). The prompt gives the valid
//          nesting randomList/listItem/para/randomList; the mock's first
//          answer puts a <randomList> straight inside another one (invalid,
//          as in the real run), and the correction request carries the path
//          and "Keep the nesting", so the corrected reject example is nested,
//          valid and rejected ✓ -- verdict correct, recorded as passed.
//  Part 3: editing an example and pressing "Run again" shows the "edited by
//          hand, not saved" notice next to the verdict and an "Edited" mark
//          on that example (EN and ES); the recorded result, the indicator
//          and History do not change. "Regenerate examples" clears both.
// Against the real app (Vite + FastAPI + Postgres); only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902,
// the chat mock running, Vite on 5173. Cleans up the project it creates.
//
//     node scripts/verify-rule-test-nesting-and-edits.mjs
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
const EN_NOTICE = "This result includes examples edited by hand and is not saved. Regenerate the examples to record a test.";
const ES_NOTICE = "Este resultado incluye ejemplos editados a mano y no se guarda. Regenera los ejemplos para registrar un test.";

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Rule test nesting ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const brdp = await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({
      identifier: "BRDP-S1-00507",
      title: "Nested random lists",
      definition: "Decide whether a random list may contain another random list.",
      proposal: "Random lists shall not be nested.",
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
    (await api(`/api/projects/${project.id}/brdps/${brdp.id}/history`).then((r) => r.json())).filter((h) => h.field_name === "rule_test").length;

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const verdict = () => page.getByTestId("rule-test-verdict");
  const notice = () => page.getByTestId("rule-test-edited-notice");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  const indicator = () => page.getByTestId("rule-test-indicator");
  const language = () => page.locator("header select, nav select").first();

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

    // Part 1.
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    const req = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    const system = req.messages.find((m) => m.role === "system")?.content || "";
    const nonSystem = req.messages.filter((m) => m.role !== "system");
    assert(system.includes("To put <randomList> inside <randomList>, the valid nesting is: randomList/listItem/para/randomList."), "prompt gives the valid nesting");
    assert(nonSystem.length === 3, "one correction round");
    const correction = nonSystem[2]?.content || "";
    assert(
      correction.includes("<randomList> is not allowed inside <randomList>. To put <randomList> inside <randomList>, the valid nesting is: randomList/listItem/para/randomList. Keep the nesting — do not move <randomList> outside <randomList>."),
      "correction request: path and keep the nesting"
    );
    assert((await verdict().textContent()).startsWith("Correct"), `verdict correct (${await verdict().textContent()})`);
    const result1 = (await example(1).getByTestId("rule-test-result").textContent()) || "";
    assert(result1.includes("rejected") && result1.includes("✓"), `reject example: rejected ✓ (${result1})`);
    assert((await example(1).textContent()).includes("listItem"), "the reject example is nested through listItem");
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 15000 });
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-nesting-correct.png") });
    const recorded = await approval();
    assert(recorded.last_test_result === "passed", "recorded as passed");
    const historyBefore = await ruleTestHistory();
    assert(historyBefore === 1, `History: one rule test entry (${historyBefore})`);
    assert((await notice().count()) === 0 && (await page.getByTestId("rule-test-edited-mark").count()) === 0, "no notice and no mark before any edit");

    // Part 3: edit the reject example and run it again.
    await example(1).getByRole("button", { name: "Edit" }).click();
    await example(1).locator("textarea").first().fill("<randomList><listItem><para>Remove the access panel.</para></listItem></randomList>");
    await example(1).getByRole("button", { name: "Run again" }).click();
    await notice().waitFor({ timeout: 5000 });
    assert((await notice().textContent()) === EN_NOTICE, `notice (EN): ${await notice().textContent()}`);
    assert((await example(1).getByTestId("rule-test-edited-mark").textContent()) === "Edited", "example 2 marked Edited");
    assert((await example(0).getByTestId("rule-test-edited-mark").count()) === 0, "example 1 not marked");
    assert(!(await verdict().textContent()).startsWith("Correct"), `panel verdict changes (${await verdict().textContent()})`);
    await page.waitForTimeout(800);
    const after = await approval();
    assert(after.last_test_result === "passed" && after.last_test_at === recorded.last_test_at, "recorded result unchanged");
    assert((await indicator().getAttribute("data-state")) === "passed", "indicator unchanged");
    assert((await ruleTestHistory()) === historyBefore, "History unchanged");
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-edited-notice-en.png") });

    // Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(400);
    assert((await notice().textContent()) === ES_NOTICE, `notice (ES): ${await notice().textContent()}`);
    assert((await example(1).getByTestId("rule-test-edited-mark").textContent()) === "Editado", "mark (ES): Editado");
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-edited-notice-es.png") });
    await language().selectOption("en");
    await page.waitForTimeout(400);

    // Regenerate: notice and marks gone.
    await page.getByRole("button", { name: "Regenerate examples" }).click();
    await page.waitForTimeout(300);
    await verdict().waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    assert((await notice().count()) === 0, "Regenerate: notice gone");
    assert((await page.getByTestId("rule-test-edited-mark").count()) === 0, "Regenerate: marks gone");
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
