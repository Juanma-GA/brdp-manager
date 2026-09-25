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
//   5. Follow-up round ("falsos positivos del extractor LLM y aviso de
//      tipo equivocado"): the mock simulates the EXACT real-Mistral
//      over-extraction report (all 8 words of "el pokemon ese que va
//      dentro del step", including 6 Spanish stopwords) -- confirms
//      filterLLMStopwords strips every stopword, "step" (a real DITA
//      element) is correctly never flagged, and the surviving "pokemon"
//      shows as the hedged "Possibly not in" (low confidence, LLM-only)
//      rather than the flat "Not found in" reserved for context-path/
//      explicit-markup evidence; "Decidir si se usa la lista numerada"
//      (zero real candidates) triggers zero warnings; and, against the
//      REAL S1000D 4.2 vocabulary, <label> used as an element (it's
//      really an attribute there) gets its own wrong-kind message while
//      @label (used correctly, same Definition) triggers nothing.
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
  // Follow-up round ("falsos positivos del extractor LLM y aviso de tipo
  // equivocado"): the EXACT real-Mistral report reused BRDP-VOCAB-02's own
  // phrase manually against the real provider -- a separate BRDP with the
  // same phrase (never touched by armErrorNext, unlike BRDP-VOCAB-02) so
  // this scenario can run through the mock's SUCCESS path: the mock
  // simulates the worst-case over-extraction the user actually saw
  // (returns all 8 words, including the 6 stopwords). filterLLMStopwords
  // must strip the 6 stopwords, and "step" is itself a REAL DITA element
  // (confirmed by grep of schema-vocabulary-dita.json) so it's correctly
  // recognized and never flagged either -- only "pokemon" survives, shown
  // as "Possibly not in" (low confidence -- LLM-only, no context-path
  // evidence for it in this plain-text phrase).
  const brdpOverExtract = await makeBrdp(auth, projD.id, {
    identifier: "BRDP-VOCAB-03",
    title: "Over-extraction stopword filter check",
    definition: "el pokemon ese que va dentro del step",
    proposal: "",
    validation: "Pending",
  });
  // Second worked example from the tightened prompt -- ambiguous text with
  // no markup, no trigger words, no real candidate at all -> zero warnings.
  const brdpNoWarning = await makeBrdp(auth, projD.id, {
    identifier: "BRDP-VOCAB-04",
    title: "No-candidate phrase check",
    definition: "Decidir si se usa la lista numerada",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project D (DITA 1.3 Xpath2.0): 4 BRDPs for the vocabulary check");

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
  // Point 4 of the follow-up round: the encargo's own <label> edge case,
  // against the REAL generated S1000D 4.2 vocabulary (confirmed by direct
  // grep of schema-vocabulary-4-2.json before writing this: "label" is a
  // real attribute there, never an element) -- one BRDP exercises BOTH
  // the wrong-kind message (<label> used as an element) AND the "correct
  // usage -> no warning" edge case (@label) in the same Definition, via
  // the context path alone (no dependency on the mock's own behavior).
  // Deliberately avoids the standalone trigger words "element"/
  // "attribute" (3.3(a)'s phrase heuristic takes the word right after
  // such a trigger, skipping only a small connector list) -- the same
  // fixture-collision class already documented for BRDP-VOCAB-01 above.
  const brdpLabel = await makeBrdp(auth, projS.id, {
    identifier: "BRDP-VOCAB-LABEL",
    title: "Label wrong-kind check",
    definition: "The <label> tag must not be used; use @label instead.",
    proposal: "",
    validation: "Pending",
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
    await page.waitForSelector("text=/This BRDP mentions names not found in the DITA 1.3 Xpath2.0 schema/", { timeout: 5000 });
    const bannerLocator = page.locator("text=/This BRDP mentions names not found in the DITA 1.3 Xpath2.0 schema/").first();
    const bannerText = await bannerLocator.textContent();
    assert(bannerText.includes("<pokemon>"), `banner names <pokemon> as unknown (got: ${bannerText})`);
    assert(!bannerText.includes("topic") && !bannerText.includes("conref"), "known names (topic/conref) never appear in the unknown-names banner");
    // Real-Mistral feedback round: this warning gets the same red callout
    // treatment as Same BRDP (see the Same-BRDP color checks further down)
    // -- checked here via getComputedStyle, not just visually.
    const bannerColor = await bannerLocator.evaluate((el) => getComputedStyle(el).color);
    assert(bannerColor === "rgb(185, 28, 28)", `unknown-names banner text is red #b91c1c (got ${bannerColor})`);
    const bannerBg = await bannerLocator.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(bannerBg !== "rgba(0, 0, 0, 0)" && bannerBg !== "transparent", `unknown-names banner has a real tinted background (got ${bannerBg})`);
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

    // ==== follow-up round: possiblyNotFound (real-Mistral over-extraction,
    // filtered) + zero-candidate phrase -> zero warnings ====
    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-03");
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this decision point well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=/This BRDP mentions names possibly not in the DITA 1.3 Xpath2.0 schema/", { timeout: 5000 });
    const possiblyLocator = page.locator("text=/This BRDP mentions names possibly not in the DITA 1.3 Xpath2.0 schema/").first();
    const possiblyText = await possiblyLocator.textContent();
    // "step" IS a real DITA element (confirmed by grep of schema-
    // vocabulary-dita.json before writing this) -- checkAgainstVocabulary
    // correctly recognizes it and it never reaches this banner at all;
    // only "pokemon" (genuinely absent from DITA) survives.
    assert(possiblyText.includes("<pokemon>") && !possiblyText.includes("<step>"), `possiblyNotFound banner names only pokemon, not the real DITA element step (got: ${possiblyText})`);
    for (const stopword of ["del", "dentro", "ese", "que", "va"]) {
      assert(!possiblyText.includes(`<${stopword}>`), `stopword "${stopword}" never survives the client-side filter into the banner`);
    }
    // "el" is itself a substring of other real words (never appears as its
    // own bracketed candidate here) -- checked precisely, not with a bare
    // substring test that a coincidental match could pass by accident.
    assert(!possiblyText.includes("<el>"), 'stopword "el" specifically never survives as its own <el> candidate');
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the DITA 1.3 Xpath2.0 schema/").count()) === 0,
      "no high-confidence notFound banner for an LLM-only-sourced phrase (no context-path evidence at all)"
    );
    const possiblyColor = await possiblyLocator.evaluate((el) => getComputedStyle(el).color);
    assert(possiblyColor === "rgb(185, 28, 28)", `possiblyNotFound banner is also red #b91c1c (got ${possiblyColor})`);
    const reqPossibly = await lastMockRequest();
    const sysPossibly = reqPossibly.messages.find((m) => m.role === "system").content;
    // Scope the "step correctly excluded" check to the possiblyNotFound
    // paragraph itself, not the whole prompt -- the BRDP's own Definition
    // ("...dentro del step") is separately quoted verbatim earlier in the
    // prompt's context block, so a bare sysPossibly.includes("step") would
    // false-fail on that unrelated occurrence.
    const possiblyParagraphMatch = sysPossibly.match(/The following names could not be confirmed against[^]*?(?=\n\n|$)/);
    assert(possiblyParagraphMatch, "Ask prompt carries the hedged possiblyNotFound paragraph, not the flat 'do NOT exist' one, for this LLM-only case");
    assert(possiblyParagraphMatch[0].includes(": <pokemon>") && !possiblyParagraphMatch[0].includes("step"), `possiblyNotFound paragraph names only pokemon (got: ${possiblyParagraphMatch[0]})`);
    await page.screenshot({ path: "/tmp/vocab-check-possibly-not-found-banner.png", fullPage: true });
    console.log("Screenshot (possibly-not-found banner): /tmp/vocab-check-possibly-not-found-banner.png");
    await page.getByRole("button", { name: "Clear" }).click();

    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-04");
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Anything to flag here?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the DITA/").count()) === 0 &&
        (await page.locator("text=/This BRDP mentions names possibly not in the DITA/").count()) === 0,
      "worked example 2 (\"Decidir si se usa la lista numerada\") -> zero warnings of any kind"
    );
    const reqNoWarning = await lastMockRequest();
    const sysNoWarning = reqNoWarning.messages.find((m) => m.role === "system").content;
    assert(
      !sysNoWarning.includes("do NOT exist") && !sysNoWarning.includes("could not be confirmed") && !sysNoWarning.includes("used as the wrong kind"),
      "prompt gets none of the 3 unknown-names paragraphs when nothing was extracted"
    );
    await page.getByRole("button", { name: "Clear" }).click();

    // ==== "Aviso ligado al texto" round, point 4: BRDP-VOCAB-01's own
    // <pokemon> is explicit markup -> high-confidence notFound -> ALL
    // THREE Suggest buttons are now blocked here, a real behavior change
    // from this round (previously this BRDP was exactly where Suggest
    // Definition/Proposal's unknown-names block used to be exercised --
    // that path is now genuinely UNREACHABLE via the UI on a notFound
    // BRDP, by design; the divergence between Ask's and Suggest's blocks
    // is instead verified on a reachable possiblyNotFound-only BRDP in
    // scripts/verify-vocab-linked-to-text.mjs). ====
    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-01");
    for (const kind of ["Definition", "Proposal", "Rule"]) {
      const btn = page.getByRole("button", { name: `Suggest ${kind}`, exact: true });
      assert(await btn.isDisabled(), `Suggest ${kind} is blocked on BRDP-VOCAB-01 (explicit <pokemon>, notFound)`);
      assert(
        (await btn.getAttribute("title")) === "Fix the names not found in the DITA 1.3 Xpath2.0 schema first",
        `Suggest ${kind}'s tooltip is the vocab-block message`
      );
    }

    // ==== 4b. Suggest Definition: "never rename" line, no unknown-names
    // block on a CLEAN BRDP (BRDP-VOCAB-04, zero vocab candidates -- see
    // the "worked example 2" check above -- so both Suggest buttons stay
    // reachable here). ====
    await openRecords(`Vocab Verify D ${suffix}`, "BRDP-VOCAB-04");
    await resetMock();
    const suggestDefButton = page.getByRole("button", { name: "Suggest Definition", exact: true });
    await suggestDefButton.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqDef = await lastMockRequest();
    const sysDef = reqDef.messages.find((m) => m.role === "system").content;
    assert(
      sysDef.includes("Keep element and attribute names exactly as written in the BRDP's\nTitle — never rename them."),
      "Suggest Definition prompt carries the exact never-rename line"
    );
    assert(!sysDef.includes("The BRDP mentions names that may not exist"), "no unknown-names block on a clean BRDP");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.waitForTimeout(200);

    // ==== 2. Suggest Proposal: fill-in-template block replaces PROJECT-SPECIFIC VALUES ====
    await resetMock();
    await page.getByRole("button", { name: "Suggest Proposal", exact: true }).click();
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
    assert(!sysProp.includes("The BRDP mentions names that may not exist"), "no unknown-names block on a clean BRDP");
    console.log("\n===== Suggest Proposal system prompt (template check) =====\n" + sysProp + "\n=====\n");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
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
    // Informational, not a warning -- stays muted gray, never the red
    // treatment reserved for an actual "not found" defect.
    const extendedUnavailableColor = await page
      .locator("text=Extended name check unavailable")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    assert(
      extendedUnavailableColor === "rgb(148, 163, 184)",
      `"Extended name check unavailable" stays muted, not red (got ${extendedUnavailableColor})`
    );
    // BRDP-VOCAB-02's Definition has no <>, no @, no trigger phrase, no
    // camelCase -- context-only (a) alone finds nothing here, so with the
    // LLM path down there should be NO unknown-names warning at all (not
    // a false one either) -- matches the docs request's own edge case
    // ("el pokemon ese que va dentro del step" needs the LLM path).
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the DITA 1.3 Xpath2.0 schema/").count()) === 0,
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
    const bannerLocatorS1000D = page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").first();
    const bannerTextS1000D = await bannerLocatorS1000D.textContent();
    assert(bannerTextS1000D.includes("<pokemon>"), `S1000D 4.2 real vocabulary flags <pokemon> as unknown (got: ${bannerTextS1000D})`);
    assert(
      !bannerTextS1000D.includes("proceduralStep"),
      "proceduralStep (no <>, real S1000D 4.2 element) is NOT flagged -- recognized against the real schema"
    );
    const bannerColorS1000D = await bannerLocatorS1000D.evaluate((el) => getComputedStyle(el).color);
    assert(bannerColorS1000D === "rgb(185, 28, 28)", `S1000D unknown-names banner is also red #b91c1c (got ${bannerColorS1000D})`);
    const reqAskS1000D = await lastMockRequest();
    const sysAskS1000D = reqAskS1000D.messages.find((m) => m.role === "system").content;
    assert(
      sysAskS1000D.includes("The following names do NOT exist in the S1000D 4.2 schema: <pokemon>."),
      "Ask prompt carries the exact unknown-names block for real S1000D 4.2 vocabulary"
    );
    await page.getByRole("button", { name: "Clear" }).click();

    // ==== follow-up round, point 4: wrong-kind check against the REAL
    // S1000D 4.2 vocabulary -- <label> used as an element (it's actually
    // an attribute there) gets its own message, and @label (used
    // correctly) triggers no warning at all, in the SAME Definition. ====
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
    // @label (correct usage) never shows up as ANY kind of warning --
    // neither notFound/possiblyNotFound nor a second wrong-kind entry.
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0 &&
        (await page.locator("text=/This BRDP mentions names possibly not in the S1000D 4.2 schema/").count()) === 0 &&
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

    // "Aviso ligado al texto" round: brdpS1's Definition still has the
    // explicit <pokemon> used for the 4c check above -- now a
    // high-confidence notFound that blocks Suggest Proposal, needed
    // reachable below for the Same-BRDP-highlight check. Fix it via a
    // real API PUT (same effect as editing+saving through the UI) and
    // confirm the fix is picked up on reload without any Ask/Suggest
    // click -- reinforcing point 1 on a second real BRDP, not just BRDP-A
    // in verify-vocab-linked-to-text.mjs.
    await fetch(`${API}/api/projects/${projS.id}/brdps/${brdpS1.id}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ definition: "Definition confirming proceduralStep numbering stays consistent." }),
    });

    // ==== 3. Same BRDP group highlighted red ====
    await openRecords(`Vocab Verify S ${suffix}`, SAME_ID);
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "removing <pokemon> from brdpS1's Definition clears the notice on reload, no Ask/Suggest needed"
    );
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
