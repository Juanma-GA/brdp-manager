// Own identifier prefixes (BRDP-ENV-00001) in AI Extract and in Add BRDP --
// in a real browser, against the real backend and Postgres (AI texts and
// embeddings through the local simulators):
//   - AI Extract, a BREX in an S1000D 4.2 project that has BRDP-ENV-00002
//     with another rule: BRDP-ENV-00001 and -00003 are "Keep ENV", checked,
//     with their own numbers; BRDP-ENV-00002 "Already exists (changes)";
//     BRDP-S1-99999 (not in the catalog) and BRDP-EXT-00004 as before;
//   - switching ENV-00001 to New EXT and back recovers BRDP-ENV-00001 (and
//     warns that the ids inside the rule are the file's while it is EXT);
//   - the "Show" filter and "Classify the shown rows as…" offer "Keep ENV";
//   - the import creates BRDP-ENV-00001 and BRDP-ENV-00003; in Spanish the
//     option reads "Conservar ENV";
//   - Add BRDP: the prefix field (EXT by default), ENV in a project without
//     any gives BRDP-ENV-00001; "env", "E" and "ENVIRONMENT" are said by the
//     form (Save disabled) and refused by the server (422); the created
//     BRDP's identifier cannot be edited; Spanish texts.
//
//     node scripts/verify-own-prefix.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_EMAIL ? process.env.PROMPT_EVAL_PASSWORD || "" : "AdminTest123!";

const rule = (identifier, path) =>
  `<structureObjectRule id="${identifier}"><objectPath allowedObjectFlag="0">${path}</objectPath>` +
  `<objectUse>${identifier}. Element ${path.slice(2)} shall not be used.</objectUse></structureObjectRule>`;
const FILE = path.join(os.tmpdir(), "brex-42-own-prefix.xml");
fs.writeFileSync(
  FILE,
  '<?xml version="1.0"?><dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd"><identAndStatusSection/><content><brex><contextRules><structureObjectRuleGroup>' +
    rule("BRDP-ENV-00001", "//envone") +
    rule("BRDP-ENV-00003", "//envthree") +
    rule("BRDP-ENV-00002", "//envtwo") +
    rule("BRDP-S1-99999", "//sone") +
    rule("BRDP-EXT-00004", "//extfour") +
    "</structureObjectRuleGroup></contextRules></brex></content></dmodule>"
);

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
async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  token = (await res.json()).access_token;
  if (!token) throw new Error(`login failed for ${EMAIL}`);
}
const setLanguage = (lang) => api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: lang }) });
async function createProject(name, standard) {
  return api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `${name} ${Date.now()}`, standard, project_config: {}, seed_from_catalog: false }),
  });
}
const row = (page, origin) => page.locator(`[data-testid="rule-extract-row"][data-origin="${origin}"]`);
const optionTexts = (locator) => locator.locator("option").allInnerTexts();

async function main() {
  await login();
  const me = await api("/api/auth/me");
  const previousLanguage = me.preferred_language;
  await setLanguage("en");
  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("dialog", (d) => d.accept());
  const projects = [];
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", EMAIL);
    await page.fill("#login-password", PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/projects/);

    // ── AI Extract ──────────────────────────────────────────────────────────
    console.log("\nAI Extract: a BREX with BRDP-ENV-… identifiers in an S1000D 4.2 project");
    const p = await createProject("Own prefix", "S1000D 4.2");
    projects.push(p);
    const env2 = await api(`/api/projects/${p.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier: "BRDP-ENV-00002", title: "Seeded", definition: "", proposal: "", validation: "Pending" }),
    });
    await api(`/api/projects/${p.id}/brdps/${env2.id}/approvals/BREX-4.2`, {
      method: "PUT",
      body: JSON.stringify({ rule_xml: rule("BRDP-ENV-00002", "//somethingelse"), source: "manual" }),
    });
    await page.goto(`${BASE_URL}/projects/${p.id}/config`);
    await page.getByTestId("rule-extract-file").setInputFiles(FILE);
    await page.getByTestId("rule-extract-table").waitFor({ timeout: 60000 });
    await page.getByTestId("rule-extract-drafting").waitFor({ state: "detached", timeout: 60000 }).catch(() => {});

    const cls = (origin) => row(page, origin).getByTestId("rule-extract-class");
    const ident = (origin) => row(page, origin).getByTestId("rule-extract-identifier").innerText();
    assert((await cls("BRDP-ENV-00001").inputValue()) === "own_prefix", "ENV-00001: own_prefix by default");
    assert(JSON.stringify(await optionTexts(cls("BRDP-ENV-00001"))) === JSON.stringify(["Keep ENV", "New EXT"]), 'ENV-00001 options: "Keep ENV", "New EXT"', JSON.stringify(await optionTexts(cls("BRDP-ENV-00001"))));
    assert(await row(page, "BRDP-ENV-00001").getByTestId("rule-extract-select").isChecked(), "ENV-00001 checked");
    assert((await ident("BRDP-ENV-00001")).trim() === "BRDP-ENV-00001", "ENV-00001 imported as BRDP-ENV-00001");
    assert((await ident("BRDP-ENV-00003")).trim() === "BRDP-ENV-00003", "ENV-00003 keeps its number (project has ENV-00002)");
    assert((await cls("BRDP-ENV-00002").inputValue()) === "changed", "ENV-00002 with another rule: Already exists (changes)");
    assert(JSON.stringify(await optionTexts(cls("BRDP-ENV-00002"))) === JSON.stringify(["Already exists (changes)", "Keep ENV", "New EXT"]),
      "ENV-00002 options include Keep ENV", JSON.stringify(await optionTexts(cls("BRDP-ENV-00002"))));
    assert((await cls("BRDP-S1-99999").inputValue()) === "new_ext", "BRDP-S1-99999 (not in the catalog): New EXT, as before");
    assert((await cls("BRDP-EXT-00004").inputValue()) === "new_ext" && (await ident("BRDP-EXT-00004")).trim() === "BRDP-EXT-00004", "BRDP-EXT-00004: New EXT with its number, as before");

    await cls("BRDP-ENV-00001").selectOption("new_ext");
    await page.waitForFunction(() => /BRDP-EXT-\d{5}/.test(document.querySelector('[data-testid="rule-extract-row"][data-origin="BRDP-ENV-00001"] [data-testid="rule-extract-identifier"]')?.innerText || ""));
    const asExt = (await ident("BRDP-ENV-00001")).trim();
    assert(/^BRDP-EXT-\d{5}$/.test(asExt), `switched to New EXT: ${asExt}`);
    const warnings = await row(page, "BRDP-ENV-00001").getByTestId("rule-extract-warnings").innerText().catch(() => "");
    assert(warnings.includes("BRDP-ENV-00001"), "warns that the ids inside the rule are still the file's", warnings);
    await cls("BRDP-ENV-00001").selectOption("own_prefix");
    await page.waitForFunction(() => (document.querySelector('[data-testid="rule-extract-row"][data-origin="BRDP-ENV-00001"] [data-testid="rule-extract-identifier"]')?.innerText || "").trim() === "BRDP-ENV-00001");
    assert(true, "back to Keep ENV: BRDP-ENV-00001 again");

    const filterOptions = await optionTexts(page.getByTestId("rule-extract-filter"));
    assert(filterOptions.includes("Keep ENV"), 'Show filter offers "Keep ENV"', filterOptions.join(" | "));
    assert(filterOptions.every((o) => o.trim() && !o.includes("config.")), "no empty or raw filter label");
    await page.getByTestId("rule-extract-filter").selectOption("own_prefix");
    const shown = await page.getByTestId("rule-extract-row").count();
    assert(shown === 2, `filter "Keep ENV": 2 rows (${shown})`);
    const bulk = await optionTexts(page.getByTestId("rule-extract-classify-shown"));
    assert(bulk.includes("Keep ENV") && bulk.includes("New EXT"), 'bulk classify offers "Keep ENV" and "New EXT"', bulk.join(" | "));
    await page.screenshot({ path: shot("own-prefix-extract-en.png") });
    await page.getByTestId("rule-extract-filter").selectOption("all");

    // Spanish.
    await setLanguage("es");
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor();
    assert(JSON.stringify(await optionTexts(cls("BRDP-ENV-00001"))) === JSON.stringify(["Conservar ENV", "Nueva EXT"]), 'ES: "Conservar ENV", "Nueva EXT"', JSON.stringify(await optionTexts(cls("BRDP-ENV-00001"))));
    assert((await optionTexts(page.getByTestId("rule-extract-filter"))).includes("Conservar ENV"), 'ES filter: "Conservar ENV"');
    await page.screenshot({ path: shot("own-prefix-extract-es.png") });
    await setLanguage("en");
    await page.reload();
    await page.getByTestId("rule-extract-table").waitFor();

    // Import (ENV-00002 changed: its rule only).
    const apply = page.getByTestId("rule-extract-apply");
    await page.waitForFunction(() => !document.querySelector('[data-testid="rule-extract-apply"]')?.disabled, null, { timeout: 60000 });
    await apply.click();
    await page.getByTestId("rule-extract-result").waitFor({ timeout: 60000 });
    const ids = (await api(`/api/projects/${p.id}/brdps`)).map((b) => b.identifier).sort();
    assert(ids.includes("BRDP-ENV-00001") && ids.includes("BRDP-ENV-00003") && ids.includes("BRDP-EXT-00004"),
      "imported: BRDP-ENV-00001, BRDP-ENV-00003, BRDP-EXT-00004", ids.join(", "));
    const envs = ids.filter((i) => i.startsWith("BRDP-ENV-"));
    assert(envs.length === 3, `three ENV BRDPs (${envs.join(", ")})`);

    // ── Add BRDP ────────────────────────────────────────────────────────────
    console.log("\nAdd BRDP: prefix field");
    const q = await createProject("Own prefix add", "S1000D 4.2");
    projects.push(q);
    await page.goto(`${BASE_URL}/projects/${q.id}/records`);
    await page.getByTestId("add-brdp").click();
    const prefix = page.getByTestId("new-brdp-prefix");
    await page.waitForFunction(() => document.querySelector('[data-testid="new-brdp-identifier"]')?.value === "BRDP-EXT-00001");
    assert((await prefix.inputValue()) === "EXT", "prefix EXT by default, identifier BRDP-EXT-00001");
    await prefix.fill("ENV");
    await page.waitForFunction(() => document.querySelector('[data-testid="new-brdp-identifier"]')?.value === "BRDP-ENV-00001");
    assert(true, "prefix ENV in a project without any: BRDP-ENV-00001");
    for (const bad of ["env", "E", "ENVIRONMENT"]) {
      await prefix.fill(bad);
      const err = await page.getByTestId("new-brdp-prefix-error").innerText();
      assert(err.includes(`"${bad}"`) && err.includes("2 to 6 uppercase letters"), `"${bad}": the form says why`, err);
      assert(await page.getByTestId("new-brdp-save").isDisabled(), `"${bad}": Save disabled`);
      const res = await fetch(`${API}/api/projects/${q.id}/brdps/next-ext-identifier?prefix=${encodeURIComponent(bad)}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      assert(res.status === 422 && body.detail?.code === "brdp_prefix_invalid", `"${bad}": server 422 brdp_prefix_invalid`, JSON.stringify(body));
    }
    await page.screenshot({ path: shot("own-prefix-add-invalid-en.png") });
    await setLanguage("es");
    await page.reload();
    await page.getByTestId("add-brdp").click();
    await page.getByTestId("new-brdp-prefix").fill("env");
    const errEs = await page.getByTestId("new-brdp-prefix-error").innerText();
    assert(errEs.includes('El prefijo "env" no es válido'), "ES: the form says why", errEs);
    assert((await page.locator('label[for="new-brdp-prefix"]').textContent()).trim() === "Prefijo", 'ES label "Prefijo"');
    await page.screenshot({ path: shot("own-prefix-add-invalid-es.png") });
    await page.getByTestId("new-brdp-prefix").fill("ENV");
    await page.waitForFunction(() => document.querySelector('[data-testid="new-brdp-identifier"]')?.value === "BRDP-ENV-00001");
    await page.getByTestId("new-brdp-save").click();
    await page.getByTestId("add-brdp").waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="new-brdp-save"]'));
    const created = (await api(`/api/projects/${q.id}/brdps`)).map((b) => b.identifier);
    assert(created.includes("BRDP-ENV-00001"), "created BRDP-ENV-00001", created.join(", "));
    const putRes = await fetch(`${API}/api/projects/${q.id}/brdps/${(await api(`/api/projects/${q.id}/brdps`))[0].id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ identifier: "BRDP-ENV-00009" }),
    });
    assert(putRes.status === 422, `the created BRDP's identifier cannot be edited (PUT identifier -> ${putRes.status})`);
    await page.getByTestId("add-brdp").click();
    await page.getByTestId("new-brdp-prefix").fill("ENV");
    await page.waitForFunction(() => document.querySelector('[data-testid="new-brdp-identifier"]')?.value === "BRDP-ENV-00002");
    assert(true, "next one with ENV: BRDP-ENV-00002");
  } finally {
    await setLanguage(previousLanguage ?? null).catch(() => {});
    for (const pr of projects) await api(`/api/projects/${pr.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
    await browser.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
