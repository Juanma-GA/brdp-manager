// Verification for "Consolidación C1", Part 3: the draggable divider between
// the BRDP Records table and the detail panel. Real Vite + backend; one
// seeded project, deleted at the end.
//
//   node scripts/verify-records-split-divider.mjs
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const STORAGE_KEY = "brdp-records-detail-width";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

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
  const project = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Split divider ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());
  await fetch(`${API}/api/projects/${project.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ identifier: "BRDP-SPLIT-1", title: "Use of emphasis", definition: "Decide on emphasis.", proposal: "", validation: "Pending" }),
  });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);

    const open = async () => {
      await page.goto(`${BASE_URL}/projects/${project.id}/records`);
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tbody tr", { hasText: "BRDP-SPLIT-1" }).first().click();
      await page.waitForTimeout(300);
    };
    await open();

    const divider = page.getByTestId("records-split-divider");
    const tableWrap = page.locator('[class*="tableWrap"]').first();
    const detail = page.locator('[class*="detailPanel"]').first();
    const widths = async () => ({ table: (await tableWrap.boundingBox()).width, detail: (await detail.boundingBox()).width });
    const stored = () => page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
    const markColor = () => divider.evaluate((el) => getComputedStyle(el, "::before").backgroundColor);

    // Default split, accessible divider.
    assert(near((await widths()).detail, 460), "default detail width 460px");
    assert((await divider.getAttribute("role")) === "separator" && (await divider.getAttribute("aria-orientation")) === "vertical", "divider: role=separator, vertical");
    assert((await divider.getAttribute("tabindex")) === "0", "divider is focusable");
    assert((await divider.getAttribute("aria-label")) === "Resize the detail panel", "divider has an accessible name");
    assert((await divider.evaluate((el) => getComputedStyle(el).cursor)) === "col-resize", "resize cursor");
    assert((await markColor()) === "rgba(0, 0, 0, 0)", "no mark before hover");
    await divider.hover();
    await page.waitForTimeout(200);
    assert((await markColor()) === "rgb(203, 213, 225)", "visible mark on hover");
    await page.screenshot({ path: "/tmp/records-split-divider.png", clip: await page.locator('[class*="layout"]').first().boundingBox() });
    console.log("Screenshot: /tmp/records-split-divider.png");

    const drag = async (toX) => {
      const box = await divider.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(toX, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
    };

    // Drag left: the detail widens by the distance moved.
    let box = await divider.boundingBox();
    await drag(box.x + box.width / 2 - 200);
    let w = await widths();
    assert(near(w.detail, 660, 2), `drag 200px left: detail 660px (${w.detail})`);
    assert(near(Number(await stored()), 660, 2), "the new width is stored");

    // Drag to the far left: stops where the table reaches its 480px minimum.
    await drag(10);
    w = await widths();
    assert(near(w.table, 480, 1.5), `drag to the far left: table stops at 480px (${w.table})`);
    await page.screenshot({ path: "/tmp/records-split-divider-table-min.png", fullPage: false });

    // Drag to the far right: detail stops at its 360px minimum.
    await drag(1430);
    w = await widths();
    assert(near(w.detail, 360, 1.5), `drag to the far right: detail stops at 360px (${w.detail})`);

    // Keyboard: focus + arrows.
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    w = await widths();
    assert(near(w.detail, 392, 1.5), `two ArrowLeft presses: detail 360 + 2×16 = 392px (${w.detail})`);
    await page.keyboard.press("ArrowRight");
    w = await widths();
    assert(near(w.detail, 376, 1.5), `ArrowRight: 376px (${w.detail})`);
    assert((await markColor()) === "rgb(37, 99, 235)", "focused divider shows the blue mark");
    assert(near(Number(await stored()), 376, 1), "keyboard width is stored");

    // Reload keeps the chosen width.
    await open();
    w = await widths();
    assert(near(w.detail, 376, 1.5), `after reload the detail keeps 376px (${w.detail})`);

    // Double-click resets to the default split and forgets the stored width.
    await divider.dblclick();
    await page.waitForTimeout(200);
    w = await widths();
    assert(near(w.detail, 460, 1.5), `double-click: back to 460px (${w.detail})`);
    assert((await stored()) === null, "double-click forgets the stored width");

    // A stored width that no longer fits (narrower window) is clamped, never
    // squeezes the table under its minimum.
    await page.evaluate((k) => localStorage.setItem(k, "5000"), STORAGE_KEY);
    await open();
    w = await widths();
    assert(near(w.table, 480, 1.5), `stored 5000px: clamped so the table keeps 480px (${w.table})`);
    // Garbage in storage: default split.
    await page.evaluate((k) => localStorage.setItem(k, "not-a-number"), STORAGE_KEY);
    await open();
    assert(near((await widths()).detail, 460, 1.5), "unreadable stored value: default 460px");
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(scroll, "no horizontal page scroll");

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY).catch(() => {});
    await fetch(`${API}/api/projects/${project.id}?permanent=true`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded project.");
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
