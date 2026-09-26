// Verification for "Ask a Question": a new system prompt strictly scoped
// to the selected BRDP (with its FULL live context, including Rule/Rule
// Status and the Refused reason -- askGeneric() previously sent only
// identifier+definition and a one-line generic prompt), one turn of real
// conversation chaining, a Clear button, resetting on BRDP switch, and the
// optional "+ Compare with another BRDP" search across Records + the
// official catalog.
//
// This sandbox's outbound network cannot reach api.mistral.ai at all (a
// direct curl through the real backend showed the agent proxy itself
// returning 403 Forbidden, not just an invalid-key rejection from
// Mistral) -- so this script drives the REAL configured provider
// ("mistral") through the REAL /api/llm-proxy code path, but pointed at a
// local mock chat-completions server (scripts/mock-mistral-chat-server.mjs,
// via MISTRAL_ENDPOINT=http://localhost:8902, same override convention
// mock-mistral-embed-server.mjs already established for embeddings). The
// mock exposes GET /last-request so this script can assert on the EXACT
// system prompt and message array the app sent, not just that some
// request happened, and deterministically detects off-topic/follow-up
// questions to exercise those real UI paths too.
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const RULE_FORMAT = "BREX-4.2";

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
  const data = await res.json();
  return data.access_token;
}

async function lastMockRequest() {
  return fetch(`${MOCK}/last-request`).then((r) => r.json());
}

async function resetMock() {
  await fetch(`${MOCK}/reset`, { method: "POST" });
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const projects = await fetch(`${API}/api/projects`, { headers: auth }).then((r) => r.json());
  const demo = projects.find((p) => p.name.startsWith("Demo Project"));

  // ---- Seed BRDP A (main, selected) -- Refused with a reason, and a
  // deliberately huge Rule (>6000 chars) to exercise the truncation edge
  // case, well-formed via a padded XML comment (never "--" inside it). ----
  const longPadding = "A".repeat(7000);
  const brdpA = await fetch(`${API}/api/projects/${demo.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-ASK-TEST-A",
      title: "Ask test A: fastener torque",
      definition: "Definition A for the Ask a Question verification.",
      proposal: "Proposal A text.",
      validation: "Refused",
      comments: "Refused because the torque value conflicts with BRDP-S1-00042.",
    }),
  }).then((r) => r.json());
  await fetch(`${API}/api/projects/${demo.id}/brdps/${brdpA.id}/approvals/${RULE_FORMAT}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({
      rule_xml: `<!-- ${longPadding} --><structureObjectRule id="RULE-LONG-TEST"><objectPath allowedObjectFlag="1">/dmodule</objectPath></structureObjectRule>`,
      source: "manual",
      status: "pending_review",
    }),
  }).then((r) => r.json());
  console.log("Seeded BRDP-ASK-TEST-A (Refused, Draft rule, >6000 char rule_xml)");

  // ---- Seed BRDP B (Records compare target) -- Validated, Verified rule ----
  const brdpB = await fetch(`${API}/api/projects/${demo.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-ASK-TEST-B",
      title: "Ask test B: corrosion interval",
      definition: "Definition B for the Ask a Question verification.",
      proposal: "Proposal B text.",
      validation: "Validated",
    }),
  }).then((r) => r.json());
  await fetch(`${API}/api/projects/${demo.id}/brdps/${brdpB.id}/approvals/${RULE_FORMAT}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({
      rule_xml: `<structureObjectRule id="RULE-B-TEST"><objectPath allowedObjectFlag="0">/dmodule/content</objectPath></structureObjectRule>`,
      source: "manual",
      status: "pending_review",
    }),
  }).then((r) => r.json());
  await fetch(`${API}/api/projects/${demo.id}/brdps/${brdpB.id}/approvals/${RULE_FORMAT}/approve`, {
    method: "POST",
    headers: auth,
  });
  console.log("Seeded BRDP-ASK-TEST-B (Validated, Verified rule)");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
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

    await page.locator("tr", { hasText: "BRDP-ASK-TEST-A" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

    const askBox = page.locator("textarea[placeholder]").filter({ hasText: "" });
    const questionBox = page.getByPlaceholder("Ask about this BRDP…");
    const askButton = page.getByRole("button", { name: /^Ask$/ });
    const answerBox = page.locator("div").filter({ hasText: /^MOCK-/ }).last();

    // ---- Normal question: full BRDP scoping, including Refused reason,
    // Rule Status, and the truncated long Rule. ----
    await resetMock();
    await questionBox.fill("What does this BRDP require?");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-ANSWER/", { timeout: 15000 });
    assert(true, "Normal question gets a real answer back through the real /api/llm-proxy -> mock chat endpoint");

    let req1 = await lastMockRequest();
    const sys1 = req1.messages.find((m) => m.role === "system").content;
    assert(sys1.includes("ID: BRDP-ASK-TEST-A"), "System prompt includes the selected BRDP's real ID");
    assert(sys1.includes("Title: Ask test A: fastener torque"), "System prompt includes Title");
    assert(sys1.includes("Proposal Status: Refused"), "System prompt includes Proposal Status");
    assert(
      sys1.includes("Refusal reason: Refused because the torque value conflicts with BRDP-S1-00042."),
      "System prompt includes the real Refusal reason (comments/refusal_reason), never sent before this round"
    );
    assert(sys1.includes("Rule Status: Draft"), "System prompt includes the real Rule Status (never sent before this round)");
    assert(
      sys1.includes(`[Rule truncated at 6000 characters]`),
      "The >6000-char Rule is truncated with an explicit marker in the prompt itself, never silently (HR7)"
    );
    assert(!sys1.includes("A".repeat(6001)), "The truncated Rule text does NOT contain the full 7000-char padding past the cutoff");
    assert(
      req1.messages.filter((m) => m.role !== "system").length === 1,
      "First question has no prior turn -- only the new user message, no chaining yet"
    );

    // ---- Follow-up question: real one-turn chaining ----
    const firstAnswerText = (await page.locator("text=/MOCK-ANSWER/").first().innerText()).trim();
    await questionBox.fill("And why?");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-FOLLOWUP/", { timeout: 15000 });
    assert(true, "Follow-up question ('And why?') resolves via chaining -- the mock only replies MOCK-FOLLOWUP when it sees prior turn history");

    const req2 = await lastMockRequest();
    const nonSystem2 = req2.messages.filter((m) => m.role !== "system");
    assert(nonSystem2.length === 3, `Chained request carries exactly 1 prior turn (user+assistant) + the new question (3 messages, got ${nonSystem2.length})`);
    assert(nonSystem2[0].role === "user" && nonSystem2[0].content === "What does this BRDP require?", "First chained message is the PREVIOUS question, verbatim");
    assert(nonSystem2[1].role === "assistant" && firstAnswerText.includes(nonSystem2[1].content), "Second chained message is the PREVIOUS answer, verbatim");
    assert(nonSystem2[2].role === "user" && nonSystem2[2].content === "And why?", "Third message is the NEW question");

    // ---- Clear ----
    await page.getByRole("button", { name: "Clear" }).click();
    assert((await questionBox.inputValue()) === "", "Clear empties the question box");
    assert((await page.locator("text=/MOCK-/").count()) === 0, "Clear removes the rendered answer");

    // ---- Off-topic question (fresh turn, Clear reset prevTurn too) ----
    await resetMock();
    await questionBox.fill("What's the weather like today?");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-OFFTOPIC/", { timeout: 15000 });
    assert(true, "An off-topic question, run against the real configured provider (mocked transport), gets the real 'not about this BRDP' refusal behavior");
    const req3 = await lastMockRequest();
    assert(req3.messages.filter((m) => m.role !== "system").length === 1, "Off-topic question after Clear is NOT chained (Clear reset the previous turn)");

    await page.getByRole("button", { name: "Clear" }).click();

    // ---- Compare: Records source ----
    await page.getByRole("button", { name: "+ Compare with another BRDP" }).click();
    // .last(): getByPlaceholder matches case-insensitively, and the main
    // table search box above ("Search by ID or Title…") differs from this
    // one only by casing -- the compare box is the one further down the DOM.
    await page.getByPlaceholder("Search by ID or title…").last().fill("BRDP-ASK-TEST-B");
    await page.waitForTimeout(300);
    const recordsResult = page.locator("li", { hasText: "BRDP-ASK-TEST-B" });
    assert((await recordsResult.locator("text=Records").count()) === 1, "The Records candidate is labeled with its source (Records)");
    await recordsResult.getByRole("button", { name: "Choose" }).click();
    await page.waitForSelector("text=/Comparing with: BRDP-ASK-TEST-B/", { timeout: 5000 });
    assert(true, "Choosing a Records candidate shows the 'Comparing with' chip");

    await resetMock();
    await questionBox.fill("Compare these two BRDPs.");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const req4 = await lastMockRequest();
    const sys4 = req4.messages.find((m) => m.role === "system").content;
    assert(sys4.includes("BRDP being compared against (source: Records):"), "Compare block is present and correctly labeled 'Records'");
    assert(sys4.includes("ID: BRDP-ASK-TEST-B"), "Compare block carries the Records BRDP's real ID");
    assert(sys4.includes("Proposal Status: Validated"), "Compare block (Records source) includes Proposal Status");
    assert(sys4.includes("Rule Status: Verified"), "Compare block (Records source) includes real Rule Status");
    assert(sys4.includes("RULE-B-TEST"), "Compare block (Records source) includes the real Rule text");
    assert(sys4.includes("The user may ask you to compare the current BRDP with the one above"), "Compare block ends with the explicit both-in-scope instruction");

    // Remove the chip
    await page.getByRole("button", { name: "Remove comparison" }).click();
    assert((await page.locator("text=/Comparing with:/").count()) === 0, "Removing the chip clears the comparison");
    assert((await page.getByRole("button", { name: "+ Compare with another BRDP" }).count()) === 1, "The '+ Compare' link reappears after removing the chip");

    // ---- Compare: Catalog source (no Proposal/Rule Status -- catalog has none) ----
    await page.getByRole("button", { name: "+ Compare with another BRDP" }).click();
    await page.getByPlaceholder("Search by ID or title…").last().fill("BRDP-CAT-ASKTEST-001");
    await page.waitForSelector('li:has-text("BRDP-CAT-ASKTEST-001")', { timeout: 5000 });
    const catalogResult = page.locator("li", { hasText: "BRDP-CAT-ASKTEST-001" });
    const catalogResultText = await catalogResult.innerText();
    assert(catalogResultText.includes("Catalog"), `The Catalog candidate is labeled with its source (Catalog) -- got: "${catalogResultText}"`);
    await catalogResult.getByRole("button", { name: "Choose" }).click();
    await page.waitForSelector("text=/Comparing with: BRDP-CAT-ASKTEST-001/", { timeout: 5000 });

    await resetMock();
    await questionBox.fill("Compare with the catalog one.");
    await askButton.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const req5 = await lastMockRequest();
    const sys5 = req5.messages.find((m) => m.role === "system").content;
    assert(sys5.includes("BRDP being compared against (source: Catalog):"), "Compare block is present and correctly labeled 'Catalog'");
    assert(sys5.includes("ID: BRDP-CAT-ASKTEST-001"), "Compare block carries the Catalog entry's real ID");
    const catalogBlock = sys5.slice(sys5.indexOf("BRDP being compared against (source: Catalog):"));
    assert(!catalogBlock.includes("Proposal Status:"), "Compare block (Catalog source) has NO Proposal Status line -- the catalog has no such field, never a misleading blank");
    assert(!catalogBlock.includes("Rule Status:"), "Compare block (Catalog source) has NO Rule Status line either, same reason");

    await page.screenshot({ path: "/tmp/ask-question-compare.png" });
    console.log("Screenshot saved to /tmp/ask-question-compare.png");

    // ---- Switching BRDP resets everything (docs request bug fix) ----
    await page.locator("tr", { hasText: "BRDP-ASK-TEST-B" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    assert((await questionBox.inputValue()) === "", "Switching the selected BRDP clears the question box");
    assert((await page.locator("text=/MOCK-/").count()) === 0, "Switching the selected BRDP clears any rendered answer");
    assert((await page.locator("text=/Comparing with:/").count()) === 0, "Switching the selected BRDP clears the compare chip too");
    assert((await page.getByRole("button", { name: "+ Compare with another BRDP" }).count()) === 1, "The compare link is back to its collapsed state after switching BRDP");

    console.log("\nALL CHECKS PASSED");
  } finally {
    for (const b of [brdpA, brdpB]) {
      await fetch(`${API}/api/projects/${demo.id}/brdps/${b.id}`, { method: "DELETE", headers: auth }).catch(() => {});
      await fetch(`${API}/api/trash/${b.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up BRDP-ASK-TEST-A/B (soft + permanent delete)");
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
