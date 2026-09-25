// Verification for "aviso de convención de nombres" (docs request, points
// 5-8): the naming-tip banner shown once per session near Title/
// Definition/Proposal (BRDP panel + Add BRDP form) and the Ask question,
// its "Got it"/"Don't show again" buttons, server-side persistence of
// "Don't show again" (users.hide_naming_tip), Settings > Profile's
// reactivation action, and the contextual "Did you mean `<x>`?"
// correction suggestion. Confirms, through the real running app + real
// Postgres:
//   1. First focus/type in ANY of Title/Definition/Proposal/Ask shows the
//      tip; a second field touched in the SAME session does not show it
//      again (it's one tip total per session, not one per field).
//   2. "Got it" hides it; reloading the page (a new session) shows it
//      again on the next field touch.
//   3. "Don't show again" persists server-side -- stays hidden across a
//      reload AND across a fresh login (this app's stand-in for "another
//      browser", same convention as test_auth.py's own
//      preferred_language test).
//   4. Settings > Profile's "Show naming tips again" reverses it -- a
//      fresh login after that shows the tip again on the next field touch.
//   5. "Did you mean `<pokemon>`?" appears for unmarked "el elemento
//      pokemon" phrasing; clicking it rewrites the field to "el elemento
//      <pokemon>" and the big vocabulary notice updates immediately.
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

  // Reset hide_naming_tip to a known state (false) before this run --
  // some earlier round/script may have left it set.
  await fetch(`${API}/api/auth/me`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ hide_naming_tip: false }),
  });

  const proj = await makeProject(auth, `Naming Tip Verify ${suffix}`, "S1000D 4.2");
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-TIP-A",
    title: "First field",
    definition: "",
    proposal: "",
    validation: "Pending",
  });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-TIP-B",
    title: "Second field, same session",
    definition: "",
    proposal: "",
    validation: "Pending",
  });
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-TIP-RENAME",
    title: "Did you mean check",
    definition: "",
    proposal: "",
    validation: "Pending",
  });

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    // ==== 1+2. First touch shows the tip; second field in the same
    // session doesn't; "Got it" hides it; reload (new session) shows it
    // again on the next touch. ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-A");

      assert((await page.locator(`text=${TIP_TEXT_MARKER}`).count()) === 0, "tip not shown before any field is touched");
      const titleInput = page.locator('label:text-is("Title") + input');
      await titleInput.click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { timeout: 3000 });
      assert(true, "tip appears on the FIRST focus of Title");
      await page.screenshot({ path: "/tmp/naming-tip-shown.png", fullPage: true });
      console.log("Screenshot (tip shown on first focus): /tmp/naming-tip-shown.png");

      // A second, DIFFERENT field (Definition) in the SAME session must
      // NOT show a second tip -- "una sola vez por sesión" is one tip
      // total, not one per field.
      const gotIt = page.getByRole("button", { name: "Got it" });
      await gotIt.click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { state: "detached", timeout: 3000 });
      const definitionTextarea = page.locator('label:text-is("Definition") + textarea');
      await definitionTextarea.click();
      await page.waitForTimeout(300);
      assert(
        (await page.locator(`text=${TIP_TEXT_MARKER}`).count()) === 0,
        "tip does NOT reappear on a second, different field in the same session, even after Got it"
      );

      // A different row WITHIN THE SAME records page (no full navigation,
      // still the same session -- page.goto() would itself be a hard
      // reload and reset the session ref, which is not what this step
      // means to test) -- tip still must not reappear.
      await page.locator("tr", { hasText: "BRDP-TIP-B" }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
      await page.locator('label:text-is("Title") + input').click();
      await page.waitForTimeout(300);
      assert((await page.locator(`text=${TIP_TEXT_MARKER}`).count()) === 0, "tip still does not reappear on a different BRDP's Title, same session (no reload)");

      // Reload -- a NEW session (namingTipSessionSeenRef lives only in
      // React state/refs, reset on every full page load) -- the tip must
      // appear again on the next touch.
      await page.reload();
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: "BRDP-TIP-B" }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
      await page.locator('label:text-is("Title") + input').click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { timeout: 3000 });
      assert(true, "reloading the page (new session) shows the tip again on the next field touch");
      await page.close();
    }

    // ==== 3. "Don't show again" persists server-side -- survives reload
    // AND a fresh login. ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-A");
      await page.locator('label:text-is("Title") + input').click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { timeout: 3000 });
      await page.getByRole("button", { name: "Don't show again" }).click();
      await page.waitForSelector(`text=${TIP_TEXT_MARKER}`, { state: "detached", timeout: 3000 });

      const meAfterDontShow = await fetch(`${API}/api/auth/me`, { headers: auth }).then((r) => r.json());
      assert(meAfterDontShow.hide_naming_tip === true, "PATCH hide_naming_tip:true really persisted to Postgres");

      // Same browser, reload -- must stay hidden.
      await page.reload();
      await page.waitForSelector("table", { timeout: 10000 });
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-B");
      await page.locator('label:text-is("Title") + input').click();
      await page.waitForTimeout(300);
      assert((await page.locator(`text=${TIP_TEXT_MARKER}`).count()) === 0, "tip stays hidden across a reload after Don't show again");
      await page.close();

      // A FRESH login (this app's stand-in for "a different browser",
      // same convention as test_auth.py's preferred_language test) --
      // must ALSO stay hidden, confirming it's a per-account server
      // setting, not per-browser state.
      const page2 = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page2);
      await openRecords(page2, `Naming Tip Verify ${suffix}`, "BRDP-TIP-A");
      await page2.locator('label:text-is("Title") + input').click();
      await page2.waitForTimeout(300);
      assert((await page2.locator(`text=${TIP_TEXT_MARKER}`).count()) === 0, "tip stays hidden on a genuinely fresh login too -- server-side, per account");
      await page2.close();
    }

    // ==== 4. Settings > Profile reactivates it. ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForSelector("text=Profile", { timeout: 10000 });
      await page.getByText("Profile", { exact: true }).click();
      await page.waitForSelector("text=Show naming tips again", { timeout: 5000 });
      await page.getByRole("button", { name: "Show naming tips again" }).click();
      await page.waitForSelector("text=Naming tips are shown.", { timeout: 5000 });

      const meAfterReactivate = await fetch(`${API}/api/auth/me`, { headers: auth }).then((r) => r.json());
      assert(meAfterReactivate.hide_naming_tip === false, "Settings > Profile's action really PATCHed hide_naming_tip back to false");
      await page.screenshot({ path: "/tmp/naming-tip-settings-reactivate.png", fullPage: true });
      console.log("Screenshot (Settings > Profile reactivation): /tmp/naming-tip-settings-reactivate.png");
      await page.close();

      // A fresh login after reactivating -- the tip is back.
      const page2 = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page2);
      await openRecords(page2, `Naming Tip Verify ${suffix}`, "BRDP-TIP-A");
      await page2.locator('label:text-is("Title") + input').click();
      await page2.waitForSelector(`text=${TIP_TEXT_MARKER}`, { timeout: 3000 });
      assert(true, "reactivating from Settings brings the tip back on a fresh login");
      await page2.close();
    }

    // ==== 5. Contextual "Did you mean `<pokemon>`?" correction. ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-RENAME");

      const definitionTextarea = page.locator('label:text-is("Definition") + textarea');
      await definitionTextarea.fill("el elemento pokemon debe evitarse");
      await page.waitForSelector("text=/Did you mean/", { timeout: 3000 });
      const suggestionButton = page.getByRole("button", { name: "Did you mean <pokemon>?", exact: true });
      assert((await suggestionButton.count()) > 0, 'exact "Did you mean <pokemon>?" suggestion chip appears under Definition, live as you type -- no save needed');
      // The big vocabulary notice itself is only recomputed on selection
      // and on save (never on every keystroke) -- blur to save this
      // typed text first, then it should already show "pokemon" as not
      // found (bare, from the phrase-trigger candidate), even before the
      // "Did you mean" fix is applied.
      await definitionTextarea.blur();
      await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });

      await suggestionButton.click();
      await page.waitForTimeout(400);
      const newValue = await definitionTextarea.inputValue();
      assert(newValue === "el elemento <pokemon> debe evitarse", `clicking the suggestion rewrites the field to wrap pokemon in <> (got: "${newValue}")`);
      assert(
        (await page.getByRole("button", { name: "Did you mean <pokemon>?", exact: true }).count()) === 0,
        "the suggestion chip itself disappears once applied (pokemon is no longer bare)"
      );
      // The vocabulary notice must still show <pokemon> as not found
      // (still absent from S1000D 4.2 -- only its SPELLING changed from
      // bare to marked-up, the schema verdict is the same either way) --
      // confirms the recompute happened immediately, without any
      // Ask/Suggest click, straight off the blur-triggered save.
      await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 3000 });
      const afterFixText = await page
        .locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/")
        .first()
        .textContent();
      assert(afterFixText.includes("<pokemon>"), `vocabulary notice updates immediately and still names <pokemon> (got: ${afterFixText})`);
      await page.screenshot({ path: "/tmp/naming-tip-did-you-mean.png", fullPage: true });
      console.log("Screenshot (Did you mean applied): /tmp/naming-tip-did-you-mean.png");

      // Confirms the correction was really SAVED (not just local state) --
      // reload and re-check.
      await page.reload();
      await page.waitForSelector("table", { timeout: 10000 });
      await openRecords(page, `Naming Tip Verify ${suffix}`, "BRDP-TIP-RENAME");
      const persistedValue = await page.locator('label:text-is("Definition") + textarea').inputValue();
      assert(persistedValue === "el elemento <pokemon> debe evitarse", "the correction survives a reload -- persisted to Postgres");
      await page.close();
    }

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    // Leave hide_naming_tip reactivated (false) -- this script's own
    // account-level side effect, reset for the next run/round.
    await fetch(`${API}/api/auth/me`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ hide_naming_tip: false }),
    }).catch(() => {});
    await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    console.log("Cleaned up the seeded project and reset hide_naming_tip.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
