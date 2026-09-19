// Throwaway in-browser verification (real Chromium against the real live
// Vite dev server) that the finalizeSchematronDocument/checkWellFormedSchematron
// fix actually works against the REAL unprefixed Navantia content -- both
// (1) the assembled document's injected <pattern>/<rule>/<assert> elements
// really resolve into the Schematron namespace now (not just "well-formed"),
// and (2) checkWellFormedSchematron's checks actually inspect that content
// instead of silently finding zero patterns because of the old hardcoded
// "sch:" prefix requirement.
import { chromium } from "playwright-core";
import fs from "node:fs";

const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const rows = JSON.parse(
  fs.readFileSync(
    "/tmp/claude-0/-home-user-brdp-manager/98dcb646-cccc-5aae-b30c-7469530ec6c5/scratchpad/verified_rules.json",
    "utf8"
  )
);

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
    const result = await page.evaluate(async (rows) => {
      const mod = await import("/src/api/generateSchematronDITA.js");
      const brdps = rows.map((r, i) => ({
        id: `uuid-${i}`,
        identifier: r.id,
        validation: "Validated",
        definition: "def",
        proposal: "prop",
      }));
      const approvals = new Map(
        brdps.map((b, i) => [b.id, { brdp_id: b.id, status: "approved", rule_xml: rows[i].rule }])
      );
      const output = await mod.generateSchematronDITA(brdps, { projectName: "Navantia S80" }, {
        onlyValidated: true,
        approvals,
      });
      // Namespace check: parse with DOMParser (namespace-aware) and confirm
      // the injected pattern/rule/assert elements are really in the
      // Schematron namespace, not "no namespace".
      const doc = new DOMParser().parseFromString(output.xml, "application/xml");
      const perr = doc.querySelector("parsererror");
      const patterns = doc.getElementsByTagNameNS("http://purl.oclc.org/dsdl/schematron", "pattern");
      const patternsNoNs = doc.getElementsByTagName("pattern"); // any NS, name-only match
      return {
        valid: output.valid,
        errors: output.errors,
        vocabularyWarnings: output.vocabularyWarnings,
        brdpCount: output.brdpCount,
        parserError: perr ? perr.textContent : null,
        patternsInSchematronNs: patterns.length,
        patternsAnyNs: patternsNoNs.length,
        xmlLength: output.xml.length,
        xmlSnippet: output.xml.slice(0, 400),
      };
    }, rows);
    console.log(JSON.stringify(result, null, 2));

    assert(result.parserError === null, "DOMParser reports no parse error");
    assert(result.patternsInSchematronNs === rows.length, `all ${rows.length} <pattern> blocks resolve into the Schematron namespace (got ${result.patternsInSchematronNs})`);
    assert(result.patternsAnyNs === rows.length, `all ${rows.length} <pattern> blocks present at all (got ${result.patternsAnyNs})`);
    assert(result.valid === true, "checkWellFormedSchematron reports valid:true for the real content");
    assert(result.errors.length === 0, `checkWellFormedSchematron reports zero errors (got ${JSON.stringify(result.errors)})`);
    assert(result.brdpCount === rows.length, `brdpCount matches (${rows.length})`);

    // Mixed-style regression check: a project could plausibly have some
    // approved rules from the curated sch:-prefixed few-shot style and some
    // from real unprefixed imported/manual content side by side -- confirm
    // both resolve into the Schematron namespace in the SAME document and
    // checkWellFormedSchematron still reports valid:true for both styles at
    // once (not just each style in isolation).
    const mixedResult = await page.evaluate(async (realRule) => {
      const mod = await import("/src/api/generateSchematronDITA.js");
      const prefixed =
        '<sch:pattern><sch:rule context="topic"><sch:assert id="mix-1" test="title"/></sch:rule></sch:pattern>';
      const brdps = [
        { id: "u1", identifier: "BRDP-MIX-PREFIXED", validation: "Validated", definition: "d", proposal: "p" },
        { id: "u2", identifier: "BRDP-MIX-UNPREFIXED", validation: "Validated", definition: "d", proposal: "p" },
      ];
      const approvals = new Map([
        ["u1", { brdp_id: "u1", status: "approved", rule_xml: prefixed }],
        ["u2", { brdp_id: "u2", status: "approved", rule_xml: realRule }],
      ]);
      const output = await mod.generateSchematronDITA(brdps, { projectName: "Mixed" }, {
        onlyValidated: true,
        approvals,
      });
      const doc = new DOMParser().parseFromString(output.xml, "application/xml");
      const perr = doc.querySelector("parsererror");
      const patterns = doc.getElementsByTagNameNS("http://purl.oclc.org/dsdl/schematron", "pattern");
      return { valid: output.valid, errors: output.errors, parserError: perr ? perr.textContent : null, patternsInSchematronNs: patterns.length };
    }, rows[0].rule);
    console.log(JSON.stringify(mixedResult, null, 2));
    assert(mixedResult.parserError === null, "mixed prefixed+unprefixed document parses without error");
    assert(mixedResult.patternsInSchematronNs === 2, `both prefixed and unprefixed pattern resolve into the Schematron namespace in the SAME document (got ${mixedResult.patternsInSchematronNs})`);
    assert(mixedResult.valid === true, "checkWellFormedSchematron reports valid:true for the mixed document");
    assert(mixedResult.errors.length === 0, `zero errors for the mixed document (got ${JSON.stringify(mixedResult.errors)})`);

    console.log("\nAll namespace-fix checks passed against real Navantia content (including mixed prefixed/unprefixed).");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
