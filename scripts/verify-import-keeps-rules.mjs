// Live verification of "La importación no toca una regla que no cambia"
// against the real app (Vite + FastAPI + Postgres); no LLM involved.
//
// A S1000D 3.0.1 project with three tested rules (one stored with CRLF line
// breaks, as a rule pasted through the API can be). The file is the
// project's own export, with: the Proposal of KR-1 changed, the rule of KR-2
// re-indented, and the rule of KR-3 really changed. Checks:
//   - the preview says "Rules: 1 changes · 2 kept as stored, with their tests";
//   - after Apply, KR-1 and KR-2 keep "Tested ✓" and every rule_approvals
//     field; KR-1's approved test warns that the Proposal changed since;
//   - KR-3 shows "Test outdated" and still has its approved test.
//
// Preconditions: uvicorn on 8000, Vite on 5173. Cleans up its project.
//
//     node scripts/verify-import-keeps-rules.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const FORMAT = "BREX-3.0.1";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const rule = (id, path) => `<objrule id="${id}">\r\n  <objpath objappl="0">${path}</objpath>\r\n  <objuse>No ${path}.</objuse>\r\n</objrule>`;

function passedTest(proposal) {
  const doc = (inner) => `<dmodule><content><descript><para0><para>${inner}</para></para0></descript></content></dmodule>`;
  return {
    proposal,
    examples: [
      { label: "Plain", expected: "accept", schema: "descript", xml: doc("Plain."), skeleton_node_paths: [], result: "accepted", matches: true },
      { label: "Bad", expected: "reject", schema: "descript", xml: doc("<emphasis>X</emphasis>"), skeleton_node_paths: [], result: "rejected", matches: true },
    ],
  };
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
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Keep rules ${suffix}`, standard: "S1000D 3.0.1" }) }).then((r) => r.json());

  const ids = { "BRDP-KR-1": "//emphasis", "BRDP-KR-2": "//acronym", "BRDP-KR-3": "//randlist" };
  const brdps = {};
  for (const [identifier, xpath] of Object.entries(ids)) {
    const proposal = `No ${xpath} in the text.`;
    const b = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title: `Title ${identifier}`, definition: "Definition.", proposal, validation: "Validated" }),
    }).then((r) => r.json());
    brdps[identifier] = b;
    const url = `/api/projects/${project.id}/brdps/${b.id}/approvals/${FORMAT}`;
    const xml = rule(identifier, xpath);
    let r = await api(url, { method: "PUT", body: JSON.stringify({ rule_xml: xml, source: "llm", status: "approved" }) });
    if (!r.ok) throw new Error(`seeding rule: ${r.status} ${await r.text()}`);
    r = await api(`${url}/test`, { method: "POST", body: JSON.stringify({ result: "passed", rule_hash: sha(xml), passed_test: passedTest(proposal) }) });
    if (!r.ok) throw new Error(`seeding test: ${r.status} ${await r.text()}`);
  }
  const approvalsOf = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(brdps).map(async ([identifier, b]) => [identifier, await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/${FORMAT}`).then((r) => r.json())]),
      ),
    );
  const before = await approvalsOf();

  // The project's export, edited as Juanma would in Excel.
  const exportRows = Object.entries(ids).map(([identifier, xpath]) => ({
    id: identifier,
    title: `Title ${identifier}`,
    definition: "Definition.",
    proposal: identifier === "BRDP-KR-1" ? "A new Proposal, written after the test." : `No ${xpath} in the text.`,
    proposalStatus: "Validated",
    ruleStatus: "Verified",
    rule:
      identifier === "BRDP-KR-2"
        ? rule(identifier, xpath).replace(/\r\n\s*/g, "\n        ")
        : identifier === "BRDP-KR-3"
          ? rule(identifier, `${xpath}[@listitemprefix]`)
          : before[identifier].rule_xml,
    catalogEdition: "",
  }));
  const xlsx = await api(`/api/projects/${project.id}/export.xlsx`, { method: "POST", body: JSON.stringify({ rows: exportRows }) });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keep-rules-")), "export.xlsx");
  fs.writeFileSync(file, Buffer.from(await xlsx.arrayBuffer()));

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");

    await page.goto(`${BASE_URL}/projects/${project.id}/config`);
    await page.waitForSelector('input[type="file"][accept=".xlsx"]', { state: "attached", timeout: 10000 });
    await page.locator('input[type="file"][accept=".xlsx"]').setInputFiles(file);
    const summary = page.getByTestId("import-rule-summary");
    await summary.waitFor({ timeout: 30000 });
    const text = (await summary.textContent()).trim();
    assert(text === "Rules: 1 changes · 2 kept as stored, with their tests", `preview: "${text}"`);
    await page.screenshot({ path: shot("import-keeps-rules-preview.png"), fullPage: true });
    await page.locator("header select, nav select").first().selectOption("es");
    const textEs = (await summary.textContent()).trim();
    assert(textEs === "Reglas: 1 cambia · 2 se conservan tal cual, con su prueba", `preview ES: "${textEs}"`);
    await page.locator("header select, nav select").first().selectOption("en");

    await page.click('button:has-text("Apply import")');
    await page.waitForSelector("text=Import complete", { timeout: 60000 });

    const after = await approvalsOf();
    const fields = ["rule_xml", "source", "status", "approved_at", "last_test_result", "last_test_at", "last_test_rule_hash", "last_passed_test"];
    for (const identifier of ["BRDP-KR-1", "BRDP-KR-2"]) {
      const same = fields.every((f) => JSON.stringify(after[identifier][f]) === JSON.stringify(before[identifier][f]));
      assert(same, `${identifier}: rule row untouched (text with its CRLF, source "llm", approved_at, test)`);
    }
    assert(after["BRDP-KR-3"].rule_xml.includes("[@listitemprefix]"), "KR-3: the new rule is saved");
    assert(after["BRDP-KR-3"].last_test_rule_hash === before["BRDP-KR-3"].last_test_rule_hash && after["BRDP-KR-3"].last_passed_test, "KR-3: the test is kept");

    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    const select = async (identifier) => {
      await page.locator("tbody tr", { hasText: identifier }).first().click();
      await page.getByTestId("rule-test-indicator").waitFor({ timeout: 10000 });
    };
    await select("BRDP-KR-1");
    const ind1 = await page.getByTestId("rule-test-indicator").textContent();
    assert(ind1.startsWith("Tested ✓"), `KR-1 indicator: ${ind1}`);
    await page.getByRole("button", { name: /See approved test/ }).click();
    const warn = page.getByTestId("saved-rule-test-proposal-changed");
    await warn.waitFor({ timeout: 5000 });
    assert((await warn.textContent()).includes("The Proposal has changed since"), "KR-1: the approved test warns the Proposal changed");
    await page.screenshot({ path: shot("import-keeps-rules-proposal-changed.png"), fullPage: true });

    await select("BRDP-KR-2");
    const ind2 = await page.getByTestId("rule-test-indicator").textContent();
    assert(ind2.startsWith("Tested ✓"), `KR-2 indicator (re-indented in the file): ${ind2}`);

    await select("BRDP-KR-3");
    const ind3 = await page.getByTestId("rule-test-indicator").textContent();
    assert(ind3.includes("Test outdated"), `KR-3 indicator: ${ind3}`);
    assert((await page.getByRole("button", { name: /See approved test/ }).count()) === 1, "KR-3: its approved test is still there");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
