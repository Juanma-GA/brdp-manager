// Verification for "Aviso de vocabulario ligado al texto de la BRDP y sin
// comentarios en los Suggest" (docs request, follow-up to the red-styling/
// stopword-filter/wrong-kind round). Confirms, through the real running
// app + real Postgres (both Mistral transports mocked, same convention as
// every other round):
//   1. The DETERMINISTIC half of the vocabulary check (context extraction,
//      no LLM) reflects a BRDP's CURRENT text automatically -- on simply
//      selecting it (no Ask/Suggest click needed) and again immediately
//      after any save that touches Title/Definition/Proposal, including
//      accepting a Suggest Definition/Proposal -- never a stale result
//      left over from whenever Ask/Suggest last happened to run.
//   2. The banner wording now says "This BRDP mentions names..." (tied to
//      the BRDP's text, not to whatever suggestion happens to be showing).
//   3. Suggest Definition/Proposal's own prompts get a DIFFERENT unknown-
//      names block from Ask's -- one that tells the model the user has
//      already been warned and forbids commenting on validity or deciding
//      anything about the names, instead of Ask's "point this out
//      explicitly" instruction.
//   4. A name in the HIGH-confidence "notFound" category blocks all three
//      Suggest buttons (with a dedicated tooltip); a "possiblyNotFound"
//      (LLM-only) name never blocks them.
//
// Prerequisites: mock-mistral-embed-server.mjs on :8901 (already the .env
// default), mock-mistral-chat-server.mjs on :8902 (also serves the
// vocabulary-extraction call, keyed on its distinctive system prompt, and
// a one-shot /step-next trigger new to this round) with uvicorn's
// MISTRAL_ENDPOINT overridden to it, real Vite dev server, real Postgres.
// Real S1000D 4.2 generated vocabulary (sources/SchemasS1000D/4.2,
// arrived mid-round in a previous round) -- confirmed by direct grep
// before writing this: "table" is a real element, "cocacola" and "step"
// are genuinely absent (neither element nor attribute).
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

  // BRDP B: the exact real-Mistral over-extraction phrase from a previous
  // round -- no context-path evidence at all, so only Ask/Suggest (the
  // LLM path) surfaces anything; used to confirm the Ask-vs-Suggest
  // prompt-block divergence and that possiblyNotFound never blocks Suggest.
  await makeBrdp(auth, proj.id, {
    identifier: "BRDP-LINK-B",
    title: "Ambiguous vocabulary check",
    definition: "el pokemon ese que va dentro del step",
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

    // ==== 1. BRDP A selected -- notice + blocking BEFORE any Ask/Suggest ====
    await openRecords("BRDP-LINK-A");
    // No Ask, no Suggest click yet -- the deterministic check must already
    // have run, purely from selecting the row.
    await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });
    const notFoundLocator = page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").first();
    const notFoundText = await notFoundLocator.textContent();
    assert(notFoundText.includes("<cocacola>"), `notice names <cocacola> without any Ask/Suggest click (got: ${notFoundText})`);
    const notFoundColor = await notFoundLocator.evaluate((el) => getComputedStyle(el).color);
    assert(notFoundColor === "rgb(185, 28, 28)", `notice is red #b91c1c (got ${notFoundColor})`);

    for (const kind of ["Definition", "Proposal", "Rule"]) {
      const btn = suggestButton(`Suggest ${kind}`);
      assert(await btn.isDisabled(), `Suggest ${kind} is disabled while <cocacola> is not found`);
      const title = await btn.getAttribute("title");
      assert(
        title === "Fix the names not found in the S1000D 4.2 schema first",
        `Suggest ${kind}'s tooltip is the exact vocab-block message (got: ${title})`
      );
    }
    await page.screenshot({ path: "/tmp/vocab-linked-blocked-on-select.png", fullPage: true });
    console.log("Screenshot (blocked on select, no Ask needed): /tmp/vocab-linked-blocked-on-select.png");

    // ==== edit Title to a real element, save -- notice/blocking update WITHOUT pressing Ask ====
    const titleInput = page.locator('label:text-is("Title") + input');
    await titleInput.fill("Decide the <table> tag usage");
    await titleInput.blur();
    await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { state: "detached", timeout: 5000 });
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "notice disappears right after saving the fix -- no Ask click involved"
    );
    for (const kind of ["Definition", "Proposal", "Rule"]) {
      const btn = suggestButton(`Suggest ${kind}`);
      assert(!(await btn.isDisabled()), `Suggest ${kind} unblocked right after the fix is saved, before any Ask click`);
    }
    await page.screenshot({ path: "/tmp/vocab-linked-unblocked-after-save.png", fullPage: true });
    console.log("Screenshot (notice cleared after save, no Ask needed): /tmp/vocab-linked-unblocked-after-save.png");

    // Confirm the fix really persisted (not just optimistic local state) --
    // reload and re-select, the notice must stay gone.
    await openRecords("BRDP-LINK-A");
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "fix survives a real reload -- persisted to Postgres, not just local React state"
    );

    // ==== 4. Accepting a Proposal that introduces <step> -- notice flips
    // to "Not found" immediately, no further Ask/Suggest needed ====
    await openRecords("BRDP-LINK-D");
    assert(
      (await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").count()) === 0,
      "BRDP D starts with a clean notice"
    );
    for (const kind of ["Definition", "Proposal", "Rule"]) {
      assert(!(await suggestButton(`Suggest ${kind}`).isDisabled()), `Suggest ${kind} starts enabled on BRDP D`);
    }
    await resetMock();
    await armStepNext();
    await suggestButton("Suggest Proposal").click();
    await page.waitForSelector("text=/MOCK-STEP-PROPOSAL/", { timeout: 15000 });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await page.waitForSelector("text=/This BRDP mentions names not found in the S1000D 4.2 schema/", { timeout: 5000 });
    const stepNotFoundText = await page.locator("text=/This BRDP mentions names not found in the S1000D 4.2 schema/").first().textContent();
    assert(stepNotFoundText.includes("<step>"), `accepting the Proposal with <step> flips the notice to Not found immediately (got: ${stepNotFoundText})`);
    for (const kind of ["Definition", "Proposal", "Rule"]) {
      assert(await suggestButton(`Suggest ${kind}`).isDisabled(), `Suggest ${kind} is blocked again right after accepting <step>, before any new Ask/Suggest`);
    }
    await page.screenshot({ path: "/tmp/vocab-linked-blocked-after-accept.png", fullPage: true });
    console.log("Screenshot (blocked right after accepting a Proposal with <step>): /tmp/vocab-linked-blocked-after-accept.png");

    // ==== 3. possiblyNotFound never blocks Suggest + Ask/Suggest prompt
    // blocks genuinely differ ====
    await openRecords("BRDP-LINK-B");
    // Nothing shown yet -- BRDP-LINK-B's plain-text phrase has zero
    // context-path evidence, so only a real Ask/Suggest (the LLM path)
    // can surface anything.
    assert(
      (await page.locator("text=/This BRDP mentions names/").count()) === 0,
      "BRDP B shows no notice before any Ask/Suggest -- context path alone finds nothing in this plain-text phrase"
    );
    await resetMock();
    await page.fill('textarea[placeholder="Ask about this BRDP…"]', "Is this well scoped?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=/This BRDP mentions names possibly not in the S1000D 4.2 schema/", { timeout: 5000 });
    const possiblyText = await page
      .locator("text=/This BRDP mentions names possibly not in the S1000D 4.2 schema/")
      .first()
      .textContent();
    assert(possiblyText.includes("<pokemon>") && possiblyText.includes("<step>"), `possiblyNotFound names both pokemon and step in S1000D 4.2, neither a real element/attribute there (got: ${possiblyText})`);
    for (const kind of ["Definition", "Proposal", "Rule"]) {
      assert(!(await suggestButton(`Suggest ${kind}`).isDisabled()), `Suggest ${kind} stays enabled with only possiblyNotFound names (never notFound)`);
    }
    const reqAsk = await lastMockRequest();
    const sysAsk = reqAsk.messages.find((m) => m.role === "system").content;
    assert(
      sysAsk.includes("The following names could not be confirmed against the S1000D 4.2 schema") && sysAsk.includes(": <pokemon>, <step>."),
      "Ask's prompt keeps the UNCHANGED possiblyNotFound wording"
    );
    await page.getByRole("button", { name: "Clear" }).click();

    // Suggest Definition on the SAME BRDP/text -- reuses the cached LLM
    // extraction (no new extraction call), but its OWN prompt block must
    // read completely differently from Ask's.
    await resetMock();
    await page.getByRole("button", { name: "Suggest Definition", exact: true }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqSuggest = await lastMockRequest();
    const sysSuggest = reqSuggest.messages.find((m) => m.role === "system").content;
    assert(
      sysSuggest.includes(
        "The BRDP mentions names that may not exist in the S1000D 4.2 schema: <pokemon>, <step>. The user has already been warned in the interface. Do NOT mention their validity in your output, do not add comments or notes, and do not take any decision about them"
      ),
      "Suggest Definition's prompt carries the NEW literal warned-in-interface block"
    );
    assert(
      !sysSuggest.includes("Point this out explicitly") && !sysSuggest.includes("could not be confirmed against"),
      "Suggest Definition's prompt never carries Ask's own wording -- the two blocks are genuinely different, not just relabeled"
    );
    console.log("\n===== Ask prompt's unknown-names block =====\n" + sysAsk.slice(sysAsk.indexOf("The following names could not")) + "\n=====\n");
    console.log("\n===== Suggest Definition prompt's unknown-names block =====\n" + sysSuggest.slice(sysSuggest.indexOf("The BRDP mentions names")) + "\n=====\n");
    await page.getByRole("button", { name: "Discard", exact: true }).click();

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
