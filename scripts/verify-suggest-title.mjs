// Live verification of Suggest Title against the real app (Vite + FastAPI +
// Postgres); only the Mistral TRANSPORT is mocked (mock-mistral-chat-server
// answers "Write the Title for this BRDP." from the current Title in the
// prompt). Checks:
//   - the button sits to the left of Suggest Definition;
//   - disabled with its reason on an empty Title and on a catalog BRDP;
//   - "Prohibir avee con orden de hijos incorrecto" -> a one-line Title with
//     <avee>; Accept writes it and History shows the Title change;
//   - a reference prefix "(SOPTE BREX …)" is kept;
//   - a Title that already follows the criterion -> "already follows", no
//     change offered; several lines -> not offered, with Discard; a name
//     that does not exist -> red warning, Accept still available;
//   - Spanish texts.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173, the S1000D 4.2 catalog loaded (BRDP-S1-00001). Cleans up the
// projects it creates.
//
//     node scripts/verify-suggest-title.mjs
import { chromium } from "playwright-core";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
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
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const p301 = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Suggest Title ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());
  const p42 = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Suggest Title 4.2 ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  // Pending BRDPs: nothing to embed, so Suggest is never blocked by embeddings.
  const makeBrdp = (project, fields) =>
    api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ definition: "Orden de los hijos.", validation: "Pending", ...fields }) }).then((r) => r.json());
  await makeBrdp(p301, { identifier: "BRDP-ST-AVEE", title: "Prohibir avee con orden de hijos incorrecto" });
  await makeBrdp(p301, { identifier: "BRDP-ST-EMPTY", title: "" });
  await makeBrdp(p301, { identifier: "BRDP-ST-PREFIX", title: "(SOPTE BREX 3.9.5.2.1.9-2.2) Prohibir hotspot sin apsname o con apsname vacio" });
  await makeBrdp(p301, { identifier: "BRDP-ST-OK", title: "Decidir si se usa <randlist> ALREADYOK" });
  await makeBrdp(p301, { identifier: "BRDP-ST-MULTI", title: "Prohibir avee MULTILINE" });
  await makeBrdp(p301, { identifier: "BRDP-ST-POKE", title: "Prohibir algo POKEMON" });
  await makeBrdp(p42, { identifier: "BRDP-S1-00001", title: 'Use of "I" and "O"' });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const prompts = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") prompts.push(req.postData() || "");
  });
  const language = async (lng) => {
    await page.locator("header select, nav select").first().selectOption(lng);
    await page.waitForTimeout(400);
  };
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.getByTestId("suggest-title").waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
  }
  const titleButton = () => page.getByTestId("suggest-title");
  const box = () => page.getByTestId("suggestion-title");

  await openHistoryOnEachLoad(page);
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.goto(`${BASE_URL}/projects/${p301.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // ---- Main case: avee, accepted ----
    await select("BRDP-ST-AVEE");
    const order = await page.evaluate(() => [...document.querySelectorAll("[data-testid^='suggest-']")].map((b) => b.dataset.testid));
    assert(order.indexOf("suggest-title") === order.indexOf("suggest-definition") - 1, `button left of Suggest Definition (${order.join(", ")})`);
    assert((await titleButton().textContent()).trim() === "Suggest Title", "button text EN");
    prompts.length = 0;
    await titleButton().click();
    await box().waitFor({ timeout: 15000 });
    const suggested = (await box().locator("div").first().textContent()).trim();
    assert(suggested === "Definir el orden de los elementos hijos de <avee>", `suggestion: ${suggested}`);
    const body = prompts.find((p) => p.includes("Write the Title for this BRDP.")) || "";
    assert(body.includes("rewrite the BRDP's current Title as the name of its decision point"), "the request carries the Suggest Title prompt");
    assert(body.includes('\\"temperature\\":0.3') || body.includes('"temperature":0.3'), "temperature 0.3");
    assert((await box().locator("[class*='vocabWarning']").count()) === 0, "no name warning (<avee> exists in 3.0.1)");
    await page.screenshot({ path: shot("suggest-title-avee.png"), fullPage: true });
    await box().getByRole("button", { name: "Accept" }).click();
    await page.waitForTimeout(800);
    const brdps = await api(`/api/projects/${p301.id}/brdps`).then((r) => r.json());
    assert(brdps.find((b) => b.identifier === "BRDP-ST-AVEE").title === suggested, "Accept saved the Title");
    const history = await page.getByText("Prohibir avee con orden de hijos incorrecto").count();
    assert(history >= 1, "History shows the old Title");

    // ---- Empty Title ----
    await select("BRDP-ST-EMPTY");
    assert(await titleButton().isDisabled(), "empty Title: disabled");
    assert((await titleButton().getAttribute("title")) === "Write a Title first: Suggest Title rewrites the one already there", "empty Title: reason");

    // ---- Prefix kept ----
    await select("BRDP-ST-PREFIX");
    await titleButton().click();
    await box().waitFor({ timeout: 15000 });
    const withPrefix = (await box().locator("div").first().textContent()).trim();
    assert(withPrefix.startsWith("(SOPTE BREX 3.9.5.2.1.9-2.2) "), `prefix kept: ${withPrefix}`);
    await box().getByRole("button", { name: "Discard" }).click();

    // ---- Already follows the criterion ----
    await select("BRDP-ST-OK");
    await titleButton().click();
    const follows = page.getByTestId("title-already-follows");
    await follows.waitFor({ timeout: 15000 });
    assert((await follows.textContent()).includes("The Title already follows the criterion"), "already follows: message");
    assert((await box().count()) === 0, "already follows: no change offered");
    await follows.getByRole("button", { name: "Discard" }).click();

    // ---- Several lines: not offered ----
    await select("BRDP-ST-MULTI");
    await titleButton().click();
    await page.getByText("more than one line instead of a Title").waitFor({ timeout: 15000 });
    assert((await box().count()) === 0, "several lines: not offered");
    await page.getByRole("button", { name: "Discard" }).click();

    // ---- Unknown name: red warning, Accept available ----
    await select("BRDP-ST-POKE");
    await titleButton().click();
    await box().waitFor({ timeout: 15000 });
    const warn = box().locator("[class*='vocabWarning']");
    assert((await warn.count()) === 1 && (await warn.textContent()).includes("The suggested Title uses names not found in the S1000D 3.0.1 schema: <pokemon>"), "unknown name: red warning");
    assert(await box().getByRole("button", { name: "Accept" }).isEnabled(), "unknown name: Accept available");
    await page.screenshot({ path: shot("suggest-title-unknown-name.png"), fullPage: true });

    // ---- Spanish ----
    await language("es");
    assert((await titleButton().textContent()).trim() === "Sugerir Título", "button text ES");
    assert((await warn.textContent()).includes("El Título sugerido usa nombres no encontrados en el esquema de S1000D 3.0.1: <pokemon>"), "warning ES");
    await box().getByRole("button", { name: "Descartar" }).click();
    await select("BRDP-ST-EMPTY");
    assert((await titleButton().getAttribute("title")) === "Escribe antes un Título: Sugerir Título reescribe el que ya hay", "empty Title reason ES");
    await language("en");

    // ---- Catalog BRDP ----
    await page.goto(`${BASE_URL}/projects/${p42.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select("BRDP-S1-00001");
    await page.waitForFunction(() => document.querySelector("[data-testid='suggest-title']")?.disabled, null, { timeout: 15000 });
    assert((await titleButton().getAttribute("title")) === "Official title from the standard catalog", "catalog BRDP: disabled with its reason");
    const direct = await api(`/api/projects/${p42.id}/brdps/${(await api(`/api/projects/${p42.id}/brdps`).then((r) => r.json()))[0].id}/similar?kind=title`);
    assert(direct.status === 400, `catalog BRDP: /similar?kind=title answers 400 (${direct.status})`);
  } finally {
    await browser.close();
    await api(`/api/projects/${p301.id}?permanent=true`, { method: "DELETE" });
    await api(`/api/projects/${p42.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
