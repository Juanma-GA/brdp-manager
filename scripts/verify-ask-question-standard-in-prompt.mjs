// Verification for: buildAskSystemPrompt (RecordsPage.jsx) now includes
// the project's real standard, so the LLM stops hedging between S1000D
// and DITA vocabulary (the bug reported: "<originator> in S1000D or
// <prodinfo> in DITA" on an unambiguously S1000D project).
//
// buildAskSystemPrompt is a module-private function inside RecordsPage.jsx
// (not exported), and this repo has no JS unit-test runner (CLAUDE.md:
// "no hay test runner JS... no inventar un framework de test nuevo") -- so
// this captures the REAL prompt the app builds and sends, through the real
// code path, for two projects of genuinely different standards (S1000D
// 3.0.1 and DITA 1.3 Xpath3.0, the two edge cases the docs request names
// explicitly), via the same mock-mistral-chat-server.mjs / GET
// /last-request mechanism already established in the previous two Ask a
// Question rounds.
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
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
  await fetch(`${MOCK}/reset`, { method: "POST" });
}

async function lastMockRequest() {
  return fetch(`${MOCK}/last-request`).then((r) => r.json());
}

async function main() {
  const token = await apiLogin();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const projA = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Standard-In-Prompt Test - S1000D 3.0.1", standard: "S1000D 3.0.1" }),
  }).then((r) => r.json());
  const projB = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Standard-In-Prompt Test - DITA Xpath3.0", standard: "DITA 1.3 Xpath3.0" }),
  }).then((r) => r.json());
  console.log("Seeded two real projects:", projA.standard, "/", projB.standard);

  const brdpA = await fetch(`${API}/api/projects/${projA.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-STD-A",
      title: "301 objrule test",
      definition: "Definition for the standard-in-prompt verification (S1000D 3.0.1).",
      proposal: "Proposal text.",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  const brdpB = await fetch(`${API}/api/projects/${projB.id}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      identifier: "BRDP-STD-B",
      title: "DITA Xpath3.0 test",
      definition: "Definition for the standard-in-prompt verification (DITA 1.3 Xpath3.0).",
      proposal: "Proposal text.",
      validation: "Pending",
    }),
  }).then((r) => r.json());
  console.log("Seeded BRDP-STD-A/B, one per project");

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);

    async function askAndCapture(projectName, brdpIdentifier, question) {
      await page.goto(`${BASE_URL}/projects`);
      await page.waitForSelector("table", { timeout: 10000 });
      const row = page.locator("tr", { hasText: projectName });
      await row.getByRole("button", { name: /Records/i }).click();
      await page.waitForURL(/\/projects\/.+\/records/, { timeout: 10000 });
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      await page.locator("tr", { hasText: brdpIdentifier }).click();
      await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });

      const askTextarea = page.locator("label", { hasText: "Ask a question" }).locator("xpath=following::textarea[1]");
      const askButton = page.getByRole("button", { name: /^Ask$/ });

      await resetMock();
      await askTextarea.fill(question);
      await askButton.click();
      await page.waitForSelector("text=/MOCK-/", { timeout: 15000 });
      const req = await lastMockRequest();
      return req.messages.find((m) => m.role === "system").content;
    }

    // ---- Project A: S1000D 3.0.1 ----
    const sysA = await askAndCapture(
      "Standard-In-Prompt Test - S1000D 3.0.1",
      "BRDP-STD-A",
      "What does this rule do?"
    );
    console.log("\n===== System prompt captured for S1000D 3.0.1 =====\n" + sysA + "\n=====\n");
    assert(sysA.includes("This project uses the standard: S1000D 3.0.1."), "S1000D 3.0.1 project: prompt names the exact standard string");
    assert(
      sysA.includes("do not mix in other versions\nof S1000D or DITA unless the user explicitly asks for a comparison"),
      "S1000D 3.0.1 project: prompt carries the exact 'do not mix versions' instruction from the docs request"
    );

    // ---- Project B: DITA 1.3 Xpath3.0 ----
    const sysB = await askAndCapture(
      "Standard-In-Prompt Test - DITA Xpath3.0",
      "BRDP-STD-B",
      "What does this rule do?"
    );
    console.log("\n===== System prompt captured for DITA 1.3 Xpath3.0 =====\n" + sysB + "\n=====\n");
    assert(sysB.includes("This project uses the standard: DITA 1.3 Xpath3.0."), "DITA 1.3 Xpath3.0 project: prompt names the exact standard string, INCLUDING the XPath dialect part");
    assert(sysB !== sysA, "The two prompts genuinely differ (not a hardcoded/static string)");
    assert(!sysB.includes("S1000D 3.0.1"), "DITA project's prompt never mentions the other project's standard");
    assert(!sysA.includes("DITA 1.3 Xpath3.0"), "S1000D project's prompt never mentions the other project's standard");

    console.log("\nALL CHECKS PASSED");
  } finally {
    for (const proj of [projA, projB]) {
      await fetch(`${API}/api/projects/${proj.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
    console.log("Cleaned up the two seeded projects (and their BRDPs, cascade)");
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
