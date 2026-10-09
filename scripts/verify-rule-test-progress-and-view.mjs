// Live verification for "Test de reglas: progreso y límite de tiempo, causas
// en Schematron, estructura en reglas de dosier, y vista formateada de la
// regla", in the real app (DITA 1.3 Xpath3.0 project):
//   1. Progress: while the AI answers, the panel shows the step ("Waiting
//      for the AI's answer…", then "Correcting 1 example…") and the elapsed
//      time as mm:ss, advancing every second.
//   2. Cancel: the wait stops, "Cancelled: nothing was recorded.", no
//      further call to the AI, nothing recorded.
//   3. Low time limit: the backend restarted with LLM_REQUEST_TIMEOUT_SECONDS=2
//      and a slow AI → the test error says "did not answer within 2 s" in
//      EN and ES, with Regenerate, and a failed llm_calls row; then the
//      backend is restarted with the normal limit.
//   4. Schematron cause: a rule with an inverted assert rejects the example
//      meant to be accepted → "Why the rule rejected it: <id> is not met
//      (<test>)"; the verdict is just "Test failed." and there is a single
//      cause sentence.
//   5. Dossier rules: the prompt carries "WHERE THE RULE LOOKS" with
//      $tablasPlan/$celdasProc/$escalonPlan/$escalonProc (EXT-00004) and
//      $pasosPrec/$notas (EXT-00008).
//   6. Formatted view of the rule: "Preview" of a Verified rule (EXT-00004
//      and EXT-00008), the saved test panel -- formatted by default, the
//      toggle shows the text exactly as saved, Copy gives the saved text,
//      labels in Spanish.
// Only the Mistral TRANSPORT is mocked.
//
// Preconditions: both mocks running (8901/8902), uvicorn on 8000 pointing
// at them, Vite on 5173. The script restarts the backend itself (by its
// exact PID) for the low limit, and back. Cleans up the project it creates.
//
//     node scripts/verify-rule-test-progress-and-view.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { readPublicTemplate } from "./lib/readXlsx.mjs";
import { shot } from "./lib/shots.mjs";
import { startUvicorn, uvicornPid } from "./lib/backendProcess.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const MOCKS = {
  MISTRAL_ENDPOINT: process.env.MISTRAL_ENDPOINT || "http://localhost:8902",
  MISTRAL_EMBED_ENDPOINT: process.env.MISTRAL_EMBED_ENDPOINT || "http://localhost:8901",
};

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const rows = readPublicTemplate("brdp-template-dita-xpath3.xlsx");
const row = (id) => rows.find((r) => r.ID === id);

const NOTE_RULE = (id, test = "@type") => `<sch:pattern id="p-${id}">
  <sch:rule context="note">
    <sch:assert id="${id}" role="error" test="${test}">Every note must declare its type (@type).</sch:assert>
  </sch:rule>
</sch:pattern>`;

async function waitBackend(up, tries = 160) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await fetch(`${API}/docs`).then((r) => r.ok).catch(() => false);
    if (ok === up) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not come ${up ? "up" : "down"}`);
}

async function restartBackend(extraEnv) {
  const pid = uvicornPid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    await waitBackend(false);
  }
  const log = fs.openSync(path.join(os.tmpdir(), "uvicorn-progress-and-view.log"), "a");
  startUvicorn({ env: { ...MOCKS, ...extraEnv }, log });
  await waitBackend(true);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${ADMIN_EMAIL}: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function main() {
  let token = await login();
  const api = (p, init = {}) =>
    fetch(`${API}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const me = await api("/api/auth/me").then((r) => r.json());
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Progress and view ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  const brdps = {};
  async function makeBrdp(identifier, { title, definition, proposal, rule, status = "pending_review" }) {
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title, definition, proposal, validation: "Validated" }),
    }).then((r) => r.json());
    brdps[identifier] = b;
    const put = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/SCH-DITA`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: rule, source: "manual", status }),
    });
    if (!put.ok) throw new Error(`seeding ${identifier} failed: ${put.status} ${await put.text()}`);
  }
  for (const id of ["BRDP-EXT-00004", "BRDP-EXT-00008"]) {
    const r = row(id);
    await makeBrdp(id, { title: r.Title, definition: r.Definition, proposal: r.Proposal, rule: r.Rule, status: id === "BRDP-EXT-00004" ? "approved" : "pending_review" });
  }
  const noteText = { title: "Notes", definition: "Decide how notes are written." };
  await makeBrdp("BRDP-PV-NOTE", { ...noteText, proposal: "Every <note> shall declare its type with @type.", rule: NOTE_RULE("BRDP-PV-NOTE") });
  await makeBrdp("BRDP-PV-SLOW", { ...noteText, proposal: "Every <note> shall declare its type with @type (slow).", rule: NOTE_RULE("BRDP-PV-SLOW") });
  await makeBrdp("BRDP-PV-WRONG", { ...noteText, proposal: "INVERTED: Every <note> shall declare its type with @type.", rule: NOTE_RULE("BRDP-PV-WRONG", "not(@type)") });
  const approvalOf = (id) => api(`/api/projects/${project.id}/brdps/${brdps[id].id}/approvals/SCH-DITA`).then((r) => r.json());
  {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1700 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const panel = () => page.getByTestId("rule-test-panel").first();
  const language = () => page.locator("header select, nav select").first();
  const mock = (p, init = {}) => fetch(`${MOCK}${p}`, init);
  const chatCalls = async () => (await mock("/chat-calls").then((r) => r.json())).calls;
  const lastRequest = () => mock("/last-request").then((r) => r.json());
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
    await page.waitForTimeout(400);
  }
  async function openRecords() {
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
  const testRuleButton = () => page.getByRole("button", { name: /^(Test rule|Probar regla)$/ }).first();
  const closePanel = async () => {
    if (await panel().count()) await panel().getByRole("button", { name: /^(Close|Cerrar)$/ }).click();
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await openRecords();

    // 1. Progress: step and elapsed time (EXT-00008 has a correction round).
    await select("BRDP-EXT-00008");
    await mock("/reset", { method: "POST" });
    await mock("/slow-next?ms=3500&count=3", { method: "POST" });
    await testRuleButton().click();
    const progress = panel().getByTestId("rule-test-progress");
    await progress.waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-progress"]')?.dataset.step === "waiting", null, { timeout: 5000 });
    assert((await progress.getByTestId("rule-test-progress-step").textContent()).includes("Waiting for the AI's answer…"), "progress: waiting for the AI");
    const t0 = (await progress.getByTestId("rule-test-progress-elapsed").textContent()).trim();
    await page.waitForTimeout(2100);
    const t1 = (await progress.getByTestId("rule-test-progress-elapsed").textContent()).trim();
    assert(/^\d\d:\d\d$/.test(t0) && /^\d\d:\d\d$/.test(t1) && t1 > t0, `progress: elapsed time advances as mm:ss (${t0} → ${t1})`);
    await panel().screenshot({ path: shot("rule-test-progress-waiting.png") });
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-progress"]')?.dataset.step === "correcting", null, { timeout: 15000 });
    assert((await panel().getByTestId("rule-test-progress-step").textContent()).includes("Correcting 1 example…"), "progress: correcting 1 example");
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    assert((await panel().getByTestId("rule-test-progress").count()) === 0, "progress: gone when the result is ready");

    // 5. WHERE THE RULE LOOKS (EXT-00008): first request is the examples' one.
    const last8 = await lastRequest();
    const sys8 = systemOf(last8);
    assert(sys8.includes("WHERE THE RULE LOOKS") && sys8.includes("$pasosPrec :=") && sys8.includes("$notas :="), "EXT-00008 prompt: WHERE THE RULE LOOKS with $pasosPrec and $notas");
    await closePanel();

    // 5. EXT-00004 is Verified (for the Preview below), so its prompt is
    // checked on a Draft copy of its rule.
    await makeBrdp("BRDP-PV-EXT4", { title: row("BRDP-EXT-00004").Title, definition: row("BRDP-EXT-00004").Definition, proposal: row("BRDP-EXT-00004").Proposal, rule: row("BRDP-EXT-00004").Rule.replaceAll("BRDP-EXT-00004", "BRDP-PV-EXT4") });
    await openRecords();
    await select("BRDP-PV-EXT4");
    await mock("/reset", { method: "POST" });
    await testRuleButton().click();
    await panel().getByTestId("rule-test-verdict").or(panel().locator('[role="alert"]')).first().waitFor({ timeout: 30000 });
    const sys4 = systemOf(await lastRequest());
    const look4 = sys4.slice(sys4.indexOf("WHERE THE RULE LOOKS"));
    assert(sys4.includes("WHERE THE RULE LOOKS"), "EXT-00004 prompt: WHERE THE RULE LOOKS");
    for (const name of ["$tablasPlan :=", "$celdasProc :=", "$escalonPlan :=", "$escalonProc :="]) {
      assert(look4.includes(name), `EXT-00004 prompt: ${name}`);
    }
    await closePanel();

    // 2. Cancel during the wait: nothing recorded, no further calls.
    await select("BRDP-PV-SLOW");
    await mock("/reset", { method: "POST" });
    await mock("/slow-next?ms=4000&count=3", { method: "POST" });
    await testRuleButton().click();
    await panel().getByTestId("rule-test-progress").waitFor({ timeout: 5000 });
    await page.waitForTimeout(500);
    const callsAtCancel = await chatCalls();
    await panel().getByTestId("rule-test-cancel").click();
    await panel().getByTestId("rule-test-cancelled").waitFor({ timeout: 3000 });
    assert((await panel().getByTestId("rule-test-cancelled").textContent()).includes("Cancelled: nothing was recorded."), "Cancel: 'Cancelled: nothing was recorded.'");
    assert((await panel().getByTestId("rule-test-progress").count()) === 0, "Cancel: the progress is gone");
    await page.waitForTimeout(5000);
    assert((await chatCalls()) === callsAtCancel, `Cancel: no further calls to the AI (${callsAtCancel} → ${await chatCalls()})`);
    assert((await panel().getByTestId("rule-test-verdict").count()) === 0, "Cancel: the late answer is not shown");
    assert((await approvalOf("BRDP-PV-SLOW")).last_test_result == null, "Cancel: nothing recorded");
    await panel().screenshot({ path: shot("rule-test-cancelled.png") });
    await closePanel();

    // 4. Schematron cause, one cause sentence.
    await select("BRDP-PV-WRONG");
    await mock("/reset", { method: "POST" });
    await testRuleButton().click();
    await panel().getByTestId("rule-test-verdict").waitFor({ timeout: 20000 });
    const verdictW = (await panel().getByTestId("rule-test-verdict").textContent()).trim();
    assert(verdictW === "Test failed.", `inverted assert: verdict is just "Test failed." (${verdictW})`);
    assert((await panel().getByTestId("rule-test-cause").count()) === 1, "a single cause sentence");
    const causes = await panel().getByTestId("rule-test-sch-cause").allTextContents();
    assert(causes.length >= 1 && causes.every((c) => c.includes("Why the rule rejected it: BRDP-PV-WRONG is not met (not(@type))")), `Schematron cause with id and expression (${causes.join(" | ")})`);
    assert((await panel().getByTestId("rule-test-reject-cause").count()) === 0, "no node-based cause next to the Schematron one");
    await panel().screenshot({ path: shot("rule-test-schematron-cause.png") });
    await language().selectOption("es");
    await page.waitForTimeout(400);
    const causesEs = await panel().getByTestId("rule-test-sch-cause").allTextContents();
    assert(causesEs.every((c) => c.includes("Por qué la regla lo rechazó: no se cumple BRDP-PV-WRONG (not(@type))")), `Schematron cause in Spanish (${causesEs.join(" | ")})`);
    assert((await panel().getByTestId("rule-test-verdict").textContent()).trim() === "Prueba fallida.", "verdict in Spanish");
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await closePanel();

    // 6. Formatted view: Preview of a Verified rule (EXT-00004).
    await select("BRDP-EXT-00004");
    await page.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByTestId("rule-preview");
    await preview.waitFor({ timeout: 5000 });
    assert((await preview.getAttribute("data-mode")) === "formatted", "Preview: formatted by default");
    const fmt4 = await page.getByTestId("rule-preview-content").innerText();
    assert(fmt4.includes("$tablasPlan := $docs//*[normalize-space(title) = 'DATOS PARA LA PLANIFICACIÓN']"), "Preview: sch:let as $name := value");
    assert(/\n\s*return if \(doc-available\(\$u\)\)/.test(fmt4), "Preview: long XPath split at return");
    await page.screenshot({ path: shot("rule-view-formatted-ext-00004.png"), fullPage: false });
    await page.getByTestId("rule-preview-raw").click();
    assert((await preview.getAttribute("data-mode")) === "raw", "toggle: as saved");
    const raw4 = await page.getByTestId("rule-preview-content").textContent();
    const stored4 = (await approvalOf("BRDP-EXT-00004")).rule_xml;
    assert(raw4 === stored4, "toggle: the text exactly as saved");
    await page.getByTestId("rule-preview-copy").click();
    await page.waitForTimeout(300);
    const clip4 = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip4 === stored4, "Copy: the stored text");
    await page.getByTestId("rule-preview-formatted").click();
    assert((await preview.getAttribute("data-mode")) === "formatted", "toggle: back to formatted");
    await page.getByTestId("rule-preview-copy").click();
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => navigator.clipboard.readText())) === stored4, "Copy from the formatted view: still the stored text");

    // EXT-00008, approved now, with its xmlns shown once.
    {
      const r = row("BRDP-EXT-00008");
      const put = await api(`/api/projects/${project.id}/brdps/${brdps["BRDP-EXT-00008"].id}/approvals/SCH-DITA`, {
        method: "PUT",
        body: JSON.stringify({ rule_xml: r.Rule, source: "manual", status: "approved" }),
      });
      assert(put.ok, "EXT-00008 approved");
    }
    await openRecords();
    await select("BRDP-EXT-00008");
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByTestId("rule-preview").waitFor({ timeout: 5000 });
    const fmt8 = await page.getByTestId("rule-preview-content").innerText();
    assert(fmt8.includes("$pasosPrec := $docPrec//cmd ! normalize-space(.)"), "EXT-00008: $pasosPrec on one line");
    assert(fmt8.includes('xmlns:xs="http://www.w3.org/2001/XMLSchema" (declared in each function)'), "EXT-00008: repeated xmlns shown once, declared in each function");
    await language().selectOption("es");
    await page.waitForTimeout(400);
    assert((await page.getByTestId("rule-preview-formatted").textContent()) === "Formateada" && (await page.getByTestId("rule-preview-raw").textContent()) === "Tal como se guardó", "labels in Spanish");
    assert((await page.getByTestId("rule-preview-content").innerText()).includes("(declarado en cada función)"), "declared in each function, in Spanish");
    await page.screenshot({ path: shot("rule-view-formatted-ext-00008-es.png"), fullPage: false });
    await page.getByTestId("rule-preview-raw").click();
    assert((await page.getByTestId("rule-preview-content").textContent()) === (await approvalOf("BRDP-EXT-00008")).rule_xml, "EXT-00008: as saved");
    await language().selectOption("en");
    await page.waitForTimeout(300);

    // The saved test panel shows the tested rule formatted (EXT-00008 passed).
    const saved8 = await approvalOf("BRDP-EXT-00008");
    if (saved8.last_passed_test) {
      await page.getByTestId("saved-rule-test-open").click();
      const sv = page.getByTestId("saved-rule-test-rule");
      await sv.waitFor({ timeout: 5000 });
      assert((await sv.getAttribute("data-mode")) === "formatted", "saved test panel: formatted by default");
      await page.getByTestId("saved-rule-test-rule-raw").click();
      assert((await page.getByTestId("saved-rule-test-rule-content").textContent()) === saved8.last_passed_test.rule_xml, "saved test panel: the tested rule as saved");
    } else {
      assert(false, "EXT-00008 has a saved passed test");
    }

    // 3. Low time limit (last: it restarts the backend).
    const usage = async () => (await api("/api/admin/llm-usage?days=1").then((r) => r.json())).rows.filter((r) => r.user_id === me.id);
    const failedChat = (rowsList) => rowsList.filter((r) => r.kind === "chat" && r.result === "failed").reduce((a, r) => a + r.calls, 0);
    const failedBefore = failedChat(await usage());
    await restartBackend({ LLM_REQUEST_TIMEOUT_SECONDS: "2" });
    token = await login();
    await openRecords();
    await select("BRDP-PV-NOTE");
    await mock("/reset", { method: "POST" });
    await mock("/slow-next?ms=4500&count=4", { method: "POST" });
    await testRuleButton().click();
    const alert = panel().locator('[role="alert"]');
    await alert.waitFor({ timeout: 15000 });
    const errEn = await alert.textContent();
    assert(errEn.includes("The AI did not answer within 2 s. Try again."), `low limit: error in English (${errEn})`);
    assert((await panel().getByRole("button", { name: "Regenerate examples" }).count()) === 1, "low limit: Regenerate available");
    assert((await approvalOf("BRDP-PV-NOTE")).last_test_result == null, "low limit: nothing recorded");
    await panel().screenshot({ path: shot("rule-test-timeout-en.png") });
    await language().selectOption("es");
    await page.waitForTimeout(300);
    await mock("/slow-next?ms=4500&count=4", { method: "POST" });
    await panel().getByRole("button", { name: "Regenerar ejemplos" }).click();
    await page.waitForFunction(() => /La IA no ha respondido en 2 s/.test(document.querySelector('[data-testid="rule-test-panel"] [role="alert"]')?.textContent || ""), null, { timeout: 15000 });
    assert(true, "low limit: error in Spanish ('La IA no ha respondido en 2 s')");
    await panel().screenshot({ path: shot("rule-test-timeout-es.png") });
    await language().selectOption("en");
    await page.waitForTimeout(5000);
    const failedAfter = failedChat(await usage());
    assert(failedAfter >= failedBefore + 2, `low limit: failed llm_calls rows (${failedBefore} → ${failedAfter})`);
  } finally {
    await browser.close();
    if (process.env.KEEP_BACKEND !== "1") {
      await restartBackend({});
      token = await login();
    }
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
