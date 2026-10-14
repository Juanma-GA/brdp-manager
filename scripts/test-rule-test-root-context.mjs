// Test de reglas DITA: el contexto en la raíz decide a qué documentos se
// aplica. Navantia BRDP-EXT-00034 ("DITA 1.3 Xpath3.0"; contexts quoted
// literally from the real project, lets and asserts reconstructed in
// scripts/rule-test-fixtures/navantia-dita3-reconstructed.sch): the rule
// only applies to documents whose ROOT <title> (or @base) says "registro de
// inspecciones, pruebas y acciones de … en taller / a bordo". Real DITA
// structures (scripts/rule-test-fixtures/structures.json) and graph; no
// network.
//   1. Detection (rootContext.js).
//   2. Part 1: the prompt says the title is the root's own; a literal title
//      the application writes, also on a whole document.
//   3. EXT-00034 end to end: examples with the title in the root → Correct;
//      the real failure (title in a <section>) → correction round with the
//      applicability line, and Inconclusive when it stays.
//   4. Part 2 with a predicate that is not about the title (/*[@base='x']).
//   5. Part 3: no "several <title>" warning on the root; section stays.
//   6. Part 4: BREX unchanged.
//
//     node scripts/test-rule-test-root-context.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { generateRuleTestExamples, prepareRuleTestSetup, notApplicableProblem } from '../src/utils/ruleTestRun.js';
import { rootContextConditions, rootTitleRequirement, ruleIsRootScoped } from '../src/utils/rootContext.js';
import { ruleTestVerdict, verdictCause, runExample } from '../src/utils/ruleTest.js';
import { acceptanceDetails, analyzeRule, rootApplicability } from '../src/utils/ruleTestEngine.js';
import { acceptCauseText, verdictToTestRecord, formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { textFunctionWarnings, repeatingComparisons, viewsFromGraph } from '../src/validation/ruleRepetition.js';
import { schemaGraph } from './lib/schemaGraph.mjs';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { readTextFile } from './lib/textFile.mjs';
import i18n from '../src/i18n/index.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const vocabDita = vocabOf('schema-vocabulary-dita.json');
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const DITA = 'DITA 1.3 Xpath2.0';
const DITA3 = 'DITA 1.3 Xpath3.0';
const TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'];
const structureOf = (standard, schema) => STRUCTURES[`${standard}|${schema}`];
const fetchSchemaCards = async (_std, names) => ({
  cards: {},
  document_schemas: TYPES,
  element_schemas: Object.fromEntries(names.map((n) => [n, TYPES.filter((t) => structureOf(DITA, t)?.elements[n])])),
});
const fetchStructure = async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) });

const SCH = readTextFile(new URL('./rule-test-fixtures/navantia-dita3-reconstructed.sch', import.meta.url));
const navRule = (id) =>
  SCH.match(new RegExp(`<sch:pattern id="p-${id}"[\\s\\S]*?</sch:pattern>`))[0].replace('<sch:pattern', '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const EXT34 = navRule('BRDP-EXT-00034');
const EXT11 = navRule('BRDP-EXT-00011');
const ctxRule = (context, test = 'exists(.//table)') =>
  `<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p-T"><sch:rule context="${context.replace(/'/g, '&apos;')}"><sch:assert id="T" role="error" test="${test.replace(/'/g, '&apos;')}">x</sch:assert></sch:rule></sch:pattern>`;

const TALLER = "matches(translate(lower-case(string(normalize-space(concat(@base, ' ', title)))), 'áéíóúüñ', 'aeiouun'), 'registro de inspecciones, pruebas y acciones de (reparacion|reacondicionamiento) en taller')";
const A_BORDO = TALLER.replace('en taller', 'a bordo');

// ─── 1. Detection ───────────────────────────────────────────────────────────
{
  check('EXT-00034: both contexts are the real ones', EXT34.includes(`/*[${TALLER.replace(/'/g, "'")}]`) && EXT34.includes(`/*[${A_BORDO}]`), EXT34.slice(0, 400));
  const conditions = rootContextConditions(EXT34);
  check('EXT-00034: two root-anchored contexts', conditions.length === 2 && conditions.every((c) => c.root === '*' && c.title && c.base));
  check('EXT-00034: root-scoped', ruleIsRootScoped(EXT34));
  const req = rootTitleRequirement(EXT34);
  check('EXT-00034: requirement title + @base, not a literal', req && req.title && req.base && req.literal === false && req.predicates.length === 2, JSON.stringify(req));
  check("/*[title = 'X']: a literal", rootTitleRequirement(ctxRule("/*[title = 'X']"))?.literal === true);
  check("/topic[normalize-space(title) = 'X']//p: a literal on <topic>", rootTitleRequirement(ctxRule("/topic[normalize-space(title) = 'X']//p"))?.roots?.[0] === 'topic');
  check("/*[@base = 'x']: @base only", (() => { const r = rootTitleRequirement(ctxRule("/*[@base = 'x']")); return r && r.base && !r.title && !r.literal; })());
  check("/*[@id]: root-scoped, but no title requirement", ruleIsRootScoped(ctxRule('/*[@id]')) && rootTitleRequirement(ctxRule('/*[@id]')) === null);
  check('EXT-00011 (*[title=…]//section//…): not root-anchored', rootContextConditions(EXT11).length === 0 && !ruleIsRootScoped(EXT11));
  check("section[title = 'X']//p: not root-anchored", rootContextConditions(ctxRule("section[title = 'X']//p")).length === 0);
  check("//*[title = 'X']: not root-anchored ('//')", rootContextConditions(ctxRule("//*[title = 'X']")).length === 0);
  check('/* without predicate: not a condition', rootContextConditions(ctxRule('/*')).length === 0);
  check("/*[title = 'X'] | //p: not root-scoped (one alternative elsewhere)", !ruleIsRootScoped(ctxRule("/*[title = 'X'] | //p")));
  check('@title in the predicate is not the title', rootTitleRequirement(ctxRule("/*[@title = 'X']")) === null);
}

// ─── 2. Part 1: the prompt ──────────────────────────────────────────────────
const table = (heads) =>
  `<table><tgroup cols="${heads.length}">${heads.map((_, i) => `<colspec colname="c${i + 1}"/>`).join('')}<thead><row>${heads.map((h, i) => `<entry colname="c${i + 1}">${h}</entry>`).join('')}</row></thead><tbody><row>${heads.map((_, i) => `<entry colname="c${i + 1}">x</entry>`).join('')}</row></tbody></tgroup></table>`;
const T = 'Registro de inspecciones, pruebas y acciones de reparación en taller';
const B = 'Registro de inspecciones, pruebas y acciones de reacondicionamiento a bordo';
const docIn = (rootTitle, sectionTitle, heads, base = null) =>
  `<topic id="t1"${base ? ` base="${base}"` : ''}><title>${rootTitle}</title><body><section>${sectionTitle ? `<title>${sectionTitle}</title>` : ''}${table(heads)}</section></body></topic>`;
const answer = (examples) => JSON.stringify({ examples });
const GOOD = answer([
  { label: 'registro completo en taller', expected: 'accept', schema: 'topic', content: docIn(T, null, ['Fecha', 'Firma', 'Resultado']) },
  { label: 'registro a bordo completo', expected: 'accept', schema: 'topic', content: docIn(B, null, ['Fecha', 'Firma']) },
  { label: 'sin fecha', expected: 'reject', schema: 'topic', content: docIn(T, null, ['Firma', 'Resultado']) },
  { label: 'sin firma, a bordo', expected: 'reject', schema: 'topic', content: docIn(B, null, ['Fecha']) },
]);
// The real failure: the record title in a <section>, the topic is
// "Maintenance Procedures" (Mistral, Navantia, EXT-00034).
const REAL_FAILURE = answer([
  { label: 'registro completo', expected: 'accept', schema: 'topic', content: docIn('Maintenance Procedures', T, ['Fecha', 'Firma', 'Resultado']) },
  { label: 'sin fecha', expected: 'reject', schema: 'topic', content: docIn('Maintenance Procedures', T, ['Firma', 'Resultado']) },
  { label: 'sin firma', expected: 'reject', schema: 'topic', content: docIn('Maintenance Procedures', T, ['Fecha', 'Resultado']) },
]);
const BRDP34 = { identifier: 'BRDP-EXT-00034', title: 'Campos obligatorios de los registros', definition: 'Decidir qué campos son obligatorios en los registros de inspecciones.', proposal: 'Los registros de inspecciones, pruebas y acciones llevan los campos Fecha y Firma.' };
async function run(ruleXml, answers, brdp = BRDP34) {
  const asked = [];
  let i = 0;
  const result = await generateRuleTestExamples({
    ruleXml,
    format: 'SCH-DITA',
    standard: DITA3,
    schemaLocation: 'flat',
    brdp,
    vocabulary: vocabDita,
    parseXml,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      const a = answers[Math.min(i, answers.length - 1)];
      i += 1;
      return a;
    },
    fetchSchemaCards,
    fetchStructure,
  });
  return { result, asked };
}
{
  const setup = await prepareRuleTestSetup({ ruleXml: EXT34, standard: DITA3, schemaLocation: 'flat', fetchSchemaCards, fetchStructure, format: 'SCH-DITA', parseXml });
  const rule = setup.promptPlacements.find((p) => p.role === 'rule');
  check('EXT-00034: a whole document of a topic', rule && rule.insertion == null && rule.root === 'topic', JSON.stringify(rule && { insertion: rule.insertion, root: rule.root }));
  check('EXT-00034: no topic title written by the app (not a literal)', !rule?.topicTitle);
  const { asked } = await run(EXT34, [GOOD]);
  const prompt = asked[0].systemPrompt;
  const block = prompt.split('THE RULE DEPENDS ON A TITLE')[1] || '';
  check('EXT-00034 prompt: "documents whose own <title> (or @base)"', block.includes('the rule applies only to documents whose own <title> (or @base)\nmeets one of:'), block.slice(0, 300));
  check('EXT-00034 prompt: both predicates as written', block.includes(`  [${TALLER}]`) && block.includes(`  [${A_BORDO}]`));
  check('EXT-00034 prompt: every example, to accept AND to reject', block.includes('Every example — to accept AND to reject — must be such a document: write\nthat text in the topic\'s own <title> (or @base). Never put it in a <section>.'));
  check('EXT-00034 prompt: never the titled-<section> instruction', !prompt.includes('<section><title>Parts list</title>') && !prompt.includes("never rely on the topic's own title"));

  // A literal: the application writes the title, also on a whole document.
  const lit = ctxRule("/*[title = 'Registro X']");
  const litSetup = await prepareRuleTestSetup({ ruleXml: lit, standard: DITA3, schemaLocation: 'flat', fetchSchemaCards, fetchStructure, format: 'SCH-DITA', parseXml });
  const litRule = litSetup.promptPlacements.find((p) => p.role === 'rule');
  check("/*[title = 'X']: whole document, the application writes the title", litRule?.insertion == null && litRule?.topicTitle?.value === 'Registro X', JSON.stringify(litRule?.topicTitle));
  const litAnswer = answer([
    { label: 'con tabla', expected: 'accept', schema: 'topic', content: `<topic id="a"><title>Maintenance Procedures</title><body>${table(['A'])}</body></topic>` },
    { label: 'sin tabla', expected: 'reject', schema: 'topic', content: '<topic id="a"><title>Maintenance Procedures</title><body><p>x</p></body></topic>' },
  ]);
  const { result: litResult, asked: litAsked } = await run(lit, [litAnswer]);
  const litPrompt = litAsked[0].systemPrompt;
  check("/*[title = 'X'] prompt: the application sets the root's title", litPrompt.includes('<topic> starts with its required <title>; the application sets it to\n  "Registro X", the title the rule asks for.') && litPrompt.includes('That title is the root\'s own: the application sets the\n<title> of your root element to it in every example'));
  check("/*[title = 'X']: every example has the rule's title in its root", litResult.examples.every((e) => /^<topic id="a"><title>Registro X<\/title>/.test(e.xml)), litResult.examples[0]?.xml.slice(0, 80));
  check("/*[title = 'X']: the note on every example", litResult.examples.every((e) => e.topicTitleSet === 'Registro X'));
  const litVerdict = ruleTestVerdict(litResult.examples, litResult.runs, analyzeRule(lit, 'SCH-DITA', { parseXml }));
  check("/*[title = 'X']: Correct with one call", litVerdict.kind === 'correct' && litAsked.length === 1, JSON.stringify(litVerdict));
}

// ─── 3. EXT-00034 end to end ────────────────────────────────────────────────
{
  const { result, asked } = await run(EXT34, [GOOD]);
  check('EXT-00034 good: no correction round', result.status === 'ready' && (result.correction?.attempted || 0) === 0 && asked.length === 1, JSON.stringify(result.correction));
  const statuses = result.runs.map((r) => r.result.status).join(',');
  check('EXT-00034 good: both records accepted, without Fecha / Firma rejected', statuses === 'accepted,accepted,rejected,rejected', statuses);
  check('EXT-00034 good: every example applies', result.runs.every((r) => !r.notApplicable));
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(EXT34, 'SCH-DITA', { parseXml }));
  check('EXT-00034 good: verdict Correct', verdict.kind === 'correct', JSON.stringify(verdict));
}
{
  // The real failure, and the same answer after the correction round.
  const { result, asked } = await run(EXT34, [REAL_FAILURE, REAL_FAILURE]);
  check('EXT-00034 real failure: one correction round', asked.length === 2 && result.correction?.attempted === 3, JSON.stringify(result.correction));
  const lines = (result.correction?.problems || []).map((p) => p.problems.join(' | '));
  const line = notApplicableProblem({ root: 'topic', conditions: [{ predicate: `[${TALLER}]` }, { predicate: `[${A_BORDO}]` }] });
  check('EXT-00034 real failure: the applicability line, exactly', line === `This example must be a document the rule applies to: its root <topic> must meet one of [${TALLER}] or [${A_BORDO}].`, line);
  check('EXT-00034 real failure: every example (reject and accept) gets it', lines.length === 3 && lines.every((l) => l === line), lines.join('\n'));
  check("EXT-00034 real failure: never the assert's test", !lines.some((l) => l.includes('$campos') || l.includes("'fecha'")));
  check('EXT-00034 real failure: never "Keep the nodes" nor "the rule checks values"', !lines.some((l) => /Keep the nodes|checks values/.test(l)));
  const correction = asked[1].messages.map((m) => m.content).join('\n');
  check('EXT-00034 real failure: the request carries the line', correction.includes('This example must be a document the rule applies to: its root <topic> must meet'));
  check('EXT-00034 real failure: reject examples are not case b', result.runs.every((r) => !r.predicateMiss && r.notApplicable?.root === 'topic'));
  const run0 = result.runs[1];
  check('EXT-00034 real failure: cause EN', acceptCauseText(run0, en) === "the root <topic> does not meet the rule's context (it is not a document the rule applies to)", acceptCauseText(run0, en));
  check('EXT-00034 real failure: cause ES', acceptCauseText(run0, es) === 'la raíz <topic> no cumple el contexto de la regla (no es un documento al que se aplique)', acceptCauseText(run0, es));
  check('EXT-00034 real failure: never "has 1 /*"', !/\/\*/.test(acceptCauseText(run0, en)) && !acceptCauseText(run0, es).includes('ninguno cumple'));
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(EXT34, 'SCH-DITA', { parseXml }));
  check('EXT-00034 still failing: Inconclusive (not_applicable, all)', verdict.kind === 'inconclusive' && verdict.why === 'not_applicable' && verdict.which === 'all', JSON.stringify(verdict).slice(0, 200));
  check('EXT-00034 still failing: never "incorrect"', verdict.kind !== 'incorrect');
  const record = verdictToTestRecord(verdict);
  check('EXT-00034 recorded as inconclusive / test_not_applicable', record.result === 'inconclusive' && record.reason.code === 'test_not_applicable');
  const esPredicate = `[${TALLER}] o [${A_BORDO}]`;
  check('EXT-00034 recorded reason ES', formatRuleTestReason(record.reason, es) === `la regla no se aplica a ningún ejemplo (su contexto pide ${esPredicate} en la raíz)`, formatRuleTestReason(record.reason, es));
  check('verdict text ES (panel key)', es('records.ruleTest.verdicts.notApplicable_all', { predicate: esPredicate }) === `No concluyente: la regla no se aplica a ningún ejemplo (su contexto pide ${esPredicate} en la raíz).`);
  check('verdict text EN (panel key)', en('records.ruleTest.verdicts.notApplicable_all', { predicate: '[x]' }) === 'Inconclusive: the rule applies to none of the examples (its context asks the root for [x]).');
  check('verdict cause: regenerate the examples (never "the rule")', verdictCause(verdict, result.runs)?.cause === 'examples');
}
{
  // The correction round fixes it: the title goes to the root.
  const { result, asked } = await run(EXT34, [REAL_FAILURE, GOOD]);
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(EXT34, 'SCH-DITA', { parseXml }));
  check('EXT-00034 corrected: two calls, Correct', asked.length === 2 && verdict.kind === 'correct', JSON.stringify(verdict).slice(0, 200));
}
{
  // Only the reject examples miss the root: the accept ones that apply stay.
  const mixed = answer([
    { label: 'registro completo', expected: 'accept', schema: 'topic', content: docIn(T, null, ['Fecha', 'Firma']) },
    { label: 'sin fecha', expected: 'reject', schema: 'topic', content: docIn('Maintenance Procedures', T, ['Firma']) },
  ]);
  const { result } = await run(EXT34, [mixed, mixed]);
  const lines = (result.correction?.problems || []).map((p) => `${p.label}: ${p.problems.join(' | ')}`);
  check('reject only: only the reject example is sent back', lines.length === 1 && lines[0].startsWith('sin fecha: This example must be a document the rule applies to'), lines.join('\n'));
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(EXT34, 'SCH-DITA', { parseXml }));
  check('reject only, still failing: Inconclusive (which reject)', verdict.kind === 'inconclusive' && verdict.why === 'not_applicable' && verdict.which === 'reject', JSON.stringify(verdict).slice(0, 160));
  check('reject only: verdict text ES', es('records.ruleTest.verdicts.notApplicable_reject', { predicate: '[x]' }) === 'No concluyente: la regla no se aplica a ningún ejemplo que debía rechazar (su contexto pide [x] en la raíz).');
}
{
  // Only the accept examples miss it: they all go back (the test proves
  // nothing about accepting otherwise).
  const mixed = answer([
    { label: 'registro completo', expected: 'accept', schema: 'topic', content: docIn('Maintenance Procedures', T, ['Fecha', 'Firma']) },
    { label: 'otro completo', expected: 'accept', schema: 'topic', content: docIn('Maintenance Procedures', B, ['Fecha', 'Firma']) },
    { label: 'sin fecha', expected: 'reject', schema: 'topic', content: docIn(T, null, ['Firma']) },
  ]);
  const { result } = await run(EXT34, [mixed, mixed]);
  const labels = (result.correction?.problems || []).map((p) => p.label).sort().join(',');
  check('accept only: both accept examples are sent back', labels === 'otro completo,registro completo', labels);
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(EXT34, 'SCH-DITA', { parseXml }));
  check('accept only, still failing: Inconclusive (which accept)', verdict.kind === 'inconclusive' && verdict.which === 'accept', JSON.stringify(verdict).slice(0, 160));
}

// ─── 4. A root predicate that is not about the title ───────────────────────
{
  const rule = ctxRule("/*[@base = 'registro']");
  const doc = (base, body) => `<topic id="a"${base ? ` base="${base}"` : ''}><title>Maintenance Procedures</title><body>${body}</body></topic>`;
  const ok = rootApplicability(rule, 'SCH-DITA', doc('registro', '<p>x</p>'), { parseXml });
  const no = rootApplicability(rule, 'SCH-DITA', doc(null, '<p>x</p>'), { parseXml });
  check("/*[@base = 'x']: applies with @base", ok?.applies === true);
  check("/*[@base = 'x']: does not apply without it", no?.applies === false && no.root === 'topic');
  const run0 = runExample(rule, 'SCH-DITA', { expected: 'reject', xml: doc(null, '<p>x</p>'), schema: 'topic' }, { parseXml });
  check("/*[@base = 'x']: a reject example without @base is not applicable (not case b)", run0.notApplicable && !run0.predicateMiss);
  const details = acceptanceDetails(rule, 'SCH-DITA', doc(null, '<p>x</p>'), 'topic', { parseXml });
  check("/*[@base = 'x']: the cause is not_applicable", details.length === 1 && details[0].case === 'not_applicable');
  const run1 = runExample(rule, 'SCH-DITA', { expected: 'reject', xml: doc('registro', '<p>x</p>'), schema: 'topic' }, { parseXml });
  check("/*[@base = 'x']: with @base it applies and rejects", run1.result.status === 'rejected' && !run1.notApplicable);
  // EXT-00011 (not root-anchored): case b as before.
  const ext11 = runExample(EXT11, 'SCH-DITA', { expected: 'reject', xml: '<topic id="a"><title>Other</title><body><section><p>(b) uno</p></section></body></topic>', schema: 'topic' }, { parseXml });
  check('EXT-00011: never "not applicable" (its context is not at the root)', !ext11.notApplicable && rootApplicability(EXT11, 'SCH-DITA', '<topic/>', { parseXml }) === null);
}

// ─── 5. Part 3: the "several <title>" warning ───────────────────────────────
{
  const graph = schemaGraph(DITA3);
  const opts = { parseXml };
  check('EXT-00034: no "several <title>" warning on the root', textFunctionWarnings(EXT34, 'SCH-DITA', graph, opts).length === 0, JSON.stringify(textFunctionWarnings(EXT34, 'SCH-DITA', graph, opts)));
  check('EXT-00034: no "several <title>" request', repeatingComparisons(EXT34, 'SCH-DITA', viewsFromGraph(graph), opts).length === 0);
  check("/*[normalize-space(title) = 'X']: no warning", textFunctionWarnings(ctxRule("/*[normalize-space(title) = 'X']"), 'SCH-DITA', graph, opts).length === 0);
  const sectionWarn = textFunctionWarnings(ctxRule("section[normalize-space(title) = 'X']//p"), 'SCH-DITA', graph, opts);
  check('section[normalize-space(title)]: still warned', sectionWarn.some((w) => w.argument === 'title'), JSON.stringify(sectionWarn));
  const starWarn = textFunctionWarnings(ctxRule("*[normalize-space(title) = 'X']"), 'SCH-DITA', graph, opts);
  check('*[normalize-space(title)] (not at the root): still warned, as before', starWarn.some((w) => w.argument === 'title'));
}

// ─── 6. Part 4: BREX unchanged ──────────────────────────────────────────────
{
  const graph42 = schemaGraph('S1000D 4.2');
  const rootBrex = `<structureObjectRule><objectPath allowedObjectFlag="0">/dmodule[identAndStatusSection/dmAddress/dmIdent/dmCode/@infoCode = '040']//randomList</objectPath><objectUse>x</objectUse></structureObjectRule>`;
  const doc = `<dmodule><identAndStatusSection><dmAddress><dmIdent><dmCode infoCode="520"/></dmIdent></dmAddress></identAndStatusSection><content><description><levelledPara><para><randomList><listItem><para>x</para></listItem></randomList></para></levelledPara></description></content></dmodule>`;
  check('BREX: no root applicability (null)', rootApplicability(rootBrex, 'BREX-4.2', doc, { parseXml }) === null);
  const r = runExample(rootBrex, 'BREX-4.2', { expected: 'reject', xml: doc, schema: 'descript' }, { parseXml });
  check('BREX root predicate: case b as today (predicateMiss, no notApplicable)', r.predicateMiss === true && !r.notApplicable, JSON.stringify({ pm: r.predicateMiss, na: r.notApplicable }));
  const brexWarn = textFunctionWarnings(
    `<structureObjectRule><objectPath allowedObjectFlag="0">//levelledPara[normalize-space(para) = 'X']</objectPath><objectUse>x</objectUse></structureObjectRule>`,
    'BREX-4.2',
    graph42,
    { parseXml }
  );
  check('BREX normalize-space(para): still warned', brexWarn.some((w) => w.argument === 'para'), JSON.stringify(brexWarn));
  const rootWarn = textFunctionWarnings(
    `<structureObjectRule><objectPath allowedObjectFlag="0">/*[normalize-space(para) = 'X']</objectPath><objectUse>x</objectUse></structureObjectRule>`,
    'BREX-4.2',
    graph42,
    { parseXml }
  );
  check('BREX /*[normalize-space(para)]: still read as any element (unchanged)', rootWarn.some((w) => w.argument === 'para'), JSON.stringify(rootWarn));
}

// ─── 7. DITA templates: the root-scoped rules always apply ─────────────────
// /*[not(parent::*)] (BRDP-D1-00020, BRDP-D1-00065) is anchored at the root
// with a predicate, but every root meets it: nothing changes for them.
{
  const expected = { 'brdp-template-dita-xpath2.xlsx': 'BRDP-D1-00020,BRDP-D1-00065', 'brdp-template-dita-xpath3.xlsx': 'BRDP-D1-00020' };
  for (const file of Object.keys(expected)) {
    const rows = readPublicTemplate(file).filter((row) => row.Rule && ruleIsRootScoped(row.Rule));
    check(`${file}: root-scoped rules are the /*[not(parent::*)] ones`, rows.map((r) => r.ID).join(',') === expected[file], rows.map((r) => r.ID).join(','));
    for (const row of rows) {
      check(`${file} ${row.ID}: no title requirement`, rootTitleRequirement(row.Rule) === null);
      const a = rootApplicability(row.Rule, 'SCH-DITA', '<topic id="a"><title>x</title><body/></topic>', { parseXml });
      check(`${file} ${row.ID}: every root meets it`, a?.applies === true);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
