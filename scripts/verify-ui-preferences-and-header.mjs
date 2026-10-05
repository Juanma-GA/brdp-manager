// AACF 3, Parts 0 and 1: the Records header counts are right-aligned, and
// the interface preferences (sidebar collapsed, Records panel width) live on
// the server and follow the person to a new browser. Real Vite + backend;
// one seeded project, deleted at the end.
//
//   node scripts/verify-ui-preferences-and-header.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const SHOTS = path.join(os.tmpdir(), "aacf3");
fs.mkdirSync(SHOTS, { recursive: true });

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
  const me = () => fetch(`${API}/api/auth/me`, { headers: auth }).then((r) => r.json());
  const setPrefs = (prefs) => fetch(`${API}/api/auth/me`, { method: "PATCH", headers: auth, body: JSON.stringify({ ui_preferences: prefs }) });
  const originalLanguage = (await me()).preferred_language;
  await setPrefs({ sidebar_collapsed: null, records_detail_width: null });

  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `UI prefs ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());
  for (const [i, validation] of ["Validated", "Pending", "Refused"].entries()) {
    await fetch(`${API}/api/projects/${project.id}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ identifier: `BRDP-UIP-${i}`, title: `Title ${i}`, definition: "Decide.", proposal: "A proposal.", validation }),
    });
  }
  const rule = (id) =>
    `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>`;
  const list = await fetch(`${API}/api/projects/${project.id}/brdps`, { headers: auth }).then((r) => r.json());
  await fetch(`${API}/api/projects/${project.id}/brdps/${list[0].id}/approvals/BREX-4.2`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ rule_xml: rule("r0"), status: "approved", source: "manual" }),
  });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const newContext = async (viewport = { width: 1440, height: 900 }) => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 15000 });
    return { context, page };
  };
  const openRecords = async (page) => {
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-UIP-0" }).first().click();
    await page.getByTestId("verified-breakdown").waitFor();
    await page.waitForTimeout(300);
  };
  const sidebarCollapsed = (page) => page.locator("aside").first().evaluate((el) => /collapsed/.test(el.className));

  try {
    // ── a. Preferences follow the person to a new browser ──────────────
    let { context, page } = await newContext();
    assert(await sidebarCollapsed(page), "no stored preference: today's default, sidebar collapsed");
    await page.getByRole("button", { name: /Expand sidebar|Expandir/ }).click();
    await page.waitForTimeout(400);
    assert(!(await sidebarCollapsed(page)), "sidebar expanded at once (optimistic)");
    assert((await me()).ui_preferences.sidebar_collapsed === false, "sidebar_collapsed=false saved on the server");
    await openRecords(page);
    const divider = page.getByTestId("records-split-divider");
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + 200, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const savedWidth = (await me()).ui_preferences.records_detail_width;
    assert(savedWidth >= 605 && savedWidth <= 615, `panel width saved on the server (${savedWidth})`);
    assert((await me()).ui_preferences.sidebar_collapsed === false, "saving the width kept the sidebar key");
    // History is collapsed on every page load and not stored.
    await page.getByTestId("history-toggle").click();
    const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length, Object.keys(localStorage), Object.keys(sessionStorage)]);
    assert(storage[0] === 0 && storage[1] === 0, `localStorage and sessionStorage empty after using the app (${JSON.stringify(storage)})`);
    // Log out.
    await page.getByRole("button", { name: /^(Logout|Cerrar sesión)$/ }).click();
    await page.waitForSelector("#login-email");
    await context.close();

    ({ context, page } = await newContext());
    assert(!(await sidebarCollapsed(page)), "new browser context: the sidebar is still expanded");
    await openRecords(page);
    const detailWidth = (await page.locator('[class*="detailPanel"]').first().boundingBox()).width;
    assert(Math.abs(detailWidth - savedWidth) <= 1.5, `new browser context: the panel keeps ${savedWidth}px (${detailWidth})`);
    assert((await page.getByTestId("history-toggle").getAttribute("aria-expanded")) === "false", "History starts collapsed on a new page load");
    await page.getByTestId("history-toggle").click();
    await page.locator("tbody tr", { hasText: "BRDP-UIP-1" }).first().click();
    await page.waitForTimeout(300);
    assert((await page.getByTestId("history-toggle").getAttribute("aria-expanded")) === "true", "History keeps its state when another BRDP is selected");
    await page.reload();
    await page.waitForSelector("tbody tr");
    await page.locator("tbody tr", { hasText: "BRDP-UIP-1" }).first().click();
    await page.waitForTimeout(300);
    assert((await page.getByTestId("history-toggle").getAttribute("aria-expanded")) === "false", "History is collapsed again after a reload");

    // Saving fails: the value holds for the session, a notice once.
    await page.route("**/api/auth/me", (route) => (route.request().method() === "PATCH" ? route.abort() : route.continue()));
    const toggleSidebar = page.locator("aside button").first();
    await toggleSidebar.click();
    await page.waitForTimeout(400);
    assert(await sidebarCollapsed(page), "no network: the sidebar still collapses");
    await page.getByTestId("ui-preference-save-failed").waitFor();
    assert((await page.getByTestId("ui-preference-save-failed").count()) === 1, "a discreet notice is shown");
    await page.getByTestId("ui-preference-save-failed").locator("button").click();
    await toggleSidebar.click();
    await page.waitForTimeout(400);
    assert(!(await sidebarCollapsed(page)), "the next change still applies");
    assert((await page.getByTestId("ui-preference-save-failed").count()) === 0, "the notice is shown only once");
    assert((await page.locator("tbody tr").count()) > 0, "nothing is blocked");
    await page.unroute("**/api/auth/me");
    await context.close();

    // ── d. Records header counts right-aligned ─────────────────────────
    const lineRights = (page) =>
      page.evaluate(() => {
        const actions = document.querySelector('[class*="headerActions"]');
        const breakdown = document.querySelector('[data-testid="verified-breakdown"]');
        const group = (elements) => {
          const lines = new Map();
          for (const el of elements) {
            for (const r of el.getClientRects()) {
              if (!r.width) continue;
              const top = Math.round(r.top);
              const key = [...lines.keys()].find((k) => Math.abs(k - top) < 6) ?? top;
              lines.set(key, Math.max(lines.get(key) ?? -Infinity, r.right));
            }
          }
          return [...lines.values()];
        };
        const counts = group([...actions.children].filter((el) => el !== breakdown));
        const textNodes = [];
        const walker = document.createTreeWalker(breakdown, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) if (walker.currentNode.textContent.trim()) {
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          textNodes.push(range);
        }
        const detail = document.querySelector('[class*="detailPanel"]').getBoundingClientRect().right;
        const header = actions.parentElement.getBoundingClientRect().right;
        return { counts, breakdown: group(textNodes), detail, header };
      });
    for (const [lang, viewport, panel] of [
      ["en", { width: 1440, height: 900 }, 460],
      ["es", { width: 1440, height: 900 }, 700],
      ["en", { width: 1100, height: 900 }, 360],
      ["es", { width: 1100, height: 900 }, 460],
      // Narrow enough for the counts to wrap (the table then scrolls
      // sideways): every wrapped line ends at the header's right edge.
      ["es", { width: 640, height: 900 }, 360],
    ]) {
      await fetch(`${API}/api/auth/me`, { method: "PATCH", headers: auth, body: JSON.stringify({ preferred_language: lang }) });
      await setPrefs({ records_detail_width: panel });
      ({ context, page } = await newContext(viewport));
      await openRecords(page);
      const r = await lineRights(page);
      const all = [...r.counts, ...r.breakdown];
      const wrapped = all.length > 2;
      const edge = wrapped ? r.header : r.detail;
      const ok = all.every((right) => Math.abs(right - edge) <= 1.5);
      assert(
        ok,
        `${lang} ${viewport.width}px panel ${panel}: all ${all.length} count lines end at the ${wrapped ? "header's" : "detail panel's"} right edge ${edge.toFixed(1)} (${all.map((x) => x.toFixed(1)).join(", ")})`
      );
      if (viewport.width === 640) assert(wrapped, "at 640px the counts wrap onto more lines");
      await page.screenshot({ path: path.join(SHOTS, `records-header-${lang}-${viewport.width}-${panel}.png`), clip: { x: 0, y: 0, width: viewport.width, height: 220 } });
      await context.close();
    }

    console.log(`\nScreenshots in ${SHOTS}\nALL CHECKS PASSED\n`);
  } finally {
    await setPrefs({ sidebar_collapsed: null, records_detail_width: null }).catch(() => {});
    await fetch(`${API}/api/auth/me`, { method: "PATCH", headers: auth, body: JSON.stringify({ preferred_language: originalLanguage }) }).catch(() => {});
    await fetch(`${API}/api/projects/${project.id}?permanent=true`, { method: "DELETE", headers: auth }).catch(() => {});
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
