// AACF 3, Part 4 (e): the texts Part 3 moved to i18n, in a real browser.
//   - the signed-in user's role in the header, in Spanish and in English;
//   - Comparar's structural summary of two Schematron rules says
//     "contexto"/"condición" in Spanish and "context"/"test" in English;
//   - a Suggest Definition reference's origin, sent by the server as
//     structured data, reads "Catálogo" / "Registros: <proyecto>" in
//     Spanish (the prompt keeps its English text: snapshot).
// Real Vite + backend (+ the Mistral simulators on 8901/8902); the two
// seeded projects are deleted at the end and the language restored.
//
//   node scripts/verify-aacf3-texts.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const SHOTS = path.join(os.tmpdir(), "aacf3");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK" : "FAIL"}: ${msg}`);
  if (!cond) failures += 1;
}

async function api(p, options = {}, token) {
  const res = await fetch(`${API}${p}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`${options.method || "GET"} ${p} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function computeEmbeddings(token, projectId) {
  const pending = await api(`/api/projects/${projectId}/embeddings/pending`, {}, token);
  if (!pending.project_pending && !pending.catalog_pending) return;
  const { job_id } = await api(`/api/projects/${projectId}/embeddings/compute`, { method: "POST" }, token);
  for (let i = 0; i < 600; i++) {
    const job = await api(`/api/projects/${projectId}/embeddings/status/${job_id}`, {}, token);
    if (job.status !== "running") {
      if (job.status !== "completed") throw new Error(`embeddings job ${job.status}: ${job.error}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("embeddings job did not finish");
}

const suffix = Math.random().toString(36).slice(2, 8);
const { access_token: token } = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const me = await api("/api/auth/me", {}, token);
const previousLanguage = me.preferred_language;
assert(me.global_role === "admin", "the verification user is an admin");

const created = [];
const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
try {
  // --- Projects: a DITA one for Comparar, two S1000D 4.2 for Suggest. ---
  const dita = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF3 textos DITA ${suffix}`, standard: "DITA 1.3 Xpath2.0" }) }, token);
  created.push(dita.id);
  const sch = (test) =>
    `<sch:pattern id="p-${suffix}"><sch:rule context="note"><sch:assert id="a-${suffix}" test="${test}">Each note needs a type.</sch:assert></sch:rule></sch:pattern>`;
  for (const [id, test] of [["BRDP-T3-A", "@type"], ["BRDP-T3-B", "@type = 'note'"]]) {
    const b = await api(`/api/projects/${dita.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: `${id}-${suffix}`, title: `Note type ${id}` }) }, token);
    await api(`/api/projects/${dita.id}/brdps/${b.id}/approvals/SCH-DITA`, { method: "PUT", body: JSON.stringify({ rule_xml: sch(test), status: "pending_review", source: "manual" }) }, token);
  }

  // Unique invented words make the other project's BRDP the closest one;
  // the catalog of S1000D 4.2 fills the rest of the five.
  const words = `zorbaflex quintavel ${suffix}`;
  const other = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF3 otro ${suffix}`, standard: "S1000D 4.2" }) }, token);
  created.push(other.id);
  await api(`/api/projects/${other.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: `BRDP-T3-REF-${suffix}`, title: `Use of ${words}`, definition: `Decide whether ${words} is used.`, proposal: `${words} shall not be used.`, validation: "Validated" }) }, token);
  await computeEmbeddings(token, other.id);
  const main = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF3 sugerir ${suffix}`, standard: "S1000D 4.2" }) }, token);
  created.push(main.id);
  await api(`/api/projects/${main.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: `BRDP-T3-SRC-${suffix}`, title: `Use of ${words}`, proposal: `${words} shall not be used.` }) }, token);
  await computeEmbeddings(token, main.id);

  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const setLanguage = async (lang) => {
    await api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: lang }) }, token);
  };
  await setLanguage("es");
  await page.goto(BASE_URL);
  await page.waitForSelector("#login-email");
  await page.fill("#login-email", EMAIL);
  await page.fill("#login-password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector("table");

  // --- Role in the header. ---
  const header = () => page.locator("header").innerText();
  assert((await header()).includes("· Administrador"), `header role in Spanish: ${(await header()).replace(/\n/g, " ")}`);
  assert(!/·\s*admin\b/.test(await header()), "the raw token 'admin' is never shown");
  await setLanguage("en");
  await page.reload();
  await page.waitForSelector("table");
  assert((await header()).includes("· Administrator"), `header role in English: ${(await header()).replace(/\n/g, " ")}`);
  await setLanguage("es");
  await page.reload();
  await page.waitForSelector("table");

  // --- Comparar: context / test. ---
  const compareLines = async () => {
    await page.goto(`${BASE_URL}/projects/${dita.id}/records`);
    await page.locator("tbody tr", { hasText: `BRDP-T3-A-${suffix}` }).first().click();
    await page.getByTestId("compare-open").click();
    await page.getByTestId("compare-tab-project").click();
    await page.getByTestId("compare-project-search").fill(`BRDP-T3-B-${suffix}`);
    await page.getByTestId("compare-project-candidate").first().click();
    await page.getByTestId("compare-structure-item").first().waitFor();
    return page.getByTestId("compare-structure").innerText();
  };
  const es = await compareLines();
  assert(/condición: @type → @type = 'note'/.test(es), `Comparar in Spanish names the test "condición" (${es.replace(/\n/g, " | ")})`);
  assert(!/\btest:/.test(es) && !/\bcontext:/.test(es), "no English 'test:' / 'context:' label in Spanish");
  await page.screenshot({ path: path.join(SHOTS, "compare-context-test-es.png") });
  await setLanguage("en");
  await page.reload();
  const en = await compareLines();
  assert(/test: @type → @type = 'note'/.test(en), `Comparar in English names it "test" (${en.replace(/\n/g, " | ")})`);
  await setLanguage("es");
  await page.reload();
  await page.waitForSelector("table, main");

  // --- Suggest Definition: the reference's origin in Spanish. ---
  await page.goto(`${BASE_URL}/projects/${main.id}/records`);
  await page.locator("tbody tr", { hasText: `BRDP-T3-SRC-${suffix}` }).first().click();
  const button = page.getByRole("button", { name: "Sugerir Definición" });
  await button.waitFor();
  for (let i = 0; i < 40 && !(await button.isEnabled()); i++) await page.waitForTimeout(250);
  await button.click();
  await page.getByText("Similares", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
  const refs = page.locator("li", { hasText: "BRDP-" }).filter({ has: page.locator("button") });
  await refs.first().waitFor({ timeout: 20000 });
  const texts = await refs.allInnerTexts();
  const joined = texts.join(" | ");
  assert(texts.some((t) => t.includes(`— Registros: AACF3 otro ${suffix}`)), `a reference from another project reads "Registros: <proyecto>" (${joined.slice(0, 300)})`);
  assert(texts.some((t) => t.includes("— Catálogo")), "a catalog reference reads \"Catálogo\"");
  assert(!texts.some((t) => /— (Records|Catalog)\b/.test(t)), "no English origin in Spanish");
  await page.screenshot({ path: path.join(SHOTS, "suggest-reference-source-es.png") });
  const similar = await api(`/api/projects/${main.id}/brdps/${(await api(`/api/projects/${main.id}/brdps`, {}, token))[0].id}/similar?kind=definition`, {}, token);
  const fromOther = similar.candidates.find((c) => c.source_type === "records");
  assert(fromOther && fromOther.source === `Records: AACF3 otro ${suffix}` && fromOther.source_project === `AACF3 otro ${suffix}`, "the API keeps the English source next to source_type / source_project");
} finally {
  await browser.close();
  for (const id of created) await api(`/api/projects/${id}?permanent=true`, { method: "DELETE" }, token).catch(() => {});
  await api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ preferred_language: previousLanguage ?? null }) }, token).catch(() => {});
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
