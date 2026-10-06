// Live verification for "Remates de Mejoras B" against the real app
// (Vite + FastAPI + Postgres); only the Mistral TRANSPORT is mocked
// (mock-mistral-chat-server.mjs):
//   Part 1 -- a rule whose path is a condition (//emphasis and
//             //randomList, flag 0): the reject example has an <emphasis>
//             and no random list (case b). It never goes to the
//             correction round, the verdict is failed, and the cause says
//             which names the example contains and that the condition is
//             false in it, EN/ES.
//   Part 2 -- AI Extract, "Show" filter and the counts line: the
//             other-edition class is always told apart from "From
//             catalog" -- one edition ("From catalog (S1000D 4.1)"),
//             several ("From catalog (another edition)") and none (the
//             same generic name), EN/ES.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Seeds and removes its own catalog rows
// (backend/scripts/seed_remates_b_catalog.py) and deletes the projects it
// creates. Screenshots go to the system temp directory.
//
//     node scripts/verify-remates-b.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { backendPython, pythonEnv } from "./lib/backendPython.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const shot = (name) => path.join(os.tmpdir(), name);

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const seed = (arg) => execFileSync(backendPython(), [path.join("scripts", "seed_remates_b_catalog.py"), ...(arg ? [arg] : [])], { cwd: path.join(ROOT, "backend"), encoding: "utf8", env: pythonEnv() });

// A BREX 4.2 whose rules carry the given identifiers (one rule each).
function brexFile(name, ids) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(
    file,
    '<?xml version="1.0"?><dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd"><identAndStatusSection/><content><brex><contextRules><structureObjectRuleGroup>' +
      ids
        .map((id, i) => `<structureObjectRule id="${id}"><brDecisionRef brDecisionIdentNumber="${id}"/><objectPath allowedObjectFlag="0">//elem${i}</objectPath><objectUse>${id}. Element ${i} shall not be used.</objectUse></structureObjectRule>`)
        .join("") +
      "</structureObjectRuleGroup></contextRules></brex></content></dmodule>"
  );
  return file;
}
const ONE_EDITION = brexFile("remates-b-one-edition.xml", ["BRDP-S1-99001", "BRDP-S1-99003"]);
const TWO_EDITIONS = brexFile("remates-b-two-editions.xml", ["BRDP-S1-99001", "BRDP-S1-99002", "BRDP-S1-99003"]);
const NO_EDITION = brexFile("remates-b-no-edition.xml", ["BRDP-EXT-00001", "BRDP-S1-99003"]);

const CONDITION_RULE = '<structureObjectRule id="BRDP-RB-COND"><objectPath allowedObjectFlag="0">//emphasis and //randomList</objectPath><objectUse>No emphasis in a document with random lists.</objectUse></structureObjectRule>';

async function main() {
  seed();
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const projects = [];
  const newProject = async (name) => {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
    projects.push(p);
    return p;
  };

  const ruleProject = await newProject("Remates B rule");
  const brdp = await api(`/api/projects/${ruleProject.id}/brdps`, {
    method: "POST",
    body: JSON.stringify({ identifier: "BRDP-RB-COND", title: "Emphasis", definition: "Decide whether emphasis is used.", proposal: "Emphasis shall not be used.", validation: "Validated" }),
  }).then((r) => r.json());
  const put = await api(`/api/projects/${ruleProject.id}/brdps/${brdp.id}/approvals/BREX-4.2`, {
    method: "PUT",
    body: JSON.stringify({ rule_xml: CONDITION_RULE, source: "manual", status: "pending_review" }),
  });
  if (!put.ok) throw new Error(`seeding the rule failed: ${put.status} ${await put.text()}`);
  const extractProject = await newProject("Remates B extract");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const llmCalls = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy") && req.method() === "POST") {
      try {
        const body = JSON.parse(req.postData() || "{}");
        const messages = body.payload?.messages || [];
        llmCalls.push([...messages].reverse().find((m) => m.role === "user")?.content || "");
      } catch {
        llmCalls.push("");
      }
    }
  });
  const language = async (lng) => {
    await page.locator("header select, nav select").first().selectOption(lng);
    await page.waitForTimeout(400);
  };

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");

    // ---- Part 1: condition rule, case b ----
    await page.goto(`${BASE_URL}/projects/${ruleProject.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tbody tr", { hasText: "BRDP-RB-COND" }).first().click();
    await page.waitForTimeout(600);
    llmCalls.length = 0;
    await page.getByRole("button", { name: "Test rule" }).click();
    const verdict = page.getByTestId("rule-test-verdict");
    await verdict.waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    const corrections = llmCalls.filter((m) => m.startsWith("Some examples are not valid."));
    assert(corrections.length === 0, `condition case b: no correction round (${llmCalls.length} LLM call(s))`);
    assert((await verdict.textContent()).startsWith("The rule accepted an example meant to violate it."), `condition case b: failed verdict (${await verdict.textContent()})`);
    const skipped = page.getByTestId("rule-test-predicate-skipped");
    assert((await skipped.count()) === 1 && (await skipped.textContent()).startsWith("1 example meant to be rejected was not sent to the automatic correction"), "condition case b: counted with the examples kept out of the correction");
    const cause = page.getByTestId("rule-test-accept-cause").first();
    const causeEn = await cause.textContent();
    assert(causeEn === "Why the rule accepted it: the example contains <emphasis>, and the condition `//emphasis and //randomList` is false in it.", `condition case b: cause EN (${causeEn})`);
    await page.getByTestId("rule-test-panel").screenshot({ path: shot("remates-b-condition-cause-en.png") });
    await language("es");
    const causeEs = await cause.textContent();
    assert(causeEs === "Por qué la regla lo aceptó: el ejemplo contiene <emphasis>, y la condición `//emphasis and //randomList` es falsa en él.", `condition case b: cause ES (${causeEs})`);
    await page.getByTestId("rule-test-panel").screenshot({ path: shot("remates-b-condition-cause-es.png") });
    await language("en");

    // ---- Part 2: "From catalog" classes in the filter and the counts ----
    await page.goto(`${BASE_URL}/projects/${extractProject.id}/config`);
    const upload = async (file) => {
      await page.getByTestId("rule-extract-file").setInputFiles(file);
      await page.getByTestId("rule-extract-counts").waitFor({ timeout: 30000 });
      await page.waitForFunction((name) => document.querySelector('[data-testid="rule-extract-counts"]')?.textContent.includes(name), path.basename(file), { timeout: 30000 });
      await page.waitForTimeout(500);
    };
    const options = async () => page.getByTestId("rule-extract-filter").locator("option").allTextContents();
    const counts = async () => page.getByTestId("rule-extract-counts").textContent();

    await upload(ONE_EDITION);
    let opts = await options();
    let line = await counts();
    assert(opts.includes("From catalog (S1000D 4.1)") && opts.includes("From catalog"), `one edition: filter options (${opts.join(" | ")})`);
    assert(line.includes("From catalog (S1000D 4.1): 1") && line.includes("From catalog: 1"), `one edition: counts line (${line})`);
    await page.getByTestId("rule-extract-review").screenshot({ path: shot("remates-b-one-edition-en.png") });
    await language("es");
    opts = await options();
    line = await counts();
    assert(opts.includes("De catálogo (S1000D 4.1)") && opts.includes("De catálogo"), `one edition ES: filter options (${opts.join(" | ")})`);
    assert(line.includes("De catálogo (S1000D 4.1): 1") && line.includes("De catálogo: 1"), `one edition ES: counts line (${line})`);
    await language("en");

    await upload(TWO_EDITIONS);
    opts = await options();
    line = await counts();
    assert(opts.includes("From catalog (another edition)") && opts.includes("From catalog"), `several editions: filter options (${opts.join(" | ")})`);
    assert(line.includes("From catalog (another edition): 2") && line.includes("From catalog: 1"), `several editions: counts line (${line})`);
    const rowLabels = await page.locator('[data-testid="rule-extract-review"] tbody select').evaluateAll((els) => els.map((e) => e.options[e.selectedIndex].text));
    assert(rowLabels.includes("From catalog (S1000D 4.1)") && rowLabels.includes("From catalog (S1000D 5.0)"), `several editions: each row says its own (${rowLabels.join(" | ")})`);
    await language("es");
    opts = await options();
    line = await counts();
    assert(opts.includes("De catálogo (otra edición)") && line.includes("De catálogo (otra edición): 2"), `several editions ES (${opts.join(" | ")} / ${line})`);
    await page.getByTestId("rule-extract-review").screenshot({ path: shot("remates-b-two-editions-es.png") });
    await language("en");

    await upload(NO_EDITION);
    opts = await options();
    assert(opts.includes("From catalog (another edition)") && opts.includes("From catalog") && new Set(opts).size === opts.length, `no edition rows: the option stays and is told apart (${opts.join(" | ")})`);
    await language("es");
    opts = await options();
    assert(opts.includes("De catálogo (otra edición)") && opts.includes("De catálogo") && new Set(opts).size === opts.length, `no edition rows ES (${opts.join(" | ")})`);
    await language("en");
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" });
    seed("cleanup");
  }
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main().catch((err) => {
  console.error(err);
  try {
    seed("cleanup");
  } catch {
    // ignore
  }
  process.exit(1);
});
