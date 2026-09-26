// Verification for "comprobación de vocabulario solo determinista, sin
// bloqueo, sin referencias inventadas, y aviso de convención de nombres"
// (docs request), covering the vocabulary-check pieces of that encargo
// plus the still-valid parts of two earlier rounds it builds on
// ("Suggest Proposal como plantilla, grupo 'Same BRDP' destacado" and the
// original schema-vocabulary-check round). Confirms, through the real
// running app + real Postgres (chat transport mocked, same convention as
// every other round in this branch):
//   1. buildSuggestProposalPrompt's fill-in-template block (unchanged by
//      this round), and that the "never rename" line is gone from both
//      Suggest prompts (removed this round -- it was added on a copy
//      mistake, not a real observed LLM behavior).
//   2. The "Same BRDP in other projects" group renders in red (unchanged
//      by this round).
//   3. Schema vocabulary check, NOW SOLO DETERMINISTA: an explicit
//      `<pokemon>` tag is flagged "not found" (red banner) and does NOT
//      disable any of the three Suggest buttons any more (the blocking
//      feature from a previous round is gone); a known name (`<topic>`,
//      `@conref`, `proceduralStep`) never triggers a warning; a standard
//      with no generated vocabulary (S1000D 5.0) shows "not available",
//      never a false positive; the real report's own two false positives
//      ("lA", "tipo") never appear, while cl/pl/ip DO get flagged real
//      S1000D 4.2 attributes; "el atributo llamado applicRefId" resolves
//      to a REAL S1000D 4.2 attribute -> zero warning; a real catalog
//      entry's own ordinary-English title (BRDP-S1-00053's) produces zero
//      warnings now that there is no LLM-guess path left to misfire on
//      it; the wrong-kind check (`<label>` used as an element, real
//      S1000D 4.2 vocabulary) still works.
//   4. The new "never cite chapter/section/paragraph numbers unless they
//      appear in the BRDP content" instruction is present, verbatim, in
//      all three prompts that get it (Ask, Suggest Definition, Suggest
//      Proposal), replacing the old "don't cite ones you're not sure of"
//      wording.
//
// Prerequisites: mock-mistral-chat-server.mjs on :8902 with uvicorn's
// MISTRAL_ENDPOINT overridden to it, real Vite dev server, real Postgres.
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
  // anywhere else in this text -- the phrase-extraction heuristic takes
  // the word right after such a trigger, so keeping this fixture to just
  // the explicit `<x>`/`@x` markup isolates that path cleanly.
  const brdpPokemon = await makeBrdp(auth, projD.id, {
    identifier: "BRDP-VOCAB-01",
    title: "Decide whether the <pokemon> tag should be used",
    definition: "This decision governs whether <pokemon> may appear in maintenance procedures, whether @conref is required, and whether it may appear on <topic>.",
    proposal: "",
    validation: "Pending",
  });
  // Worked example from the encargo: ambiguous text with no markup, no
  // trigger words, no real candidate at all -> zero warnings.
  const brdpNoWarning = await makeBrdp(auth, projD.id, {
    identifier: "BRDP-VOCAB-04",
    title: "No-candidate phrase check",
    definition: "Decidir si se usa la lista numerada",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project D (DITA 1.3 Xpath2.0): 2 BRDPs for the vocabulary check");

  // ---- Project S (S1000D 4.2): real generated vocabulary ----
  const projS = await makeProject(auth, `Vocab Verify S ${suffix}`, "S1000D 4.2");
  const brdpS1 = await makeBrdp(auth, projS.id, {
    identifier: SAME_ID,
    title: "Fuel line clamp spacing decision (source)",
    definition: "Definition confirming proceduralStep numbering stays consistent.",
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
  // The encargo's own <label> edge case, against the REAL generated
  // S1000D 4.2 vocabulary (confirmed by grep of schema-vocabulary-4-2.json:
  // "label" is a real attribute there, never an element).
  const brdpLabel = await makeBrdp(auth, projS.id, {
    identifier: "BRDP-VOCAB-LABEL",
    title: "Label wrong-kind check",
    definition: "The <label> tag must not be used; use @label instead.",
    proposal: "",
    validation: "Pending",
  });
  // The exact real-report edge case, verbatim -- "lA"/"tipo" must never be
  // flagged, cl/pl/ip must be (none exist in the real S1000D 4.2
  // vocabulary), and <table> (a real element) must not be flagged either.
  const brdpRealReport = await makeBrdp(auth, projS.id, {
    identifier: "BRDP-VOCAB-REAL-REPORT",
    title: "Real report reproduction",
    definition: "lA ETIQUETA <table> no lleva atributo de tipo cl, pl y de tipo ip si es de valor 23",
    proposal: "",
    validation: "Pending",
  });
  // "el atributo llamado applicRefId" -> applicRefId is a REAL S1000D 4.2
  // attribute (confirmed by grep of schema-vocabulary-4-2.json) -> zero
  // warnings, even though it's captured via the phrase heuristic (never
  // written as @applicRefId here).
  const brdpApplicRefId = await makeBrdp(auth, projS.id, {
    identifier: "BRDP-VOCAB-APPLICREFID",
    title: "el atributo llamado applicRefId debe rellenarse siempre",
    definition: "Confirms applicRefId is recognized without needing @ markup.",
    proposal: "",
    validation: "Pending",
  });
  // BRDP-S1-00053's own real title (S1000D 4.2 catalog, Verified Rule) --
  // ordinary technical English, no markup, no trigger phrasing -- must
  // produce zero warnings now that the LLM-guess path (which used to
  // flag "change"/"data"/"marks"/"module"/"changed"/"revised" here) is
  // gone entirely.
  const brdpS100053 = await makeBrdp(auth, projS.id, {
    identifier: "BRDP-VOCAB-S1-00053-STYLE",
    title: "Data module change/revised ratio",
    definition: "Data module change/revised ratio",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project S (S1000D 4.2) + Project S2 sharing the catalog identifier");

  // ---- Project S0 (S1000D 5.0): genuinely no schema in this repo at all.
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

    async function suggestButtonsDisabled() {
      const buttons = page.getByRole("button", { name: /^Suggest (Definition|Proposal|Rule)$/ });
      const count = await buttons.count();
      const states = [];
      for (let i = 0; i < count; i++) states.push(await buttons.nth(i).isDisabled());
      return states;
    }

    // ==== 1. DITA project: unknown-name banner + prompt injection (Ask),
    // Suggest buttons stay enabled despite notFound ====
    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-01");

    assert(
      (await page.locator("text=Write element names as <element> and attributes as @attribute").count()) > 0,
      "vocab hint text visible under Title/Definition/Proposal"
    );

    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this decision point well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=/This BRDP mentions names not found in the DITA 1.3 Xpath2.0 schema/", { timeout: 5000 });
    const bannerLocator = page.locator("text=/This BRDP mentions names not found in the DITA 1.3 Xpath2.0 schema/").first();
    const bannerText = await bannerLocator.textContent();
    assert(bannerText.includes("<pokemon>"), `banner names <pokemon> as unknown (got: ${bannerText})`);
    assert(!bannerText.includes("topic") && !bannerText.includes("conref"), "known names (topic/conref) never appear in the unknown-names banner");
    const bannerColor = await bannerLocator.evaluate((el) => getComputedStyle(el).color);
    assert(bannerColor === "rgb(185, 28, 28)", `unknown-names banner text is red #b91c1c (got ${bannerColor})`);
    const bannerBg = await bannerLocator.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(bannerBg !== "rgba(0, 0, 0, 0)" && bannerBg !== "transparent", `unknown-names banner has a real tinted background (got ${bannerBg})`);
    await page.screenshot({ path: "/tmp/vocab-check-unknown-name-banner.png", fullPage: true });
    console.log("Screenshot (unknown-name banner): /tmp/vocab-check-unknown-name-banner.png");

    const reqAsk = await lastMockRequest();
    const sysAsk = reqAsk.messages.find((m) => m.role === "system").content;
    assert(
      sysAsk.includes(
        "The following names do NOT exist in the DITA 1.3 Xpath2.0 schema: <pokemon>. Point this out explicitly; do not treat them as valid elements or attributes."
      ),
      "Ask prompt carries the exact unknown-names block"
    );

    // "Solo determinista, sin bloqueo" round: a notFound name NEVER
    // disables any Suggest button any more -- the red banner is
    // sufficient on its own.
    const states1 = await suggestButtonsDisabled();
    assert(states1.every((d) => !d), "all 3 Suggest buttons remain ENABLED on BRDP-VOCAB-01 despite the notFound <pokemon>");

    // ==== Suggest Definition: "never rename" line, no unknown-names block
    // on a CLEAN BRDP (BRDP-VOCAB-04, zero vocab candidates) ====
    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-04");
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the DITA/").count()) === 0,
      'worked example ("Decidir si se usa la lista numerada") -> zero warnings'
    );
    await resetMock();
    const suggestDefButton = page.getByRole("button", { name: "Suggest Definition", exact: true });
    await suggestDefButton.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqDef = await lastMockRequest();
    const sysDef = reqDef.messages.find((m) => m.role === "system").content;
    assert(
      !sysDef.includes("never rename them"),
      "Suggest Definition prompt no longer carries the 'never rename' line (removed: added on a copy-mistake, never a real LLM behavior)"
    );
    assert(!sysDef.includes("The BRDP mentions names that may not exist"), "no unknown-names block on a clean BRDP");
    // New chapter-citation instruction, replacing the old "not sure of" wording.
    assert(
      sysDef.includes(
        'Never state or suggest specification chapter, section or paragraph\nnumbers, not even as possibilities ("it might be in chapter X"), unless\nthe exact number appears in the BRDP content above.'
      ),
      "Suggest Definition prompt carries the new chapter-citation instruction verbatim"
    );
    assert(!sysDef.includes("Do not cite specification chapter numbers you are not sure of."), "old chapter-citation wording is gone from Suggest Definition's prompt");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.waitForTimeout(200);

    // ==== 2. Suggest Proposal: fill-in-template block + chapter instruction ====
    await resetMock();
    await page.getByRole("button", { name: "Suggest Proposal", exact: true }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqProp = await lastMockRequest();
    const sysProp = reqProp.messages.find((m) => m.role === "system").content;
    assert(sysProp.includes("DO NOT MAKE THE DECISION."), "Suggest Proposal prompt opens the template block with the exact instruction");
    assert(sysProp.includes("The [LIST: Descriptive, Procedural, IPD, ...] schemas shall be used"), "example line 1 present verbatim");
    assert(sysProp.includes("The element <x> [YES/NO] be used."), "example line 2 present verbatim");
    assert(sysProp.includes("Nesting shall be limited to [VALUE: e.g. 4] levels."), "example line 3 present verbatim");
    assert(sysProp.includes("Permitted characters: [CHARACTERS: ...]."), "example line 4 present verbatim");
    assert(!sysProp.includes("PROJECT-SPECIFIC VALUES"), "old PROJECT-SPECIFIC VALUES block is gone");
    assert(
      !sysProp.includes("never rename them"),
      "Suggest Proposal prompt no longer carries the 'never rename' line either"
    );
    assert(!sysProp.includes("The BRDP mentions names that may not exist"), "no unknown-names block on a clean BRDP");
    assert(
      sysProp.includes(
        'Never state or suggest specification chapter, section or paragraph\nnumbers, not even as possibilities ("it might be in chapter X"), unless\nthe exact number appears in the BRDP content above.'
      ),
      "Suggest Proposal prompt carries the new chapter-citation instruction verbatim"
    );
    console.log("\n===== Suggest Proposal system prompt (template check) =====\n" + sysProp + "\n=====\n");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.waitForTimeout(200);

    // ==== 3. S1000D 4.2 project: real vocabulary -- <pokemon> unknown via
    // one BRDP, proceduralStep recognized on brdpS1, BRDP-S1-00053's own
    // real title produces zero warnings, applicRefId (via phrase-trigger,
    // no @) resolves to a real attribute -> zero warnings, the real
    // report's own false positives (lA/tipo) never appear while cl/pl/ip
    // do, and the new chapter instruction lands in Ask too. ====
    await openRecords(`Vocab Verify S ${suffix}`, SAME_ID);
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "brdpS1's real Definition (proceduralStep, no <>) -> zero warnings just from selecting the row"
    );
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "In what chapter is this defined?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqAskS1000D = await lastMockRequest();
    const sysAskS1000D = reqAskS1000D.messages.find((m) => m.role === "system").content;
    assert(
      sysAskS1000D.includes(
        'Never state or suggest specification chapter, section or paragraph\nnumbers, not even as possibilities ("it might be in chapter X"),\nunless the exact number appears in the BRDP content above. If the user\nasks where something is defined, say that you cannot give the exact\nlocation, and name the concept or element to look up in the S1000D 4.2\nspecification instead.'
      ),
      "Ask prompt carries the new chapter-citation instruction verbatim, with the real standard interpolated"
    );
    assert(
      !sysAskS1000D.includes("only cite ones you're genuinely confident about"),
      "old chapter-citation wording is gone from Ask's prompt"
    );
    await page.getByRole("button", { name: "Clear" }).click();

    // BRDP-S1-00053's own real title -> zero warnings (no LLM-guess path
    // left to flag "change"/"data"/"marks"/"module"/"changed"/"revised").
    await openRecords(`Vocab Verify S ${suffix}`, "BRDP-VOCAB-S1-00053-STYLE");
    assert(
      (await page.locator("text=/This BRDP mentions names (not found|possibly not) in the S1000D 4.2 schema/").count()) === 0,
      "BRDP-S1-00053's real title (\"Data module change/revised ratio\") -> zero vocabulary warnings"
    );

    // applicRefId, captured via phrase-trigger ("el atributo llamado
    // applicRefId"), resolves to a real S1000D 4.2 attribute -> zero
    // warning, AND (follow-up round, "sugerencias contextuales sin falsos
    // positivos") a real "Did you mean @applicRefId?" suggestion, since it
    // genuinely exists in the vocabulary.
    await openRecords(`Vocab Verify S ${suffix}`, "BRDP-VOCAB-APPLICREFID");
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      '"el atributo llamado applicRefId" -> applicRefId recognized as a real attribute, zero warnings'
    );
    assert(
      (await page.getByRole("button", { name: "Did you mean @applicRefId?", exact: true }).count()) > 0,
      '"el atributo llamado applicRefId" also offers a real "Did you mean @applicRefId?" suggestion'
    );

    // Follow-up round ("sin falsos positivos"): the real report is no
    // longer flagged at all -- cl/pl/ip are phrase-triggered bare words
    // that don't exist in this vocabulary, so under the new rules they are
    // silently ignored (no warning, no suggestion), never flagged red the
    // way a previous round used to. <table> (explicit markup, real
    // element) still gets neither a warning nor a suggestion (it's simply
    // valid), and "tipo"/"lA" were never captured at all, before or after
    // this round.
    await openRecords(`Vocab Verify S ${suffix}`, "BRDP-VOCAB-REAL-REPORT");
    await page.waitForTimeout(500); // give any (incorrect) banner a chance to render before asserting its absence
    assert(
      (await page.locator("text=/This BRDP mentions names (not found|possibly not) in the S1000D 4.2 schema/").count()) === 0,
      "real report: zero vocabulary warnings now -- cl/pl/ip are ignored (not in vocab), never flagged red"
    );
    assert(
      (await page.getByRole("button", { name: /Did you mean/ }).count()) === 0,
      "real report: zero \"Did you mean\" suggestions either -- none of cl/pl/ip exist in the real S1000D 4.2 vocabulary"
    );

    // ==== wrong-kind check against the REAL S1000D 4.2 vocabulary --
    // <label> used as an element (it's actually an attribute there) gets
    // its own message, and @label (used correctly) triggers no warning at
    // all, in the SAME Definition. ====
    await openRecords(`Vocab Verify S ${suffix}`, "BRDP-VOCAB-LABEL");
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=/is not an element in S1000D 4.2/", { timeout: 5000 });
    const wrongTypeLocator = page.locator("text=/is not an element in S1000D 4.2/").first();
    const wrongTypeText = await wrongTypeLocator.textContent();
    assert(
      wrongTypeText.includes("<label>") && wrongTypeText.includes("attribute @label"),
      `wrong-kind message names <label> and points to the real attribute @label (got: ${wrongTypeText})`
    );
    const wrongTypeColor = await wrongTypeLocator.evaluate((el) => getComputedStyle(el).color);
    assert(wrongTypeColor === "rgb(185, 28, 28)", `wrong-kind message is also red #b91c1c (got ${wrongTypeColor})`);
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0 &&
        (await page.locator("text=/is not an attribute in S1000D 4.2/").count()) === 0,
      "@label (correct usage, same Definition) triggers zero warnings of any kind"
    );
    const reqWrongType = await lastMockRequest();
    const sysWrongType = reqWrongType.messages.find((m) => m.role === "system").content;
    assert(
      sysWrongType.includes("The following names were used as the wrong kind in the text") &&
        sysWrongType.includes("<label> is not an element in S1000D 4.2 — it exists as attribute @label."),
      "Ask prompt carries the exact wrong-kind sentence for real S1000D 4.2 vocabulary"
    );
    await page.screenshot({ path: "/tmp/vocab-check-wrong-type-banner.png", fullPage: true });
    console.log("Screenshot (wrong-kind banner): /tmp/vocab-check-wrong-type-banner.png");
    await page.getByRole("button", { name: "Clear" }).click();

    // ==== 4. S1000D 5.0 project: genuinely no schema in this repo ->
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
    const notAvailableColor = await page
      .locator("text=Schema vocabulary check not available for S1000D 5.0.")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    assert(notAvailableColor === "rgb(148, 163, 184)", `"not available" notice stays muted, not red (got ${notAvailableColor})`);
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 5.0 schema/").count()) === 0,
      "no false 'not found' claim for a standard with no vocabulary at all"
    );
    const reqAskS0 = await lastMockRequest();
    const sysAskS0 = reqAskS0.messages.find((m) => m.role === "system").content;
    assert(!sysAskS0.includes("do NOT exist in the S1000D 5.0 schema"), "prompt never gets the unknown-names block when the standard has no vocabulary");
    const states0 = await suggestButtonsDisabled();
    assert(states0.every((d) => !d), "Suggest buttons never blocked by vocabulary on the 'not available' standard either");

    // ==== 5. Same BRDP group highlighted red (unchanged by this round) ====
    await openRecords(`Vocab Verify S ${suffix}`, SAME_ID);
    await resetMock();
    const suggestPropButtonS = page.getByRole("button", { name: "Suggest Proposal", exact: true });
    assert(await suggestPropButtonS.isEnabled(), "Suggest Proposal enabled (Definition is present)");
    await suggestPropButtonS.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=Same BRDP in other projects", { timeout: 5000 });

    const heading = page.locator("h4", { hasText: "Same BRDP in other projects" });
    const headingColor = await heading.evaluate((el) => getComputedStyle(el).color);
    assert(headingColor === "rgb(220, 38, 38)", `Same-BRDP heading is red #dc2626 (got ${headingColor})`);
    const boxBg = await heading.evaluate((el) => getComputedStyle(el.closest("div")).backgroundColor);
    assert(boxBg !== "rgba(0, 0, 0, 0)" && boxBg !== "transparent", `Same-BRDP group has a real tinted background (got ${boxBg})`);
    const sameBrdpRow = page.locator("li", { hasText: "Fuel line clamp spacing decision (other project)" });
    const idButton = sameBrdpRow.getByRole("button", { name: SAME_ID });
    const idColor = await idButton.evaluate((el) => getComputedStyle(el).color);
    assert(idColor === "rgb(220, 38, 38)", `Same-BRDP row identifier is red #dc2626 (got ${idColor})`);
    await idButton.click();
    await page.waitForSelector("text=600 mm apart", { timeout: 3000 });

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
    console.log("Cleaned up the seeded projects.");
    void brdpPokemon;
    void brdpNoWarning;
    void brdpLabel;
    void brdpRealReport;
    void brdpApplicRefId;
    void brdpS100053;
    void brdpS0;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
