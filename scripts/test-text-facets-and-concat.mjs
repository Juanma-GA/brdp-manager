// Formato del texto de los elementos y valores compuestos con concat() --
// on the REAL S1000D 3.0.1 structures (scripts/rule-test-fixtures/
// structures.json, models[x].textFacets from the real XSD). The LLM is a fake
// with fixed answers: what is tested is the application's part -- the text
// format check (Part 1), the only split of a literal compared with a
// concat() of elements in the prompt, the correction round and describeRule
// (Part 2).
//   node scripts/test-text-facets-and-concat.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { generateRuleTestExamples, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { ruleTestVerdict } from '../src/utils/ruleTest.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { metadataXml } from '../src/utils/ruleTestSkeleton.js';
import { describeRule } from '../src/utils/ruleTestEngine.js';
import { ruleDescriptionText } from '../src/utils/ruleTestReasons.js';
import {
  checkExampleStructure,
  formatSchemaIssue,
  formatStructureProblem,
  meetsTextFacets,
  structureIssues,
  textFacetsText,
} from '../src/validation/schemaValidation.js';
import { concatComparisons, concatSplitSentence, literalSplits, uniqueConcatSplits, wholeConcatComparison } from '../src/utils/concatSplit.js';
import { schemaGraph } from './lib/schemaGraph.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${String(detail).slice(0, 1500)}` : ''}`);
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
const S301 = 'S1000D 3.0.1';
const S42 = 'S1000D 4.2';
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (std, schema) => STRUCTURES[`${std}|${schema}`];
const DESCRIPT = structureOf(S301, 'descript');
const PROCED = structureOf(S301, 'proced');
const vocab = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-3-0-1.json', import.meta.url)));
const VOCAB = { elements: new Set(vocab.elements), attributes: new Set(vocab.attributes) };
const CARDS = JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-3-0-1.json', import.meta.url)));
const graph = schemaGraph(S301);
const fetchers = {
  fetchSchemaCards: async (_s, names) => ({
    cards: Object.fromEntries(names.filter((n) => CARDS.cards[n]).map((n) => [n, { variants: CARDS.cards[n], parents: CARDS.parents[n] || [] }])),
    document_schemas: graph.schemas,
  }),
  fetchStructure: async (_s, schema) => (structureOf(S301, schema) ? { available: true, ...structureOf(S301, schema) } : { available: false }),
  fetchSchemaGraph: async () => graph,
};
const brdp = { identifier: 'BRDP-EXT-02219', title: 't', definition: 'd', proposal: 'p' };
const setupFor = (ruleXml) => prepareRuleTestSetup({ ruleXml, standard: S301, schemaLocation: 'flat', ...fetchers, format: 'BREX-3.0.1', parseXml });
async function generate(ruleXml, answers) {
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml, format: 'BREX-3.0.1', standard: S301, schemaLocation: 'flat', brdp, vocabulary: VOCAB, parseXml, ...fetchers,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      const answer = answers[asked.length - 1];
      if (answer === undefined) throw new Error('unexpected LLM call');
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
  const verdict = result?.status === 'ready' ? ruleTestVerdict(result.examples, result.runs, null, null, null, result.coverage) : null;
  return { result, asked, verdict };
}
const objrule = (path, extra = '', appl = ' objappl="0"') => `<objrule><objpath${appl}>${path}</objpath><objuse>x</objuse>${extra}</objrule>`;
// The two shapes of the SOPTE rules: the own module's <avee>, and a <refdm>'s.
const OWN = objrule(
  `/dmodule/idstatus[concat(dmaddres/dmc/avee/chapnum, dmaddres/dmc/avee/section, dmaddres/dmc/avee/subsect, dmaddres/dmc/avee/subject) = 'A91251']/dmaddres/dmc/avee/incode`,
  '<objval valtype="single" val1="040"/><objval valtype="single" val1="520"/>',
  ''
);
const REFDM = objrule(`//refdm[concat(avee/chapnum, avee/section, avee/subsect, avee/subject) = 'A91251']`);

// ─── 1. Facets from the real XSD ────────────────────────────────────────────
{
  check('1 chapnum facets', JSON.stringify(DESCRIPT.models.chapnum.textFacets) === '{"patterns":["[A-Za-z0-9]{2,3}"]}', JSON.stringify(DESCRIPT.models.chapnum));
  check('1 section facets', JSON.stringify(DESCRIPT.models.section.textFacets) === '{"patterns":["[A-Za-z0-9]{1}"]}');
  check('1 subsect facets', JSON.stringify(DESCRIPT.models.subsect.textFacets) === '{"patterns":["[A-Za-z0-9]{1}"]}');
  check('1 subject facets', JSON.stringify(DESCRIPT.models.subject.textFacets) === '{"patterns":["([A-Za-z0-9]{2}|[A-Za-z0-9]{4})"]}');
  check('1 no facets on <para> / <techname>', !DESCRIPT.models.para.textFacets && !DESCRIPT.models.techname.textFacets);
  const f = DESCRIPT.models.chapnum.textFacets;
  check('1 "B3" valid', meetsTextFacets('B3', f));
  check('1 "B31" valid', meetsTextFacets('B31', f));
  check('1 "B312" invalid', !meetsTextFacets('B312', f));
  check('1 "A" invalid', !meetsTextFacets('A', f));
  check('1 "B-" invalid', !meetsTextFacets('B-', f));
  check('1 subject "51" / "5122" valid, "512" invalid', meetsTextFacets('51', DESCRIPT.models.subject.textFacets) && meetsTextFacets('5122', DESCRIPT.models.subject.textFacets) && !meetsTextFacets('512', DESCRIPT.models.subject.textFacets));
  // Enumeration and length facets (no real 3.0.1/4.x element has them).
  const en1 = { enumeration: ['add', 'delete'], length: 3 };
  check('1 enumeration + length', meetsTextFacets('add', en1) && !meetsTextFacets('delete', en1) && !meetsTextFacets('mod', en1));
  check('1 min/max length', meetsTextFacets('ab', { minLength: 2, maxLength: 3 }) && !meetsTextFacets('a', { minLength: 2, maxLength: 3 }) && !meetsTextFacets('abcd', { minLength: 2, maxLength: 3 }));
  check('1 no facets: anything', meetsTextFacets('whatever', undefined) && meetsTextFacets('', {}));
  check('1 facets text', textFacetsText({ patterns: ['[0-9]{2}'], minLength: 1, maxLength: 4, enumeration: ['a', 'b'] }) === '[0-9]{2}; 1–4 characters; one of: a, b', textFacetsText({ patterns: ['[0-9]{2}'], minLength: 1, maxLength: 4, enumeration: ['a', 'b'] }));
  check('1 a pattern fontoxpath cannot compile is not judged', meetsTextFacets('x', { patterns: ['[unclosed'] }));
}

// ─── 2. The structural check ────────────────────────────────────────────────
const SECTION = metadataXml(DESCRIPT.skeleton.metadata.tree, 0).xml;
const withSns = (xml, [c, s, ss, sj], where = 'dmc') =>
  xml.replace(
    new RegExp(`(<${where}>\\s*<avee>[\\s\\S]*?)<chapnum>[^<]*</chapnum>\\s*<section>[^<]*</section>\\s*<subsect>[^<]*</subsect>\\s*<subject>[^<]*</subject>`),
    `$1<chapnum>${c}</chapnum><section>${s}</section><subsect>${ss}</subsect><subject>${sj}</subject>`
  );
{
  const doc = parseXml(`<dmodule>${withSns(SECTION, ['B312', '9', '1', '22'])}<content><descript><para0><para>x</para></para0></descript></content></dmodule>`);
  const problems = checkExampleStructure(doc, DESCRIPT).filter((p) => p.kind === 'textFormat');
  check('2 B312: one format problem', problems.length === 1 && problems[0].element === 'chapnum' && problems[0].text === 'B312', JSON.stringify(problems));
  check('2 B312: English message', formatStructureProblem(problems[0], 'descript') === 'the text "B312" of <chapnum> does not meet the format of the descript schema ([A-Za-z0-9]{2,3})', formatStructureProblem(problems[0], 'descript'));
  const [issue] = structureIssues(problems, { schema: 'descript' });
  check('2 B312: EN', formatSchemaIssue(issue, en) === 'the text "B312" of <chapnum> does not meet the format of the descript schema ([A-Za-z0-9]{2,3})', formatSchemaIssue(issue, en));
  check('2 B312: ES', formatSchemaIssue(issue, es) === 'el texto "B312" de <chapnum> no cumple el formato del esquema descript ([A-Za-z0-9]{2,3})', formatSchemaIssue(issue, es));
  const good = parseXml(`<dmodule>${withSns(SECTION, ['B3', '1', '2', '22'])}<content/></dmodule>`);
  check('2 B3: no format problem', checkExampleStructure(good, DESCRIPT).every((p) => p.kind !== 'textFormat'));
  // The application's own elements are never checked (the skeleton).
  const skip = new Set(['/dmodule[1]/idstatus[1]/dmaddres[1]/dmc[1]/avee[1]/chapnum[1]']);
  check('2 skeleton: never flagged', checkExampleStructure(doc, DESCRIPT, { skipPaths: skip }).every((p) => p.kind !== 'textFormat'));
  // An element with element children is not judged by its text.
  check('2 the minimal section meets every facet', checkExampleStructure(parseXml(`<dmodule>${SECTION}<content/></dmodule>`), DESCRIPT).every((p) => p.kind !== 'textFormat'));
}

// ─── 3. The split of a literal ──────────────────────────────────────────────
const sns = (args) => args.map((a) => ({ kind: 'element', element: a, path: a }));
const SNS = sns(['chapnum', 'section', 'subsect', 'subject']);
const pieces = (split) => split.map((p) => p).join('|');
{
  const a = literalSplits('A91251', SNS, DESCRIPT);
  check('3 A91251: one split, 2+1+1+2', a.length === 1 && pieces(a[0]) === 'A9|1|2|51', JSON.stringify(a));
  const b = literalSplits('B31222', SNS, DESCRIPT);
  check('3 B31222: one split', b.length === 1 && pieces(b[0]) === 'B3|1|2|22', JSON.stringify(b));
  // Seven and eight characters: the real formats still allow only one split
  // (3+1+1+2 and 2+1+1+4); five and ten, none.
  const seven = literalSplits('A912512', SNS, DESCRIPT);
  check('3 7 characters: one split 3+1+1+2 (real formats)', seven.length === 1 && pieces(seven[0]) === 'A91|2|5|12', JSON.stringify(seven));
  check('3 5 characters: none', literalSplits('A9125', SNS, DESCRIPT).length === 0);
  check('3 10 characters: none', literalSplits('A912512345', SNS, DESCRIPT).length === 0);
  // Two splits: <sdc> 1–4 and <discodev> 1–3 joined as "ABCD".
  check('3 sdc+discodev "ABCD": several splits', literalSplits('ABCD', sns(['sdc', 'discodev']), DESCRIPT).length === 2);
  // An element without facets: no unique split.
  check('3 element without facets: several splits', literalSplits('A9x', sns(['chapnum', 'techname']), DESCRIPT).length === 2);
  check('3 element with children: not judged', literalSplits('A9', sns(['para', 'chapnum']), DESCRIPT) === null);
  check('3 unknown element: not judged', literalSplits('A9', sns(['nosuch', 'chapnum']), DESCRIPT) === null);
  // A fixed literal argument.
  const fixed = literalSplits('A9-1', [{ kind: 'element', element: 'chapnum' }, { kind: 'fixed', value: '-' }, { kind: 'element', element: 'section' }], DESCRIPT);
  check('3 fixed piece', fixed.length === 1 && pieces(fixed[0]) === 'A9|-|1', JSON.stringify(fixed));
}
{
  const own = concatComparisons(OWN);
  check('3 own module: one comparison', own.length === 1 && own[0].literal === 'A91251' && own[0].args.map((x) => x.element).join() === 'chapnum,section,subsect,subject', JSON.stringify(own));
  check('3 literal on the left, !=, double quotes', concatComparisons(objrule(`//refdm["A91251" != concat(avee/chapnum, avee/section, avee/subsect, avee/subject)]`))[0]?.literal === 'A91251');
  check('3 apos escaped as &apos;', concatComparisons(objrule(`//refdm[concat(avee/chapnum, avee/section, avee/subsect, avee/subject) = &apos;A91251&apos;]`))[0]?.literal === 'A91251');
  check('3 not a literal: nothing', concatComparisons(objrule(`//refdm[concat(avee/chapnum, avee/section) = avee/incode]`)).length === 0);
  check('3 argument with a predicate: nothing', concatComparisons(objrule(`//refdm[concat(avee[1]/chapnum, avee/section) = 'A91']`)).length === 0);
  check('3 no concat: nothing', concatComparisons(objrule('//refdm')).length === 0);
  const splits = uniqueConcatSplits(REFDM, [DESCRIPT, PROCED]);
  check('3 unique over two schemas', splits.length === 1 && splits[0].pieces.map((p) => p.text).join('|') === 'A9|1|2|51', JSON.stringify(splits));
  check('3 sentence', concatSplitSentence(splits[0]) === "In this rule, 'A91251' is split as <chapnum>A9</chapnum>, <section>1</section>, <subsect>2</subsect>, <subject>51</subject>.", concatSplitSentence(splits[0]));
  check('3 two splits: no sentence', uniqueConcatSplits(objrule(`//dmc/avee[concat(sdc, discodev) = 'ABCD']`), [DESCRIPT]).length === 0);
  check('3 no split: no sentence', uniqueConcatSplits(objrule(`//refdm[concat(avee/chapnum, avee/section, avee/subsect, avee/subject) = 'A9125']`), [DESCRIPT]).length === 0);
  // 4.2: the codes are attributes, the elements have no facets.
  check('3 4.2 element without facets: no sentence', uniqueConcatSplits(objrule(`//dmRef[concat(dmRefIdent/dmCode, dmRefIdent) = 'AB']`), [structureOf(S42, 'descript')]).length === 0);
  const whole = wholeConcatComparison(`concat(avee/chapnum, avee/section, avee/subsect, avee/subject) = 'A91251'`);
  check('3 whole predicate', whole && whole.elements.join() === 'chapnum,section,subsect,subject' && whole.value === 'A91251' && !whole.negated, JSON.stringify(whole));
  check('3 whole predicate with and: not whole', wholeConcatComparison(`concat(avee/chapnum, avee/section) = 'A91' and avee/incode = '040'`) === null);
}

// ─── 4. The prompt ──────────────────────────────────────────────────────────
for (const [name, rule] of [['own module', OWN], ['refdm', REFDM]]) {
  const setup = await setupFor(rule);
  check(`4 ${name}: split in the setup`, setup.concatSplits.length === 1, JSON.stringify(setup.concatSplits));
  const prompt = buildRuleTestExamplesPrompt({ brdp, ruleXml: rule, format: 'BREX-3.0.1', standard: S301, contextSchemas: setup.contextSchemas, placements: setup.promptPlacements, schemaFacts: setup.schemaFacts, concatSplits: setup.concatSplits });
  check(`4 ${name}: the sentence`, prompt.includes("- In this rule, 'A91251' is split as <chapnum>A9</chapnum>, <section>1</section>, <subsect>2</subsect>, <subject>51</subject>."), prompt.slice(-2500));
  check(`4 ${name}: the block`, prompt.includes('COMPOSED VALUES: the rule joins the text of several elements with concat()'));
}
{
  // A rule without concat: no block (the snapshot keeps every other prompt).
  const plain = objrule('//refdm');
  const setup = await setupFor(plain);
  const prompt = buildRuleTestExamplesPrompt({ brdp, ruleXml: plain, format: 'BREX-3.0.1', standard: S301, contextSchemas: setup.contextSchemas, placements: setup.promptPlacements, schemaFacts: setup.schemaFacts, concatSplits: setup.concatSplits });
  check('4 no concat: no block', setup.concatSplits.length === 0 && !prompt.includes('COMPOSED VALUES'));
  const two = objrule(`//dmc/avee[concat(sdc, discodev) = 'ABCD']`);
  const twoSetup = await setupFor(two);
  check('4 two splits: no block', twoSetup.concatSplits.length === 0);
}

// ─── 5. End to end (fake LLM) ───────────────────────────────────────────────
{
  // Own module: the LLM splits the SNS wrong first (<chapnum>B312</chapnum>,
  // the real case), the correction round brings the format and the split.
  const wrong = withSns(SECTION, ['A912', '5', '1', '51']).replace(/(<dmc>\s*<avee>[\s\S]*?)<incode>040<\/incode>/, '$1<incode>941</incode>');
  const acceptMeta = withSns(SECTION, ['A9', '1', '2', '51']);
  const rejectMeta = acceptMeta.replace(/(<dmc>\s*<avee>[\s\S]*?)<incode>040<\/incode>/, '$1<incode>941</incode>');
  const first = { examples: [{ label: 'allowed info code', expected: 'accept', schema: 'descript', metadata: acceptMeta }, { label: 'info code 941', expected: 'reject', schema: 'descript', metadata: wrong }] };
  const second = { examples: [{ label: 'allowed info code', expected: 'accept', schema: 'descript', metadata: acceptMeta }, { label: 'info code 941', expected: 'reject', schema: 'descript', metadata: rejectMeta }] };
  const { result, asked, verdict } = await generate(OWN, [first, second]);
  check('5 own: two LLM calls', asked.length === 2, asked.length);
  check('5 own: prompt has the split', asked[0].systemPrompt.includes("'A91251' is split as <chapnum>A9</chapnum>"));
  const correction = asked[1]?.messages?.[2]?.content || '';
  check('5 own: correction names the format', correction.includes('the text "A912" of <chapnum> does not meet the format of the descript schema ([A-Za-z0-9]{2,3})'), correction);
  check('5 own: correction card has the format', correction.includes('card of <chapnum> in the descript schema') && correction.includes('its text must match: [A-Za-z0-9]{2,3}'), correction);
  check('5 own: correction repeats the split', correction.includes("In this rule, 'A91251' is split as <chapnum>A9</chapnum>"), correction);
  check('5 own: correct verdict', verdict?.kind === 'correct', JSON.stringify(verdict));
  check('5 own: reject rejected', result.runs[1].result?.status === 'rejected', JSON.stringify(result.runs[1].result));
}
{
  // <refdm>, the real misplit (<chapnum>A</chapnum>…<subject>251</subject>):
  // pieces in the wrong format -- the correction round names the format and
  // says the split.
  const ref = (c, s, ss, sj) => `<refdm><avee><modelic>EXAMPLE</modelic><sdc>A</sdc><chapnum>${c}</chapnum><section>${s}</section><subsect>${ss}</subsect><subject>${sj}</subject><discode>00</discode><discodev>A</discodev><incode>040</incode><incodev>A</incodev><itemloc>A</itemloc></avee></refdm>`;
  const accept = { label: 'other SNS', expected: 'accept', schema: 'descript', metadata: SECTION, content: ref('B3', '1', '2', '22') };
  const good = { label: 'SNS A91251', expected: 'reject', schema: 'descript', metadata: SECTION, content: ref('A9', '1', '2', '51') };
  {
    const first = { examples: [accept, { ...good, content: ref('A', '9', '1', '251') }] };
    const { asked, verdict, result } = await generate(REFDM, [first, { examples: [accept, good] }]);
    check('5 refdm misplit: two LLM calls', asked.length === 2, asked.length);
    const correction = asked[1]?.messages?.[2]?.content || '';
    check('5 refdm misplit: format of <chapnum> and <subject>', correction.includes('the text "A" of <chapnum>') && correction.includes('the text "251" of <subject>'), correction);
    check('5 refdm misplit: the split', correction.includes("In this rule, 'A91251' is split as <chapnum>A9</chapnum>, <section>1</section>, <subsect>2</subsect>, <subject>51</subject>."), correction);
    check('5 refdm misplit: correct verdict', verdict?.kind === 'correct', JSON.stringify(verdict));
    check('5 refdm misplit: reject rejected', result.runs[1].result?.status === 'rejected');
  }
  {
    // A reject example with no <refdm> in the content selects nothing (case
    // a: //para/refdm finds no node -- the brexref's <refdm> is not inside a
    // <para>): the correction round says the split too.
    const paraRule = objrule(`//para/refdm[concat(avee/chapnum, avee/section, avee/subsect, avee/subject) = 'A91251']`);
    const first = { examples: [accept, { ...good, content: 'See the procedure.' }] };
    const { asked, verdict } = await generate(paraRule, [first, { examples: [accept, good] }]);
    const correction = asked[1]?.messages?.[2]?.content || '';
    check('5 //para/refdm without <refdm>: the split in the correction', correction.includes('must contain a node matched by') && correction.includes("In this rule, 'A91251' is split as <chapnum>A9</chapnum>"), correction);
    check('5 //para/refdm without <refdm>: correct verdict', verdict?.kind === 'correct', JSON.stringify(verdict));
  }
  {
    // //refdm always finds the brexref's <refdm> of the minimal section: a
    // reject example without its own <refdm> is case b (Mejoras B) -- never
    // sent to the correction round.
    const first = { examples: [accept, { ...good, content: 'See the procedure.' }] };
    const { asked, verdict } = await generate(REFDM, [first]);
    check('5 //refdm without <refdm> in the content: no correction round (case b)', asked.length === 1 && verdict?.kind === 'incorrect', JSON.stringify({ n: asked.length, verdict }));
  }
  {
    // Valid formats but another value (B3 1 2 22): the rule's predicate
    // leaves it out (Mejoras B, case b) -- never pushed toward the rule's
    // literal; the verdict says the rule accepted it.
    const first = { examples: [accept, { ...good, content: ref('B3', '1', '2', '22') }] };
    const { asked, verdict } = await generate(REFDM, [first]);
    check('5 refdm other value: no correction round', asked.length === 1, asked.length);
    check('5 refdm other value: incorrect (permissive)', verdict?.kind === 'incorrect' && verdict.permissive, JSON.stringify(verdict));
  }
}

// ─── 6. describeRule ────────────────────────────────────────────────────────
{
  const d = (rule, t) => ruleDescriptionText(describeRule(rule, 'BREX-3.0.1', { graph, parseXml }), t);
  check('6 refdm EN', d(REFDM, en).includes("<refdm> whose composed value (concat of <chapnum>, <section>, <subsect>, <subject>) is 'A91251' must not appear"), d(REFDM, en));
  check('6 refdm ES', d(REFDM, es).includes("<refdm> cuyo valor compuesto (concat de <chapnum>, <section>, <subsect>, <subject>) es 'A91251' no puede aparecer"), d(REFDM, es));
  check('6 own EN', d(OWN, en).endsWith("Only when the composed value (concat of <chapnum>, <section>, <subsect>, <subject>) of <idstatus> is 'A91251'."), d(OWN, en));
  check('6 own ES', d(OWN, es).endsWith("Solo cuando el valor compuesto (concat de <chapnum>, <section>, <subsect>, <subject>) de <idstatus> es 'A91251'."), d(OWN, es));
  const not = objrule(`//refdm[concat(avee/chapnum, avee/section, avee/subsect, avee/subject) != 'A91251']`);
  check('6 != EN', d(not, en).includes("is not 'A91251'"), d(not, en));
  // Not the whole predicate: said literally, as before.
  const mixed = objrule(`//refdm[concat(avee/chapnum, avee/section, avee/subsect, avee/subject) = 'A91251' and avee/incode = '040']`);
  check('6 with and: literal condition', d(mixed, en).includes('matching the condition [concat(') && !d(mixed, en).includes('composed value'), d(mixed, en));
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
