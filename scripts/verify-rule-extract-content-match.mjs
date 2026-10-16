// AI Extract: rules already in the project recognized by their content, in a
// real browser against the real backend and Postgres (LLM through the local
// simulator, for the two placeholder rows the AI writes).
//
// The ATA CMP BREX is not in this repository: the "issue 010" file and the
// "issue 009" project are reconstructed from real rules of the CA BREX
// (backend/scripts/build_ata_like_fixtures.py). An S1000D 4.2 project is
// created and filled with the 461 rules of "009" (scripts/seed_ata_like_project.py),
// the "010" file is read through the page, and:
//   - the counts: 450 "Already exists (same)", 11 "(changed)", 2 "New EXT";
//   - BRDP-EXT-00043 (corrected by the project): the content warning in EN
//     and ES, unchecked; SOR-3, marked changeType="modify" in the file:
//     "Marked as modified in the file; matched by similarity with
//     BRDP-EXT-00002", unchecked;
//   - a BRDP of the project with a rule the file does not have (added to the
//     seeded project): "1 BRDP of the project is not in the file", named by
//     "Show them" (EN and ES), and 2 at once when SOR-3 is moved to "New EXT";
//   - importing what is checked by default (only the two placeholders)
//     changes no rule of the project.
// The project is deleted at the end.
//
//     node scripts/verify-rule-extract-content-match.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { backendPython, pythonEnv } from "./lib/backendPython.mjs";
import { shot } from "./lib/shots.mjs";
import { keepAccountLanguage } from "./lib/seeds.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
// Gives the account back its language when the process exits (the
// language selector saves it on the account; see lib/seeds.mjs).
keepAccountLanguage(EMAIL);
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ATA_010 = path.join(ROOT, "backend", "tests", "fixtures", "brex", "ATA-CMP-like-010-reconstructed.xml");

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

async function warningOf(page, identifier) {
  await page.getByTestId("rule-extract-search").fill(identifier);
  const row = page.locator('[data-testid="rule-extract-row"]').filter({ hasText: identifier }).first();
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
    body: JSON.stringify({ name: `ATA CMP content match ${Date.now()}`, standard: "S1000D 4.2", project_config: {}, seed_from_catalog: false }),
  });
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  try {
    const seeded = execFileSync(backendPython(), [path.join("scripts", "seed_ata_like_project.py"), project.id], {
      cwd: path.join(ROOT, "backend"),
      env: pythonEnv(),
      encoding: "utf-8",
    });
    console.log(`Seeded the "issue 009" project: ${seeded.trim()}`);
    // A BRDP only the project has (with a rule): not in the file.
    const extra = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier: "BRDP-EXT-00999", title: "Only in the project" }),
    });
    await api(`/api/projects/${project.id}/brdps/${extra.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({
        rule_xml: '<structureObjectRule><objectPath allowedObjectFlag="0">//projectOnly</objectPath><objectUse>Only this project.</objectUse></structureObjectRule>',
        status: "pending_review",
        source: "manual",
      }),
    });
    const before = await storedRules(project.id);
    assert(before.size === 462, `462 rules stored before reading the file (461 + one only in the project) (${before.size})`);

    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);
    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.getByTestId("rule-extract-section").waitFor();

    console.log("\nIssue 010 read into the issue 009 project");
    await page.getByTestId("rule-extract-file").setInputFiles(ATA_010);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 120000 });
    await page.waitForTimeout(500);
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 120000 });
    const counts = await page.getByTestId("rule-extract-counts").innerText();
    console.log(`  counts: ${counts.replace(/\s+/g, " ")}`);
    assert(counts.includes("463 candidates"), "463 candidates", counts);
    assert(/Already exists \(same\): 450/.test(counts), "450 already in the project, the same", counts);
    assert(/Already exists \(changes\): 11/.test(counts), "11 already in the project, changed (10 corrections + SOR-3)", counts);
    assert(/New EXT: 2/.test(counts), "2 new EXT (the placeholders)", counts);

    const job = await api(`/api/projects/${project.id}/ai-extract/jobs/active`);
    const cands = (await api(`/api/projects/${project.id}/ai-extract/jobs/${job.id}/candidates`)).candidates;
    const checked = cands.filter((c) => c.selected);
    assert(
      checked.length === 2 && checked.every((c) => c.classification === "new_ext"),
      "only the two placeholders are checked by default",
      JSON.stringify(checked.map((c) => [c.identifier, c.classification])),
    );

    {
      const { row, text } = await warningOf(page, "BRDP-EXT-00043");
      assert(
        text.includes("Matched by content: the project's rule differs from the file's. It may be a correction made in the project; review it before importing."),
        "BRDP-EXT-00043: the content warning (EN)",
        text,
      );
      assert(!(await row.getByTestId("rule-extract-select").isChecked()), "BRDP-EXT-00043 unchecked");
      assert((await row.getByTestId("rule-extract-rule-diff").count()) > 0 || (await row.getByTestId("rule-extract-rule-summary").count()) > 0, "its rule (and the diff with the stored one) can be opened");
      await page.getByTestId("rule-extract-review").screenshot({ path: shot("rule-extract-content-match-en.png") });
    }
    {
      const { row, text } = await warningOf(page, "BRDP-EXT-00002");
      assert(
        text.includes("Marked as modified in the file; matched by similarity with BRDP-EXT-00002: check it."),
        "SOR-3 (changeType=\"modify\"): matched by similarity with BRDP-EXT-00002 (EN)",
        text,
      );
      assert(!(await row.getByTestId("rule-extract-select").isChecked()), "SOR-3 unchecked");
    }

    console.log("\nThe project's BRDPs that are not in the file");
    {
      const line = page.getByTestId("rule-extract-unmatched-count");
      await line.waitFor({ timeout: 15000 });
      assert((await line.innerText()) === "1 BRDP of the project is not in the file.", "1 BRDP of the project is not in the file (EN)", await line.innerText());
      assert((await page.getByTestId("rule-extract-unmatched-list").count()) === 0, "the list starts folded");
      await page.getByTestId("rule-extract-unmatched-toggle").click();
      const list = await page.getByTestId("rule-extract-unmatched-list").innerText();
      assert(list.includes("BRDP-EXT-00999") && list.includes("Only in the project") && list.includes("Draft"), "Show them: identifier, title, rule status", list);
      await page.getByTestId("rule-extract-review").screenshot({ path: shot("rule-extract-unmatched-en.png") });
      // SOR-3 moved to "New EXT": BRDP-EXT-00002 is no longer in the file, at once.
      await page.getByTestId("rule-extract-search").fill("BRDP-EXT-00002");
      const s3 = page.locator('[data-testid="rule-extract-row"]').filter({ hasText: "BRDP-EXT-00002" }).first();
      await s3.getByTestId("rule-extract-class").selectOption("new_ext");
      await page.waitForFunction(() => document.querySelector('[data-testid="rule-extract-unmatched-count"]')?.textContent.startsWith("2 "), null, { timeout: 15000 });
      const list2 = await page.getByTestId("rule-extract-unmatched-list").innerText();
      assert(list2.includes("BRDP-EXT-00002") && list2.includes("Verified") && list2.includes("BRDP-EXT-00999"), "2 once SOR-3 is a new EXT: BRDP-EXT-00002 (Verified) named", list2);
      const restored = (await api(`/api/projects/${project.id}/ai-extract/jobs/${job.id}/candidates`)).candidates.find((c) => c.key === cands.find((x) => x.identifier === "BRDP-EXT-00002").key);
      await api(`/api/projects/${project.id}/ai-extract/jobs/${job.id}/candidates`, {
        method: "PATCH",
        body: JSON.stringify({ items: [{ key: restored.key, classification: "changed" }] }),
      });
    }

    console.log("\nThe same screen in Spanish");
    await setLanguage("es");
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    {
      const { text } = await warningOf(page, "BRDP-EXT-00043");
      assert(
        text.includes("Emparejada por contenido: la regla del proyecto difiere del fichero. Puede ser una corrección hecha en el proyecto; revisa antes de importar."),
        "BRDP-EXT-00043: the content warning (ES)",
        text,
      );
      const s3 = await warningOf(page, "BRDP-EXT-00002");
      assert(
        s3.text.includes("Marcada como modificada en el fichero; emparejada por parecido con BRDP-EXT-00002: compruébalo."),
        "SOR-3 (ES)",
        s3.text,
      );
      const line = await page.getByTestId("rule-extract-unmatched-count").innerText();
      assert(line === "1 BRDP del proyecto no está en el fichero.", "1 BRDP del proyecto no está en el fichero (ES)", line);
      assert((await page.getByTestId("rule-extract-unmatched-toggle").innerText()) === "Mostrarlas", "Mostrarlas (ES)");
      await page.getByTestId("rule-extract-review").screenshot({ path: shot("rule-extract-content-match-es.png") });
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
    assert(after.size === 464, `464 rules now (462 + the 2 placeholders) (${after.size})`);
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
