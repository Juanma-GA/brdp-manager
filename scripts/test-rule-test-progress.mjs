// Test de reglas: progreso, cancelación y causas (Parts 1.2-1.4 of "progreso
// y límite de tiempo, causas en Schematron"). Plain Node, no test runner.
//   1. generateRuleTestExamples reports its steps (onStep): preparing →
//      waiting → correcting N → proposal (only when the Proposal check is
//      the only thing still pending).
//   2. Cancelling (isCurrent false) while the answer is awaited: null, and
//      no correction round or any further call.
//   3. Schematron: each violation names its assert/report, id and test;
//      two failed asserts → both; a report → kind "report".
//   4. One cause sentence: the incorrect verdict says only "Test failed."
//      (verdicts.failed), the cause is said once; the inconclusive and
//      "no example could run" verdicts no longer repeat "regenerate".
// Run: node scripts/test-rule-test-progress.mjs
import { DOMParser } from '@xmldom/xmldom';
import fs from 'node:fs';
import i18n from '../src/i18n/index.js';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { verdictCause } from '../src/utils/ruleTest.js';

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
  const doc = new DOMParser({ errorHandler: (_l, m) => messages.push(m) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0]);
  return doc;
}
const FORMAT = 'SCH-DITA';
const STANDARD = 'DITA 1.3 Xpath2.0';
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const vocab0 = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-dita.json', import.meta.url)));
const VOCAB = { elements: new Set(vocab0.elements), attributes: new Set(vocab0.attributes) };
const fetchStructure = async (_std, schema) => {
  const s = STRUCTURES[`${STANDARD}|${schema}`];
  return s ? { available: true, ...s } : { available: false };
};
const fetchSchemaCards = async (_std, names) => ({
  cards: {},
  document_schemas: ['topic', 'task', 'map'],
  element_schemas: Object.fromEntries(names.map((n) => [n, ['topic', 'task']])),
});
const RULE = '<sch:pattern id="p"><sch:rule context="note"><sch:assert role="error" id="N-1" test="@type">A note needs a type.</sch:assert></sch:rule></sch:pattern>';
const BRDP = { identifier: 'BRDP-X', title: 'Note type', definition: 'Decide whether notes have a type.', proposal: 'Every note shall have @type.' };
const GOOD = { examples: [
  { label: 'typed', expected: 'accept', schema: 'topic', content: '<p>x</p><note type="warning">Hot.</note>' },
  { label: 'untyped', expected: 'reject', schema: 'topic', content: '<p>x</p><note>Hot.</note>' },
] };
const BAD = { examples: [GOOD.examples[0], { label: 'untyped', expected: 'reject', schema: 'topic', content: '<note><frobnicate/>Hot.</note>' }] };

async function run({ answers, proposalDelay = 0, askDelay = 50, isCurrent = () => true, onAsk = () => {} }) {
  const steps = [];
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: RULE, format: FORMAT, standard: STANDARD, schemaLocation: 'flat', brdp: BRDP, vocabulary: VOCAB, parseXml,
    ask: async (messages) => {
      asked.push(messages);
      onAsk(asked.length);
      await new Promise((r) => setTimeout(r, askDelay));
      return JSON.stringify(answers[Math.min(asked.length - 1, answers.length - 1)]);
    },
    askProposalCheck: async () => {
      await new Promise((r) => setTimeout(r, proposalDelay));
      return '{"implements": "yes", "reason": ""}';
    },
    ruleDescription: 'Each note must have @type.',
    onStep: (s) => steps.push(s.step === 'correcting' ? `correcting:${s.count}` : s.step),
    isCurrent,
    fetchSchemaCards, fetchStructure, fetchSchemaAttribute: async () => ({ owners: [] }),
  });
  return { result, steps, asked };
}

// ─── 1. Steps ───────────────────────────────────────────────────────────────
{
  const { result, steps } = await run({ answers: [GOOD] });
  check('ready', result?.status === 'ready', JSON.stringify(result?.error));
  check('steps: preparing, waiting (proposal already answered)', steps.join(',') === 'preparing,waiting', steps.join(','));
}
{
  const { result, steps } = await run({ answers: [BAD, GOOD] });
  check('with a correction round: preparing, waiting, correcting:1', steps.join(',') === 'preparing,waiting,correcting:1', steps.join(','));
  check('  corrected', result?.correction?.fixed === 1, JSON.stringify(result?.correction));
}
{
  const { steps } = await run({ answers: [GOOD], proposalDelay: 300 });
  check('the Proposal check the only thing pending: "proposal" last', steps.join(',') === 'preparing,waiting,proposal', steps.join(','));
}

// ─── 2. Cancel ──────────────────────────────────────────────────────────────
{
  let current = true;
  const { result, asked } = await run({ answers: [BAD, GOOD], isCurrent: () => current, onAsk: (n) => { if (n === 1) current = false; } });
  check('cancelled while waiting: null', result === null, JSON.stringify(result));
  check('cancelled: no correction round, no further call', asked.length === 1, String(asked.length));
}

// ─── 3. Schematron cause ────────────────────────────────────────────────────
{
  const two = '<sch:pattern id="p"><sch:rule context="note"><sch:assert id="A-1" test="@type">t</sch:assert><sch:assert id="A-2" test="exists(p)">p</sch:assert></sch:rule></sch:pattern>';
  const r = runRuleOnFragment(two, FORMAT, '<topic id="t"><title>x</title><body><note>Hot.</note></body></topic>', null, { parseXml });
  const checks = r.violations.map((v) => v.check);
  check('two failed asserts: both named', r.status === 'rejected' && checks.length === 2 && checks[0].id === 'A-1' && checks[1].id === 'A-2', JSON.stringify(checks));
  check('  kind assert and the test', checks.every((c) => c.kind === 'assert') && checks[0].test === '@type' && checks[1].test === 'exists(p)', JSON.stringify(checks));
  const rep = '<sch:pattern id="p"><sch:rule context="note"><sch:report id="R-1" test="@type = \'danger\'">no danger</sch:report></sch:rule></sch:pattern>';
  const rr = runRuleOnFragment(rep, FORMAT, '<topic id="t"><title>x</title><body><note type="danger">Hot.</note></body></topic>', null, { parseXml });
  check('a report: kind report, its test', rr.violations[0]?.check?.kind === 'report' && rr.violations[0].check.test === "@type = 'danger'", JSON.stringify(rr.violations));
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  check('texts EN', en('records.ruleTest.schematronCause', { checks: en('records.ruleTest.schematronAssertNotMet', { id: 'BRDP-EXT-00004a', test: 'exists($tablasPlan) = exists($celdasProc)' }) }) === 'Why the rule rejected it: BRDP-EXT-00004a is not met (exists($tablasPlan) = exists($celdasProc)).');
  check('texts ES', es('records.ruleTest.schematronCause', { checks: es('records.ruleTest.schematronAssertNotMet', { id: 'BRDP-EXT-00004a', test: 'exists($tablasPlan) = exists($celdasProc)' }) }) === 'Por qué la regla lo rechazó: no se cumple BRDP-EXT-00004a (exists($tablasPlan) = exists($celdasProc)).');
  check('report ES', es('records.ruleTest.schematronReportMet', { id: 'R-1', test: 'x' }) === 'se cumple R-1 (x)');
  // BREX violations carry no check: the cause stays as it was.
  const brex = runRuleOnFragment('<structureObjectRule id="b"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>', 'BREX-4.2', '<para><emphasis>x</emphasis></para>', 'descript', { parseXml });
  check('BREX: no check on the violation (cause unchanged)', brex.status === 'rejected' && brex.violations.every((v) => v.check === undefined), JSON.stringify(brex.violations));
}

// ─── 4. One cause sentence ──────────────────────────────────────────────────
{
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  check('verdicts.failed EN/ES', en('records.ruleTest.verdicts.failed') === 'Test failed.' && es('records.ruleTest.verdicts.failed') === 'Prueba fallida.');
  check('the long permissive/strict verdicts are gone', !i18n.exists('records.ruleTest.verdicts.permissive') && !i18n.exists('records.ruleTest.verdicts.strict'));
  check('inconclusive no longer says "Regenerate the examples"', !/regenerat/i.test(en('records.ruleTest.verdicts.nothingSelected')) && !/regenera/i.test(es('records.ruleTest.verdicts.nothingSelected')));
  check('no example ran: no "regenerate" in the verdict', !/regenerat/i.test(en('records.ruleTest.verdicts.noRunnableHint')) && !/regenera/i.test(es('records.ruleTest.verdicts.noRunnableHint')));
  const ran = [{ validation: { runnable: true } }, { validation: { runnable: true } }];
  check('incorrect: cause rule, once', verdictCause({ kind: 'incorrect', permissive: true }, ran)?.cause === 'rule');
  check('inconclusive: cause examples (the only "generate again")', verdictCause({ kind: 'inconclusive', why: 'nothing_selected' }, ran)?.cause === 'examples');
  check('correct/review: no cause', verdictCause({ kind: 'correct' }, ran) === null && verdictCause({ kind: 'review', mismatch: 'x' }, ran) === null);
  check('timeout code EN/ES', en('errors.codes.llm_timeout', { seconds: 300 }) === 'The AI did not answer within 300 s. Try again.' && es('errors.codes.llm_timeout', { seconds: 300 }) === 'La IA no ha respondido en 300 s. Vuelve a intentarlo.');
  check('progress texts EN/ES', en('records.ruleTest.progress.correcting', { count: 2 }) === 'Correcting 2 examples…' && es('records.ruleTest.progress.waiting') === 'Esperando la respuesta de la IA…' && es('records.ruleTest.progress.proposal') === 'Comprobando la Propuesta…');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
