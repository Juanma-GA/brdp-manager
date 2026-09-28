// Verification for "Consolidación C1", Part 2: Ask answers structural
// questions (children, parents, attributes, values) from the complete schema
// card, without the LLM. Real backend, real Postgres, real Vite; only the
// chat transport is mocked (scripts/mock-mistral-chat-server.mjs). "No LLM
// call" is checked on the mock itself: /reset before the question, and
// /last-request still empty after the answer.
// Self-cleaning (the two seeded projects are deleted at the end).
//
//   node scripts/verify-ask-structural.mjs
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

const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());
const noLlmCall = (req) => !req || !req.messages;

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

  const p42 = await makeProject("Ask structural 4.2", "S1000D 4.2");
  await makeBrdp(p42, {
    identifier: "BRDP-AS-42",
    title: "Use of emphasis in running text",
    definition: "Decide whether emphasis is used in running text.",
  });
  const pDita = await makeProject("Ask structural DITA", "DITA 1.3 Xpath2.0");
  await makeBrdp(pDita, {
    identifier: "BRDP-AS-DITA",
    title: "Content of task steps",
    definition: "Decide what a task step may hold.",
  });

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
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
    const label = () => page.getByTestId("ask-answer-deterministic");
    const answerBox = () => page.locator('[class*="answerBox"]').first();
    // Asks, waits for the answer, returns { deterministic, text, req }.
    async function ask(question) {
      await fetch(`${MOCK}/reset`, { method: "POST" });
      const box = page.locator("label", { hasText: /Ask a question|Haz una pregunta/ }).locator("xpath=following::textarea[1]");
      await box.fill(question);
      await box.press("Enter");
      await page.waitForFunction(() => !document.body.innerText.includes("Thinking…") && !document.body.innerText.includes("Pensando…"), null, { timeout: 15000 });
      await answerBox().waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
      return { deterministic: (await label().count()) === 1, text: await answerBox().innerText(), req: await lastRequest() };
    }

    // 1. The real failure of the 007a9b1 run: children by schema groups,
    //    never the parents -- with the label, and no LLM call.
    await open(p42, "BRDP-AS-42");
    await language.selectOption("es");
    let r = await ask("¿Qué puede contener <identAndStatusSection>?");
    assert(r.deterministic, "identAndStatusSection: answered from the schema (label shown)");
    assert(noLlmCall(r.req), "identAndStatusSection: no LLM call");
    assert((await label().textContent()) === "Respuesta obtenida del esquema S1000D 4.2 (sin IA)", "Spanish label, exact text");
    assert(r.text.includes("Sus hijos dependen del esquema (ninguno es común a todos):"), "children depend on the schema");
    assert(/comment:?\s*<commentAddress>, <commentStatus>/.test(r.text.replace(/\*/g, "")), "comment group: <commentAddress>, <commentStatus>");
    assert(r.text.includes("<dmAddress>") && r.text.includes("<dmStatus>"), "data-module group: <dmAddress>, <dmStatus>");
    assert(!r.text.includes("<dmodule>") && !r.text.includes("<ddn>") && !r.text.includes("puede ir dentro"), "never the parents (<dmodule>, <ddn>, ...)");
    assert((await page.getByText("Schema facts used:").or(page.getByText("Fichas de esquema usadas:")).count()) >= 1, "the expandable card stays below the answer");
    await page.locator('[class*="exchange"]').first().screenshot({ path: "/tmp/ask-structural-deterministic.png" });
    console.log("Screenshot: /tmp/ask-structural-deterministic.png");

    // 2. A follow-up goes to the LLM with the deterministic answer as the
    //    previous assistant turn.
    const previous = r.text;
    r = await ask("¿Y por qué?");
    assert(!r.deterministic, "follow-up: no label");
    assert(r.req?.messages, "follow-up: goes to the LLM");
    const turns = r.req.messages.filter((m) => m.role !== "system");
    assert(turns.length === 3, `follow-up: previous question, previous answer and the new question (${turns.length})`);
    assert(turns[0].content === "¿Qué puede contener <identAndStatusSection>?", "follow-up: previous question verbatim");
    assert(turns[1].role === "assistant" && turns[1].content.includes("Sus hijos dependen del esquema"), "follow-up: the deterministic answer is the previous assistant message");
    assert(previous.includes("commentAddress"), "(the deterministic answer shown was the one carried)");
    await page.getByRole("button", { name: /^(Clear|Borrar)$/ }).click();

    // 3. English, parents, complete (43), no LLM.
    await language.selectOption("en");
    r = await ask("Where can <para> go?");
    assert(r.deterministic && noLlmCall(r.req), "Where can <para> go?: from the schema, no LLM call");
    assert((await label().textContent()) === "Answer taken from the S1000D 4.2 schema (no AI)", "English label, exact text");
    assert(r.text.includes("<para> can go inside 43 elements"), "all 43 parents, in English");
    for (const parent of ["levelledPara", "proceduralStep", "footnote", "entry", "listItem"]) assert(r.text.includes(`<${parent}>`), `parent <${parent}> listed`);
    assert(!r.text.includes("more") && !r.text.includes("partial"), "complete list, never cut");

    // 4. Values: the full range, no LLM.
    r = await ask("¿Qué valores admite @emphasisType?");
    assert(r.deterministic && noLlmCall(r.req), "¿Qué valores admite @emphasisType?: from the schema, no LLM call");
    assert(r.text.includes("em01–em99"), "em01–em99");

    // 5. A name that does not exist: "does not exist", no LLM.
    r = await ask("¿Qué contiene <pokemon>?");
    assert(r.deterministic && noLlmCall(r.req), "¿Qué contiene <pokemon>?: from the schema, no LLM call");
    assert(r.text.includes("<pokemon> no existe en el esquema S1000D 4.2."), "<pokemon> no existe en el esquema S1000D 4.2");

    // 6. Wrong type.
    r = await ask("What attributes does @table have?");
    assert(r.deterministic && noLlmCall(r.req), "@table as an attribute: from the schema, no LLM call");
    assert(r.text.includes("table is an element, not an attribute"), "table is an element, not an attribute");

    // 7. Reasons go to the LLM.
    r = await ask("¿Por qué se decidió no usar <emphasis>?");
    assert(!r.deterministic && r.req?.messages, "¿Por qué se decidió no usar <emphasis>?: LLM, no label");

    // 8. DITA <step>: deterministic.
    await open(pDita, "BRDP-AS-DITA");
    r = await ask("¿Qué puede contener <step>?");
    assert(r.deterministic && noLlmCall(r.req), "DITA ¿Qué puede contener <step>?: from the schema, no LLM call");
    assert(r.text.includes("<cmd>") && r.text.includes("<substeps>"), "DITA <step> children: <cmd>, <substeps>");
    assert((await label().textContent()) === "Answer taken from the DITA 1.3 Xpath2.0 schema (no AI)", "label names the DITA standard");

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
