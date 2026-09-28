// Live verification for "Suggest Rule (núcleo, parte 1 de 2)" (docs
// request) -- the edge-case table, against the real app (Vite + FastAPI +
// Postgres), with only the Mistral TRANSPORT mocked
// (mock-mistral-chat-server.mjs, which picks its Suggest Rule reply from
// the BRDP's Proposal; mock-mistral-embed-server.mjs for embeddings).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173, and backend/scripts/seed_suggest_proposal_catalog.py run
// (catalog identifier BRDP-SPCAT-LIVE-001 for S1000D 4.2). Cleans up the
// projects it creates.
//
//     node scripts/verify-suggest-rule.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const CATALOG_ID = "BRDP-SPCAT-LIVE-001";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const EMBED_MOCK = "http://localhost:8901";

// Suggest Rule adjustments round: reconstructions of the two real rules the
// docs request cites (their real XML isn't available in this environment
// -- same fixtures as backend/tests/test_rule_precedents.py).
const RULE_EXT_00066 = `<nonContextRule id="BRDP-EXT-00066">
  <brDecisionRef brDecisionIdentNumber="BRDP-EXT-00066"/>
  <simplePara>Illustrations shall be delivered as CGM files.</simplePara>
</nonContextRule>`;
const RULE_S1_00489_SOR = `<structureObjectRule id="BRDP-S1-00489" brSeverityLevel="brsl01">
    <brDecisionRef brDecisionIdentNumber="BRDP-S1-00489"/>
    <objectPath allowedObjectFlag="0">//logo</objectPath>
    <objectUse>The element &lt;logo&gt; shall not be used.</objectUse>
  </structureObjectRule>`;
const RULE_S1_00489 = `<rules>
  ${RULE_S1_00489_SOR}
  <nonContextRule id="BRDP-S1-00489-b">
    <simplePara>Logotypes are not presented.</simplePara>
  </nonContextRule>
</rules>`;

const VERIFIED_RULE = (id) =>
  `<structureObjectRule id="${id}" brSeverityLevel="brsl01"><brDecisionRef brDecisionIdentNumber="${id}"/><objectPath allowedObjectFlag="0">//table/@pgwide</objectPath><objectUse>Tables shall not use pgwide.</objectUse></structureObjectRule>`;

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
      body: JSON.stringify({ definition: "A definition.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
  }
  async function putRule(project, brdp, format, rule_xml, status) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml, source: "manual", status }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  // Legacy rule shapes (a <rules> wrapper, as in real customer data) arrive
  // through the Excel import, which does not apply the rule-format check --
  // PUT …/approvals refuses them since C2, Part 0.
  async function importRows(project, rows) {
    const body = { rows: rows.map((r, i) => ({ row_number: i + 2, definition: "A definition.", proposal_status: "Validated", ...r })) };
    const job = await api(`/api/projects/${project.id}/brdps/import/apply`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${project.id}/brdps/import/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") {
        if (s.status !== "completed") throw new Error(`import job ${s.status}: ${s.error}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("import job did not finish");
  }
  async function getRule(project, brdp, format) {
    return api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${format}`).then((r) => r.json());
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
  const similar = (project, brdp) => api(`/api/projects/${project.id}/brdps/${brdp.id}/similar?kind=rule`);

  // ---- seed ----
  const p42 = await makeProject("Suggest Rule 4.2", "S1000D 4.2");
  const b = {};
  b.marker = await makeBrdp(p42, { identifier: "BRDP-SR-MARKER", title: "Marker", proposal: "Warnings [SHALL/SHALL NOT] include a hazard symbol." });
  b.pending = await makeBrdp(p42, { identifier: "BRDP-SR-PENDING", title: "Pending", proposal: "Tables shall be framed.", validation: "Pending" });
  b.verified = await makeBrdp(p42, { identifier: "BRDP-SR-VERIFIED", title: "Verified", proposal: "Tables shall not use pgwide." });
  b.draft = await makeBrdp(p42, { identifier: "BRDP-SR-DRAFT", title: "Draft", proposal: "Every table shall be framed on all sides." });
  b.catalog = await makeBrdp(p42, { identifier: CATALOG_ID, title: "Catalog clamps", proposal: "Every table shall be framed on all sides." });
  b.pokemon = await makeBrdp(p42, { identifier: "BRDP-SR-POKEMON", title: "Pokemon", proposal: "Every pokemon shall be framed." });
  b.malformed = await makeBrdp(p42, { identifier: "BRDP-SR-MALFORMED", title: "Malformed", proposal: "MALFORMED: the mock returns an unclosed element." });
  b.escaped = await makeBrdp(p42, { identifier: "BRDP-SR-ESCAPED", title: "Escaped path", proposal: "ESCAPEDPATH: the mock returns //&lt;emphasis&gt; in objectPath." });
  b.calib = await makeBrdp(p42, { identifier: "BRDP-SR-CALIB", title: "Calibration", proposal: "Torque tool calibration shall be performed every 6 months." });
  b.ok = await makeBrdp(p42, { identifier: "BRDP-SR-OK", title: "Frames", proposal: "Every <table> shall be framed on all sides." });
  // Suggest Rule adjustments round.
  b.cage = await makeBrdp(p42, { identifier: "BRDP-SR-CAGE", title: "CAGE", proposal: "Permitted CAGE codes shall be limited to [e C1008, C1234]" });
  b.xpath = await makeBrdp(p42, { identifier: "BRDP-SR-XPATH", title: "Ids", proposal: "Only //para[@id] shall carry an identifier." });
  b.emph = await makeBrdp(p42, { identifier: "BRDP-SR-EMPH", title: "Emphasis", proposal: "@emphasisType shall only take em01 and em02." });
  b.edit = await makeBrdp(p42, { identifier: "BRDP-SR-EDIT", title: "Edited", proposal: "Every <table> shall be framed." });
  b.nc66 = await makeBrdp(p42, { identifier: "BRDP-EXT-00066", title: "CGM illustrations", proposal: "Illustrations shall be CGM." });
  await importRows(p42, [
    { identifier: "BRDP-S1-00489", title: "Logo", proposal: "The element <logo> will not be used.", rule_status: "Verified", rule: RULE_S1_00489 },
  ]);
  await putRule(p42, b.nc66, "BREX-4.2", RULE_EXT_00066, "approved");
  await putRule(p42, b.verified, "BREX-4.2", VERIFIED_RULE("BRDP-SR-VERIFIED"), "approved");
  await putRule(p42, b.draft, "BREX-4.2", VERIFIED_RULE("BRDP-SR-DRAFT-OLD"), "pending_review");

  // Another project that already implemented the catalog BRDP -> "Same BRDP".
  const pOther = await makeProject("Suggest Rule other", "S1000D 4.2");
  const otherCat = await makeBrdp(pOther, { identifier: CATALOG_ID, title: "Catalog clamps", proposal: "Tables shall be framed." });
  await putRule(pOther, otherCat, "BREX-4.2", VERIFIED_RULE(CATALOG_ID), "approved");

  const pDita = await makeProject("Suggest Rule DITA3", "DITA 1.3 Xpath3.0");
  const dita = await makeBrdp(pDita, { identifier: "BRDP-SR-DITA", title: "Notes", proposal: "Every table shall declare a frame." });

  const p50 = await makeProject("Suggest Rule 5.0", "S1000D 5.0");
  await makeBrdp(p50, { identifier: "BRDP-SR-50", title: "No format", proposal: "Tables shall be framed." });

  for (const p of [p42, pOther, pDita, p50]) await embed(p);

  // ---- backend: prerequisites and groups ----
  for (const [key, expected] of [
    ["marker", /placeholders/],
    ["pending", /Validated/],
    ["verified", /Verified/],
  ]) {
    const r = await similar(p42, b[key]);
    const body = await r.json();
    assert(r.status === 400 && expected.test(body.detail), `/similar?kind=rule rejects ${key} with 400 (${body.detail})`);
  }
  for (const key of ["draft", "catalog", "ok"]) {
    assert((await similar(p42, b[key])).status === 200, `/similar?kind=rule allows ${key}`);
  }
  const catBody = await similar(p42, b.catalog).then((r) => r.json());
  assert(catBody.same_brdp.length === 1 && catBody.same_brdp[0].source === pOther.name, "catalog BRDP: other project's Verified rule in same_brdp");
  assert(catBody.same_brdp[0].proposal === "Tables shall be framed." && catBody.same_brdp[0].text.includes(CATALOG_ID), "same_brdp carries the Proposal -> rule pair");
  assert((await similar(p42, b.cage)).status === 400, "hand-written [e C1008, C1234] is an unfilled placeholder (400)");
  assert((await similar(p42, b.xpath)).status === 200, "//para[@id] in the Proposal is not a placeholder");
  const okBody = await similar(p42, b.ok).then((r) => r.json());
  const okAll = [...okBody.same_brdp, ...okBody.candidates, ...okBody.standard_fallback, ...okBody.template_fallback];
  assert(!okAll.some((c) => c.identifier === "BRDP-EXT-00066"), "nonContextRule-only precedent (BRDP-EXT-00066) is never returned");
  const s489 = okAll.find((c) => c.identifier === "BRDP-S1-00489");
  assert(s489 && s489.text === RULE_S1_00489_SOR, "BRDP-S1-00489 is reduced to its structureObjectRule (no <rules>, no nonContextRule)");
  const okCount = okBody.same_brdp.length + okBody.candidates.length + okBody.standard_fallback.length + okBody.template_fallback.length;
  assert(okBody.sufficient_precedent === true && okCount >= 3, `no MIN_CANDIDATES: always answered, topped up to >=3 references (got ${okCount})`);
  // With the mock embeddings every real Verified 4.2 rule may already sit in
  // "Similar decisions"; the invariant is that the template only tops up
  // what is STILL missing after the real rules (backend tests cover the
  // 1-similar -> standard_fallback-not-template split explicitly).
  const realRefs = okBody.same_brdp.length + okBody.candidates.length + okBody.standard_fallback.length;
  assert(
    [...okBody.candidates, ...okBody.standard_fallback].some((c) => c.identifier === "BRDP-SR-VERIFIED"),
    "this project's own Verified rule is used as a reference"
  );
  assert(okBody.template_fallback.length === Math.max(0, 3 - realRefs), `template tops up only the missing slots (${realRefs} real + ${okBody.template_fallback.length} template)`);
  const ditaBody = await similar(pDita, dita).then((r) => r.json());
  console.log("DITA 1.3 Xpath3.0 groups:", ditaBody.same_brdp.length, ditaBody.candidates.length, ditaBody.standard_fallback.length, ditaBody.template_fallback.length);
  assert(ditaBody.template_fallback.length >= 1 && ditaBody.template_fallback.every((c) => c.source === "Template"), "a standard with (almost) no Verified rules falls back to the curated template");

  // ---- UI ----
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  const page = await context.newPage();
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.accept();
  });
  const ruleButton = () => page.getByRole("button", { name: "Suggest Rule" });
  async function openProject(p) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  }
  async function select(identifier) {
    // Search first: the table shows 15 rows per page, and this project has
    // more than that.
    await page.fill('input[placeholder="Search by ID or Title…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(400); // rule approval fetch
  }
  async function suggestRule() {
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});
    await ruleButton().click();
    await page.getByRole("button", { name: "Discard" }).waitFor({ timeout: 15000 });
    // Selector only opens when the text mentions a schema -- none of these do.
    assert((await page.getByTestId("rule-schema-selector").count()) === 0, "no schema mentioned: no schema selector");
  }
  const discard = () => page.getByRole("button", { name: "Discard" }).click();

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // Disabled reasons.
    await openProject(p50);
    await select("BRDP-SR-50");
    assert(await ruleButton().isDisabled(), "S1000D 5.0: Suggest Rule disabled");
    assert((await ruleButton().getAttribute("title")) === "Suggest Rule is not available for S1000D 5.0", "S1000D 5.0: reason shown");

    await openProject(p42);
    for (const [id, reason] of [
      ["BRDP-SR-MARKER", "Fill in the Proposal's placeholders"],
      ["BRDP-SR-PENDING", "Validate the Proposal first"],
      ["BRDP-SR-VERIFIED", "The rule is already Verified"],
      ["BRDP-SR-CAGE", "Fill in the Proposal's placeholders"],
    ]) {
      await select(id);
      assert(await ruleButton().isDisabled(), `${id}: Suggest Rule disabled`);
      assert((await ruleButton().getAttribute("title")) === reason, `${id}: reason "${reason}"`);
    }
    await page.screenshot({ path: "/tmp/suggest-rule-disabled-verified.png", fullPage: true });
    await select("BRDP-SR-XPATH");
    assert(!(await ruleButton().isDisabled()), "Proposal with //para[@id]: Suggest Rule enabled");

    // Happy path: generated rule, references, Copy prompt, Accept -> Draft.
    await select("BRDP-SR-OK");
    assert(!(await ruleButton().isDisabled()), "BRDP-SR-OK: Suggest Rule enabled");
    await suggestRule();
    await page.waitForSelector("text=/MOCK-RULE/");
    const last = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    const system = last.messages.find((m) => m.role === "system").content;
    const nonSystem = last.messages.filter((m) => m.role !== "system");
    assert(nonSystem.length === 1 && nonSystem[0].content === "Write the rule for this BRDP.", "fixed user message, no history");
    assert(last.temperature === 0.3, `temperature is SUGGEST_TEMPERATURE (got ${last.temperature})`);
    assert(system.includes("FORMAT — S1000D Issue 4.2 BREX") && system.includes("Proposal: Every <table> shall be framed on all sides."), "prompt carries the 4.2 format rules and the Proposal");
    assert(system.includes("SCHEMA FACTS — extracted from the official S1000D 4.2 schema") && system.includes("<table>"), "prompt carries schema facts for <table> (named in the Proposal)");
    assert(system.includes("Format examples — unrelated to this BRDP") || system.includes("Similar decisions"), "precedent blocks present");
    assert(!system.includes("BRDP-EXT-00066"), "prompt never cites the nonContextRule-only precedent");
    assert(system.includes(RULE_S1_00489_SOR) && !system.includes("BRDP-S1-00489-b") && !system.includes("<rules>"), "prompt cites only BRDP-S1-00489's structureObjectRule");
    assert((await page.getByRole("button", { name: "BRDP-EXT-00066", exact: true }).count()) === 0, "UI references never list BRDP-EXT-00066");
    assert((await page.getByRole("button", { name: "BRDP-S1-00489", exact: true }).count()) === 1, "UI references list BRDP-S1-00489");
    assert((await page.locator("text=/uses names not found/").count()) === 0, "valid rule: no name warning");
    assert(!(await page.getByRole("button", { name: "Accept", exact: true }).isDisabled()), "valid rule: Accept enabled");
    await page.getByRole("button", { name: "Copy prompt" }).click();
    await page.waitForSelector("text=Prompt copied");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip === `${system}\n\nWrite the rule for this BRDP.`, "Copy prompt copies the exact system prompt + user message in one block");
    await page.getByRole("button", { name: "BRDP-S1-00489", exact: true }).click();
    assert(
      (await page.locator("pre", { hasText: "//logo" }).count()) === 1 &&
        (await page.locator("pre", { hasText: "Logotypes are not presented" }).count()) === 0,
      "expanded BRDP-S1-00489 reference shows only its structureObjectRule"
    );
    assert((await page.locator("pre").count()) >= 1, "expanding a reference shows its rule XML");
    await page.screenshot({ path: "/tmp/suggest-rule-generated.png", fullPage: true });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForTimeout(800);
    const okRule = await getRule(p42, b.ok, "BREX-4.2");
    assert(okRule.status === "pending_review" && okRule.source === "llm" && okRule.rule_xml.includes("MOCK-RULE"), "Accept saves the rule as Draft (pending_review, source llm)");
    // History updated at once, no reload: status AND (shortened) text.
    const historyItems = page.locator("li").filter({ hasText: "admin@example.com" });
    // The shortened text shows the rule's start; "MOCK-RULE" is past the cut.
    const okRuleStart = '<structureObjectRule id="BRDP-SR-OK"';
    await page.locator("li", { hasText: okRuleStart }).first().waitFor({ timeout: 5000 });
    assert((await historyItems.filter({ hasText: /rule status/i }).filter({ hasText: /draft/i }).count()) >= 1, "History shows Rule Status To Do -> Draft right after Accept");
    const ruleHistory = historyItems.filter({ hasText: /^\s*rule(?! status)/i }).filter({ hasText: okRuleStart });
    assert((await ruleHistory.count()) === 1, "History shows the rule text change right after Accept");
    const shownRule = await ruleHistory.first().locator("span[title]").last().innerText();
    const fullRule = await ruleHistory.first().locator("span[title]").last().getAttribute("title");
    assert(fullRule === okRule.rule_xml && shownRule.length <= 161 && shownRule.endsWith("…"), `rule text shortened in the list, full text on hover (${shownRule.length} chars shown)`);
    await page.screenshot({ path: "/tmp/suggest-rule-history.png", fullPage: true });

    // Draft BRDP: allowed, confirmation before replacing.
    await select("BRDP-SR-DRAFT");
    assert(!(await ruleButton().isDisabled()), "Draft rule: Suggest Rule still allowed");
    await suggestRule();
    await page.waitForSelector("text=/MOCK-RULE/");
    dialogs.length = 0;
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForTimeout(800);
    assert(dialogs.some((m) => m.includes("already has a Draft rule")), "replacing a Draft asks for confirmation");
    const draftRule = await getRule(p42, b.draft, "BREX-4.2");
    assert(draftRule.rule_xml.includes("MOCK-RULE") && draftRule.status === "pending_review", "confirmed: Draft replaced");

    // Value-list Proposal -> objectValue instruction with the generic example.
    await select("BRDP-SR-EMPH");
    await suggestRule();
    const emphSystem = (await fetch(`${MOCK}/last-request`).then((r) => r.json())).messages[0].content;
    assert(
      emphSystem.includes('objectPath selects that attribute/element with allowedObjectFlag="2"') &&
        emphSystem.includes('<objectPath allowedObjectFlag="2">//@acmeCode</objectPath>') &&
        emphSystem.includes("Never express the list as a predicate in objectPath"),
      "value-list Proposal: prompt carries the objectValue instruction with the generic @acmeCode example"
    );
    assert(emphSystem.includes("write attribute names as @name"), "prompt asks for @name in objectUse");
    await discard();

    // Catalog BRDP: allowed, Same BRDP group in red.
    await select(CATALOG_ID);
    assert(!(await ruleButton().isDisabled()), "catalog BRDP: Suggest Rule allowed");
    await suggestRule();
    const sameHeading = page.locator("h4", { hasText: "Same BRDP in other projects" });
    assert((await sameHeading.count()) === 1, "Same BRDP group shown");
    const color = await sameHeading.evaluate((el) => getComputedStyle(el).color);
    assert(color === "rgb(220, 38, 38)", `Same BRDP group heading is red (got ${color})`);
    await page.screenshot({ path: "/tmp/suggest-rule-same-brdp-red.png", fullPage: true });
    await discard();

    // Invented element -> red warning, Accept still available.
    await select("BRDP-SR-POKEMON");
    await suggestRule();
    await page.waitForSelector("text=/uses names not found in the S1000D 4.2 schema: <pokemon>/");
    assert(!(await page.getByRole("button", { name: "Accept", exact: true }).isDisabled()), "invented element: Accept still enabled");
    await page.screenshot({ path: "/tmp/suggest-rule-invented-name.png", fullPage: true });
    await discard();

    // Malformed -> Accept disabled.
    await select("BRDP-SR-MALFORMED");
    await suggestRule();
    await page.waitForSelector("text=/not well-formed XML/");
    assert(await page.getByRole("button", { name: "Accept", exact: true }).isDisabled(), "malformed rule: Accept disabled");
    await page.screenshot({ path: "/tmp/suggest-rule-malformed.png", fullPage: true });
    await discard();

    // Schema-location encargo, Part 3: well-formed XML whose objectPath is
    // //&lt;emphasis&gt; (not XPath) -> red warning + Accept disabled, like
    // malformed XML. No name warning: "emphasis" is a real 4.2 element.
    await select("BRDP-SR-ESCAPED");
    await suggestRule();
    await page.waitForSelector("text=/Invalid XPath expression: \\/\\/<emphasis>/");
    const accept = page.getByRole("button", { name: "Accept", exact: true });
    assert(await accept.isDisabled(), "//&lt;emphasis&gt;: Accept disabled");
    assert((await accept.getAttribute("title")) === "The rule has an invalid XPath expression — it cannot be saved", "//&lt;emphasis&gt;: Accept says why");
    const xpColor = await page.locator("p", { hasText: "Invalid XPath expression" }).evaluate((el) => getComputedStyle(el).color);
    assert(xpColor === "rgb(185, 28, 28)", `invalid XPath warning is red (got ${xpColor})`);
    assert((await page.locator("text=/uses names not found/").count()) === 0, "//&lt;emphasis&gt;: no name warning (emphasis exists) -- only the syntax check catches it");
    await page.screenshot({ path: "/tmp/suggest-rule-invalid-xpath.png", fullPage: true });
    // The encargo's table, through Paste rule (same validation).
    const pasteBox = page.getByPlaceholder(/Paste/);
    const acceptPasted = page.getByRole("button", { name: "Accept pasted rule" });
    const brex = (path) => `<structureObjectRule id="BRDP-SR-ESCAPED" brSeverityLevel="brsl01"><brDecisionRef brDecisionIdentNumber="BRDP-SR-ESCAPED"/><objectPath allowedObjectFlag="0">${path}</objectPath><objectUse>u</objectUse></structureObjectRule>`;
    for (const [path, valid] of [["//para[count(x) &lt; 3]", true], ["//@emphasisType", true], ["//&lt;emphasis&gt;", false]]) {
      await pasteBox.fill(brex(path));
      await page.waitForTimeout(300);
      const warned = (await page.locator("text=/Invalid XPath expression/").count()) === 2; // generated + pasted
      assert(warned === !valid && (await acceptPasted.isDisabled()) === !valid, `pasted ${path}: ${valid ? "valid, Accept enabled" : "warning + Accept disabled"}`);
    }
    await discard();

    // NOT_CHECKABLE -> reason, no Accept, Discard + Copy prompt; then Paste rule.
    await select("BRDP-SR-CALIB");
    await suggestRule();
    await page.waitForSelector("text=/Not checkable on the XML: tool calibration/");
    assert((await page.getByRole("button", { name: "Accept", exact: true }).count()) === 0, "NOT_CHECKABLE: no Accept");
    assert((await page.getByRole("button", { name: "Copy prompt" }).count()) === 1, "NOT_CHECKABLE: Copy prompt still available");
    const ncColor = await page.locator("p", { hasText: "Not checkable on the XML" }).evaluate((el) => getComputedStyle(el).color);
    assert(ncColor === "rgb(185, 28, 28)", `NOT_CHECKABLE shown in red like the vocabulary warnings (got ${ncColor})`);
    await page.screenshot({ path: "/tmp/suggest-rule-not-checkable.png", fullPage: true });
    const paste = page.getByPlaceholder(/Paste/);
    await paste.fill('<structureObjectRule id="BRDP-SR-CALIB"><brDecisionRef brDecisionIdentNumber="BRDP-SR-CALIB"/><objectPath allowedObjectFlag="0">//pokemon</objectPath><objectUse>External</objectUse></structureObjectRule>');
    await page.waitForSelector("text=/uses names not found in the S1000D 4.2 schema: <pokemon>/");
    await paste.fill("<objectPath>//para");
    await page.waitForSelector("text=/not well-formed XML/");
    assert(await page.getByRole("button", { name: "Accept pasted rule" }).isDisabled(), "pasted malformed rule: Accept pasted disabled");
    await paste.fill('<structureObjectRule id="BRDP-SR-CALIB"><brDecisionRef brDecisionIdentNumber="BRDP-SR-CALIB"/><objectPath allowedObjectFlag="0">//pokemon</objectPath><objectUse>External</objectUse></structureObjectRule>');
    await page.screenshot({ path: "/tmp/suggest-rule-paste.png", fullPage: true });
    await page.getByRole("button", { name: "Accept pasted rule" }).click();
    await page.waitForTimeout(800);
    const pasted = await getRule(p42, b.calib, "BREX-4.2");
    assert(pasted.source === "external_llm" && pasted.status === "pending_review" && pasted.rule_xml.includes("External"), "pasted rule saved as Draft with source external_llm");
    assert((await page.getByRole("button", { name: "Discard" }).count()) === 0, "accepting the pasted rule clears the entry");

    // Edit the Proposal (the BRDP becomes the ONLY pending embedding) and
    // Suggest Rule right away, without Compute embeddings.
    await select("BRDP-SR-EDIT");
    const proposalBox = page.locator('label:text-is("Proposal") + textarea');
    await proposalBox.fill("Every <table> shall be framed on all four sides.");
    await proposalBox.blur();
    await page.waitForTimeout(800);
    const pendingNow = await api(`/api/projects/${p42.id}/embeddings/pending`).then((r) => r.json());
    assert(
      pendingNow.project_pending === 1 && pendingNow.catalog_pending === 0 && pendingNow.only_pending_brdp_id === b.edit.id,
      `editing the Proposal makes this BRDP the only pending one (${JSON.stringify(pendingNow)})`
    );
    assert((await page.locator("text=/pending embedding/").count()) === 1, "the pending banner is shown");
    assert(!(await ruleButton().isDisabled()), "Suggest Rule stays enabled: the only pending BRDP is the selected one");
    const callsBefore = (await fetch(`${EMBED_MOCK}/calls`).then((r) => r.json())).count;
    await suggestRule();
    await page.waitForSelector("text=/MOCK-RULE/");
    const callsAfter = (await fetch(`${EMBED_MOCK}/calls`).then((r) => r.json())).count;
    const pendingAfter = await api(`/api/projects/${p42.id}/embeddings/pending`).then((r) => r.json());
    assert(pendingAfter.project_pending === 0, "the selected BRDP was embedded before the Suggest ran");
    assert(callsAfter - callsBefore === 2, `one embedding for the BRDP + one query embedding (${callsAfter - callsBefore} calls)`);
    await page.waitForFunction(() => !document.body.innerText.includes("pending embedding"), null, { timeout: 5000 });
    await page.screenshot({ path: "/tmp/suggest-rule-embed-selected-first.png", fullPage: true });
    await discard();

    // DITA 1.3 Xpath3.0: Schematron fragment, template format examples.
    await openProject(pDita);
    await select("BRDP-SR-DITA");
    await suggestRule();
    await page.waitForSelector("text=/MOCK-RULE/");
    const ditaSystem = (await fetch(`${MOCK}/last-request`).then((r) => r.json())).messages[0].content;
    assert(ditaSystem.includes('queryBinding="xslt3"'), "DITA Xpath3.0 prompt names queryBinding xslt3");
    assert((await page.locator("text=/not well-formed/").count()) === 0, "sch:-prefixed fragment is well-formed (prefix declared by the checker)");
    assert((await page.locator("h4", { hasText: "Format examples" }).count()) === 1, "DITA: format examples group from the template");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForTimeout(800);
    const ditaRule = await getRule(pDita, dita, "SCH-DITA");
    assert(ditaRule.status === "pending_review" && ditaRule.rule_xml.startsWith("<sch:pattern"), "DITA rule saved as Draft under SCH-DITA");
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
