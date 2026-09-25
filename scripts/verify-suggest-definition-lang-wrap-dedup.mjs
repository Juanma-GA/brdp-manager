// Verification for "Suggest Definition: idioma, salto de línea y
// duplicados catálogo/records" (docs request). Confirms:
//   1. buildSuggestDefinitionPrompt's LANGUAGE block sits at the very end
//      of the instructions, immediately before "Return ONLY...", built
//      from the real running app via mock-mistral-chat-server.mjs's
//      GET /last-request (same method already established for
//      buildAskSystemPrompt/buildSuggestDefinitionPrompt in prior rounds
//      -- this repo has no JS test runner, CLAUDE.md).
//   2. A Spanish-Title BRDP puts the Spanish title inside the LANGUAGE
//      line verbatim.
//   3. The suggestion box wraps a long reply instead of cutting it off at
//      the panel's right edge -- screenshotted for the docs request's own
//      closing requirement.
// Backend dedup (point 3) is covered by pytest (test_similar.py's new
// dedup tests) -- not re-verified here via UI, per the docs request's own
// closure list (unit test for the prompt, backend test for dedup, a
// screenshot for the wrap fix).
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK_CHAT = "http://localhost:8902";
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
  await fetch(`${MOCK_CHAT}/reset`, { method: "POST" });
}

async function lastMockRequest() {
  return fetch(`${MOCK_CHAT}/last-request`).then((r) => r.json());
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Suggest Definition Lang/Wrap Verify ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  const spanishTitle = "Procedimiento de calibración del par de apriete";
  const brdp = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-LANGWRAP-01",
      title: spanishTitle,
      definition: "",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  console.log(`Seeded Project (S1000D 4.2) with a Spanish-Title BRDP: "${spanishTitle}"`);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    await page.goto(`${BASE_URL}/projects`);
    await page.waitForSelector("table", { timeout: 10000 });
    const row = page.locator("tr", { hasText: `Suggest Definition Lang/Wrap Verify ${suffix}` });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tr", { hasText: "BRDP-LANGWRAP-01" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

    await resetMock();
    const suggestDefButton = page.getByRole("button", { name: "Suggest Definition" });
    assert(await suggestDefButton.isEnabled(), "Suggest Definition is enabled");
    await suggestDefButton.click();
    await page.waitForSelector("text=/MOCK-LONG-DEFINITION/", { timeout: 15000 });

    // ---- 1 & 2: prompt shape, captured from the real request ----
    const req = await lastMockRequest();
    const systemPrompt = req.messages.find((m) => m.role === "system").content;
    console.log("\n===== System prompt (LANGUAGE block position) =====\n" + systemPrompt + "\n=====\n");

    const returnOnlyIdx = systemPrompt.indexOf("Return ONLY the Definition text");
    const languageIdx = systemPrompt.indexOf("LANGUAGE:");
    const doNotCiteIdx = systemPrompt.indexOf("Do not cite specification chapter numbers");
    const oldLineIdx = systemPrompt.indexOf("Write in the same language as the BRDP's Title and Proposal.");

    assert(returnOnlyIdx !== -1, "'Return ONLY...' is present");
    assert(languageIdx !== -1, "'LANGUAGE:' block is present");
    assert(doNotCiteIdx !== -1, "'Do not cite...' line is present");
    assert(oldLineIdx === -1, "the OLD generic language line ('Write in the same language...') is gone");
    assert(doNotCiteIdx < languageIdx, "LANGUAGE block comes AFTER 'Do not cite...'");
    assert(languageIdx < returnOnlyIdx, "LANGUAGE block comes BEFORE 'Return ONLY...' -- immediately preceding it");

    // Exact expected block, byte for byte -- confirms nothing else (no
    // other instruction paragraph) sits between the LANGUAGE block and
    // "Return ONLY...", i.e. "justo antes de Return ONLY", not just
    // "somewhere before it".
    const expectedLanguageBlock = `LANGUAGE: Write the Definition in the same language as the BRDP's
Title ("${spanishTitle}"). This takes priority over everything else — the
reference BRDPs may be in a different language; do not follow theirs.
If the Title language is unclear, use the language of the Proposal.`;
    const between = systemPrompt.slice(languageIdx, returnOnlyIdx).trim();
    assert(between === expectedLanguageBlock, "LANGUAGE block's exact text sits immediately before 'Return ONLY...', nothing else in between");

    // ---- 3: wrapping screenshot ----
    // (This dev sandbox has real, persistent catalog fixtures seeded
    // under S1000D 4.2 for earlier rounds -- see CLAUDE.md -- so this
    // freshly-seeded BRDP DOES get "Similar" references here; that's
    // fine, this check is purely about the suggestion TEXT wrapping, not
    // about the no-references case, which the previous round already
    // covered.)
    const suggestionBox = page.locator('[class*="suggestionBox"]').first();
    const box = await suggestionBox.boundingBox();
    const scrollWidthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = 1440;
    assert(scrollWidthBefore <= viewportWidth + 2, "no horizontal page overflow from the long suggestion text");
    await page.screenshot({ path: "/tmp/suggest-definition-long-text-wrapped.png", fullPage: true });
    console.log("Screenshot (long text wraps, no horizontal overflow): /tmp/suggest-definition-long-text-wrapped.png");
    console.log("Suggestion box bounding box:", box);

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded project.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
