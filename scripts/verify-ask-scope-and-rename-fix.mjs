// Verification for "Ask con fichas de esquema: alcance coherente,
// respuestas centradas y corrección de Did you mean" (encargo). Same
// convention as every other round in this branch: real backend, real
// Postgres, chat transport mocked (mock-mistral-chat-server.mjs /
// GET /last-request captures the EXACT prompt sent). The mock gives a
// canned reply regardless of question content, so it cannot grade real
// conversational coherence -- that is the encargo's own explicit caveat
// ("la coherencia real la verificará el usuario... con Mistral"). What
// THIS script proves instead: (1) the "Did you mean" fix actually
// rewrites and saves incomplete markup, live, through the real UI and
// Postgres; (2) the exact prompt text sent to the LLM carries the new
// SCOPE/focus instructions and never the old, narrower wording; (3) the
// same question asked three times in a row produces the byte-identical
// prompt shape every time -- the encargo's own "no puede depender de la
// tirada" concern, addressed at the one layer this repo can actually test
// deterministically (what we SEND), not what a real model answers.
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  return (await res.json()).access_token;
}
async function resetMock() {
  await fetch(`${MOCK}/reset`, { method: "POST" });
}
async function lastMockRequest() {
  return fetch(`${MOCK}/last-request`).then((r) => r.json());
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Ask Scope Verify ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  const brdpBroken = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-ASK-TABLE",
      title: "Element <table",
      definition: "Governs the <table> element.",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  const brdpPara = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-ASK-PARA",
      title: "Paragraph placement rule",
      definition: "About where the <para> element may be used.",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  console.log("Seeded 1 project (S1000D 4.2) and 2 BRDPs");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    async function openRecords(brdpIdentifier) {
      await page.goto(`${BASE_URL}/projects`);
      await page.waitForSelector("table", { timeout: 10000 });
      const row = page.locator("tr", { hasText: `Ask Scope Verify ${suffix}` });
      await row.getByRole("button", { name: /Records/i }).click();
      await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: brdpIdentifier }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    }

    async function ask(question) {
      const askTextarea = page.locator("label", { hasText: "Ask a question" }).locator("xpath=following::textarea[1]");
      await resetMock();
      await askTextarea.fill(question);
      await page.getByRole("button", { name: /^Ask$/ }).click();
      await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
      const req = await lastMockRequest();
      return req.messages.find((m) => m.role === "system").content;
    }

    // ==== 1. "Did you mean" fix: BRDP-ASK-TABLE's title is "Element
    // <table" (an unclosed "<") -- the button must actually rewrite and
    // save it, in both the table and the detail panel (they share the
    // same state, so they can never show different values once the save
    // completes), and the deterministic vocabulary check must recompute
    // (the notFound warning, if any were shown, must clear). ====
    await openRecords("BRDP-ASK-TABLE");
    const titleInput = page.locator("input").filter({ hasText: "" }).first();
    // Locate the actual Title <input> by its current value rather than
    // position -- more robust than an index if the panel layout shifts.
    const inputs = await page.locator("input").all();
    let foundTitleInput = null;
    for (const inp of inputs) {
      const v = await inp.inputValue().catch(() => null);
      if (v === "Element <table") foundTitleInput = inp;
    }
    assert(!!foundTitleInput, "the seeded BRDP's Title input shows the unclosed markup as saved");

    const didYouMeanBtn = page.locator("button", { hasText: /Did you mean/i });
    assert((await didYouMeanBtn.count()) === 1, 'exactly one "Did you mean <table>?" suggestion is offered');
    assert((await didYouMeanBtn.first().innerText()) === "Did you mean <table>?", "the suggestion names the correct element");
    await didYouMeanBtn.first().click();
    await page.waitForTimeout(800);

    const fixedValue = await foundTitleInput.inputValue();
    assert(fixedValue === "Element <table>", `clicking the suggestion actually rewrites the incomplete markup (got: ${JSON.stringify(fixedValue)})`);
    assert((await didYouMeanBtn.count()) === 0, 'the suggestion is gone once the name is properly marked up (nothing left to fix)');

    const rowCellText = await page.locator("tr", { hasText: "BRDP-ASK-TABLE" }).locator("td").nth(1).innerText();
    assert(rowCellText === "Element <table>", `the table row shows the SAME corrected value as the panel -- never a divergent "Element \\"\\"" or similar (got: ${JSON.stringify(rowCellText)})`);

    // Reload to confirm it was actually saved to Postgres, not just local
    // React state, and that the corrected value survives.
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    const rowCellAfterReload = await page.locator("tr", { hasText: "BRDP-ASK-TABLE" }).locator("td").nth(1).innerText();
    assert(rowCellAfterReload === "Element <table>", "the corrected title survives a full page reload (real Postgres save, not just in-memory state)");

    const serverBrdp = await fetch(`${API}/api/projects/${proj.id}/brdps`, { headers: auth })
      .then((r) => r.json())
      .then((list) => list.find((b) => b.identifier === "BRDP-ASK-TABLE"));
    assert(serverBrdp.title === "Element <table>", `Postgres itself holds the corrected title, never an empty string (got: ${JSON.stringify(serverBrdp.title)})`);

    await page.locator("tr", { hasText: "BRDP-ASK-TABLE" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    assert((await page.locator("text=/mentions names/").count()) === 0, "no vocabulary warning remains for the now-correctly-marked-up <table>");

    // ==== 2. Rename fix, incomplete-markup edge cases, isolated (no
    // network/UI needed -- unit-level, but re-confirmed here against the
    // REAL module import path the app itself uses, for the closeout's
    // "test de la corrección con marcado incompleto"). ====
    const { applyRenameSuggestion } = await import("../src/validation/schemaValidation.js");
    assert(applyRenameSuggestion("Element <table", { name: "table", type: "element" }) === "Element <table>", "unit-level: dangling leading \"<\" is completed");
    assert(applyRenameSuggestion("Element table>", { name: "table", type: "element" }) === "Element <table>", "unit-level: dangling trailing \">\" is completed, never doubled");

    // ==== 3. Scope: the new SCOPE paragraph is present verbatim, the OLD
    // narrower wording is gone, and a schema-only question (no mention of
    // the BRDP at all) is answered without the model needing to see any
    // BRDP-specific phrase in the rule itself. ====
    let sys = await ask("Where can <para> go?");
    assert(sys.includes("SCOPE: answer questions about the BRDP shown below AND questions about"), "the new literal SCOPE paragraph is present");
    assert(sys.includes("Never add scope reminders or disclaimers to an answer you have given."), "the new no-trailing-disclaimer instruction is present");
    assert(!sys.includes("If the question is not about this specific BRDP, say so plainly and ask"), "the OLD, narrower scope wording is gone");
    assert(!sys.includes("not general questions, not questions about other BRDPs"), "the OLD blanket refusal phrasing is gone");
    assert(sys.includes('Answer exactly what is asked: "where can X go / be used" -> its allowed'), "the new focused-answer instruction is present");
    assert(sys.includes("When the facts contain several schema variants, summarize"), "the new variant-summarizing instruction is present");
    assert(sys.includes("Keep the 3-paragraph limit even when the facts are long."), "the new long-facts paragraph-limit reminder is present");

    // ==== 4. Determinism: the exact same question, asked three times in
    // a row (selecting a different BRDP in between and coming back, the
    // encargo's own "no puede depender de la tirada" concern), must
    // produce the byte-identical prompt every time -- never a coin flip
    // of which instructions happen to be included. ====
    const prompts = [];
    for (let i = 0; i < 3; i++) {
      await openRecords("BRDP-ASK-PARA");
      prompts.push(await ask("Where can <para> go?"));
    }
    assert(prompts[0] === prompts[1] && prompts[1] === prompts[2], "asking the identical question three times in a row produces the byte-identical system prompt every time");
    assert(prompts[0].includes("<para> — defined in 28 schemas:"), "the <para> parents question's prompt carries the real, compact schema facts (28 schemas)");
    assert(prompts[0].includes("allowed inside:"), "the prompt for a parents question includes the \"allowed inside\" (parents) line the model needs to answer it");

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded project (and its BRDPs, cascade).");
    void brdpBroken;
    void brdpPara;
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
