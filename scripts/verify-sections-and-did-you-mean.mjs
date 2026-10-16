// Live verification for "Secciones de icnmetadata/comment/SCORM, «¿Quisiste
// decir…?» y remates":
//   - BRDP-EXT-00086 (//icnMetadataFile flag 0 in an icnmetadata context
//     block, CMP 4.2): no call to the LLM; the minimal icnmetadata document
//     -- with its <imfIdentAndStatusSection> -- rejected, one of another
//     schema accepted; verdict "Correct". Before: "Not executable".
//   - A rule on the comment's section (//commentStatus/commentResponse): the
//     comment schema is offered and the LLM is asked to write the comment's
//     identification and status section.
//   - "Did you mean…?": the EXT-00024 text ("The @footnoteMark attribute (if
//     used) must…") proposes nothing; "el atributo applicRefId debe
//     indicarse" still proposes @applicRefId.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to
// SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-sections-and-did-you-mean.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { keepAccountLanguage } from "./lib/seeds.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
// Gives the account back its language when the process exits (see lib/seeds.mjs).
keepAccountLanguage(ADMIN_EMAIL);
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

const inContext = (schema, body) => `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${schema}.xsd"><structureObjectRuleGroup>${body}</structureObjectRuleGroup></contextRules>`;
const EXT86 = inContext("icnmetadata", '<structureObjectRule id="BRDP-EXT-00086"><objectPath allowedObjectFlag="0">//icnMetadataFile</objectPath><objectUse>BREX-CMMST-00006: The icnmetadata schema is not allowed.</objectUse></structureObjectRule>');
const COMMENT = '<structureObjectRule id="BRDP-EXT-90001"><objectPath allowedObjectFlag="0">//commentStatus/commentResponse</objectPath><objectUse>A comment does not carry a response.</objectUse></structureObjectRule>';

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

  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Sections test ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  async function makeBrdp(fields, rule) {
    const b = await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
    if (rule) {
      const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/BREX-4.2`, {
        method: "PUT",
        body: JSON.stringify({ rule_xml: rule, source: "manual", status: "pending_review" }),
      });
      if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
    }
    return b;
  }
  await makeBrdp({ identifier: "BRDP-EXT-00086", title: "Use of the ICN metadata schema", definition: "Decide whether the ICN metadata schema is used.", proposal: "The icnmetadata schema shall not be used." }, EXT86);
  await makeBrdp({ identifier: "BRDP-EXT-90001", title: "Responses in comments", definition: "Decide whether comments carry a response.", proposal: "A comment shall not carry a response." }, COMMENT);
  await makeBrdp({ identifier: "BRDP-EXT-00024", title: "Footnote mark", definition: "Decide which mark is used for footnotes.", proposal: 'The @footnoteMark attribute (if used) must be set to "num".' });
  await makeBrdp({ identifier: "BRDP-EXT-90002", title: "Applicability reference", definition: "Decide whether the applicability is referenced.", proposal: "el atributo applicRefId debe indicarse" });
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
  const panel = () => page.getByTestId("rule-test-panel");
  const verdict = () => page.getByTestId("rule-test-verdict");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  const chatCalls = async () => (await fetch(`${MOCK}/chat-calls`).then((r) => r.json())).calls;
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForTimeout(600); // rule approval fetch
  }
  async function openTest(identifier) {
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select(identifier);
    await page.getByRole("button", { name: /^(Test rule|Probar regla)$/ }).click();
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 1. EXT-00086: the icnmetadata schema forbidden, tested without the LLM.
    await openTest("BRDP-EXT-00086");
    await verdict().waitFor({ timeout: 20000 });
    assert((await chatCalls()) === 0, "EXT-00086: no LLM call");
    const v86 = (await verdict().textContent()).trim();
    assert(v86.startsWith("Correct"), `EXT-00086: verdict correct (${v86})`);
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "EXT-00086: the minimal icnmetadata document rejected");
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("accepted ✓"), "EXT-00086: the document of another schema accepted");
    assert((await example(0).getByTestId("rule-test-minimal-document").textContent()).startsWith("Built by the application: the minimal icnmetadata document"), "EXT-00086: built by the application");
    assert(/<icnMetadataFile[^>]*>\s*<imfIdentAndStatusSection>/.test(await example(0).locator("pre").textContent()), "EXT-00086: the document has its <imfIdentAndStatusSection>");
    await panel().screenshot({ path: shot("sections-ext86-icnmetadata.png") });

    // 2. A rule on the comment's section: the comment schema is offered.
    await openTest("BRDP-EXT-90001");
    await verdict().waitFor({ timeout: 30000 });
    const req = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    const system = (req.messages || []).find((m) => m.role === "system")?.content || "";
    assert((await chatCalls()) > 0, "comment: the LLM is asked for examples");
    const examples = system;
    assert(examples.includes("comment's identification and status section"), "comment: the prompt asks for the comment's identification and status section");
    assert(/<commentStatus>/.test(examples), "comment: the minimal section in the prompt has <commentStatus>");
    const vComment = (await verdict().textContent()).trim();
    assert(vComment.startsWith("Correct"), `comment: verdict correct (${vComment})`);
    assert((await example(1).getByTestId("rule-test-result").textContent()).includes("rejected ✓"), "comment: the comment with a response rejected");
    await panel().screenshot({ path: shot("sections-comment-status.png") });
    await panel().getByRole("button", { name: "Close" }).click().catch(() => {});

    // 3. "Did you mean…?" never jumps over punctuation.
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-EXT-00024");
    await page.waitForTimeout(800);
    assert((await page.getByRole("button", { name: /^Did you mean/ }).count()) === 0, "EXT-00024: no Did you mean proposal (the parenthesis stops it)");
    assert((await page.getByRole("button", { name: /Did you mean <if>/ }).count()) === 0, "EXT-00024: no <if>");
    await page.screenshot({ path: shot("sections-ext24-no-did-you-mean.png") });
    await select("BRDP-EXT-90002");
    await page.waitForTimeout(800);
    assert((await page.getByRole("button", { name: "Did you mean @applicRefId?", exact: true }).count()) === 1, '"el atributo applicRefId debe indicarse": still proposes @applicRefId');
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
