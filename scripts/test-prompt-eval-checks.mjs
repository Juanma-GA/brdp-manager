// Tests for the prompt-eval checks added before the reference pass (C2b):
// ignorePlaceholders, max_names in any markup form, and no_parent_as_child.
// Helpers live in scripts/prompt-eval/checks.mjs (run-prompt-eval.mjs logs in
// on import, so it can't be imported here).
//
// Run:  node scripts/test-prompt-eval-checks.mjs
//       node scripts/test-prompt-eval-checks.mjs --responses <dir or responses.json>
// Without --responses the saved answers are the reconstructions in
// scripts/prompt-eval/check-fixtures/; with it, the same expectations run on
// a real pass (the 026ec83 3-run pass: no-dump run 1 fails on proceduralStep,
// run 3 on levelledPara/listItem/sbMaterialInfo, run 2 passes; the P3 checks
// pass in all three suggest-proposal-spanish-title-english-refs runs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distinctSchemaNames, loadSchemaCards, parentsPresentedAsChildren, stripPlaceholders } from "./prompt-eval/checks.mjs";
import { UNFILLED_MARKER_RE } from "../src/utils/proposalMarkers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? " -- " + extra : ""}`);
  }
}

function loadVocabulary(file) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8"));
  return { elements: new Set(j.elements), attributes: new Set(j.attributes) };
}
const vocab42 = loadVocabulary("schema-vocabulary-4-2.json");
const cards42 = loadSchemaCards("S1000D 4.2");
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "prompt-eval", "cases.json"), "utf8")).cases;

// Same evaluation run-prompt-eval.mjs does for not_contains_any.
const notContainsAny = (c, answer) => {
  const text = c.ignorePlaceholders ? stripPlaceholders(answer) : answer;
  return !c.patterns.some((p) => new RegExp(p, c.flags || "").test(text));
};

console.log("stripPlaceholders (UNFILLED_MARKER_RE)");
check("empties [VALUE: …] and [LIST: …]", stripPlaceholders("cada [VALUE: e.g. 90 días] o [LIST: 5 years, 10 years].") === "cada [] o [].");
check("empties hand-typed placeholders", stripPlaceholders("códigos [e C1008, C1234]") === "códigos []");
check("keeps XPath predicates and ranges", stripPlaceholders("para[@x] //a[1] x[.='y'] (//p)[2] [1..n] [@type='x']") === "para[@x] //a[1] x[.='y'] (//p)[2] [1..n] [@type='x']");
check("keeps text outside the brackets", stripPlaceholders("cada 90 días [VALUE: 30]") === "cada 90 días []");
const sample = "a [VALUE: 1] b[2] ([LIST: x]) «[tbd]»";
const stripped = stripPlaceholders(sample);
check("strips exactly what UNFILLED_MARKER_RE finds", !UNFILLED_MARKER_RE.test(stripped.replace(/\[\]/g, "")) && UNFILLED_MARKER_RE.test(sample), stripped);

console.log("P3 checks with ignorePlaceholders");
const p3Case = cases.find((c) => c.id === "suggest-proposal-spanish-title-english-refs");
const p3Checks = p3Case.checks.filter((c) => c.type === "not_contains_any");
check("both P3 checks carry ignorePlaceholders", p3Checks.length === 2 && p3Checks.every((c) => c.ignorePlaceholders === true));
const p3 = (answer) => p3Checks.every((c) => notContainsAny(c, answer));
check("value inside a placeholder passes", p3("cada [VALUE: e.g. 90 días] con [VALUE: ±2 %], registros [VALUE: 5 años]"));
check("90 days outside a placeholder fails", !p3("Se calibrarán cada 90 días con [VALUE: tolerancia]."));
check("±2% outside a placeholder fails", !p3("con una tolerancia de ±2 % [VALUE: x]"));
check("5 years outside a placeholder fails", !p3("Los registros se conservarán 5 años."));
check("without ignorePlaceholders the same allowed answer would fail", !p3Checks.every((c) => notContainsAny({ ...c, ignorePlaceholders: false }, "cada [VALUE: e.g. 90 días]")));

console.log("max_names (any form)");
const names = (t) => distinctSchemaNames(t, vocab42);
check("counts *x*, **x**, `x`, <x>, @x", JSON.stringify(names("*levelledPara*, **listItem**, `dmRef`, <emphasis>, @emphasisType")) === JSON.stringify(["<levelledPara>", "<listItem>", "<dmRef>", "<emphasis>", "@emphasisType"]), JSON.stringify(names("*levelledPara*, **listItem**, `dmRef`, <emphasis>, @emphasisType")));
check("markup inside emphasis: *<para>* and `@id`", JSON.stringify(names("*<para>* y `@id`")) === JSON.stringify(["<para>", "@id"]));
check("bare camelCase in the vocabulary counts", JSON.stringify(names("usa levelledPara aquí")) === JSON.stringify(["<levelledPara>"]));
check("bare ordinary words never count (para, title)", names("es para el title del manual").length === 0);
check("bare camelCase outside the vocabulary never counts", names("un fooBar y otroNombre").length === 0);
check("emphasised ordinary words outside the vocabulary never count", names("*muy importante* y **nota**").length === 0);
check("same name in several forms counts once", names("<para>, *para*, `para`").length === 1);
check("<x> outside the vocabulary still counts", JSON.stringify(names("<pokemon>")) === JSON.stringify(["<pokemon>"]));

console.log("no_parent_as_child (S1000D 4.2 <para>)");
const offenders = (t) => parentsPresentedAsChildren(t, "para", cards42, vocab42).offenders;
check("'dentro de <para> … *proceduralStep*' fails", JSON.stringify(offenders("Dentro de un `<para>` puedes usar *emphasis* o *proceduralStep*.")) === '["proceduralStep"]');
check("'<para> puede contener …' fails for parents", JSON.stringify(offenders("Un `<para>` puede contener *emphasis*, *levelledPara* y *listItem*.")) === '["levelledPara","listItem"]');
check("EN 'can contain'", JSON.stringify(offenders("A <para> can contain <emphasis> and <sbMaterialInfo>.")) === '["sbMaterialInfo"]');
check("EN 'inside a <para>'", JSON.stringify(offenders("Inside a <para> you can place <randomList> or <levelledPara>.")) === '["levelledPara"]');
check("a bullet list introduced by ':' belongs to its sentence", JSON.stringify(offenders("Dentro de `<para>` puedes usar:\n- *emphasis*\n- *proceduralStep*\n\nOtro párrafo con *listItem*.")) === '["proceduralStep"]');
check("real children only: passes", offenders("Dentro de `<para>` caben *emphasis*, *dmRef*, *randomList* y *footnote*.").length === 0);
check("the right direction ('<para> va dentro de <levelledPara>') passes", offenders("`<para>` se usa dentro de *levelledPara*, *listItem* o *proceduralStep*.").length === 0);
check("a parent named before the phrase is not judged", offenders("En *levelledPara*, dentro de `<para>` van *emphasis* y *dmRef*.").length === 0);
check("a negation between the phrase and the name is not judged", offenders("Dentro de `<para>` no puede ir *levelledPara*.").length === 0);
check("footnote (both child and parent) is never an offender", offenders("Dentro de `<para>` puedes usar *footnote*.").length === 0);
check("the case carries the check", !!cases.find((c) => c.id === "ask-open-question-no-dump").checks.find((c) => c.type === "no_parent_as_child" && c.element === "para" && c.standard === "S1000D 4.2"));

console.log("SCHEMA FACTS on the three open-question cases");
for (const id of ["ask-open-question-no-disclaimer", "ask-open-question-partial-list", "ask-open-question-no-dump"]) {
  const last = cases.find((c) => c.id === id).checks.at(-1);
  check(`${id}: not_contains SCHEMA FACTS is the last check`, last.type === "not_contains" && last.pattern === "SCHEMA FACTS");
}

// ---- Saved answers (reconstructed, or a real pass with --responses) ------

const argIndex = process.argv.indexOf("--responses");
let responsesPath = path.join(__dirname, "prompt-eval", "check-fixtures", "responses-reconstructed.json");
if (argIndex !== -1) {
  responsesPath = path.resolve(process.argv[argIndex + 1] || "");
  if (fs.existsSync(responsesPath) && fs.statSync(responsesPath).isDirectory()) responsesPath = path.join(responsesPath, "responses.json");
}
const saved = JSON.parse(fs.readFileSync(responsesPath, "utf8"));
const answersOf = (id) => (saved.cases.find((c) => c.id === id)?.runs || []).map((r) => r.answer ?? "");
console.log(`Saved answers: ${path.relative(process.cwd(), responsesPath)}${saved._readme ? " (RECONSTRUCTED)" : ""}`);

const dump = answersOf("ask-open-question-no-dump");
check("three no-dump answers", dump.length === 3, `got ${dump.length}`);
const dumpOffenders = dump.map(offenders);
dumpOffenders.forEach((o, i) => console.log(`       run ${i + 1}: offenders ${JSON.stringify(o)}; names ${names(dump[i]).length}: ${names(dump[i]).join(", ")}`));
check("run 1 fails on proceduralStep", dumpOffenders[0]?.includes("proceduralStep"), JSON.stringify(dumpOffenders[0]));
check("run 2 passes", dumpOffenders[1]?.length === 0, JSON.stringify(dumpOffenders[1]));
check("run 3 fails on levelledPara, listItem and sbMaterialInfo", ["levelledPara", "listItem", "sbMaterialInfo"].every((n) => dumpOffenders[2]?.includes(n)), JSON.stringify(dumpOffenders[2]));
check("max_names counts the names in italics (some run with 10 or more)", dump.some((a) => names(a).length >= 10), dump.map((a) => names(a).length).join("/"));

const p3Answers = answersOf("suggest-proposal-spanish-title-english-refs");
check("three suggest-proposal answers", p3Answers.length === 3, `got ${p3Answers.length}`);
p3Answers.forEach((a, i) => check(`P3 checks pass on run ${i + 1}`, p3(a), stripPlaceholders(a).slice(0, 200)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
