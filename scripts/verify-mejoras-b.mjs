// Live verification for "Mejoras B del test de reglas" against the real app
// (Vite + FastAPI + Postgres); only the Mistral TRANSPORT is mocked
// (mock-mistral-chat-server.mjs):
//   Part 1 -- S1-00219 (flag 1, //itemSeqNumber/partSegment, ipd): the
//             minimal reject example is already rejected and never goes to
//             the correction round; verdict "Correct".
//   Part 1/3 -- S1-00123 (//entry/*[@applicRefId]): the reject example with
//             @applicRefId on the <entry> is accepted, not corrected (note
//             with the count), failed verdict with the exact cause, EN/ES.
//   Part 2 -- S1-00186 (> 5 with "a maximum of five levels"): threshold
//             warning in the test panel and under a pasted rule.
//   Part 4.1 -- descriptions of predicates on a non-last step and of a
//             single attribute predicate, EN/ES.
//   Part 4.2/4.3 -- manual editor: "Split into N rules" and "Number the ids".
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to the
// system temp directory.
//
//     node scripts/verify-mejoras-b.mjs
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const shot = (name) => path.join(os.tmpdir(), name);
const IPD = "http://www.s1000d.org/S1000D_4-2/xml_schema_flat/ipd.xsd";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const rule = (id, p, use, flag = "0") => `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="${flag}">${p}</objectPath><objectUse>${use}</objectUse></structureObjectRule>`;
const R219 = `<contextRules rulesContext="${IPD}"><structureObjectRuleGroup>${rule("BRDP-S1-00219", "//itemSeqNumber/partSegment", "BRDP-S1-00219. The element partSegment shall be used each time the part is listed.", "1")}</structureObjectRuleGroup></contextRules>`;
const R123 = rule("BRDP-S1-00123", "//entry/*[@applicRefId]", "BRDP-S1-00123. No applicability at entry level.");
const R186 = rule("BRDP-S1-00186", "//proceduralStep[count(ancestor::proceduralStep)&gt;5]", "No more than five levels of procedural steps.");
const RTITLE = rule("BRDP-MB-TITLE", "//proceduralStep[count(ancestor::proceduralStep)=4]/title", "No title on level 5.");
const TWO_PATHS = `<structureObjectRule id="BRDP-MB-EDIT" brSeverityLevel="brsl01">
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) &gt; 4]</objectPath>
  <objectUse>At most five levels.</objectUse>
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) = 4]/title</objectPath>
  <objectUse>The fifth level has no title.</objectUse>
</structureObjectRule>`;
const SAME_IDS = `${rule("BRDP-MB-EDIT", "//emphasis", "No emphasis.")}\n${rule("BRDP-MB-EDIT", "//randomList", "No random lists.")}`;

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Mejoras B ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());

  async function makeBrdp(fields) {
    return api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ definition: "Decide how the data is written.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
  }
  async function putDraft(brdp, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const getRule = (brdp) => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`).then((r) => r.json());

  const b219 = await makeBrdp({ identifier: "BRDP-S1-00219", title: "Part data in the IPD", proposal: "The element <partSegment> shall be used to store the part data in the IPD data module each time the part is listed." });
  const b123 = await makeBrdp({ identifier: "BRDP-S1-00123", title: "Applicability at entry level", proposal: "Applicability shall not be given at entry level in tables." });
  const b186 = await makeBrdp({ identifier: "BRDP-S1-00186", title: "Levels of steps", proposal: "There will be a maximum of five levels of steps." });
  const bTitle = await makeBrdp({ identifier: "BRDP-MB-TITLE", title: "Title on level 5", proposal: "The fifth level of steps has no title." });
  const bEdit = await makeBrdp({ identifier: "BRDP-MB-EDIT", title: "Manual editor", proposal: "Tool calibration is recorded every year." });
  const bPaste = await makeBrdp({ identifier: "BRDP-MB-PASTE", title: "Levels (pasted)", proposal: "There will be a maximum of five levels of steps." });
  await putDraft(b219, R219);
  await putDraft(b123, R123);
  await putDraft(b186, R186);
  await putDraft(bTitle, RTITLE);
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 80; i++) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  // Every LLM call the page makes: the correction round is the one whose
  // last user message starts with "Some examples are not valid."
  const llmCalls = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") {
      try {
        const body = JSON.parse(req.postData() || "{}");
        const messages = body.payload?.messages || body.messages || [];
        const last = [...messages].reverse().find((m) => m.role === "user")?.content || "";
        llmCalls.push(last);
      } catch {
        llmCalls.push("");
      }
    }
  });
  const corrections = () => llmCalls.filter((m) => m.startsWith("Some examples are not valid."));
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const language = async (lng) => {
    await page.locator("header select, nav select").first().selectOption(lng);
    await page.waitForTimeout(400);
  };
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant|Asistente/i", { timeout: 5000 });
    await page.waitForTimeout(500);
  }
  async function testRule() {
    llmCalls.length = 0;
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // ---- Part 1: S1-00219 never corrected ----
    await select("BRDP-S1-00219");
    await testRule();
    assert(corrections().length === 0, `S1-00219: no correction round (${llmCalls.length} LLM call(s))`);
    assert((await verdict().textContent()).startsWith("Correct"), `S1-00219: verdict correct (${await verdict().textContent()})`);
    await panel().screenshot({ path: shot("mejoras-b-s1-00219.png") });

    // ---- Parts 1 and 3: S1-00123 accepted reject example, exact cause ----
    await select("BRDP-S1-00123");
    await testRule();
    assert(corrections().length === 0, "S1-00123: the accepted reject example is not sent to the correction round");
    const skipped = page.getByTestId("rule-test-predicate-skipped");
    assert((await skipped.count()) === 1 && (await skipped.textContent()).startsWith("1 example meant to be rejected was not sent to the automatic correction"), `S1-00123: note about the example kept out of the correction (${(await skipped.count()) ? await skipped.textContent() : "none"})`);
    assert((await verdict().textContent()).startsWith("Test failed."), `S1-00123: failed verdict (${await verdict().textContent()})`);
    const cause = page.getByTestId("rule-test-accept-cause").first();
    assert((await cause.textContent()) === "Why the rule accepted it: the example has 2 children of <entry> and none has @applicRefId.", `S1-00123: cause EN (${await cause.textContent()})`);
    const neutral = page.getByTestId("rule-test-cause").first();
    assert((await neutral.textContent()).includes("If the example is badly written, repeat the test or edit it; if it is right, the rule does not cover the decision."), `S1-00123: neutral verdict text EN (${await neutral.textContent()})`);
    await language("es");
    assert((await cause.textContent()) === "Por qué la regla lo aceptó: el ejemplo tiene 2 hijos de <entry> y ninguno lleva @applicRefId.", `S1-00123: cause ES (${await cause.textContent()})`);
    assert((await neutral.textContent()).includes("Si el ejemplo está mal escrito, repite la prueba o edítalo; si está bien, la regla no cubre la decisión."), `S1-00123: neutral verdict text ES (${await neutral.textContent()})`);
    await panel().screenshot({ path: shot("mejoras-b-s1-00123-cause-es.png") });
    const descEs = await page.getByTestId("rule-test-description").textContent();
    assert(descEs.includes("Cualquier elemento hijo de <entry> con @applicRefId no puede aparecer (ruta //entry/*[@applicRefId])."), `Part 4.1, attribute predicate ES (${descEs})`);
    await language("en");
    const descEn = await page.getByTestId("rule-test-description").textContent();
    assert(descEn.includes("Any child element of <entry> with @applicRefId must not appear (path //entry/*[@applicRefId])."), `Part 4.1, attribute predicate EN (${descEn})`);

    // ---- Part 2: threshold warning in the test panel ----
    await select("BRDP-S1-00186");
    await page.getByRole("button", { name: "Test rule" }).click();
    const warn = page.getByTestId("rule-threshold-warning").or(page.getByTestId("rule-test-verdict").filter({ hasText: "speaks of 5" }));
    await warn.first().waitFor({ timeout: 20000 });
    await verdict().waitFor({ timeout: 20000 });
    const allText = await panel().textContent();
    assert(allText.includes("The Proposal speaks of 5; the rule allows up to 6 levels of <proceduralStep> and rejects from level 7 on."), "S1-00186: threshold mismatch in the test panel EN");
    await language("es");
    assert((await panel().textContent()).includes("La Propuesta habla de 5; la regla permite hasta 6 niveles de <proceduralStep> y rechaza a partir del 7."), "S1-00186: threshold mismatch in the test panel ES");
    await panel().screenshot({ path: shot("mejoras-b-threshold-test-es.png") });
    await language("en");

    // ---- Part 4.1: threshold on a step that is not the last one ----
    await select("BRDP-MB-TITLE");
    await page.getByRole("button", { name: "Test rule" }).click();
    const desc = page.getByTestId("rule-test-description");
    await desc.waitFor({ timeout: 10000 });
    assert((await desc.textContent()).includes("<title> must not appear in a <proceduralStep> at level 5"), `Part 4.1, threshold on a non-last step EN (${await desc.textContent()})`);
    await language("es");
    assert((await desc.textContent()).includes("<title> no puede aparecer en un <proceduralStep> de nivel 5"), `Part 4.1, threshold on a non-last step ES (${await desc.textContent()})`);
    await language("en");

    // ---- Part 2: threshold warning under a pasted rule (Suggest Rule panel) ----
    await select("BRDP-MB-PASTE");
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    const pasteBox = page.getByPlaceholder(/Paste/);
    await pasteBox.waitFor({ timeout: 15000 });
    await pasteBox.fill(rule("BRDP-MB-PASTE", "//proceduralStep[count(ancestor::proceduralStep)&gt;5]", "At most five levels."));
    await page.waitForTimeout(500);
    const pastedWarn = page.getByTestId("rule-threshold-warning").last();
    assert((await pastedWarn.count()) === 1 && (await pastedWarn.textContent()).includes("The Proposal speaks of 5; the rule allows up to 6 levels"), `pasted rule: threshold warning (${(await pastedWarn.count()) ? await pastedWarn.textContent() : "none"})`);
    await page.screenshot({ path: shot("mejoras-b-threshold-paste.png"), fullPage: true });
    // Same id twice in a pasted answer: numbered, with its note.
    await pasteBox.fill(SAME_IDS.replaceAll("BRDP-MB-EDIT", "BRDP-MB-PASTE"));
    await page.waitForTimeout(500);
    const idsNote = page.getByTestId("rule-ids-note").last();
    assert((await idsNote.count()) === 1 && (await idsNote.textContent()).includes("The app numbered the rules that had the same id BRDP-MB-PASTE: BRDP-MB-PASTE-1, BRDP-MB-PASTE-2."), `pasted rule: duplicate ids numbered (${(await idsNote.count()) ? await idsNote.textContent() : "none"})`);
    await page.getByRole("button", { name: "Accept pasted rule" }).click();
    await page.waitForTimeout(800);
    const savedPaste = await getRule(bPaste);
    const pastedIds = [...savedPaste.rule_xml.matchAll(/<structureObjectRule id="([^"]+)"/g)].map((m) => m[1]);
    assert(JSON.stringify(pastedIds) === '["BRDP-MB-PASTE-1","BRDP-MB-PASTE-2"]', `pasted rule: saved with distinct ids ${JSON.stringify(pastedIds)}`);

    // ---- Parts 4.2 and 4.3: manual editor buttons ----
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-MB-EDIT");
    await page.getByRole("button", { name: "Edit", exact: true }).last().click();
    const editor = page.getByPlaceholder("Paste or write the rule text (raw XML/Schematron)…");
    await editor.waitFor({ timeout: 5000 });
    await editor.fill(TWO_PATHS);
    await page.waitForTimeout(400);
    const split = page.getByTestId("rule-editor-split");
    assert((await split.count()) === 1 && (await split.textContent()) === "Split into 2 rules", `editor: split button (${(await split.count()) ? await split.textContent() : "none"})`);
    assert((await editor.inputValue()) === TWO_PATHS, "editor: nothing changed before clicking");
    await language("es");
    assert((await split.textContent()) === "Partir en 2 reglas", `editor: split button ES (${await split.textContent()})`);
    await language("en");
    await split.click();
    await page.waitForTimeout(300);
    assert((((await editor.inputValue()).match(/<structureObjectRule\b/g)) || []).length === 2, "editor: split into two rules");
    assert((await page.getByTestId("rule-editor-note").textContent()).includes("2 rules"), "editor: note after the split");
    await editor.fill(SAME_IDS);
    await page.waitForTimeout(400);
    const number = page.getByTestId("rule-editor-number-ids");
    assert((await number.count()) === 1 && (await number.textContent()) === "Number the ids", "editor: number-ids button");
    assert((await page.getByTestId("rule-editor-format-error").textContent()).includes("Several <structureObjectRule> have the same id (BRDP-MB-EDIT)"), `editor: duplicate ids warning (${await page.getByTestId("rule-editor-format-error").textContent()})`);
    await language("es");
    assert((await number.textContent()) === "Numerar ids", `editor: number-ids button ES (${await number.textContent()})`);
    await page.screenshot({ path: shot("mejoras-b-editor-number-ids-es.png"), fullPage: true });
    await language("en");
    await number.click();
    await page.waitForTimeout(300);
    const edited = await editor.inputValue();
    assert(/id="BRDP-MB-EDIT-1"/.test(edited) && /id="BRDP-MB-EDIT-2"/.test(edited), "editor: ids numbered -1, -2");
    assert((await page.getByTestId("rule-editor-note").textContent()).includes("BRDP-MB-EDIT-1, BRDP-MB-EDIT-2"), "editor: note after numbering");
    assert((await page.getByTestId("rule-editor-number-ids").count()) === 0, "editor: button gone once the ids are distinct");

    // PUT with repeated ids: 422.
    const put = await api(`/api/projects/${project.id}/brdps/${bEdit.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: SAME_IDS, source: "manual", status: "pending_review" }) });
    assert(put.status === 422, `PUT with repeated ids: 422 (${put.status})`);
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
