// Tests for the prompt-eval checks (C2b, C3): ignorePlaceholders, max_names
// in any markup form, and no_parent_as_child. Helpers live in
// scripts/prompt-eval/checks.mjs (run-prompt-eval.mjs logs in on import, so
// it can't be imported here).
//
// Run:  node scripts/test-prompt-eval-checks.mjs
//
// no_parent_as_child is validated against 9 REAL Mistral answers to
// ask-open-question-no-dump (S1000D 4.2, <para>), with the offenders reviewed
// by hand: scripts/prompt-eval/fixtures/no-parent-as-child-fixtures.json.
// Each answer must give EXACTLY its expectedOffenders; an empty list must
// pass. (C3 replaced the reconstructed answers and the --responses /
// --reference modes of C2b.)
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

console.log("CAGE check with ignorePlaceholders");
const cage = cases.find((c) => c.id === "suggest-proposal-cage-code").checks.find((c) => c.type === "not_contains");
const cageOk = (answer) => !new RegExp(cage.pattern, cage.flags || "").test(cage.ignorePlaceholders ? stripPlaceholders(answer) : answer);
check("the CAGE not_contains carries ignorePlaceholders", cage.ignorePlaceholders === true);
check("a CAGE-shaped example inside a placeholder passes", cageOk("Supplier part numbers shall be prefixed with [CONVENTION: e.g. the supplier CAGE code, such as 1ABC2]."));
check("a CAGE-shaped code outside a placeholder fails", !cageOk("Supplier part numbers shall be prefixed with 1ABC2."));

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
const schemaNameCount = (t) => distinctSchemaNames(t, vocab42).filter((n) => n.startsWith("<")).length;
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
// Wording the reference pass (e54b1f2) used and the first version missed.
check("'permitiendo anidar' after the element", JSON.stringify(offenders("`<para>` es la unidad básica, permitiendo anidar *randomList* y pasos (*proceduralStep*).")) === '["proceduralStep"]');
check("'permite incluir'", JSON.stringify(offenders("El `<para>` permite incluir *emphasis* y *listItem*.")) === '["listItem"]');
check("'admite' after the element", JSON.stringify(offenders("`<para>` admite *dmRef* y *levelledPara*.")) === '["levelledPara"]');
check("'tiene como hijos'", JSON.stringify(offenders("`<para>` tiene como hijos *emphasis* y *sbMaterialInfo*.")) === '["sbMaterialInfo"]');
check("'se pueden anidar ... dentro de <para>' (phrase before)", JSON.stringify(offenders("Se pueden anidar varias cosas dentro de `<para>`: *emphasis* y *proceduralStep*.")) === '["proceduralStep"]');
check("EN 'allowing you to nest'", JSON.stringify(offenders("A <para> holds text, allowing you to nest <randomList> and <proceduralStep>.")) === '["proceduralStep"]');
check("EN 'its children include' as the next sentence", JSON.stringify(offenders("<para> is the basic paragraph. Its children include <emphasis> and <listItem>.")) === '["listItem"]');
check("implied subject: 'Admite …' right after a sentence about <para>", JSON.stringify(offenders("`<para>` es el párrafo básico. Admite *emphasis* y *levelledPara*.")) === '["levelledPara"]');
check("implied subject: 'Sus hijos incluyen …'", JSON.stringify(offenders("`<para>` agrupa texto. Sus hijos incluyen *emphasis* y *proceduralStep*.")) === '["proceduralStep"]');
check("implied subject needs the element in the sentence right before", offenders("`<para>` es el párrafo básico. Se usa mucho. Admite *levelledPara*.").length === 0);
check("the verb belongs to another element named in between", offenders("`<para>` va dentro de *levelledPara*, que admite *listItem*.").length === 0);
check("names after a phrase that turns the relation round are not judged", JSON.stringify(offenders("`<para>` admite *emphasis* y se usa dentro de *levelledPara* y *proceduralStep*.")) === "[]");
check("a real child after 'anidar' passes", offenders("`<para>` es flexible, permitiendo anidar *randomList*, *sequentialList* y *footnote*.").length === 0);
check("the case carries the check", !!cases.find((c) => c.id === "ask-open-question-no-dump").checks.find((c) => c.type === "no_parent_as_child" && c.element === "para" && c.standard === "S1000D 4.2"));

console.log("SCHEMA FACTS on the three open-question cases");
for (const id of ["ask-open-question-no-disclaimer", "ask-open-question-partial-list", "ask-open-question-no-dump"]) {
  const last = cases.find((c) => c.id === id).checks.at(-1);
  check(`${id}: not_contains SCHEMA FACTS is the last check`, last.type === "not_contains" && last.pattern === "SCHEMA FACTS");
}

console.log("no_parent_as_child: wording added in C3");
check("'También admite …' after a sentence about <para>", JSON.stringify(offenders("`<para>` puede contener *emphasis*. También admite *sbMaterialInfo* en contextos técnicos.")) === '["sbMaterialInfo"]');
check("'Además incluye …'", JSON.stringify(offenders("El `<para>` agrupa texto. Además incluye *listItem*.")) === '["listItem"]');
check("'Además, puede contener …'", JSON.stringify(offenders("El `<para>` agrupa texto. Además, puede contener *levelledPara*.")) === '["levelledPara"]');
check("an abbreviation never cuts the sentence ('(ej. *dmRef*). También admite …')", JSON.stringify(offenders("`<para>` puede contener *emphasis* (ej. *dmRef*, *symbol*). También admite *sbMaterialInfo*.")) === '["sbMaterialInfo"]');
check("'p. ej.' and 'e.g.' too", JSON.stringify(offenders("A <para> can contain inline markup (e.g. <dmRef>). It also contains <listItem>.")) === '["listItem"]');
check("'<para> debe:' + '- Contener …' judges that item", JSON.stringify(offenders("En la práctica, <para> debe:\n- Contener texto o elementos como *dmRef* y *proceduralStep*.\n- Evitar párrafos largos.")) === '["proceduralStep"]');
check("'<para> debe:' items that do not say 'contain' are not judged", offenders("En la práctica, <para> debe:\n- Ir dentro de *levelledPara* o *proceduralStep*.\n- Contener texto plano.").length === 0);
check("'<para> must:' + '- Contain …'", JSON.stringify(offenders("In practice, <para> must:\n- Contain text and <levelledPara>.")) === '["levelledPara"]');
check("'Contenido permitido:' after <para> is named: every item is its content", JSON.stringify(offenders("El `<para>` es el párrafo.\n\n**Contenido permitido**:\n- **Hijos comunes**: *emphasis*, *dmRef*.\n- **Hijos adicionales**: *listItem*.")) === '["listItem"]');
check("'Allowed content:' in English", JSON.stringify(offenders("<para> is the paragraph.\n\nAllowed content:\n- <emphasis>\n- <sbMaterialInfo>")) === '["sbMaterialInfo"]');
check("'Contenido permitido:' with real children only passes", offenders("El `<para>` es el párrafo.\n\n**Contenido permitido**:\n- **Atributos**: `@id`.\n- **Hijos comunes**: `emphasis`, `dmRef`, `randomList`.").length === 0);
check("'Contenido permitido:' when the answer is not about <para> is not judged", offenders("El *levelledPara* agrupa párrafos.\n\nContenido permitido:\n- *proceduralStep*").length === 0);

console.log("no_parent_as_child: 9 real answers (fixtures, reviewed by hand)");
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "prompt-eval", "fixtures", "no-parent-as-child-fixtures.json"), "utf8"));
check("fixtures are about S1000D 4.2 <para>", fixtures.element === "para" && fixtures.standard === "S1000D 4.2");
check("9 answers", fixtures.answers.length === 9, String(fixtures.answers.length));
for (const a of fixtures.answers) {
  const key = `${a.commit}#${a.run}`;
  const expected = [...a.expectedOffenders].sort();
  const r = parentsPresentedAsChildren(a.answer, fixtures.element, loadSchemaCards(fixtures.standard), vocab42);
  const got = [...r.offenders].sort();
  const namesAnything = schemaNameCount(a.answer) > 0;
  check(
    `${key}: exactly ${JSON.stringify(expected)}`,
    JSON.stringify(got) === JSON.stringify(expected),
    `got ${JSON.stringify(got)}; sentences analysed: ${r.units.map((u) => u.slice(0, 80)).join(" | ")}`
  );
  if (!namesAnything) check(`${key}: no element names -> nothing to analyse, passes`, r.offenders.length === 0);
}
const dumpNames = fixtures.answers.map((a) => names(a.answer).length);
console.log(`       max_names on the 9 answers: ${dumpNames.join("/")}`);
check("max_names counts the names in italics (some real answer with 10 or more)", dumpNames.some((n) => n >= 10), dumpNames.join("/"));
check("an answer with no element names passes (nothing to analyse)", offenders("Es un párrafo; úsalo con moderación.").length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
