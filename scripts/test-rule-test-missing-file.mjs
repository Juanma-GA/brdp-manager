// Test de reglas DITA: un ejemplo de dosier al que le falta un fichero va a la
// corrección. Navantia BRDP-EXT-00015, RECONSTRUCTED in scripts/
// rule-test-fixtures/navantia-dita3-missing-file-ext-00015.sch (the real
// file is not in the repo): the ditamap of the example meant to be rejected
// pointed to topics/procedimiento_L00009.dita and the AI never wrote it.
// Real DITA structures (scripts/rule-test-fixtures/structures.json); no
// network.
//
//     node scripts/test-rule-test-missing-file.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { ruleTestVerdict, verdictCause } from '../src/utils/ruleTest.js';
import { missingDossierFiles, missingFilesProblem } from '../src/utils/ruleTestDossier.js';
import { acceptCauseText, formatRuleTestReason, verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
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
const v = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-dita.json', import.meta.url)));
const vocabDita = { elements: new Set(v.elements), attributes: new Set(v.attributes) };
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'];
const st = (t) => STRUCTURES[`DITA 1.3 Xpath2.0|${t}`];
const FORMAT = 'SCH-DITA';
const STANDARD = 'DITA 1.3 Xpath3.0';
const SCH = readTextFile(new URL('./rule-test-fixtures/navantia-dita3-missing-file-ext-00015.sch', import.meta.url));
const RULE = SCH.match(/<sch:pattern id="p-BRDP-EXT-00015"[\s\S]*?<\/sch:pattern>/)[0].replace('<sch:pattern', '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

const L9 = 'topics/procedimiento_L00009.dita';
const L10 = 'topics/procedimiento_L00010.dita';
const MAP = `<map><title>Dosier</title><topicref href="${L9}"/><topicref href="${L10}"/></map>`;
const sheet = (id, text) => `<topic id="${id}"><title>Procedimiento ${id}</title><body><p>${text}</p></body></topic>`;
const ACCEPT = {
  label: 'Cita a tabla de una ficha mencionada',
  expected: 'accept',
  schema: 'map',
  content: MAP,
  files: [
    { path: L9, content: sheet('L00009', 'Desmontar la bomba.') },
    { path: L10, content: sheet('L00010', 'Véase la Tabla 2.1 de la ficha L00009.') },
  ],
};
// As in the real case: L00009 is in the ditamap but not written.
const REJECT_MISSING = {
  label: 'Cita a tabla con número en formato X.Y en ficha NO mencionada',
  expected: 'reject',
  schema: 'map',
  content: MAP,
  files: [{ path: L10, content: sheet('L00010', 'Montar la bomba.') }],
};
const REJECT_FIXED = { ...REJECT_MISSING, files: [...REJECT_MISSING.files, { path: L9, content: sheet('L00009', 'Véase la Tabla 3.1 de la ficha L00099.') }] };
const answer = (examples) => JSON.stringify({ examples });
const fetchSchemaCards = async (_s, names) => ({ cards: {}, document_schemas: TYPES, element_schemas: Object.fromEntries(names.map((n) => [n, TYPES.filter((t) => st(t)?.elements[n])])) });
const fetchStructure = async (_s, t) => (st(t) ? { available: true, ...st(t) } : { available: false });
async function run(answers) {
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: RULE, format: FORMAT, standard: STANDARD, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00015', title: 'Tablas citadas', definition: 'Decidir cómo se citan las tablas de otra ficha.', proposal: 'Una tabla citada como "Tabla X.Y de la ficha N" es de una ficha del dosier.' },
    vocabulary: vocabDita, parseXml,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      return answers[Math.min(asked.length - 1, answers.length - 1)];
    },
    fetchSchemaCards, fetchStructure,
  });
  const analysis = analyzeRule(RULE, FORMAT, { parseXml });
  return { result, asked, verdict: result.examples ? ruleTestVerdict(result.examples, result.runs, analysis) : null };
}

check('EXT-00015 (reconstructed): an executable dossier rule', analyzeRule(RULE, FORMAT, { parseXml }).dossier === true);

// ─── 1. The real case: the correction adds the missing file ─────────────────
{
  const { result, asked, verdict } = await run([answer([ACCEPT, REJECT_MISSING]), answer([ACCEPT, REJECT_FIXED])]);
  check('1: two LLM calls (one correction round)', asked.length === 2, String(asked.length));
  const correction = asked[1]?.messages.at(-1).content || '';
  const expected = `The ditamap points to ${L9}, which is not in the dossier. Add that file (a complete DITA document) with the content that breaks the decision, or point the ditamap to a file you write.`;
  check('1: the correction names the missing path (exact text)', correction.includes(expected), correction.slice(0, 900));
  check('1: only the reject example is sent', correction.includes(REJECT_MISSING.label) && !correction.includes(ACCEPT.label), correction.slice(0, 600));
  check('1: the correction never asks for the rule\'s nodes', !correction.includes('must contain a node matched by'));
  check('1: the corrected example is rejected ✓', result.runs[1].result?.status === 'rejected' && result.runs[1].matches === true, JSON.stringify(result.runs[1].result?.status));
  check('1: verdict Correct', verdict?.kind === 'correct', JSON.stringify(verdict));
}

// ─── 2. The correction does not add it → inconclusive with the new reason ───
{
  const { result, asked, verdict } = await run([answer([ACCEPT, REJECT_MISSING]), answer([ACCEPT, REJECT_MISSING])]);
  check('2: one correction round', asked.length === 2);
  check('2: the run carries missingFiles (never case b)', result.runs[1].missingFiles?.[0]?.path === L9 && result.runs[1].predicateMiss === false, JSON.stringify(result.runs[1].missingFiles));
  check('2: verdict inconclusive / missing_file with the path', verdict?.kind === 'inconclusive' && verdict.why === 'missing_file' && verdict.paths.join() === L9, JSON.stringify(verdict));
  check('2: cause = examples (regenerate), never "the rule"', verdictCause(verdict, result.runs)?.cause === 'examples');
  const outcome = verdictToTestRecord(verdict);
  check('2: recorded as inconclusive with test_missing_file', outcome.result === 'inconclusive' && outcome.reason.code === 'test_missing_file' && outcome.reason.params.paths.join() === L9, JSON.stringify(outcome));
  check('2: reason text EN', formatRuleTestReason(outcome.reason, en) === `the example meant to be rejected points to ${L9}, which is not in the dossier`, formatRuleTestReason(outcome.reason, en));
  check('2: reason text ES', formatRuleTestReason(outcome.reason, es) === `el ejemplo a rechazar apunta a ${L9}, que no está en el dosier`, formatRuleTestReason(outcome.reason, es));
  check('2: verdict text ES', es('records.ruleTest.verdicts.missingFile', { paths: L9 }) === `No concluyente: el ejemplo a rechazar apunta a ${L9}, que no está en el dosier.`);
  check('2: verdict text EN', en('records.ruleTest.verdicts.missingFile', { paths: L9 }) === `Inconclusive: the example meant to be rejected points to ${L9}, which is not in the dossier.`);
  check('2: cause under the example ES', acceptCauseText(result.runs[1], es) === `le falta ${L9}, a la que apunta el ditamap`, acceptCauseText(result.runs[1], es));
  check('2: cause under the example EN', acceptCauseText(result.runs[1], en) === `it lacks ${L9}, which the ditamap points to`, acceptCauseText(result.runs[1], en));
  check('2: shown as "Por qué la regla lo aceptó: le falta …"', es('records.ruleTest.acceptedBecause', { cause: acceptCauseText(result.runs[1], es) }) === `Por qué la regla lo aceptó: le falta ${L9}, a la que apunta el ditamap.`);
}

// ─── 3. Edge cases ──────────────────────────────────────────────────────────
{
  // reject, a file missing, the rule already rejects: never corrected
  const rejects = { ...REJECT_MISSING, files: [{ path: L10, content: sheet('L00010', 'Véase la Tabla 3.1 de la ficha L00099.') }] };
  const { asked, result, verdict } = await run([answer([ACCEPT, rejects])]);
  check('3a: reject, file missing, rule rejects → one call, no missingFiles', asked.length === 1 && !result.runs[1].missingFiles && verdict.kind === 'correct', JSON.stringify([asked.length, verdict]));
  check('3a: the warning is still shown', result.runs[1].validation.referenceWarnings.length === 1);
}
{
  // accept, a file missing: only the warning
  // (it still cites a table of a mentioned sheet: a value rule needs a
  // matched node in an accept example, a separate correction)
  const acceptMissing = { ...ACCEPT, files: [{ path: L10, content: sheet('L00010', 'Véase la Tabla 2.1 de la ficha L00009.') }] };
  const { asked, result } = await run([answer([acceptMissing, REJECT_FIXED])]);
  check('3b: accept with a missing file → no correction, warning only', asked.length === 1 && !result.runs[0].missingFiles && result.runs[0].validation.referenceWarnings.length === 1, JSON.stringify([asked.length, result.runs[0].missingFiles]));
}
{
  // reject, no missing file, rule accepts (citation of a mentioned sheet)
  const caseB = { ...REJECT_MISSING, files: [{ path: L9, content: sheet('L00009', 'x') }, { path: L10, content: sheet('L00010', 'Véase la Tabla 3.1 de la ficha L00009.') }] };
  const { asked, result } = await run([answer([ACCEPT, caseB]), answer([ACCEPT, caseB])]);
  const correction = asked[1]?.messages.at(-1).content || '';
  check('3c: no missing file → no missingFiles and no missing-file line', !result.runs[1].missingFiles && !correction.includes('not in the dossier'), correction.slice(0, 300));
}
{
  // a conref to an id inside a file that IS in the dossier
  const conref = { path: L10, content: `<topic id="L00010"><title>P</title><body><p conref="procedimiento_L00009.dita#L00009/p1"/><p>x</p></body></topic>` };
  check('3d: conref to an id in a present file is not a missing file', missingDossierFiles([]).length === 0);
  const withConref = { ...REJECT_FIXED, files: [REJECT_FIXED.files[1], conref] };
  const { result } = await run([answer([ACCEPT, withConref])]);
  check('3d: …no warning, no missingFiles', result.runs[1].validation.referenceWarnings.length === 0 && !result.runs[1].missingFiles, JSON.stringify(result.runs[1].validation.referenceWarnings));
}
{
  // several paths: at most 4, "+N more"; a file other than the ditamap
  const many = ['a.dita', 'b.dita', 'c.dita', 'd.dita', 'e.dita'].map((p) => ({ path: `topics/${p}`, from: 'dossier.ditamap' }));
  check('3e: five paths → four and "+1 more"', missingFilesProblem(many).startsWith('The ditamap points to topics/a.dita, topics/b.dita, topics/c.dita, topics/d.dita, +1 more, which are not in the dossier. Add those files (complete DITA documents)'), missingFilesProblem(many));
  const fromFile = missingFilesProblem([{ path: 'x.dita', from: L10 }]);
  check('3e: from a sheet → names the sheet', fromFile.startsWith(`The file ${L10} points to x.dita, which is not in the dossier.`) && fromFile.endsWith('or point it to a file you write.'), fromFile);
  check('3e: the same path twice counts once', missingDossierFiles([{ file: 'dossier.ditamap', attr: 'href', value: 'a.dita' }, { file: L10, attr: 'href', value: 'a.dita#x' }]).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
