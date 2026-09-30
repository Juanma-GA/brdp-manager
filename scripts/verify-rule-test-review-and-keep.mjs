// Live verification for "Test de reglas: resultado 'Revisar', no
// sobrescribir una prueba aprobada sin preguntar, Historial desplegable".
//  1. "at most three substeps" tested against //proceduralStep[count(
//     proceduralStep) = 1]: the examples pass but the LLM says the rule does
//     not implement the Proposal -- amber "Review" verdict, recorded as
//     "review": amber indicator, amber History label, Verify warns.
//  2. S1-00187 (the same rule, the Proposal it implements): "Tested ✓".
//     Regenerate → passed again: no question.
//  3. Regenerate with the examples swapped (mock /invert-next) → failed:
//     the question; "Keep the previous one" keeps the indicator and notes
//     the attempt in History as not recorded.
//  4. Again, in Spanish: "Registrar este resultado" → "Prueba fallida".
//  5. History is collapsed: "History (N)" with the latest date; expands on
//     click; long entries show "Show more"; the state is kept when another
//     BRDP is selected.
// Real Postgres + Vite; the LLM transport is the mock (8902). Cleans up.
import { chromium } from "playwright-core";
import os from "node:os";
import path from "node:path";

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
  '<structureObjectRule id="BRDP-S1-00187"><objectPath allowedObjectFlag="0">//proceduralStep[count(proceduralStep) = 1]</objectPath><objectUse>A step must not have a single substep.</objectUse></structureObjectRule>';
const AMBER = "rgb(180, 83, 9)";

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Rule test review ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const makeBrdp = async (fields) => {
    const brdp = await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
    const put = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: RULE.replace("BRDP-S1-00187", fields.identifier), source: "manual", status: "pending_review" }),
    });
    if (!put.ok) throw new Error(`seeding rule failed: ${put.status} ${await put.text()}`);
    return brdp;
  };
  const review = await makeBrdp({
    identifier: "BRDP-REV-001",
    title: "Number of substeps in a step",
    definition: "Decide how many sub-steps a procedural step may have.",
    proposal: "A step shall have at most three substeps.",
  });
  const passed = await makeBrdp({
    identifier: "BRDP-S1-00187",
    title: "Minimum number of substeps in a step",
    definition: "Decide the minimum number of sub-steps of a procedural step.",
    proposal: "A minimum of two sub-steps is required.",
  });
  const approval = (b) => api(`/api/projects/${project.id}/brdps/${b.id}/approvals/BREX-4.2`).then((r) => r.json());
  const ruleTestHistory = async (b) =>
    (await api(`/api/projects/${project.id}/brdps/${b.id}/history`).then((r) => r.json())).filter((h) => h.field_name === "rule_test");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const verdict = () => page.getByTestId("rule-test-verdict");
  const indicator = () => page.getByTestId("rule-test-indicator");
  const question = () => page.getByTestId("rule-test-replace-question");
  const language = () => page.locator("header select, nav select").first();
  const color = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
  const select = async (identifier) => {
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
  };
  // Part 3 collapses History: open it (once; the state is kept).
  const openHistory = async () => {
    const toggle = page.getByTestId("history-toggle");
    if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  };
  const settle = (ms = 900) => page.waitForTimeout(ms);
  const regenerate = async () => {
    await page.getByRole("button", { name: /^(Regenerate examples|Regenerar ejemplos)$/ }).click();
    await settle(300);
    await verdict().waitFor({ timeout: 20000 });
    await settle();
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
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});

    // 1. "Review".
    await select("BRDP-REV-001");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    await settle();
    const vText = (await verdict().textContent()) || "";
    assert((await verdict().getAttribute("data-kind")) === "review", `verdict is review (${vText})`);
    assert(vText.startsWith("Review: the examples pass, but the rule does not seem to implement the Proposal.") && vText.includes("at most three substeps"), "verdict text with the mismatch");
    assert((await color(verdict())) === AMBER, "verdict in amber");
    const rev = await approval(review);
    assert(rev.last_test_result === "review" && rev.last_test_reason?.code === "test_proposal_mismatch", `recorded as review (${rev.last_test_result})`);
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "review", null, { timeout: 10000 });
    assert((await indicator().textContent()) === "Review", "indicator: Review");
    assert((await color(indicator())) === AMBER, "indicator in amber");
    assert(((await indicator().getAttribute("title")) || "").includes("does not seem to implement the Proposal"), "indicator title: the reason");
    await openHistory();
    const tag = page.getByTestId("history-rule-test-review").first();
    await tag.waitFor({ timeout: 5000 });
    assert(((await tag.textContent()) || "").startsWith("Review: the examples pass"), `History: ${await tag.textContent()}`);
    assert((await color(tag)) === AMBER, "History label in amber");
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-review-verdict.png") });
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    const dialog = page.getByTestId("verify-warning-dialog");
    await dialog.waitFor({ timeout: 5000 });
    assert((await dialog.getAttribute("data-kind")) === "review", "Verify: review warning");
    assert(((await dialog.textContent()) || "").includes("The last test needs review: the examples pass"), "Verify text");
    assert((await dialog.getByRole("button", { name: "Test now" }).count()) === 1 && (await dialog.getByRole("button", { name: "Verify anyway" }).count()) === 1, "Verify: Test now and Verify anyway (never a block)");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // 2. S1-00187: passed; regenerate → passed again, no question.
    await select("BRDP-S1-00187");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    await settle();
    assert(((await verdict().textContent()) || "").startsWith("Correct"), "S1-00187: Correct");
    const p1 = await approval(passed);
    assert(p1.last_test_result === "passed", "S1-00187: recorded as passed");
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "passed", null, { timeout: 10000 });
    assert(((await indicator().textContent()) || "").startsWith("Tested ✓"), "S1-00187: Tested ✓");
    await regenerate();
    assert((await question().count()) === 0, "passed → passed: no question");
    const p2 = await approval(passed);
    assert(p2.last_test_result === "passed" && p2.last_test_at !== p1.last_test_at && (await ruleTestHistory(passed)).length === 2, "passed → passed: recorded without asking");

    // 3. Regenerate → failed: the question; Keep the previous one.
    await fetch(`${MOCK}/invert-next`, { method: "POST" });
    await regenerate();
    assert(((await verdict().textContent()) || "").startsWith("The rule"), `failed verdict (${await verdict().textContent()})`);
    await question().waitFor({ timeout: 5000 });
    assert(/^The previous test passed on .+\. Record this result and replace it\?/.test((await question().textContent()) || ""), `question: ${await question().textContent()}`);
    assert((await approval(passed)).last_test_at === p2.last_test_at && (await ruleTestHistory(passed)).length === 2, "nothing recorded before answering");
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-replace-question.png") });
    await question().getByRole("button", { name: "Keep the previous one" }).click();
    await settle();
    assert((await question().count()) === 0, "Keep: the question goes");
    assert(/^Not recorded: the test that passed on .+ was kept\.$/.test((await page.getByTestId("rule-test-replace-kept").textContent()) || ""), "Keep: note in the panel");
    const p3 = await approval(passed);
    assert(p3.last_test_result === "passed" && p3.last_test_at === p2.last_test_at, "Keep: the passed test stays");
    assert(((await indicator().textContent()) || "").startsWith("Tested ✓"), "Keep: indicator unchanged");
    const hist3 = await ruleTestHistory(passed);
    assert(hist3.length === 3 && JSON.parse(hist3.sort((a, b) => a.changed_at.localeCompare(b.changed_at))[2].new_value).not_recorded === true, "Keep: History notes the attempt");
    await page.waitForFunction(() => document.body.textContent.includes("not recorded (the test of"), null, { timeout: 10000 });
    const keptItem = page.locator("li", { hasText: "not recorded (the test of" }).first();
    assert(/^Failed: .+ — not recorded \(the test of .+ was kept\)$/.test(((await keptItem.locator('[class*="historyNew"]').textContent()) || "").trim()), `History text: ${await keptItem.locator('[class*="historyNew"]').textContent()}`);

    // 4. Again in Spanish: "Registrar este resultado".
    await language().selectOption("es");
    await settle(400);
    await fetch(`${MOCK}/invert-next`, { method: "POST" });
    await regenerate();
    await question().waitFor({ timeout: 5000 });
    assert(/^La prueba anterior salió correcta el .+\. ¿Registrar este resultado y sustituirla\?/.test((await question().textContent()) || ""), `pregunta: ${await question().textContent()}`);
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-replace-question-es.png") });
    await question().getByRole("button", { name: "Registrar este resultado" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === "failed", null, { timeout: 10000 });
    assert((await indicator().textContent()) === "Prueba fallida", "Registrar: Prueba fallida");
    assert((await approval(passed)).last_test_result === "failed" && (await ruleTestHistory(passed)).length === 4, "Registrar: recorded as failed");
    await language().selectOption("en");
    await settle(400);
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
