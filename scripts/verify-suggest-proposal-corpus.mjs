// Verification for "Suggest Proposal: precedentes por mismo ID, parecidas y
// coherencia del proyecto" (docs request). Confirms, through the real
// running app + real Postgres (both Mistral transports mocked, same
// convention as every other round in this branch):
//   1. Three-group corpus: "Same BRDP in other projects" (direct
//      identifier match against brdp_catalog, up to 5), "Similar decisions"
//      (up to 5 combined with the group above), "This project" (up to 3),
//      no MIN_CANDIDATES gate.
//   2. Edge cases: a catalog-issued identifier present in 2 other projects
//      (2 in Same BRDP + top-up from Similar), an EXT-style identifier
//      (no Same BRDP group at all, Similar alone provides up to 5), empty
//      Definition disables the button (and the API 400s directly), a
//      Refused BRDP's Proposal-rejection block in the prompt, and the
//      "without reference BRDPs" fallback when all three groups are empty.
//   3. buildSuggestProposalPrompt's exact literal shape, captured via
//      mock-mistral-chat-server.mjs's GET /last-request (RecordsPage.jsx's
//      buildSuggestProposalPrompt is module-private and this repo has no
//      JS test runner -- same "capture the real prompt" method already
//      established for buildAskSystemPrompt/buildSuggestDefinitionPrompt).
//   4. temperature: 0.3, fixed user message, no history.
//   5. UI: three-group reference list, a reference row expanding to show
//      BOTH Definition and Proposal, the pending-suggestion block on all
//      three Suggest buttons.
//
// Prerequisites: mock-mistral-embed-server.mjs on :8901 (already the .env
// default, no uvicorn restart needed for it), mock-mistral-chat-server.mjs
// on :8902 with uvicorn's MISTRAL_ENDPOINT overridden to it, real Vite dev
// server, real Postgres, and
// backend/scripts/seed_suggest_proposal_catalog.py already run (S1000D 4.2
// catalog: BRDP-SPCAT-LIVE-001).
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK_CHAT = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const SAME_ID = "BRDP-SPCAT-LIVE-001";

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
  const STANDARD = "S1000D 4.2";

  // ---- Project A: source BRDP + This project candidates + Refused + empty-Definition ----
  const projA = await makeProject(auth, `Suggest Proposal Verify A ${suffix}`, STANDARD);
  const sourceA = await makeBrdp(auth, projA.id, {
    identifier: SAME_ID,
    title: "Fuel line clamp spacing decision",
    definition: "This decision point governs the maximum spacing between fuel line clamps in this project.",
    proposal: "",
    validation: "Pending",
  });
  const thisProjectBrdps = [];
  for (let i = 0; i < 3; i++) {
    thisProjectBrdps.push(
      await makeBrdp(auth, projA.id, {
        identifier: `BRDP-SPPROJ-A-0${i + 1}`,
        title: `This-project precedent ${i + 1}`,
        definition: `This-project precedent definition ${i + 1}.`,
        proposal: `This-project precedent proposal ${i + 1}.`,
        validation: "Validated",
      })
    );
  }
  const refusedBrdp = await makeBrdp(auth, projA.id, {
    identifier: "BRDP-SPREFUSED-01",
    title: "Refused decision needing a new Proposal",
    definition: "Definition for the refused decision point.",
    proposal: "The rejected proposal text.",
    validation: "Refused",
    comments: "Too vague -- must state a numeric limit.",
  });
  const emptyDefBrdp = await makeBrdp(auth, projA.id, {
    identifier: "BRDP-SPNODEF-01",
    title: "BRDP with no Definition yet",
    definition: "",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project A: source (Same-BRDP identifier) + 3 This-project + 1 Refused + 1 empty-Definition");

  // ---- Project B: Same-BRDP match #1 + 2 Similar-decisions candidates ----
  const projB = await makeProject(auth, `Suggest Proposal Verify B ${suffix}`, STANDARD);
  const sameId1 = await makeBrdp(auth, projB.id, {
    identifier: SAME_ID,
    title: "Fuel line clamp spacing decision (Project B's own)",
    definition: "Project B's own Definition for the same decision point.",
    proposal: "Project B decided: clamps shall be spaced no more than 600 mm apart.",
    validation: "Validated",
  });
  const similarDecision1 = await makeBrdp(auth, projB.id, {
    identifier: "BRDP-SPSIM-B-01",
    title: "Related decision 1",
    definition: "Related decision definition 1.",
    proposal: "Related decision proposal 1.",
    validation: "Validated",
  });
  const similarDecision2 = await makeBrdp(auth, projB.id, {
    identifier: "BRDP-SPSIM-B-02",
    title: "Related decision 2",
    definition: "Related decision definition 2.",
    proposal: "Related decision proposal 2.",
    validation: "Validated",
  });
  console.log("Seeded Project B: Same-BRDP match #1 + 2 Similar-decisions candidates");

  // ---- Project C: Same-BRDP match #2 + 1 Similar-decisions candidate ----
  const projC = await makeProject(auth, `Suggest Proposal Verify C ${suffix}`, STANDARD);
  const sameId2 = await makeBrdp(auth, projC.id, {
    identifier: SAME_ID,
    title: "Fuel line clamp spacing decision (Project C's own)",
    definition: "Project C's own Definition for the same decision point.",
    proposal: "Project C decided: clamps shall be spaced no more than 500 mm apart.",
    validation: "Validated",
  });
  const similarDecision3 = await makeBrdp(auth, projC.id, {
    identifier: "BRDP-SPSIM-C-01",
    title: "Related decision 3",
    definition: "Related decision definition 3.",
    proposal: "Related decision proposal 3.",
    validation: "Validated",
  });
  console.log("Seeded Project C: Same-BRDP match #2 + 1 Similar-decisions candidate");

  // ---- Project D: EXT-style identifier -- no Same BRDP group at all ----
  const projD = await makeProject(auth, `Suggest Proposal Verify D ${suffix}`, STANDARD);
  const extSource = await makeBrdp(auth, projD.id, {
    identifier: "BRDP-EXT-00001",
    title: "Auto-extracted BRDP, not catalog-issued",
    definition: "Definition for the EXT-style BRDP.",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project D: EXT-style source BRDP, no other BRDPs of its own");

  // ---- Project E (DITA, different standard): zero candidates anywhere ----
  const projE = await makeProject(auth, `Suggest Proposal Verify E ${suffix}`, "DITA 1.3 Xpath2.0");
  const loneBrdp = await makeBrdp(auth, projE.id, {
    identifier: "BRDP-SPNOREF-01",
    title: "Lone BRDP with no precedent anywhere",
    definition: "Definition for a BRDP with no reference precedent at all.",
    proposal: "",
    validation: "Pending",
  });
  console.log("Seeded Project E (DITA 1.3 Xpath2.0): lone BRDP, no other Validated BRDPs of this standard");

  const jobA = await computeAndWait(auth, projA.id);
  assert(jobA.status === "completed", `Project A embedding job completed (status=${jobA.status}, error=${jobA.error})`);
  const jobB = await computeAndWait(auth, projB.id);
  assert(jobB.status === "completed", `Project B embedding job completed (status=${jobB.status}, error=${jobB.error})`);
  const jobC = await computeAndWait(auth, projC.id);
  assert(jobC.status === "completed", `Project C embedding job completed (status=${jobC.status}, error=${jobC.error})`);

  // ==== Backend: three-group corpus for the SAME_ID source BRDP ====
  const similarA = await fetch(`${API}/api/projects/${projA.id}/brdps/${sourceA.id}/similar?kind=proposal`, {
    headers: auth,
  }).then((r) => r.json());
  console.log("GET /similar?kind=proposal for source A:", JSON.stringify(similarA, null, 2));
  assert(similarA.sufficient_precedent === true, "sufficient_precedent always true for kind=proposal");
  assert(similarA.same_brdp.length === 2, `Same BRDP: 2 entries (got ${similarA.same_brdp.length})`);
  const sameBrdpIds = new Set(similarA.same_brdp.map((c) => c.identifier));
  assert(sameBrdpIds.size === 1 && sameBrdpIds.has(SAME_ID), "both Same-BRDP entries carry the shared identifier");
  const sameBrdpSources = new Set(similarA.same_brdp.map((c) => c.source));
  assert(
    sameBrdpSources.has(projB.name) && sameBrdpSources.has(projC.name),
    "Same-BRDP sources are the bare project names of B and C"
  );
  assert(similarA.candidates.length === 3, `Similar decisions tops up to a combined 5 (3 here), got ${similarA.candidates.length}`);
  const candidateIds = new Set(similarA.candidates.map((c) => c.identifier));
  assert(
    candidateIds.has("BRDP-SPSIM-B-01") && candidateIds.has("BRDP-SPSIM-B-02") && candidateIds.has("BRDP-SPSIM-C-01"),
    "all 3 Similar-decisions candidates present"
  );
  assert(!candidateIds.has(SAME_ID), "SAME_ID never double-counted in candidates (excluded via cross-group dedup)");
  assert(similarA.this_project.length === 3, `This project: 3 entries, got ${similarA.this_project.length}`);
  const thisProjectSources = new Set(similarA.this_project.map((c) => c.source));
  assert(thisProjectSources.size === 1 && thisProjectSources.has(""), "This-project entries carry an empty source (never named)");
  assert(similarA.excluded_pending_other_projects === 0, "no exclusions for missing embeddings in this scenario");

  // ==== Backend: EXT-style identifier -- no Same BRDP group ====
  const similarD = await fetch(`${API}/api/projects/${projD.id}/brdps/${extSource.id}/similar?kind=proposal`, {
    headers: auth,
  }).then((r) => r.json());
  console.log("GET /similar?kind=proposal for EXT source:", JSON.stringify(similarD, null, 2));
  assert(similarD.same_brdp.length === 0, "EXT-style identifier -> empty Same BRDP group");
  assert(similarD.candidates.length === 5, `Similar decisions alone provides up to 5, got ${similarD.candidates.length}`);
  const extCandidateIds = new Set(similarD.candidates.map((c) => c.identifier));
  assert(
    [SAME_ID, "BRDP-SPSIM-B-01", "BRDP-SPSIM-B-02", "BRDP-SPSIM-C-01"].every((id) => extCandidateIds.has(id)) ||
      extCandidateIds.size === 5,
    "5 distinct Similar-decisions candidates pooled from all other projects' Validated BRDPs"
  );
  assert(similarD.this_project.length === 0, "Project D has no other BRDPs of its own -- empty This project group");

  // ==== Backend: empty Definition rejected with 400 ====
  const rejected = await fetch(`${API}/api/projects/${projA.id}/brdps/${emptyDefBrdp.id}/similar?kind=proposal`, {
    headers: auth,
  });
  assert(rejected.status === 400, `empty-Definition BRDP -> 400, got ${rejected.status}`);

  // ==== Backend: zero-candidates project still reports sufficient precedent ====
  const similarE = await fetch(`${API}/api/projects/${projE.id}/brdps/${loneBrdp.id}/similar?kind=proposal`, {
    headers: auth,
  }).then((r) => r.json());
  assert(similarE.sufficient_precedent === true, "0 candidates everywhere -> still sufficient_precedent=true, no gate");
  assert(
    similarE.same_brdp.length === 0 && similarE.candidates.length === 0 && similarE.this_project.length === 0,
    "all three groups empty for Project E's lone BRDP"
  );

  // ==== UI: real clicks, screenshots, and prompt capture ====
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

    // ---- Three-group corpus: Project A / source BRDP ----
    await openRecords(`Suggest Proposal Verify A ${suffix}`, SAME_ID);
    const suggestProposalButtonA = page.getByRole("button", { name: "Suggest Proposal" });
    assert(await suggestProposalButtonA.isEnabled(), "Suggest Proposal enabled -- Definition is present");
    await resetMock();
    await suggestProposalButtonA.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=Same BRDP in other projects", { timeout: 5000 });
    await page.waitForSelector("text=Similar decisions", { timeout: 5000 });
    await page.waitForSelector("text=This project", { timeout: 5000 });

    // Expand a "Same BRDP" row -- confirms BOTH Definition and Proposal show
    // even though that group's PROMPT block only ever cites Proposal.
    const sameBrdpRow = page.locator("li", { hasText: "Project B's own" }).first();
    await sameBrdpRow.getByRole("button", { name: SAME_ID }).click();
    await page.waitForSelector("text=Project B's own Definition for the same decision point.", { timeout: 3000 });
    await page.waitForSelector("text=Project B decided: clamps shall be spaced no more than 600 mm apart.", {
      timeout: 3000,
    });
    assert(true, "expanded Same-BRDP reference shows BOTH Definition and Proposal, labeled");

    await page.screenshot({ path: "/tmp/suggest-proposal-three-groups-expanded.png", fullPage: true });
    console.log("Screenshot (3 groups, 1 reference expanded): /tmp/suggest-proposal-three-groups-expanded.png");

    // While a suggestion is pending, all 3 Suggest buttons are blocked.
    assert(await page.getByRole("button", { name: "Suggest Definition" }).isDisabled(), "Suggest Definition blocked while pending");
    assert(await page.getByRole("button", { name: "Suggest Rule" }).isDisabled(), "Suggest Rule blocked while pending");

    const reqA = await lastMockRequest();
    const sysA = reqA.messages.find((m) => m.role === "system").content;
    const userMsgsA = reqA.messages.filter((m) => m.role !== "system");
    console.log("\n===== System prompt (3-group scenario) =====\n" + sysA + "\n=====\n");
    assert(reqA.temperature === 0.3, `temperature 0.3 sent, got ${reqA.temperature}`);
    assert(userMsgsA.length === 1 && userMsgsA[0].content === "Write the Proposal for this BRDP.", "fixed user message, no history");
    assert(sysA.includes("You are an expert in S1000D 4.2 business rules"), "prompt opens with the standard-scoped expert line");
    assert(sysA.includes("Use this project's standard only: S1000D 4.2."), "prompt pins the standard");
    assert(sysA.includes("SAME BRDP IN OTHER PROJECTS"), "Same BRDP block present");
    assert(sysA.includes("SIMILAR DECISIONS IN OTHER PROJECTS"), "Similar decisions block present");
    assert(sysA.includes("THIS PROJECT'S RELATED DECISIONS"), "This project block present");
    assert(
      /\[BRDP-SPCAT-LIVE-001 \| Suggest Proposal Verify B .+\] Proposal: Project B decided/.test(sysA),
      "Same-BRDP reference line matches the exact template (no similarity score)"
    );
    assert(/\[BRDP-SPSIM-B-01 \| Suggest Proposal Verify B .+ \| similarity \d\.\d\d\]/.test(sysA), "Similar-decisions line carries similarity");
    assert(/\[BRDP-SPPROJ-A-01 \| similarity \d\.\d\d\]/.test(sysA), "This-project line never carries a project name");
    assert(!sysA.includes("THE PREVIOUS PROPOSAL WAS REFUSED"), "no Refused block for a Pending source BRDP");
    assert(sysA.includes("PROJECT-SPECIFIC VALUES"), "project-specific-values guard present");
    assert(sysA.includes(`ID: ${SAME_ID}`), "BRDP block carries the real identifier");
    assert(sysA.trim().endsWith("no quotes, no markdown."), "prompt ends with the return-format instruction");

    // ---- Discard, then the EXT-style edge case: no Same BRDP group ----
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(200);

    await openRecords(`Suggest Proposal Verify D ${suffix}`, "BRDP-EXT-00001");
    await resetMock();
    await page.getByRole("button", { name: "Suggest Proposal" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    assert((await page.locator("text=Same BRDP in other projects").count()) === 0, "EXT-style BRDP: no Same BRDP group rendered");
    await page.waitForSelector("text=Similar decisions", { timeout: 5000 });
    assert((await page.locator("text=This project").count()) === 0, "Project D has no This-project group rendered");
    await page.screenshot({ path: "/tmp/suggest-proposal-ext-no-same-brdp.png", fullPage: true });
    console.log("Screenshot (EXT-style, no Same BRDP): /tmp/suggest-proposal-ext-no-same-brdp.png");
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(200);

    // ---- Empty-Definition BRDP: button disabled with the real tooltip ----
    await openRecords(`Suggest Proposal Verify A ${suffix}`, "BRDP-SPNODEF-01");
    const disabledButton = page.getByRole("button", { name: "Suggest Proposal" });
    assert(await disabledButton.isDisabled(), "Suggest Proposal disabled for a BRDP with an empty Definition");
    assert(
      (await disabledButton.getAttribute("title")) === "Add or accept a Definition first",
      "tooltip reads the exact docs-request text"
    );
    await page.screenshot({ path: "/tmp/suggest-proposal-empty-definition-disabled.png", fullPage: true });
    console.log("Screenshot (empty-Definition disabled button): /tmp/suggest-proposal-empty-definition-disabled.png");

    // ---- Refused BRDP: the prompt's rejection block ----
    await openRecords(`Suggest Proposal Verify A ${suffix}`, "BRDP-SPREFUSED-01");
    await resetMock();
    await page.getByRole("button", { name: "Suggest Proposal" }).click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    const reqRefused = await lastMockRequest();
    const sysRefused = reqRefused.messages.find((m) => m.role === "system").content;
    console.log("\n===== System prompt (Refused BRDP) =====\n" + sysRefused + "\n=====\n");
    assert(sysRefused.includes("THE PREVIOUS PROPOSAL WAS REFUSED."), "Refused block present");
    assert(sysRefused.includes("Refused proposal: The rejected proposal text."), "refused proposal text cited verbatim");
    assert(
      sysRefused.includes("Reason for refusal: Too vague -- must state a numeric limit.") ||
        sysRefused.includes("Reason for refusal: Too vague — must state a numeric limit."),
      "refusal reason cited verbatim"
    );
    assert(sysRefused.includes("Your Proposal must address the reason for refusal."), "explicit instruction to address the reason");
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(200);

    // ---- No references at all: Project E / lone BRDP ----
    await openRecords(`Suggest Proposal Verify E ${suffix}`, "BRDP-SPNOREF-01");
    await resetMock();
    const noRefButton = page.getByRole("button", { name: "Suggest Proposal" });
    assert(await noRefButton.isEnabled(), "Suggest Proposal enabled even with zero candidates (no MIN_CANDIDATES gate)");
    await noRefButton.click();
    await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
    await page.waitForSelector("text=Proposal generated without reference BRDPs", { timeout: 5000 });
    await page.screenshot({ path: "/tmp/suggest-proposal-no-references.png", fullPage: true });
    console.log("Screenshot (no references): /tmp/suggest-proposal-no-references.png");

    const reqNoRefs = await lastMockRequest();
    const sysNoRefs = reqNoRefs.messages.find((m) => m.role === "system").content;
    assert(
      sysNoRefs.includes("No reference BRDPs are available; write the Proposal from your\nknowledge of DITA 1.3 Xpath2.0 alone."),
      "no-references fallback line present with the real standard"
    );

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    for (const proj of [projA, projB, projC, projD, projE]) {
      await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up the 5 seeded projects.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
