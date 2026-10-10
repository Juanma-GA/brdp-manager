// Verification for "Did you mean con marcado a medias y listas de padres
// cortadas" round, Part 1: half-typed bracket markup ("<table" with no
// closing ">", "table>" with no opening "<") is now offered a "Did you
// mean <table>?" completion WITHOUT needing any trigger word
// ("elemento"/"atributo"/etc.) -- and a half-typed name that does NOT
// exist in the real schema (<pokemon) still gets the same red "not
// found" banner a complete <pokemon> tag would, because the intent to
// mark up an element is just as explicit either way. Real backend, real
// Postgres, no LLM call involved in any of this (the vocabulary check is
// 100% deterministic, no mock needed).
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  return (await res.json()).access_token;
}

async function makeProject(auth, name, standard) {
  return fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, standard }),
  }).then((r) => r.json());
}
async function makeBrdp(auth, projectId, body) {
  return fetch(`${API}/api/projects/${projectId}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function login(page) {
  await page.goto(BASE_URL);
  await page.fill("#login-email", ADMIN_EMAIL);
  await page.fill("#login-password", ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector("table", { timeout: 10000 });
  await page.locator("header select, nav select").first().selectOption("en");
  await page.waitForTimeout(300);
}

async function openRecords(page, projectName, brdpIdentifier) {
  await page.goto(`${BASE_URL}/projects`);
  await page.waitForSelector("table", { timeout: 10000 });
  const row = page.locator("tr", { hasText: projectName });
  await row.getByRole("button", { name: /Records/i }).click();
  await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
  await page.waitForSelector("tbody tr", { timeout: 20000 });
  await page.locator("tr", { hasText: brdpIdentifier }).click();
  await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await makeProject(auth, `Dangling Markup Verify ${suffix}`, "S1000D 4.2");
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-DANGLE-OPEN",
    title: "Title above the <table",
    definition: "",
    proposal: "",
    validation: "Pending",
  });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-DANGLE-CLOSE",
    title: "Content above the table>",
    definition: "",
    proposal: "",
    validation: "Pending",
  });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-DANGLE-UNKNOWN",
    title: "Content above the <pokemon",
    definition: "",
    proposal: "",
    validation: "Pending",
  });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-DANGLE-NOFALSEPOS",
    title: "if a < b then x<5 else -> nothing",
    definition: "",
    proposal: "",
    validation: "Pending",
  });

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  try {
    // ==== 1. Dangling OPEN ("<table", no closing ">") -- no trigger word
    // anywhere in the title -- must still offer "Did you mean <table>?" ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Dangling Markup Verify ${suffix}`, "BRDP-DANGLE-OPEN");

      const suggestionButton = page.getByRole("button", { name: "Did you mean <table>?", exact: true });
      await suggestionButton.waitFor({ timeout: 3000 });
      assert(true, 'a half-typed "<table" with NO trigger word ("elemento"/"element"/etc.) still offers "Did you mean <table>?"');
      assert((await page.locator("text=/mentions names not found/").count()) === 0, "a resolvable dangling name never triggers the red 'not found' banner");

      await page.screenshot({ path: shot("dangling-markup-open-suggestion.png"), fullPage: true });
      console.log(`Screenshot (dangling open, suggestion visible): ${shot("dangling-markup-open-suggestion.png")}`);

      await suggestionButton.click();
      await page.waitForTimeout(400);
      const titleInput = page.locator('label:text-is("Title") + input');
      const newValue = await titleInput.inputValue();
      assert(newValue === "Title above the <table>", `clicking the suggestion closes the bracket, adding only ">" (got: "${newValue}")`);
      assert((await page.getByRole("button", { name: "Did you mean <table>?", exact: true }).count()) === 0, "the suggestion chip disappears once applied");

      await page.reload();
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: "BRDP-DANGLE-OPEN" }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
      const persisted = await page.locator('label:text-is("Title") + input').inputValue();
      assert(persisted === "Title above the <table>", "the completed markup survives a reload -- persisted to Postgres");
      await page.close();
    }

    // ==== 2. Dangling CLOSE ("table>", no opening "<") -- same completion ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Dangling Markup Verify ${suffix}`, "BRDP-DANGLE-CLOSE");

      const suggestionButton = page.getByRole("button", { name: "Did you mean <table>?", exact: true });
      await suggestionButton.waitFor({ timeout: 3000 });
      assert(true, 'a half-typed "table>" with no opening "<" also offers "Did you mean <table>?"');

      await suggestionButton.click();
      await page.waitForTimeout(400);
      const newValue = await page.locator('label:text-is("Title") + input').inputValue();
      assert(newValue === "Content above the <table>", `clicking the suggestion adds only the missing "<" (got: "${newValue}")`);
      await page.close();
    }

    // ==== 3. Dangling but NOT in the vocabulary ("<pokemon") -- same red
    // banner a complete <pokemon> tag would get, and NO completion offered
    // (there's nothing real to complete it to). ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Dangling Markup Verify ${suffix}`, "BRDP-DANGLE-UNKNOWN");

      await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });
      const bannerText = await page
        .locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/")
        .first()
        .textContent();
      assert(bannerText.includes("<pokemon>"), `the red banner names <pokemon> even though the markup was never closed (got: ${bannerText})`);
      assert((await page.getByRole("button", { name: /Did you mean/ }).count()) === 0, 'no "Did you mean" completion is offered for a name that does not exist -- nothing real to complete it to');
      await page.screenshot({ path: shot("dangling-markup-unknown-banner.png"), fullPage: true });
      console.log(`Screenshot (dangling, unresolvable, red banner only): ${shot("dangling-markup-unknown-banner.png")}`);
      await page.close();
    }

    // ==== 4. Never confused with a plain comparison/arrow ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Dangling Markup Verify ${suffix}`, "BRDP-DANGLE-NOFALSEPOS");
      await page.waitForTimeout(500);
      assert((await page.getByRole("button", { name: /Did you mean/ }).count()) === 0, '"a < b"/"x<5"/"->" never produce any "Did you mean" suggestion');
      assert((await page.locator("text=/mentions names not found/").count()) === 0, '"a < b"/"x<5"/"->" never trigger the red "not found" banner either');
      await page.close();
    }

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    await fetch(`${API}/api/projects/${proj.id}?permanent=true`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded project.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
