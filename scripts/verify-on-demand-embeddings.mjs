// End-to-end verification for "Embeddings bajo demanda" (docs request):
// real Chromium, real Vite dev server, real backend, real Postgres.
// Mistral is mocked at the HTTP transport level only (this sandbox cannot
// reach api.mistral.ai at all -- same documented limitation as the Ask a
// Question rounds): mock-mistral-embed-server-delayed.mjs on :8901 (the
// endpoint .env already points at) adds a deliberate per-call delay so
// the embedding_jobs run's "running" state (progress bar + ETA) is
// actually observable instead of completing between one poll and the
// next; mock-mistral-chat-server.mjs on :8902 (uvicorn started with
// MISTRAL_ENDPOINT overridden to it) backs the one real Suggest call this
// script makes, to observe the excluded_pending_other_projects notice.
//
// Covers, against real data (no mocking of Postgres/the app itself):
//   1. A real Excel import of Validated rows triggers ZERO Mistral calls.
//   2. The pending banner + "Compute embeddings" button appear with the
//      real count, and Suggest is disabled while pending.
//   3. Running the job shows real progress (processed/total) and an ETA,
//      completes, and the banner/button disappear afterward.
//   4. A Validated-but-pending BRDP in ANOTHER project of the same
//      standard is surfaced via the "excluded" notice on Suggest.
//
// Usage: start mock-mistral-embed-server-delayed.mjs (:8901) and
// mock-mistral-chat-server.mjs (:8902), start uvicorn with
// MISTRAL_ENDPOINT=http://localhost:8902 (MISTRAL_EMBED_ENDPOINT already
// points at :8901 by default in .env), then `node
// scripts/verify-on-demand-embeddings.mjs`. Pass KEEP=1 to skip deleting
// the two test projects afterward (for manual/DB inspection).
import { chromium } from "playwright-core";
import XLSX from "xlsx";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK_EMBED = "http://localhost:8901";
const MOCK_CHAT = "http://localhost:8902";
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
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

function buildImportXlsx(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "BRDPs");
  const tmpPath = path.join(os.tmpdir(), `on-demand-embeddings-import-${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tmpPath);
  return tmpPath;
}

async function main() {
  await fetch(`${MOCK_EMBED}/reset-calls`, { method: "POST" });
  await fetch(`${MOCK_CHAT}/reset`, { method: "POST" });
  assert((await embedCallCount()) === 0, "mock Mistral embeddings call counter reset to 0");

  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const suffix = Math.random().toString(36).slice(2, 8);
  const projA = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `On-Demand Embeddings Test A ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());
  const projB = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: `On-Demand Embeddings Test B (other) ${suffix}`, standard: "S1000D 4.2" }),
  }).then((r) => r.json());
  console.log(`Project A (own): ${projA.id}\nProject B (other): ${projB.id}`);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser console error]", msg.text());
  });

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    // ---- 1. Real import of 5 Validated rows: zero Mistral calls ----
    const importRows = Array.from({ length: 5 }, (_, i) => ({
      ID: `BRDP-EMB-A-${i}`,
      Title: `Title ${i}`,
      Definition: `Definition text ${i}`,
      Proposal: `Proposal text ${i}`,
      "Proposal Status": "Validated",
      "Rule Status": "To Do",
      Rule: "",
    }));
    const xlsxPath = buildImportXlsx(importRows);

    await page.goto(`${BASE_URL}/projects/${projA.id}/config`);
    await page.waitForSelector("text=Import BRDPs from Excel", { timeout: 10000 });
    await page.locator('input[type="file"]').setInputFiles(xlsxPath);
    await page.waitForSelector('button:has-text("Apply import")', { timeout: 15000 });
    await page.click('button:has-text("Apply import")');
    await page.waitForSelector("text=Import complete", { timeout: 30000 });
    const resultText = await page.locator("ul").filter({ hasText: /created/i }).first().innerText();
    console.log("Import result:", resultText.replace(/\n/g, " | "));
    assert(/5 BRDPs created/i.test(resultText), "import created all 5 BRDPs");

    const callsAfterImport = await embedCallCount();
    console.log("Mock Mistral embed calls after import:", callsAfterImport);
    assert(callsAfterImport === 0, `import triggered ZERO real embedding calls (got ${callsAfterImport})`);

    fs.unlinkSync(xlsxPath);

    // Confirm via the real API too, not just the UI's own summary.
    const pendingAfterImport = await fetch(`${API}/api/projects/${projA.id}/embeddings/pending`, {
      headers: auth,
    }).then((r) => r.json());
    console.log("Pending after import (API):", pendingAfterImport);
    assert(pendingAfterImport.project_pending === 5, "all 5 imported Validated BRDPs are pending (no embedding call happened)");

    // ---- Seed Project B ("other project"): 2 Validated, pending BRDPs ----
    for (let i = 0; i < 2; i++) {
      await fetch(`${API}/api/projects/${projB.id}/brdps`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          identifier: `BRDP-EMB-B-${i}`,
          title: `Other project title ${i}`,
          definition: `Other project definition ${i}`,
          proposal: `Other project proposal ${i}`,
          validation: "Validated",
        }),
      }).then((r) => r.json());
    }
    console.log("Seeded 2 Validated, pending BRDPs in Project B");

    // ---- 2. Records page: pending banner + button visible, Suggest disabled ----
    await page.goto(`${BASE_URL}/projects/${projA.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.locator("tr", { hasText: "BRDP-EMB-A-0" }).click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

    await page.waitForSelector("text=/pending embedding/i", { timeout: 10000 });
    const bannerText = await page.locator("text=/pending embedding/i").first().innerText();
    console.log("Pending banner text:", bannerText);
    assert(/5 BRDPs pending embedding/i.test(bannerText), `pending banner shows the real count (got "${bannerText}")`);

    const computeButton = page.getByRole("button", { name: "Compute embeddings" });
    await computeButton.waitFor({ state: "visible", timeout: 5000 });
    console.log("OK: 'Compute embeddings' button visible");

    const suggestDefButton = page.getByRole("button", { name: "Suggest Definition" });
    assert(await suggestDefButton.isDisabled(), "Suggest Definition is disabled while embeddings are pending");
    const suggestPropButton = page.getByRole("button", { name: "Suggest Proposal" });
    assert(await suggestPropButton.isDisabled(), "Suggest Proposal is disabled while embeddings are pending");
    const suggestRuleButton = page.getByRole("button", { name: "Suggest Rule" });
    assert(await suggestRuleButton.isDisabled(), "Suggest Rule is disabled while embeddings are pending");

    await page.screenshot({ path: "/tmp/embeddings-pending-banner.png" });

    // ---- 3. Launch the job: real progress + ETA while running, then completes ----
    await computeButton.click();

    await page.waitForSelector("text=/Computing embeddings/i", { timeout: 5000 });
    console.log("OK: job-running message visible");
    const progressEl = page.locator("progress");
    await progressEl.waitFor({ state: "visible", timeout: 5000 });
    console.log("OK: progress bar visible");
    await page.screenshot({ path: "/tmp/embeddings-job-running.png" });

    // At least one poll tick should show partial progress (processed > 0,
    // < total) given the delayed mock -- confirms this is REAL progress,
    // not a bar that jumps straight from 0 to done.
    let sawPartialProgress = false;
    for (let i = 0; i < 20; i++) {
      const [value, max] = await progressEl.evaluate((el) => [el.value, el.max]).catch(() => [null, null]);
      if (value !== null && max !== null && value > 0 && value < max) {
        sawPartialProgress = true;
        console.log(`Observed partial progress: ${value} / ${max}`);
        break;
      }
      if ((await page.locator("text=/Computing embeddings/i").count()) === 0) break; // finished already
      await page.waitForTimeout(200);
    }
    assert(sawPartialProgress, "progress bar showed a genuine partial value (not just 0 or done) while the job ran");

    const etaText = await page
      .locator("text=/remaining|Estimating time/i")
      .first()
      .innerText()
      .catch(() => null);
    console.log("ETA text observed:", etaText);
    assert(!!etaText, "an ETA/estimating message was shown while the job ran");

    // Job must finish -- wait for the RUNNING-state text itself to
    // disappear (not the pending-banner text, which is already gone the
    // moment the job starts, since it's replaced by "Computing
    // embeddings…" -- waiting on that instead would resolve immediately
    // and race ahead of the job actually finishing).
    await page.waitForSelector("text=/Computing embeddings/i", { state: "detached", timeout: 20000 });
    await page.waitForSelector("text=/pending embedding/i", { state: "detached", timeout: 5000 });
    await page.waitForSelector('button:has-text("Compute embeddings")', { state: "detached", timeout: 5000 });
    console.log("OK: job finished; pending banner and 'Compute embeddings' button are gone");

    const callsAfterCompute = await embedCallCount();
    console.log("Mock Mistral embed calls after compute:", callsAfterCompute);
    assert(callsAfterCompute === 5, `exactly 5 real embedding calls happened (one per pending BRDP), got ${callsAfterCompute}`);

    const pendingAfterComputeResp = await fetch(`${API}/api/projects/${projA.id}/embeddings/pending`, {
      headers: auth,
    });
    const pendingAfterCompute = await pendingAfterComputeResp.json();
    console.log("Pending after compute (API):", pendingAfterComputeResp.status, pendingAfterCompute);
    assert(
      pendingAfterCompute.project_pending === 0 && pendingAfterCompute.catalog_pending === 0,
      "GET /pending confirms nothing left pending for Project A"
    );

    // Suggest buttons are now enabled (embeddings no longer pending).
    assert(!(await suggestDefButton.isDisabled()), "Suggest Definition is enabled once nothing is pending");

    await page.screenshot({ path: "/tmp/embeddings-job-completed.png" });

    // ---- 4. Suggest surfaces the "other project" exclusion notice ----
    await suggestDefButton.click();
    await page.waitForSelector("text=/from other projects excluded/i", { timeout: 15000 });
    const excludedText = await page.locator("text=/from other projects excluded/i").first().innerText();
    console.log("Exclusion notice text:", excludedText);
    assert(/2 BRDPs from other projects excluded: pending embedding/i.test(excludedText), `exclusion notice names the real count from Project B (got "${excludedText}")`);

    await page.screenshot({ path: "/tmp/embeddings-excluded-notice.png" });

    console.log("\nALL CHECKS PASSED\n");
  } finally {
    await browser.close();
    if (!process.env.KEEP) {
      await fetch(`${API}/api/projects/${projA.id}`, { method: "DELETE", headers: auth });
      await fetch(`${API}/api/projects/${projB.id}`, { method: "DELETE", headers: auth });
      console.log("Cleaned up both test projects.");
    } else {
      console.log(`KEEP set -- left Project A (${projA.id}) and Project B (${projB.id}) in place.`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
