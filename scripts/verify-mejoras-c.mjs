// Live verification for "Mejoras C del test de reglas" against the real app
// (Vite + FastAPI + Postgres); only the Mistral TRANSPORT is mocked
// (mock-mistral-chat-server.mjs). S1000D 3.0.1, the three real cases:
//   (a) BRDP-EXT-00013 -- <trade> inside <perscat> (it is a child of <reqpers>)
//   (b) BRDP-EXT-00087 -- /techstd as a document root (it lives in the status)
//   (c) BRDP-EXT-02613 -- /dmodule[not(//actref)]
// Part 1: amber warning and its fix button in Suggest Rule (b), Paste rule
//         (a) and the manual rule editor (b); the rule test of a) and b)
//         says "Review" with the reason, with no LLM call, and records it.
// Part 2: the prompt says where <actref> goes; the test of c) is correct.
// Part 3: the new descriptions of b) and c), EN and ES.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates.
//
//     node scripts/verify-mejoras-c.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const FORMAT = "BREX-3.0.1";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const objrule = (id, p, use, flag = null) => `<objrule id="${id}"><objpath${flag === null ? "" : ` objappl="${flag}"`}>${p}</objpath><objuse>${use}</objuse></objrule>`;
const PATH_A = "(/dmodule/content/schedule/deftask | /dmodule/content/proced)/prelreqs/reqpers/perscat/trade";
const RULE_A = objrule("BRDP-EXT-00013", PATH_A, "The trade of a required person shall be Mechanic or Electrician.").replace("</objuse>", '</objuse><objval valtype="single" val1="Mechanic"/><objval valtype="single" val1="Electrician"/>');
const RULE_B = objrule("BRDP-EXT-00087", "/techstd[not(authex) or not(notes)]", "A technical standard record shall always give its authority exceptions and its notes.", "0");
const RULE_C = objrule("BRDP-EXT-02613", "/dmodule[not(//actref)]", "Every data module shall reference its applicability cross-reference table.", "0");

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Mejoras C ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());

  async function makeBrdp(fields) {
    return api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ definition: "Decide how the data is written.", validation: "Validated", ...fields }),
    }).then((r) => r.json());
  }
  async function putDraft(brdp, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }),
    });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const getRule = (brdp) => api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`).then((r) => r.json());

  const bA = await makeBrdp({ identifier: "BRDP-EXT-00013", title: "Trades of the required persons", proposal: "The trade of a required person shall be Mechanic or Electrician." });
  const bB = await makeBrdp({ identifier: "BRDP-EXT-00087", title: "Technical standard record", proposal: "A technical standard record shall always give its authority exceptions and its notes." });
  const bC = await makeBrdp({ identifier: "BRDP-EXT-02613", title: "ACT reference", proposal: "Every data module shall reference its applicability cross-reference table." });
  await makeBrdp({ identifier: "BRDP-MC-SUGGEST", title: "Technical standard record (suggested)", proposal: "The <techstd> record shall always give its authority exceptions and its notes." });
  await makeBrdp({ identifier: "BRDP-MC-PASTE", title: "Trades (pasted)", proposal: "The trade of a required person shall be Mechanic or Electrician." });
  await makeBrdp({ identifier: "BRDP-MC-EDIT", title: "Technical standard record (editor)", proposal: "A technical standard record shall always give its authority exceptions and its notes." });
  await putDraft(bA, RULE_A);
  await putDraft(bB, RULE_B);
  await putDraft(bC, RULE_C);
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
  const llmCalls = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") llmCalls.push(req.postData() || "");
  });
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

    // ---- Part 1: test of a) -- review, no LLM call, recorded ----
    await select("BRDP-EXT-00013");
    const draftWarnA = page.getByTestId("rule-test-path-warning");
    await testRule();
    const vA = await verdict().textContent();
    assert(vA.startsWith("Review: The path cannot exist: <trade> does not go inside <perscat>; it goes inside <reqpers>."), `a) verdict review with the reason (${vA})`);
    assert(llmCalls.length === 0, `a) no LLM call (${llmCalls.length})`);
    assert((await draftWarnA.count()) === 0, "a) the reason is in the verdict, not repeated as a warning");
    await panel().screenshot({ path: shot("mejoras-c-test-a-review.png") });
    const savedA = await getRule(bA);
    assert(savedA.last_test_result === "review" && savedA.last_test_reason?.code === "test_impossible_path", `a) recorded as review (${savedA.last_test_result}, ${savedA.last_test_reason?.code})`);
    const indicatorA = page.getByTestId("rule-test-indicator");
    assert((await indicatorA.textContent()).includes("Review"), `a) indicator (${await indicatorA.textContent()})`);
    await language("es");
    const vAes = await verdict().textContent();
    assert(vAes.startsWith("Revisar: La ruta no puede existir: <trade> no va dentro de <perscat>; va dentro de <reqpers>."), `a) verdict ES (${vAes})`);
    await panel().screenshot({ path: shot("mejoras-c-test-a-review-es.png") });
    await language("en");

    // ---- Part 1 + 3: test of b) -- review before the LLM; description ----
    await select("BRDP-EXT-00087");
    await testRule();
    const vB = await verdict().textContent();
    assert(vB.startsWith("Review: <techstd> is never the root of a document; it goes in dmodule/idstatus/status."), `b) verdict review with the reason (${vB})`);
    assert(llmCalls.length === 0, `b) no LLM call (${llmCalls.length})`);
    const descB = page.getByTestId("rule-test-description");
    assert((await descB.textContent()).includes("<techstd> without <authex> or without <notes> must not appear"), `b) description EN (${await descB.textContent()})`);
    await language("es");
    assert((await descB.textContent()).includes("<techstd> sin <authex> o sin <notes> no puede aparecer"), `b) description ES (${await descB.textContent()})`);
    assert((await verdict().textContent()).startsWith("Revisar: <techstd> nunca es la raíz de un documento; va en dmodule/idstatus/status."), `b) verdict ES (${await verdict().textContent()})`);
    await panel().screenshot({ path: shot("mejoras-c-test-b-review-es.png") });
    await language("en");

    // ---- Parts 2 + 3: test of c) -- prompt says where <actref> goes ----
    await select("BRDP-EXT-02613");
    await testRule();
    const prompts = llmCalls.join("\n");
    assert(prompts.includes("<actref> goes inside <status> (dmodule/idstatus/status), after <orig> and before <applic>."), "c) the prompt says where <actref> goes");
    const vC = await verdict().textContent();
    assert(vC.startsWith("Correct"), `c) verdict correct (${vC})`);
    const descC = page.getByTestId("rule-test-description");
    assert((await descC.textContent()).includes("Every document must contain at least one <actref>"), `c) description EN (${await descC.textContent()})`);
    await language("es");
    assert((await descC.textContent()).includes("Todo documento debe contener algún <actref>"), `c) description ES (${await descC.textContent()})`);
    await panel().screenshot({ path: shot("mejoras-c-test-c-es.png") });
    await language("en");

    // ---- Part 1: Suggest Rule -- warning and "Change /techstd to //techstd" ----
    await select("BRDP-MC-SUGGEST");
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    const sWarn = page.getByTestId("suggested-rule-path-warning");
    await sWarn.first().waitFor({ timeout: 20000 });
    assert((await sWarn.first().textContent()).includes("<techstd> is never the root of a document; it goes in dmodule/idstatus/status."), `suggested: warning (${await sWarn.first().textContent()})`);
    const sFix = page.getByTestId("suggested-rule-path-warning-fix");
    assert((await sFix.textContent()) === "Change /techstd to //techstd", `suggested: fix button (${await sFix.textContent()})`);
    await language("es");
    assert((await sFix.textContent()) === "Cambiar /techstd por //techstd", `suggested: fix button ES (${await sFix.textContent()})`);
    await page.screenshot({ path: shot("mejoras-c-suggest-warning-es.png"), fullPage: true });
    await language("en");
    await sFix.click();
    await page.waitForTimeout(400);
    assert((await sWarn.count()) === 0, "suggested: warning gone after the fix");
    const sNote = page.getByTestId("suggested-rule-path-warning-fixed");
    assert((await sNote.count()) === 1 && (await sNote.textContent()).includes("Path changed: /techstd → //techstd."), `suggested: note (${(await sNote.count()) ? await sNote.textContent() : "none"})`);
    await page.getByRole("button", { name: "Accept", exact: true }).first().click();
    await page.waitForTimeout(800);
    const savedSuggest = await api(`/api/projects/${project.id}/brdps`).then((r) => r.json()).then(async (list) => getRule(list.find((b) => b.identifier === "BRDP-MC-SUGGEST")));
    assert(savedSuggest.rule_xml.includes("//techstd[not(authex) or not(notes)]") && !savedSuggest.rule_xml.includes(">/techstd"), `suggested: accepted with the fixed path (${savedSuggest.rule_xml})`);

    // ---- Part 1: Paste rule -- warning and "Remove <perscat> from the path" ----
    await select("BRDP-MC-PASTE");
    await page.getByRole("button", { name: "Suggest Rule" }).click();
    const pasteBox = page.getByPlaceholder(/Paste/);
    await pasteBox.waitFor({ timeout: 15000 });
    await pasteBox.fill(RULE_A.replaceAll("BRDP-EXT-00013", "BRDP-MC-PASTE"));
    await page.waitForTimeout(600);
    const pWarn = page.getByTestId("pasted-rule-path-warning");
    assert((await pWarn.count()) === 1 && (await pWarn.textContent()).includes("The path cannot exist: <trade> does not go inside <perscat>; it goes inside <reqpers>."), `pasted: warning (${(await pWarn.count()) ? await pWarn.textContent() : "none"})`);
    const pFix = page.getByTestId("pasted-rule-path-warning-fix");
    assert((await pFix.textContent()) === "Remove <perscat> from the path", `pasted: fix button (${await pFix.textContent()})`);
    await language("es");
    assert((await pFix.textContent()) === "Quitar <perscat> de la ruta", `pasted: fix button ES (${await pFix.textContent()})`);
    await language("en");
    await pFix.click();
    await page.waitForTimeout(400);
    const pasted = await pasteBox.inputValue();
    assert(pasted.includes("/prelreqs/reqpers/trade</objpath>") && !pasted.includes("perscat"), `pasted: text fixed (${pasted})`);
    assert((await pWarn.count()) === 0, "pasted: warning gone after the fix");
    await page.screenshot({ path: shot("mejoras-c-paste-fixed.png"), fullPage: true });

    // ---- Part 1: manual editor ----
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-MC-EDIT");
    await page.getByRole("button", { name: "Edit", exact: true }).last().click();
    const editor = page.getByPlaceholder("Paste or write the rule text (raw XML/Schematron)…");
    await editor.waitFor({ timeout: 5000 });
    await editor.fill(RULE_B.replaceAll("BRDP-EXT-00087", "BRDP-MC-EDIT"));
    await page.waitForTimeout(600);
    const eWarn = page.getByTestId("rule-editor-path-warning");
    assert((await eWarn.count()) === 1 && (await eWarn.textContent()).includes("<techstd> is never the root of a document"), `editor: warning (${(await eWarn.count()) ? await eWarn.textContent() : "none"})`);
    assert((await editor.inputValue()).includes(">/techstd["), "editor: nothing changed before clicking");
    await page.getByTestId("rule-editor-path-warning-fix").click();
    await page.waitForTimeout(300);
    assert((await editor.inputValue()).includes(">//techstd["), `editor: fixed (${await editor.inputValue()})`);
    assert((await eWarn.count()) === 0, "editor: warning gone after the fix");
    await page.screenshot({ path: shot("mejoras-c-editor-fixed.png"), fullPage: true });
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
