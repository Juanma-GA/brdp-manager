import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE_URL);
  await page.fill("#login-email", "admin@example.com");
  await page.fill("#login-password", "AdminTest123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector("table", { timeout: 10000 });
  await page.goto(`${BASE_URL}/settings`);
  await page.waitForSelector("text=/Settings/i", { timeout: 10000 });
  const hasImportSettings = await page.locator("text=/Import Settings/i").count();
  console.log("Import Settings section present:", hasImportSettings > 0 ? "YES (bug!)" : "NO (correctly removed)");
  await page.screenshot({ path: "/tmp/settings-page-no-import-eta.png", fullPage: true });
  await browser.close();
}
main();
