// Verification for '"+N más" desplegable en las respuestas de Ask y buscador
// del esquema': in an answer taken from the schema, "+N más" expands the cut
// names in place (each a link) and "Mostrar menos" folds them back; the
// search box in the Ask header opens the same schema card. Real backend,
// Postgres and Vite; only the chat transport is mocked, and the mock proves
// neither feature calls the LLM. Self-cleaning.
//
//   node scripts/verify-ask-schema-search-and-more.mjs
import { chromium } from "playwright-core";

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

  const p42 = await makeProject("Ask schema search 4.2", "S1000D 4.2");
  await makeBrdp(p42, { identifier: "BRDP-NAV-A", title: "Use of paragraphs", definition: "Decide where paragraphs are used." });
  await makeBrdp(p42, { identifier: "BRDP-NAV-B", title: "Use of emphasis", definition: "Decide whether emphasis is used." });
  const pDita = await makeProject("Ask schema search DITA", "DITA 1.3 Xpath2.0");
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


    const search = () => page.getByTestId("schema-search-input");
    const moreButtons = () => page.locator('[data-testid^="answer-more-"]:not([data-testid^="answer-more-list-"])');

    // ─── 1. "¿Qué elementos tienen @changeMark?": "+N más" expands in place ──
    await open(p42, "BRDP-NAV-A");
    await language.selectOption("es");
    await ask("¿Qué elementos tienen @changeMark?");
    assert((await page.getByTestId("ask-answer-deterministic").count()) === 1, "answer taken from the schema");
    const nMore = await moreButtons().count();
    assert(nMore > 1, `several cut lists, each with its own "+N más" (${nMore})`);
    const answerText = await answerBox().innerText();
    assert(!answerText.includes("+more:"), "no raw marker visible");
    const more0 = page.getByTestId("answer-more-0");
    const label0 = await more0.innerText();
    const hidden0 = Number(label0.match(/\+(\d+)/)[1]);
    assert(/^\+\d+ más$/.test(label0), `first cut: ${label0}`);
    const linksBefore = await page.locator('[data-testid^="schema-link-"]').count();
    await more0.click();
    const list0 = page.getByTestId("answer-more-list-0");
    assert((await list0.locator('[data-testid^="schema-link-"]').count()) === hidden0, `expanded: the ${hidden0} hidden names, all links`);
    assert((await page.locator('[data-testid^="schema-link-"]').count()) === linksBefore + hidden0, "no name lost or duplicated");
    assert((await moreButtons().count()) === nMore - 1, "only this list expanded; the others stay folded");
    await page.getByTestId("answer-more-1").click();
    assert((await page.getByTestId("answer-more-list-1").count()) === 1 && (await list0.count()) === 1, "a second list expands on its own");
    await page.getByTestId("answer-less-1").click();
    assert((await page.getByTestId("answer-more-1").count()) === 1 && (await list0.count()) === 1, "folding the second keeps the first expanded");
    await page.screenshot({ path: "/tmp/ask-answer-more-expanded.png" });

    const expandedLink = list0.locator('[data-testid^="schema-link-"]').last();
    const expandedName = (await expandedLink.getAttribute("data-testid")).replace("schema-link-element:", "");
    await expandedLink.click();
    await card().waitFor();
    await waitReady();
    assert((await cardTitle()) === `<${expandedName}>`, `an expanded name opens its card (<${expandedName}>)`);
    assert(await inViewport(), "card inside the viewport");
    await page.keyboard.press("Escape");
    assert((await page.getByTestId("answer-less-0").innerText()) === "Mostrar menos", "Mostrar menos (ES)");
    await page.getByTestId("answer-less-0").click();
    assert((await list0.count()) === 0 && (await page.getByTestId("answer-more-0").innerText()) === label0, "Mostrar menos folds it back");

    // A new answer folds everything again.
    await page.getByTestId("answer-more-0").click();
    await ask("¿Qué elementos tienen @changeMark?");
    assert((await page.locator('[data-testid^="answer-more-list-"]').count()) === 0 && (await moreButtons().count()) === nMore, "a new answer starts with every list folded");
    const req1 = await lastRequest();
    assert(!req1 || !req1.messages, "no LLM call");

    // ─── 2. Search: "levell" + keyboard → <levelledPara> → title → Atrás → Esc
    await search().fill("levell");
    const list = page.getByTestId("schema-search-list");
    await list.waitFor();
    assert((await list.locator("li").first().innerText()).includes("<levelledPara>"), "suggestion <levelledPara>");
    await page.screenshot({ path: "/tmp/ask-schema-search-suggestions.png" });
    await search().press("ArrowDown");
    await search().press("ArrowUp");
    const activeLabel = await list.locator('li[aria-selected="true"]').innerText();
    assert(activeLabel.includes("<levelledPara>"), "arrows move the highlight");
    await search().press("Enter");
    await card().waitFor();
    await waitReady();
    assert((await cardTitle()) === "<levelledPara>", "Enter opens <levelledPara>");
    assert((await breadcrumb()) === "levelledPara", "breadcrumb starts at levelledPara");
    assert((await list.count()) === 0, "list closed after choosing");
    await card().getByTestId("schema-nav-link-element:title").first().click();
    await waitReady();
    assert((await breadcrumb()) === "levelledPara › title", "breadcrumb: levelledPara › title");
    await card().getByTestId("schema-nav-back").click();
    assert((await cardTitle()) === "<levelledPara>", "Atrás");
    await page.screenshot({ path: "/tmp/ask-schema-search-card.png" });
    await page.keyboard.press("Escape");
    assert((await card().count()) === 0, "Esc closes the card");

    // Esc with the list open closes only the list; a click reopens it.
    await search().fill("");
    await search().fill("levell");
    await list.waitFor();
    await search().press("Escape");
    assert((await list.count()) === 0, "Esc closes the list");
    await search().click();
    assert((await list.count()) === 1, "a click on the box reopens the list");
    await search().press("Escape");

    // ─── 3. "@emph" → @emphasisType; "title" → both kinds; "pokemon" ─────────
    await search().fill("@emph");
    await list.waitFor();
    const emphOptions = await list.locator("li").allInnerTexts();
    assert(emphOptions.every((o) => o.startsWith("@")), `"@" limits to attributes (${emphOptions.length})`);
    await page.getByTestId("schema-search-option-attribute:emphasisType").click();
    await waitReady();
    assert((await cardTitle()) === "@emphasisType", "@emph opens @emphasisType");
    assert((await breadcrumb()) === "@emphasisType", "breadcrumb @emphasisType");

    // Search with a card already open: replaced, breadcrumb restarts.
    await card().getByTestId("schema-nav-link-element:emphasis").click();
    await waitReady();
    assert((await breadcrumb()) === "@emphasisType › emphasis", "card navigated to emphasis");
    await search().fill("title");
    await list.waitFor();
    assert((await page.getByTestId("schema-search-option-element:title").count()) === 1 && (await page.getByTestId("schema-search-option-attribute:title").count()) === 1, "title: <title> and @title suggested");
    const titleOptions = await list.locator("li").count();
    assert(titleOptions <= 10, `at most 10 suggestions (${titleOptions})`);
    await page.getByTestId("schema-search-option-element:title").click();
    await waitReady();
    assert((await cardTitle()) === "<title>" && (await breadcrumb()) === "title", "card replaced, breadcrumb restarts at title");

    await page.keyboard.press("Escape");
    await search().fill("a");
    await list.waitFor();
    assert((await list.locator("li").count()) === 10, "many matches: exactly 10 suggestions");
    await search().fill("pokemon");
    const noMatch = page.getByTestId("schema-search-no-match");
    await noMatch.waitFor();
    assert((await noMatch.innerText()) === "No existe en el esquema S1000D 4.2", "pokemon: No existe en el esquema S1000D 4.2");
    await search().press("Enter");
    assert((await card().count()) === 0, "pokemon: no card");
    await page.screenshot({ path: "/tmp/ask-schema-search-no-match.png" });
    const req2 = await lastRequest();
    assert(!req2 || !req2.messages, "search never calls the LLM");
    assert((await exchangeText()).includes("@changeMark"), "search added nothing to the Ask thread");

    // ─── 4. BRDP change: search empties, card closes ─────────────────────────
    await search().fill("levell");
    await search().press("Enter");
    await card().waitFor();
    await select("BRDP-NAV-B");
    assert((await search().inputValue()) === "", "BRDP change empties the search");
    assert((await card().count()) === 0, "BRDP change closes the card");

    // ─── 5. English texts ────────────────────────────────────────────────────
    await language.selectOption("en");
    assert((await search().getAttribute("placeholder")) === "Search the schema…", "placeholder (EN)");
    await search().fill("pokemon");
    assert((await page.getByTestId("schema-search-no-match").innerText()) === "Not in the S1000D 4.2 schema", "no match (EN)");
    await search().fill("");
    await ask("Which elements have @changeMark?");
    await page.getByTestId("answer-more-0").click();
    assert((await page.getByTestId("answer-less-0").innerText()) === "Show less", "Show less (EN)");
    await language.selectOption("es");
    assert((await search().getAttribute("placeholder")) === "Buscar en el esquema…", "placeholder (ES)");

    // ─── 6. DITA: p and @outputclass ─────────────────────────────────────────
    await open(pDita, "BRDP-NAV-DITA");
    await search().fill("p");
    await list.waitFor();
    assert((await list.locator("li").first().innerText()).includes("<p>"), "DITA: <p> first");
    await search().press("Enter");
    await waitReady();
    assert((await cardTitle()) === "<p>", "DITA: card of <p>");
    await page.keyboard.press("Escape");
    await search().fill("@outputc");
    await list.waitFor();
    await search().press("Enter");
    await waitReady();
    assert((await cardTitle()) === "@outputclass", "DITA: @outputclass");
    await page.screenshot({ path: "/tmp/ask-schema-search-dita.png" });

    // Project change: the search box of the new project starts empty.
    await search().fill("levell");
    await open(p42, "BRDP-NAV-A");
    assert((await search().inputValue()) === "" && (await card().count()) === 0, "project change: empty search, card closed");

    console.log("\nAll checks passed. Screenshots: /tmp/ask-answer-more-*.png, /tmp/ask-schema-search-*.png");
  } finally {
    for (const p of created) await fetch(`${API}/api/projects/${p.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
