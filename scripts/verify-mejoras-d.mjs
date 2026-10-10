// Live verification for "Mejoras D" against the real app (Vite + FastAPI +
// Postgres); only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
// S1000D 3.0.1, the two real rules:
//   (A) BRDP-EXT-02816 //figure//legend/deflist/def[not(normalize-space(.) =
//       ancestor::figure//graphic//hotspot/@title)] -- the test writes the
//       examples in <para0> (where <figure> goes), they run, and the
//       description says the condition (Part 1);
//   (B) BRDP-EXT-02815 //figure//legend/deflist/term[not(. =
//       //figure//graphic//hotspot/@apsname)] -- the "any <figure>" warning,
//       EN and ES, in the test panel and in the rule editor, whose button
//       changes //figure to ancestor::figure (Part 2).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates.
//
//     node scripts/verify-mejoras-d.mjs
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

const RULE_A = '<objrule id="XML-R-2828"><objpath objappl="0">//figure//legend/deflist/def[not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)]</objpath><objuse>Prohibir &lt;def&gt; que no coincida con ningun @title de los elementos de tipo &lt;hotspot&gt; de su &lt;figure&gt;</objuse></objrule>';
const RULE_B = '<objrule id="XML-R-2826"><objpath objappl="0">//figure//legend/deflist/term[not(. = //figure//graphic//hotspot/@apsname)]</objpath><objuse>Prohibir &lt;term&gt; que no coincida con algun atributo @apsname de los elementos de tipo &lt;hotspot&gt; de su &lt;figure&gt;</objuse></objrule>';
const WARN_EN = "The condition looks at the <hotspot> of any <figure> in the document, not only those of the <figure> that contains <term>. If the decision speaks of «its» <figure>, use ancestor::figure.";
const WARN_ES = "La condición mira los <hotspot> de cualquier <figure> del documento, no solo los del <figure> que contiene a <term>. Si la decisión habla de «su» <figure>, usa ancestor::figure.";

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Mejoras D ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());
  const makeBrdp = (fields) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ definition: "Decidir qué admite la leyenda de una figura.", validation: "Validated", ...fields }) }).then((r) => r.json());
  async function putDraft(brdp, rule_xml) {
    const r = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`, { method: "PUT", body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }) });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  const bA = await makeBrdp({ identifier: "BRDP-EXT-02816", title: "Definiciones de la leyenda", proposal: "No se admite ningún <def> que no coincida con ningun @title de los elementos de tipo <hotspot> de su <figure>." });
  const bB = await makeBrdp({ identifier: "BRDP-EXT-02815", title: "Términos de la leyenda", proposal: "No se admite ningún <term> que no coincida con algun atributo @apsname de los elementos de tipo <hotspot> de su <figure>." });
  await makeBrdp({ identifier: "BRDP-MD-EDIT", title: "Términos (editor)", proposal: "No se admite ningún <term> que no coincida con algun atributo @apsname de los elementos de tipo <hotspot> de su <figure>." });
  await putDraft(bA, RULE_A);
  await putDraft(bB, RULE_B);
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
  const prompts = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") prompts.push(req.postData() || "");
  });
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

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // ---- Part 1: the test of rule A ----
    await select("BRDP-EXT-02816");
    prompts.length = 0;
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    // the request body of the examples call (its JSON text holds the prompt)
    const system = prompts.find((p) => p.includes("Write the test examples for this rule.")) || "";
    assert(system.includes("your content goes directly inside <para0>"), "A: the prompt places the content in <para0>");
    assert(system.includes("The rule's path, written from <para0>: para0/figure/legend/deflist/def."), "A: the prompt gives the whole way");
    const v = await verdict().textContent();
    assert(v.startsWith("Correct"), `A: verdict correct, the examples ran (${v})`);
    const notRun = await page.getByText(/Not run:/).count();
    assert(notRun === 0, `A: no example left unrun (${notRun})`);
    const desc = await page.getByTestId("rule-test-description").textContent();
    assert(desc.includes("<def> matching the condition [not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)] must not appear"), `A: description with the condition EN (${desc})`);
    assert((await page.getByTestId("rule-test-path-warning").count()) === 0, "A: no any-<figure> warning (it already uses ancestor::figure)");
    await page.getByTestId("rule-test-panel").screenshot({ path: shot("mejoras-d-rule-a-test.png") });
    await language("es");
    const descEs = await page.getByTestId("rule-test-description").textContent();
    assert(descEs.includes("<def> que cumpla la condición [not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)] no puede aparecer"), `A: description ES (${descEs})`);
    await language("en");

    // ---- Part 2: rule B in the test panel (warning, no button) ----
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-EXT-02815");
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    const tWarn = page.getByTestId("rule-test-path-warning");
    assert((await tWarn.count()) === 1 && (await tWarn.textContent()).includes(WARN_EN), `B: test panel warning EN (${(await tWarn.count()) ? await tWarn.textContent() : "none"})`);
    assert((await page.getByTestId("rule-test-path-warning-fix").count()) === 0, "B: no fix button in the test panel");
    const vB = await verdict().textContent();
    assert(!vB.startsWith("Review: The path"), `B: the warning does not change the verdict (${vB})`);
    await language("es");
    assert((await tWarn.textContent()).includes(WARN_ES), `B: test panel warning ES (${await tWarn.textContent()})`);
    await page.getByTestId("rule-test-panel").screenshot({ path: shot("mejoras-d-rule-b-warning-es.png") });
    await language("en");

    // ---- Part 2: rule B in the manual editor (warning + button) ----
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-MD-EDIT");
    await page.getByRole("button", { name: "Edit", exact: true }).last().click();
    const editor = page.getByPlaceholder("Paste or write the rule text (raw XML/Schematron)…");
    await editor.waitFor({ timeout: 5000 });
    await editor.fill(RULE_B);
    await page.waitForTimeout(600);
    const eWarn = page.getByTestId("rule-editor-path-warning");
    assert((await eWarn.count()) === 1 && (await eWarn.textContent()).includes(WARN_EN), `editor: warning (${(await eWarn.count()) ? await eWarn.textContent() : "none"})`);
    const fix = page.getByTestId("rule-editor-path-warning-fix");
    assert((await fix.textContent()) === "Change //figure//graphic//hotspot/@apsname to ancestor::figure//graphic//hotspot/@apsname", `editor: fix button (${await fix.textContent()})`);
    await page.screenshot({ path: shot("mejoras-d-editor-warning.png"), fullPage: true });
    await fix.click();
    await page.waitForTimeout(300);
    const fixed = await editor.inputValue();
    assert(fixed.includes("//figure//legend/deflist/term[not(. = ancestor::figure//graphic//hotspot/@apsname)]</objpath>"), `editor: fixed (${fixed})`);
    assert(fixed.includes("de su &lt;figure&gt;</objuse>"), "editor: objuse untouched");
    assert((await eWarn.count()) === 0, "editor: warning gone after the fix");
    const saveEnabled = await page.getByRole("button", { name: "Save", exact: true }).last().isEnabled();
    assert(saveEnabled, "editor: the warning never blocks saving");
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
