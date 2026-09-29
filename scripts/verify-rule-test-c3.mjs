// Live verification for Consolidation C3, Part 1 (Test rule):
//  1a. the correction round carries the card of each element involved -- the
//      real <quantity quantityValue="25" unitOfMeasure="N·m"> case: the
//      request lists the problems AND "card of <quantity> in the proced
//      schema: allowed children: quantityGroup; …", and with it the examples
//      are fixed (the mock only fixes them when the card is there);
//  1d. an old stored rule that is not a rule of its format (//&lt;emphasis&gt;,
//      saved before the format check; written straight into Postgres here,
//      because PUT now refuses it) shows "can't be tested" with the format
//      reason, in the panel and in the Verify dialog, without any LLM call;
//      backend/scripts/report_invalid_rules.py lists it.
// Against the real app (Vite + FastAPI + Postgres); only the Mistral
// TRANSPORT is mocked (mock-mistral-chat-server.mjs, mock-mistral-embed-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to /tmp.
//
//     node scripts/verify-rule-test-c3.mjs
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const BACKEND = new URL("../backend/", import.meta.url).pathname;

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

const RULE_QTY = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"><structureObjectRuleGroup><structureObjectRule id="BRDP-C3-QTY"><objectPath allowedObjectFlag="2">//quantityValue/@quantityUnitOfMeasure</objectPath><objectUse>The unit of measure of a torque value shall be N.m.</objectUse><objectValue valueForm="single" valueAllowed="N.m"/></structureObjectRule></structureObjectRuleGroup></contextRules>`;
const RULE_OK = `<structureObjectRule id="BRDP-C3-OLD"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>`;
const OLD_RULE = "//&lt;emphasis&gt;";
const RULE_THEAD = `<structureObjectRule id="BRDP-C3-SPAN"><objectPath allowedObjectFlag="0">//thead</objectPath><objectUse>Tables shall have no column headings.</objectUse></structureObjectRule>`;

// Write rule_xml straight into Postgres (the save endpoint refuses it now).
function writeRuleXmlDirectly(brdpId, format, ruleXml) {
  const code = `
import asyncio, sys, uuid
from sqlalchemy import update
from app.db.base import async_session_factory
from app.models import RuleApproval
async def main():
    async with async_session_factory() as s:
        await s.execute(update(RuleApproval).where(RuleApproval.brdp_id == uuid.UUID(sys.argv[1]), RuleApproval.format == sys.argv[2]).values(rule_xml=sys.argv[3]))
        await s.commit()
asyncio.run(main())
`;
  execFileSync(".venv/bin/python", ["-c", code, brdpId, format, ruleXml], { cwd: BACKEND });
}

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

  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Rule test C3 ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const makeBrdp = (fields) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ definition: "Decide.", validation: "Validated", ...fields }) }).then((r) => r.json());
  const putDraft = async (brdp, rule_xml) => {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  };
  const qty = await makeBrdp({
    identifier: "BRDP-C3-QTY",
    title: "Unit of measure of torque values",
    proposal: "In procedural data modules, torque values shall be marked up with <quantity> and their unit of measure shall be N.m.",
  });
  const old = await makeBrdp({ identifier: "BRDP-C3-OLD", title: "Old pasted rule", proposal: "The element <emphasis> shall not be used." });
  // C3b: examples whose table repeats a cell under a morerows.
  const spanned = await makeBrdp({ identifier: "BRDP-C3-SPAN", title: "Table headings", proposal: "Tables shall have no column headings. SPANNEDCELLS" });
  await putDraft(qty, RULE_QTY);
  await putDraft(old, RULE_OK);
  await putDraft(spanned, RULE_THEAD);
  // The old rule, as it was stored before the format check existed.
  const refused = await api(`/api/projects/${project.id}/brdps/${old.id}/approvals/BREX-4.2`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: OLD_RULE, source: "external_llm", status: "pending_review" }),
  });
  assert(refused.status === 422, "PUT refuses //&lt;emphasis&gt; today (422)");
  writeRuleXmlDirectly(old.id, "BREX-4.2", OLD_RULE);
  const report = execFileSync(".venv/bin/python", ["scripts/report_invalid_rules.py"], { cwd: BACKEND }).toString();
  assert(report.includes(`| Rule test C3 ${suffix} | BRDP-C3-OLD | BREX-4.2 | Draft | This is not a BREX 4.2 rule: structureObjectRule is missing |`), `report_invalid_rules.py lists the old rule (${report.trim().split("\n")[0]})`);
  assert(!report.includes("BRDP-C3-QTY"), "report_invalid_rules.py does not list a valid rule");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1400 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
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
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 1a. The <quantity> case: the correction request carries the cards.
    await select("BRDP-C3-QTY");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const req = await lastRequest();
    const nonSystem = req.messages.filter((m) => m.role !== "system");
    assert(nonSystem.length === 3, "one correction round");
    const correction = nonSystem[2]?.content || "";
    assert(correction.includes("- @quantityValue is not an attribute (it is the element <quantityValue>)"), "correction: @quantityValue is really an element");
    assert(correction.includes("- @unitOfMeasure does not exist on <quantity>"), "correction: @unitOfMeasure does not exist on <quantity>");
    assert(
      correction.includes("- @unitOfMeasure does not exist on <quantity>. If this element is not needed to test the rule, remove it and use plain text."),
      "C3b: <quantity> is not in the rule → the plain-text option is offered"
    );
    assert(!correction.includes("(it is the element <quantityValue>). If this element"), "C3b: no plain-text option for a problem about an attribute");
    assert(
      correction.includes("- card of <quantity> in the proced schema: allowed children: quantityGroup; attributes: @changeMark, @changeType, @quantityType, @quantityTypeSpecifics, @reasonForUpdateRefIds"),
      "correction: card of <quantity> (allowed children quantityGroup, its attributes)"
    );
    assert(correction.includes("- card of <quantityValue> in the proced schema: allowed children: none; attributes: @quantityUnitOfMeasure"), "correction: card of <quantityValue>");
    assert((await page.getByTestId("rule-test-correction").textContent()) === "2 examples were corrected automatically.", "both examples fixed with the cards");
    assert((await verdict().textContent()).startsWith("Correct"), "verdict correct after the correction");
    const accepted = await page.getByTestId("rule-test-example-0").textContent();
    assert(accepted.includes("<quantityGroup>") && accepted.includes('quantityUnitOfMeasure="N.m"'), "the fixed accept example follows the card (quantity > quantityGroup > quantityValue)");
    await panel().screenshot({ path: "/tmp/rule-test-c3-quantity-cards.png" });
    await page.getByRole("button", { name: "Close" }).click();

    // C3b. Overlapping cells: removed by the app, said in the panel, no
    // correction round.
    await select("BRDP-C3-SPAN");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 15000 });
    const spanReq = await lastRequest();
    assert(spanReq.messages.filter((m) => m.role !== "system").length === 1, "C3b: no correction round (one LLM call)");
    assert((await page.getByTestId("rule-test-correction").count()) === 0, "C3b: no correction note");
    for (const i of [0, 1]) {
      const ex = page.getByTestId(`rule-test-example-${i}`);
      const note = ex.getByTestId("rule-test-app-adjusted");
      assert((await note.textContent()) === "Adjusted by the app: removed 1 overlapping cell in row 2.", `C3b: example ${i + 1} says what the app removed (${await note.textContent()})`);
      const text = await ex.textContent();
      assert((text.match(/Access panel/g) || []).length === 1, `C3b: example ${i + 1} shows the fixed table (the spanned cell is gone)`);
    }
    assert((await verdict().textContent()).startsWith("Correct"), `C3b: verdict correct (${await verdict().textContent()})`);
    await panel().screenshot({ path: "/tmp/rule-test-c3b-spanned-cells.png" });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(300);
    const esNote = await page.getByTestId("rule-test-example-0").getByTestId("rule-test-app-adjusted").textContent();
    assert(esNote === "Ajustado por la app: se quitó 1 celda solapada en la fila 2.", `C3b: Spanish note (${esNote})`);
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    const spanApproval = await api(`/api/projects/${project.id}/brdps/${spanned.id}/approvals/BREX-4.2`).then((r) => r.json());
    assert(spanApproval.last_test_result === "passed", `C3b: the registered result is the fixed examples' (${spanApproval.last_test_result})`);
    await page.getByRole("button", { name: "Close" }).click();

    // 1d. The old non-rule: not executable with the format reason, no LLM call.
    await select("BRDP-C3-OLD");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Test rule" }).click();
    await panel().getByTestId("rule-test-analysis").waitFor({ timeout: 5000 });
    const analysis = await panel().getByTestId("rule-test-analysis").textContent();
    assert(
      analysis.includes("This rule can't be tested: The stored XML is not a rule of this format, so it cannot be tested: This is not a BREX 4.2 rule: structureObjectRule is missing"),
      `panel: the format reason on top (${analysis})`
    );
    await page.waitForTimeout(1000);
    assert(!analysis.includes("Examples could only illustrate it."), "no mention of illustrative examples for a non-rule");
    assert((await panel().getByTestId("rule-test-show-examples").count()) === 0, "no \"Show illustrative examples\" button for a non-rule");
    assert((await lastRequest()) === null, "no LLM call for a stored non-rule");
    await panel().screenshot({ path: "/tmp/rule-test-c3-old-rule.png" });
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    const dialog = page.getByTestId("verify-warning-dialog");
    await dialog.waitFor({ timeout: 5000 });
    const dialogText = await dialog.textContent();
    assert(dialogText.includes("structureObjectRule is missing"), `Verify dialog explains why (${dialogText})`);
    assert((await dialog.getByRole("button", { name: "Test now" }).count()) === 0, "Verify dialog: no Test now for a rule that can't be tested");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Spanish.
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Probar regla" }).click();
    await panel().getByTestId("rule-test-analysis").waitFor({ timeout: 5000 });
    const es = await panel().getByTestId("rule-test-analysis").textContent();
    assert(es.includes("El XML guardado no es una regla de este formato") && es.includes("Esto no es una regla BREX 4.2: falta structureObjectRule"), `Spanish: format reason translated (${es})`);
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
