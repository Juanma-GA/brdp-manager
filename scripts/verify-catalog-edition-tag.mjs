// Live verification of the "4.1" label next to a BRDP identifier whose
// identifier is only in another S1000D edition's catalog (computed by the
// backend for every BRDP response, never stored):
//   1. Records table (S1000D 4.2 project): "4.1" on a 4.1-only id and on an
//      AI Extract "marked" id (BRDP-S1-xxxxx-4.1); none on an id of the 4.2
//      catalog, an EXT, or an S2 id. Tooltip in EN and ES, "(retired)" /
//      "(obsoleta)".
//   2. The BRDP panel: the same label next to the identifier.
//   3. Compare: the title, the candidate in another project, and both
//      column headers carry it.
//   4. An S1000D 4.1 project with an id only in 4.2: "4.2", no "(retired)".
//
// Preconditions: uvicorn on 8000, Vite on 5173, the 4.2 catalog of sources/
// and the real 4.1 catalog loaded. No LLM. Cleans up its projects.
//
//     node scripts/verify-catalog-edition-tag.mjs
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";

let failures = 0;
function assert(condition, message, detail = "") {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  if (!login.access_token) throw new Error(`login failed for ${ADMIN_EMAIL}`);
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });

  const cat42 = await api("/api/brdp-catalog?standard=S1000D%204.2").then((r) => r.json());
  const cat41 = await api("/api/brdp-catalog?standard=S1000D%204.1").then((r) => r.json());
  const ids42 = new Set(cat42.map((c) => c.identifier));
  const ids41 = new Set(cat41.map((c) => c.identifier));
  const official = (i) => /^BRDP-S1-\d{5}$/.test(i);
  const only41 = cat41.map((c) => c.identifier).filter((i) => official(i) && !ids42.has(i));
  const both = cat42.map((c) => c.identifier).find((i) => official(i) && ids41.has(i));
  const only42 = cat42.map((c) => c.identifier).find((i) => official(i) && !ids41.has(i));
  const [old, oldMarkedBase] = only41;
  const marked = `${oldMarkedBase}-4.1`;
  console.log(`ids: 4.1-only ${old}, marked ${marked}, both ${both}, 4.2-only ${only42}`);

  const suffix = Math.random().toString(36).slice(2, 8);
  const projects = [];
  const newProject = async (name, standard, identifiers) => {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p.id);
    for (const identifier of identifiers) {
      await api(`/api/projects/${p.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier, title: `Title ${identifier}` }) });
    }
    return p;
  };
  const main42 = await newProject("tag 4.2", "S1000D 4.2", [old, marked, both, "BRDP-EXT-00001", "BRDP-S2-00002"]);
  const other42 = await newProject("tag other 4.2", "S1000D 4.2", [old]);
  const p41 = await newProject("tag 4.1", "S1000D 4.1", [only42]);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const language = (lang) => page.locator("header select, nav select").first().selectOption(lang);
  const rowOf = (identifier) => page.locator("tbody tr").filter({ has: page.locator("td").first().filter({ hasText: identifier }) }).first();
  const tagIn = (locator) => locator.locator('[data-testid="catalog-edition-tag"]');
  const openRecords = async (project) => {
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");

    console.log("\n1. Records table (S1000D 4.2)");
    await openRecords(main42);
    for (const [identifier, expected] of [[old, "4.1"], [marked, "4.1"], [both, null], ["BRDP-EXT-00001", null], ["BRDP-S2-00002", null]]) {
      const tag = tagIn(rowOf(identifier));
      const count = await tag.count();
      if (expected) assert(count === 1 && (await tag.innerText()) === expected, `${identifier}: label "${expected}"`);
      else assert(count === 0, `${identifier}: no label`);
    }
    const oldTag = tagIn(rowOf(old));
    assert((await oldTag.getAttribute("title")) === "From the S1000D 4.1 catalog. Not in S1000D 4.2 (retired).", "tooltip EN", await oldTag.getAttribute("title"));
    assert((await rowOf(old).locator("td").first().innerText()).startsWith(old), "the label is not part of the identifier text");
    await page.screenshot({ path: path.join(os.tmpdir(), "catalog-edition-tag-records-en.png") });

    console.log("\n2. BRDP panel");
    await rowOf(old).click();
    const panelTag = page.locator('[data-testid="compare-open"]').locator("xpath=..").locator('[data-testid="catalog-edition-tag"]');
    assert((await panelTag.count()) === 1 && (await panelTag.innerText()) === "4.1", "label next to the identifier in the panel");

    console.log("\n3. Compare");
    await page.getByTestId("compare-open").click();
    await page.waitForSelector('[data-testid="compare-dialog"], [data-testid="brdp-compare-dialog"]', { timeout: 10000 });
    const dialog = page.getByTestId("brdp-compare-dialog");
    assert((await tagIn(dialog.locator("#brdp-compare-title")).count()) === 1, "label in the dialog title");
    await page.waitForSelector('[data-testid="compare-candidate"]', { timeout: 10000 });
    const candidate = page.getByTestId("compare-candidate").first();
    assert((await candidate.innerText()).includes(other42.name), "the same BRDP in the other project is listed (official identifier)");
    assert((await tagIn(candidate).innerText()) === "4.1", "label on the candidate");
    await page.waitForSelector('[data-testid="compare-view"]', { timeout: 10000 });
    assert((await tagIn(page.getByTestId("compare-left-header")).innerText()) === "4.1", "label in the left header");
    assert((await tagIn(page.getByTestId("compare-right-header")).innerText()) === "4.1", "label in the right header");
    await page.screenshot({ path: path.join(os.tmpdir(), "catalog-edition-tag-compare-en.png") });
    await page.getByTestId("compare-close").click();

    console.log("\n4. Spanish");
    await language("es");
    await page.waitForTimeout(300);
    const esTitle = await tagIn(rowOf(old)).getAttribute("title");
    assert(esTitle === "Del catálogo S1000D 4.1. No existe en S1000D 4.2 (obsoleta).", "tooltip ES", esTitle);
    assert((await panelTag.getAttribute("title")) === esTitle, "panel tooltip ES");
    await page.getByTestId("compare-open").click();
    await page.waitForSelector('[data-testid="compare-view"]', { timeout: 10000 });
    assert((await tagIn(page.getByTestId("compare-right-header")).getAttribute("title")) === esTitle, "Compare tooltip ES");
    await page.screenshot({ path: path.join(os.tmpdir(), "catalog-edition-tag-compare-es.png") });
    await page.getByTestId("compare-close").click();
    await language("en");

    console.log("\n5. S1000D 4.1 project, id only in 4.2");
    await openRecords(p41);
    const newer = tagIn(rowOf(only42));
    assert((await newer.innerText()) === "4.2", 'label "4.2"');
    assert((await newer.getAttribute("title")) === "From the S1000D 4.2 catalog. Not in S1000D 4.1.", "no '(retired)'", await newer.getAttribute("title"));
  } finally {
    await browser.close();
    for (const id of projects) await api(`/api/projects/${id}`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
