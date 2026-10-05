// Live verification for "Nombres con prefijo, esquema del test por atributos
// y scroll en Generar", against the real app (Vite + FastAPI + Postgres).
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// 1. Prefixed names: a 3.0.1 BRDP shaped like SOPTE's BRDP-EXT-02772
//    (@xsi:noNamespaceSchemaLocation in Definition and Proposal) shows no
//    red warning; @xlink:href / <xsl:template> neither; <emphasys> beside
//    them still warns with "did you mean <emphasis>".
// 2. Attribute-only rules: "Test rule" on S1-00151 (//@materialUsage) writes
//    its examples in proced, inside <preliminaryRqmts>, and on S1-00563
//    (//@timeLimitCategoryValue) in schedul; both verdicts correct.
// 3. Generate of a SOPTE-scale project (2818 rules, seeded by
//    backend/scripts/seed_generate_report_scale.py) at 1366x768 with the
//    three schema-URL report blocks open: the page scrolls down to the XML
//    and to "Download"; each block's list has its own scroll; the XML box
//    keeps its own scroll.
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running, Vite
// on 5173, and the scale project seeded:
//     cd backend && .venv/bin/python scripts/seed_generate_report_scale.py
// Cleans up the projects it creates (not the seeded one: run the seed script
// with "cleanup"). Screenshots go to the OS temp dir.
//
//     node scripts/verify-prefix-attr-scroll.mjs            (all)
//     node scripts/verify-prefix-attr-scroll.mjs generate   (part 3 only)
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const SCALE_PROJECT = "Generate Report Scale Verification";
const shot = (name) => path.join(os.tmpdir(), name);
const ONLY_GENERATE = process.argv[2] === "generate";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const R151 = `<structureObjectRule id="BRDP-S1-00151">
  <objectPath allowedObjectFlag="0">//@materialUsage</objectPath>
  <objectUse>The attribute @materialUsage must not be used.</objectUse>
</structureObjectRule>`;
const R563 = `<structureObjectRule id="BRDP-S1-00563">
  <objectPath allowedObjectFlag="2">//@timeLimitCategoryValue</objectPath>
  <objectUse>Only time limit category 1 is used.</objectUse>
  <objectValue valueForm="single" valueAllowed="1"/>
</structureObjectRule>`;

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (p, init = {}) => fetch(`${API}${p}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);
  const projects = [];
  async function makeProject(name, standard) {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `${name} ${suffix}`, standard }) }).then((r) => r.json());
    projects.push(p);
    return p;
  }
  const makeBrdp = (p, fields) => api(`/api/projects/${p.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
  async function putDraft(p, b, format, rule_xml) {
    const r = await api(`/api/projects/${p.id}/brdps/${b.id}/approvals/${format}`, { method: "PUT", body: JSON.stringify({ rule_xml, source: "manual", status: "pending_review" }) });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
  }
  async function embed(p) {
    const job = await api(`/api/projects/${p.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
    for (let i = 0; i < 80; i++) {
      const s = await api(`/api/projects/${p.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
      if (s.status !== "running") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const scale = (await api("/api/projects").then((r) => r.json())).find((p) => p.name === SCALE_PROJECT);
  if (!scale) throw new Error("Seed the scale project first: cd backend && .venv/bin/python scripts/seed_generate_report_scale.py");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  async function login(page) {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("header select, nav select").first().selectOption("en");
    await page.waitForTimeout(300);
  }
  async function select(page, identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForSelector("text=/BRDP Assistant/i", { timeout: 5000 });
    await page.waitForTimeout(600);
  }

  try {
    if (!ONLY_GENERATE) {
      // ---- 1. prefixed names ----
      const p301 = await makeProject("Prefixed names 3.0.1", "S1000D 3.0.1");
      await makeBrdp(p301, {
        identifier: "BRDP-EXT-02772",
        title: "Schemas allowed for data modules",
        definition: "Decide which schemas the data modules may declare in @xsi:noNamespaceSchemaLocation.",
        proposal: "The @xsi:noNamespaceSchemaLocation of every data module points to an S1000D 3.0.1 DM schema, flat or master.",
      });
      await makeBrdp(p301, {
        identifier: "BRDP-PFX-OTHER",
        title: "Links and stylesheets",
        definition: "Cross-references use @xlink:href; the stylesheet's <xsl:template> elements are out of scope.",
        proposal: "Nothing to decide.",
      });
      await makeBrdp(p301, {
        identifier: "BRDP-PFX-TYPO",
        title: "Schema location and emphasis",
        definition: "Keep @xsi:noNamespaceSchemaLocation and do not use <emphasys> in warnings.",
        proposal: "Nothing to decide.",
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
      await login(page);
      await page.goto(`${BASE_URL}/projects/${p301.id}/records`);
      await page.waitForSelector("tbody tr", { timeout: 20000 });
      for (const id of ["BRDP-EXT-02772", "BRDP-PFX-OTHER"]) {
        await select(page, id);
        await page.waitForTimeout(600);
        assert((await page.locator("text=/mentions names not found/").count()) === 0, `${id}: no red warning`);
        assert((await page.getByTestId("name-fix-suggestion").count()) === 0 && (await page.getByTestId("name-did-you-mean").count()) === 0, `${id}: no chip, no suggestion`);
      }
      await page.screenshot({ path: shot("prefixed-names-no-warning.png"), fullPage: true });
      await select(page, "BRDP-PFX-TYPO");
      const line = page.getByTestId("name-did-you-mean");
      await line.waitFor({ timeout: 5000 });
      const red = await page.locator("text=/mentions names not found/").first().textContent();
      assert(red.includes("<emphasys>") && !/xsi|noNamespaceSchemaLocation/.test(red), `<emphasys> still warns, the prefixed name does not (${red})`);
      assert((await line.textContent()).includes("did you mean <emphasis>?"), "did you mean <emphasis>? under it");
      await page.close();

      // ---- 2. attribute-only rules ----
      const p42 = await makeProject("Attribute-only rules 4.2", "S1000D 4.2");
      const b151 = await makeBrdp(p42, { identifier: "BRDP-S1-00151", title: "Material usage", definition: "Use of the attribute @materialUsage.", proposal: "The attribute @materialUsage is not used." });
      const b563 = await makeBrdp(p42, { identifier: "BRDP-S1-00563", title: "Time limit category", definition: "Use of the time limit category.", proposal: "Only hard time limits (category 1) are used." });
      await putDraft(p42, b151, "BREX-4.2", R151);
      await putDraft(p42, b563, "BREX-4.2", R563);
      await embed(p42);
      const rt = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
      await login(rt);
      await rt.goto(`${BASE_URL}/projects/${p42.id}/records`);
      await rt.waitForSelector("tbody tr", { timeout: 20000 });
      const lastSystem = async () => (await fetch(`${MOCK}/last-request`).then((r) => r.json())).messages.find((m) => m.role === "system").content;
      for (const [id, schema, carrier, file] of [
        ["BRDP-S1-00151", "proced", "<supportEquipDescr", "rule-test-attribute-only-material-usage.png"],
        ["BRDP-S1-00563", "schedul", "<timeLimitCategory", "rule-test-attribute-only-time-limit.png"],
      ]) {
        await select(rt, id);
        await rt.getByRole("button", { name: "Test rule" }).click();
        const verdict = rt.getByTestId("rule-test-verdict");
        await verdict.waitFor({ timeout: 20000 });
        const sys = await lastSystem();
        assert(sys.includes(`"schema": "${schema}"`), `${id}: the prompt uses ${schema}`);
        assert((await verdict.textContent()).startsWith("Correct"), `${id}: verdict correct (${await verdict.textContent()})`);
        const x0 = await rt.getByTestId("rule-test-example-0").locator("pre").textContent();
        assert(x0.includes(carrier) && x0.includes(`${schema}.xsd`), `${id}: the example is a ${schema} DM with ${carrier}>`);
        if (id === "BRDP-S1-00151") assert(x0.includes("<preliminaryRqmts"), "S1-00151: inside <preliminaryRqmts>");
        await rt.getByTestId("rule-test-panel").screenshot({ path: shot(file) });
        await rt.getByRole("button", { name: "Close" }).first().click().catch(() => {});
      }
      await rt.close();
    }

    // ---- 3. Generate scroll at 1366x768 ----
    const g = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await login(g);
    // Found while verifying: a click before the project's approved rules
    // arrived generated a BREX with no rule at all, silently. Generate now
    // waits for them (loading hint), and a failed load is shown.
    await g.route("**/approvals/*/export", async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await g.goto(`${BASE_URL}/projects/${scale.id}/generate`);
    const btn = g.locator('button:has-text("Generate")').first();
    await btn.waitFor({ timeout: 10000 });
    await g.getByTestId("generate-rules-loading").waitFor({ timeout: 5000 });
    assert(await btn.isDisabled(), "Generate disabled while the rules load, with the loading hint");
    await g.getByTestId("generate-rules-loading").waitFor({ state: "detached", timeout: 60000 });
    assert(await btn.isEnabled(), "Generate enabled once the rules are loaded");
    {
      const e = await browser.newPage({ viewport: { width: 1366, height: 768 } });
      await login(e);
      await e.route("**/approvals/*/export", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"boom"}' }));
      await e.goto(`${BASE_URL}/projects/${scale.id}/generate`);
      const err = e.getByTestId("generate-rules-error");
      await err.waitFor({ timeout: 10000 });
      assert((await err.textContent()).includes("could not be loaded") && (await e.locator('button:has-text("Generate")').first().isDisabled()), "a failed load is shown and Generate stays disabled");
      await e.close();
    }
    await btn.click();
    await g.waitForSelector("pre", { timeout: 180000 });
    await g.waitForSelector("text=/Valid against XSD schema|XSD validation issue|XSD validation failed/", { timeout: 180000 });
    const blocks = ["schema-urls-rewritten", "schema-urls-mixed", "schema-urls-unrecognized"];
    try {
      await g.getByTestId("schema-urls-rewritten").waitFor({ state: "attached", timeout: 180000 });
    } catch (err) {
      await g.screenshot({ path: shot("generate-report-missing.png") });
      throw err;
    }
    for (const id of blocks) {
      const d = g.getByTestId(id);
      if (!(await d.evaluate((el) => el.open))) await d.locator("summary").click();
    }
    for (const id of blocks) assert(await g.getByTestId(id).evaluate((el) => el.open), `${id}: open`);
    const lists = await Promise.all(blocks.map((id) => g.getByTestId(id).locator("ul").first().evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight, oy: getComputedStyle(el).overflowY }))));
    lists.forEach((l, i) => assert(l.h <= 222 && l.sh > l.h && l.oy === "auto", `${blocks[i]}: list capped with its own scroll (${l.h}px of ${l.sh}px)`));
    await g.screenshot({ path: shot("generate-report-top.png") });
    const pageBox = g.locator("[class*='page']").filter({ has: g.locator("pre") }).first();
    const scroll = await pageBox.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    assert(scroll.sh > scroll.ch, `the page scrolls (${scroll.ch}px shown of ${scroll.sh}px)`);
    // Scroll with the wheel, like a user, until the end -- over the page's
    // own margin (over a report list the wheel scrolls that list first).
    const pb = await pageBox.boundingBox();
    await g.mouse.move(pb.x + 10, pb.y + 300);
    for (let i = 0; i < 40; i++) await g.mouse.wheel(0, 400);
    await g.waitForTimeout(400);
    const dl = g.getByRole("button", { name: "Download" });
    const box = await dl.boundingBox();
    assert(box && box.y >= 0 && box.y + box.height <= 768, `"Download" reached by scrolling, inside the window (y=${box && Math.round(box.y)})`);
    const copy = await g.getByRole("button", { name: /Copy/ }).boundingBox();
    assert(copy && copy.y + copy.height <= 768, '"Copy to clipboard" reached too');
    const pre = await g.locator("pre").evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight, sw: el.scrollWidth, cw: el.clientWidth, o: getComputedStyle(el).overflow }));
    assert(pre.h >= 300 && pre.sh > pre.h && pre.o === "auto", `the XML box keeps its own scroll (${pre.h}px of ${pre.sh}px)`);
    const preTop = await g.locator("pre").boundingBox();
    assert(preTop.y < 768 && preTop.y + preTop.height > 0, "the XML box is on screen at the end");
    await g.screenshot({ path: shot("generate-report-bottom.png") });
    // Folding still works.
    await g.getByTestId("schema-urls-rewritten").locator("summary").click();
    assert(!(await g.getByTestId("schema-urls-rewritten").evaluate((el) => el.open)), "a block can still be folded");
    await g.close();
  } finally {
    await browser.close();
    for (const p of projects) await api(`/api/projects/${p.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
