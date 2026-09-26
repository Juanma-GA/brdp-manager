// Verification for "Aviso de vocabulario ligado al texto de la BRDP, y sin
// bloqueo de Suggest" (docs request), covering the still-valid parts of
// the "aviso ligado al texto" round PLUS this round's explicit reversal of
// its point 4 (Suggest button blocking, removed by user decision).
// Confirms, through the real running app + real Postgres (chat transport
// mocked, same convention as every other round):
//   1. The DETERMINISTIC vocabulary check (context extraction, no LLM at
//      all now) reflects a BRDP's CURRENT text automatically -- on simply
//      selecting it (no Ask/Suggest click needed) and again immediately
//      after any save that touches Title/Definition/Proposal, including
//      accepting a Suggest Proposal -- never a stale result left over from
//      whenever Ask/Suggest last happened to run.
//   2. The banner wording says "This BRDP mentions names not found..."
//      (tied to the BRDP's text, not to whatever suggestion is showing).
//   3. Suggest Definition/Proposal's own prompts get a DIFFERENT unknown-
//      names block from Ask's -- one that tells the model the user has
//      already been warned and forbids commenting on validity or deciding
//      anything about the names, instead of Ask's "point this out
//      explicitly" instruction.
//   4. REVERSED THIS ROUND: a notFound name NEVER disables any of the
//      three Suggest buttons any more -- the red banner is sufficient on
//      its own, at every point in this script (on select, right after a
//      save, and right after accepting a Proposal that introduces one).
//
// Prerequisites: mock-mistral-chat-server.mjs on :8902 (with its own
// one-shot /step-next trigger) with uvicorn's MISTRAL_ENDPOINT overridden
// to it, real Vite dev server, real Postgres. Real S1000D 4.2 generated
// vocabulary (sources/SchemasS1000D/4.2) -- confirmed by direct grep
// before writing this: "table" is a real element, "cocacola"/"pokemon"/
// "step" are genuinely absent (neither element nor attribute).
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK_CHAT = "http://localhost:8902";
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

async function resetMock() {
  await fetch(`${MOCK_CHAT}/reset`, { method: "POST" });
}
async function lastMockRequest() {
  return fetch(`${MOCK_CHAT}/last-request`).then((r) => r.json());
}
async function armStepNext() {
  await fetch(`${MOCK_CHAT}/step-next`, { method: "POST" });
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

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  const proj = await makeProject(auth, `Vocab Linked ${suffix}`, "S1000D 4.2");

  // BRDP A: <cocacola> in the Title -- to be found WITHOUT ever clicking
  // Ask, and to be fixed by editing+saving, also without clicking Ask.
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-LINK-A",
    title: "Decide the <cocacola> tag usage",
    definition: "This decision governs formatting.",
    proposal: "",
    validation: "Pending",
  });

  // BRDP D: clean text (no vocab issues), Definition non-empty so Suggest
  // Proposal is enabled -- used to accept a Proposal that introduces
  // <step> (genuinely absent from S1000D 4.2, confirmed above) and watch
  // the notice react immediately, without any further Ask/Suggest click.
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-LINK-D",
    title: "Step numbering format",
    definition: "This decision governs numbering of steps in maintenance procedures.",
    proposal: "",
    validation: "Pending",
  });

  // BRDP E: explicit <pokemon> markup -- guaranteed real context-path
  // evidence (never relies on the phrase heuristic), used to compare
  // Ask's vs Suggest's unknown-names prompt blocks on the SAME notFound
  // name.
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-LINK-E",
    title: "Ask vs Suggest prompt divergence check",
    definition: "References <pokemon> as a placeholder that should never really exist.",
    proposal: "",
    validation: "Pending",
  });

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    async function openRecords(brdpIdentifier) {
      await page.goto(`${BASE_URL}/projects`);
      await page.waitForSelector("table", { timeout: 10000 });
      const row = page.locator("tr", { hasText: `Vocab Linked ${suffix}` });
      await row.getByRole("button", { name: /Records/i }).click();
      await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: brdpIdentifier }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    }

    function suggestButton(name) {
      return page.getByRole("button", { name, exact: true });
    }

    async function assertAllSuggestButtonsEnabled(context) {
      for (const kind of ["Definition", "Proposal", "Rule"]) {
        assert(!(await suggestButton(`Suggest ${kind}`).isDisabled()), `Suggest ${kind} is ENABLED ${context}`);
      }
    }

    // ==== 1. BRDP A selected -- notice appears BEFORE any Ask/Suggest,
    // Suggest buttons stay enabled throughout ====
    await openRecords("BRDP-LINK-A");
    // No Ask, no Suggest click yet -- the deterministic check must already
    // have run, purely from selecting the row.
    await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });
    const notFoundLocator = page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").first();
    const notFoundText = await notFoundLocator.textContent();
    assert(notFoundText.includes("<cocacola>"), `notice names <cocacola> without any Ask/Suggest click (got: ${notFoundText})`);
    const notFoundColor = await notFoundLocator.evaluate((el) => getComputedStyle(el).color);
    assert(notFoundColor === "rgb(185, 28, 28)", `notice is red #b91c1c (got ${notFoundColor})`);
    await assertAllSuggestButtonsEnabled("while <cocacola> is not found (blocking is gone this round)");
    await page.screenshot({ path: "/tmp/vocab-linked-notice-on-select.png", fullPage: true });
    console.log("Screenshot (notice on select, no Ask needed, buttons enabled): /tmp/vocab-linked-notice-on-select.png");

    // ==== edit Title to a real element, save -- notice updates WITHOUT pressing Ask ====
    const titleInput = page.locator('label:text-is("Title") + input');
    await titleInput.fill("Decide the <table> tag usage");
    await titleInput.blur();
    await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { state: "detached", timeout: 5000 });
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "notice disappears right after saving the fix -- no Ask click involved"
    );
    await assertAllSuggestButtonsEnabled("right after the fix is saved");
    await page.screenshot({ path: "/tmp/vocab-linked-notice-cleared-after-save.png", fullPage: true });
    console.log("Screenshot (notice cleared after save, no Ask needed): /tmp/vocab-linked-notice-cleared-after-save.png");

    // Confirm the fix really persisted (not just optimistic local state) --
    // reload and re-select, the notice must stay gone.
    await openRecords("BRDP-LINK-A");
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "fix survives a real reload -- persisted to Postgres, not just local React state"
    );

    // ==== 4. Accepting a Proposal that introduces <step> -- notice flips
    // to "Not found" immediately, no further Ask/Suggest needed, buttons
    // never disabled by it ====
    await openRecords("BRDP-LINK-D");
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "BRDP D starts with a clean notice"
    );
    await assertAllSuggestButtonsEnabled("on BRDP D before any suggestion");
    await resetMock();
    await armStepNext();
    await suggestButton("Suggest Proposal").click();
    await page.waitForSelector("text=/MOCK-STEP-PROPOSAL/", { timeout: 15000 });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });
    const stepNotFoundText = await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").first().textContent();
    assert(stepNotFoundText.includes("<step>"), `accepting the Proposal with <step> flips the notice to Not found immediately (got: ${stepNotFoundText})`);
    await assertAllSuggestButtonsEnabled("right after accepting <step> -- the notice shows, but nothing is disabled by it");
    await page.screenshot({ path: "/tmp/vocab-linked-notice-after-accept.png", fullPage: true });
    console.log("Screenshot (notice right after accepting a Proposal with <step>, buttons still enabled): /tmp/vocab-linked-notice-after-accept.png");

    // ==== 3. Ask/Suggest prompt blocks genuinely differ, on the SAME
    // notFound name ====
    await openRecords("BRDP-LINK-E");
    await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqAsk = await lastMockRequest();
    const sysAsk = reqAsk.messages.find((m) => m.role === "system").content;
    assert(
      sysAsk.includes(
        "The following names do NOT exist in the S1000D 4.2 schema: <pokemon>. Point this out explicitly; do not treat them as valid elements or attributes."
      ),
      "Ask's prompt carries its own 'point this out explicitly' wording"
    );
    await page.getByRole("button", { name: "Clear" }).click();

    // Suggest Definition on the SAME BRDP/text -- its OWN prompt block must
    // read completely differently from Ask's.
    await resetMock();
    await page.getByRole("button", { name: "Suggest Definition", exact: true }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqSuggest = await lastMockRequest();
    const sysSuggest = reqSuggest.messages.find((m) => m.role === "system").content;
    assert(
      sysSuggest.includes(
        "The BRDP mentions names that may not exist in the S1000D 4.2 schema: <pokemon>. The user has already been warned in the interface. Do NOT mention their validity in your output, do not add comments or notes, and do not take any decision about them"
      ),
      "Suggest Definition's prompt carries the literal warned-in-interface block"
    );
    assert(
      !sysSuggest.includes("Point this out explicitly"),
      "Suggest Definition's prompt never carries Ask's own wording -- the two blocks are genuinely different, not just relabeled"
    );
    console.log("\n===== Ask prompt's unknown-names block =====\n" + sysAsk.slice(sysAsk.indexOf("The following names do NOT exist")) + "\n=====\n");
    console.log("\n===== Suggest Definition prompt's unknown-names block =====\n" + sysSuggest.slice(sysSuggest.indexOf("The BRDP mentions names")) + "\n=====\n");
    // The 3 buttons ARE disabled right now, but for the PENDING-suggestion
    // reason (unrelated to vocabulary, unchanged by this round) -- never
    // the vocab-block tooltip/reason, which no longer exists anywhere.
    const tooltipWithPending = await suggestButton("Suggest Proposal").getAttribute("title");
    assert(
      tooltipWithPending === "Accept or discard the pending suggestion first",
      `the 3 buttons are blocked only for the pending-suggestion reason, never vocabulary (got tooltip: ${tooltipWithPending})`
    );
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.waitForTimeout(200);
    await assertAllSuggestButtonsEnabled("after discarding -- and with the notFound <pokemon> still present in the text, confirming vocabulary alone never blocks");

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
