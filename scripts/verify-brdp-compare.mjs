// Verification for "Comparar dos BRDP lado a lado": the same catalog BRDP
// (BRDP-S1-00052) in several projects -- a "Lufthansa"-like 4.2 project
// against an "Official Default"-like 4.2 one, plus 4.1, 3.0.1 and a project
// the viewer cannot see --, word/line diffs and the structural summary,
// bringing a Proposal and a Rule (Draft + "copied from" in History), a rule
// of another format blocked, "Explain the differences" with a BRDP of
// another project, an EXT identifier, 155 vs 153 values, a viewer, DITA,
// EN and ES. Real backend, Postgres and Vite; only the chat transport is
// mocked. Self-cleaning.
//
//   cd backend && .venv/bin/python scripts/seed_compare_verification.py
//   node scripts/verify-brdp-compare.mjs
//   cd backend && .venv/bin/python scripts/seed_compare_verification.py cleanup
import { chromium } from "playwright-core";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const VIEWER_EMAIL = "compare-viewer@example.com";
const VIEWER_PASSWORD = "CompareViewer123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

const brex42 = (id, values, flag = "2") =>
  `<structureObjectRule id="${id}">
  <brDecisionRef brDecisionIdentNumber="${id}"/>
  <objectPath allowedObjectFlag="${flag}">//dmIdent/dmCode/@infoCode</objectPath>
  <objectUse>Allowed information codes.</objectUse>
${values.map((v) => `  <objectValue valueForm="single" valueAllowed="${v}"/>`).join("\n")}
</structureObjectRule>`;
// Same rule, other layout: one line, extra spaces.
const brex42OneLine = (id, values) =>
  `<structureObjectRule   id="${id}"><brDecisionRef brDecisionIdentNumber="${id}"/><objectPath allowedObjectFlag="2">
      //dmIdent/dmCode/@infoCode
  </objectPath><objectUse>Allowed   information codes.</objectUse>${values.map((v) => `<objectValue valueForm="single" valueAllowed="${v}"/>`).join("")}</structureObjectRule>`;
const brex41 = (id, values) =>
  `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="2">//dmIdent/dmCode/@infoCode</objectPath><objectUse>Allowed information codes.</objectUse>${values
    .map((v) => `<objectValue valueForm="single" valueAllowed="${v}"/>`)
    .join("")}</structureObjectRule>`;
const obj301 = `<objrule><objpath objappl="1">//dmc/avee/incode</objpath><objuse>Allowed information codes.</objuse><objval valtype="single" val1="040"/></objrule>`;
const sch = (test) =>
  `<sch:pattern id="p-note"><sch:rule context="note"><sch:assert id="BRDP-D1-CMP-001" test="${test}" role="error">A note needs an allowed type.</sch:assert></sch:rule></sch:pattern>`;

async function main() {
  const login = async (email, password) =>
    (
      await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }).then((r) => r.json())
    ).access_token;
  const token = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 7);
  const created = [];
  const makeProject = async (name, standard) => {
    const p = await fetch(`${API}/api/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    created.push(p);
    return p;
  };
  const makeBrdp = (p, body) =>
    fetch(`${API}/api/projects/${p.id}/brdps`, { method: "POST", headers: auth, body: JSON.stringify({ proposal: "", validation: "Validated", ...body }) }).then((r) => r.json());
  const putRule = async (p, b, format, ruleXml, status) => {
    const r = await fetch(`${API}/api/projects/${p.id}/brdps/${b.id}/approvals/${format}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ rule_xml: ruleXml, source: "manual", status }),
    });
    if (!r.ok) throw new Error(`rule ${b.identifier}: ${r.status} ${await r.text()}`);
  };
  const def = "Decide which information codes are used in the project.";

  const pLh = await makeProject("Cmp Lufthansa 4.2", "S1000D 4.2");
  const pOd = await makeProject("Cmp A Official Default 4.2", "S1000D 4.2");
  const p41 = await makeProject("Cmp B Official 4.1", "S1000D 4.1");
  const p301 = await makeProject("Cmp C Official 3.0.1", "S1000D 3.0.1");
  const pHidden = await makeProject("Cmp D Hidden 4.2", "S1000D 4.2");
  const pDitaA = await makeProject("Cmp DITA A", "DITA 1.3 Xpath2.0");
  const pDitaB = await makeProject("Cmp DITA B", "DITA 1.3 Xpath2.0");

  const bLh = await makeBrdp(pLh, { identifier: "BRDP-S1-00052", title: "Information codes", definition: def, proposal: "Use info codes 000 and 002." });
  await putRule(pLh, bLh, "BREX-4.2", brex42("BRDP-S1-00052", ["000", "002"]), "pending_review");
  const bOd = await makeBrdp(pOd, { identifier: "BRDP-S1-00052", title: "Information codes", definition: def, proposal: "Use info codes [VALUE: e.g. 000, 055, 930]." });
  await putRule(pOd, bOd, "BREX-4.2", brex42("BRDP-S1-00052", ["000", "055", "930"]), "approved");
  const b41 = await makeBrdp(p41, { identifier: "BRDP-S1-00052", title: "Information codes", definition: def, proposal: "Only info code 000." });
  await putRule(p41, b41, "BREX-4.1", brex41("BRDP-S1-00052", ["000"]), "approved");
  const b301 = await makeBrdp(p301, { identifier: "BRDP-S1-00052", title: "Information codes", definition: def, proposal: "Only info code 040." });
  await putRule(p301, b301, "BREX-3.0.1", obj301, "approved");
  const bHidden = await makeBrdp(pHidden, { identifier: "BRDP-S1-00052", title: "Information codes", definition: def, proposal: "Use info codes 000 and 002." });
  await putRule(pHidden, bHidden, "BREX-4.2", brex42OneLine("BRDP-S1-00052", ["000", "002"]), "approved");
  await makeBrdp(pLh, { identifier: "BRDP-EXT-CMP01", title: "Own decision", definition: "A project-only decision.", proposal: "Keep it." });
  const many = Array.from({ length: 155 }, (_, i) => String(i).padStart(3, "0"));
  const fewer = many.filter((v) => v !== "077" && v !== "140");
  const bMany = await makeBrdp(pLh, { identifier: "BRDP-CMP-MANY1", title: "Many codes", definition: "Codes.", proposal: "155 codes." });
  await putRule(pLh, bMany, "BREX-4.2", brex42("BRDP-CMP-MANY1", many), "approved");
  const bFewer = await makeBrdp(pLh, { identifier: "BRDP-CMP-MANY2", title: "Many codes", definition: "Codes.", proposal: "153 codes." });
  await putRule(pLh, bFewer, "BREX-4.2", brex42("BRDP-CMP-MANY1", fewer), "approved");
  const bDitaA = await makeBrdp(pDitaA, { identifier: "BRDP-D1-CMP-001", title: "Note types", definition: "Decide the note types.", proposal: "Any type." });
  await putRule(pDitaA, bDitaA, "SCH-DITA", sch("@type"), "approved");
  const bDitaB = await makeBrdp(pDitaB, { identifier: "BRDP-D1-CMP-001", title: "Note types", definition: "Decide the note types.", proposal: "Only note and tip." });
  await putRule(pDitaB, bDitaB, "SCH-DITA", sch("@type = ('note', 'tip')"), "approved");

  // The viewer: viewer on every project except the hidden one.
  const viewer = await fetch(`${API}/api/users`, { headers: auth }).then((r) => r.json());
  const viewerUser = viewer.find((u) => u.email === VIEWER_EMAIL);
  if (!viewerUser) throw new Error("Run backend/scripts/seed_compare_verification.py first");
  for (const p of [pLh, pOd, p41, p301]) {
    await fetch(`${API}/api/users/${viewerUser.id}/project-roles`, { method: "PUT", headers: auth, body: JSON.stringify({ project_id: p.id, role: "viewer" }) });
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  await openHistoryOnEachLoad(page);

  const signIn = async (email, password) => {
    await page.goto(BASE_URL);
    await page.fill("#login-email", email);
    await page.fill("#login-password", password);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
  };
  async function open(p, identifier) {
    await page.goto(`${BASE_URL}/projects/${p.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector('[data-testid="compare-open"]', { timeout: 5000 });
  }
  const dialog = () => page.getByTestId("brdp-compare-dialog");
  async function openCompare() {
    await page.getByTestId("compare-open").click();
    await dialog().waitFor();
  }
  async function waitView() {
    await page.getByTestId("compare-view").waitFor({ timeout: 10000 });
  }
  async function chooseCandidate(projectName) {
    await dialog().getByTestId("compare-candidate").filter({ hasText: projectName }).click();
    await page.waitForFunction((name) => document.querySelector('[data-testid="compare-right-header"]')?.textContent.includes(name), projectName, { timeout: 10000 });
  }

  try {
    await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    // ── S1-00052: Lufthansa-like vs Official Default-like ──
    await open(pLh, "BRDP-S1-00052");
    await openCompare();
    await dialog().getByTestId("compare-candidate").first().waitFor();
    const names = await dialog().getByTestId("compare-candidate").allTextContents();
    assert(names.length === 4, `admin sees the 4 other projects with BRDP-S1-00052 (${names.length})`);
    assert(names[0].includes(pOd.name), "the first candidate (Official Default 4.2) is listed first");
    assert(names.some((n) => n.includes("S1000D 4.1")) && names.some((n) => n.includes("S1000D 3.0.1")), "projects of other standards are included, marked with their standard");
    assert(names[0].includes("Validated") && names[0].includes("Rule: Verified") && names[0].includes("Test: Not tested"), "each candidate shows Proposal status, rule status and test");
    await waitView();
    const header = await dialog().getByTestId("compare-right-header").textContent();
    assert(header.includes(pOd.name) && header.includes("S1000D 4.2"), "the first candidate is selected by default, header with project and standard");
    assert((await dialog().getByTestId("compare-left-header").textContent()).includes(pLh.name), "left column is the current BRDP with its project");
    const summary = await dialog().getByTestId("compare-summary").textContent();
    assert(summary.includes("Definition equal") && summary.includes("Proposal different"), `summary line: ${summary}`);
    assert(summary.includes("Rule different (2 values added, 1 value removed)"), "summary counts the values added and removed");
    const structValues = await dialog().getByTestId("compare-structure-values").first().textContent();
    assert(structValues.includes("+055") && structValues.includes("+930") && structValues.includes("−002"), `structural summary: ${structValues}`);
    const proposalAdded = await dialog().getByTestId("compare-row-proposal").getByTestId("diff-added").allTextContents();
    assert(proposalAdded.join(" ").includes("VALUE"), "Proposal word diff marks the added placeholder");
    assert(await dialog().getByTestId("compare-standard-differs").count() === 0, "same standard: no warning");
    assert((await dialog().getByTestId("compare-row-rule-state").textContent()).includes("Draft") && (await dialog().getByTestId("compare-row-rule-state").textContent()).includes("Verified"), "rule status row: Draft vs Verified");
    await dialog().getByTestId("compare-rule-text-tab").click();
    assert((await dialog().locator('[data-testid="compare-rule-line"][data-kind="changed"], [data-testid="compare-rule-line"][data-kind="added"]').count()) >= 2, "text view: line diff of the normalized XML");
    await page.screenshot({ path: "/tmp/brdp-compare-s1-00052.png", fullPage: false });

    // Formatting only: the hidden project's rule is the same rule on one line.
    await chooseCandidate(pHidden.name);
    assert((await dialog().getByTestId("compare-row-rule").getAttribute("data-status")) === "equal", "rules equal except indentation and line breaks → Rule equal");
    assert((await dialog().getByTestId("compare-summary").textContent()).includes("Rule equal"), "summary says Rule equal");

    // Another standard: warning, comparison still shown.
    await chooseCandidate(p41.name);
    assert(await dialog().getByTestId("compare-standard-differs").isVisible(), "4.1 vs 4.2: visible warning, comparison still allowed");
    // Explain the differences with a BRDP of another project.
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});
    await dialog().getByTestId("compare-explain").click();
    await dialog().waitFor({ state: "detached" });
    assert(await page.getByText("Comparing with: BRDP-S1-00052").isVisible(), "Explain opens Ask comparing with the chosen BRDP");
    const askBox = page.locator("textarea").last();
    assert(await askBox.evaluate((el) => el === document.activeElement), "the Ask question box has the focus");
    await askBox.fill("Explain the differences.");
    await askBox.press("Enter");
    await page.waitForFunction(() => fetch("http://localhost:8902/last-request").then((r) => r.json()).then((j) => Boolean(j)), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const request = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    const system = request.messages.find((m) => m.role === "system").content;
    assert(system.includes(`BRDP being compared against (source: Project "${p41.name}" (S1000D 4.1)):`), "Ask prompt carries the other project and its standard");
    assert(system.includes("Proposal: Only info code 000.") && system.includes("Rule Status: Verified"), "…with its Proposal and rule");

    // A rule of another format (objrule 3.0.1) cannot come into 4.2.
    await openCompare();
    await chooseCandidate(p301.name);
    assert(await dialog().getByTestId("compare-formats-differ").isVisible(), "3.0.1 vs 4.2: no structural summary, formats differ warning");
    assert(await dialog().locator('[data-testid="compare-rule-line"]').count() > 0, "…and the text view is shown");
    await dialog().getByTestId("compare-use-rule").click();
    assert(await dialog().getByTestId("compare-rule-blocked").isVisible(), "bringing a 3.0.1 rule into 4.2 is blocked");
    assert((await dialog().getByTestId("rule-format-error").first().textContent()).includes("<objrule> belongs to a BREX 3.0.1 rule, not to a BREX 4.2 rule"), "…with the format reason");
    assert(await dialog().getByTestId("compare-confirm-yes").count() === 0, "…and no Replace button");
    await page.screenshot({ path: "/tmp/brdp-compare-format-blocked.png" });

    // Bring the Official Default rule and Proposal.
    await chooseCandidate(pOd.name);
    await dialog().getByTestId("compare-use-rule").click();
    assert((await dialog().getByTestId("compare-confirm").textContent()).includes("The current Rule will be replaced"), "rule copy asks for confirmation");
    await dialog().getByTestId("compare-confirm-yes").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="compare-row-rule"]')?.getAttribute("data-status") === "equal", null, { timeout: 10000 });
    const approval = await fetch(`${API}/api/projects/${pLh.id}/brdps/${bLh.id}/approvals/BREX-4.2`, { headers: auth }).then((r) => r.json());
    assert(approval.status === "pending_review" && approval.source === "copied", "the brought rule is saved as Draft, source copied");
    assert(approval.rule_xml === brex42("BRDP-S1-00052", ["000", "055", "930"]), "…byte for byte the other project's rule");
    await dialog().getByTestId("compare-use-proposal").click();
    assert((await dialog().getByTestId("compare-confirm").textContent()).includes("The current Proposal will be replaced"), "Proposal copy asks for confirmation");
    await dialog().getByTestId("compare-confirm-yes").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="compare-row-proposal"]')?.getAttribute("data-equal") === "true", null, { timeout: 10000 });
    const brdps = await fetch(`${API}/api/projects/${pLh.id}/brdps`, { headers: auth }).then((r) => r.json());
    assert(brdps.find((b) => b.id === bLh.id).proposal === "Use info codes [VALUE: e.g. 000, 055, 930].", "a Proposal with [VALUE: …] is copied as is");
    await dialog().getByTestId("compare-close").click();
    const history = await fetch(`${API}/api/projects/${pLh.id}/brdps/${bLh.id}/history`, { headers: auth }).then((r) => r.json());
    assert(history.some((h) => h.field_name === "rule") && history.some((h) => h.field_name === "proposal"), "History has the rule change and the proposal change");
    await page.waitForSelector('[data-testid="history-item"]');
    const copiedItem = page.locator('[data-testid="history-item"]', { hasText: "Rule copied from" });
    assert((await copiedItem.textContent()).includes(`${pOd.name} / BRDP-S1-00052`), "History shows 'Rule copied from <project> / <BRDP>'");
    await page.screenshot({ path: "/tmp/brdp-compare-history-copied.png" });

    // EXT: not searched in other projects; the other tab opens.
    await open(pLh, "BRDP-EXT-CMP01");
    await openCompare();
    await page.getByTestId("compare-project-search").waitFor();
    assert((await dialog().getByTestId("compare-tab-project").getAttribute("aria-selected")) === "true", "EXT: the 'this project' tab opens");
    await dialog().getByTestId("compare-tab-same").click();
    assert((await dialog().getByTestId("compare-ext-note").textContent()).includes("Project's own identifier"), "EXT: the reason is visible");
    await dialog().getByTestId("compare-tab-project").click();
    await dialog().getByTestId("compare-project-search").fill("S1-00052");
    await dialog().getByTestId("compare-project-candidate").first().click();
    await waitView();
    assert((await dialog().getByTestId("compare-right-header").textContent()).includes("BRDP-S1-00052"), "search by ID in this project works");
    await dialog().getByTestId("compare-close").click();

    // 155 vs 153 values.
    await open(pLh, "BRDP-CMP-MANY1");
    await openCompare();
    await dialog().getByTestId("compare-tab-project").click();
    await dialog().getByTestId("compare-project-search").fill("MANY2");
    await dialog().getByTestId("compare-project-candidate").first().click();
    await waitView();
    assert((await dialog().getByTestId("compare-summary").textContent()).includes("2 values removed"), "155 vs 153: −2 values in the summary");
    assert((await dialog().getByTestId("compare-structure-values").textContent()).includes("−077, −140"), "…saying which");
    await dialog().getByTestId("compare-rule-text-tab").click();
    assert((await dialog().locator('[data-testid="compare-rule-line"][data-kind="removed"]').count()) === 2, "text view: exactly the 2 removed lines");
    assert((await dialog().getByTestId("compare-show-equal-lines").count()) >= 1, "…and the unchanged values folded, text readable");
    await page.screenshot({ path: "/tmp/brdp-compare-155-153.png" });
    await dialog().getByTestId("compare-close").click();

    // DITA: Schematron summary.
    await open(pDitaA, "BRDP-D1-CMP-001");
    await openCompare();
    await waitView();
    const ditaItem = await dialog().getByTestId("compare-structure-item").first().textContent();
    assert(ditaItem.includes("test: @type → @type = ('note', 'tip')"), `DITA: Schematron summary with the test change (${ditaItem})`);
    await page.screenshot({ path: "/tmp/brdp-compare-dita.png" });
    await dialog().getByTestId("compare-close").click();

    // Spanish.
    await page.locator("header select, nav select").first().selectOption("es");
    await open(pLh, "BRDP-S1-00052");
    assert((await page.getByTestId("compare-open").textContent()) === "Comparar", "ES: button 'Comparar'");
    await openCompare();
    await waitView();
    assert((await dialog().getByTestId("compare-tab-same").textContent()) === "Misma BRDP en otros proyectos", "ES: tab name");
    const summaryEs = await dialog().getByTestId("compare-summary").textContent();
    assert(summaryEs.includes("Definición igual") && summaryEs.includes("Regla igual"), `ES summary: ${summaryEs}`);
    await page.screenshot({ path: "/tmp/brdp-compare-es.png" });
    await dialog().getByTestId("compare-close").click();
    await page.locator("header select, nav select").first().selectOption("en");

    // Viewer: sees the comparison, no bring buttons, the hidden project never.
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());
    await signIn(VIEWER_EMAIL, VIEWER_PASSWORD);
    await open(pLh, "BRDP-S1-00052");
    await openCompare();
    await waitView();
    const viewerNames = await dialog().getByTestId("compare-candidate").allTextContents();
    assert(viewerNames.length === 3 && !viewerNames.some((n) => n.includes(pHidden.name)), "viewer: the project without access does not appear");
    assert((await dialog().getByTestId("compare-use-rule").count()) === 0 && (await dialog().getByTestId("compare-use-proposal").count()) === 0, "viewer: no bring buttons");
    assert(await dialog().getByTestId("compare-explain").isVisible(), "viewer: Explain is available");
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    const direct = await fetch(`${API}/api/projects/${pLh.id}/brdps/${bLh.id}/compare-detail/${bHidden.id}`, { headers: { Authorization: `Bearer ${viewerToken}` } });
    assert(direct.status === 404, "viewer: direct detail of the hidden project's BRDP is 404");
  } finally {
    await browser.close();
    for (const p of created) await fetch(`${API}/api/projects/${p.id}?permanent=true`, { method: "DELETE", headers: auth }).catch(() => {});
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
