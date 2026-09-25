// Verification for "Suggest Definition: corpus con catálogo, prompt de
// especialista y referencias visibles" (docs request). Confirms, through
// the real running app + real Postgres (embeddings transport mocked, same
// convention as every other round in this branch):
//   1. The corpus includes BOTH other-project Validated BRDPs AND catalog
//      entries of the same standard, each labeled by origin.
//   2. With 0 candidates, the LLM is still called (no MIN_CANDIDATES gate)
//      and the UI shows "Definition generated without reference BRDPs".
//   3. buildSuggestDefinitionPrompt's exact literal shape, captured via
//      mock-mistral-chat-server.mjs's GET /last-request (RecordsPage.jsx's
//      buildSuggestDefinitionPrompt is module-private and this repo has no
//      JS test runner -- same "capture the real prompt" method already
//      established for buildAskSystemPrompt).
//   4. temperature: 0.3 is sent for this call specifically.
//   5. An official catalog BRDP disables the button (with the real
//      tooltip) AND the backend rejects a direct API call with 400.
//
// Prerequisites (same as prior rounds): mock-mistral-embed-server.mjs on
// :8901 (already the .env default, no uvicorn restart needed for it),
// mock-mistral-chat-server.mjs on :8902 with uvicorn's MISTRAL_ENDPOINT
// overridden to it, real Vite dev server, real Postgres. Also needs
// backend/scripts/seed_suggest_definition_catalog.py and
// seed_ask_compare_catalog.py already run (S1000D 4.2 catalog: 3 entries).
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

async function computeAndWait(auth, projectId) {
  const resp = await fetch(`${API}/api/projects/${projectId}/embeddings/compute`, { method: "POST", headers: auth });
  if (resp.status !== 202) throw new Error(`POST /compute expected 202, got ${resp.status}`);
  const { job_id } = await resp.json();
  for (let i = 0; i < 60; i++) {
    const body = await fetch(`${API}/api/projects/${projectId}/embeddings/status/${job_id}`, { headers: auth }).then(
      (r) => r.json()
    );
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Embedding job ${job_id} never left 'running' status`);
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  // ---- Project A (S1000D 4.2): real Records + Catalog candidates ----
  const projA = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Suggest Definition Verify A ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  const sourceA = await fetch(`${API}/api/projects/${projA.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SDCAT-SOURCE-01",
      title: "Torque calibration procedure",
      definition: "",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  for (let i = 0; i < 2; i++) {
    await fetch(`${API}/api/projects/${projA.id}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        identifier: `BRDP-SDCAT-CLOSE-0${i + 1}`,
        title: `Close precedent ${i + 1}`,
        definition: `Close precedent definition text ${i + 1}.`,
        proposal: `Close precedent proposal text ${i + 1}.`,
        validation: "Validated",
      }),
    }).then((r) => r.json());
  }
  console.log("Seeded Project A (S1000D 4.2): 1 source BRDP + 2 Validated Records candidates");

  // Catalog-rejection BRDP: identifier matches the seeded catalog entry.
  const catalogBrdp = await fetch(`${API}/api/projects/${projA.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SDCAT-LIVE-001",
      title: "Catalog-sourced BRDP",
      definition: "",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());

  const jobA = await computeAndWait(auth, projA.id);
  assert(jobA.status === "completed", `Project A embedding job completed (status=${jobA.status}, error=${jobA.error})`);

  // ---- Backend: candidates include catalog + records, labeled ----
  const similarA = await fetch(
    `${API}/api/projects/${projA.id}/brdps/${sourceA.id}/similar?kind=definition`,
    { headers: auth }
  ).then((r) => r.json());
  console.log("GET /similar?kind=definition for BRDP-SDCAT-SOURCE-01:", JSON.stringify(similarA, null, 2));
  assert(similarA.candidates.length === 5, `5 candidates (2 Records + 3 Catalog), got ${similarA.candidates.length}`);
  assert(similarA.style_references.length === 0, "5 similar (not <3) -- no style references");
  const identifiers = new Set(similarA.candidates.map((c) => c.identifier));
  assert(identifiers.has("BRDP-SDCAT-CLOSE-01") && identifiers.has("BRDP-SDCAT-CLOSE-02"), "both Records candidates present");
  assert(identifiers.has("BRDP-SDCAT-LIVE-001") || identifiers.has("BRDP-CAT-ASKTEST-001"), "at least one Catalog candidate present");
  const catalogCandidate = similarA.candidates.find((c) => c.source === "Catalog");
  assert(!!catalogCandidate, "a candidate is labeled source === 'Catalog'");
  const recordsCandidate = similarA.candidates.find((c) => c.source === `Records: ${projA.name}`);
  assert(!!recordsCandidate, `a candidate is labeled source === 'Records: ${projA.name}'`);

  // ---- Backend: 400 for the catalog-sourced BRDP itself ----
  const rejected = await fetch(`${API}/api/projects/${projA.id}/brdps/${catalogBrdp.id}/similar?kind=definition`, {
    headers: auth,
  });
  assert(rejected.status === 400, `direct API call for the catalog BRDP itself -> 400, got ${rejected.status}`);

  // ---- Project B (DITA 1.3 Xpath2.0): zero candidates anywhere ----
  const projB = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Suggest Definition Verify B ${suffix}`, standard: "DITA 1.3 Xpath2.0" }),
  }).then((r) => r.json());
  const sourceB = await fetch(`${API}/api/projects/${projB.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-SDEMPTY-SOURCE-01",
      title: "Lone BRDP with no precedent anywhere",
      definition: "",
      proposal: "",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  console.log("Seeded Project B (DITA 1.3 Xpath2.0): 1 source BRDP, no other Validated BRDPs, no catalog for this standard");

  const similarB = await fetch(
    `${API}/api/projects/${projB.id}/brdps/${sourceB.id}/similar?kind=definition`,
    { headers: auth }
  ).then((r) => r.json());
  assert(similarB.sufficient_precedent === true, "kind=definition never reports insufficient precedent, even with 0 candidates");
  assert(similarB.candidates.length === 0 && similarB.style_references.length === 0, "0 candidates, 0 style references");

  // ---- UI: real clicks, screenshots, and prompt capture ----
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

    async function openRecords(projectName, brdpIdentifier) {
      await page.goto(`${BASE_URL}/projects`);
      await page.waitForSelector("table", { timeout: 10000 });
      const row = page.locator("tr", { hasText: projectName });
      await row.getByRole("button", { name: /Records/i }).click();
      await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: brdpIdentifier }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    }

    // ---- With references: Project A / BRDP-SDCAT-SOURCE-01 ----
    await openRecords(`Suggest Definition Verify A ${suffix}`, "BRDP-SDCAT-SOURCE-01");
    await resetMock();
    const suggestDefButton = page.getByRole("button", { name: "Suggest Definition" });
    assert(await suggestDefButton.isEnabled(), "Suggest Definition is enabled for a non-catalog BRDP");
    await suggestDefButton.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=Similar", { timeout: 5000 });
    await page.screenshot({ path: "/tmp/suggest-definition-with-references.png", fullPage: true });
    console.log("Screenshot (with references): /tmp/suggest-definition-with-references.png");

    const reqWithRefs = await lastMockRequest();
    const sysWithRefs = reqWithRefs.messages.find((m) => m.role === "system").content;
    const userMsgs = reqWithRefs.messages.filter((m) => m.role !== "system");
    console.log("\n===== System prompt (with references) =====\n" + sysWithRefs + "\n=====\n");
    assert(reqWithRefs.temperature === 0.3, `temperature 0.3 sent, got ${reqWithRefs.temperature}`);
    assert(userMsgs.length === 1 && userMsgs[0].content === "Write the Definition for this BRDP.", "fixed user message, no history");
    assert(sysWithRefs.includes("You are an expert in S1000D 4.2 business rules"), "prompt opens with the standard-scoped expert line");
    assert(sysWithRefs.includes("Use this project's standard only: S1000D 4.2."), "prompt pins the standard");
    assert(sysWithRefs.includes("SIMILAR BRDPs — validated decision points closest in meaning"), "Similar block present");
    assert(sysWithRefs.includes("BRDP-SDCAT-CLOSE-01") && sysWithRefs.includes("BRDP-SDCAT-CLOSE-02"), "both Records candidates named in the prompt");
    assert(/\[BRDP-SDCAT-CLOSE-01 \| Records: .+ \| similarity \d\.\d\d\]/.test(sysWithRefs), "reference line format matches the exact template");
    assert(sysWithRefs.includes("Title:") && sysWithRefs.includes("Definition:"), "Title/Definition lines present for references");
    assert(!sysWithRefs.includes("STYLE REFERENCES"), "no style references block when 5 similar were found");
    assert(sysWithRefs.includes("ID: BRDP-SDCAT-SOURCE-01"), "BRDP-to-define block carries the real identifier");
    assert(sysWithRefs.includes("Current Definition: empty") && sysWithRefs.includes("Proposal: empty"), "empty fields render as literal 'empty'");
    assert(sysWithRefs.trim().endsWith("Proposal: empty"), "prompt ends with the Proposal line, nothing appended after");

    // ---- Catalog-disabled button (Project A / BRDP-SDCAT-LIVE-001) ----
    await openRecords(`Suggest Definition Verify A ${suffix}`, "BRDP-SDCAT-LIVE-001");
    const catalogButton = page.getByRole("button", { name: "Suggest Definition" });
    assert(await catalogButton.isDisabled(), "Suggest Definition is disabled for a catalog-sourced BRDP");
    assert(
      (await catalogButton.getAttribute("title")) === "Official definition from the standard catalog",
      "tooltip reads the exact docs-request text"
    );
    await page.screenshot({ path: "/tmp/suggest-definition-catalog-disabled.png", fullPage: true });
    console.log("Screenshot (catalog-disabled button): /tmp/suggest-definition-catalog-disabled.png");

    // ---- Without references: Project B / BRDP-SDEMPTY-SOURCE-01 ----
    await openRecords(`Suggest Definition Verify B ${suffix}`, "BRDP-SDEMPTY-SOURCE-01");
    await resetMock();
    const suggestDefButtonB = page.getByRole("button", { name: "Suggest Definition" });
    assert(await suggestDefButtonB.isEnabled(), "Suggest Definition is enabled even with zero candidates (no MIN_CANDIDATES gate)");
    await suggestDefButtonB.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=Definition generated without reference BRDPs", { timeout: 5000 });
    await page.screenshot({ path: "/tmp/suggest-definition-without-references.png", fullPage: true });
    console.log("Screenshot (without references): /tmp/suggest-definition-without-references.png");

    const reqNoRefs = await lastMockRequest();
    const sysNoRefs = reqNoRefs.messages.find((m) => m.role === "system").content;
    console.log("\n===== System prompt (without references) =====\n" + sysNoRefs + "\n=====\n");
    assert(
      sysNoRefs.includes("No reference BRDPs are available; write the Definition from your\nknowledge of DITA 1.3 Xpath2.0 alone."),
      "no-references fallback line present with the real standard"
    );
    assert(!sysNoRefs.includes("SIMILAR BRDPs") && !sysNoRefs.includes("STYLE REFERENCES"), "neither block present with 0 candidates");

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    for (const proj of [projA, projB]) {
      await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up both seeded projects.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
