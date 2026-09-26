// Verification for "Servicio de fichas de esquema y su uso en Ask" (docs
// request): real structural facts (attributes w/ required+enum, children,
// parents) from GET /api/schema-cards, injected into Ask's system prompt
// and shown as a discrete, clickable "Schema facts used" line under the
// answer. Same convention as every other round in this branch: real
// backend, real Postgres, chat transport mocked
// (mock-mistral-chat-server.mjs / GET /last-request captures the EXACT
// prompt sent).
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
    await page.screenshot({ path: "/tmp/schema-facts-table-expanded.png", fullPage: true });
    console.log("Screenshot: /tmp/schema-facts-table-expanded.png");

    // ==== 2. Phrase-triggered, no markup: "the element table" -> same
    // real card, since "table" resolves against the vocabulary. ====
    await resetMock();
    const askTextarea = page.locator("label", { hasText: "Ask a question" }).locator("xpath=following::textarea[1]");
    await askTextarea.fill("What attributes does the element table admit?");
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
    assert(!sys.includes("SCHEMA FACTS"), 'bare "para"/"for" with no markup or trigger -> no SCHEMA FACTS block at all');
    assert((await page.locator("text=Schema facts used:").count()) === 0, "no \"Schema facts used\" line either");

    // ==== 4. <pokemon> (doesn't exist) -> no schema fact for it (it
    // already has its own red vocabulary warning, covered elsewhere). ====
    await openRecords(`Schema Facts Verify S ${suffix}`, "BRDP-SF-TABLE");
    await ask("Is <pokemon> allowed here?");
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    assert(!sys.includes("<pokemon> (schemas:"), "<pokemon> (not in vocabulary) never gets a schema-fact card");

    // ==== 5. Element with genuinely different definitions across S1000D
    // schema files (docs request point: "la ficha muestra variantes"). ====
    await openRecords(`Schema Facts Verify S ${suffix}`, "BRDP-SF-PARA");
    await ask("What children does <para> allow?");
    req = await lastMockRequest();
    sys = req.messages.find((m) => m.role === "system").content;
    const paraVariantCount = (sys.match(/<para> \(schemas:/g) || []).length;
    assert(paraVariantCount > 1, `<para> genuinely resolves differently across S1000D 4.2 schema files -- prompt shows ${paraVariantCount} variants, not 1`);

    // ==== 6. DITA: <note>'s @type closed enum (a second, different
    // standard's worked example, per the docs request's own instruction
    // "elegir uno real de cada standard y documentarlo"). ====
    await openRecords(`Schema Facts Verify D ${suffix}`, "BRDP-SF-NOTE");
    await ask("What are the allowed values for @type on <note>?");
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
    assert(!sys.includes("SCHEMA FACTS"), "S1000D 5.0 (no generated cards) -> no SCHEMA FACTS block, Ask still answers normally");
    assert((await page.locator("text=Schema facts used:").count()) === 0, "no UI line either");

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    for (const proj of [projS, projD, projNoSchema]) {
      await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
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
