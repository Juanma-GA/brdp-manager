// Live verification for "Test de reglas: reglas informativas, juicio de
// listas cerradas y esquema según los predicados" (pasada «Official Default
// S1000D 4.2 - 001»), with the rules of the default S1000D 4.2 BREX verbatim
// (scripts/rule-test-fixtures/default-brex-4-2.json):
//   - BRDP-EXT-00002 (//dmlEntry, flag 2, no values): "Informative" with no
//     LLM call, in EN and ES; Verify with no warning; the Records header
//     counts it.
//   - BRDP-EXT-00037 (flag 2, objectUse "must not"): informative + the note.
//   - BRDP-EXT-00046 (a reference to //supplyDescr/@id): tested in proced;
//     the accept example first points to an id no <supplyDescr> has, the
//     correction round names it; verdict correct.
//   - BRDP-EXT-00152 (/dmodule[content/brex]/…): tested in the brex schema;
//     verdict correct.
// Only the Mistral TRANSPORT is mocked (mock-mistral-chat-server.mjs).
//
// Preconditions: uvicorn started with MISTRAL_ENDPOINT=http://localhost:8902
// and MISTRAL_EMBED_ENDPOINT=http://localhost:8901, both mocks running,
// Vite on 5173. Cleans up the project it creates. Screenshots go to
// SHOTS_DIR (default: the system's temp directory).
//
//     node scripts/verify-rule-test-default-brex.mjs
import fs from "node:fs";
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const MOCK = "http://localhost:8902";
// Set CHROMIUM_PATH to use a specific Chromium; otherwise Playwright uses its default browser.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "AdminTest123!";
const RULES = JSON.parse(fs.readFileSync(new URL("./rule-test-fixtures/default-brex-4-2.json", import.meta.url))).rules;
const rule = (n) => RULES[`BRDP-EXT-${String(n).padStart(5, "0")}`].rule_xml;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

async function main() {
  const token = (
    await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then((r) => r.json())
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = (path, init = {}) => fetch(`${API}${path}`, { headers: auth, ...init });
  const suffix = Math.random().toString(36).slice(2, 8);

  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Default BREX rule test ${suffix}`, standard: "S1000D 4.2" }) }).then((r) => r.json());
  async function makeBrdp(fields, ruleXml, status = "pending_review") {
    const b = await api(`/api/projects/${project.id}/brdps`, { method: "POST", body: JSON.stringify({ validation: "Validated", ...fields }) }).then((r) => r.json());
    const r = await api(`/api/projects/${project.id}/brdps/${b.id}/approvals/BREX-4.2`, { method: "PUT", body: JSON.stringify({ rule_xml: ruleXml, source: "manual", status }) });
    if (!r.ok) throw new Error(`seeding rule failed: ${r.status} ${await r.text()}`);
    return b;
  }
  await makeBrdp({ identifier: "BRDP-EXT-00002", title: "Contents of the DMRL", definition: "Decide on the contents of the data module requirement list.", proposal: "The DMRL must contain the titles and details of the responsible partner company for each data module and publication module." }, rule(2));
  await makeBrdp({ identifier: "BRDP-EXT-00037", title: "Use of an element", definition: "Decide whether the element is used.", proposal: "The element must not be used." }, rule(37));
  await makeBrdp({ identifier: "BRDP-EXT-00046", title: "References to supplies", definition: "Decide what an internal reference of type irtt04 can point to.", proposal: "An internal reference of type irtt04 points to a supply description of the data module." }, rule(46));
  // Lo que la app arregla sola: EXT-00127 with the simulator's real failure
  // (<pmCode>PM-001</pmCode>, frontMatterType="general"); the identifier is
  // the simulator's marker.
  await makeBrdp({ identifier: "BRDP-EVAL-RT-PMCODE", title: "Attributes of references in front matter", definition: "Decide on the attributes of references to publication modules in a front matter data module.", proposal: "Attributes @id, @authorityName and @authorityDocument must not be used for references to publication modules in a front matter data module." }, rule(127));
  await makeBrdp({ identifier: "BRDP-EXT-00019", title: "Elements of the zone CIR in a data update file", definition: "Decide which elements can be used in the data update file representing the zone CIR.", proposal: "Only zoneSpec, zoneIdent, figure, figureIdent, multimedia, multimediaIdent, applicIdent, applicRefIdent, applic, applicRef elements can be used in the Data update file representing the zone CIR." }, rule(19));
  await makeBrdp({ identifier: "BRDP-EXT-00152", title: "Information code of a BREX", definition: "Decide on the information code of a BREX data module.", proposal: "A BREX data module has information code 022 and item location code D." }, rule(152));
  // Condiciones sobre la sección de identificación del propio documento:
  // EXT-00134 (comrep, own dmCode infoCode="0A2"), and a value the minimal
  // section has no node for (applicRef in dmStatus).
  await makeBrdp({ identifier: "BRDP-EXT-00134", title: "Expressions in a common repository", definition: "Decide where expressions can be used in the applicability common repository.", proposal: "In the applicability CIR, expressions are only used inside referenced applicability groups." }, rule(134));
  await makeBrdp({ identifier: "BRDP-OS-APPLICREF", title: "Paragraphs of an applicability", definition: "Decide on paragraphs of data modules with a given applicability reference.", proposal: "Data modules with applicability reference app-01 must not have paragraphs." }, `<structureObjectRule><objectPath allowedObjectFlag="0">//para[ancestor::dmodule/identAndStatusSection/dmStatus/applicRef/@applicRefId = 'app-01']</objectPath><objectUse>x</objectUse></structureObjectRule>`);
  const job = await api(`/api/projects/${project.id}/embeddings/compute`, { method: "POST" }).then((r) => r.json());
  for (let i = 0; i < 80; i++) {
    const s = await api(`/api/projects/${project.id}/embeddings/status/${job.job_id}`).then((r) => r.json());
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  const verdict = () => page.getByTestId("rule-test-verdict");
  const example = (i) => page.getByTestId(`rule-test-example-${i}`);
  const language = (lng) => page.locator("header select, nav select").first().selectOption(lng);
  const chatCalls = async () => (await fetch(`${MOCK}/chat-calls`).then((r) => r.json())).calls;
  async function select(identifier) {
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
    await page.locator("tbody tr", { hasText: identifier }).first().click();
    await page.waitForTimeout(600); // rule approval fetch
  }
  async function openTest(identifier) {
    await fetch(`${MOCK}/reset`, { method: "POST" });
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await select(identifier);
    await page.getByRole("button", { name: /^(Test rule|Probar regla)$/ }).click();
  }
  async function indicatorText(expected) {
    let text = "";
    for (let i = 0; i < 40 && !text.includes(expected); i++) {
      text = (await page.getByTestId("rule-test-indicator").textContent().catch(() => "")) || "";
      if (!text.includes(expected)) await page.waitForTimeout(250);
    }
    return text;
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });

    // 1. EXT-00002: informative, no LLM call.
    await openTest("BRDP-EXT-00002");
    await verdict().waitFor({ timeout: 20000 });
    assert((await verdict().getAttribute("data-kind")) === "informative", "EXT-00002: verdict kind informative");
    const v2 = (await verdict().textContent()) || "";
    assert(v2.includes("Informative: this rule rejects nothing; it documents what is allowed."), `EXT-00002: informative text (${v2})`);
    assert((await page.getByTestId("rule-test-informative-must-not").count()) === 0, "EXT-00002: no 'must not' note");
    assert((await chatCalls()) === 0, "EXT-00002: no LLM call");
    assert((await indicatorText("Informative")).includes("Informative"), "EXT-00002: recorded, indicator 'Informative'");
    await page.screenshot({ path: shot("rule-test-informative-en.png"), fullPage: true });
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await page.waitForTimeout(800);
    assert((await page.getByTestId("verify-warning-dialog").count()) === 0, "EXT-00002: Verify with no warning");
    await page.reload();
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    const header = page.getByTestId("verified-breakdown-informative");
    await header.waitFor({ timeout: 10000 });
    assert(((await header.textContent()) || "").includes("1 informative"), `header: "1 informative" (${await header.textContent()})`);
    await page.screenshot({ path: shot("rule-test-informative-header-en.png"), fullPage: true });

    // 2. Spanish.
    await language("es");
    await page.waitForTimeout(400);
    assert(((await page.getByTestId("verified-breakdown-informative").textContent()) || "").includes("1 informativa"), "header ES: '1 informativa'");
    // 3. EXT-00037: informative + the "must not" note.
    await openTest("BRDP-EXT-00037");
    await verdict().waitFor({ timeout: 20000 });
    assert((await verdict().getAttribute("data-kind")) === "informative", "EXT-00037: informative");
    const note = (await page.getByTestId("rule-test-informative-must-not").textContent()) || "";
    assert(note.includes("must not"), `EXT-00037 ES: note (${note})`);
    assert(((await verdict().textContent()) || "").includes("Informativa: esta regla no rechaza nada; documenta lo que está permitido."), "EXT-00037 ES: texto «Informativa»");
    assert((await chatCalls()) === 0, "EXT-00037: no LLM call");
    await page.screenshot({ path: shot("rule-test-informative-must-not-es.png"), fullPage: true });
    await language("en");
    await page.waitForTimeout(300);

    // 4. EXT-00046: proced, correction round names the dangling id.
    await openTest("BRDP-EXT-00046");
    await verdict().waitFor({ timeout: 30000 });
    const calls46 = (await fetch(`${MOCK}/requests`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) || null;
    const last = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    const lastUser = [...last.messages].reverse().find((m) => m.role === "user")?.content || "";
    assert(lastUser.includes("The example points to SE123 (@internalRefId of <internalRef>), but no <supplyDescr> or <embeddedSupplyDescr> has id=\"SE123\""), "EXT-00046: the correction names the dangling id");
    const system46 = last.messages.find((m) => m.role === "system").content;
    assert(system46.includes('schema "proced": your content goes directly inside <procedure>'), "EXT-00046: tested in proced at <procedure>");
    const v46 = (await verdict().textContent()) || "";
    assert(v46.startsWith("Correct"), `EXT-00046: verdict correct (${v46})`);
    assert(((await example(0).getByTestId("rule-test-result").textContent()) || "").includes("accepted ✓"), "EXT-00046: accept example accepted");
    assert(((await example(1).getByTestId("rule-test-result").textContent()) || "").includes("rejected ✓"), "EXT-00046: reject example rejected");
    void calls46;
    await page.screenshot({ path: shot("rule-test-default-ext46.png"), fullPage: true });

    // 5. EXT-00152: brex schema.
    await openTest("BRDP-EXT-00152");
    await verdict().waitFor({ timeout: 30000 });
    const req152 = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    assert(req152.messages.find((m) => m.role === "system").content.includes('schema "brex":'), "EXT-00152: tested in the brex schema");
    const v152 = (await verdict().textContent()) || "";
    assert(v152.startsWith("Correct"), `EXT-00152: verdict correct (${v152})`);
    assert(/<brex>/.test((await example(0).locator("pre").textContent()) || ""), "EXT-00152: the example is a BREX data module");
    await page.screenshot({ path: shot("rule-test-default-ext152.png"), fullPage: true });

    // 6. EXT-00127: the app fixes the LLM's markup on its own -- required
    // attributes of <pmCode>, its text, frontMatterType -- no correction
    // round, verdict correct.
    await openTest("BRDP-EVAL-RT-PMCODE");
    await verdict().waitFor({ timeout: 30000 });
    const v127 = (await verdict().textContent()) || "";
    assert(v127.startsWith("Correct"), `EXT-00127: verdict correct (${v127})`);
    const req127 = await fetch(`${MOCK}/last-request`).then((r) => r.json());
    assert(!req127.messages.some((m) => m.role === "user" && /Some examples are not valid/.test(m.content)), "EXT-00127: no correction round");
    const notes = async (i, id) => ((await example(i).getByTestId(id).textContent().catch(() => "")) || "");
    const attrs0 = await notes(0, "rule-test-required-attributes-added");
    assert(attrs0.includes("Adjusted by the app: added the required attributes @modelIdentCode, @pmIssuer, @pmNumber, @pmVolume on <pmCode>"), `EXT-00127: required attributes note (${attrs0})`);
    const text0 = await notes(0, "rule-test-text-removed");
    assert(text0.includes("removed the text of <pmCode>"), `EXT-00127: text note (${text0})`);
    const val0 = await notes(0, "rule-test-values-replaced");
    assert(val0.includes('@frontMatterType="general" to "fm01"'), `EXT-00127: value note (${val0})`);
    const shown = (await example(0).locator("pre").textContent()) || "";
    assert(/<pmCode modelIdentCode="[^"]+" pmIssuer="[^"]+" pmNumber="[^"]+" pmVolume="[^"]+"\s*>\s*<\/pmCode>|<pmCode modelIdentCode="[^"]+" pmIssuer="[^"]+" pmNumber="[^"]+" pmVolume="[^"]+"\s*\/>/.test(shown) && !shown.includes("PM-001"), "EXT-00127: the example shows the fixed <pmCode>");
    assert(((await example(1).getByTestId("rule-test-result").textContent()) || "").includes("rejected ✓"), "EXT-00127: @id example rejected");
    await page.screenshot({ path: shot("rule-test-app-fixes-pmcode-en.png"), fullPage: true });
    await language("es");
    await page.waitForTimeout(400);
    const attrsEs = await notes(0, "rule-test-required-attributes-added");
    assert(attrsEs.includes("Ajustado por la app: se añadieron los atributos obligatorios @modelIdentCode, @pmIssuer, @pmNumber, @pmVolume en <pmCode>"), `EXT-00127 ES: nota de atributos (${attrsEs})`);
    assert((await notes(1, "rule-test-values-replaced")).includes('@frontMatterType="tableOfContents" por "fm01"'), "EXT-00127 ES: nota de valores");
    assert((await notes(0, "rule-test-text-removed")).includes("se quitó el texto de <pmCode>"), "EXT-00127 ES: nota de texto");
    await page.screenshot({ path: shot("rule-test-app-fixes-pmcode-es.png"), fullPage: true });
    await language("en");

    // 7. El juez de la Propuesta y las listas cerradas: EXT-00019 (zone
    // CIR). The description says the element list (8 shown, "+18 more"),
    // the Proposal check gets the computed PROPOSAL vs RULE lists and is
    // never "no" (the real run read the forbidden list as the allowed one).
    await openTest("BRDP-EXT-00019");
    const line = page.getByTestId("rule-test-ancestor-list");
    await line.waitFor({ timeout: 20000 });
    const cut = (await line.textContent()) || "";
    assert(cut.startsWith('In a <dataUpdateFile> whose <updateCode> has @infoCode "00H", none of these may appear inside <update>: <partSpec>,') && cut.includes(", … (26)") && cut.includes("+18 more"), `EXT-00019: description cut to 8 (${cut})`);
    await page.getByTestId("rule-test-ancestor-list-more").click();
    const whole = (await line.textContent()) || "";
    assert(whole.includes("<cautionIdent> (26)") && !whole.includes("…") && whole.includes("Show less"), `EXT-00019: whole list on "+18 more" (${whole})`);
    await page.screenshot({ path: shot("rule-test-zone-cir-list-en.png"), fullPage: true });
    await verdict().waitFor({ timeout: 30000 });
    let check19 = null;
    const systemOf = (req) => (req?.messages || []).find((m) => m.role === "system")?.content || "";
    for (let i = 0; i < 40 && !systemOf(check19); i++) {
      check19 = await fetch(`${MOCK}/last-proposal-check`).then((r) => r.json()).catch(() => null);
      if (!systemOf(check19)) await page.waitForTimeout(250);
    }
    const sp19 = systemOf(check19);
    assert(sp19.includes("- named in the Proposal and NOT forbidden by the rule: <zoneSpec>, <zoneIdent>, <figure>,") && sp19.includes("- named in the Proposal and forbidden by the rule: (none)") && sp19.includes("- forbidden by the rule and not named in the Proposal: 26 elements"), "EXT-00019: PROPOSAL vs RULE block in the Proposal check");
    assert(((await verdict().textContent()) || "").startsWith("Correct"), `EXT-00019: verdict correct, never "Review" (${await verdict().textContent()})`);
    await language("es");
    await page.waitForTimeout(400);
    const es = (await line.textContent()) || "";
    assert(es.startsWith('En un <dataUpdateFile> cuyo <updateCode> tiene @infoCode "00H", no puede aparecer dentro de <update> ninguno de estos:') && es.includes("Mostrar menos"), `EXT-00019 ES: descripción (${es})`);
    await page.getByTestId("rule-test-ancestor-list-more").click();
    assert(((await line.textContent()) || "").includes("+18 más"), "EXT-00019 ES: +18 más");
    await page.screenshot({ path: shot("rule-test-zone-cir-list-es.png"), fullPage: true });
    await language("en");

    // 8. Condiciones sobre la sección de identificación del propio
    // documento: EXT-00134. The simulator writes own infoCode="040" (the real
    // failure); the app sets 0A2 in the section of every example.
    await openTest("BRDP-EXT-00134");
    await verdict().waitFor({ timeout: 30000 });
    assert(((await verdict().textContent()) || "").startsWith("Correct"), `EXT-00134: verdict correct (${await verdict().textContent()})`);
    const own = (await example(1).getByTestId("rule-test-section-values").textContent().catch(() => "")) || "";
    assert(own.includes('Adjusted by the app: the identification and status section has <dmCode infoCode="0A2">'), `EXT-00134: section values note (${own})`);
    assert(((await example(1).getByTestId("rule-test-result").textContent()) || "").includes("rejected ✓"), "EXT-00134: expression outside referencedApplicGroup rejected");
    assert(((await example(0).getByTestId("rule-test-result").textContent()) || "").includes("accepted ✓"), "EXT-00134: expression inside referencedApplicGroup accepted");
    assert(((await example(1).textContent()) || "").includes('infoCode="0A2"'), "EXT-00134: 0A2 shown in the example");
    await page.screenshot({ path: shot("rule-test-own-section-0a2-en.png"), fullPage: true });
    await language("es");
    await page.waitForTimeout(400);
    const ownEs = (await example(1).getByTestId("rule-test-section-values").textContent().catch(() => "")) || "";
    assert(ownEs.includes('Ajustado por la app: la sección de identificación lleva <dmCode infoCode="0A2">'), `EXT-00134 ES: nota (${ownEs})`);
    await language("en");

    // A value the examples cannot carry: not executable, no LLM call.
    await openTest("BRDP-OS-APPLICREF");
    await page.getByTestId("rule-test-analysis").waitFor({ timeout: 15000 });
    const reasonEn = ((await page.getByTestId("rule-test-analysis").textContent()) || "").trim();
    assert(reasonEn.includes('the rule depends on @applicRefId="app-01" in the identification section, and the examples cannot have it.'), `not executable reason EN (${reasonEn})`);
    await page.waitForTimeout(800);
    assert((await chatCalls()) === 0, "not executable: no LLM call");
    await page.screenshot({ path: shot("rule-test-own-section-unavailable-en.png"), fullPage: true });
    await language("es");
    await page.waitForTimeout(400);
    const reasonEs = ((await page.getByTestId("rule-test-analysis").textContent()) || "").trim();
    assert(reasonEs.includes('la regla depende de @applicRefId="app-01" en la sección de identificación, y los ejemplos no pueden tenerla.'), `no ejecutable ES (${reasonEs})`);
    await language("en");
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures ? `${failures} failure(s)` : "ALL OK");
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
