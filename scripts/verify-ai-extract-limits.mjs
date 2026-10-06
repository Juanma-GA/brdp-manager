// Live verification for AACF 1, Part 4 (no silent cuts), against the real
// app (Vite + FastAPI + Postgres), without the AI: the free-text job is
// driven through the API (the decisions the AI would return are posted
// directly) and the rows' texts are written by hand, so the page never
// needs to call the AI.
//
//   - A long quote is stored whole and shown folded ("Show more").
//   - A title over the BRDP limit is kept whole, with "Title too long:
//     shorten it", and blocks the import of that row until shortened.
//   - A quote over the quote limit: that decision is left out, with a
//     file warning naming it -- never cut.
//   - Compare, "Another BRDP of this project": with more than 50 results,
//     "50 of N" + "Show more", never a silent cut at 50.
//
//     node scripts/verify-ai-extract-limits.mjs
import { chromium } from "playwright-core";
import { SHOTS_DIR } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const SHOTS = SHOTS_DIR;

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF1 limits ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const base = `/api/projects/${project.id}/ai-extract`;

  // The text: a decision with a long quote (over 600 characters), one whose
  // title is over the BRDP title limit, and one whose quote is over the
  // quote limit (20000 characters).
  const longQuote = `Warnings shall always be placed before the step they apply to, ${"and the reader must see them before acting on the equipment ".repeat(12)}without exception.`;
  const shortQuote = "Each procedural step shall contain only one action.";
  const hugeQuote = `Table cells ${"abcdef ".repeat(2900)}end.`;
  const text = [longQuote, shortQuote, hugeQuote].join("\n\n");
  const longTitle = `Title ${"x".repeat(2100)}`;
  const started = await api(`${base}/text`, { method: "POST", body: JSON.stringify({ text, filename: "" }) }).then((r) => r.json());
  const jobId = started.job_id;
  await api(`${base}/jobs/${jobId}/decisions`, {
    method: "POST",
    body: JSON.stringify({
      decisions: [
        { quote: longQuote, title: "Warnings before the step" },
        { quote: shortQuote, title: longTitle },
        { quote: hugeQuote, title: "Huge table" },
      ],
    }),
  });
  let job;
  for (let i = 0; i < 60; i += 1) {
    job = await api(`${base}/jobs/${jobId}`).then((r) => r.json());
    if (job.status !== "running" && job.status !== "awaiting_decisions") break;
    await sleep(500);
  }
  let { candidates } = await api(`${base}/jobs/${jobId}/candidates`).then((r) => r.json());
  console.log("1. Server");
  assert(candidates.length === 2, `the huge quote is left out (${candidates.length} candidates)`);
  assert((job.warnings || []).some((w) => w.code === "quotes_too_long"), "a file warning names it");
  const quoted = candidates.find((c) => c.title === "Warnings before the step");
  assert(quoted?.quote === longQuote, `the long quote is stored whole (${quoted?.quote?.length} characters)`);
  const titled = candidates.find((c) => c.title?.startsWith("Title "));
  assert(titled?.title === longTitle, `the long title is stored whole (${titled?.title?.length} characters)`);
  assert(titled?.too_long?.some((x) => x.field === "title"), "the long title is marked too long");
  // Texts by hand, so the page never needs the AI.
  await api(`${base}/jobs/${jobId}/candidates`, {
    method: "PATCH",
    body: JSON.stringify({
      items: candidates.map((c) => ({ key: c.key, definition: `Decide ${c.key}.`, proposal: `Proposal ${c.key}.`, selected: true })),
    }),
  });
  const refused = await api(`${base}/jobs/${jobId}/apply`, { method: "POST", body: JSON.stringify({ keys: candidates.map((c) => c.key), import_as: "pending" }) });
  const refusedBody = await refused.json();
  assert(refused.status === 409 && refusedBody.detail?.code === "texts_too_long", `the server refuses importing it (${refused.status} ${refusedBody.detail?.code})`);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");

    console.log("2. AI Extract table");
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.getByTestId("rule-extract-row").first().waitFor({ timeout: 15000 });
    const fileWarnings = await page.getByTestId("rule-extract-file-warnings").textContent();
    assert(/1 decisions left out: their quote is over 20000 characters/.test(fileWarnings) && /«Huge table»/.test(fileWarnings), "the left-out decision is named");
    const quoteRow = page.getByTestId("rule-extract-row").filter({ hasText: "Warnings before the step" });
    await quoteRow.getByTestId("rule-extract-quote-summary").click();
    const folded = await quoteRow.getByTestId("rule-extract-quote").textContent();
    assert(folded.length < longQuote.length && folded.endsWith("…"), `a long quote is shown folded (${folded.length} characters)`);
    await quoteRow.getByTestId("rule-extract-quote-more").click();
    assert((await quoteRow.getByTestId("rule-extract-quote").textContent()) === longQuote, "Show more: the whole quote");
    assert((await quoteRow.getByTestId("rule-extract-quote-more").textContent()) === "Show less", "and Show less");
    const titleRow = page.getByTestId("rule-extract-row").filter({ hasText: "Title too long" });
    assert((await titleRow.count()) === 1, 'the row says "Title too long … shorten it"');
    assert(/Title too long \(2106 characters; the limit is 2000\): shorten it\./.test(await titleRow.textContent()), "with its length and the limit");
    const apply = page.getByTestId("rule-extract-apply");
    assert(await apply.isDisabled(), "the import is blocked");
    assert(/1 checked rows have a text over its limit/.test(await page.getByTestId("rule-extract-blocked").textContent()), "and says why");
    await page.getByTestId("rule-extract-show-blocking").click();
    assert((await page.getByTestId("rule-extract-row").count()) === 1, "Show them: that row");
    await page.screenshot({ path: `${SHOTS}/ai-extract-title-too-long.png` });
    const titleInput = page.getByTestId("rule-extract-row").first().locator("textarea, input[type=text]").first();
    await titleInput.fill("Only one action per step");
    await titleInput.blur();
    await page.getByTestId("rule-extract-blocked").waitFor({ state: "detached", timeout: 5000 });
    assert(!(await apply.isDisabled()), "shortened: the import is possible");
    await apply.click();
    await page.getByTestId("rule-extract-result").waitFor({ timeout: 10000 });
    const brdps = await api(`/api/projects/${project.id}/brdps`).then((r) => r.json());
    assert(brdps.some((b) => b.title === "Only one action per step"), "imported with the shortened title");

    console.log("3. Spanish");
    await page.locator("header select, nav select").first().selectOption("es");
    // A fresh job to see the warning again, in Spanish.
    const again = await api(`${base}/text`, { method: "POST", body: JSON.stringify({ text: shortQuote, filename: "" }) }).then((r) => r.json());
    await api(`${base}/jobs/${again.job_id}/decisions`, { method: "POST", body: JSON.stringify({ decisions: [{ quote: shortQuote, title: longTitle }] }) });
    for (let i = 0; i < 60; i += 1) {
      const j = await api(`${base}/jobs/${again.job_id}`).then((r) => r.json());
      if (j.status !== "running" && j.status !== "awaiting_decisions") break;
      await sleep(500);
    }
    ({ candidates } = await api(`${base}/jobs/${again.job_id}/candidates`).then((r) => r.json()));
    await api(`${base}/jobs/${again.job_id}/candidates`, {
      method: "PATCH",
      body: JSON.stringify({ items: candidates.map((c) => ({ key: c.key, definition: "Decidir.", proposal: "Propuesta.", selected: true })) }),
    });
    await page.reload();
    await page.getByTestId("rule-extract-row").first().waitFor({ timeout: 15000 });
    assert(/Título demasiado largo \(2106 caracteres; el límite es 2000\): acórtalo\./.test(await page.getByTestId("rule-extract-row").first().textContent()), '"Título demasiado largo: acórtalo"');
    await page.screenshot({ path: `${SHOTS}/ai-extract-title-too-long-es.png` });

    console.log("4. Compare: more than 50 results");
    await page.locator("header select, nav select").first().selectOption("en");
    for (let i = 0; i < 60; i += 1) {
      await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: `BRDP-EXT-${String(90000 + i)}`, title: `Bulk ${i}` }) });
    }
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr");
    await page.locator("tbody tr").first().click();
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.getByTestId("compare-project-search").waitFor({ timeout: 5000 }).catch(async () => {
      await page.getByRole("button", { name: "Another BRDP of this project" }).click();
    });
    await page.getByTestId("compare-project-search").waitFor({ timeout: 5000 });
    const total = brdps.length + 60 - 1;
    assert((await page.getByTestId("compare-project-candidate").count()) === 50, "50 shown");
    assert((await page.getByTestId("compare-project-more").textContent()).includes(`50 of ${total}.`), `"50 of ${total}"`);
    await page.getByTestId("compare-project-show-more").click();
    assert((await page.getByTestId("compare-project-candidate").count()) === total, `Show more: all ${total}`);
    assert((await page.getByTestId("compare-project-more").count()) === 0, "no more to show");
    await page.getByTestId("compare-project-search").fill("Bulk 5");
    assert((await page.getByTestId("compare-project-candidate").count()) === 11, "a search shows its own results (Bulk 5, 50–59)");
    await page.screenshot({ path: `${SHOTS}/compare-show-more.png` });
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
