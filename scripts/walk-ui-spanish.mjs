// AACF 3, Part 3.5: walks the main screens with the interface in Spanish
// and lists every visible text (and title / placeholder / aria-label) that
// looks English or like a raw token (snake_case, i18n key). Not a pass/fail
// check: a report to read, kept so the walk can be repeated.
//
//   node scripts/walk-ui-spanish.mjs [--out file.json]
import fs from "node:fs";
import { chromium } from "playwright-core";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex > 0 ? process.argv[outIndex + 1] : null;

// English words that never belong in a Spanish sentence of this app.
const ENGLISH = /\b(the|and|with|from|this|that|which|your|not|no longer|please|loading|save|saved|delete|deleted|cancel|search|show|hide|more|less|add|edit|close|open|back|next|previous|page|of|rule|rules|status|pending|draft|verified|validated|refused|to do|history|settings|project|projects|user|users|role|error|failed|retry|reload|download|upload|import|export|generate|template|catalog|records|trash|select|selected|none|all|yes|no|new|name|email|password|language|logout|login|sign|title|definition|proposal|comment|reason|question|answer|suggest|suggestion|accept|discard|test|tested|outdated|compare|copy|clear|filter|filters|sort|done|running|completed|unknown|warning|warnings|create|created|update|updated)\b/i;
const TOKEN = /\b[a-z]+_[a-z_]+\b|\b[a-z]+\.[a-z]+\.[a-zA-Z.]+\b|\{\{|\}\}/;

async function api(path, options = {}, token) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function collect() {
  const out = [];
  const visible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.replace(/\s+/g, " ").trim();
    const el = n.parentElement;
    if (!text || !visible(el)) continue;
    if (el.closest("pre, code, textarea, input, [data-testid='brdp-xml'], .mono")) continue;
    out.push({ kind: "text", text, tag: el.tagName.toLowerCase() });
  }
  for (const el of document.querySelectorAll("[title], [placeholder], [aria-label]")) {
    if (!visible(el)) continue;
    for (const a of ["title", "placeholder", "aria-label"]) {
      const v = el.getAttribute(a);
      if (v && v.trim()) out.push({ kind: a, text: v.trim(), tag: el.tagName.toLowerCase() });
    }
  }
  return out;
}

const found = new Map();
async function grab(page, screen) {
  await page.waitForTimeout(600);
  for (const item of await page.evaluate(collect)) {
    // Data, not interface text: e-mails and ids of other users and projects.
    if (/@[\w.-]+\.\w+|[0-9a-f]{8}-[0-9a-f]{4}-/.test(item.text)) continue;
    const english = ENGLISH.test(item.text);
    const token = TOKEN.test(item.text);
    if (!english && !token) continue;
    const key = `${item.kind}|${item.text}`;
    if (!found.has(key)) found.set(key, { ...item, screens: new Set(), english, token });
    found.get(key).screens.add(screen);
  }
}

const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
const token = login.access_token;
const me = await api("/api/auth/me", {}, token);
const previousLanguage = me.preferred_language;
await api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: "es", ui_preferences: { sidebar_collapsed: false } }) }, token);

const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Recorrido ES ${Date.now()}`, standard: "S1000D 4.2" }) }, token);
const brdps = [];
for (const [i, validation] of [["1", "Validated"], ["2", "Refused"], ["3", "Pending"]]) {
  brdps.push(
    await api(
      `/api/projects/${project.id}/brdps`,
      { method: "POST", body: JSON.stringify({ identifier: `BRDP-ES-${i}`, title: `Uso de <emphasis> ${i}`, definition: "Decidir si se usa <emphasis>.", proposal: "No se usará <emphasis>.", validation, comments: validation === "Refused" ? "Demasiado vago" : "" }) },
      token
    )
  );
}
const rule = '<structureObjectRule id="r0"><brDecisionRef brDecisionIdentNumber="BRDP-ES-1"/><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No se usa emphasis.</objectUse></structureObjectRule>';
await api(`/api/projects/${project.id}/brdps/${brdps[0].id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: rule, status: "approved", source: "manual" }) }, token);
await api(`/api/projects/${project.id}/brdps/${brdps[1].id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: rule.replace("r0", "r1"), status: "pending_review", source: "manual" }) }, token);
await api(`/api/projects/${project.id}/brdps/${brdps[2].id}`, { method: "PUT", body: JSON.stringify({ title: "Uso de <emphasis> 3 (editado)" }) }, token);

const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-ES" })).newPage();
  await openHistoryOnEachLoad(page);
  await page.goto(BASE_URL);
  await page.waitForSelector("#login-email");
  await grab(page, "login");
  await page.fill("#login-email", ADMIN_EMAIL);
  await page.fill("#login-password", ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector("table");
  await grab(page, "proyectos");

  await page.goto(`${BASE_URL}/projects/${project.id}/records`);
  await page.waitForSelector("tbody tr");
  await grab(page, "registros");
  for (const id of ["BRDP-ES-1", "BRDP-ES-2", "BRDP-ES-3"]) {
    await page.locator("tbody tr", { hasText: id }).first().click();
    await grab(page, `registros/${id}`);
  }
  await page.locator("tbody tr", { hasText: "BRDP-ES-2" }).first().click();
  await page.getByTestId("compare-open").click();
  await grab(page, "comparar");
  for (const tab of await page.getByRole("tab").all()) {
    await tab.click().catch(() => {});
    await grab(page, "comparar");
  }
  await page.keyboard.press("Escape");
  await page.locator("tbody tr", { hasText: "BRDP-ES-2" }).first().click();
  const testRule = page.getByRole("button", { name: /Probar regla/ }).first();
  if (await testRule.count()) {
    await testRule.click();
    await page.waitForTimeout(4000);
    await grab(page, "probar regla");
  }

  await page.goto(`${BASE_URL}/projects/${project.id}/config`);
  await page.waitForTimeout(1500);
  await grab(page, "configuración");
  await page.goto(`${BASE_URL}/projects/${project.id}/generate`);
  await page.waitForTimeout(1500);
  await grab(page, "generar");
  await page.getByRole("button", { name: /^Generar/ }).first().click().catch(() => {});
  await page.waitForTimeout(2500);
  await grab(page, "generar (resultado)");
  await page.goto(`${BASE_URL}/settings`);
  await page.waitForTimeout(1500);
  for (const summary of await page.locator("summary").all()) await summary.click().catch(() => {});
  await page.waitForTimeout(1000);
  await grab(page, "ajustes");
} finally {
  await browser.close();
  await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" }, token).catch(() => {});
  await api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: previousLanguage ?? null }) }, token).catch(() => {});
}

const rows = [...found.values()].map((f) => ({ ...f, screens: [...f.screens] }));
for (const r of rows) console.log(`[${r.screens.join(", ")}] ${r.kind}${r.token ? " (token)" : ""}: ${r.text.slice(0, 160)}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log(`\n${rows.length} texts to review`);
