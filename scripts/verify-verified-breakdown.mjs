// Live verification for AACF 2, Part 2 (d): the second line of BRDP
// Records' header -- how the verified rules are tested -- against the real
// app (Vite + FastAPI + Postgres), no AI. The tests are recorded through
// the real endpoint (POST .../approvals/{format}/test), as the panel does.
//
//   - The categories add up to the verified count; "Tested ✓" always
//     shows, the others only when not zero; no line for S1000D 5.0.
//   - Each rule's indicator shows the category it is counted in.
//   - Clicking a category filters the table to those rules, the filter is
//     marked and removable, and it coexists with the other filters.
//   - A rule that leaves the filtered category (its rule edited ->
//     outdated) leaves the table; with none left the table is empty and
//     the filter stays.
//   - A stats load that fails is said, with Retry.
//
//     node scripts/verify-verified-breakdown.mjs
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || "AdminTest123!";
const SHOTS = process.env.SHOTS_DIR || "/tmp";

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const rule = (n) => `<structureObjectRule id="R${n}"><objectPath allowedObjectFlag="0">//x${n}</objectPath><objectUse>Rule ${n}.</objectUse></structureObjectRule>`;

// identifier -> recorded result (null = never tested), plus Draft ones.
const PLAN = [
  ["BRDP-VB-P1", "passed"],
  ["BRDP-VB-P2", "passed"],
  ["BRDP-VB-P3", "passed"],
  ["BRDP-VB-N1", null],
  ["BRDP-VB-N2", null],
  ["BRDP-VB-R1", "review"],
  ["BRDP-VB-F1", "failed"],
  ["BRDP-VB-O1", "passed"], // made outdated below
];

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const auth = { Authorization: `Bearer ${login.access_token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF2 breakdown ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  const noFormat = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `AACF2 breakdown 5.0 ${suffix}`, standard: "S1000D 5.0" }) }).then((r) => r.json());
  const ids = {};
  let n = 0;
  for (const [identifier, result] of PLAN) {
    n += 1;
    const brdp = await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier, title: identifier }) }).then((r) => r.json());
    ids[identifier] = brdp.id;
    const xml = rule(n);
    await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: xml, status: "approved", source: "manual" }) });
    if (result) {
      const reason = result === "passed" ? null : { code: result === "review" ? "test_proposal_mismatch" : "test_incorrect", params: result === "review" ? { mismatch: "x" } : { permissive: true, strict: false } };
      const res = await api(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/BREX-4.2/test`, { method: "POST", body: JSON.stringify({ result, reason, rule_hash: sha(xml) }) });
      if (!res.ok) throw new Error(`recording ${identifier}: ${res.status} ${await res.text()}`);
    }
  }
  // Outdated: the rule changed after its test.
  await api(`/api/projects/${project.id}/brdps/${ids["BRDP-VB-O1"]}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: rule(99), status: "approved", source: "manual" }) });
  // A Draft rule with a passed test: never counted among the verified.
  const draft = await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ identifier: "BRDP-VB-D1", title: "Draft" }) }).then((r) => r.json());
  await api(`/api/projects/${project.id}/brdps/${draft.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: rule(50), status: "pending_review", source: "manual" }) });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const line = () => page.getByTestId("verified-breakdown");
  const rows = () => page.locator("tbody tr");

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 10000 });
    await line().waitFor({ timeout: 10000 });

    console.log("1. The line adds up to the verified count");
    const text = (await line().textContent()).replace(/\s+/g, " ").trim();
    console.log(`     "${text}"`);
    assert(text.startsWith("Of 8 verified:"), "Of 8 verified (the Draft one is not counted)");
    assert(/3 tested ✓/.test(text) && /2 not tested/.test(text) && /1 to review/.test(text) && /1 test failed/.test(text) && /1 test outdated/.test(text), "each category with its count");
    assert(!/inconclusive|not executable/.test(text), "categories at zero are not shown");
    const numbers = [...text.matchAll(/(\d+) (tested|not tested|to review|tests? failed|tests? outdated)/g)].map((m) => Number(m[1]));
    assert(numbers.reduce((a, b) => a + b, 0) === 8, `they add up to 8 (${numbers.join(" + ")})`);
    await page.screenshot({ path: `${SHOTS}/records-verified-breakdown.png` });

    console.log("2. Each rule's indicator shows its category");
    for (const [identifier, expected] of [["BRDP-VB-P1", "passed"], ["BRDP-VB-N1", "not_tested"], ["BRDP-VB-R1", "review"], ["BRDP-VB-F1", "failed"], ["BRDP-VB-O1", "outdated"]]) {
      await page.locator("tbody tr", { hasText: identifier }).click();
      await page.getByTestId("rule-test-indicator").waitFor({ timeout: 5000 });
      const state = await page.getByTestId("rule-test-indicator").getAttribute("data-state");
      assert(state === expected, `${identifier}: ${state}`);
    }

    console.log("3. Clicking a category filters the table");
    await page.getByTestId("verified-breakdown-not_tested").click();
    await page.getByTestId("verified-breakdown-filter").waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2, null, { timeout: 5000 });
    const shown = await rows().allTextContents();
    assert(shown.some((t) => t.includes("BRDP-VB-N1")) && shown.some((t) => t.includes("BRDP-VB-N2")), "Not tested: the two rules never tested");
    assert((await page.getByTestId("verified-breakdown-not_tested").getAttribute("aria-pressed")) === "true", "the active category is marked");
    assert(/Verified rules: Not tested/.test(await page.getByTestId("verified-breakdown-filter").textContent()), "and named, with a way to remove it");
    await page.screenshot({ path: `${SHOTS}/records-verified-breakdown-filter.png` });
    await page.getByTestId("verified-breakdown-passed").click();
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 3, null, { timeout: 5000 });
    assert(true, "Tested ✓: the three passed rules");
    // Coexists with the other filters (AND): Proposal Status = Validated.
    await page.locator("thead select").first().selectOption("Validated");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr td").length <= 1, null, { timeout: 5000 });
    assert((await page.getByTestId("verified-breakdown-filter").count()) === 1, "with another filter: nothing matches both, the category filter stays");
    await page.locator("thead select").first().selectOption("");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 3, null, { timeout: 5000 });

    console.log("4. The last rule of the category changes");
    await page.getByTestId("verified-breakdown-review").click();
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1, null, { timeout: 5000 });
    await rows().first().click();
    // Edit the rule: its test becomes outdated (through the API, as a save would).
    await api(`/api/projects/${project.id}/brdps/${ids["BRDP-VB-R1"]}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: rule(77), status: "approved", source: "manual" }) });
    // Revoke + Verify again through the page refreshes the counts like any rule action.
    await page.getByRole("button", { name: /Revoke/ }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="verified-breakdown-review"]'), null, { timeout: 10000 });
    await page.waitForFunction(() => [...document.querySelectorAll("tbody tr")].every((r) => !r.textContent.includes("BRDP-VB-R1")), null, { timeout: 10000 });
    assert((await page.getByTestId("verified-breakdown-filter").count()) === 1, "the table is empty and the filter is still there");
    await page.getByTestId("verified-breakdown-clear").click();
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 9, null, { timeout: 5000 });
    assert((await page.getByTestId("verified-breakdown-filter").count()) === 0, "removed: all rows back");
    const after = (await line().textContent()).replace(/\s+/g, " ");
    assert(after.startsWith("Of 7 verified:"), `the counts follow (${after.trim()})`);

    console.log("5. Spanish");
    await page.locator("header select, nav select").first().selectOption("es");
    const es = (await line().textContent()).replace(/\s+/g, " ").trim();
    console.log(`     "${es}"`);
    assert(es.startsWith("De 7 verificadas:") && /3 probadas ✓/.test(es) && /2 sin probar/.test(es) && /1 desactualizada/.test(es), "De 7 verificadas: 3 probadas ✓ · 2 sin probar · …");
    await page.locator("header select, nav select").first().selectOption("en");

    console.log("6. No rule format: no line; a stats load that fails is said");
    await page.goto(`${BASE_URL}/projects/${noFormat.id}/records`);
    await page.waitForSelector("h1", { timeout: 10000 });
    await page.waitForTimeout(1500);
    assert((await line().count()) === 0, "S1000D 5.0: no breakdown line");
    await page.route(`**/api/projects/${project.id}/brdps/stats`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: { code: "internal_error", ref: "beef0001" } }) }));
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.getByTestId("records-notice-stats").waitFor({ timeout: 10000 });
    assert((await line().count()) === 0, "a failed load: no stale line, the notice with Retry");
    await page.unroute(`**/api/projects/${project.id}/brdps/stats`);
    await page.getByTestId("records-notice-stats-retry").click();
    await line().waitFor({ timeout: 5000 });
    assert(true, "Retry: the line is back");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
    await api(`/api/projects/${noFormat.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
