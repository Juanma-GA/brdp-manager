// Live verification: Excel import of official identifiers that the catalog
// of the project's standard does not have but another S1000D edition's does.
//   1. The Lufthansa Excel (502 rows, built from the real Lufthansa BREX by
//      backend/scripts/build_lufthansa_excel.py) in an S1000D 4.2 project:
//      502 ready, 0 rejected, "From another edition's catalog: 116" (ES:
//      "De catálogo de otra edición: 116"), the list on demand with
//      "(retired in 4.2)" / "(obsoleta en 4.2)", the substitution warning
//      naming the edition.
//   2. Apply: a 4.1-only BRDP keeps its identifier, has the 4.1 catalog's
//      Title/Definition and the Excel's Proposal; History reads "S1000D 4.1
//      catalog, not in S1000D 4.2" (ES: "catálogo S1000D 4.1, no existe en
//      S1000D 4.2").
//   3. Export to Excel and import again: 502 unchanged, still 116 from
//      another edition, and no second History entry.
//   4. An S1000D 4.1 project with an identifier only in the 4.2 catalog:
//      "it is in S1000D 4.2" with no "retired".
//
// Preconditions: uvicorn on 8000, Vite on 5173, the S1000D 4.2 catalog of
// sources/ (scripts/seed_extract_catalog_42.py) and the real 4.1 catalog
// (import_brdp_catalog.py catalog_sources/s1000d_4.1.xlsx "S1000D 4.1")
// loaded. No LLM. Cleans up its projects.
//
//     node scripts/verify-import-catalog-edition.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { backendPython, pythonEnv } from "./lib/backendPython.mjs";
import { openHistoryOnEachLoad } from "./lib/openHistory.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const BACKEND = fileURLToPath(new URL("../backend/", import.meta.url));

let failures = 0;
function assert(condition, message, detail = "") {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ""}`);
  }
}


async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-edition-"));
  const lufthansa = path.join(tmp, "lufthansa.xlsx");
  execFileSync(backendPython(), [path.join("scripts", "build_lufthansa_excel.py"), lufthansa], { cwd: BACKEND, stdio: "inherit", env: pythonEnv() });

  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  if (!login.access_token) throw new Error(`login failed for ${ADMIN_EMAIL}`);
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });

  // A 4.1-only identifier and a 4.2-only one, read from the real catalogs.
  const cat42 = await api("/api/brdp-catalog?standard=S1000D%204.2").then((r) => r.json());
  const cat41 = await api("/api/brdp-catalog?standard=S1000D%204.1").then((r) => r.json());
  assert(cat42.length >= 427 && cat41.length >= 552, `catalogs loaded (4.2: ${cat42.length}, 4.1: ${cat41.length})`);
  const ids42 = new Set(cat42.map((c) => c.identifier));
  const ids41 = new Map(cat41.map((c) => [c.identifier, c]));
  const only42 = cat42.find((c) => /^BRDP-S1-\d{5}$/.test(c.identifier) && !ids41.has(c.identifier));

  const suffix = Math.random().toString(36).slice(2, 8);
  const projects = [];
  const newProject = async (standard) => {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `catalog edition ${standard} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p.id);
    return p;
  };

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  await openHistoryOnEachLoad(page);
  const language = (lang) => page.locator("header select, nav select").first().selectOption(lang);
  const openConfig = async (project) => {
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    // A finished import job's panel takes the section's place until closed.
    await page.locator('input[type="file"][accept=".xlsx"]').or(page.locator('text=Import complete')).first().waitFor({ state: "attached", timeout: 10000 });
    const close = page.locator('button:has-text("Close")');
    if (await close.count()) await close.first().click();
    await page.waitForSelector('input[type="file"][accept=".xlsx"]', { state: "attached", timeout: 10000 });
  };
  const analyse = async (file) => {
    await page.locator('input[type="file"][accept=".xlsx"]').setInputFiles(file);
    await page.waitForSelector('[data-testid="import-catalog-edition-count"], button:has-text("Apply import"), button:has-text("Aplicar importación")', { timeout: 60000 });
    await page.waitForTimeout(300);
    return page.locator("body").innerText();
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");

    console.log("\n1. Lufthansa Excel in an S1000D 4.2 project (EN)");
    const project = await newProject("S1000D 4.2");
    await openConfig(project);
    let text = await analyse(lufthansa);
    assert(text.includes("502 rows ready to import"), "502 rows ready", text.match(/\d+ rows? [a-z ()]+/g)?.join(" | "));
    assert(/0 rows rejected/.test(text), "0 rejected");
    assert((await page.getByTestId("import-catalog-edition-count").innerText()) === "From another edition's catalog: 116", "counter: From another edition's catalog: 116");
    assert((await page.getByTestId("import-catalog-edition-list").count()) === 0, "the list starts hidden");
    await page.getByTestId("import-catalog-edition-toggle").click();
    const items = page.getByTestId("import-catalog-edition-list").locator("li");
    assert((await items.count()) === 116, `116 rows listed (got ${await items.count()})`);
    const first = await items.first().innerText();
    const firstId = first.match(/BRDP-S1-\d{5}/)[0];
    assert(
      first.endsWith(`${firstId} is not in the S1000D 4.2 catalog; it is in S1000D 4.1 (retired in 4.2)`),
      "row text EN", first
    );
    assert(!ids42.has(firstId) && ids41.has(firstId), `${firstId} is only in the 4.1 catalog`);
    text = await page.locator("body").innerText();
    assert(text.includes(`(${firstId}): Title and Definition will use the values of the S1000D 4.1 catalog, not the file`), "substitution warning names the edition");
    await page.screenshot({ path: path.join(os.tmpdir(), "import-catalog-edition-en.png"), fullPage: false });

    console.log("\n1b. Same preview in Spanish");
    await language("es");
    await page.waitForTimeout(300);
    assert((await page.getByTestId("import-catalog-edition-count").innerText()) === "De catálogo de otra edición: 116", "contador: De catálogo de otra edición: 116");
    const firstEs = await page.getByTestId("import-catalog-edition-list").locator("li").first().innerText();
    assert(
      firstEs.endsWith(`${firstId} no está en el catálogo S1000D 4.2; está en S1000D 4.1 (obsoleta en 4.2)`),
      "texto de fila ES", firstEs
    );
    await page.getByTestId("import-catalog-edition-list").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), "import-catalog-edition-es.png"), fullPage: false });
    await language("en");

    console.log("\n2. Apply");
    await page.click('button:has-text("Apply import")');
    await page.waitForSelector("text=Import complete", { timeout: 120000 });
    text = await page.locator("body").innerText();
    assert(/502 BRDPs created/.test(text), "502 created", text.match(/\d+ BRDPs? [a-z]+/g)?.join(" | "));
    await page.click('button:has-text("Close")').catch(() => {});
    const brdps = await api(`/api/projects/${project.id}/brdps`).then((r) => r.json());
    const b = brdps.find((x) => x.identifier === firstId);
    const entry = ids41.get(firstId);
    assert(b && b.title === entry.title && b.definition === entry.definition, "Title/Definition from the 4.1 catalog");
    assert(b && b.proposal.length > 0 && b.validation === "Validated", "Proposal and status from the Excel");

    const history = await api(`/api/projects/${project.id}/brdps/${b.id}/history`).then((r) => r.json());
    const editionEvents = history.filter((h) => h.field_name === "catalog_edition");
    assert(editionEvents.length === 1, `one History entry (got ${editionEvents.length})`);

    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.getByPlaceholder(/Search by ID or (title|Title)/).first().fill(firstId);
    await page.locator("tbody tr", { hasText: firstId }).first().click();
    await page.waitForSelector("text=S1000D 4.1 catalog, not in S1000D 4.2", { timeout: 10000 });
    assert(true, "History EN: S1000D 4.1 catalog, not in S1000D 4.2");
    await language("es");
    await page.waitForSelector("text=catálogo S1000D 4.1, no existe en S1000D 4.2", { timeout: 10000 });
    assert(true, "Historial ES: catálogo S1000D 4.1, no existe en S1000D 4.2");
    await page.screenshot({ path: path.join(os.tmpdir(), "import-catalog-edition-history-es.png"), fullPage: false });
    await language("en");

    console.log("\n3. Export to Excel and import again");
    await openConfig(project);
    const exported = path.join(tmp, "export.xlsx");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('button:has-text("Export to Excel")')]);
    await dl.saveAs(exported);
    text = await analyse(exported);
    assert(text.includes("502 rows unchanged"), "502 unchanged", text.match(/\d+ rows? [a-z ()]+/g)?.join(" | "));
    assert((await page.getByTestId("import-catalog-edition-count").innerText()) === "From another edition's catalog: 116", "still 116 from another edition");
    assert(!text.includes("Title and Definition will use the values"), "no substitution warning (texts already the catalog's)");
    await page.click('button:has-text("Apply import")');
    await page.waitForSelector("text=Import complete", { timeout: 120000 });
    const again = await api(`/api/projects/${project.id}/brdps/${b.id}/history`).then((r) => r.json());
    assert(again.filter((h) => h.field_name === "catalog_edition").length === 1, "still one History entry");
    assert(again.length === history.length, `History unchanged (${history.length} → ${again.length})`);

    console.log("\n4. S1000D 4.1 project, identifier only in 4.2");
    const p41 = await newProject("S1000D 4.1");
    const one = path.join(tmp, "one.xlsx");
    const res = await api(`/api/projects/${p41.id}/export.xlsx`, {
      method: "POST",
      body: JSON.stringify({ rows: [{ id: only42.identifier, title: "", definition: "", proposal: "P", proposalStatus: "Pending", ruleStatus: "To Do", rule: "" }] }),
    });
    fs.writeFileSync(one, Buffer.from(await res.arrayBuffer()));
    await openConfig(p41);
    await analyse(one);
    await page.getByTestId("import-catalog-edition-toggle").click();
    const row = await page.getByTestId("import-catalog-edition-list").locator("li").first().innerText();
    assert(row.endsWith(`${only42.identifier} is not in the S1000D 4.1 catalog; it is in S1000D 4.2`), "is in S1000D 4.2, no 'retired'", row);
  } finally {
    await browser.close();
    for (const id of projects) await api(`/api/projects/${id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
