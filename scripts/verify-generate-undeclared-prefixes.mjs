// Live verification for "Generate Schematron DITA: prefijos usados sin
// declarar". A "DITA 1.3 Xpath3.0" project with the Navantia rules as they
// are in production (scripts/rule-test-fixtures/schematron-extract-rules.json
// without their xmlns:xs: functions typed "as xs:string", no declaration
// anywhere) plus one rule that uses an unknown prefix foo:.
//   1. Generate: exactly one <sch:ns prefix="xs"> right after sch:title;
//      the red block names foo: and its rule; the document is generated
//      anyway. English and Spanish.
//   2. Test rule on the foo: rule: the amber warning in the panel (no LLM
//      call: the rule is not executable, foo:bar() is an extension
//      function), and on an xs: rule. English and Spanish.
// No mock is needed: nothing here calls the LLM.
//
// Preconditions: uvicorn on 8000, Vite on 5173. Cleans up the project it
// creates. Screenshots go to SHOTS_DIR (default: the system's temp
// directory).
//
//     node scripts/verify-generate-undeclared-prefixes.mjs
import { chromium } from "playwright-core";
import { shot } from "./lib/shots.mjs";
import { readTextFile } from "./lib/textFile.mjs";
import { keepAccountLanguage } from "./lib/seeds.mjs";

const BASE_URL = "http://localhost:5173";
const API = "http://localhost:8000";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = "admin@example.com";
// Gives the account back its language when the process exits (the
// language selector saves it on the account; see lib/seeds.mjs).
keepAccountLanguage(ADMIN_EMAIL);
const ADMIN_PASSWORD = "AdminTest123!";
const XS = "http://www.w3.org/2001/XMLSchema";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

const extract = JSON.parse(readTextFile(new URL("./rule-test-fixtures/schematron-extract-rules.json", import.meta.url)));
const PRODUCTION = extract.xpath3.map((r) => ({ identifier: r.identifier, rule_xml: r.rule_xml.replace(/\s+xmlns:xs="[^"]*"/g, "") }));
const FOO_ID = "BRDP-EXT-00090";
const FOO_DRAFT_ID = "BRDP-EXT-00091";
const FOO_RULE = `<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p-${FOO_ID}"><sch:rule context="topic"><sch:let name="v" value="foo:bar(.)"/><sch:assert id="${FOO_ID}" role="error" test="exists(title)">El topic debe tener título.</sch:assert></sch:rule></sch:pattern>`;

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
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Undeclared prefixes ${suffix}`, standard: "DITA 1.3 Xpath3.0" }) }).then((r) => r.json());
  await api(`/api/projects/${project.id}/config`, { method: "PUT", body: JSON.stringify({ project_config: { projectName: "Navantia prefixes" } }) });
  async function seed(identifier, ruleXml, status) {
    const brdp = await api(`/api/projects/${project.id}/brdps`, {
      method: "POST",
      body: JSON.stringify({ identifier, title: `Title ${identifier}`, definition: `Definition ${identifier}`, proposal: `Proposal ${identifier}`, validation: "Validated" }),
    }).then((r) => r.json());
    const url = `/api/projects/${project.id}/brdps/${brdp.id}/approvals/SCH-DITA`;
    const put = await api(url, { method: "PUT", body: JSON.stringify({ rule_xml: ruleXml, source: "manual", status: "pending_review" }) });
    if (!put.ok) throw new Error(`seeding ${identifier} failed: ${put.status} ${await put.text()}`);
    if (status === "approved") {
      const ok = await api(`${url}/approve`, { method: "POST" });
      if (!ok.ok) throw new Error(`approving ${identifier} failed: ${ok.status}`);
    }
    return brdp;
  }
  for (const r of PRODUCTION) await seed(r.identifier, r.rule_xml, "approved");
  await seed(FOO_ID, FOO_RULE, "approved");
  // "Test rule" is offered on Draft rules: the same foo: rule as Draft.
  await seed(FOO_DRAFT_ID, FOO_RULE.replaceAll(FOO_ID, FOO_DRAFT_ID), "draft");
  await seed("BRDP-EXT-00095", PRODUCTION[0].rule_xml.replace("p-BRDP-EXT-00001", "p-BRDP-EXT-00095").replace(/id="BRDP-EXT-00001"/g, 'id="BRDP-EXT-00095"'), "draft");

  const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  page.on("dialog", (d) => d.accept());
  const proxyCalls = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/llm-proxy")) proxyCalls.push(req.url());
  });
  const language = () => page.locator("header select, nav select").first();

  async function generate() {
    await page.goto(`${BASE_URL}/projects/${project.id}/generate`);
    await page.waitForSelector('p:has-text("DITA 1.3 Xpath3.0")', { timeout: 10000 });
    await page.locator("button", { hasText: /^(Generate|Generar)$/ }).first().click();
    await page.waitForSelector("pre", { timeout: 30000 });
    return page.locator("pre").innerText();
  }

  try {
    await page.goto(BASE_URL);
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("table", { timeout: 10000 });
    await language().selectOption("en");
    await page.waitForTimeout(300);

    // 1. Generate, English.
    const xml = await generate();
    const nsLines = xml.split("\n").filter((l) => /<sch:ns\b/.test(l));
    assert(nsLines.length === 1 && nsLines[0].trim() === `<sch:ns prefix="xs" uri="${XS}"/>`, `exactly one sch:ns, for xs (${nsLines.join(" | ")})`);
    const lines = xml.split("\n");
    const titleAt = lines.findIndex((l) => l.includes("</sch:title>"));
    assert(lines[titleAt + 1]?.trim().startsWith('<sch:ns prefix="xs"'), "sch:ns right after sch:title");
    assert(xml.includes("foo:bar(.)"), "the document is generated anyway, foo:bar(.) in it");
    assert(!/xmlns:xs/.test(xml), "no xmlns:xs anywhere (the rules as in production)");
    const block = page.getByTestId("undeclared-prefixes");
    assert(await block.isVisible(), "red block shown");
    const summaryText = await block.locator("summary").innerText();
    assert(summaryText.includes("The Schematron uses 1 namespace prefix that is not declared"), `summary EN (${summaryText})`);
    const color = await block.locator("summary").evaluate((el) => getComputedStyle(el).color);
    assert(/rgb\((1[5-9]\d|2\d\d), (\d|[1-9]\d), (\d|[1-9]\d)\)/.test(color), `summary in red (${color})`);
    const items = await block.locator("li").allInnerTexts();
    assert(items.length === 1 && items[0] === `foo: used in ${FOO_ID}`, `item names foo: and its rule (${items.join(" | ")})`);
    assert(!items.some((i) => i.startsWith("xs:")), "xs: is not reported (Generate declared it)");
    await page.screenshot({ path: shot("generate-undeclared-prefixes-en.png"), fullPage: true });

    // 1b. Spanish.
    await language().selectOption("es");
    await page.waitForTimeout(300);
    await generate();
    const blockEs = page.getByTestId("undeclared-prefixes");
    const summaryEs = await blockEs.locator("summary").innerText();
    assert(summaryEs.includes("El Schematron usa 1 prefijo de espacio de nombres sin declarar"), `summary ES (${summaryEs})`);
    const itemsEs = await blockEs.locator("li").allInnerTexts();
    assert(itemsEs[0] === `foo: usado en ${FOO_ID}`, `item ES (${itemsEs[0]})`);
    const hintEs = await blockEs.locator("p").innerText();
    assert(hintEs.includes("XPST0081") && hintEs.includes("se ha generado igualmente"), "hint ES");
    await page.screenshot({ path: shot("generate-undeclared-prefixes-es.png"), fullPage: true });

    // 2. Test rule panel: the amber warning.
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    async function openTest(identifier, buttonName) {
      await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o Título…"]', identifier);
      await page.locator("tbody tr", { hasText: identifier }).first().click();
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: buttonName }).first().click();
      await page.getByTestId("rule-test-panel").first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(500);
      return page.getByTestId("rule-test-panel").first().getByTestId("rule-test-analysis-warning").allInnerTexts();
    }
    proxyCalls.length = 0;
    const fooWarnEs = await openTest(FOO_DRAFT_ID, "Probar regla");
    assert(fooWarnEs.some((w) => w.includes("La regla usa el prefijo foo: sin declararlo: un validador real fallará si el Schematron final no lo declara.")), `amber warning ES for foo: (${fooWarnEs.join(" | ")})`);
    const amber = await page.getByTestId("rule-test-analysis-warning").first().evaluate((el) => getComputedStyle(el).color);
    console.log("warning colour:", amber);
    assert(proxyCalls.length === 0, `no LLM call for the not-executable foo: rule (${proxyCalls.length})`);
    await page.screenshot({ path: shot("rule-test-undeclared-prefix-es.png"), fullPage: true });

    await language().selectOption("en");
    await page.waitForTimeout(300);
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    const fooWarnEn = await openTest(FOO_DRAFT_ID, "Test rule");
    assert(fooWarnEn.some((w) => w.includes("The rule uses the prefix foo: without declaring it: a real validator will fail if the final Schematron does not declare it.")), `amber warning EN for foo: (${fooWarnEn.join(" | ")})`);

    // The xs: rule (draft, Navantia 00001 as in production): the known-prefix
    // warning, shown before any LLM answer. Closed right away.
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector("tbody tr", { timeout: 20000 });
    await page.route("**/api/llm-proxy", (route) => route.abort());
    const xsWarn = await openTest("BRDP-EXT-00095", "Test rule");
    assert(xsWarn.some((w) => w.startsWith("⚠ The rule uses the prefix xs: without declaring it. Generate declares it in the project Schematron (sch:ns)")), `amber warning EN for xs: (${xsWarn.join(" | ")})`);
    await page.screenshot({ path: shot("rule-test-undeclared-known-prefix-en.png"), fullPage: true });
  } finally {
    await browser.close();
    await api(`/api/projects/${project.id}?permanent=true`, { method: "DELETE" });
  }
  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
