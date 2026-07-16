// Deterministic, offline test for the "lets" few-shot field (sch:let +
// XPath 2.0 "every ... satisfies" quantifier pattern, STRICT RULE 19),
// covering every curated example that uses it (CURATED-cant-table, "Cant."
// column; CURATED-ncage-table, "NCAGE" column). Unlike
// scripts/test-schematron-dita.mjs, this needs NO LLM API key: it only
// exercises the deterministic few-shot injection path
// (buildDeterministicBlockFromFewShot / buildFewShotBlock / finalization /
// well-formedness check), which is exactly the code path a real project
// BRDP with one of these ids would take -- see generateSchematronDITA()'s
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

const hasLets = (ex) => Array.isArray(ex.lets) && ex.lets.length > 0;
const letsExamples = schemaSummary.few_shot_examples.filter(hasLets);
const noLetsExamples = schemaSummary.few_shot_examples.filter((ex) => !hasLets(ex));

console.log(`Found ${letsExamples.length} few-shot(s) using 'lets': ${letsExamples.map((e) => e.id).join(", ")}\n`);

// ---- 1-4. Every "lets" few-shot renders correctly, in isolation ----
for (const ex of letsExamples) {
  console.log(`=== ${ex.id} ===`);
  check("has topicTypes (non-empty)", Array.isArray(ex.topicTypes) && ex.topicTypes.length > 0);
  check("confidence_ai is 'alta'", ex.confidence_ai === "alta");

  const block = buildDeterministicBlockFromFewShot(ex);
  console.log(block.split("\n").map((l) => "    " + l).join("\n"));

  for (const l of ex.lets) {
    check(
      `contains sch:let for '${l.name}'`,
      block.includes(`<sch:let name="${l.name}" value="${l.value}"/>`)
    );
  }
  check("sch:let appears BEFORE sch:assert", block.indexOf("<sch:let") < block.indexOf("<sch:assert"));
  check("sch:let is inside the sch:rule", block.indexOf("<sch:rule") < block.indexOf("<sch:let"));
  check("contains the assert with the right id", block.includes(`id="${ex.id}"`));
  check("contains the quantifier", block.includes("every $row in tgroup/tbody/row satisfies"));

  const singleDoc = finalizeSchematronDocument([block], projectConfig, schemaSummary);
  const singleResult = checkWellFormedSchematron(singleDoc, schemaSummary);
  check("assembled single-block document is well-formed", singleResult.valid, JSON.stringify(singleResult.errors));
  check("zero errors", singleResult.errors.length === 0, JSON.stringify(singleResult.errors));
  console.log();
}

// ---- buildFewShotBlock (prompt text) teaches the LLM every "lets" example ----
console.log("=== buildFewShotBlock() prompt text includes every sch:let example ===");
const promptBlock = buildFewShotBlock(schemaSummary);
for (const ex of letsExamples) {
  check(`prompt contains ${ex.id}`, promptBlock.includes(ex.id));
  for (const l of ex.lets) {
    check(
      `prompt contains the literal sch:let line for '${l.name}'`,
      promptBlock.includes(`<sch:let name="${l.name}" value="${l.value}"/>`)
    );
  }
}
console.log();

// ---- Zero regression: every few-shot WITHOUT "lets" has no stray sch:let ----
console.log("=== Regression: few-shots without 'lets' render with no sch:let line ===");
let regressionOk = true;
for (const ex of noLetsExamples) {
  const b = buildDeterministicBlockFromFewShot(ex);
  if (b.includes("<sch:let")) {
    regressionOk = false;
    console.log(`  FAIL unexpected <sch:let> in ${ex.id}`);
  }
}
check(`all ${noLetsExamples.length} few-shots without 'lets' have no stray <sch:let>`, regressionOk);
console.log();

// ---- Zero regression: the full assembled document (every few-shot) is well-formed ----
console.log(`=== Regression: full assembled document (all ${schemaSummary.few_shot_examples.length} few-shots) is well-formed, ids unique ===`);
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
console.log();

// ---- Full generateSchematronDITA() entry point, zero LLM calls needed, for every "lets" example ----
console.log("=== generateSchematronDITA() resolves each real project BRDP 100% deterministically (no LLM call) ===");
const projectBRDPsById = {
  "CURATED-cant-table": {
    id: "CURATED-cant-table",
    definition: "Decidir si: En los topics cuyo <title> sea LISTA DE MATERIAL OBLIGATORIO, LISTA DE MATERIAL IMPREVISTO, ó HERRAMIENTAS Y EQUIPOS DE PRUEBA, cuando haya una tabla cuyo título de columna sea Cant., todas las filas del tbody/row/entry correspondiente deben tener siempre un valor y nunca estar vacías.",
    proposal: "Exime de error las filas cuya columna \"Part\" (primera columna) esté vacía.",
    validation: "Validated",
  },
  "CURATED-ncage-table": {
    id: "CURATED-ncage-table",
    definition: "Valores numéricos y caracteres permitidos en las filas de TODAS aquellas tablas de TODOS los XML del proyecto que contengan una columna con nombre NCAGE. Exime de errores aquellas filas cuya primera columna no tenga nada escrito.",
    proposal: "Debe contener o 5 valores alfanuméricos cuyas letras deben ir en mayúsculas, o \"-\" (para casos en los que no se conoce el dato).",
    validation: "Validated",
  },
};

for (const ex of letsExamples) {
  const brdp = projectBRDPsById[ex.id];
  if (!brdp) {
    console.log(`  SKIP ${ex.id} -- no test BRDP object defined for this id in this script`);
    continue;
  }
  let llmWasCalled = false;
  const result = await generateSchematronDITA([brdp], projectConfig, {
    onlyValidated: false,
    schemaSummary,
    approvals: [],
    callLLM: async () => {
      llmWasCalled = true;
      throw new Error(`callLLM should never be invoked for ${ex.id}`);
    },
    proposeApproval: async () => {},
  });

  console.log(`--- ${ex.id} ---`);
  check("callLLM was never invoked", !llmWasCalled);
  check("result.valid === true", result.valid, JSON.stringify(result.errors));
  check("result.brdpCount === 1", result.brdpCount === 1);
  for (const l of ex.lets) {
    check(`generated xml contains the sch:let for '${l.name}'`, result.xml.includes(`<sch:let name="${l.name}"`));
  }
  check(`generated xml contains the ${ex.id} assert`, result.xml.includes(`id="${ex.id}"`));
}

console.log("\n=== SUMMARY ===");
if (failures === 0) {
  console.log("All checks passed.");
} else {
  console.log(`${failures} check(s) FAILED.`);
  process.exitCode = 1;
}
