// Verification: brdps.comments (the Refused-reason textbox wired up in a
// previous round) is now tracked in the audit trail under field_name
// "refusal_reason" -- _HISTORY_FIELDS (backend/app/api/routes/brdps.py)
// previously omitted "comments" entirely, so editing the reason left no
// trace in History despite the field itself saving correctly. Covers the
// three edge cases from the docs request: (a) marking Refused + filling
// the reason logs an entry, (b) editing the reason of an already-Refused
// BRDP (text-only change) also logs one, (c) a BRDP never marked Refused
// has zero refusal_reason entries.
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
  const data = await res.json();
  return data.access_token;
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const projects = await fetch(`${API}/api/projects`, { headers: auth }).then((r) => r.json());
  const demo = projects.find((p) => p.name.startsWith("Demo Project"));

  // Edge case (c): a BRDP never marked Refused, only touched on other
  // fields -- must have zero refusal_reason history rows.
  const neverRefused = await fetch(`${API}/api/projects/${demo.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-HIST-COMMENTS-A",
      title: "t",
      definition: "d",
      proposal: "p",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  await fetch(`${API}/api/projects/${demo.id}/brdps/${neverRefused.id}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ title: "Touched, never refused" }),
  });
  const neverRefusedHistory = await fetch(`${API}/api/projects/${demo.id}/brdps/${neverRefused.id}/history`, {
    headers: auth,
  }).then((r) => r.json());
  assert(
    !neverRefusedHistory.some((h) => h.field_name === "refusal_reason"),
    "A BRDP never marked Refused has zero refusal_reason history entries"
  );

  // Edge case (a) + (b): seed one BRDP for the real UI walkthrough.
  const created = await fetch(`${API}/api/projects/${demo.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-HIST-COMMENTS-B",
      title: "Comments history textbox test",
      definition: "d",
      proposal: "p",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  console.log("Seeded BRDP-HIST-COMMENTS-A/B on Demo Project");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    const row = page.locator("tr", { hasText: "Demo Project" });
    await row.getByRole("button", { name: /Records/i }).click();
    await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    await page.locator("tr", { hasText: "BRDP-HIST-COMMENTS-B" }).click();
    await page.waitForSelector("text=/No changes recorded yet/i", { timeout: 5000 });
    assert(true, "History starts empty for the freshly seeded BRDP");

    // (a) Mark Refused + fill in a reason -> real PUT through the app.
    const validationSelect = page
      .locator("select")
      .filter({ has: page.locator("option", { hasText: "Refused" }) })
      .last();
    await validationSelect.selectOption("Refused");
    await page.waitForTimeout(400);
    const textarea = page
      .locator("label", { hasText: "Reason for refusal" })
      .locator("xpath=following-sibling::textarea[1]");
    await textarea.fill("Conflicts with an already-approved rule.");
    await textarea.blur();
    await page.waitForTimeout(700);

    await page.waitForSelector("text=/Reason for refusal/i", { timeout: 5000 });
    let historyItems = page.locator("li", { hasText: "Reason for refusal" });
    assert((await historyItems.count()) >= 1, "A 'Reason for refusal' history entry appears after marking Refused with a reason");
    let latestText = await historyItems.first().innerText();
    assert(latestText.includes("Conflicts with an already-approved rule."), `History entry shows the new reason text (got: "${latestText}")`);

    // (b) Edit the reason again, status unchanged -- must ALSO log.
    const textareaAgain = page
      .locator("label", { hasText: "Reason for refusal" })
      .locator("xpath=following-sibling::textarea[1]");
    await textareaAgain.fill("Updated reason, same Refused status.");
    await textareaAgain.blur();
    await page.waitForTimeout(700);

    historyItems = page.locator("li", { hasText: "Reason for refusal" });
    const reasonEntryCount = await historyItems.count();
    assert(reasonEntryCount === 2, `Editing the reason of an already-Refused BRDP (status unchanged) logs its OWN entry too (expected 2 total, got ${reasonEntryCount})`);
    latestText = await historyItems.first().innerText();
    assert(latestText.includes("Updated reason, same Refused status."), `Newest history entry (top of list) shows the updated reason (got: "${latestText}")`);
    assert(latestText.includes("Conflicts with an already-approved rule."), `Newest history entry shows the OLD value too, i.e. old->new (got: "${latestText}")`);

    await page.screenshot({ path: "/tmp/comments-history-tracking.png", fullPage: true });
    console.log("Screenshot saved to /tmp/comments-history-tracking.png");

    // Cross-check directly against the API: field_name is "refusal_reason", not "comments".
    const apiHistory = await fetch(`${API}/api/projects/${demo.id}/brdps/${created.id}/history`, { headers: auth }).then((r) => r.json());
    const apiReasonEntries = apiHistory.filter((h) => h.field_name === "refusal_reason");
    assert(apiReasonEntries.length === 2, `API history has exactly 2 refusal_reason rows (got ${apiReasonEntries.length})`);
    assert(!apiHistory.some((h) => h.field_name === "comments"), "No history row uses the raw DB column name 'comments' -- always the audit name 'refusal_reason'");
    assert(apiReasonEntries[0].old_value === "Conflicts with an already-approved rule." && apiReasonEntries[0].new_value === "Updated reason, same Refused status.", "Newest API row's old/new values match the second edit exactly");
    assert(apiReasonEntries[1].old_value === "" && apiReasonEntries[1].new_value === "Conflicts with an already-approved rule.", "Oldest API row's old/new values match the first (Pending->Refused) edit exactly");

    console.log("\nALL CHECKS PASSED");
  } finally {
    for (const b of [neverRefused, created]) {
      await fetch(`${API}/api/projects/${demo.id}/brdps/${b.id}`, { method: "DELETE", headers: auth }).catch(() => {});
      await fetch(`${API}/api/trash/${b.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up BRDP-HIST-COMMENTS-A/B (soft + permanent delete)");
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
