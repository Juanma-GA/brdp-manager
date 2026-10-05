// Live verification for "Test de reglas: guardar la prueba aprobada, volver
// a probar con sus ejemplos, y mensaje de fallo según la causa" (+ Part 4,
// answers cut by the token limit).
//  1. S1-00187 passes → "See approved test (<date>)" shows its examples and
//     the rule it was tested with.
//  2. The rule changed to count(proceduralStep) >= 2 → "Test with the saved
//     examples": no LLM call, the accept example changes result, the
//     question before replacing the passed test ("Keep" and "Record").
//  3. Back to the original rule → "Tested ✓ (examples from the test of
//     <date>)" without calling the LLM.
//  4. The Proposal changed → the saved panel warns.
//  5. A rule whose only test failed has no button; the failure messages by
//     cause (rule / examples), in English and Spanish.
//  6. A cut answer (mock /truncate-next) says so, not "not valid JSON"; the
//     rule test asks for RULE_TEST_MAX_TOKENS.
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
const RULE_GE2 = RULE.replace("= 1]", "&gt;= 2]");

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Saved rule test ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const putRule = async (b, ruleXml) => {
    const put = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: ruleXml.replace("BRDP-S1-00187", b.identifier), source: "manual", status: "pending_review" }),
    });
    if (!put.ok) throw new Error(`rule PUT failed: ${put.status} ${await put.text()}`);
  };
  const makeBrdp = async (fields) => {
    const brdp = await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
    await putRule(brdp, RULE);
    return brdp;
  };
  const base = {
    title: "Minimum number of substeps in a step",
    definition: "Decide the minimum number of sub-steps of a procedural step.",
    proposal: "A minimum of two sub-steps is required.",
  };
  const s187 = await makeBrdp({ identifier: "BRDP-S1-00187", ...base });
  const failedOnly = await makeBrdp({ identifier: "BRDP-SAV-FAIL", ...base });
  await makeBrdp({ identifier: "BRDP-SAV-INVALID", ...base, proposal: "A minimum of two sub-steps is required. ALLINVALID" });
  await makeBrdp({ identifier: "BRDP-SAV-CUT", ...base });
  const approval = (b) => api(`/api/projects/${project.id}/brdps/${b.id}/approvals/BREX-4.2`).then((r) => r.json());
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const reset = () => fetch(`${MOCK}/reset`, { method: "POST" });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const verdict = () => page.getByTestId("rule-test-verdict");
  const indicator = () => page.getByTestId("rule-test-indicator");
  const savedPanel = () => page.getByTestId("saved-rule-test-panel");
  const openSaved = () => page.getByTestId("saved-rule-test-open");
  const question = () => page.getByTestId("rule-test-replace-question");
  const language = () => page.locator("header select, nav select").first();
  const settle = (ms = 900) => page.waitForTimeout(ms);
  const select = async (identifier) => {
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await settle(400);
  };
  const reload = async () => {
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  };
  const testRule = async () => {
    await page.getByRole("button", { name: /^(Test rule|Probar regla)$/ }).click();
    await settle(300);
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await reload();
    await reset();

    // 1. S1-00187 passes; its test is kept with the examples.
    await select("BRDP-S1-00187");
    assert((await openSaved().count()) === 0, "no approved test yet: no button");
    await testRule();
    await verdict().waitFor({ timeout: 20000 });
    await settle();
    assert(((await verdict().textContent()) || "").startsWith("Correct"), "S1-00187: Correct");
    assert((await page.getByTestId("rule-test-cause").count()) === 0, "Correct: no cause message");
    const a1 = await approval(s187);
    const kept = a1.last_passed_test;
    assert(a1.last_test_result === "passed" && kept && kept.examples.length >= 2 && kept.rule_xml.includes("count(proceduralStep) = 1"), `kept with ${kept?.examples?.length} examples and the rule`);
    assert(kept.examples.every((e) => e.xml.startsWith("<dmodule") && ["accepted", "rejected"].includes(e.result) && e.matches === true), "each example: the whole document and its result");
    await page.getByRole("button", { name: /^(Close|Cerrar)$/ }).first().click();
    await openSaved().waitFor({ timeout: 10000 });
    assert(/^See approved test \(.+\)$/.test((await openSaved().textContent()) || ""), `button: ${await openSaved().textContent()}`);
    await openSaved().click();
    await savedPanel().waitFor({ timeout: 5000 });
    assert(((await page.getByTestId("saved-rule-test-rule").textContent()) || "").includes("count(proceduralStep) = 1"), "the rule it was tested with");
    assert((await page.locator('[data-testid^="saved-rule-test-example-"]').count()) === kept.examples.length, "every kept example shown");
    assert((await savedPanel().getByRole("button", { name: /^Edit$/ }).count()) === 0, "read-only: no Edit");
    assert((await savedPanel().getByTestId("rule-test-result").count()) === kept.examples.length, "the result of each example");
    assert((await page.getByTestId("saved-rule-test-rule-changed").count()) === 0 && (await page.getByTestId("saved-rule-test-proposal-changed").count()) === 0, "no change warnings");
    await savedPanel().screenshot({ path: path.join(SHOTS, "rule-test-saved-view.png") });

    // 2. The rule changes: rerun on the saved examples, no LLM.
    await putRule(s187, RULE_GE2);
    await reload();
    await select("BRDP-S1-00187");
    await openSaved().click();
    await savedPanel().waitFor({ timeout: 5000 });
    assert((await page.getByTestId("saved-rule-test-rule-changed").count()) === 1, "rule changed: 'tested with an earlier version'");
    await reset();
    await page.getByTestId("saved-rule-test-rerun").click();
    await page.getByTestId("saved-rule-test-verdict").waitFor({ timeout: 5000 });
    await settle(300);
    assert((await lastRequest()) === null, "rerun: no LLM call");
    assert((await page.getByTestId("saved-rule-test-verdict").getAttribute("data-kind")) === "incorrect", "rerun >= 2: incorrect");
    const acceptIndex = kept.examples.findIndex((e) => e.expected === "accept");
    assert((await page.getByTestId(`saved-rule-test-example-${acceptIndex}`).getByTestId("rule-test-result-changed").count()) === 1, "the accept example is marked as changing result");
    assert(/^Result changed: accepted in the approved test, rejected now\.$/.test(((await page.getByTestId(`saved-rule-test-example-${acceptIndex}`).getByTestId("rule-test-result-changed").textContent()) || "").trim()), "changed marker text");
    assert(((await page.getByTestId("saved-rule-test-changed-summary").textContent()) || "").includes("change result"), "summary of the examples that change");
    assert(((await savedPanel().getByTestId("rule-test-cause").textContent()) || "").includes("the problem is in the rule"), "cause: the rule (saved examples are valid)");
    await question().waitFor({ timeout: 5000 });
    assert(/^The previous test passed on .+\. Record this result and replace it\?/.test((await question().textContent()) || ""), "question before replacing the passed test");
    const beforeKeep = await approval(s187);
    await savedPanel().screenshot({ path: path.join(SHOTS, "rule-test-saved-rerun-question.png") });
    await question().getByRole("button", { name: "Keep the previous one" }).click();
    await settle();
    const afterKeep = await approval(s187);
    assert(afterKeep.last_test_result === "passed" && afterKeep.last_test_at === beforeKeep.last_test_at, "Keep: the passed test stays");
    assert((await page.getByTestId("rule-test-replace-kept").count()) === 1, "Keep: note in the panel");
    await page.getByTestId("saved-rule-test-rerun").click();
    await question().waitFor({ timeout: 5000 });
    await question().getByRole("button", { name: "Record this result" }).click();
    await page.getByTestId("saved-rule-test-recorded").waitFor({ timeout: 10000 });
    const afterRecord = await approval(s187);
    assert(afterRecord.last_test_result === "failed" && afterRecord.last_passed_test?.at === kept.at, "Record: failed, the approved test is kept");
    assert((await lastRequest()) === null, "still no LLM call");

    // 3. Back to the original rule: passes on the saved examples.
    await putRule(s187, RULE);
    await reload();
    await select("BRDP-S1-00187");
    await openSaved().click();
    await savedPanel().waitFor({ timeout: 5000 });
    await page.getByTestId("saved-rule-test-rerun").click();
    await page.getByTestId("saved-rule-test-recorded").waitFor({ timeout: 10000 });
    assert((await page.getByTestId("saved-rule-test-verdict").getAttribute("data-kind")) === "correct", "reverted: Correct");
    assert((await question().count()) === 0, "a pass never asks");
    assert((await lastRequest()) === null, "reverted: no LLM call");
    const back = await approval(s187);
    assert(back.last_test_result === "passed" && back.last_passed_test.examples_from?.slice(0, 19) === kept.at.slice(0, 19), "recorded as passed on the saved examples");
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.savedExamples === "true", null, { timeout: 10000 });
    assert(/^Tested ✓ \(examples from the test of .+\)$/.test((await indicator().textContent()) || ""), `indicator: ${await indicator().textContent()}`);
    await indicator().screenshot({ path: path.join(SHOTS, "rule-test-saved-indicator.png") });
    await language().selectOption("es");
    await settle(400);
    assert(/^Probada ✓ \(ejemplos de la prueba del .+\)$/.test((await indicator().textContent()) || ""), `indicador: ${await indicator().textContent()}`);
    assert((await page.getByTestId("saved-rule-test-rerun").textContent()) === "Probar con los ejemplos guardados", "botón en español");
    await language().selectOption("en");
    await settle(400);

    // 4. The Proposal changed: the saved panel warns.
    await api(`/api/projects/${project.id}/brdps/${s187.id}`, { method: "PUT", body: JSON.stringify({ proposal: "A minimum of three sub-steps is required." }) });
    await reload();
    await select("BRDP-S1-00187");
    await openSaved().click();
    await page.getByTestId("saved-rule-test-proposal-changed").waitFor({ timeout: 5000 });
    assert(((await page.getByTestId("saved-rule-test-proposal-changed").textContent()) || "").includes("written for the earlier Proposal"), "Proposal changed warning");

    // 5. Only a failed test: no button; the cause messages.
    await select("BRDP-SAV-FAIL");
    await fetch(`${MOCK}/invert-next`, { method: "POST" });
    await testRule();
    await verdict().waitFor({ timeout: 20000 });
    await settle();
    assert((await verdict().getAttribute("data-kind")) === "incorrect", "swapped examples: incorrect");
    const cause = page.getByTestId("rule-test-panel").getByTestId("rule-test-cause");
    assert((await cause.getAttribute("data-cause")) === "rule", "cause: the rule");
    assert(/^The rule (accepted an example it should have rejected|rejected an example it should have accepted)[^.]*\. Check (that example: if it is|those examples: if they are) right, the problem is in the rule\.$/.test((await cause.textContent()) || ""), `cause text: ${await cause.textContent()}`);
    assert((await page.getByTestId("rule-test-review").count()) === 1, "Review with the assistant at hand");
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-cause-rule.png") });
    assert((await approval(failedOnly)).last_test_result === "failed" && !(await approval(failedOnly)).last_passed_test, "failed only: no approved test kept");
    assert((await openSaved().count()) === 0, "failed only: no 'See approved test' button");
    await language().selectOption("es");
    await settle(400);
    assert(/^La regla (aceptó un ejemplo que debía rechazar|rechazó un ejemplo que debía aceptar)[^.]*\. Revisa (ese ejemplo: si es correcto|esos ejemplos: si son correctos), el problema está en la regla\.$/.test((await cause.textContent()) || ""), `causa en español: ${await cause.textContent()}`);
    await language().selectOption("en");
    await settle(400);

    await select("BRDP-SAV-INVALID");
    await testRule();
    await verdict().waitFor({ timeout: 20000 });
    await settle();
    const cause2 = page.getByTestId("rule-test-panel").getByTestId("rule-test-cause");
    assert((await verdict().getAttribute("data-kind")) === "no_runnable" && (await cause2.getAttribute("data-cause")) === "examples", "no example ran: cause is the examples");
    assert(((await cause2.textContent()) || "") === "The examples are written by the AI and sometimes come out wrong. Generate them again.", `examples text: ${await cause2.textContent()}`);
    await language().selectOption("es");
    await settle(400);
    assert(((await cause2.textContent()) || "") === "Los ejemplos los genera la IA y a veces salen mal. Vuelve a generarlos.", "examples text in Spanish");
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-cause-examples-es.png") });
    await language().selectOption("en");
    await settle(400);

    // 6. A cut answer.
    await select("BRDP-SAV-CUT");
    await fetch(`${MOCK}/truncate-next`, { method: "POST" });
    await testRule();
    const alert = page.getByTestId("rule-test-panel").getByRole("alert");
    await alert.waitFor({ timeout: 20000 });
    const alertText = (await alert.textContent()) || "";
    assert(alertText.includes("The AI's answer was cut off by its length") && !/JSON/.test(alertText), `cut answer: ${alertText}`);
    assert((await lastRequest())?.max_tokens === 16000, `the rule test asks for 16000 tokens (${(await lastRequest())?.max_tokens})`);
    await page.getByTestId("rule-test-panel").screenshot({ path: path.join(SHOTS, "rule-test-truncated.png") });
    await page.getByRole("button", { name: /^(Regenerate examples|Regenerar ejemplos)$/ }).click();
    await verdict().waitFor({ timeout: 20000 });
    assert(((await verdict().textContent()) || "").startsWith("Correct"), "regenerated after the cut: Correct");
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
