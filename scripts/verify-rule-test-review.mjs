// Live verification for "Test de reglas" T3b: the deterministic description
// of the rule (describeRule) in the Test rule panel, the "cannot reject any
// content" warning, examples written from the Proposal's decision, and
// "Review with the assistant" on an incorrect verdict -- cause "rule" →
// "Suggest a corrected rule" (Suggest Rule with the failed test in its
// prompt) → flag-0 rule → Test rule correct → Accept records it; cause
// "example" → "Regenerate examples" with the diagnosis → correct; cause
// "unclear" → both actions (the corrected rule blocked while a suggestion
// is pending). The review never changes the recorded result.
//
// Against the real app (Vite + FastAPI + Postgres); only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs: examples by rule +
// MISSINGATTR/UNCLEAR markers, review cause from the description it
// receives, a flag-0 rule for a Proposal naming <emphasis>).
//
// Preconditions: uvicorn with MISTRAL_ENDPOINT=http://localhost:8902 and
// MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite on
// 5173. Cleans up the projects it creates. Screenshots go to SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-rule-test-review.mjs
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

const rule42 = (id, path, flag, values = []) =>
  `<structureObjectRule id="${id}" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="${id}"/>
  <objectPath allowedObjectFlag="${flag}">${path}</objectPath>
  <objectUse>Rule ${id}.</objectUse>${values.map((v) => `\n  <objectValue valueForm="single" valueAllowed="${v}"/>`).join("")}
</structureObjectRule>`;
const PROCED = (id) => `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd">
  <structureObjectRuleGroup>
${rule42(id, "//emphasis", "0")}
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
  const brdps = {};

  async function makeProject(name, standard) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    return p;
  }
  async function makeBrdp(project, identifier, proposal, format, ruleXml) {
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title: `Emphasis ${identifier}`, definition: "Decide how emphasis is used.", proposal, validation: "Validated" }),
    }).then((r) => r.json());
    brdps[identifier] = { project, brdp: b, format };
    const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/${format}`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: ruleXml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const approvalOf = (identifier) => {
    const { project, brdp, format } = brdps[identifier];
    return api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`).then((r) => r.json());
  };
  const historyOf = (identifier) => {
    const { project, brdp } = brdps[identifier];
    return api(`/api/projects/${project.id}/brdps/${brdp.id}/history`).then((r) => r.json());
  };
  async function embed(project) {
    const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // ---- seed ----
  const p42 = await makeProject("Rule review 4.2", "S1000D 4.2");
  // A wrong rule: the Proposal forbids <emphasis>, the rule allows it.
  await makeBrdp(p42, "BRDP-RV-WRONG", "<emphasis> shall not be used.", "BREX-4.2", rule42("BRDP-RV-WRONG", "//emphasis", "2"));
  // A correct rule tested with an example that relies on the attribute's
  // absence (the real disagreement of the T3 report).
  const ETYPE = (id) => rule42(id, "//emphasis/@emphasisType", "2", ["em01", "em02"]);
  await makeBrdp(p42, "BRDP-RV-ATTR", "MISSINGATTR: @emphasisType shall only take em01 and em02.", "BREX-4.2", ETYPE("BRDP-RV-ATTR"));
  await makeBrdp(p42, "BRDP-RV-UNCL", "UNCLEAR MISSINGATTR: @emphasisType shall only take em01 and em02.", "BREX-4.2", ETYPE("BRDP-RV-UNCL"));
  await makeBrdp(p42, "BRDP-RV-PROC", "In procedural data modules, <emphasis> shall not be used.", "BREX-4.2", PROCED("BRDP-RV-PROC"));
  const p301 = await makeProject("Rule review 3.0.1", "S1000D 3.0.1");
  await makeBrdp(p301, "BRDP-RV-301", "<emphasis> shall not be used.", "BREX-3.0.1", `<objrule id="BRDP-RV-301">
  <objpath objappl="0">//emphasis</objpath>
  <objuse>No emphasis.</objuse>
</objrule>`);
  for (const p of projects) await embed(p);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept()); // "replace the Draft rule?" on Accept
  const panels = () => page.getByTestId("rule-test-panel");
  const indicator = () => page.getByTestId("rule-test-indicator");
  const language = () => page.locator("header select, nav select").first();
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
  const systemOf = (req) => req.messages.find((m) => m.role === "system").content;
  async function openProject(p) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
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
  async function testDraft() {
    await page.getByRole("button", { name: "Test rule" }).first().click();
    await panels().first().getByTestId("rule-test-verdict").waitFor({ timeout: 15000 });
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.waitForTimeout(300);
    await openProject(p42);

    // 1. The wrong rule (flag 2 on //emphasis): description + warning,
    //    incorrect verdict, review → rule → corrected rule → correct test.
    await select("BRDP-RV-WRONG");
    await testDraft();
    const panel = panels().first();
    const description = await panel.getByTestId("rule-test-description").textContent();
    assert(description.includes("<emphasis> is allowed: this rule does not reject it (path //emphasis)."), `flag 2: deterministic description (${description})`);
    const warning = panel.getByTestId("rule-test-cannot-reject");
    assert((await warning.textContent()).includes("This rule cannot reject any content."), "flag 2: cannot-reject warning");
    assert((await warning.evaluate((el) => getComputedStyle(el).color)) === "rgb(185, 28, 28)", "cannot-reject warning in red");
    const examplesPrompt = systemOf(await lastRequest());
    assert(examplesPrompt.includes("the examples test THIS") && examplesPrompt.includes("written from the Proposal's DECISION"), "examples prompt: written from the decision");
    assert(!examplesPrompt.includes('"explanation"'), "examples prompt: no LLM explanation asked");
    assert((await panel.getByTestId("rule-test-verdict").textContent()).startsWith("The rule accepted an example meant to violate it."), `flag 2: verdict incorrect (${await panel.getByTestId("rule-test-verdict").textContent()})`);
    await waitIndicator("failed");
    const historyBefore = (await historyOf("BRDP-RV-WRONG")).filter((h) => h.field_name === "rule_test").length;
    await panel.getByTestId("rule-test-review").click();
    const reviewBox = panel.getByTestId("rule-test-review-result");
    await reviewBox.waitFor({ timeout: 15000 });
    const reviewReq = await lastRequest();
    const reviewPrompt = systemOf(reviewReq);
    assert(reviewReq.temperature === 0.3, `review sent at 0.3 (${reviewReq.temperature})`);
    assert(reviewReq.messages.at(-1).content === "Review this failed rule test.", "review: fixed user message");
    assert(reviewPrompt.includes("What the rule checks (computed by the application from its XML — exact):\n- <emphasis> is allowed") && reviewPrompt.includes("- This rule cannot reject any content."), "review prompt carries the deterministic description");
    assert(reviewPrompt.includes('expected rejected, the rule accepted it.') && reviewPrompt.includes("<emphasis>25 N.m</emphasis>"), "review prompt carries the mismatched example");
    assert((await reviewBox.getAttribute("data-cause")) === "rule", "review: cause rule");
    assert((await reviewBox.textContent()).includes("The rule looks wrong.") && (await reviewBox.textContent()).includes("Indicative: MOCK-REVIEW"), "review shown as indicative");
    assert((await panel.getByTestId("rule-test-regenerate-with-review").count()) === 0, "cause rule: no Regenerate examples");
    const a1 = await approvalOf("BRDP-RV-WRONG");
    assert(a1.last_test_result === "failed" && (await historyOf("BRDP-RV-WRONG")).filter((h) => h.field_name === "rule_test").length === historyBefore, "the review records nothing: still failed, no new History entry");
    await panel.screenshot({ path: shot("rule-test-review-rule.png") });
    await panel.getByTestId("rule-test-suggest-corrected").click();
    await page.getByTestId("rule-corrected-note").waitFor({ timeout: 15000 });
    const sugReq = await lastRequest();
    const sugPrompt = systemOf(sugReq);
    assert(sugReq.messages.at(-1).content === "Write the rule for this BRDP.", "corrected rule: Suggest Rule's own message");
    assert(sugPrompt.includes("PREVIOUS RULE FAILED ITS TEST") && sugPrompt.includes('<objectPath allowedObjectFlag="2">//emphasis</objectPath>') && sugPrompt.includes("Diagnosis: MOCK-REVIEW"), "Suggest Rule prompt carries the failed rule, its examples and the diagnosis");
    const suggested = await page.locator('[class*="suggestionCode"]').first().textContent();
    assert(suggested.includes('allowedObjectFlag="0">//emphasis<'), `corrected rule is flag 0 (${suggested})`);
    // Test the corrected suggestion straight away, in the suggestion's own
    // box (the Draft rule's panel is closed first).
    await panel.getByRole("button", { name: "Close" }).click();
    const sugBox = page.locator('xpath=//*[@data-testid="rule-corrected-note"]/..');
    await sugBox.getByRole("button", { name: "Test rule" }).click();
    const sugPanel = sugBox.getByTestId("rule-test-panel");
    await sugPanel.getByTestId("rule-test-verdict").waitFor({ timeout: 15000 });
    assert((await sugPanel.getByTestId("rule-test-description").textContent()).includes("<emphasis> must not appear"), "corrected rule: description says it must not appear");
    assert((await sugPanel.getByTestId("rule-test-cannot-reject").count()) === 0, "corrected rule: no cannot-reject warning");
    assert((await sugPanel.getByTestId("rule-test-verdict").textContent()).startsWith("Correct"), `corrected rule: verdict correct (${await sugPanel.getByTestId("rule-test-verdict").textContent()})`);
    await page.screenshot({ path: shot("rule-test-corrected-rule.png"), fullPage: true });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await waitIndicator("passed");
    const a1b = await approvalOf("BRDP-RV-WRONG");
    assert(a1b.last_test_result === "passed" && a1b.last_test_up_to_date && a1b.rule_xml.includes('allowedObjectFlag="0"'), "accepted corrected rule: Draft, recorded as passed");

    // 2. A correct rule with a wrong example (no @emphasisType, expected
    //    rejected): review → example → regenerate with the diagnosis.
    await select("BRDP-RV-ATTR");
    await testDraft();
    const panel2 = panels().first();
    assert((await panel2.getByTestId("rule-test-description").textContent()).includes("@emphasisType, when it appears, can only take: em01, em02; if it does not appear, it is not rejected"), "emphasisType: description says a missing attribute is not rejected");
    assert((await panel2.getByTestId("rule-test-verdict").textContent()).startsWith("The rule accepted an example meant to violate it."), "missing-attribute example: verdict incorrect");
    await waitIndicator("failed");
    await panel2.getByTestId("rule-test-review").click();
    await panel2.getByTestId("rule-test-review-result").waitFor({ timeout: 15000 });
    assert((await panel2.getByTestId("rule-test-review-result").getAttribute("data-cause")) === "example", "review: cause example");
    assert((await panel2.getByTestId("rule-test-suggest-corrected").count()) === 0, "cause example: no corrected rule");
    await panel2.screenshot({ path: shot("rule-test-review-example.png") });
    await panel2.getByTestId("rule-test-regenerate-with-review").click();
    await panel2.getByTestId("rule-test-verdict").waitFor({ timeout: 15000 });
    const regenPrompt = systemOf(await lastRequest());
    assert(regenPrompt.includes("PREVIOUS EXAMPLES WERE WRONG") && regenPrompt.includes('"Sealant step without emphasisType" (expected reject, the rule accepted it)') && regenPrompt.includes("Diagnosis: MOCK-REVIEW"), "regeneration carries the diagnosis");
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-verdict"]')?.textContent.startsWith("Correct"), null, { timeout: 15000 });
    assert(true, "regenerated examples: verdict correct");
    await waitIndicator("passed");
    assert((await approvalOf("BRDP-RV-ATTR")).last_test_result === "passed", "the regeneration is a new test: recorded as passed");

    // 3. Unclear: both actions; the corrected rule blocked while this BRDP
    //    has a pending suggestion.
    await select("BRDP-RV-UNCL");
    await page.getByRole("button", { name: "Suggest Definition" }).click();
    await page.getByRole("button", { name: "Discard" }).first().waitFor({ timeout: 15000 });
    await testDraft();
    const panel3 = panels().first();
    await panel3.getByTestId("rule-test-review").click();
    await panel3.getByTestId("rule-test-review-result").waitFor({ timeout: 15000 });
    assert((await panel3.getByTestId("rule-test-review-result").getAttribute("data-cause")) === "unclear", "review: cause unclear");
    assert((await panel3.getByTestId("rule-test-regenerate-with-review").count()) === 1, "unclear: Regenerate examples offered");
    const corrected = panel3.getByTestId("rule-test-suggest-corrected");
    assert((await corrected.count()) === 1 && (await corrected.isDisabled()), "unclear: corrected rule offered, disabled while a suggestion is pending");
    assert((await corrected.getAttribute("title")) === "Accept or discard the pending suggestion first", `blocked reason shown (${await corrected.getAttribute("title")})`);
    await page.getByRole("button", { name: "Discard" }).first().click();
    await page.waitForTimeout(300);
    assert(!(await corrected.isDisabled()), "after Discard: corrected rule enabled");

    // 4. Proced context: "Only in the schemas: proced" in EN and ES.
    await panel3.getByRole("button", { name: "Close" }).click();
    await select("BRDP-RV-PROC");
    await testDraft();
    assert((await panels().first().getByTestId("rule-test-description").textContent()).includes("<emphasis> must not appear (path //emphasis). Only in the schemas: proced."), "proced: description in English");
    await language().selectOption("es");
    await page.waitForTimeout(300);
    const esDescription = await panels().first().getByTestId("rule-test-description").textContent();
    assert(esDescription.includes("Qué comprueba la regla") && esDescription.includes("<emphasis> no puede aparecer (ruta //emphasis). Solo en los esquemas: proced."), `proced: description in Spanish (${esDescription})`);
    await panels().first().screenshot({ path: shot("rule-test-description-proced-es.png") });
    await language().selectOption("en");
    await page.waitForTimeout(300);

    // 5. 3.0.1 objrule: its own semantics (objappl 0).
    await openProject(p301);
    await select("BRDP-RV-301");
    await testDraft();
    assert((await panels().first().getByTestId("rule-test-description").textContent()).includes("<emphasis> must not appear (path //emphasis)."), "3.0.1 objrule: described (objappl 0)");
  } finally {
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
    console.log("Cleaned up the seeded projects.");
    await browser.close();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
