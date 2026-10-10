// Mejoras H: the correction round can never remove exactly what the schema
// limits. Real cases (Mistral pass, 08/10):
//   1. rule-test-dita-xpath3-let -- each <step> has exactly one <cmd>; the
//      example meant to be rejected had two <cmd> ("<step> allows at most 1
//      <cmd>"), the correction merged them into one, the rule accepted it
//      and the verdict blamed the rule.
//   2. rule-test-3-0-1-applic-at-most-one-evaluate (BRDP-EXT-02786) -- the
//      example meant to be accepted had two <evaluate> directly in <applic>
//      ("<applic> allows at most 1 <evaluate>"), the correction merged them
//      into one <evaluate> with two <assert> and the rule rejected it.
// Both through generateRuleTestExamples with a fake `ask`, on the real
// structures (DITA task, S1000D 3.0.1 descript) and vocabularies.
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { editExample, ruleTestVerdict, verdictCause } from '../src/utils/ruleTest.js';
import { countWrittenElements, generateRuleTestExamples, keepSchemaLimitedExamples, lostSchemaLimit } from '../src/utils/ruleTestRun.js';
import { metadataXml } from '../src/utils/ruleTestSkeleton.js';
import { verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
import { schemaGraph } from './lib/schemaGraph.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
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
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const vocabOf = (file) => {
  const v = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(v.elements), attributes: new Set(v.attributes) };
};

// ─── Case 1: DITA, each <step> has exactly one <cmd> ──────────────────────
const DITA_STD = 'DITA 1.3 Xpath3.0';
const ditaStructure = (schema) => STRUCTURES[`DITA 1.3 Xpath2.0|${schema}`];
const vocabDita = vocabOf('schema-vocabulary-dita.json');
const STEP_RULE =
  '<sch:pattern id="p-BRDP-EVAL-RT-DL"><sch:rule context="step"><sch:let name="cuenta" value="function($s as element()) as xs:integer { count($s/cmd) }"/><sch:let name="n" value="$cuenta(.)"/><sch:assert id="BRDP-EVAL-RT-DL" role="error" test="$n = 1">Each step has exactly one command; found <sch:value-of select="$n"/>.</sch:assert></sch:rule></sch:pattern>';
const ONE_CMD = '<step><cmd>Remove the four bolts from the pump cover.</cmd></step>';
const TWO_CMDS = '<step><cmd>Remove the bolts.</cmd><cmd>Lift the pump cover.</cmd></step>';
const MERGED = '<step><cmd>Remove the bolts and lift the pump cover.</cmd></step>';
const NO_CMD = '<step><info>Wait for the pump to stop.</info></step>';

async function runDita(answers) {
  const asked = [];
  let i = 0;
  const result = await generateRuleTestExamples({
    ruleXml: STEP_RULE,
    format: 'SCH-DITA',
    standard: DITA_STD,
    schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EVAL-RT-DL', title: 'Commands per step', definition: 'Decide how many commands a step may contain.', proposal: 'Each <step> shall contain exactly one <cmd>.' },
    vocabulary: vocabDita,
    parseXml,
    ask: async (messages) => {
      asked.push(messages);
      const a = answers[Math.min(i++, answers.length - 1)];
      return typeof a === 'string' ? a : JSON.stringify(a);
    },
    fetchSchemaCards: async (_std, names) => ({
      cards: {},
      document_schemas: ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'],
      element_schemas: Object.fromEntries(names.map((n) => [n, ['topic', 'task', 'map'].filter((t) => ditaStructure(t).elements[n])])),
    }),
    fetchStructure: async (_std, schema) => ({ available: true, ...ditaStructure(schema) }),
  });
  return { result, asked, calls: i };
}
const ditaAnswer = (...examples) => ({ examples: examples.map(([label, expected, content]) => ({ label, expected, schema: 'task', content })) });
const lastUser = (asked) => asked[asked.length - 1]?.at(-1)?.content || '';
const verdictOf = (result) => ruleTestVerdict(result.examples, result.runs);

check('precondition: DITA <step> allows at most 1 <cmd>', ditaStructure('task').models.step.max.cmd === 1);

// 1 as-is: the correction merges the two <cmd> → discarded.
{
  const first = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', TWO_CMDS]);
  const merged = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', MERGED]);
  const { result, asked, calls } = await runDita([first, merged]);
  check('1: one correction round, naming the maximum', calls === 2 && /<step> allows at most 1 <cmd>; the example has 2/.test(lastUser(asked)), lastUser(asked));
  check('1: the correction is discarded -- the example keeps its two <cmd>', result.examples[1].content === TWO_CMDS, result.examples[1].content);
  check('1: example carries the schema limit', JSON.stringify(result.examples[1].schemaLimit) === JSON.stringify({ element: 'cmd', parent: 'step', max: 1 }), JSON.stringify(result.examples[1].schemaLimit));
  check('1: example not valid, not run', result.runs[1].validation.runnable === false && result.runs[1].result === null);
  check('1: counted as not corrected (0 of 1)', result.correction.attempted === 1 && result.correction.fixed === 0, JSON.stringify(result.correction));
  const verdict = verdictOf(result);
  check('1: verdict inconclusive with the schema limit, never incorrect', verdict.kind === 'inconclusive' && verdict.schemaLimit?.element === 'cmd', JSON.stringify(verdict));
  check('1: never "covered by the schema"', verdict.kind !== 'schema_covered');
  check('1: recorded as inconclusive, as today', JSON.stringify(verdictToTestRecord(verdict)) === JSON.stringify({ result: 'inconclusive', reason: { code: 'test_missing_expectation', params: {} } }), JSON.stringify(verdictToTestRecord(verdict)));
  check('1: no "regenerate the examples" cause', verdictCause(verdict, result.runs) === null);
  // texts EN/ES
  check('1.2 EN', en('records.ruleTest.schemaLimitExample', result.examples[1].schemaLimit) === '<step> allows at most 1 <cmd>: this example cannot be written within the schema (the correction removed <cmd>).');
  check('1.2 ES', es('records.ruleTest.schemaLimitExample', result.examples[1].schemaLimit) === '<step> admite como mucho 1 <cmd>: este ejemplo no se puede escribir dentro del esquema (la corrección quitaba <cmd>).');
  check('1.3 EN', en('records.ruleTest.verdicts.schemaLimit', verdict.schemaLimit) === 'The schema prevents writing the example that breaks the decision (<step> allows at most 1 <cmd>); the schema may already enforce it.');
  check('1.3 ES', es('records.ruleTest.verdicts.schemaLimit', verdict.schemaLimit) === 'El esquema impide escribir el ejemplo que incumple la decisión (<step> admite como mucho 1 <cmd>); puede que el esquema ya lo imponga.');
  // Run again with a hand edit: the user's example -- the mark goes.
  const edited = editExample(result.examples[1], NO_CMD, undefined, result.setup, parseXml);
  check('1.4 hand edit drops the schema limit', !edited.schemaLimit && edited.editedByUser === true);
  const unchanged = editExample(result.examples[1], TWO_CMDS, undefined, result.setup, parseXml);
  check('1.4 run again unchanged keeps it', unchanged.schemaLimit?.element === 'cmd');
}

// 1 + a third valid reject example the rule rejects (<step> without <cmd>) → correct.
{
  const first = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', TWO_CMDS], ['Step without a command', 'reject', NO_CMD]);
  const merged = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', MERGED], ['Step without a command', 'reject', NO_CMD]);
  const { result } = await runDita([first, merged]);
  check('1+third: the third example ran and was rejected', result.runs[2].result?.status === 'rejected', JSON.stringify(result.runs[2].result?.status));
  check('1+third: the merged correction is still discarded', result.examples[1].content === TWO_CMDS && result.examples[1].schemaLimit);
  const verdict = verdictOf(result);
  check('1+third: verdict correct', verdict.kind === 'correct', JSON.stringify(verdict));
}

// Moving the surplus <cmd> to another valid parent keeps the count → kept.
{
  const moved = '<step><cmd>Remove the bolts.</cmd><substeps><substep><cmd>Lift the pump cover.</cmd></substep></substeps></step>';
  const first = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', TWO_CMDS]);
  const fixed = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', moved]);
  const { result } = await runDita([first, fixed]);
  check('move: correction kept (as many <cmd>)', result.examples[1].content === moved && !result.examples[1].schemaLimit, result.examples[1].content);
  check('move: the moved example is valid and ran', result.runs[1].validation.runnable === true && result.runs[1].result != null, JSON.stringify(result.runs[1].validation.structure));
  check('move: verdict never carries a schema limit', !verdictOf(result).schemaLimit);
}

// tooMany + another problem; the correction fixes the other and keeps both <cmd> → kept (still invalid by tooMany, as today).
{
  const twoProblems = '<step><cmd>Remove the bolts.</cmd><cmd>Lift the <pokemon>cover</pokemon>.</cmd></step>';
  const first = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', twoProblems]);
  const fixed = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', TWO_CMDS]);
  const { result } = await runDita([first, fixed]);
  check('tooMany+other: correction kept', result.examples[1].content === TWO_CMDS && !result.examples[1].schemaLimit, result.examples[1].content);
  check('tooMany+other: still invalid by tooMany, as today', result.runs[1].validation.runnable === false && result.runs[1].validation.structure.some((p) => p.kind === 'tooMany'));
}

// A cut correction / invalid JSON → as today.
{
  const first = ditaAnswer(['Step with one command', 'accept', ONE_CMD], ['Step with two commands', 'reject', TWO_CMDS]);
  const { result } = await runDita([first, '{"examples": [ {"label": "x"']);
  check('invalid JSON: correction failed, example unchanged, no schema limit', result.correction.failed && result.examples[1].content === TWO_CMDS && !result.examples[1].schemaLimit, JSON.stringify(result.correction));
  check('invalid JSON: verdict has no schema limit (as today)', !verdictOf(result).schemaLimit);
}

// ─── Case 2: S1000D 3.0.1, BRDP-EXT-02786 ────────────────────────────────
const S301 = 'S1000D 3.0.1';
const F = 'BREX-3.0.1';
const structureOf = (schema) => STRUCTURES[`${S301}|${schema}`];
const vocab301 = vocabOf('schema-vocabulary-3-0-1.json');
const graph = schemaGraph(S301);
const EXT02786 =
  "<objrule id=\"XML-R-2786\"><objpath objappl=\"0\">//idstatus//applic[count(displaytext/p) &gt; 1][count(evaluate/evaluate[@operator='and']) != count(displaytext/p)]</objpath><objuse>Cada párrafo del texto de aplicabilidad debe tener su propia evaluación</objuse></objrule>";
const minimal = metadataXml(structureOf('descript').skeleton.metadata.tree).xml;
check('precondition: <applic> allows at most 1 <evaluate>', structureOf('descript').models.applic.max.evaluate === 1);
check('precondition: the minimal section has an <applic>', /<applic>[\s\S]*<\/applic>/.test(minimal));
const ASSERT = (v) => `<assert actidref="model" actreftype="prodattr" actvalues="${v}"/>`;
const AND = (v) => `<evaluate operator="and">${ASSERT(v)}<assert actidref="serialno" actreftype="prodattr" actvalues="1-99"/></evaluate>`;
const withApplic = (inner) => minimal.replace(/<applic>[\s\S]*?<\/applic>/, `<applic><displaytext><p>Model A, serial 1-99</p><p>Model B, serial 1-99</p></displaytext>${inner}</applic>`);
const LOOSE = withApplic(AND('A') + AND('B')); // two <evaluate> directly in <applic>
const MERGED_301 = withApplic(`<evaluate operator="and">${ASSERT('A')}${ASSERT('B')}</evaluate>`); // one <evaluate>, two <assert>
const NESTED_301 = withApplic(`<evaluate operator="or">${AND('A')}${AND('B')}</evaluate>`); // nested: more <evaluate>
const REJECT_301 = withApplic(`<evaluate operator="or">${AND('A')}</evaluate>`);
const fetchers301 = {
  fetchSchemaCards: async () => ({ available: true, cards: {}, document_schemas: ['descript'] }),
  fetchStructure: async (_std, schema) => (structureOf(schema) ? { available: true, ...structureOf(schema) } : { available: false }),
  fetchSchemaAttribute: async () => ({ available: true, owners: [] }),
};
const answer301 = (accept, reject) => ({
  examples: [
    { label: 'Two display paragraphs, two evaluations', expected: 'accept', schema: 'descript', metadata: accept, content: 'Remove the access panel.' },
    { label: 'Two display paragraphs, one evaluation', expected: 'reject', schema: 'descript', metadata: reject, content: 'Remove the access panel.' },
  ],
});
async function run301(answers) {
  let i = 0;
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: EXT02786,
    format: F,
    standard: S301,
    schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-02786', title: 't', definition: 'd', proposal: 'Cada párrafo del texto de aplicabilidad debe tener su propia evaluación.' },
    vocabulary: vocab301,
    parseXml,
    ask: async (messages) => {
      asked.push(messages);
      return JSON.stringify(answers[Math.min(i++, answers.length - 1)]);
    },
    ...fetchers301,
    fetchSchemaGraph: async () => graph,
  });
  return { result, asked, calls: i };
}

// 2 as-is: one <evaluate> with two <assert> → discarded.
{
  const { result, asked, calls } = await run301([answer301(LOOSE, REJECT_301), answer301(MERGED_301, REJECT_301)]);
  check('2: correction round naming the maximum', calls === 2 && /<applic> allows at most 1 <evaluate>; the example has 2/.test(lastUser(asked)), lastUser(asked));
  check('2: correction discarded -- the accept example keeps its loose <evaluate>', result.examples[0].metadata === LOOSE && result.examples[0].schemaLimit?.element === 'evaluate', JSON.stringify(result.examples[0].schemaLimit));
  check('2: accept example not run', result.runs[0].result === null);
  check('2: the reject example ran and was rejected', result.runs[1].result?.status === 'rejected', JSON.stringify(result.runs[1].result?.status));
  const verdict = verdictOf(result);
  check('2: never "incorrect (strict)"', !(verdict.kind === 'incorrect' && verdict.strict), JSON.stringify(verdict));
  check('2: inconclusive (the accept example did not run), without the reject sentence', verdict.kind === 'inconclusive' && !verdict.schemaLimit, JSON.stringify(verdict));
  check('2: 0 of 1 corrected', result.correction.fixed === 0);
}

// 2 with a nesting correction (more <evaluate>) → kept, runs, correct.
{
  const { result } = await run301([answer301(LOOSE, REJECT_301), answer301(NESTED_301, REJECT_301)]);
  check('2 nested: correction kept', result.examples[0].metadata === NESTED_301 && !result.examples[0].schemaLimit);
  check('2 nested: accept example ran and was accepted', result.runs[0].result?.status === 'accepted', JSON.stringify(result.runs[0].validation));
  check('2 nested: verdict correct', verdictOf(result).kind === 'correct', JSON.stringify(verdictOf(result)));
}

// ─── Helpers ──────────────────────────────────────────────────────────────
check('count: content and section, not comments', countWrittenElements({ content: '<step><cmd>a</cmd><!-- <cmd> --><cmd/></step>', metadata: '<x><cmd >b</cmd></x>' }, 'cmd') === 3);
check('count: a prefix of the name does not count', countWrittenElements({ content: '<cmdname>a</cmdname>' }, 'cmd') === 0);
check('lost: fewer → the limit', lostSchemaLimit({ content: TWO_CMDS }, { content: MERGED }, [{ element: 'cmd', parent: 'step', max: 1 }])?.element === 'cmd');
check('lost: same or more → null', lostSchemaLimit({ content: TWO_CMDS }, { content: TWO_CMDS.replace('</step>', '<cmd>c</cmd></step>') }, [{ element: 'cmd', parent: 'step', max: 1 }]) === null);
{
  // An example that lost other elements (no tooMany) → as today: kept.
  const examples = [{ label: 'a', expected: 'reject', content: '<p>x <emphasis>y</emphasis></p>' }];
  const runs = [{ validation: { structure: [{ kind: 'notAllowed', element: 'emphasis', parent: 'p' }] } }];
  const next = keepSchemaLimitedExamples(examples, runs, [{ index: 0 }], [{ label: 'a', expected: 'reject', content: '<p>x y</p>' }], true);
  check('no tooMany: the correction is kept even if it removes an element', next[0].content === '<p>x y</p>' && !next[0].schemaLimit);
  // Misaligned answer: found by label; a missing label counts as removing all.
  const ex2 = [{ label: 'one', expected: 'accept', content: ONE_CMD }, { label: 'two', expected: 'reject', content: TWO_CMDS }];
  const runs2 = [{ validation: { structure: [] } }, { validation: { structure: [{ kind: 'tooMany', element: 'cmd', parent: 'step', max: 1, count: 2 }] } }];
  const byLabel = keepSchemaLimitedExamples(ex2, runs2, [{ index: 1 }], [{ label: 'extra', expected: 'accept', content: ONE_CMD }, { label: 'two', expected: 'reject', content: MERGED }, { label: 'one', expected: 'accept', content: ONE_CMD }], false);
  check('misaligned: found by label and discarded', byLabel[1].content === TWO_CMDS && byLabel[1].schemaLimit?.element === 'cmd', JSON.stringify(byLabel));
  const dropped = keepSchemaLimitedExamples(ex2, runs2, [{ index: 1 }], [{ label: 'one', expected: 'accept', content: ONE_CMD }], false);
  check('misaligned: dropped by the correction → original put back', dropped.length === 2 && dropped[1].content === TWO_CMDS && dropped[1].schemaLimit);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
