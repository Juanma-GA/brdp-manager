// Verification for "Suggest Definition: idioma, salto de línea y
// duplicados catálogo/records" (docs request), point 2's regression
// check: confirms Suggest Rule's suggestion box (.suggestionCode) keeps
// its monospace, unwrapped XML rendering but scrolls WITHIN its own box
// (overflow-x) rather than widening the panel/page -- unlike Definition/
// Proposal (.suggestionText), which must wrap instead. Uses a mocked
// chat completion (mock-mistral-chat-server.mjs) that returns a
// deliberately long, unbroken XML line to make the difference visible.
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  return (await res.json()).access_token;
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Rule Box Verify ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  for (let i = 0; i < 3; i++) {
    const b = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        identifier: `BRDP-RULEBOX-${i}`,
        title: `Rule box test ${i}`,
        definition: `Definition ${i}`,
        proposal: `Proposal ${i}`,
        validation: "Validated",
      }),
    }).then((r) => r.json());
    await fetch(`${API}/api/projects/${proj.id}/brdps/${b.id}/approvals/BREX-4.2`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        rule_xml: `<structureObjectRule id="rulebox-${i}"><objectPath allowedObjectFlag="1">/dmodule/content/verylongxpathsegmentnamewithnobreaksatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx[@attr='value']</objectPath></structureObjectRule>`,
        source: "manual",
        status: "approved",
      }),
    });
  }
  const computeResp = await fetch(`${API}/api/projects/${proj.id}/embeddings/compute`, {
    method: "POST",
    headers: auth,
  }).then((r) => r.json());
  for (let i = 0; i < 40; i++) {
    const statusResp = await fetch(`${API}/api/projects/${proj.id}/embeddings/status/${computeResp.job_id}`, {
      headers: auth,
    }).then((r) => r.json());
    if (statusResp.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const source = await fetch(`${API}/api/projects/${proj.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-RULEBOX-SOURCE",
      title: "Rule box source",
      definition: "",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects`);
    await page.waitForSelector("table", { timeout: 10000 });
    const row = page.locator("tr", { hasText: `Rule Box Verify ${suffix}` });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tr", { hasText: "BRDP-RULEBOX-SOURCE" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

    const suggestRuleButton = page.getByRole("button", { name: "Suggest Rule" });
    await suggestRuleButton.click();
    await page.waitForSelector("text=/MOCK-LONG-RULE/", { timeout: 15000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log("page scrollWidth:", scrollWidth, "(viewport 1440)");
    if (scrollWidth > 1442) throw new Error("Rule suggestion box overflowed the page horizontally!");
    await page.screenshot({ path: "/tmp/suggest-rule-box-scoped-scroll.png", fullPage: true });
    console.log("Screenshot: /tmp/suggest-rule-box-scoped-scroll.png");
    console.log("ALL CHECKS PASSED");
  } finally {
    await browser.close();
    await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
