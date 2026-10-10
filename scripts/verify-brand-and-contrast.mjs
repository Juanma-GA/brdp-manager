// AACF 3, Part 2: the ATEXIS brand on the app's own CSS variables.
//   b. loading and using the app sends no request to an external domain
//      (fonts included);
//   c. the primary button, the active sidebar item and a link use the new
//      primary; the body font is Inter and an identifier's JetBrains Mono,
//      and both fonts actually loaded (document.fonts);
//   AA audit: every visible text on the main screens (login, projects,
//   Records with a BRDP open and its History, Comparar, Configuration,
//   Generate, Settings) has 4.5:1 against its real background (3:1 for
//   large text); disabled controls are exempt, as WCAG allows.
// Real Vite + backend; one seeded project, deleted at the end.
//
//   node scripts/verify-brand-and-contrast.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const PRIMARY = "rgb(46, 116, 181)";
const PRIMARY_DARK = "rgb(36, 92, 144)";
const SHOTS = path.join(os.tmpdir(), "aacf3");
fs.mkdirSync(SHOTS, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

// Runs in the page: every element with its own visible text, its colour
// composited over its real background (opacity and translucent
// backgrounds included) and the WCAG contrast ratio.
function auditContrast() {
  const parse = (value) => {
    let m = value.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = value.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  };
  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const background = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const opacity = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const disabled = (el) => !!el.closest(':disabled, [aria-disabled="true"], option');
  const failures = [];
  let checked = 0;
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
    if (!own || disabled(el)) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== "visible" || style.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    // Purely decorative glyphs (separators, arrows, ✓/✕ marks) have no text
    // to read.
    if (/^[\s·•›→←▾▸▲▼✓✕×|,:;–—/]+$/.test(own)) continue;
    // Colour emoji (the sidebar icons) do not take the text colour.
    if (/^[\s\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(own)) continue;
    const fg0 = parse(style.color);
    if (!fg0) continue;
    const bg = background(el);
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacity(el)], bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    checked++;
    if (ratio < (large ? 3 : 4.5) - 0.01) {
      failures.push({
        ratio: Math.round(ratio * 100) / 100,
        fg: style.color,
        bg: `rgb(${bg.slice(0, 3).map(Math.round).join(", ")})`,
        cls: (el.className && typeof el.className === "string" ? el.className : el.tagName).slice(0, 60),
        text: own.slice(0, 40),
      });
    }
  }
  return { checked, failures };
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
  const setPrefs = (prefs) => fetch(`${API}/api/auth/me`, { method: "PATCH", headers: auth, body: JSON.stringify({ ui_preferences: prefs }) });
  // Sidebar expanded, so its labels are visible and audited.
  await setPrefs({ sidebar_collapsed: false });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Brand ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());
  const brdps = [];
  for (const [i, validation] of ["Validated", "Pending", "Refused"].entries()) {
    brdps.push(
      await fetch(`${API}/api/projects/${project.id}/brdps`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ identifier: `BRDP-BRAND-${i}`, title: `Use of <emphasis> ${i}`, definition: "Decide whether <emphasis> is used.", proposal: "<emphasis> shall not be used.", validation }),
      }).then((r) => r.json())
    );
  }
  const rule = `<structureObjectRule id="r0"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>`;
  await fetch(`${API}/api/projects/${project.id}/brdps/${brdps[0].id}/approvals/BREX-4.2`, { method: "PUT", headers: auth, body: JSON.stringify({ rule_xml: rule, status: "approved", source: "manual" }) });
  await fetch(`${API}/api/projects/${project.id}/brdps/${brdps[1].id}/approvals/BREX-4.2`, { method: "PUT", headers: auth, body: JSON.stringify({ rule_xml: rule.replace("r0", "r1"), status: "pending_review", source: "manual" }) });
  await fetch(`${API}/api/projects/${project.id}/brdps/${brdps[1].id}`, { method: "PUT", headers: auth, body: JSON.stringify({ title: "Use of <emphasis> 1 (edited)" }) });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await openHistoryOnEachLoad(page);
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const external = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const host = new URL(url).hostname;
    if (!["localhost", "127.0.0.1"].includes(host)) external.push(url);
  });
  const allFailures = [];
  const audit = async (screen) => {
    await page.waitForTimeout(400);
    const { checked, failures } = await page.evaluate(auditContrast);
    for (const f of failures) allFailures.push({ screen, ...f });
    console.log(`  ${screen}: ${checked} texts checked, ${failures.length} below AA`);
    await page.screenshot({ path: path.join(SHOTS, `brand-${screen}.png`) });
  };
  const color = (loc, prop = "color") => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);

  try {
    await page.goto(BASE_URL);
    await page.waitForSelector("#login-email");
    await audit("login");
    assert((await color(page.locator('button[type="submit"]'), "backgroundColor")) === PRIMARY, "login button: the new primary");
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 15000 });
    await audit("projects");

    // c. Fonts and primary colour.
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        body: getComputedStyle(document.body).fontFamily,
        inter: document.fonts.check('16px "Inter"'),
        mono: document.fonts.check('12px "JetBrains Mono"'),
        loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`),
      };
    });
    assert(fonts.body.startsWith("Inter"), `body font is Inter (${fonts.body.slice(0, 40)})`);
    assert(fonts.loaded.some((f) => f.startsWith("Inter")), `Inter loaded from the app (${fonts.loaded.filter((f) => f.startsWith("Inter")).join(", ")})`);
    assert(
      (await color(page.locator(`button[class*="button"]`).filter({ hasText: /Create|Crear|New|Nuevo/ }).first(), "backgroundColor")) === PRIMARY,
      "primary button: the new primary"
    );
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr");
    const activeItem = page.locator('aside a[class*="active"]').first();
    // The label uses the dark primary: the primary itself is 4.3:1 on the
    // item's pale primary background, below AA for 12.5px text.
    assert((await color(activeItem.locator('[class*="navLabel"]'))) === PRIMARY_DARK, "active sidebar item: label in the dark primary");
    assert((await color(activeItem.locator('[class*="navIcon"]'))) === PRIMARY, "active sidebar item: icon in the new primary");
    const tint = await color(activeItem, "backgroundColor");
    assert(/^color\(srgb 0\.9[01]/.test(tint) || tint === "rgb(234, 241, 248)", `active sidebar item: the primary tint behind it (${tint})`);
    await page.locator("tbody tr", { hasText: "BRDP-BRAND-1" }).first().click();
    await page.getByTestId("history-toggle").waitFor();
    const idFont = await page.locator("tbody td").first().evaluate((el) => getComputedStyle(el.querySelector("*") || el).fontFamily);
    assert(idFont.startsWith('"JetBrains Mono"') || idFont.startsWith("JetBrains Mono"), `identifier font is JetBrains Mono (${idFont.slice(0, 40)})`);
    assert(await page.evaluate(() => document.fonts.check('12px "JetBrains Mono"')), "JetBrains Mono loaded from the app");
    const link = page.getByRole("button", { name: /Limit to specific schemas|Ask comparing/ }).first();
    assert((await color(link)) === PRIMARY, "a link: the new primary");
    await audit("records-detail");
    await page.getByTestId("compare-open").click();
    await page.waitForTimeout(800);
    await audit("compare");
    await page.keyboard.press("Escape");

    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.waitForTimeout(1200);
    await audit("configuration");
    await page.goto(`${BASE_URL}/projects/${project.id}/generate`);
    await page.waitForTimeout(1200);
    await audit("generate");
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(800);
    for (const summary of await page.locator("summary").all()) await summary.click().catch(() => {});
    await audit("settings");

    // Header square and favicon use the new primary.
    const square = await page.locator("header h1").first().evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
    assert(square === PRIMARY, `header square: the new primary (${square})`);
    const favicon = await (await fetch(`${BASE_URL}/favicon.svg`)).text();
    assert(/fill="#2E74B5"/i.test(favicon), "favicon: the new primary");

    assert(external.length === 0, `no request to an external domain (${external.slice(0, 3).join(", ") || "none"})`);
    if (allFailures.length) console.table(allFailures);
    assert(allFailures.length === 0, `every text meets AA (${allFailures.length} below)`);
    console.log(`\nScreenshots in ${SHOTS}\nALL CHECKS PASSED\n`);
  } finally {
    await setPrefs({ sidebar_collapsed: null }).catch(() => {});
    await fetch(`${API}/api/projects/${project.id}?permanent=true`, { method: "DELETE", headers: auth }).catch(() => {});
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
