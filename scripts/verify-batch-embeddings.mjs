// Live verification for "Embeddings por lotes en el job" (docs request):
// real backend, real Postgres, real mock-mistral-embed-server.mjs (now
// batch-aware -- returns one item per input text, reversed order, so a
// real end-to-end run exercises the same index-based reordering logic
// the pytest-level tests already cover). No browser/Playwright needed --
// this closure is about request COUNTS and job completion, not UI.
//
// Confirms directly against the real running dev stack:
//   1. 63 pending Validated BRDPs -> exactly 2 real embedding requests
//      (32 + 31), never 63.
//   2. 1 pending Validated BRDP -> exactly 1 real embedding request.
//   3. Both jobs complete with the correct brdps_embedded count and leave
//      nothing pending afterward.
//
// Vector-to-row assignment correctness (docs request's other closing
// check) is verified more rigorously at the pytest level instead
// (test_embedding_jobs.py::test_batch_assigns_the_vector_matching_each_
// brdps_own_text, with a deliberately out-of-order mock response) --
// there is no API surface that exposes a stored embedding vector to
// inspect from outside the backend, so pytest (which can read the column
// directly) is the right tool for that specific check, not this script.

const API = "http://localhost:8000";
const MOCK_EMBED = "http://localhost:8901";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function embedCallCount() {
  return (await fetch(`${MOCK_EMBED}/calls`).then((r) => r.json())).count;
}

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  return (await res.json()).access_token;
}

async function computeAndWait(auth, projectId) {
  const resp = await fetch(`${API}/api/projects/${projectId}/embeddings/compute`, {
    method: "POST",
    headers: auth,
  });
  if (resp.status !== 202) throw new Error(`POST /compute expected 202, got ${resp.status}`);
  const { job_id } = await resp.json();

  for (let i = 0; i < 40; i++) {
    const statusResp = await fetch(`${API}/api/projects/${projectId}/embeddings/status/${job_id}`, {
      headers: auth,
    });
    const body = await statusResp.json();
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Embedding job ${job_id} never left 'running' status`);
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const suffix = Math.random().toString(36).slice(2, 8);

  // ---- 1. 63 pending BRDPs -> exactly 2 requests (32 + 31) ----
  const projA = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Batch Embeddings Test 63 ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  for (let i = 0; i < 63; i++) {
    await fetch(`${API}/api/projects/${projA.id}/brdps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        identifier: `BRDP-BATCH63-${i}`,
        title: `Title ${i}`,
        definition: `Definition ${i}`,
        proposal: `Proposal ${i}`,
        validation: "Validated",
      }),
    }).then((r) => r.json());
  }
  console.log("Seeded 63 Validated BRDPs in Project A");

  await fetch(`${MOCK_EMBED}/reset-calls`, { method: "POST" });
  assert((await embedCallCount()) === 0, "mock call counter reset to 0 before the 63-item job");

  const jobA = await computeAndWait(auth, projA.id);
  assert(jobA.status === "completed", `63-item job completed (got status=${jobA.status}, error=${jobA.error})`);
  assert(jobA.result.brdps_embedded === 63, `job embedded all 63 BRDPs (got ${jobA.result.brdps_embedded})`);

  const callsAfter63 = await embedCallCount();
  console.log("Mock embedding requests for 63 pending BRDPs:", callsAfter63);
  assert(callsAfter63 === 2, `63 pending BRDPs made exactly 2 requests (32 + 31), got ${callsAfter63}`);

  const pendingAfter63 = await fetch(`${API}/api/projects/${projA.id}/embeddings/pending`, { headers: auth }).then(
    (r) => r.json()
  );
  assert(
    pendingAfter63.project_pending === 0,
    `nothing left pending in Project A after the batch job (got ${pendingAfter63.project_pending})`
  );

  // ---- 2. 1 pending BRDP -> exactly 1 request ----
  const projB = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `Batch Embeddings Test 1 ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());

  await fetch(`${API}/api/projects/${projB.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-BATCH1-0",
      title: "Solo title",
      definition: "Solo definition",
      proposal: "Solo proposal",
      validation: "Validated",
    }),
  }).then((r) => r.json());
  console.log("Seeded 1 Validated BRDP in Project B");

  await fetch(`${MOCK_EMBED}/reset-calls`, { method: "POST" });
  assert((await embedCallCount()) === 0, "mock call counter reset to 0 before the 1-item job");

  const jobB = await computeAndWait(auth, projB.id);
  assert(jobB.status === "completed", `1-item job completed (got status=${jobB.status}, error=${jobB.error})`);
  assert(jobB.result.brdps_embedded === 1, `job embedded the 1 BRDP (got ${jobB.result.brdps_embedded})`);

  const callsAfter1 = await embedCallCount();
  console.log("Mock embedding requests for 1 pending BRDP:", callsAfter1);
  assert(callsAfter1 === 1, `1 pending BRDP made exactly 1 request, got ${callsAfter1}`);

  // ---- cleanup ----
  await fetch(`${API}/api/projects/${projA.id}`, { method: "DELETE", headers: auth });
  await fetch(`${API}/api/projects/${projB.id}`, { method: "DELETE", headers: auth });
  console.log("Cleaned up both test projects.");

  console.log("\nALL CHECKS PASSED\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
