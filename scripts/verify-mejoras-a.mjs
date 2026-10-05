// Live verification for "Mejoras A del test de reglas" (Lufthansa Technik
// AG - CMM, S1000D 4.2), against the real app (Vite + FastAPI + Postgres);
// only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs):
//   Part 1 -- S1-00223 / S1-00224 (//optionalPart/catalogSeqNumberRef,
//             //preferredSparePart/catalogSeqNumberRef): examples in ipd,
//             verdict "Correct".
//   Part 2 -- S1-00177 (//commonInfo[not(ancestor::procedure)]): the example
//             that must be rejected in process, the accepted one in proced.
//   Part 3 -- a rule with two objectPath, split by the app in Suggest Rule
//             and in Paste rule (note in EN and ES; the stored rule has two
//             <structureObjectRule>); one that cannot be split blocks Accept.
//   Part 4 -- S1-00186 (count(ancestor::proceduralStep) > 5): "What the rule
//             checks" says "level 7 or deeper" / "a partir del nivel 7".
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to the
// system temp directory.
//
//     node scripts/verify-mejoras-a.mjs
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
const shot = (name) => path.join(os.tmpdir(), name);

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const rule = (id, p, use) => `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">${p}</objectPath><objectUse>${use}</objectUse></structureObjectRule>`;
const R223 = rule("BRDP-S1-00223", "//optionalPart/catalogSeqNumberRef", "No CSN reference in optionalPart.");
const R224 = rule("BRDP-S1-00224", "//preferredSparePart/catalogSeqNumberRef", "No CSN reference in preferredSparePart.");
const R177 = rule("BRDP-S1-00177", "//commonInfo[not(ancestor::procedure)]", "Common information only in procedures.");
const R186 = rule("BRDP-S1-00186", "//proceduralStep[count(ancestor::proceduralStep)&gt;5]", "No more than five levels of procedural steps.");
const TWO_PATHS = `<structureObjectRule id="BRDP-MA-PASTE" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="BRDP-MA-PASTE"/>
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) &gt; 4]</objectPath>
  <objectUse>At most five levels.</objectUse>
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) = 4]/title</objectPath>
  <objectUse>The fifth level has no title.</objectUse>
</structureObjectRule>`;
const NOT_SPLITTABLE = TWO_PATHS.replace("<objectUse>The fifth level has no title.</objectUse>", "");

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Mejoras A ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());

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

  const b223 = await makeBrdp({ identifier: "BRDP-S1-00223", title: "CSN references in optional parts", proposal: "Optional parts shall not refer to another catalog sequence number." });
  const b224 = await makeBrdp({ identifier: "BRDP-S1-00224", title: "CSN references in preferred spare parts", proposal: "Preferred spare parts shall not refer to another catalog sequence number." });
  const b177 = await makeBrdp({ identifier: "BRDP-S1-00177", title: "Common information", proposal: "Common information is only used inside procedures." });
  const b186 = await makeBrdp({ identifier: "BRDP-S1-00186", title: "Levels of steps", proposal: "There will be a maximum of five levels of steps." });
  const bSuggest = await makeBrdp({ identifier: "BRDP-MA-SUGGEST", title: "Levels and titles", proposal: "There will be a maximum of five levels, while the fifth level must not have a title." });
  const bPaste = await makeBrdp({ identifier: "BRDP-MA-PASTE", title: "Levels and titles (pasted)", proposal: "Tool calibration is recorded every year." });
  await putDraft(b223, R223);
  await putDraft(b224, R224);
  await putDraft(b177, R177);
  await putDraft(b186, R186);
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
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
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
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
  }
  async function examples() {
    const out = [];
    const n = await page.locator('[data-testid^="rule-test-example-"]').count();
    for (let i = 0; i < n; i += 1) {
      out.push({
        schema: (await example(i).textContent()).match(/Schema: ([a-z]+)/)?.[1],
        result: (await example(i).getByTestId("rule-test-result").count()) ? (await example(i).getByTestId("rule-test-result").textContent()).replace(/^Result: /, "") : `not run: ${await example(i).textContent()}`,
        xml: await example(i).locator("pre").textContent(),
      });
    }
    return out;
  }
  const lastSystem = async () => (await fetch(`${MOCK}/last-request`).then((r) => r.json())).messages.find((m) => m.role === "system").content;

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // ---- Part 1: S1-00223 / S1-00224 in ipd ----
    for (const [id, first] of [["BRDP-S1-00223", "optionalPart"], ["BRDP-S1-00224", "preferredSparePart"]]) {
      await select(id);
      await testRule();
      const sys = await lastSystem();
      assert(sys.includes('schema "ipd"') && !sys.includes('schema "descript"'), `${id}: the prompt offers ipd, never descript`);
      assert(/itemSeqNumber.*partSegment.*partRefGroup/s.test(sys), `${id}: the prompt gives the way down through itemSeqNumber/partSegment/partRefGroup`);
      const ex = await examples();
      assert(ex.length === 2 && ex.every((e) => e.schema === "ipd"), `${id}: examples in ipd (${JSON.stringify(ex.map((e) => e.schema))})`);
      assert(ex.every((e) => e.xml.includes(`<${first}>`)), `${id}: each example has <${first}>`);
      assert(JSON.stringify(ex.map((e) => e.result)) === '["accepted ✓","rejected ✓"]', `${id}: accepted / rejected (${JSON.stringify(ex.map((e) => e.result))})`);
      assert((await verdict().textContent()).startsWith("Correct"), `${id}: verdict correct (${await verdict().textContent()})`);
      if (id === "BRDP-S1-00223") await panel().screenshot({ path: shot("mejoras-a-s1-00223-ipd.png") });
    }

    // ---- Part 2: S1-00177 split by schema ----
    await select("BRDP-S1-00177");
    await testRule();
    const sys177 = await lastSystem();
    assert(sys177.includes('- "process": examples where <commonInfo> is NOT inside <procedure>; way: dmodule/content/process/commonInfo')
      && sys177.includes('- "proced": examples where <commonInfo> is inside <procedure>; way: dmodule/content/procedure/commonInfo'), "S1-00177: the prompt says which example in which schema and by which way");
    const ex177 = await examples();
    assert(JSON.stringify(ex177.map((e) => [e.schema, e.result])) === '[["process","rejected ✓"],["proced","accepted ✓"]]', `S1-00177: rejected in process, accepted in proced (${JSON.stringify(ex177.map((e) => [e.schema, e.result]))})`);
    assert((await verdict().textContent()).startsWith("Correct"), "S1-00177: verdict correct");
    await panel().screenshot({ path: shot("mejoras-a-s1-00177-split.png") });

    // ---- Part 4: S1-00186 threshold explained ----
    await select("BRDP-S1-00186");
    await page.getByRole("button", { name: "Test rule" }).click();
    const desc = page.getByTestId("rule-test-description");
    await desc.waitFor({ timeout: 10000 });
    const descEn = await desc.textContent();
    assert(descEn.includes("<proceduralStep> must not be nested at level 7 or deeper (with more than 5 <proceduralStep> above it)"), `S1-00186 EN: level 7 (${descEn})`);
    await language("es");
    const descEs = await desc.textContent();
    assert(descEs.includes("<proceduralStep> no puede estar anidado a partir del nivel 7 (con más de 5 <proceduralStep> por encima)"), `S1-00186 ES: nivel 7 (${descEs})`);
    await panel().screenshot({ path: shot("mejoras-a-s1-00186-es.png") });
    await language("en");

    // ---- Part 3: Suggest Rule splits a two-path answer ----
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-MA-SUGGEST");
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    const note = page.getByTestId("rule-split-note").first();
    await note.waitFor({ timeout: 15000 });
    assert((await note.textContent()).includes("The app split the rule into 2 rules (one per <objectPath>)."), `Suggest Rule: split note EN (${await note.textContent()})`);
    await language("es");
    assert((await note.textContent()).includes("La app ha partido la regla en 2 reglas (una por <objectPath>)."), `Suggest Rule: split note ES (${await note.textContent()})`);
    await language("en");
    assert(!(await page.getByRole("button", { name: "Accept", exact: true }).isDisabled()), "Suggest Rule: Accept enabled after the split");
    await page.screenshot({ path: shot("mejoras-a-suggest-split.png"), fullPage: true });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForTimeout(800);
    const savedSuggest = await getRule(bSuggest);
    assert((savedSuggest.rule_xml.match(/<structureObjectRule\b/g) || []).length === 2 && (savedSuggest.rule_xml.match(/<objectPath\b/g) || []).length === 2, "Suggest Rule: saved as two <structureObjectRule>, one <objectPath> each");

    // ---- Part 3: Paste rule ----
    await select("BRDP-MA-PASTE");
    await fetch(`${MOCK}/reset`, { method: "POST" }).catch(() => {});
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    const pasteBox = page.getByPlaceholder(/Paste/);
    await pasteBox.waitFor({ timeout: 15000 });
    await pasteBox.fill(NOT_SPLITTABLE);
    await page.waitForTimeout(500);
    const acceptPasted = page.getByRole("button", { name: "Accept pasted rule" });
    assert(await acceptPasted.isDisabled(), "Paste rule, two paths and one use: Accept disabled");
    assert((await page.locator("text=/can only have one <objectPath>; this one has 2/").count()) >= 1, "Paste rule, not splittable: the reason is shown");
    await pasteBox.fill(TWO_PATHS);
    await page.waitForTimeout(500);
    const pastedNote = page.getByTestId("rule-split-note").last();
    assert((await pastedNote.textContent()).includes("The app split the rule into 2 rules (one per <objectPath>)."), "Paste rule: split note EN");
    await language("es");
    assert((await pastedNote.textContent()).includes("La app ha partido la regla en 2 reglas (una por <objectPath>)."), "Paste rule: split note ES");
    await page.screenshot({ path: shot("mejoras-a-paste-split-es.png"), fullPage: true });
    await language("en");
    assert(!(await acceptPasted.isDisabled()), "Paste rule: Accept enabled after the split");
    await acceptPasted.click();
    await page.waitForTimeout(800);
    const savedPaste = await getRule(bPaste);
    const ids = [...savedPaste.rule_xml.matchAll(/<structureObjectRule id="([^"]+)"/g)].map((m) => m[1]);
    assert(JSON.stringify(ids) === '["BRDP-MA-PASTE-1","BRDP-MA-PASTE-2"]' && savedPaste.source === "external_llm", `Paste rule: saved split, ids ${JSON.stringify(ids)}`);
    assert((savedPaste.rule_xml.match(/brSeverityLevel="brsl01"/g) || []).length === 2 && (savedPaste.rule_xml.match(/<brDecisionRef /g) || []).length === 2, "Paste rule: both rules keep brSeverityLevel and brDecisionRef");

    // PUT of a rule with two objectPath: 422.
    const put = await api(`/api/projects/${project.id}/brdps/${b186.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: TWO_PATHS, source: "manual", status: "pending_review" }) });
    assert(put.status === 422, `PUT with two objectPath: 422 (${put.status})`);
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
