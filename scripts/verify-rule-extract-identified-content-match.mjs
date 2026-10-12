// AI Extract: candidates with an official, default-rule or own-prefix
// identifier the project does not have, matched by their content, in a real
// browser against the real backend and Postgres (LLM through the local
// simulator, for the two placeholder rows the AI writes).
//
// The GMC ATA BREX (issue 018) is not in this repository: the file and the
// project made from Excel are reconstructed from real rules of the CA BREX
// (backend/scripts/build_gmc_like_fixtures.py). An S1000D 4.2 project is
// created and filled with its 159 EXT BRDPs (scripts/seed_ata_like_project.py
// with GMC-like-project-rules.json); BRDP-S1-00226 and BRDP-S1-00007 are in
// the S1000D 4.2 catalog of the database. The file is read through the page,
// and:
//   - the counts: 147 "Already exists (same)", 7 "(changes)", 1 "From the
//     catalog", 2 "New EXT"; no BRDP of the project left out of the file;
//   - BRDP-S1-00226 → BRDP-EXT-00083 and the five GEN: "Matched by content
//     with … ; in the file it is identified as …" (EN and ES), unchecked;
//   - BRDP-S1-00007: still "From the catalog", unchecked, "Its 5 rules are
//     already in the project, spread over: …" (EN and ES);
//   - there and back: S1-00226 to "From the catalog" (BRDP-EXT-00083 then
//     named as not in the file) and back to "Already exists (same)";
//   - importing what is checked by default creates only the two
//     placeholders: none of these seven rows, no rule of the project changed.
// The project is deleted at the end.
//
//     node scripts/verify-rule-extract-identified-content-match.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { backendPython, pythonEnv } from "./lib/backendPython.mjs";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GMC_018 = path.join(ROOT, "backend", "tests", "fixtures", "brex", "GMC-like-018-reconstructed.xml");
const GEN = {
  "BRDP-GEN-00077": "BRDP-EXT-00086",
  "BRDP-GEN-00078": "BRDP-EXT-00087",
  "BRDP-GEN-00079": "BRDP-EXT-00088",
  "BRDP-GEN-00080": "BRDP-EXT-00089",
  "BRDP-GEN-00081": "BRDP-EXT-00105",
};
const SPLIT = "BRDP-EXT-00084, BRDP-EXT-00085, BRDP-EXT-00090, BRDP-EXT-00091, BRDP-EXT-00092";

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

const setLanguage = (lang) => api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: lang }) });

async function storedRules(projectId) {
  const rows = await api(`/api/projects/${projectId}/approvals/BREX-4.2/export`);
  return new Map(rows.map((r) => [r.brdp_id, `${r.status}|${r.rule_xml}`]));
}

async function rowOf(page, text) {
  await page.getByTestId("rule-extract-search").fill(text);
  const row = page.locator('[data-testid="rule-extract-row"]').filter({ hasText: text }).first();
  await row.waitFor();
  return { row, text: await row.getByTestId("rule-extract-warnings").innerText() };
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = (await login.json()).access_token;
  if (!token) throw new Error(`login failed for ${EMAIL}`);
  await setLanguage("en");

  const project = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `GMC ATA content match ${Date.now()}`, standard: "S1000D 4.2", project_config: {}, seed_from_catalog: false }),
  });
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  try {
    const seeded = execFileSync(backendPython(), [path.join("scripts", "seed_ata_like_project.py"), project.id, "GMC-like-project-rules.json"], {
      cwd: path.join(ROOT, "backend"),
      env: pythonEnv(),
      encoding: "utf-8",
    });
    console.log(`Seeded the GMC project: ${seeded.trim()}`);
    const before = await storedRules(project.id);
    assert(before.size === 159, `159 rules stored before reading the file (${before.size})`);

    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.getByTestId("rule-extract-section").waitFor();

    console.log("\nIssue 018 read into the project");
    await page.getByTestId("rule-extract-file").setInputFiles(GMC_018);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 120000 });
    await page.waitForTimeout(500);
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 120000 });
    const counts = await page.getByTestId("rule-extract-counts").innerText();
    console.log(`  counts: ${counts.replace(/\s+/g, " ")}`);
    assert(counts.includes("157 candidates"), "157 candidates", counts);
    assert(/Already exists \(same\): 147/.test(counts), "147 already in the project, the same (141 + S1-00226 + 5 GEN)", counts);
    assert(/Already exists \(changes\): 7/.test(counts), "7 already in the project, changed", counts);
    assert(/From catalog: 1/.test(counts), "1 from catalog (S1-00007)", counts);
    assert(/New EXT: 2/.test(counts), "2 new EXT (the placeholders)", counts);
    assert(!/Keep GEN/.test(counts), "no \"Keep GEN\" left", counts);
    await page.waitForTimeout(1000);
    assert((await page.getByTestId("rule-extract-unmatched-count").count()) === 0, "no BRDP of the project left out of the file");

    const job = await api(`/api/projects/${project.id}/ai-extract/jobs/active`);
    const cands = (await api(`/api/projects/${project.id}/ai-extract/jobs/${job.id}/candidates`)).candidates;
    const checked = cands.filter((c) => c.selected);
    assert(
      checked.length === 2 && checked.every((c) => c.classification === "new_ext"),
      "only the two placeholders are checked by default",
      JSON.stringify(checked.map((c) => [c.identifier, c.classification])),
    );

    {
      const { row, text } = await rowOf(page, "BRDP-S1-00226");
      assert(text.includes("Matched by content with BRDP-EXT-00083; in the file it is identified as BRDP-S1-00226."), "S1-00226: the warning (EN)", text);
      assert(!(await row.getByTestId("rule-extract-select").isChecked()), "S1-00226 unchecked");
      assert((await row.getByTestId("rule-extract-class").inputValue()) === "same", "S1-00226: Already exists (same)");
      await page.getByTestId("rule-extract-review").screenshot({ path: shot("rule-extract-identified-same-en.png") });
    }
    for (const [origin, identifier] of Object.entries(GEN)) {
      const { row, text } = await rowOf(page, origin);
      assert(
        text.includes(`Matched by content with ${identifier}; in the file it is identified as ${origin}.`) &&
          !(await row.getByTestId("rule-extract-select").isChecked()),
        `${origin} = ${identifier}, unchecked`,
        text,
      );
    }
    {
      const { row, text } = await rowOf(page, "BRDP-S1-00007");
      assert(
        text.includes(`Its 5 rules are already in the project, spread over: ${SPLIT}; importing it would duplicate those rules.`),
        "S1-00007: the spread warning (EN)",
        text,
      );
      assert(!(await row.getByTestId("rule-extract-select").isChecked()), "S1-00007 unchecked");
      assert((await row.getByTestId("rule-extract-class").inputValue()) === "catalog", "S1-00007 still From the catalog");
      await page.getByTestId("rule-extract-review").screenshot({ path: shot("rule-extract-identified-split-en.png") });
    }

    console.log("\nThere and back");
    {
      const { row } = await rowOf(page, "BRDP-S1-00226");
      await row.getByTestId("rule-extract-class").selectOption("catalog");
      await page.waitForFunction(() => document.querySelector('[data-testid="rule-extract-unmatched-count"]')?.textContent.startsWith("1 "), null, { timeout: 15000 });
      await page.getByTestId("rule-extract-unmatched-toggle").click();
      const list = await page.getByTestId("rule-extract-unmatched-list").innerText();
      assert(list.includes("BRDP-EXT-00083"), "as From the catalog, BRDP-EXT-00083 is named as not in the file", list);
      const moved = (await api(`/api/projects/${project.id}/ai-extract/jobs/${job.id}/candidates`)).candidates.find((c) => c.origin_identifier === "BRDP-S1-00226");
      assert(moved.classification === "catalog" && moved.identifier === "BRDP-S1-00226", "saved as From the catalog with its own identifier", JSON.stringify([moved.classification, moved.identifier]));
      const again = (await rowOf(page, "BRDP-S1-00226")).row;
      await again.getByTestId("rule-extract-class").selectOption("same");
      await page.getByTestId("rule-extract-unmatched-count").waitFor({ state: "detached", timeout: 15000 });
      const back = (await api(`/api/projects/${project.id}/ai-extract/jobs/${job.id}/candidates`)).candidates.find((c) => c.origin_identifier === "BRDP-S1-00226");
      assert(back.classification === "same" && back.identifier === "BRDP-EXT-00083", "back to Already exists (same), BRDP-EXT-00083", JSON.stringify([back.classification, back.identifier]));
      // The five GEN can be kept with their prefix too.
      const gen = (await rowOf(page, "BRDP-GEN-00081")).row;
      const options = await gen.getByTestId("rule-extract-class").locator("option").allInnerTexts();
      assert(options.join("|") === "Already exists (same)|Keep GEN|New EXT", "GEN: Already exists (same), Keep GEN, New EXT", options.join("|"));
    }

    console.log("\nThe same screen in Spanish");
    await setLanguage("es");
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    {
      const { text } = await rowOf(page, "BRDP-S1-00226");
      assert(text.includes("Emparejada por contenido con BRDP-EXT-00083; en el fichero se identifica como BRDP-S1-00226."), "S1-00226 (ES)", text);
      const s7 = await rowOf(page, "BRDP-S1-00007");
      assert(
        s7.text.includes(`Sus 5 reglas ya están en el proyecto, repartidas en: ${SPLIT}; importarla duplicaría esas reglas.`),
        "S1-00007 (ES)",
        s7.text,
      );
      await page.getByTestId("rule-extract-review").screenshot({ path: shot("rule-extract-identified-es.png") });
    }
    await setLanguage("en");
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    await page.getByTestId("rule-extract-search").fill("");

    console.log("\nImporting without touching anything");
    await page.getByTestId("rule-extract-apply").click();
    await page.getByTestId("rule-extract-result").waitFor({ timeout: 60000 });
    const summary = await page.getByTestId("rule-extract-result-summary").innerText();
    assert(/Checked 2/.test(summary) && /Created 2/.test(summary) && /Updated 0/.test(summary), "2 checked, 2 created, 0 updated", summary);
    const after = await storedRules(project.id);
    const changed = [...before].filter(([id, v]) => after.get(id) !== v);
    assert(changed.length === 0, "no rule of the project changed", JSON.stringify(changed.slice(0, 3)));
    const brdps = await api(`/api/projects/${project.id}/brdps`);
    const ids = new Set(brdps.map((b) => b.identifier));
    assert(after.size === 161 && !ids.has("BRDP-S1-00226") && !ids.has("BRDP-S1-00007") && !Object.keys(GEN).some((g) => ids.has(g)), "161 rules now; none of the seven rows created", `${after.size}`);
  } finally {
    await browser.close();
    await setLanguage("en").catch(() => {});
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" }).catch((e) => console.log(`cleanup: ${e.message}`));
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
