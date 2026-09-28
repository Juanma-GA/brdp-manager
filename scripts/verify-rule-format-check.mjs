// Live verification for "Consolidación C2", Part 0: what is saved as a rule
// must contain a rule of the project's format -- in Paste rule, in the
// manual rule editor, and in PUT …/approvals/{format} (422). Real Vite +
// FastAPI + Postgres; only the Mistral transport is mocked
// (mock-mistral-chat-server.mjs / mock-mistral-embed-server.mjs, uvicorn
// started with MISTRAL_ENDPOINT / MISTRAL_EMBED_ENDPOINT pointing at them).
// Cleans up the projects it creates.
//
//     node scripts/verify-rule-format-check.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
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

const RULE_42 = (id) =>
  `<structureObjectRule id="${id}"><brDecisionRef brDecisionIdentNumber="${id}"/><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>`;
const NON_CONTEXT_42 = (id) => `<nonContextRule id="${id}"><simplePara>Follow the house style guide.</simplePara></nonContextRule>`;
const PATTERN = '<sch:pattern id="p1"><sch:rule context="note"><sch:assert id="a1" test="@type">Type.</sch:assert></sch:rule></sch:pattern>';

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Rule format ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const makeBrdp = (fields) =>
    api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ definition: "A definition.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
  const ruleUrl = (brdp) => `/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`;
  const getRule = (brdp) => api(ruleUrl(brdp)).then((r) => r.json());

  const paste = await makeBrdp({ identifier: "BRDP-RF-PASTE", title: "Frames", proposal: "Every <table> shall be framed on all sides." });
  const edit = await makeBrdp({ identifier: "BRDP-RF-EDIT", title: "Emphasis", proposal: "Emphasis shall not be used." });
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 80; i++) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // ---- backend: 422 with the reason ----
  const put = (rule_xml) => api(ruleUrl(edit), { method: "PUT", body: JSON.stringify({ rule_xml, source: "manual" }) });
  let r = await put("//&lt;emphasis&gt;");
  assert(r.status === 422 && (await r.json()).detail === "This is not a BREX 4.2 rule: structureObjectRule is missing", "PUT //&lt;emphasis&gt; -> 422 'structureObjectRule is missing'");
  r = await put(`<rules>${RULE_42("BRDP-RF-EDIT")}</rules>`);
  assert(r.status === 422 && /<rules> is not allowed around the rule/.test((await r.json()).detail), "PUT <rules>…</rules> -> 422 wrapper not allowed");
  r = await put(PATTERN);
  assert(r.status === 422 && /Schematron \(DITA\)/.test((await r.json()).detail), "PUT <sch:pattern> in a BREX project -> 422 other format");
  assert((await getRule(edit)) === null, "nothing saved by the rejected PUTs");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1300 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    const language = page.locator("header select, nav select").first();
    await language.selectOption("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    const select = async (identifier) => {
      await page.locator("tbody tr", { hasText: identifier }).first().click();
      await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
      await page.waitForTimeout(400);
    };
    const formatError = () => page.getByTestId("rule-format-error");

    // ---- Paste rule ----
    await select("BRDP-RF-PASTE");
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    await page.getByRole("button", { name: "Discard" }).waitFor({ timeout: 15000 });
    const pasteBox = page.getByPlaceholder(/Paste/);
    const acceptPasted = page.getByRole("button", { name: "Accept pasted rule" });

    const table = [
      ["//&lt;emphasis&gt;", false, "This is not a BREX 4.2 rule: structureObjectRule is missing"],
      [RULE_42("BRDP-RF-PASTE"), true, null],
      [NON_CONTEXT_42("BRDP-RF-PASTE"), true, null],
      [PATTERN, false, "<sch:pattern> belongs to a Schematron (DITA) rule, not to a BREX 4.2 rule"],
      [`<rules>${RULE_42("BRDP-RF-PASTE")}</rules>`, false, "<rules> is not allowed around the rule: write structureObjectRule directly"],
    ];
    for (const [xml, ok, message] of table) {
      await pasteBox.fill(xml);
      await page.waitForTimeout(250);
      const errorCount = await formatError().count();
      const disabled = await acceptPasted.isDisabled();
      if (ok) {
        assert(errorCount === 0 && !disabled, `Paste rule ${xml.slice(0, 40)}…: accepted, Accept enabled`);
      } else {
        const text = errorCount ? await formatError().first().textContent() : "";
        assert(errorCount === 1 && text === `⚠ ${message}` && disabled, `Paste rule ${xml.slice(0, 30)}…: red error "${message}", Accept disabled`);
        assert((await acceptPasted.getAttribute("title")) === "This is not a rule of the project's format — it cannot be saved", "  Accept tooltip gives the reason");
      }
    }
    await pasteBox.fill("//&lt;emphasis&gt;");
    await page.waitForTimeout(250);
    const color = await formatError().evaluate((el) => getComputedStyle(el).color);
    assert(color === "rgb(185, 28, 28)", `the format error is red (${color})`);
    await page.locator('[class*="suggestionBox"]').first().screenshot({ path: "/tmp/rule-format-paste-error.png" });
    console.log("Screenshot: /tmp/rule-format-paste-error.png");
    await language.selectOption("es");
    await page.waitForTimeout(300);
    assert((await formatError().first().textContent()) === "⚠ Esto no es una regla BREX 4.2: falta structureObjectRule", "Spanish: 'Esto no es una regla BREX 4.2: falta structureObjectRule'");
    await language.selectOption("en");
    await page.waitForTimeout(300);
    // A valid pasted rule still saves.
    await pasteBox.fill(RULE_42("BRDP-RF-PASTE"));
    await page.waitForTimeout(250);
    await acceptPasted.click();
    await page.waitForTimeout(800);
    const saved = await getRule(paste);
    assert(saved && saved.source === "external_llm" && saved.rule_xml === RULE_42("BRDP-RF-PASTE"), "a valid pasted rule is saved as Draft (external_llm)");

    // ---- Manual editor ----
    await select("BRDP-RF-EDIT");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator('[class*="ruleTextarea"]');
    const save = page.getByRole("button", { name: "Save", exact: true });
    const editorError = () => page.getByTestId("rule-editor-format-error");
    assert((await editorError().count()) === 0 && (await save.isDisabled()), "empty editor: no error shown, Save disabled");
    await editor.fill("//&lt;emphasis&gt;");
    await page.waitForTimeout(200);
    assert((await editorError().textContent()) === "⚠ This is not a BREX 4.2 rule: structureObjectRule is missing" && (await save.isDisabled()), "editor //&lt;emphasis&gt;: red error, Save disabled");
    await page.locator('[class*="ruleEditor"]').first().screenshot({ path: "/tmp/rule-format-editor-error.png" });
    await editor.fill(`<rules>${RULE_42("BRDP-RF-EDIT")}</rules>`);
    await page.waitForTimeout(200);
    assert(/<rules> is not allowed around the rule/.test(await editorError().textContent()) && (await save.isDisabled()), "editor <rules> wrapper: error with the reason, Save disabled");
    await editor.fill(PATTERN);
    await page.waitForTimeout(200);
    assert(/Schematron \(DITA\)/.test(await editorError().textContent()) && (await save.isDisabled()), "editor <sch:pattern> in BREX: format error, Save disabled");
    await editor.fill(NON_CONTEXT_42("BRDP-RF-EDIT"));
    await page.waitForTimeout(200);
    assert((await editorError().count()) === 0 && !(await save.isDisabled()), "editor with only <nonContextRule>: accepted, Save enabled");
    await save.click();
    await page.waitForTimeout(800);
    const editSaved = await getRule(edit);
    assert(editSaved && editSaved.rule_xml === NON_CONTEXT_42("BRDP-RF-EDIT") && editSaved.source === "manual", "editor saves the nonContextRule as Draft");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
    console.log("Cleaned up the seeded project.");
  }
  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
