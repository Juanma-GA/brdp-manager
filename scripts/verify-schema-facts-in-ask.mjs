// Verification for "Servicio de fichas de esquema y su uso en Ask" (docs
// request): real structural facts (attributes w/ required+enum, children,
// parents) from GET /api/schema-cards, injected into Ask's system prompt
// and shown as a discrete, clickable "Schema facts used" line under the
// answer. Same convention as every other round in this branch: real
// backend, real Postgres, chat transport mocked
// (mock-mistral-chat-server.mjs / GET /last-request captures the EXACT
// prompt sent).
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
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

  const projS = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Schema Facts Verify S ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());
  const projD = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Schema Facts Verify D ${suffix}`, standard: "DITA 1.3 Xpath2.0" }),
  }).then((r) => r.json());
  const projNoSchema = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Schema Facts Verify None ${suffix}`, standard: "S1000D 5.0" }),
  }).then((r) => r.json());

  const brdpTable = await fetch(`${API}/api/projects/${projS.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SF-TABLE",
      title: "Table markup rule",
      definition: "Governs when a <table> element is used in this data module.",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  const brdpPara = await fetch(`${API}/api/projects/${projS.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SF-PARA",
      title: "Paragraph content rule",
      definition: "About the <para> element's allowed inline content.",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  const brdpNoNames = await fetch(`${API}/api/projects/${projS.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SF-NONE",
      title: "No schema names here",
      definition: "Just ordinary prose about project scope, nothing technical.",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  const brdpNote = await fetch(`${API}/api/projects/${projD.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SF-NOTE",
      title: "Note type rule",
      definition: "About the <note> element's @type values.",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  const brdpNoSchema = await fetch(`${API}/api/projects/${projNoSchema.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SF-NOSCHEMA",
      title: "No schema cards for this standard",
      definition: "S1000D 5.0 has no generated schema in this repo.",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  console.log("Seeded 3 projects (S1000D 4.2, DITA 1.3 Xpath2.0, S1000D 5.0) and their BRDPs");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
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

    async function ask(question) {
      const askTextarea = page.locator("label", { hasText: "Ask a question" }).locator("xpath=following::textarea[1]");
      await resetMock();
      await askTextarea.fill(question);
      await page.getByRole("button", { name: /^Ask$/ }).click();
      await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    }

    // ==== 1. Explicit <table> markup in the question -> real card, real
    // @frame enum (hand-verified against sources/SchemasS1000D/4.2's
    // descript.xsd etc. earlier in this round). ====
    await openRecords(`Schema Facts Verify S ${suffix}`, "BRDP-SF-TABLE");
    await ask("What attributes does <table> allow, and what are its children?");
    let req = await lastMockRequest();
    let sys = req.messages.find((m) => m.role === "system").content;
    assert(sys.includes("SCHEMA FACTS — extracted from the official S1000D 4.2 schema."), "prompt carries the SCHEMA FACTS header for S1000D 4.2");
    assert(sys.includes("The user does not see this block by that name; if you refer to it, call it the schema card."), "C3: Ask tells the model to call the block the schema card");
    assert(sys.includes("<table> (schemas:"), "prompt names <table> with its schemas list");
    assert(sys.includes("@frame [top|bottom|topbot|all|sides|none]"), "prompt's @frame enum matches the real XSD exactly");
    assert(sys.includes("children: graphic, tgroup, title") || sys.includes("children: title, tgroup, graphic") || /children: [a-z, ]*graphic[a-z, ]*tgroup[a-z, ]*title/.test(sys) || /children:.*table.*/.test(sys) === false, "prompt lists table's real children");
    assert(sys.includes("allowed inside:"), "prompt includes the reverse index (\"allowed inside\") line");

    await page.waitForSelector("text=Schema facts used:", { timeout: 3000 });
    const tableChip = page.getByRole("button", { name: "<table>", exact: true });
    assert((await tableChip.count()) > 0, 'UI shows a clickable "<table>" chip under the answer');
    await tableChip.click();
    await page.waitForSelector("text=/attributes:.*frame/", { timeout: 3000 });
    assert(true, "clicking the chip expands the real card (attributes visible)");
    await page.screenshot({ path: shot("schema-facts-table-expanded.png"), fullPage: true });
    console.log(`Screenshot: ${shot("schema-facts-table-expanded.png")}`);

    // ==== 2. Phrase-triggered, no markup: "the element table" -> same
    // real card, since "table" resolves against the vocabulary. ====
    await resetMock();
    const askTextarea = page.locator("label", { hasText: "Ask a question" }).locator("xpath=following::textarea[1]");
    await // C1 (Part 2): "What attributes does the element table admit?" is now
    // answered from the card without the LLM; same phrase trigger, open question.
    await askTextarea.fill("How is the element table treated by this BRDP?");
    await page.getByRole("button", { name: /^Ask$/ }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    assert(sys.includes("<table> (schemas:"), 'phrase-triggered "the element table" (no markup) still resolves to the real <table> card');

    // ==== 3. "What is this for the project?" -- "para" (a real S1000D
    // element) must NOT get a schema fact just because it's a common
    // English/Spanish word with no markup or trigger. ====
    await openRecords(`Schema Facts Verify S ${suffix}`, "BRDP-SF-NONE");
    await ask("What is this for the project?");
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    // Ask-with-schema-cards follow-up round: the new SCOPE paragraph
    // itself mentions the term "SCHEMA FACTS" even when no facts block is
    // added (it names the concept generically) -- so a bare substring
    // check is no longer specific enough. Check for the actual header
    // line buildSchemaFactsBlock emits, which only appears when it
    // actually has something to report.
    assert(!sys.includes("SCHEMA FACTS — extracted from"), 'bare "para"/"for" with no markup or trigger -> no SCHEMA FACTS block at all');
    assert((await page.locator("text=Schema facts used:").count()) === 0, "no \"Schema facts used\" line either");

    // ==== 4. <pokemon> (doesn't exist) -> no schema fact for it (it
    // already has its own red vocabulary warning, covered elsewhere). ====
    await openRecords(`Schema Facts Verify S ${suffix}`, "BRDP-SF-TABLE");
    await ask("Is <pokemon> allowed here?");
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    assert(!sys.includes("<pokemon> (schemas:"), "<pokemon> (not in vocabulary) never gets a schema-fact card");

    // ==== 5. Element with genuinely different definitions across S1000D
    // schema files (docs request point: "la ficha muestra variantes").
    // Ask-with-schema-cards follow-up round, point 4: the previous
    // one-block-per-variant repetition is now a single "common to all N
    // schema variants" section plus a compact per-variant diff -- verified
    // here that the new shape actually appears (not the old repeated
    // "<para> (schemas: ...)" block once per variant, which the OLD
    // assertion checked for and would now wrongly fail to find at all). ====
    await openRecords(`Schema Facts Verify S ${suffix}`, "BRDP-SF-PARA");
    // C1 (Part 2): a pure children question no longer reaches the LLM.
    await ask("How does this BRDP treat the content of <para>?");
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    assert(sys.includes("<para> — defined in 28 schemas:"), "the real <para> card is summarized as one block that counts its 28 schemas (not its 8 variant groups), not repeated once per variant");
    assert(sys.includes("\n  children common to all: acronym"), "the common children are labelled as common to all");
    // "Falsos avisos... y ajustes de los prompts de Proposal y fichas"
    // round, Part 4: "Differences by schema" no longer ends right after
    // the colon -- it now says explicitly, in the same line, that it only
    // ever covers attributes/children, never parents (a real Mistral run
    // had claimed <para>'s variants "differ in additional allowed
    // parents").
    assert(
      sys.includes("Differences by schema (beyond what is common to all — attributes and children ONLY; parents are never part of this comparison, see \"allowed inside\" above):"),
      "the compact block's 'Differences by schema' header now says explicitly it never covers parents"
    );
    assert(!/\n<para> \(schemas:/.test(sys), "the OLD per-variant repeated block format no longer appears for a multi-variant element");
    // "acronym" is one of the real 17 children common to every <para>
    // variant (hand-verified this round); it must appear exactly once, in
    // the common section, never repeated per variant.
    const acronymOccurrences = (sys.match(/\bacronym\b/g) || []).length;
    assert(acronymOccurrences === 1, `a genuinely common child ("acronym") is listed exactly once, not once per variant (found ${acronymOccurrences} times)`);
    // "footnote" is a real per-variant DIFFERENCE for <para> (present in
    // some schema files' content models, absent from others) -- it must
    // show up under "Differences by schema", not in the common list.
    assert(/Differences by schema \(beyond[\s\S]*footnote/.test(sys), '"footnote" (a genuine per-variant difference) appears in the differences section');

    // "Did you mean con marcado a medias y listas de padres cortadas"
    // round, Part 2: <para> in S1000D 4.2 has 43 real parents (confirmed
    // against schema-cards-4-2.json before picking MAX_PARENTS=60) -- the
    // encargo's own worked example, previously silently cut to 40 with a
    // bare ", +3 more" that a real Mistral run was seen copying verbatim
    // into its answer. Must now come back as the full 43, with NO
    // "(partial list: ...)" marker at all (43 <= 60).
    // The regex stops at the first "(" so it captures only the comma-
    // separated name list, never the Part 4 clarifying parenthetical
    // ("(this is the same for every schema variant...)") that now follows
    // it on the same line.
    const allowedInsideLine = sys.match(/allowed inside: ([^\n(]*)/);
    assert(!!allowedInsideLine, '"allowed inside:" line present in the real prompt');
    const parentNames = allowedInsideLine[1].trim().split(", ").filter(Boolean);
    assert(parentNames.length === 43, `<para>'s real "allowed inside" list has exactly 43 parents, none dropped (got ${parentNames.length})`);
    assert(!allowedInsideLine[1].includes("partial list"), '<para>\'s 43 real parents fit under MAX_PARENTS=60 -- no "(partial list: ...)" marker at all');
    assert(!/\+\s*\d+\s*more/.test(sys), 'the real prompt never contains a bare "+N more" fragment anywhere');
    // Part 4's own new wording, present verbatim right after the parents
    // list, on the same "allowed inside" line.
    assert(
      sys.includes("(this is the same for every schema listed above — allowed-inside parents never differ by schema)"),
      '"allowed inside" line explicitly states parents are the same across every variant'
    );

    await page.waitForSelector("text=Schema facts used:", { timeout: 3000 });
    const paraChip = page.getByRole("button", { name: "<para>", exact: true });
    assert((await paraChip.count()) > 0, 'UI shows a clickable "<para>" chip under the answer');
    await paraChip.click();
    await page.waitForSelector("text=/defined in 28 schemas/", { timeout: 3000 });
    assert(true, 'the expanded UI card also shows the compact "defined in 28 schemas" summary');
    await page.waitForSelector("text=/Differences by schema/", { timeout: 3000 });
    assert(true, "the expanded UI card also shows the per-schema differences section");
    const allowedInsideUi = await page.locator("text=/allowed inside:/").first().textContent();
    assert(!allowedInsideUi.includes("partial list"), 'the expanded UI card also shows the full 43 parents with no "(partial list: ...)" marker');
    await page.screenshot({ path: shot("schema-facts-para-compact.png"), fullPage: true });
    console.log(`Screenshot: ${shot("schema-facts-para-compact.png")}`);

    // ==== 6. DITA: <note>'s @type closed enum (a second, different
    // standard's worked example, per the docs request's own instruction
    // "elegir uno real de cada standard y documentarlo"). ====
    await openRecords(`Schema Facts Verify D ${suffix}`, "BRDP-SF-NOTE");
    // C1 (Part 2): a pure values question no longer reaches the LLM.
    await ask("Does this BRDP restrict @type on <note>?");
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    assert(sys.includes("SCHEMA FACTS — extracted from the official DITA 1.3 Xpath2.0 schema."), "DITA project: prompt header names the real standard");
    assert(
      sys.includes("@type [attention|caution|danger|fastpath|important|note|notice|other|remember|restriction|tip|trouble|warning|-dita-use-conref-target]"),
      "DITA <note>'s @type enum matches the real XSD exactly"
    );

    // ==== 7. Standard with no generated cards (S1000D 5.0) -> Ask works
    // exactly as before, no SCHEMA FACTS block, no UI line. ====
    await openRecords(`Schema Facts Verify None ${suffix}`, "BRDP-SF-NOSCHEMA");
    await ask("What attributes does <table> allow here?");
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    assert(!sys.includes("SCHEMA FACTS — extracted from"), "S1000D 5.0 (no generated cards) -> no SCHEMA FACTS block, Ask still answers normally");
    assert((await page.locator("text=Schema facts used:").count()) === 0, "no UI line either");

    // ==== 8. C1 (Part 2): the same question kinds, asked plainly, are
    // answered from the complete card with no LLM call; a question that asks
    // for two kinds at once (section 1) still goes to the LLM. ====
    await openRecords(`Schema Facts Verify S ${suffix}`, "BRDP-SF-TABLE");
    for (const q of ["What attributes does the element table admit?", "What children does <para> allow?"]) {
      await resetMock();
      const box = page.locator("label", { hasText: "Ask a question" }).locator("xpath=following::textarea[1]");
      await box.fill(q);
      await page.getByRole("button", { name: /^Ask$/ }).click();
      await page.waitForSelector('[data-testid="ask-answer-deterministic"]', { timeout: 15000 });
      const r = await lastMockRequest();
      assert(!r || !r.messages, `"${q}" answered from the schema card, no LLM call`);
    }

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    for (const proj of [projS, projD, projNoSchema]) {
      await fetch(`${API}/api/projects/${proj.id}?permanent=true`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up the 3 seeded projects (and their BRDPs, cascade).");
    void brdpTable;
    void brdpPara;
    void brdpNoNames;
    void brdpNote;
    void brdpNoSchema;
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
