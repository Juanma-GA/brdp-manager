// AI Extract review table, first columns: the classification drop-down and
// the identifier never overlap, in a real browser, with the "CA" BREX (533
// candidates: "Other specification (S2000M)", "Default rule of S1000D",
// "BREX-S1-00074 " with a trailing space…), at 1,280 px and 1,920 px, in EN
// and ES. For every row of every page:
//   - the drop-down is as wide as its longest option (nothing cut) and stays
//     inside its cell; every drop-down has the same width, also on a row with
//     a single option, and the longest label of any classification fits;
//   - the identifier (and its "source: …" line) is whole, on one line, inside
//     its cell, and its box never crosses the drop-down's box;
//   - no cell of those columns has content wider than its box (scrollWidth vs
//     clientWidth); the page itself never scrolls sideways (the table does,
//     inside its own box, when it does not fit).
// Needs the backend, Vite and the Mistral chat simulator running (the AI
// writes the texts of the new rows first), as in verify-rule-extract.mjs,
// and the 4.2 and 4.1 catalogs loaded so the "From catalog (S1000D 4.1)"
// labels appear (seed_extract_catalog_42.py; the real 4.1 catalog with
// import_brdp_catalog.py catalog_sources/s1000d_4.1.xlsx "S1000D 4.1").
//
//     node scripts/verify-rule-extract-columns.mjs [--shots-only]
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const CA = fileURLToPath(new URL("../backend/tests/fixtures/brex/DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml", import.meta.url));
const SHOTS = os.tmpdir();
const SHOT_PREFIX = process.env.SHOT_PREFIX || "rule-extract-columns";
const SHOTS_ONLY = process.argv.includes("--shots-only");

let failures = 0;
function assert(condition, message, detail = "") {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ""}`);
  }
}

let token = null;
async function api(p, options = {}) {
  const res = await fetch(`${API}${p}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${options.method || "GET"} ${p} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Every label a classification drop-down can show, in the current language.
const ALL_LABELS = {
  en: [
    "New EXT", "From catalog", "From catalog (S1000D 4.1)", "From catalog (S1000D 4.1), marked", "Other specification (S2000M)",
    "Already exists (changes)", "Already exists (same)", "Default rule of S1000D", "No content",
  ],
  es: [
    "Nueva EXT", "De catálogo", "De catálogo (S1000D 4.1)", "De catálogo (S1000D 4.1), marcada", "Otra especificación (S2000M)",
    "Ya existe (cambia)", "Ya existe (igual)", "Regla por defecto de S1000D", "Sin contenido",
  ],
};

// Layout of the first columns of the rows on the current page.
async function measurePage(page, lang) {
  return page.evaluate((labels) => {
    const tol = 1;
    const problems = [];
    const rows = [...document.querySelectorAll('[data-testid="rule-extract-row"]')];
    const widths = new Set();
    const within = (inner, outer) =>
      inner.left >= outer.left - tol && inner.right <= outer.right + tol && inner.top >= outer.top - tol && inner.bottom <= outer.bottom + tol;
    const cross = (a, b) => a.left < b.right - tol && b.left < a.right - tol && a.top < b.bottom - tol && b.top < a.bottom - tol;
    const naturalWidth = (select, optionTexts) => {
      const clone = select.cloneNode(false);
      for (const text of optionTexts) {
        const o = document.createElement("option");
        o.textContent = text;
        clone.appendChild(o);
      }
      clone.style.width = "auto";
      clone.style.minWidth = "0";
      clone.style.maxWidth = "none";
      clone.style.position = "absolute";
      clone.style.visibility = "hidden";
      select.parentElement.appendChild(clone);
      const w = clone.getBoundingClientRect().width;
      clone.remove();
      return w;
    };
    let allLabelsFit = true;
    for (const row of rows) {
      const origin = row.dataset.origin;
      const select = row.querySelector('[data-testid="rule-extract-class"]');
      const id = row.querySelector('[data-testid="rule-extract-identifier"]');
      const originLine = row.querySelector('[data-testid="rule-extract-origin"]');
      const selectCell = select.closest("td");
      const idCell = id.closest("td");
      const s = select.getBoundingClientRect();
      widths.add(Math.round(s.width));
      const need = naturalWidth(select, [...select.options].map((o) => o.textContent));
      if (need > s.width + tol) problems.push(`${origin}: drop-down ${s.width.toFixed(0)} px < its longest option ${need.toFixed(0)} px`);
      if (rows[0] === row && naturalWidth(select, labels) > s.width + tol) allLabelsFit = false;
      if (!within(s, selectCell.getBoundingClientRect())) problems.push(`${origin}: drop-down outside its cell`);
      for (const [name, el] of [["identifier", id], ["source line", originLine]]) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (el.scrollWidth > el.clientWidth + tol) problems.push(`${origin}: ${name} wider than its box (${el.scrollWidth} > ${el.clientWidth})`);
        if (!within(r, el.closest("td").getBoundingClientRect())) problems.push(`${origin}: ${name} outside its cell`);
        if (cross(r, s)) problems.push(`${origin}: ${name} crosses the drop-down`);
        // Whole, on one line: one line box for its text.
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top)));
        if (lines.size > 1) problems.push(`${origin}: ${name} wraps onto ${lines.size} lines ("${el.textContent}")`);
      }
      for (const cell of new Set([selectCell, idCell])) {
        if (cell.scrollWidth > cell.clientWidth + tol) problems.push(`${origin}: cell content wider than the cell (${cell.scrollWidth} > ${cell.clientWidth})`);
      }
    }
    const wrap = document.querySelector('[data-testid="rule-extract-table"]').parentElement;
    return {
      rows: rows.length,
      origins: rows.map((r) => r.dataset.origin),
      identifiers: rows.map((r) => r.querySelector('[data-testid="rule-extract-identifier"]').textContent),
      problems,
      widths: [...widths],
      allLabelsFit,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      tableScrolls: wrap.scrollWidth > wrap.clientWidth + 1,
    };
  }, ALL_LABELS[lang]);
}

async function setLanguage(page, lang) {
  await page.locator("header select, nav select").first().selectOption(lang);
  await page.waitForFunction(
    (l) => document.querySelector('[data-testid="rule-extract-section"] h2')?.textContent.includes(l === "es" ? "Importar" : "Import"),
    lang,
  );
}

async function search(page, text) {
  await page.getByTestId("rule-extract-search").fill(text);
  await page.waitForTimeout(150);
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = (await login.json()).access_token;
  if (!token) throw new Error(`login failed for ${EMAIL}`);

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  // A new file or text over an extraction not imported yet asks first
  // ("the current one is discarded"): accepted, as a user starting over.
  // Any other dialog is left to its own handler (or dismissed, the default).
  page.on("dialog", (d) => {
    if (/new extraction|extracción nueva/.test(d.message())) d.accept();
    else if (page.listenerCount("dialog") === 1) d.dismiss();
  });
  const project = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `AI Extract columns ${Date.now()}`, standard: "S1000D 4.2", project_config: {}, seed_from_catalog: false }),
  });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.getByTestId("rule-extract-section").waitFor();
    await page.getByTestId("rule-extract-file").setInputFiles(CA);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 240000 });
    await page.waitForTimeout(500);
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 240000 });

    // The window of the user's capture (~1,380 px), before anything else.
    await setLanguage(page, "es");
    await search(page, "S2-00002");
    await page.getByTestId("rule-extract-table").scrollIntoViewIfNeeded();
    await page.getByTestId("rule-extract-table").locator("xpath=..").screenshot({ path: path.join(SHOTS, `${SHOT_PREFIX}-1380-es.png`) });
    if (SHOTS_ONLY) {
      console.log(`screenshots in ${SHOTS}`);
      return;
    }

    for (const width of [1280, 1920]) {
      for (const lang of ["es", "en"]) {
        console.log(`\n${width} px, ${lang.toUpperCase()}`);
        await page.setViewportSize({ width, height: 1000 });
        await setLanguage(page, lang);
        await search(page, "");
        const pageLabel = await page.getByTestId("rule-extract-page").innerText();
        const pages = Number(pageLabel.match(/(?:of|de) (\d+)/)[1]);
        await page.getByTestId("rule-extract-table").scrollIntoViewIfNeeded();
        const problems = [];
        const widths = new Set();
        const seen = [];
        let labelsFit = true;
        let pageOverflow = 0;
        let tableScrolls = false;
        for (let i = 0; i < pages; i += 1) {
          const m = await measurePage(page, lang);
          problems.push(...m.problems);
          m.widths.forEach((w) => widths.add(w));
          seen.push(...m.identifiers);
          labelsFit = labelsFit && m.allLabelsFit;
          pageOverflow = Math.max(pageOverflow, m.pageOverflow);
          tableScrolls = tableScrolls || m.tableScrolls;
          if (i < pages - 1) await page.getByTestId("rule-extract-next").click();
        }
        // Back to the first page for the next round.
        for (let i = 0; i < pages - 1; i += 1) await page.getByTestId("rule-extract-prev").click();
        assert(seen.length === 533, `all 533 rows checked over ${pages} pages`, `${seen.length}`);
        assert(problems.length === 0, "no drop-down or identifier cut, outside its cell or overlapping", problems.slice(0, 8).join("\n       "));
        assert(widths.size === 1, "every drop-down has the same width (also with a single option)", [...widths].join(", "));
        assert(labelsFit, `the longest label of any classification fits (${ALL_LABELS[lang].join(" / ")})`);
        assert(pageOverflow <= 1, "the page does not scroll sideways", `${pageOverflow} px`);
        assert(seen.includes("BREX-S1-00074 ") || seen.includes("BREX-S1-00074"), "BREX-S1-00074 (trailing space) among the rows");
        console.log(`       drop-down ${[...widths].join(", ")} px; table scrolls sideways: ${tableScrolls ? "yes" : "no"}`);

        for (const id of ["S2-00002", "BREX-S1-00074"]) {
          await search(page, id);
          const m = await measurePage(page, lang);
          assert(m.rows >= 1 && m.problems.length === 0, `${id}: whole, on its own line, nothing crosses`, m.problems.join("; "));
        }
        await search(page, "S2-00002");
        await page.getByTestId("rule-extract-table").locator("xpath=..").screenshot({ path: path.join(SHOTS, `${SHOT_PREFIX}-${width}-${lang}.png`) });
        await search(page, "");
      }
    }
  } finally {
    await api(`/api/projects/${project.id}`, { method: "DELETE" }).catch((e) => console.log(`cleanup: ${e.message}`));
    await browser.close();
  }
  console.log(`\nscreenshots: ${path.join(SHOTS, `${SHOT_PREFIX}-*.png`)}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall ok");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
