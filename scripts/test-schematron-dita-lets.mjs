// Deterministic, offline test for the new "lets" few-shot field (sch:let +
// XPath 2.0 "every ... satisfies" quantifier pattern, taught via
// BRDP-EXT-00003). Unlike scripts/test-schematron-dita.mjs, this needs NO
// LLM API key: it only exercises the deterministic few-shot injection path
// (buildDeterministicBlockFromFewShot / buildFewShotBlock / finalization /
// well-formedness check), which is exactly the code path a real project
// BRDP with this same id would take -- see generateSchematronDITA()'s
// "BRDPs whose id exactly matches a curated few-shot are resolved
// deterministically" comment.
//
// Usage: node scripts/test-schematron-dita-lets.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateSchematronDITA,
  buildFewShotBlock,
  buildDeterministicBlockFromFewShot,
  checkWellFormedSchematron,
  finalizeSchematronDocument,
} from "../src/api/generateSchematronDITA.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const schemaSummaryPath = path.join(REPO_ROOT, "public/schematron-dita-schema-summary.json");
const schemaSummary = JSON.parse(fs.readFileSync(schemaSummaryPath, "utf8"));
const projectConfig = { projectName: "Test Project", modelIdentCode: "TESTPROJ" };

console.log(`Loaded schema summary: ${schemaSummary.few_shot_examples.length} few-shots.\n`);

// ---- 1. BRDP-EXT-00003 exists with the expected shape ----
console.log("1. New few-shot BRDP-EXT-00003 is present with a 'lets' field");
const ext3 = schemaSummary.few_shot_examples.find((e) => e.id === "BRDP-EXT-00003");
check("entry found", !!ext3);
check("has topicTypes including 'reference'", !!ext3 && ext3.topicTypes.includes("reference"));
check("confidence_ai is 'alta'", !!ext3 && ext3.confidence_ai === "alta");
check(
  "has a non-empty 'lets' array with name/value",
  !!ext3 && Array.isArray(ext3.lets) && ext3.lets.length === 1 &&
    ext3.lets[0].name === "colCant" && !!ext3.lets[0].value
);

// ---- 2. buildDeterministicBlockFromFewShot renders the sch:let correctly ----
console.log("\n2. buildDeterministicBlockFromFewShot(BRDP-EXT-00003) renders sch:let + sch:assert");
const block = buildDeterministicBlockFromFewShot(ext3);
console.log(block.split("\n").map((l) => "    " + l).join("\n"));
check(
  "contains the exact sch:let line",
  block.includes(
    `<sch:let name="colCant" value="tgroup/thead/row[1]/entry[normalize-space(.) = 'Cant.']/@colname"/>`
  )
);
check("sch:let appears BEFORE sch:assert", block.indexOf("<sch:let") < block.indexOf("<sch:assert"));
check("sch:let is inside the sch:rule", block.indexOf("<sch:rule") < block.indexOf("<sch:let"));
check("contains the assert with the right id", block.includes('id="BRDP-EXT-00003"'));
check("contains the quantifier", block.includes("every $row in tgroup/tbody/row satisfies"));

// ---- 3. The assembled single-BRDP document is well-formed ----
console.log("\n3. Assembled document (header + this one block) is well-formed");
const singleDoc = finalizeSchematronDocument([block], projectConfig, schemaSummary);
const singleResult = checkWellFormedSchematron(singleDoc, schemaSummary);
check("valid === true", singleResult.valid, JSON.stringify(singleResult.errors));
check("zero errors", singleResult.errors.length === 0, JSON.stringify(singleResult.errors));

// ---- 4. buildFewShotBlock (prompt text) teaches the LLM this example ----
console.log("\n4. buildFewShotBlock() prompt text includes the sch:let example");
const promptBlock = buildFewShotBlock(schemaSummary);
check("prompt contains BRDP-EXT-00003", promptBlock.includes("BRDP-EXT-00003"));
check(
  "prompt contains the literal sch:let line",
  promptBlock.includes(`<sch:let name="colCant" value="tgroup/thead/row[1]/entry[normalize-space(.) = 'Cant.']/@colname"/>`)
);

// ---- 5. Zero regression: every OTHER few-shot (no "lets") renders unchanged ----
console.log("\n5. Regression: few-shots without 'lets' render with no sch:let line and are unaffected");
const others = schemaSummary.few_shot_examples.filter((e) => e.id !== "BRDP-EXT-00003");
let regressionOk = true;
for (const ex of others) {
  const b = buildDeterministicBlockFromFewShot(ex);
  if (b.includes("<sch:let")) {
    regressionOk = false;
    console.log(`  FAIL unexpected <sch:let> in ${ex.id}`);
  }
}
check(`all ${others.length} pre-existing few-shots have no stray <sch:let>`, regressionOk);

// ---- 6. Zero regression: the full 30-block assembled document is well-formed ----
console.log("\n6. Regression: full assembled document (all 30 few-shots) is well-formed, ids unique");
const allBlocks = schemaSummary.few_shot_examples.map((ex) => buildDeterministicBlockFromFewShot(ex));
const fullDoc = finalizeSchematronDocument(allBlocks, projectConfig, schemaSummary);
const fullResult = checkWellFormedSchematron(fullDoc, schemaSummary);
check("valid === true", fullResult.valid, JSON.stringify(fullResult.errors));
check("zero errors", fullResult.errors.length === 0, JSON.stringify(fullResult.errors));
console.log(`  (non-blocking vocabulary warnings: ${fullResult.vocabularyWarnings.length})`);
if (fullResult.vocabularyWarnings.length > 0) {
  fullResult.vocabularyWarnings.forEach((w) => console.log(`    - ${w}`));
}
check(
  "no vocabulary warning mentions 'thead' (confirmed real DITA/CALS element, added to EXTRA_KNOWN_NAMES)",
  !fullResult.vocabularyWarnings.some((w) => w.includes("'thead'"))
);

// ---- 7. Full generateSchematronDITA() entry point, zero LLM calls needed ----
console.log("\n7. generateSchematronDITA() resolves a real project BRDP with this id 100% deterministically (no LLM call)");
const projectBRDPs = [
  {
    id: "BRDP-EXT-00003",
    definition: "Decidir si: En los topics cuyo <title> sea LISTA DE MATERIAL OBLIGATORIO, LISTA DE MATERIAL IMPREVISTO, ó HERRAMIENTAS Y EQUIPOS DE PRUEBA, cuando haya una tabla cuyo título de columna sea Cant., todas las filas del tbody/row/entry correspondiente deben tener siempre un valor y nunca estar vacías.",
    proposal: "Exime de error las filas cuya columna \"Part\" (primera columna) esté vacía.",
    validation: "Validated",
  },
];

let llmWasCalled = false;
const result = await generateSchematronDITA(projectBRDPs, projectConfig, {
  onlyValidated: false,
  schemaSummary,
  approvals: [],
  callLLM: async () => {
    llmWasCalled = true;
    throw new Error("callLLM should never be invoked for a BRDP id matching a curated few-shot");
  },
  proposeApproval: async () => {},
});

check("callLLM was never invoked", !llmWasCalled);
check("result.valid === true", result.valid, JSON.stringify(result.errors));
check("result.brdpCount === 1", result.brdpCount === 1);
check("generated xml contains the sch:let", result.xml.includes("<sch:let name=\"colCant\""));
check("generated xml contains the BRDP-EXT-00003 assert", result.xml.includes('id="BRDP-EXT-00003"'));

console.log("\n=== SUMMARY ===");
if (failures === 0) {
  console.log("All checks passed.");
} else {
  console.log(`${failures} check(s) FAILED.`);
  process.exitCode = 1;
}
