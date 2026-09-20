// Throwaway in-browser verification (real Chromium against the real live
// Vite dev server) that generateSchematronDITA() derives queryBinding from
// project.standard correctly for BOTH DITA flavors (migration
// 0013_split_dita_xpath_standards.py), instead of the old hardcoded
// "xslt2" -- confirms the real bug (a real XPath 3.0 project would have
// gotten a wrong queryBinding header) is actually fixed, with synthetic
// XPath 3.0 content (map{}/array{}/=> constructs) since the real
// Navantia-Xpath3.0 file was not available in this environment yet.
import { chromium } from "playwright-core";

const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console error]", m.text());
  });
  try {
    await page.goto("http://localhost:5173/");
    const result = await page.evaluate(async () => {
      const mod = await import("/src/api/generateSchematronDITA.js");

      // A synthetic-but-real-shaped XPath 3.0 rule: arrow operator (=>),
      // map{} constructor (space before brace, the one style confirmed by
      // regex analysis to actually need the new "array" vocab entry --
      // "map" was already known regardless), and single-arg string-join.
      const xpath3Rule =
        '<pattern id="p-BRDP-X3-001">' +
        '<rule context="topic">' +
        '<let name="opts" value="map { \'sep\': \', \' }"/>' +
        '<let name="items" value="array { 1, 2, 3 }"/>' +
        '<assert id="BRDP-X3-001-a" test="(title/string() => upper-case()) = string-join((\'A\',\'B\'))">Test.</assert>' +
        "</rule>" +
        "</pattern>";
      const xpath2Rule =
        '<sch:pattern><sch:rule context="topic"><sch:assert id="BRDP-X2-001" test="title"/></sch:rule></sch:pattern>';

      const brdpsX3 = [{ id: "u1", identifier: "BRDP-X3-001", validation: "Validated", definition: "d", proposal: "p" }];
      const approvalsX3 = new Map([["u1", { brdp_id: "u1", status: "approved", rule_xml: xpath3Rule }]]);
      const outputX3 = await mod.generateSchematronDITA(brdpsX3, { projectName: "Xpath3 Test" }, {
        onlyValidated: true,
        approvals: approvalsX3,
        standard: "DITA 1.3 Xpath3.0",
      });

      const brdpsX2 = [{ id: "u2", identifier: "BRDP-X2-001", validation: "Validated", definition: "d", proposal: "p" }];
      const approvalsX2 = new Map([["u2", { brdp_id: "u2", status: "approved", rule_xml: xpath2Rule }]]);
      const outputX2 = await mod.generateSchematronDITA(brdpsX2, { projectName: "Xpath2 Test" }, {
        onlyValidated: true,
        approvals: approvalsX2,
        standard: "DITA 1.3 Xpath2.0",
      });

      // Also confirm the bare, pre-migration "DITA 1.3" string (an old
      // caller that hasn't been updated) still defaults safely to xslt2,
      // never silently guessing xslt3.
      const outputBareDITA = await mod.generateSchematronDITA(brdpsX2, { projectName: "Bare Test" }, {
        onlyValidated: true,
        approvals: approvalsX2,
        standard: "DITA 1.3",
      });

      return {
        x3: { valid: outputX3.valid, errors: outputX3.errors, vocabularyWarnings: outputX3.vocabularyWarnings, xmlHead: outputX3.xml.slice(0, 200) },
        x2: { valid: outputX2.valid, errors: outputX2.errors, xmlHead: outputX2.xml.slice(0, 200) },
        bare: { valid: outputBareDITA.valid, xmlHead: outputBareDITA.xml.slice(0, 200) },
      };
    });
    console.log(JSON.stringify(result, null, 2));

    assert(result.x3.xmlHead.includes('queryBinding="xslt3"'), "DITA 1.3 Xpath3.0 project generates queryBinding=\"xslt3\"");
    assert(result.x3.valid === true, "Xpath3.0 document with map{}/array{}/=>/string-join content reports valid:true");
    assert(result.x3.errors.length === 0, `Xpath3.0 document has zero errors (got ${JSON.stringify(result.x3.errors)})`);
    assert(!result.x3.vocabularyWarnings.some((w) => w.includes("'array'")), "'array' (used in array{...}) is NOT flagged as unconfirmed for an Xpath3.0 project");
    assert(!result.x3.vocabularyWarnings.some((w) => w.includes("'map'")), "'map' (used in map{...}) is NOT flagged as unconfirmed (already known regardless of flavor)");
    assert(!result.x3.vocabularyWarnings.some((w) => w.includes("string-join")), "'string-join' single-arg form is NOT flagged as unconfirmed");

    assert(result.x2.xmlHead.includes('queryBinding="xslt2"'), "DITA 1.3 Xpath2.0 project generates queryBinding=\"xslt2\" (unchanged behavior)");
    assert(result.x2.valid === true, "Xpath2.0 document unaffected, still valid:true");

    assert(result.bare.xmlHead.includes('queryBinding="xslt2"'), "a bare pre-migration 'DITA 1.3' standard string safely defaults to xslt2, never guesses xslt3");

    // Cross-check: an Xpath2.0 project must NOT get the Xpath3.0-only
    // vocabulary silently widened -- construct one that uses "array" as a
    // bare unconfirmed name and confirm it STILL gets flagged there.
    const crossCheck = await page.evaluate(async () => {
      const mod = await import("/src/api/generateSchematronDITA.js");
      const rule =
        '<sch:pattern><sch:rule context="topic"><sch:assert id="BRDP-X2-ARR" test="array and true()"/></sch:rule></sch:pattern>';
      const brdps = [{ id: "u3", identifier: "BRDP-X2-ARR", validation: "Validated", definition: "d", proposal: "p" }];
      const approvals = new Map([["u3", { brdp_id: "u3", status: "approved", rule_xml: rule }]]);
      const output = await mod.generateSchematronDITA(brdps, { projectName: "Xpath2 Cross Test" }, {
        onlyValidated: true,
        approvals,
        standard: "DITA 1.3 Xpath2.0",
      });
      return { vocabularyWarnings: output.vocabularyWarnings };
    });
    assert(
      crossCheck.vocabularyWarnings.some((w) => w.includes("'array'")),
      "'array' STILL gets flagged as unconfirmed for an Xpath2.0 project (the Xpath3.0-only vocabulary never leaks across flavors)"
    );

    console.log("\nAll DITA Xpath2.0/Xpath3.0 queryBinding checks passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
