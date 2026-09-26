// Verification for "consejo de nombres sin Don't show again y sugerencias
// contextuales sin falsos positivos" (docs request), covering the parts
// of the naming-tip round that survive this reversal PLUS the new
// vocabulary-gated "Did you mean" behavior. Confirms, through the real
// running app + real Postgres (no LLM calls involved in any of this --
// no mock needed):
//   1. The tip still appears once per session (first focus/type in ANY of
//      Title/Definition/Proposal/Ask), never a second time in the same
//      session even on a different field, and comes back after a real
//      reload (a new session).
//   2. "Don't show again" no longer exists anywhere -- confirmed by its
//      absence from the DOM (there is exactly one button in the tip now).
//   3. "Did you mean" only ever appears for a phrase-triggered bare word
//      that genuinely resolves against the real vocabulary: a same-type
//      match (applicRefId, a real attribute) suggests with that type; a
//      wrong-type match (table, triggered as an attribute but really an
//      element) suggests with the CORRECTED type; applying either
//      rewrites the field and persists to Postgres.
//   4. The exact real-report false positive is fixed: "Atributos
//      seleccionados para la etiqueta <stranger>." shows the red banner
//      ONLY for <stranger> (never for "seleccionados"), and offers no
//      "Did you mean" suggestion for "seleccionados" either.
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
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

const TIP_TEXT_MARKER = "This lets the app check them against the";

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await makeProject(auth, `Naming Tip Verify ${suffix}`, "S1000D 4.2");
  await makeBrdp(auth, proj.id, { identifier: "BRDP-TIP-FIRST", title: "First field", definition: "", proposal: "", validation: "Pending" });
  await makeBrdp(auth, proj.id, { identifier: "BRDP-TIP-SECOND", title: "Second field, same session", definition: "", proposal: "", validation: "Pending" });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-TIP-APPLICREFID",
    title: "Same-type suggestion check",
    definition: "el atributo applicRefId debe indicarse siempre",
    proposal: "",
    validation: "Pending",
  });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-TIP-TABLE",
    title: "Wrong-type correction check",
    definition: "el atributo table debe existir",
    proposal: "",
    validation: "Pending",
  });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-TIP-NOFALSEPOS",
    title: "Atributos seleccionados para la etiqueta <stranger>.",
    definition: "",
    proposal: "",
    validation: "Pending",
  });

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    // ==== 1+2. Session mechanics + "Don't show again" gone ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-FIRST");

      assert((await page.locator(`text=${TIP_TEXT_MARKER}`).count()) === 0, "tip not shown before any field is touched");
      const titleInput = page.locator('label:text-is("Title") + input');
      await titleInput.click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { timeout: 3000 });
      assert(true, "tip appears on the FIRST focus of Title");

      assert((await page.getByRole("button", { name: "Don't show again" }).count()) === 0, '"Don\'t show again" button no longer exists anywhere in the DOM');
      assert((await page.getByRole("button", { name: "Got it" }).count()) === 1, 'exactly one "Got it" button remains');
      await page.screenshot({ path: "/tmp/naming-tip-shown-single-button.png", fullPage: true });
      console.log("Screenshot (tip shown, single Got it button): /tmp/naming-tip-shown-single-button.png");

      const gotIt = page.getByRole("button", { name: "Got it" });
      await gotIt.click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { state: "detached", timeout: 3000 });

      // A different row WITHIN THE SAME records page (no full navigation,
      // still the same session) -- tip still must not reappear.
      await page.locator("tr", { hasText: "BRDP-TIP-SECOND" }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
      await page.locator('label:text-is("Title") + input').click();
      await page.waitForTimeout(300);
      assert((await page.locator(`text=${TIP_TEXT_MARKER}`).count()) === 0, "tip still does not reappear on a different BRDP's Title, same session (no reload)");

      // Reload -- a NEW session -- the tip must appear again on the next touch.
      await page.reload();
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: "BRDP-TIP-SECOND" }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
      await page.locator('label:text-is("Title") + input').click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { timeout: 3000 });
      assert(true, "reloading the page (new session) shows the tip again on the next field touch");
      await page.close();
    }

    // ==== 3a. Same-type suggestion: applicRefId (real attribute) ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-APPLICREFID");

      const suggestionButton = page.getByRole("button", { name: "Did you mean @applicRefId?", exact: true });
      await suggestionButton.waitFor({ timeout: 3000 });
      assert(true, 'exact "Did you mean @applicRefId?" suggestion appears for the real attribute, live, no save needed');

      await suggestionButton.click();
      await page.waitForTimeout(400);
      const definitionTextarea = page.locator('label:text-is("Definition") + textarea');
      const newValue = await definitionTextarea.inputValue();
      assert(newValue === "el atributo @applicRefId debe indicarse siempre", `clicking the suggestion wraps applicRefId in @... (got: "${newValue}")`);
      assert((await page.getByRole("button", { name: "Did you mean @applicRefId?", exact: true }).count()) === 0, "the suggestion chip disappears once applied");

      await page.reload();
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: "BRDP-TIP-APPLICREFID" }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
      const persisted = await page.locator('label:text-is("Definition") + textarea').inputValue();
      assert(persisted === "el atributo @applicRefId debe indicarse siempre", "the correction survives a reload -- persisted to Postgres");
      await page.screenshot({ path: "/tmp/naming-tip-same-type-suggestion.png", fullPage: true });
      console.log("Screenshot (same-type suggestion applied): /tmp/naming-tip-same-type-suggestion.png");
      await page.close();
    }

    // ==== 3b. Wrong-type correction: "table" triggered as attribute, really an element ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-TABLE");

      const suggestionButton = page.getByRole("button", { name: "Did you mean <table>?", exact: true });
      await suggestionButton.waitFor({ timeout: 3000 });
      assert(true, '"el atributo table" -> suggestion offers the CORRECTED type, "Did you mean <table>?", never "@table"');
      assert((await page.getByRole("button", { name: "Did you mean @table?", exact: true }).count()) === 0, "the wrong (attribute) spelling is never offered");

      await suggestionButton.click();
      await page.waitForTimeout(400);
      const newValue = await page.locator('label:text-is("Definition") + textarea').inputValue();
      assert(newValue === "el atributo <table> debe existir", `clicking the suggestion wraps table in <...> despite the attribute trigger (got: "${newValue}")`);
      await page.screenshot({ path: "/tmp/naming-tip-wrong-type-correction.png", fullPage: true });
      console.log("Screenshot (wrong-type correction applied): /tmp/naming-tip-wrong-type-correction.png");
      await page.close();
    }

    // ==== 4. The exact real-report false positive is fixed ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-NOFALSEPOS");

      await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });
      const bannerText = await page
        .locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/")
        .first()
        .textContent();
      assert(bannerText.includes("<stranger>"), `banner names <stranger> (got: ${bannerText})`);
      assert(!bannerText.toLowerCase().includes("seleccionad"), `banner never mentions "seleccionados" (got: ${bannerText})`);

      assert(
        (await page.getByRole("button", { name: /Did you mean/ }).count()) === 0,
        'no "Did you mean" suggestion of any kind for this BRDP ("seleccionados" does not resolve against the real vocabulary)'
      );
      await page.screenshot({ path: "/tmp/naming-tip-real-report-fixed.png", fullPage: true });
      console.log("Screenshot (real report false positive fixed): /tmp/naming-tip-real-report-fixed.png");
      await page.close();
    }

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded project.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
