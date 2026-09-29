// Live verification for Consolidation C3, Part 2 (pending items):
//  - Project Configuration: after saving, "Saved" appears next to the button
//    and stays a few seconds (it never showed before: refreshProject() put
//    ProjectLayout back into its loading state and unmounted the page);
//    a failed save shows its error there too (HR7).
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
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
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

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");

    // ---- Project Configuration: "Saved" ----
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.waitForSelector("#cfg-modelIdentCode", { timeout: 10000 });
    await page.fill("#cfg-modelIdentCode", "C3TEST");
    const t0 = Date.now();
    await page.getByRole("button", { name: "Save Configuration" }).click();
    const saved = page.getByTestId("config-saved");
    await saved.waitFor({ timeout: 5000 });
    assert((await saved.textContent()) === "Saved", '"Saved" appears next to the button');
    assert((await page.inputValue("#cfg-modelIdentCode")) === "C3TEST", "the page was not reloaded away: the field keeps the saved value");
    await page.waitForTimeout(1500);
    assert(await saved.isVisible(), '"Saved" is still there 1.5 s later');
    await page.screenshot({ path: "/tmp/config-saved.png", clip: { x: 0, y: 0, width: 1440, height: 520 } });
    await saved.waitFor({ state: "detached", timeout: 8000 });
    const gone = (Date.now() - t0) / 1000;
    assert(gone >= 3 && gone <= 7, `"Saved" goes away after a few seconds (${gone.toFixed(1)} s)`);
    const stored = await api(`/api/projects/${project.id}/config`).then((r) => r.json());
    assert(stored.project_config?.modelIdentCode === "C3TEST", "the value was really saved");

    // A failed save: the error is shown, never "Saved".
    await page.route(`**/api/projects/${project.id}/config`, (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "database unavailable" }) }) : route.continue()
    );
    await page.fill("#cfg-modelIdentCode", "C3FAIL");
    await page.getByRole("button", { name: "Save Configuration" }).click();
    const error = page.getByTestId("config-save-error");
    await error.waitFor({ timeout: 5000 });
    const errorText = await error.textContent();
    assert(errorText.startsWith("Could not save:") && errorText.includes("database unavailable"), `save error shown (${errorText})`);
    assert((await page.getByTestId("config-saved").count()) === 0, 'no "Saved" after a failed save');
    await page.screenshot({ path: "/tmp/config-save-error.png", clip: { x: 0, y: 0, width: 1440, height: 520 } });
    await page.unroute(`**/api/projects/${project.id}/config`);

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
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
