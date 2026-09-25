// Verification for "Suggest Proposal como plantilla, grupo 'Same BRDP'
// destacado y comprobación de vocabulario contra el esquema" (docs
// request). Confirms, through the real running app + real Postgres (both
// Mistral transports mocked, same convention as every other round):
//   1. buildSuggestProposalPrompt no longer decides the Proposal -- the
//      PROJECT-SPECIFIC VALUES block is gone, replaced with the literal
//      "DO NOT MAKE THE DECISION" fill-in-template block.
//   2. buildSuggestDefinitionPrompt gained the "never rename" line.
//   3. The "Same BRDP in other projects" group renders in red (heading
//      color, row identifier color, and a bordered/tinted box), visibly
//      more prominent than Similar/This project.
//   4. Schema vocabulary check: a DITA project (which HAS a generated
//      vocabulary) flags an unknown name (<pokemon>) in the assistant
//      panel and in the Ask/Suggest Definition/Suggest Proposal prompts,
//      while a known name (<topic>, @conref) never triggers a warning;
//      an S1000D 4.2 project -- sources/SchemasS1000D/{3.0.1,4.1,4.2}
//      arrived MID-ROUND with a full data-module schema set per Issue
//      (descript/proced/ipd/crew.xsd all confirmed present, not just
//      brex.xsd), so it now ALSO has a real generated vocabulary --
//      flags <pokemon> for real too, and recognizes proceduralStep (no
//      <>, the docs request's own S1000D 4.2 litmus case) as valid; an
//      S1000D 5.0 project (genuinely no schema anywhere in this repo)
//      shows "not available", never a false positive, and the prompt
//      never gets the unknown-names block; the extraction call is
//      genuinely cached (same text -> one call); a failed extraction
//      call degrades to "Extended name check unavailable" while
//      context-only detection still works; the hint text under
//      Title/Definition/Proposal is visible.
//
// Prerequisites: mock-mistral-embed-server.mjs on :8901 (already the
// .env default), mock-mistral-chat-server.mjs on :8902 (now also serving
// the vocabulary-extraction call, keyed on its distinctive system
// prompt) with uvicorn's MISTRAL_ENDPOINT overridden to it, real Vite dev
// server, real Postgres. Reuses the S1000D 4.2 catalog row
// BRDP-SPCAT-LIVE-001 seeded by backend/scripts/seed_suggest_proposal_
// catalog.py in a previous round (still present in this sandbox).
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK_CHAT = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const SAME_ID = "BRDP-SPCAT-LIVE-001";

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
async function extractionCalls() {
  return fetch(`${MOCK_CHAT}/extraction-calls`).then((r) => r.json()).then((r) => r.count);
}
async function armErrorNext() {
  await fetch(`${MOCK_CHAT}/error-next`, { method: "POST" });
}

async function makeProject(auth, name, standard) {
  return fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, standard }),
  }).then((r) => r.json());
}
async function makeBrdp(auth, projectId, body) {
  return fetch(`${API}/api/projects/${projectId}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  // ---- Project D (DITA 1.3 Xpath2.0): has a real generated vocabulary ----
  const projD = await makeProject(auth, `Vocab Verify D ${suffix}`, "DITA 1.3 Xpath2.0");
  // Deliberately avoids the trigger words "element(s)"/"attribute(s)"
  // anywhere in this text -- the phrase-extraction heuristic (3.3(a))
  // takes the word RIGHT AFTER such a trigger, skipping only a small
  // fixed connector list (el/la/del/de/the/of/...), so "the <pokemon>
  // element is used" would itself trigger on "element" -> "is" (a real,
  // acknowledged limitation of a simple heuristic, not what this check
  // is verifying here) -- this fixture isolates the <tag>/@attr paths
  // (3.3(a) first two bullets) and the known-name non-warning case
  // cleanly, without that unrelated collision.
  const brdpPokemon = await makeBrdp(auth, projD.id, {
    identifier: "BRDP-VOCAB-01",
    title: "Decide whether the <pokemon> tag should be used",
    definition: "This decision governs whether <pokemon> may appear in maintenance procedures, whether @conref is required, and whether it may appear on <topic>.",
    proposal: "",
    validation: "Pending",
  });
  const brdpErrorCase = await makeBrdp(auth, projD.id, {
    identifier: "BRDP-VOCAB-02",
    title: "A separate BRDP for the extraction-failure case",
    definition: "el pokemon ese que va dentro del step",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project D (DITA 1.3 Xpath2.0): 2 BRDPs for the vocabulary check");

  // ---- Project S (S1000D 4.2): sources/SchemasS1000D/4.2 arrived mid-
  // round (real, complete -- descript/proced/ipd/crew.xsd all present,
  // confirmed before generating anything) -- S1000D 4.2 now HAS a real
  // generated vocabulary too, so this BRDP exercises both an unknown
  // name (<pokemon>) AND a real known one WITHOUT <> (proceduralStep,
  // the encargo's own S1000D 4.2 litmus case) in the same Definition.
  const projS = await makeProject(auth, `Vocab Verify S ${suffix}`, "S1000D 4.2");
  const brdpS1 = await makeBrdp(auth, projS.id, {
    identifier: SAME_ID,
    title: "Fuel line clamp spacing decision (source)",
    definition:
      "Definition mentioning <pokemon> as a placeholder that should never really exist, and confirming proceduralStep numbering stays consistent.",
    proposal: "",
    validation: "Pending",
  });
  // A second project sharing the SAME catalog-issued identifier + a real
  // Proposal, so Suggest Proposal on brdpS1 gets a real "Same BRDP in
  // other projects" entry to screenshot with the red highlight.
  const projS2 = await makeProject(auth, `Vocab Verify S2 ${suffix}`, "S1000D 4.2");
  await makeBrdp(auth, projS2.id, {
    identifier: SAME_ID,
    title: "Fuel line clamp spacing decision (other project)",
    definition: "The other project's own Definition for the same decision point.",
    proposal: "The other project decided: clamps shall be spaced no more than 600 mm apart.",
    validation: "Validated",
  });
  console.log("Seeded Project S (S1000D 4.2) + Project S2 sharing the catalog identifier");

  // ---- Project S0 (S1000D 5.0): genuinely no schema in this repo at all
  // (only 3.0.1/4.1/4.2 arrived) -- the real "not available" case now.
  const projS0 = await makeProject(auth, `Vocab Verify S0 ${suffix}`, "S1000D 5.0");
  const brdpS0 = await makeBrdp(auth, projS0.id, {
    identifier: "BRDP-VOCAB-S0-01",
    title: "A BRDP under a standard with no schema at all",
    definition: "Mentions <pokemon> too, but this standard has no generated vocabulary to check it against.",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project S0 (S1000D 5.0): no schema in this repo -- real 'not available' case");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    async function openRecords(projectName, brdpIdentifier) {
      await page.goto(`${BASE_URL}/projects`);
      await page.waitForSelector("table", { timeout: 10000 });
      const row = page.locator("tr", { hasText: projectName });
      await row.getByRole("button", { name: /Records/i }).click();
      await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: brdpIdentifier }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    }

    // ==== 1+4a. DITA project: unknown-name banner + prompt injection (Ask) ====
    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-01");

    // Hint text under the fields, always visible.
    assert(
      (await page.locator("text=Write element names as <element> and attributes as @attribute").count()) > 0,
      "vocab hint text visible under Title/Definition/Proposal"
    );

    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this decision point well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=/Not found in the DITA 1.3 Xpath2.0 schema/", { timeout: 5000 });
    const bannerText = await page.locator("text=/Not found in the DITA 1.3 Xpath2.0 schema/").first().textContent();
    assert(bannerText.includes("<pokemon>"), `banner names <pokemon> as unknown (got: ${bannerText})`);
    assert(!bannerText.includes("topic") && !bannerText.includes("conref"), "known names (topic/conref) never appear in the unknown-names banner");
    await page.screenshot({ path: "/tmp/vocab-check-unknown-name-banner.png", fullPage: true });
    console.log("Screenshot (unknown-name banner): /tmp/vocab-check-unknown-name-banner.png");

    assert((await extractionCalls()) === 1, "exactly 1 extraction call after the first Ask");

    const reqAsk = await lastMockRequest();
    const sysAsk = reqAsk.messages.find((m) => m.role === "system").content;
    assert(
      sysAsk.includes(
        "The following names do NOT exist in the DITA 1.3 Xpath2.0 schema: <pokemon>. Point this out explicitly; do not treat them as valid elements or attributes."
      ),
      "Ask prompt carries the exact unknown-names block"
    );

    // Same text again (a follow-up question, BRDP text unchanged) -> cached,
    // no second extraction call.
    await page.fill('textarea[placeholder="Ask a follow-up about this BRDP…"]', "Why exactly?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-FOLLOWUP/", { timeout: 15000 });
    assert((await extractionCalls()) === 1, "same BRDP text -> still 1 extraction call (cached, not re-run)");

    // ==== 4b. Suggest Definition: "never rename" line + unknown-names block ====
    await page.getByRole("button", { name: "Clear" }).click();
    await resetMock();
    const suggestDefButton = page.getByRole("button", { name: "Suggest Definition" });
    await suggestDefButton.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqDef = await lastMockRequest();
    const sysDef = reqDef.messages.find((m) => m.role === "system").content;
    assert(
      sysDef.includes("Keep element and attribute names exactly as written in the BRDP's\nTitle — never rename them."),
      "Suggest Definition prompt carries the exact never-rename line"
    );
    assert(
      sysDef.includes("The following names do NOT exist in the DITA 1.3 Xpath2.0 schema: <pokemon>."),
      "Suggest Definition prompt also carries the unknown-names block"
    );
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(200);

    // ==== 2. Suggest Proposal: fill-in-template block replaces PROJECT-SPECIFIC VALUES ====
    await resetMock();
    await page.getByRole("button", { name: "Suggest Proposal" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqProp = await lastMockRequest();
    const sysProp = reqProp.messages.find((m) => m.role === "system").content;
    assert(sysProp.includes("DO NOT MAKE THE DECISION."), "Suggest Proposal prompt opens the template block with the exact instruction");
    assert(
      sysProp.includes(
        "Write the Proposal as a fill-in template: the\ncomplete normative sentence, with every choice left to the user as a\nbracketed placeholder"
      ),
      "template wording present verbatim"
    );
    assert(sysProp.includes("The [LIST: Descriptive, Procedural, IPD, ...] schemas shall be used"), "example line 1 present verbatim");
    assert(sysProp.includes("The element <x> [YES/NO] be used."), "example line 2 present verbatim");
    assert(sysProp.includes("Nesting shall be limited to [VALUE: e.g. 4] levels."), "example line 3 present verbatim");
    assert(sysProp.includes("Permitted characters: [CHARACTERS: ...]."), "example line 4 present verbatim");
    assert(
      sysProp.includes("Example options may come from the reference BRDPs, but never present\nanother project's choice as this project's decision."),
      "never-present-another-projects-choice line present"
    );
    assert(!sysProp.includes("PROJECT-SPECIFIC VALUES"), "old PROJECT-SPECIFIC VALUES block is gone");
    assert(
      sysProp.includes("Keep element and attribute names exactly as written in the BRDP's Title\nand Definition — never rename them."),
      "Suggest Proposal prompt also carries its own never-rename line"
    );
    assert(
      sysProp.includes("The following names do NOT exist in the DITA 1.3 Xpath2.0 schema: <pokemon>."),
      "Suggest Proposal prompt also carries the unknown-names block"
    );
    console.log("\n===== Suggest Proposal system prompt (template check) =====\n" + sysProp + "\n=====\n");
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(200);

    // ==== extraction failure -> "Extended name check unavailable", context-only still works ====
    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-02");
    await resetMock();
    await armErrorNext();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Does this need review?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    assert(
      (await page.locator("text=Extended name check unavailable").count()) > 0,
      '"Extended name check unavailable" shown when the extraction call itself fails'
    );
    // BRDP-VOCAB-02's Definition has no <>, no @, no trigger phrase, no
    // camelCase -- context-only (a) alone finds nothing here, so with the
    // LLM path down there should be NO unknown-names warning at all (not
    // a false one either) -- matches the docs request's own edge case
    // ("el pokemon ese que va dentro del step" needs the LLM path).
    assert(
      (await page.locator("text=/Not found in the DITA 1.3 Xpath2.0 schema/").count()) === 0,
      "no unknown-names warning when context-only extraction found nothing and the LLM path failed"
    );
    await page.screenshot({ path: "/tmp/vocab-check-extraction-unavailable.png", fullPage: true });
    console.log("Screenshot (extraction unavailable): /tmp/vocab-check-extraction-unavailable.png");
    await page.getByRole("button", { name: "Clear" }).click();

    // ==== 4c. S1000D 4.2 project: REAL generated vocabulary (sources/
    // SchemasS1000D/4.2 arrived mid-round -- descript/proced/ipd/crew.xsd
    // all confirmed present, so the check is genuinely active here, not
    // "not available") -- <pokemon> unknown, proceduralStep (no <>, the
    // encargo's own S1000D 4.2 litmus case) recognized as real. ====
    await openRecords(`Vocab Verify S ${suffix}`, SAME_ID);
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const bannerTextS1000D = await page.locator("text=/Not found in the S1000D 4.2 schema/").first().textContent();
    assert(bannerTextS1000D.includes("<pokemon>"), `S1000D 4.2 real vocabulary flags <pokemon> as unknown (got: ${bannerTextS1000D})`);
    assert(
      !bannerTextS1000D.includes("proceduralStep"),
      "proceduralStep (no <>, real S1000D 4.2 element) is NOT flagged -- recognized against the real schema"
    );
    const reqAskS1000D = await lastMockRequest();
    const sysAskS1000D = reqAskS1000D.messages.find((m) => m.role === "system").content;
    assert(
      sysAskS1000D.includes("The following names do NOT exist in the S1000D 4.2 schema: <pokemon>."),
      "Ask prompt carries the exact unknown-names block for real S1000D 4.2 vocabulary"
    );
    await page.getByRole("button", { name: "Clear" }).click();

    // ==== 4d. S1000D 5.0 project: genuinely no schema in this repo ->
    // "not available", never a false positive. ====
    await openRecords(`Vocab Verify S0 ${suffix}`, "BRDP-VOCAB-S0-01");
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    assert(
      (await page.locator("text=Schema vocabulary check not available for S1000D 5.0.").count()) > 0,
      '"not available" notice shown for S1000D 5.0 (no schema at all in this repo for it)'
    );
    assert(
      (await page.locator("text=/Not found in the S1000D 5.0 schema/").count()) === 0,
      "no false 'not found' claim for a standard with no vocabulary at all"
    );
    const reqAskS0 = await lastMockRequest();
    const sysAskS0 = reqAskS0.messages.find((m) => m.role === "system").content;
    assert(!sysAskS0.includes("do NOT exist in the S1000D 5.0 schema"), "prompt never gets the unknown-names block when the standard has no vocabulary");

    // ==== 3. Same BRDP group highlighted red ====
    await openRecords(`Vocab Verify S ${suffix}`, SAME_ID);
    await resetMock();
    const suggestPropButtonS = page.getByRole("button", { name: "Suggest Proposal" });
    assert(await suggestPropButtonS.isEnabled(), "Suggest Proposal enabled (Definition is present)");
    await suggestPropButtonS.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=Same BRDP in other projects", { timeout: 5000 });

    const heading = page.locator("h4", { hasText: "Same BRDP in other projects" });
    const headingColor = await heading.evaluate((el) => getComputedStyle(el).color);
    assert(headingColor === "rgb(220, 38, 38)", `Same-BRDP heading is red #dc2626 (got ${headingColor})`);
    const boxBg = await heading.evaluate((el) => getComputedStyle(el.closest("div")).backgroundColor);
    assert(boxBg !== "rgba(0, 0, 0, 0)" && boxBg !== "transparent", `Same-BRDP group has a real tinted background (got ${boxBg})`);
    // The Proposal text ("600 mm apart") is inside the collapsed expand
    // panel, not visible until clicked -- locate the row by its always-
    // visible title text instead.
    const sameBrdpRow = page.locator("li", { hasText: "Fuel line clamp spacing decision (other project)" });
    const idButton = sameBrdpRow.getByRole("button", { name: SAME_ID });
    const idColor = await idButton.evaluate((el) => getComputedStyle(el).color);
    assert(idColor === "rgb(220, 38, 38)", `Same-BRDP row identifier is red #dc2626 (got ${idColor})`);
    // Expand it for the screenshot -- confirms the red styling AND the
    // Definition/Proposal expand still both work under the new styling.
    await idButton.click();
    await page.waitForSelector("text=600 mm apart", { timeout: 3000 });

    // Compare against Similar decisions/This project, which must NOT be red.
    const similarHeadingCount = await page.locator("h4", { hasText: "Similar decisions" }).count();
    if (similarHeadingCount > 0) {
      const similarColor = await page
        .locator("h4", { hasText: "Similar decisions" })
        .first()
        .evaluate((el) => getComputedStyle(el).color);
      assert(similarColor !== "rgb(220, 38, 38)", `Similar decisions heading is NOT red (got ${similarColor})`);
    }

    await page.screenshot({ path: "/tmp/vocab-same-brdp-highlighted-red.png", fullPage: true });
    console.log("Screenshot (Same BRDP highlighted red): /tmp/vocab-same-brdp-highlighted-red.png");

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    for (const proj of [projD, projS, projS2, projS0]) {
      await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up the 3 seeded projects.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
