// Verification for "Nombres navegables en las respuestas de Ask sin IA":
// in an answer taken from the schema, `<x>`/`@y` names of the vocabulary are
// links that open a floating card (children, parents, attributes / values,
// owners) with breadcrumb, Back, Close, Esc and "Copy name". Real backend,
// real Postgres, real Vite; only the chat transport is mocked
// (scripts/mock-mistral-chat-server.mjs), and the mock proves the card never
// calls the LLM. Self-cleaning (the seeded projects are deleted at the end).
//
//   node scripts/verify-ask-schema-navigation.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

const lastRequest = () => fetch(`${MOCK}/last-request`).then((r) => r.json());

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

  const p42 = await makeProject("Ask schema nav 4.2", "S1000D 4.2");
  await makeBrdp(p42, { identifier: "BRDP-NAV-A", title: "Use of paragraphs", definition: "Decide where paragraphs are used." });
  await makeBrdp(p42, { identifier: "BRDP-NAV-B", title: "Use of emphasis", definition: "Decide whether emphasis is used." });
  const pDita = await makeProject("Ask schema nav DITA", "DITA 1.3 Xpath2.0");
  await makeBrdp(pDita, { identifier: "BRDP-NAV-DITA", title: "Paragraph classes", definition: "Decide the paragraph output classes." });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  // Every schema-card request the page makes (to prove the cache).
  let cardRequests = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/schema-cards")) cardRequests.push(decodeURIComponent(url.slice(url.indexOf("/api/schema-cards"))));
  });
  const requestsFor = (needle) => cardRequests.filter((u) => u.includes(needle)).length;

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    const language = page.locator("header select, nav select").first();

    async function open(p, identifier) {
      await page.goto(`${BASE_URL}/projects/${p.id}/records`);
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await select(identifier);
    }
    async function select(identifier) {
      await page.locator("tbody tr", { hasText: identifier }).first().click();
      await page.waitForSelector("text=/BRDP Assistant|Asistente de BRDP/i", { timeout: 5000 });
      await page.waitForTimeout(400);
    }
    const answerBox = () => page.locator('[class*="answerBox"]').first();
    async function ask(question) {
      await fetch(`${MOCK}/reset`, { method: "POST" });
      const box = page.locator("label", { hasText: /Ask a question|Haz una pregunta/ }).locator("xpath=following::textarea[1]");
      await box.fill(question);
      await box.press("Enter");
      await page.waitForFunction(() => !document.body.innerText.includes("Thinking…") && !document.body.innerText.includes("Pensando…"), null, { timeout: 15000 });
      await answerBox().waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
    }
    const card = () => page.getByTestId("schema-nav-card");
    const cardTitle = () => card().getByTestId("schema-nav-title").innerText();
    const breadcrumb = async () => (await card().getByTestId("schema-nav-breadcrumb").innerText()).replace(/\s+/g, " ").trim();
    const waitReady = () => card().getByTestId("schema-nav-loading").waitFor({ state: "detached", timeout: 10000 });
    const inViewport = async () => {
      const box = await card().boundingBox();
      const vp = page.viewportSize();
      return box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 0.5 && box.y + box.height <= vp.height + 0.5;
    };
    const exchangeText = () => page.locator('[class*="exchange"]').first().innerText();

    // ─── 1. "¿Dónde puede ir <para>?" → levelledPara → title → Atrás → Cerrar ───
    await open(p42, "BRDP-NAV-A");
    await language.selectOption("es");
    await ask("¿Dónde puede ir <para>?");
    assert((await page.getByTestId("ask-answer-deterministic").count()) === 1, "answer taken from the schema");
    const links = page.locator('[data-testid^="schema-link-"]');
    assert((await links.count()) === 44, `<para> and its 43 parents are links (${await links.count()})`);
    const threadBefore = await exchangeText();

    cardRequests = [];
    await page.getByTestId("schema-link-element:levelledPara").click();
    await card().waitFor();
    await waitReady();
    assert((await cardTitle()) === "<levelledPara>", "card of <levelledPara> opens");
    assert((await breadcrumb()) === "levelledPara", "breadcrumb: levelledPara");
    assert(await inViewport(), "card inside the viewport");
    {
      const link = await page.getByTestId("schema-link-element:levelledPara").boundingBox();
      const box = await card().boundingBox();
      const nextTo = Math.abs(box.y - (link.y + link.height + 4)) <= 2 || Math.abs(box.y + box.height - (link.y - 4)) <= 2;
      assert(nextTo && box.x <= link.x + 1, `card next to the link (link ${Math.round(link.x)},${Math.round(link.y)}; card ${Math.round(box.x)},${Math.round(box.y)})`);
    }
    assert((await card().getByTestId("schema-nav-children").textContent()).includes("Hijos"), "children section (ES)");
    assert(requestsFor("names=levelledPara&full=true") === 1, "one full-card request for levelledPara");
    await card().getByTestId("schema-nav-link-element:title").first().click();
    await waitReady();
    assert((await cardTitle()) === "<title>", "card of <title>");
    assert((await breadcrumb()) === "levelledPara › title", "breadcrumb: levelledPara › title");
    await page.screenshot({ path: shot("ask-schema-nav-breadcrumb.png") });
    await card().getByTestId("schema-nav-back").click();
    assert((await cardTitle()) === "<levelledPara>", "Atrás goes back to <levelledPara>");
    assert(requestsFor("names=levelledPara") === 1, "Atrás does not fetch levelledPara again");
    await card().getByTestId("schema-nav-link-element:title").first().click();
    assert(requestsFor("names=title") === 1, "coming back to <title> does not fetch it again");
    await card().getByTestId("schema-nav-close").click();
    assert((await card().count()) === 0, "Cerrar closes the card");
    assert((await exchangeText()) === threadBefore, "navigation added nothing to the Ask thread");
    const req = await lastRequest();
    assert(!req || !req.messages, "no LLM call during the whole navigation");

    // ─── 2. Long lists: <para>'s 43 parents with "+23 más" ────────────────────
    await page.getByTestId("schema-link-element:para").first().click();
    await waitReady();
    const parents = card().getByTestId("schema-nav-parents");
    assert((await parents.locator('[data-testid^="schema-nav-link-"]').count()) === 20, "20 parents shown before expanding");
    assert((await parents.getByTestId("schema-nav-more").innerText()) === "+23 más", "+23 más");
    await parents.getByTestId("schema-nav-more").click();
    assert((await parents.locator('[data-testid^="schema-nav-link-"]').count()) === 43, "all 43 parents after expanding, none lost");
    assert(await inViewport(), "the <para> card does not overflow the screen (scrolls inside)");
    await page.screenshot({ path: shot("ask-schema-nav-para-parents.png") });

    // ─── 3. Esc closes; Copiar nombre ─────────────────────────────────────────
    await page.keyboard.press("Escape");
    assert((await card().count()) === 0, "Esc closes like Cerrar");

    await ask("¿Qué elementos tienen @emphasisType?");
    cardRequests = [];
    await page.getByTestId("schema-link-attribute:emphasisType").first().click();
    await waitReady();
    assert((await cardTitle()) === "@emphasisType", "card of @emphasisType");
    const values = await card().getByTestId("schema-nav-values").textContent();
    assert(/em01/.test(values), `values listed (${values.slice(0, 60)})`);
    assert(requestsFor("/attribute?") === 1, "attribute card uses /api/schema-cards/attribute");
    await card().getByTestId("schema-nav-copy").click();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === "@emphasisType", "Copiar nombre copies @emphasisType");
    assert((await card().getByTestId("schema-nav-copy-state").innerText()) === "@emphasisType copiado", "copied note");
    await card().getByTestId("schema-nav-link-element:emphasis").click();
    await waitReady();
    assert((await breadcrumb()) === "@emphasisType › emphasis", "breadcrumb: @emphasisType › emphasis");
    await card().getByTestId("schema-nav-copy").click();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === "<emphasis>", "Copiar nombre copies <emphasis>");
    await page.screenshot({ path: shot("ask-schema-nav-attribute.png") });
    await page.keyboard.press("Escape");
    assert((await card().count()) === 0, "Esc closes the attribute path");

    // ─── 4. @changeMark: 672 owners, expandable, inside the screen ────────────
    await ask("¿Qué elementos tienen @changeMark?");
    await page.getByTestId("schema-link-attribute:changeMark").first().click();
    await waitReady();
    const owners = card().getByTestId("schema-nav-owners");
    const more = owners.getByTestId("schema-nav-more");
    assert((await more.count()) >= 1, "@changeMark owners cut with +N más");
    const before = await owners.locator('[data-testid^="schema-nav-link-"]').count();
    await more.first().click();
    const after = await owners.locator('[data-testid^="schema-nav-link-"]').count();
    assert(after > before, `+N más expands the list (${before} → ${after})`);
    assert(await inViewport(), "the @changeMark card does not overflow the screen");
    await page.keyboard.press("Escape");

    // ─── 5. Names not in the schema, and LLM answers, are plain text ─────────
    await ask("¿Qué puede contener <pokemon>?");
    assert((await page.getByTestId("ask-answer-deterministic").count()) === 1, "<pokemon>: answer from the schema");
    assert((await page.locator('[data-testid^="schema-link-"]').count()) === 0, "<pokemon> is not a link");
    await ask("¿Dónde va el NCAGE?");
    assert((await page.getByTestId("ask-answer-deterministic").count()) === 0, "NCAGE question goes to the LLM");
    assert((await answerBox().innerText()).includes("<identAndStatusSection>"), "LLM answer mentions <identAndStatusSection>");
    assert((await page.locator('[data-testid^="schema-link-"]').count()) === 0, "LLM answers have no links");

    // ─── 6. Load error: visible in the card, never stuck; Retry ──────────────
    // A card not loaded yet (levelledPara is already in the cache).
    await ask("¿Dónde puede ir <para>?");
    await page.route("**/api/schema-cards?*names=listItem*", (route) => route.fulfill({ status: 500, body: JSON.stringify({ detail: "boom" }) }));
    await page.getByTestId("schema-link-element:listItem").click();
    await card().getByTestId("schema-nav-error").waitFor({ timeout: 10000 });
    assert((await card().getByTestId("schema-nav-error").innerText()).startsWith("No se pudo cargar esta ficha"), "error shown in the card (HR7)");
    assert((await card().getByTestId("schema-nav-loading").count()) === 0, "not stuck loading");
    await page.screenshot({ path: shot("ask-schema-nav-error.png") });
    await page.unroute("**/api/schema-cards?*names=listItem*");
    await card().getByTestId("schema-nav-retry").click();
    await waitReady();
    assert((await card().getByTestId("schema-nav-children").count()) === 1, "Retry loads the card");

    // ─── 7. BRDP change with the card open: closes and clears the cache ───────
    cardRequests = [];
    await select("BRDP-NAV-B");
    assert((await card().count()) === 0, "changing BRDP closes the card");
    await ask("¿Dónde puede ir <para>?");
    await page.getByTestId("schema-link-element:levelledPara").click();
    await waitReady();
    assert(requestsFor("names=levelledPara") === 1, "after the BRDP change the card is fetched again (cache cleared)");

    // ─── 8. English texts ────────────────────────────────────────────────────
    await language.selectOption("en");
    await card().getByTestId("schema-nav-link-element:title").first().click();
    await waitReady();
    assert((await card().getByTestId("schema-nav-back").innerText()) === "Back", "Back (EN)");
    assert((await card().getByTestId("schema-nav-close").innerText()) === "Close", "Close (EN)");
    assert((await card().getByTestId("schema-nav-copy").innerText()) === "Copy name", "Copy name (EN)");
    assert((await card().getByTestId("schema-nav-children").textContent()).includes("Children"), "Children (EN)");
    await page.keyboard.press("Escape");

    // ─── 9. DITA: <p> and @outputclass ───────────────────────────────────────
    await open(pDita, "BRDP-NAV-DITA");
    await ask("What attributes does <p> take?");
    assert((await page.getByTestId("ask-answer-deterministic").count()) === 1, "DITA: answer from the schema");
    await page.getByTestId("schema-link-attribute:outputclass").first().click();
    await waitReady();
    assert((await cardTitle()) === "@outputclass", "DITA: card of @outputclass");
    assert((await card().getByTestId("schema-nav-values").textContent()).includes("no closed list of values"), "DITA: free values");
    await card().getByTestId("schema-nav-owners").getByTestId("schema-nav-more").first().click();
    await card().getByTestId("schema-nav-link-element:p").click();
    await waitReady();
    assert((await breadcrumb()) === "@outputclass › p", "DITA: breadcrumb @outputclass › p");
    assert((await card().getByTestId("schema-nav-parents").locator('[data-testid^="schema-nav-link-"]').count()) > 0, "DITA: <p> parents are links");
    await page.screenshot({ path: shot("ask-schema-nav-dita.png") });
    await card().getByTestId("schema-nav-close").click();

    console.log(`\nAll checks passed. Screenshots: ${shot("ask-schema-nav-")}*.png`);
  } finally {
    for (const p of created) await fetch(`${API}/api/projects/${p.id}?permanent=true`, { method: "DELETE", headers: auth }).catch(() => {});
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
