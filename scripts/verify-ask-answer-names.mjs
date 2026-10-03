// Verification for "Ask: comprobar los nombres de la respuesta" (Parts 1-2).
// Real backend, real Postgres, real Vite; only the chat transport is mocked
// (scripts/mock-mistral-chat-server.mjs): a question containing "NCAGE"
// gets the real wrong answer of the report ("ncage es un atributo del
// elemento `<identAndStatusSection>`..."), one containing IDSTATUS_TEST a
// correct 3.0.1 answer, NCAGE_CORRECT the shape of the real correct
// answers. "Aviso de nombres sin heurísticas y fichas sin hijos comunes"
// round: neutral warning without the BRDP's own names, and the
// <identAndStatusSection> card (children per schema) in prompt and UI.
// Self-cleaning (the two seeded projects are deleted at the end).
//
//   node scripts/verify-ask-answer-names.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const REAL_ANSWER_START = "ncage es un atributo del elemento";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);
  const created = [];
  const makeProject = async (name, standard) => {
    const p = await fetch(`${API}/api/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    created.push(p);
    return p;
  };
  const makeBrdp = (p, body) =>
    fetch(`${API}/api/projects/${p.id}/brdps`, { method: "POST", headers: auth, body: JSON.stringify({ proposal: "", validation: "Pending", ...body }) }).then((r) => r.json());

  const p301 = await makeProject("Ask names 3.0.1", "S1000D 3.0.1");
  await makeBrdp(p301, {
    identifier: "BRDP-AN-NCAGE",
    title: "NCAGE code of the responsible partner company",
    definition: "Decide whether the @ncage attribute records the CAGE code of the responsible partner company.",
    proposal: "The @ncage attribute shall always be filled in.",
    validation: "Validated",
  });
  const p42 = await makeProject("Ask names 4.2", "S1000D 4.2");
  await makeBrdp(p42, {
    identifier: "BRDP-AN-42",
    title: "NCAGE code of the responsible partner company",
    definition: "Decide how the CAGE code of the responsible partner company is recorded.",
  });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    const language = page.locator("header select, nav select").first();
    await language.selectOption("en");

    async function open(p, identifier) {
      await page.goto(`${BASE_URL}/projects/${p.id}/records`);
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tbody tr", { hasText: identifier }).first().click();
      await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
      await page.waitForTimeout(500);
    }
    async function ask(question, answerText) {
      await fetch(`${MOCK}/reset`, { method: "POST" });
      const askTextarea = page.locator("label", { hasText: /Ask a question|Haz una pregunta/ }).locator("xpath=following::textarea[1]");
      await askTextarea.fill(question);
      await askTextarea.press("Enter");
      await page.getByText(answerText).first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
      return (await fetch(`${MOCK}/last-request`).then((r) => r.json())).messages.find((m) => m.role === "system").content;
    }
    const warning = () => page.getByTestId("ask-answer-unknown-names");

    // 1. The reported answer, S1000D 3.0.1: red warning under the answer.
    await open(p301, "BRDP-AN-NCAGE");
    const sys = await ask("Which element is used for the NCAGE code?", REAL_ANSWER_START);
    const text = await warning().textContent();
    assert(
      text === "⚠ Names mentioned in the answer that do not exist in the S1000D 3.0.1 schema: <identAndStatusSection>",
      `neutral warning lists <identAndStatusSection> only -- @ncage is already in the BRDP's notice (${text})`
    );
    const color = await warning().evaluate((el) => getComputedStyle(el).color);
    assert(color === "rgb(185, 28, 28)", `the warning is red (${color})`);
    const answerText = await page.locator("div", { hasText: REAL_ANSWER_START }).last().textContent();
    assert(answerText.includes("ncage es un atributo del elemento <identAndStatusSection>, que agrupa"), "the answer itself is shown unchanged");
    assert(
      sys.includes('Never describe any of them as existing in any form — not written without "@" or angle brackets, and not with a different capitalisation (for example "Ncage" for @ncage)'),
      "prompt: the reinforced do-NOT-exist paragraph"
    );
    assert(
      // C2b Entrega 2 (A14 + A15 fused): compared with whitespace collapsed.
      sys.replace(/\s+/g, " ").includes("If the SCHEMA FACTS do not cover what is asked (for example a code, an identifier or a date that a document records), do not guess or name an element or attribute for it from memory: say that you cannot confirm the element or attribute name in the S1000D 3.0.1 schema, and suggest looking the concept up in the S1000D 3.0.1 specification."),
      "prompt: the no-facts concept instruction"
    );
    assert(!sys.includes("SCHEMA FACTS — extracted from"), "prompt: no schema facts for the NCAGE question (the real situation)");
    await page.locator('[class*="exchange"]').first().screenshot({ path: "/tmp/ask-answer-unknown-names.png" });

    // 2. Spanish interface.
    await language.selectOption("es");
    await page.waitForTimeout(300);
    const es = await warning().textContent();
    assert(
      es === "⚠ Nombres mencionados en la respuesta que no existen en el esquema S1000D 3.0.1: <identAndStatusSection>",
      `Spanish warning (${es})`
    );
    await language.selectOption("en");
    await page.waitForTimeout(300);

    // 3. A correct answer with only valid names: no warning.
    await ask("IDSTATUS_TEST where do the identification data go?", "En S1000D 3.0.1 los datos de identificación");
    assert((await warning().count()) === 0, "correct 3.0.1 answer (<idstatus>, <dmodule>): no warning");

    // 3b. A correct answer about @ncage (shape of the real Mistral answers:
    //     "The attribute **@ncage** does not exist ...", "does not contain
    //     ... including @ncage"): no warning -- @ncage is the BRDP's own
    //     reported name and no sentence is interpreted.
    await ask("NCAGE_CORRECT which element is used for the NCAGE code?", "does not exist in the S1000D 3.0.1 schema");
    assert((await warning().count()) === 0, "correct answer about @ncage (bold, 'does not contain ... including @ncage'): no warning");

    // 4. The same wrong answer in a 4.2 project: <identAndStatusSection>
    //    exists there, and this BRDP has no @ncage -> no warning.
    await open(p42, "BRDP-AN-42");
    await ask("Which element is used for the NCAGE code?", REAL_ANSWER_START);
    assert((await warning().count()) === 0, "4.2: <identAndStatusSection> exists, no warning");

    // 4b. The schema card of <identAndStatusSection> in 4.2: no child is
    //     common to all 26 schemas, so the children are listed per schema,
    //     never "children: none" -- in the prompt and in the expandable card.
    //     (C1, Part 2: "What can <identAndStatusSection> contain?" is now
    //     answered from the card without the LLM -- see
    //     verify-ask-structural.mjs -- so the prompt card is checked with an
    //     open question that still names it.)
    const sys42 = await ask("What is the role of <identAndStatusSection> in this BRDP?", "MOCK-");
    assert(sys42.includes("<identAndStatusSection> — defined in 26 schemas:"), "prompt card: 26 schemas in the header");
    assert(sys42.includes("\n  children depend on the schema (none common to all):"), "prompt card: children depend on the schema");
    assert(sys42.includes("\n    [comment]: commentAddress, commentStatus"), "prompt card: the comment schema group");
    assert(!sys42.includes("children: none"), "prompt card: never 'children: none'");
    await page.getByRole("button", { name: "<identAndStatusSection>", exact: true }).click();
    const card = page.locator('[class*="referenceDefinition"]').filter({ hasText: "defined in 26 schemas" });
    await card.waitFor({ timeout: 3000 });
    const cardText = await card.textContent();
    assert(cardText.includes("children depend on the schema (none common to all):"), "UI card: children depend on the schema");
    assert(/\[appliccrossreftable, [^\]]*wrngflds\]: dmAddress, dmStatus/.test(cardText), "UI card: data-module group lists dmAddress, dmStatus");
    assert(cardText.includes("[comment]: commentAddress, commentStatus"), "UI card: [comment] lists commentAddress, commentStatus");
    assert(cardText.includes("attributes: none") && !cardText.includes("children: none"), "UI card: attributes none, never children none");
    assert(!cardText.includes("additional"), "UI card: no 'additional' labels");
    await card.screenshot({ path: "/tmp/schema-card-identandstatussection.png" });

    // 5. Switching BRDP clears the exchange and its warning.
    await open(p301, "BRDP-AN-NCAGE");
    await ask("Which element is used for the NCAGE code?", REAL_ANSWER_START);
    assert((await warning().count()) === 1, "warning back on the 3.0.1 BRDP");
    await page.getByRole("button", { name: /^Clear$/ }).click();
    assert((await warning().count()) === 0, "Clear removes the warning with the exchange");

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    for (const p of created) await fetch(`${API}/api/projects/${p.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded projects.");
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
