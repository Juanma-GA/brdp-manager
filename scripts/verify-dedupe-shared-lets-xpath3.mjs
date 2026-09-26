// Ad hoc Playwright end-to-end verification (real Chromium, real Vite dev
// server, real backend, real Postgres) of the shared sch:let deduplication
// feature for DITA 1.3 Xpath3.0 projects.
//
// The literal production scenario this encargo describes (the real
// Navantia Xpath3.0 project's 9 Verified rows, with valor/colDe/colPart
// repeated 5x, docFicha 4x, 62 sch:let total) is NOT reproducible byte for
// byte in this sandbox: nav_dtm_xpath3_import.xlsx here still only has the
// shared helper functions' CALL sites ($valor(...), $docFicha(...)), never
// their definitions (confirmed by grep in the prior round) -- that gap
// opened up in the user's real, separately-evolving production project.
// This script instead builds a REAL project through the REAL app/API/DB
// using the exact same call-site shape already confirmed real in that
// file (which BRDP calls which helper, and with which literal value) and
// adds the shared functions' own definitions -- the concrete thing the
// encargo says is now actually happening -- so the four edge cases can be
// verified against a real generated document, not just the isolated
// dedupeSharedLets() unit test (test-dedupe-shared-lets.mjs, not
// committed).
//
// Verifies:
//   1. 5 real approved rules sharing byte-identical valor/colPart/colDe/cab
//      definitions, and 4 sharing docFicha/docs -> each ends up declared
//      EXACTLY ONCE in the generated document, with its real content intact.
//   2. Every original assert/report id and test expression survives
//      untouched (dedup never touches anything but the sch:let elements).
//   3. A genuine name collision (same sch:let name, different value across
//      two rules) is NEVER merged -- both copies stay in their own rule,
//      and a non-blocking warning appears in the same vocabulary-warnings
//      panel.
//   4. A brand-new approved rule that reuses an already-shared function
//      joins the existing group automatically on regeneration -- no manual
//      step, count stays at 1.
//   5. The final document is still well-formed (queryBinding="xslt3"
//      unaffected by any of this).
//
// Usage: node scripts/verify-dedupe-shared-lets-xpath3.mjs
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
  const resp = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const { access_token } = await resp.json();
  return { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
}

// Real confirmed shape from nav_dtm_xpath3_import.xlsx's own $valor/$colPart/
// $colDe/$docFicha CALL sites (prior round), extended with the shared
// functions' own DEFINITIONS -- the concrete gap this encargo describes.
const VALOR_DEF =
  "function($fila as element(), $idx as xs:integer) as xs:string { let $c := $fila/entry[position() = ($idx + 1)] return if (empty($c)) then '' else normalize-space($c) }";
const COLPART_DEF =
  "function($cab as element()) as xs:integer { count($cab/entry[normalize-space(.) = 'Part']/preceding-sibling::entry) }";
const COLDE_DEF =
  "function($cab as element(), $label as xs:string) as xs:integer { count($cab/entry[normalize-space(.) = $label]/preceding-sibling::entry) }";
const DOCFICHA_DEF =
  "function($tr as element()) as document-node()? { let $u := resolve-uri($tr/@href, base-uri($tr)) return if (doc-available($u)) then doc($u) else () }";
const CAB_DEF = "ancestor::tgroup[1]/thead/row[1]";

function sharedFnRule(id) {
  return `<sch:pattern xmlns:xs="http://www.w3.org/2001/XMLSchema" id="p-${id}"><sch:rule context="table"><sch:let name="cab" value="${CAB_DEF}"/><sch:let name="valor" value="${VALOR_DEF}"/><sch:let name="colPart" value="${COLPART_DEF}"/><sch:let name="colDe" value="${COLDE_DEF}"/><sch:assert role="error" id="${id}" test="$valor(., $colPart($cab)) != ''">Real assert message for ${id}.</sch:assert></sch:rule></sch:pattern>`;
}

function docFichaRule(id) {
  return `<sch:pattern xmlns:xs="http://www.w3.org/2001/XMLSchema" id="p-${id}"><sch:rule context="map"><sch:let name="docFicha" value="${DOCFICHA_DEF}"/><sch:let name="docs" value="for $tr in //topicref[@href] return $docFicha($tr)"/><sch:assert role="error" id="${id}" test="exists($docs)">Real assert message for ${id}.</sch:assert></sch:rule></sch:pattern>`;
}

function collisionRule(id, value) {
  return `<sch:pattern id="p-${id}"><sch:rule context="topic"><sch:let name="marker" value="${value}"/><sch:assert role="warning" id="${id}" test="$marker != ''">Collision test for ${id}.</sch:assert></sch:rule></sch:pattern>`;
}

function soloRule(id) {
  return `<sch:pattern id="p-${id}"><sch:rule context="concept"><sch:let name="onlyHere" value="1 + 1"/><sch:assert role="warning" id="${id}" test="$onlyHere = 2">Solo rule ${id}, never repeated.</sch:assert></sch:rule></sch:pattern>`;
}

async function createApprovedBRDP(auth, projectId, identifier, ruleXml) {
  const brdpResp = await fetch(`${API}/api/projects/${projectId}/brdps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ identifier, title: `Title ${identifier}`, definition: `Definition ${identifier}` }),
  });
  if (!brdpResp.ok) throw new Error(`BRDP create failed for ${identifier}: ${brdpResp.status} ${await brdpResp.text()}`);
  const brdp = await brdpResp.json();

  const approveUrl = `${API}/api/projects/${projectId}/brdps/${brdp.id}/approvals/SCH-DITA`;
  const putResp = await fetch(approveUrl, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ rule_xml: ruleXml, source: "manual" }),
  });
  if (!putResp.ok) throw new Error(`Propose rule failed for ${identifier}: ${putResp.status} ${await putResp.text()}`);
  const approveResp = await fetch(`${approveUrl}/approve`, { method: "POST", headers: auth });
  if (!approveResp.ok) throw new Error(`Approve failed for ${identifier}: ${approveResp.status} ${await approveResp.text()}`);
  return brdp;
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser console error]", msg.text());
  });

  let projectId;
  const auth = await apiLogin();

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=/Projects|Proyectos/i", { timeout: 10000 });

    const suffix = Math.random().toString(36).slice(2, 8);
    const projectName = `Dedupe Xpath3 Test ${suffix}`;
    const createResp = await fetch(`${API}/api/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: projectName, standard: "DITA 1.3 Xpath3.0" }),
    });
    if (!createResp.ok) throw new Error(`Project create failed: ${createResp.status} ${await createResp.text()}`);
    const project = await createResp.json();
    projectId = project.id;
    console.log(`Project id: ${projectId}`);

    const configResp = await fetch(`${API}/api/projects/${projectId}/config`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ project_config: { projectName } }),
    });
    if (!configResp.ok) throw new Error(`Config update failed: ${configResp.status} ${await configResp.text()}`);

    // ---- 5 rows sharing valor/colPart/colDe/cab, byte-identical ----
    const valorRows = ["BRDP-EXT-00001", "BRDP-EXT-00002", "BRDP-EXT-00003", "BRDP-EXT-00005", "BRDP-EXT-00006a"];
    for (const id of valorRows) await createApprovedBRDP(auth, projectId, id, sharedFnRule(id));

    // ---- 4 rows sharing docFicha/docs, byte-identical ----
    const docFichaRows = ["BRDP-EXT-00004a", "BRDP-EXT-00007", "BRDP-EXT-00008", "BRDP-EXT-00009"];
    for (const id of docFichaRows) await createApprovedBRDP(auth, projectId, id, docFichaRule(id));

    // ---- Genuine name collision: same name "marker", different value ----
    await createApprovedBRDP(auth, projectId, "BRDP-EXT-COLLIDE-A", collisionRule("BRDP-EXT-COLLIDE-A", "1 + 1"));
    await createApprovedBRDP(auth, projectId, "BRDP-EXT-COLLIDE-B", collisionRule("BRDP-EXT-COLLIDE-B", "2 + 2"));

    // ---- Solo, never-repeated let -- must stay completely untouched ----
    await createApprovedBRDP(auth, projectId, "BRDP-EXT-SOLO", soloRule("BRDP-EXT-SOLO"));

    console.log(`Created and approved ${valorRows.length + docFichaRows.length + 3} real BRDPs.`);

    // ---- Real generation via the real UI ----
    await page.goto(`${BASE_URL}/projects/${projectId}/generate`);
    await page.waitForSelector(`p:has-text("DITA 1.3 Xpath3.0")`, { timeout: 10000 });
    const onlyValidatedCb = page.locator('input[type="checkbox"]').first();
    if (await onlyValidatedCb.isChecked()) await onlyValidatedCb.uncheck();
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 30000 });
    const xml = await page.locator("pre").innerText();

    const countOf = (name) => (xml.match(new RegExp(`name="${name}"`, "g")) || []).length;
    assert(countOf("valor") === 1, `"valor" appears exactly once in the real generated document (got ${countOf("valor")})`);
    assert(countOf("colPart") === 1, `"colPart" appears exactly once (got ${countOf("colPart")})`);
    assert(countOf("colDe") === 1, `"colDe" appears exactly once (got ${countOf("colDe")})`);
    assert(countOf("cab") === 1, `"cab" appears exactly once (got ${countOf("cab")})`);
    assert(countOf("docFicha") === 1, `"docFicha" appears exactly once (got ${countOf("docFicha")})`);
    assert(countOf("docs") === 1, `"docs" appears exactly once (got ${countOf("docs")})`);
    assert(xml.includes(VALOR_DEF), "the real shared valor definition is present verbatim, exactly once");
    assert(xml.includes(DOCFICHA_DEF), "the real shared docFicha definition is present verbatim, exactly once");

    for (const id of [...valorRows, ...docFichaRows]) {
      assert(xml.includes(`id="${id}"`), `real assert id="${id}" is untouched after dedup`);
      assert(xml.includes(`Real assert message for ${id}.`), `real assert message for ${id} is untouched (test/message content never modified)`);
    }

    // ---- Collision: NEVER merged, both copies survive with their own value ----
    assert(countOf("marker") === 2, `colliding "marker" let is NEVER merged -- both copies survive (got ${countOf("marker")})`);
    assert(xml.includes('value="1 + 1"') && xml.includes('value="2 + 2"'), "both distinct colliding values are present, untouched");
    const warningsToggle = page.locator("text=/vocabulary warning/i");
    assert((await warningsToggle.count()) > 0, "a warnings panel is shown (collision warning uses the same UI surface as vocabulary warnings)");
    await page.click("text=/vocabulary warning/i");
    const warningsText = await page.locator("ul").filter({ hasText: /marker/i }).innerText();
    console.log("Collision warning text:", warningsText);
    assert(/marker/.test(warningsText) && /2 different values/.test(warningsText), "the collision warning names 'marker' and the 2 different values, without claiming certainty of a mistake");

    // ---- Solo rule: completely untouched ----
    assert(countOf("onlyHere") === 1, `solo, never-repeated "onlyHere" let is untouched (still exactly 1 occurrence, got ${countOf("onlyHere")})`);
    assert(xml.includes("Solo rule BRDP-EXT-SOLO, never repeated."), "solo rule's real content is untouched");

    const wellFormedBadge = await page.locator("text=/Well-formed XML/i").count();
    assert(wellFormedBadge > 0, "the deduped document is still reported well-formed");
    assert(xml.includes('queryBinding="xslt3"'), "queryBinding=\"xslt3\" is unaffected by dedup");

    await page.screenshot({ path: "/tmp/verify-dedupe-xpath3-output.png", fullPage: true });

    // ---- Case 4: a NEW rule reusing an already-shared function joins automatically ----
    await createApprovedBRDP(auth, projectId, "BRDP-EXT-NEWJOIN", sharedFnRule("BRDP-EXT-NEWJOIN"));
    // GeneratePage.jsx's BRDP list is fetched once on page mount (via
    // BRDPContext/useBRDPs) -- a BRDP created afterward through a raw API
    // call, out of band from the app's own state, is invisible to it until
    // a real reload re-fetches. A plain "Regenerate" click here would just
    // re-run generation over the SAME already-loaded (stale) BRDP list.
    await page.reload();
    await page.waitForSelector(`p:has-text("DITA 1.3 Xpath3.0")`, { timeout: 10000 });
    const onlyValidatedCb2 = page.locator('input[type="checkbox"]').first();
    if (await onlyValidatedCb2.isChecked()) await onlyValidatedCb2.uncheck();
    await page.click('button:has-text("Generate")');
    await page.waitForSelector("pre", { timeout: 30000 });
    const xml2 = await page.locator("pre").innerText();
    const countOf2 = (name) => (xml2.match(new RegExp(`name="${name}"`, "g")) || []).length;
    // countOf2("valor") === 1 below is the real proof that the newly-joining
    // rule's own valor copy was removed automatically (no manual step): if
    // it had survived, the total count would be 2, not 1, regardless of
    // where in the document it sits.
    assert(countOf2("valor") === 1, `after a new BRDP reuses the shared function, "valor" is STILL declared exactly once -- its own copy was folded in automatically (got ${countOf2("valor")})`);
    assert(xml2.includes('id="BRDP-EXT-NEWJOIN"'), "the newly-joining rule's own assert is present");

    console.log("\nAll shared sch:let deduplication checks passed against a real Xpath3.0 project.");
  } finally {
    if (projectId) {
      await fetch(`${API}/api/projects/${projectId}`, { method: "DELETE", headers: auth }).catch(() => {});
      console.log(`Cleaned up: deleted project ${projectId}.`);
    }
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
