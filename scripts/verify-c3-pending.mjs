// Live verification for Consolidation C3, Part 2 (pending items):
//  - Project Configuration (C3b): the save button itself confirms -- disabled
//    with "Saving…" while it saves, green with a ✓ for about a second after
//    it saved (no "Saved" text any more); a failed save shows its error next
//    to the button until the next attempt (HR7), never a colour flash.
//  - BRDP Records: a failure of the catalog endpoint shows a visible warning
//    and leaves the catalog-identifier check unavailable (never "empty":
//    Suggest Definition is not reported as blocked by the catalog).
// Against the real app (Vite + FastAPI + Postgres). The two failures are
// provoked by intercepting the request in the browser (page.route), the
// only way to make a real endpoint fail on demand here.
//
//     node scripts/verify-c3-pending.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}`);
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
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `C3 pending ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  await api(`/api/projects/${project.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({ identifier: "BRDP-C3-CAT", title: "Catalog check", definition: "", validation: "Pending" }),
  });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");

    // ---- Project Configuration: confirmation on the button (C3b) ----
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.waitForSelector("#cfg-modelIdentCode", { timeout: 10000 });
    const button = page.getByTestId("config-save");
    // Read the colour with the mouse away (no :hover) and after the button's
    // 0.2 s background transition.
    const bg = async () => {
      await page.mouse.move(5, 5);
      await page.waitForTimeout(300);
      return button.evaluate((el) => getComputedStyle(el).backgroundColor);
    };
    const normalBg = await bg();
    assert(normalBg === "rgb(46, 116, 181)", `the save button is the shared primary Button (${normalBg})`);
    // Hold the PUT a moment so the saving state can be seen.
    let releasePut;
    const putHeld = new Promise((resolve) => (releasePut = resolve));
    await page.route(`**/api/projects/${project.id}/config`, async (route) => {
      if (route.request().method() === "PUT") await putHeld;
      await route.continue();
    });
    await page.fill("#cfg-modelIdentCode", "C3TEST");
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="config-save"]')?.getAttribute("data-state") === "busy");
    assert((await button.textContent()) === "Saving…" && (await button.isDisabled()), `while saving: disabled, "Saving…" (${await button.textContent()})`);
    releasePut();
    await page.waitForFunction(() => document.querySelector('[data-testid="config-save"]')?.getAttribute("data-state") === "success", null, { timeout: 5000 });
    const t0 = Date.now();
    const green = await bg();
    assert(green === "rgb(22, 101, 52)", `after saving: the button turns green (${green})`);
    assert((await button.textContent()) === "✓Save Configuration", `after saving: ✓ on the button (${await button.textContent()})`);
    assert((await page.getByRole("button", { name: "Save Configuration" }).count()) === 1, "the ✓ is not part of the button's name");
    await page.locator("form").first().screenshot({ path: "/tmp/config-save-success.png" });
    await page.waitForFunction(() => !document.querySelector('[data-testid="config-save"]')?.hasAttribute("data-state"), null, { timeout: 5000 });
    const back = (Date.now() - t0) / 1000;
    assert(back <= 2, `…and goes back to normal after about a second (${back.toFixed(1)} s)`);
    const backBg = await bg();
    assert(backBg === normalBg && (await button.textContent()) === "Save Configuration", `back to its normal colour and label (${backBg})`);
    assert((await page.getByTestId("config-saved").count()) === 0 && !(await page.locator("form").first().textContent()).includes("Saved"), 'no "Saved" text next to the button any more');
    assert((await page.inputValue("#cfg-modelIdentCode")) === "C3TEST", "the page was not reloaded away: the field keeps the saved value");
    const stored = await api(`/api/projects/${project.id}/config`).then((r) => r.json());
    assert(stored.project_config?.modelIdentCode === "C3TEST", "the value was really saved");
    await page.unroute(`**/api/projects/${project.id}/config`);

    // A failed save: the error stays next to the button, never a colour flash.
    await page.route(`**/api/projects/${project.id}/config`, (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "database unavailable" }) }) : route.continue()
    );
    await page.fill("#cfg-modelIdentCode", "C3FAIL");
    await button.click();
    const error = page.getByTestId("config-save-error");
    await error.waitFor({ timeout: 5000 });
    const errorText = await error.textContent();
    assert(errorText.startsWith("Could not save:") && errorText.includes("database unavailable"), `save error shown (${errorText})`);
    const afterError = await bg();
    assert((await button.getAttribute("data-state")) === null && afterError === normalBg, `a failed save never turns the button green (${afterError})`);
    await page.waitForTimeout(2500);
    assert(await error.isVisible(), "the error is still there 2.5 s later");
    await page.fill("#cfg-modelIdentCode", "C3FAIL2");
    assert(await error.isVisible(), "…and still there after editing a field (until the next attempt)");
    await page.locator("form").first().screenshot({ path: "/tmp/config-save-error.png" });
    await page.unroute(`**/api/projects/${project.id}/config`);
    await page.fill("#cfg-modelIdentCode", "C3OK");
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="config-save"]')?.getAttribute("data-state") === "success", null, { timeout: 5000 });
    assert((await error.count()) === 0, "the next attempt clears the error (and succeeds)");
    // Spanish label while saving.
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(300);
    let releaseEs;
    const esHeld = new Promise((resolve) => (releaseEs = resolve));
    await page.route(`**/api/projects/${project.id}/config`, async (route) => {
      if (route.request().method() === "PUT") await esHeld;
      await route.continue();
    });
    await page.getByTestId("config-save").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="config-save"]')?.getAttribute("data-state") === "busy");
    assert((await button.textContent()) === "Guardando…", `Spanish: "Guardando…" (${await button.textContent()})`);
    releaseEs();
    await page.waitForFunction(() => document.querySelector('[data-testid="config-save"]')?.getAttribute("data-state") === "success", null, { timeout: 5000 });
    assert((await button.textContent()) === "✓Guardar configuración", `Spanish: ✓ on the button (${await button.textContent()})`);
    await page.unroute(`**/api/projects/${project.id}/config`);
    await page.locator("header select, nav select").first().selectOption("en");

    // ---- BRDP Records: catalog endpoint failure ----
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-C3-CAT" }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    assert((await page.getByTestId("catalog-load-warning").count()) === 0, "catalog loads: no warning");

    await page.route("**/api/brdp-catalog?standard=*", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "catalog service down" }) })
    );
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-C3-CAT" }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    const warning = page.getByTestId("catalog-load-warning");
    await warning.waitFor({ timeout: 5000 });
    const warningText = await warning.textContent();
    assert(warningText.includes("The catalog could not be loaded; the identifier check is not available") && warningText.includes("catalog service down"), `catalog warning shown (${warningText})`);
    assert((await warning.evaluate((el) => getComputedStyle(el).color)) === "rgb(185, 28, 28)", "the warning is red");
    const suggestDef = page.getByRole("button", { name: "Suggest Definition" });
    const title = (await suggestDef.getAttribute("title")) || "";
    assert(!title.includes("Official definition from the standard catalog"), "Suggest Definition is not reported as a catalog BRDP (the check is off, not empty)");
    await page.screenshot({ path: "/tmp/catalog-load-warning.png" });
    await page.locator("header select, nav select").first().selectOption("es");
    await page.waitForTimeout(300);
    const es = await warning.textContent();
    assert(es.includes("No se pudo cargar el catálogo; la comprobación de identificadores no está disponible"), `Spanish text (${es})`);
    await page.locator("header select, nav select").first().selectOption("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
