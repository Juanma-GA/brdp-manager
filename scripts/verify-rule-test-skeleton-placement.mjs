// Live verification for "Remates" Part 1: BRDP-EXT-00043 (CMP 4.2, a
// correct rule: <levelledParaAlts> only directly inside <description>). The
// application writes the examples' content inside the skeleton's
// <levelledPara>, so the example meant to be accepted always ends up inside
// one and the rule rejects it. The panel says "Inconclusive" for that
// reason (never "Test failed", no "regenerate" hint), with a note under the
// example, in EN and ES; recorded as inconclusive with its reason. Only the
// Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to
// SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-rule-test-skeleton-placement.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
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

// The real rule (CMP 4.2), only the id added.
const EXT43 =
  '<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/descript.xsd"><structureObjectRuleGroup><structureObjectRule id="BRDP-EXT-00043"><objectPath allowedObjectFlag="0">//description//levelledPara/levelledParaAlts</objectPath><objectUse>The &lt;levelledParaAlts&gt; element can only be used directly inside the &lt;description&gt; element.</objectUse></structureObjectRule></structureObjectRuleGroup></contextRules>';
const VERDICT_EN =
  "Inconclusive: the rule rejects an example meant to be accepted only because the application builds it inside <levelledPara>; written directly in <description>, the rule accepts it. This test says nothing about the rule.";
const NOTE_EN = "The application builds this example inside <levelledPara> (dimmed part), and the rule rejects it for that. Written directly in <description>, the rule accepts it.";
const NOTE_ES = "La app monta este ejemplo dentro de <levelledPara> (parte atenuada), y la regla lo rechaza por eso. Escrito directamente en <description>, la regla lo acepta.";

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Skeleton rule test ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const brdp = await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({ validation: "Validated", identifier: "BRDP-EXT-00043", title: "Alternative levelled paragraphs", definition: "Decide where the <levelledParaAlts> element may be used.", proposal: "The <levelledParaAlts> element can only be used directly inside the <description> element." }),
  }).then((r) => r.json());
  const seeded = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: EXT43, source: "manual", status: "pending_review" }),
  });
  if (!seeded.ok) throw new Error(`seeding rule failed: ${seeded.status} ${await seeded.text()}`);
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
  const language = (lng) => page.locator("header select, nav select").first().selectOption(lng);

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-EXT-00043" }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Test rule" }).click();
    await verdict().waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);

    const v = (await verdict().textContent()).trim();
    assert(v.includes(VERDICT_EN), `verdict inconclusive for the skeleton (${v})`);
    assert(!/Test failed/i.test(v), "never 'Test failed'");
    assert((await page.getByTestId("rule-test-cause").count()) === 0 && !/[Rr]egenerate the examples/.test(await panel().textContent()), "no 'regenerate the examples' hint");
    const notes = page.getByTestId("rule-test-skeleton-placement");
    assert((await notes.count()) === 1, `one note, under the example meant to be accepted (${await notes.count()})`);
    assert((await example(0).getByTestId("rule-test-skeleton-placement").textContent()).trim() === NOTE_EN, "the note's text in EN");
    assert((await example(0).getByTestId("rule-test-result").textContent()).includes("rejected"), "the example as shown: rejected");
    const xml0 = await example(0).locator("pre").textContent();
    assert(/<levelledPara>\s*<levelledParaAlts>/.test(xml0), "the document shown is the one built (inside the skeleton's <levelledPara>)");
    const indicator = (await page.getByTestId("rule-test-indicator").textContent()).trim();
    assert(/Inconclusive/i.test(indicator), `recorded as inconclusive (${indicator})`);
    await panel().screenshot({ path: shot("rule-test-skeleton-placement-en.png") });

    await language("es");
    await page.waitForTimeout(400);
    assert((await example(0).getByTestId("rule-test-skeleton-placement").textContent()).trim() === NOTE_ES, "the note's text in ES");
    assert(/^No concluyente: .*<levelledPara>.*<description>/.test((await verdict().textContent()).trim()), "verdict in ES");
    await panel().screenshot({ path: shot("rule-test-skeleton-placement-es.png") });
    await language("en");

    const approval = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`).then((r) => r.json());
    assert(approval.last_test_result === "inconclusive" && approval.last_test_reason?.code === "test_skeleton_placement" && approval.last_test_reason.params?.at === "description", `recorded: ${approval.last_test_result} ${JSON.stringify(approval.last_test_reason)}`);
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
