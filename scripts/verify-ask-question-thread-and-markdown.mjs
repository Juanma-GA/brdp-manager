// Verification for: Ask a Question feeling like a mini conversation
// (last exchange shown above the textarea, textarea auto-clears on
// success but keeps its text on error, dynamic follow-up placeholder,
// Enter/Shift+Enter) and rendering the answer as real markdown via
// react-markdown (already in package.json, used elsewhere in the dead
// ChatPanel.jsx for reference) with its default-safe behavior (no
// rehype-raw), so a literal <table>/<originator> in the answer text
// never gets interpreted as HTML.
//
// Same sandbox network limitation as the previous Ask a Question round
// (scripts/mock-mistral-chat-server.mjs, MISTRAL_ENDPOINT override) --
// api.mistral.ai is unreachable here (proxy 403), so this drives the real
// /api/llm-proxy code path against a local mock, with a few new
// deterministic triggers (MARKDOWN_TEST, HTML_TEST, ERROR_TEST) added to
// the same mock for this round's specific checks.
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

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const projects = await fetch(`${API}/api/projects`, { headers: auth }).then((r) => r.json());
  const demo = projects.find((p) => p.name.startsWith("Demo Project"));

  const created = await fetch(`${API}/api/projects/${demo.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-ASK-THREAD-A",
      title: "Ask thread test A",
      definition: "Definition for the mini-thread UI verification.",
      proposal: "Proposal text.",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  const createdB = await fetch(`${API}/api/projects/${demo.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-ASK-THREAD-B",
      title: "Ask thread test B",
      definition: "Definition B.",
      proposal: "Proposal B.",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  console.log("Seeded BRDP-ASK-THREAD-A/B on Demo Project");

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

    const row = page.locator("tr", { hasText: "Demo Project" });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tr", { hasText: "BRDP-ASK-THREAD-A" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

    // The ask textarea's placeholder changes (first-question vs.
    // follow-up), so it's located here by DOM position relative to the
    // "Ask a question" label -- the first <textarea> following it, in
    // document order -- rather than by placeholder text, which would go
    // stale the moment the placeholder switches.
    const askTextarea = page.locator("label", { hasText: "Ask a question" }).locator("xpath=following::textarea[1]");
    const askButton = page.getByRole("button", { name: /^Ask$/ });
    const youLine = (expected) => page.locator("p").filter({ hasText: expected });

    // ---- Initial state: no exchange yet, first-question placeholder ----
    assert((await page.locator("p", { hasText: /^You: / }).count()) === 0, "No exchange shown before any question is asked");
    assert((await askTextarea.getAttribute("placeholder")) === "Ask about this BRDP…", "First-question placeholder is showing initially");

    // ---- Normal question: exchange appears, textarea auto-clears ----
    await resetMock();
    await askTextarea.fill("What does this BRDP require?");
    await askButton.click();
    // While pending: the question is already shown, with a loading indicator.
    await page.waitForSelector("p:has-text('You:')", { timeout: 5000 });
    assert(true, "The submitted question appears in the exchange zone immediately (optimistic display)");
    const pendingText = await page.locator("text=/Thinking…/").count();
    assert(pendingText >= 1, "A loading indicator ('Thinking…') shows while the request is in flight");

    await page.waitForSelector("text=/MOCK-ANSWER/", { timeout: 15000 });
    assert((await askTextarea.inputValue()) === "", "Textarea auto-clears after a successful answer");
    assert(
      (await youLine("You: What does this BRDP require?").count()) === 1,
      "Exchange shows the exact question that was asked, prefixed 'You:'"
    );
    assert(
      (await askTextarea.getAttribute("placeholder")) === "Ask a follow-up about this BRDP…",
      "Placeholder switches to the follow-up variant after a successful answer"
    );

    // ---- Follow-up: exchange REPLACED by the new one, not appended ----
    await resetMock();
    await askTextarea.fill("And why?");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-FOLLOWUP/", { timeout: 15000 });
    assert((await page.locator("p", { hasText: /^You: / }).count()) === 1, "Only ONE exchange is ever shown -- the new one replaced the old, not appended");
    assert((await youLine("You: And why?").count()) === 1, "The single shown exchange is the newest question");
    assert((await page.locator("text=/What does this BRDP require/").count()) === 0, "The previous question is no longer visible once replaced");
    assert((await askTextarea.inputValue()) === "", "Textarea auto-clears again after the follow-up succeeds");

    await page.screenshot({ path: "/tmp/ask-thread-followup.png" });

    // ---- Markdown rendering: bold/list/inline code become real elements ----
    await resetMock();
    await askTextarea.fill("MARKDOWN_TEST please");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-MARKDOWN/", { timeout: 15000 });
    const strongCount = await page.locator("strong", { hasText: "MOCK-MARKDOWN" }).count();
    assert(strongCount === 1, "**MOCK-MARKDOWN** rendered as a real <strong> element, not literal asterisks");
    const listItems = await page.locator("li", { hasText: "allowedObjectFlag" }).count();
    assert(listItems === 1, "Markdown list item rendered as a real <li>");
    const emCount = await page.locator("em", { hasText: "emphasized" }).count();
    assert(emCount === 1, "*emphasized* rendered as a real <em> element");
    const codeCount = await page.locator("code", { hasText: "objectPath" }).count();
    assert(codeCount >= 1, "Inline `code` rendered as a real <code> element");
    const rawAsterisks = await page.locator("text=/\\*\\*MOCK-MARKDOWN\\*\\*/").count();
    assert(rawAsterisks === 0, "No raw markdown syntax (**/`) leaks through as literal text");

    await page.screenshot({ path: "/tmp/ask-thread-markdown-code.png" });

    // ---- HTML-injection edge case: <table>/<originator> in the answer
    // text render as literal text, never as real DOM elements (same
    // principle as the Generate Report fix, 90b7e12) ----
    await resetMock();
    await askTextarea.fill("HTML_TEST please");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-HTML-TEST/", { timeout: 15000 });
    const answerBox = page.locator("div", { hasText: "MOCK-HTML-TEST" }).last();
    const literalText = await answerBox.innerText();
    assert(literalText.includes("<table>") && literalText.includes("<originator>"), "The raw tag text is visible literally in the rendered answer");
    const realTableInAnswer = await answerBox.locator("table").count();
    assert(realTableInAnswer === 0, "No real <table> DOM element was created from the unescaped answer text");
    const realOriginator = await page.evaluate(() => document.getElementsByTagName("originator").length);
    assert(realOriginator === 0, "No real <originator> element exists anywhere in the page");

    // ---- Clear ----
    await page.getByRole("button", { name: "Clear" }).click();
    assert((await page.locator("p", { hasText: /^You: / }).count()) === 0, "Clear removes the exchange entirely");
    assert(
      (await askTextarea.getAttribute("placeholder")) === "Ask about this BRDP…",
      "Placeholder reverts to the first-question variant after Clear (no prior turn anymore)"
    );

    // ---- Error case: textarea keeps its text, error shown where the
    // answer would go ----
    await resetMock();
    await askTextarea.fill("ERROR_TEST please");
    await askButton.click();
    await page.waitForSelector("text=/You: ERROR_TEST please/", { timeout: 5000 });
    await page.waitForSelector('[role="alert"]', { timeout: 15000 });
    const errorText = await page.locator('[role="alert"]').innerText();
    assert(errorText.toLowerCase().includes("error"), `An error is shown where the answer would go (got: "${errorText}")`);
    const survivingTextarea = await askTextarea.inputValue();
    assert(survivingTextarea === "ERROR_TEST please", `The textarea keeps the question text after a network error (got: "${survivingTextarea}")`);

    await page.screenshot({ path: "/tmp/ask-thread-error.png" });

    // ---- Switching BRDP resets everything, including the placeholder ----
    await page.locator("tr", { hasText: "BRDP-ASK-THREAD-B" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    assert((await page.locator("p", { hasText: /^You: / }).count()) === 0, "Switching BRDP clears the exchange");
    assert(
      (await askTextarea.getAttribute("placeholder")) === "Ask about this BRDP…",
      "Switching BRDP reverts the placeholder to the first-question variant"
    );

    console.log("\nALL CHECKS PASSED");
  } finally {
    for (const b of [created, createdB]) {
      await fetch(`${API}/api/projects/${demo.id}/brdps/${b.id}`, { method: "DELETE", headers: auth }).catch(() => {});
      await fetch(`${API}/api/trash/${b.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up BRDP-ASK-THREAD-A/B (soft + permanent delete)");
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
