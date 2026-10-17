// Test de reglas DITA: el título del topic montado cuando la regla lo exige.
// Navantia BRDP-EXT-00011 (context quoted literally from the real project,
// lets and assert reconstructed in scripts/rule-test-fixtures/
// navantia-dita3-reconstructed.sch): the title the rule asks for is the
// topic's own -- a DITA <section> takes no other <section> -- so the
// application writes it on the topic of every example. Real DITA topic
// structure (scripts/rule-test-fixtures/structures.json); no network.
//
//     node scripts/test-rule-test-topic-title.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { generateRuleTestExamples, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { topicTitleConditions, topicTitleFor, withTopicTitle } from '../src/utils/topicTitleValue.js';
import { assembleExample, SKELETON_TITLE_TEXT } from '../src/utils/ruleTestSkeleton.js';
import { ruleTestVerdict } from '../src/utils/ruleTest.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
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
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const vocabDita = vocabOf('schema-vocabulary-dita.json');
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const DITA = 'DITA 1.3 Xpath2.0';
const DITA3 = 'DITA 1.3 Xpath3.0';
const structureOf = (standard, schema) => STRUCTURES[`${standard}|${schema}`];
const topic = structureOf(DITA, 'topic');

const SCH = readTextFile(new URL('./rule-test-fixtures/navantia-dita3-reconstructed.sch', import.meta.url));
const navRule = (id) =>
  SCH.match(new RegExp(`<sch:pattern id="p-${id}"[\\s\\S]*?</sch:pattern>`))[0].replace('<sch:pattern', '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const EXT11 = navRule('BRDP-EXT-00011');
const TITLE = 'LISTA DE REFERENCIAS CONSOLIDADAS';
const ctxRule = (context) =>
  `<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p-T"><sch:rule context="${context.replace(/'/g, '&apos;')}"><sch:assert id="T" test="true()">x</sch:assert></sch:rule></sch:pattern>`;

const fetchSchemaCards = async (_std, names) => ({
  cards: {},
  document_schemas: ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'],
  element_schemas: Object.fromEntries(names.map((n) => [n, ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'].filter((t) => structureOf(DITA, t)?.elements[n])])),
});
const fetchStructure = async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) });

// ─── 1. Detection ───────────────────────────────────────────────────────────
{
  check('EXT-00011 context is the real one', EXT11.includes(`*[normalize-space(title) = &apos;${TITLE}&apos;] //section//*[self::p or self::entry[not(p)]]`) || EXT11.includes(`*[normalize-space(title) = '${TITLE}'] //section//*[self::p or self::entry[not(p)]]`), EXT11.slice(0, 300));
  const placement = { titled: ['topic'] };
  const of = (context) => topicTitleFor(topic, placement, topicTitleConditions(ctxRule(context)));
  check('EXT-00011: the topic\'s title is the rule\'s', JSON.stringify(topicTitleFor(topic, placement, topicTitleConditions(EXT11))) === JSON.stringify({ element: 'topic', value: TITLE }));
  check("*[title = ('A','B')]//section//p → 'A'", of("*[title = ('A','B')]//section//p")?.value === 'A');
  check("'A' = title (reversed) → 'A'", of("*['A' = title]//section//p")?.value === 'A');
  check('topic[title = ...]//p → the topic (only the topic can match)', of("topic[title = 'X']//p")?.value === 'X');
  check('section[normalize-space(title) = ...]//p: unchanged (a titled section in the content)', of("section[normalize-space(title)='X']//p") === null);
  check('*[title = ...]//p: unchanged (fits in a titled section)', of("*[title='X']//p") === null);
  check('*[title = (...)]//table: unchanged (EXT-00001 shape, a <section> holds the table)', of("*[title = ('A', 'B')]//table[tgroup]/tgroup/tbody/row") === null);
  check('*[not(title = ...)]//p: unchanged', of("*[not(title='X')]//section//p") === null);
  check('*[title = ... or @id]: unchanged (under an "or")', of("*[title = 'X' or @id]//section//p") === null);
  check('*[title = $t]: unchanged (not a literal)', of('*[title = $t]//section//p') === null);
  check('*[title = ...] on a placement the LLM writes whole: unchanged', topicTitleFor(topic, { titled: [] }, topicTitleConditions(EXT11)) === null);
  // S1000D: no skeleton title (titled is empty), nothing changes.
  const descript = structureOf('S1000D 4.2', 'descript');
  const s1000d = `<structureObjectRule><objectPath allowedObjectFlag="0">//levelledPara[title = 'X']//para</objectPath><objectUse>x</objectUse></structureObjectRule>`;
  check('S1000D rule with title: unchanged', withTopicTitle({ titled: descript.skeleton.titled || [] }, descript, topicTitleConditions(s1000d)).topicTitle === undefined);
}

// ─── 2. Assembly: the topic's title, escaped, dimmed as skeleton ────────────
{
  const placement = { path: ['topic', 'body'], insertion: 'body', root: 'topic', titled: ['topic'], topicTitle: { element: 'topic', value: 'A & <B>' } };
  const { xml, skeletonNodePaths } = assembleExample({ standard: DITA, schema: 'topic', placement, content: '<p>x</p>' });
  check('assembly: the rule\'s title, escaped', xml.includes('<title>A &amp; &lt;B&gt;</title>') && !xml.includes(SKELETON_TITLE_TEXT), xml);
  check('assembly: the title is part of the skeleton (dimmed)', skeletonNodePaths.includes('/topic[1]/title[1]'));
  const plain = assembleExample({ standard: DITA, schema: 'topic', placement: { ...placement, topicTitle: undefined }, content: '<p>x</p>' });
  check('assembly: without it, "Example topic" as before', plain.xml.includes(`<title>${SKELETON_TITLE_TEXT}</title>`));
}

// ─── 3. EXT-00011 end to end ────────────────────────────────────────────────
const sectionWith = (title, items) => `<section>${title ? `<title>${title}</title>` : ''}${items.map((i) => `<p>(${i}) Referencia ${i}.</p>`).join('')}</section>`;
const ANSWER_REAL_FAILURE = JSON.stringify({
  examples: [
    { label: 'orden correcto', expected: 'accept', schema: 'topic', content: sectionWith(TITLE, ['a', 'b', 'c']) },
    { label: 'salto (a)(c)', expected: 'reject', schema: 'topic', content: sectionWith(TITLE, ['a', 'c']) },
    { label: 'empieza en (b)', expected: 'reject', schema: 'topic', content: sectionWith(TITLE, ['b', 'c']) },
    { label: 'repetida (a)(a)', expected: 'reject', schema: 'topic', content: sectionWith(TITLE, ['a', 'a']) },
  ],
});
const ANSWER_GOOD = JSON.stringify({
  examples: [
    { label: 'orden correcto', expected: 'accept', schema: 'topic', content: sectionWith(null, ['a', 'b']) },
    { label: 'salto (a)(c)', expected: 'reject', schema: 'topic', content: sectionWith(null, ['a', 'c']) },
    { label: 'empieza en (b)', expected: 'reject', schema: 'topic', content: sectionWith(null, ['b', 'c']) },
    { label: 'repetida (a)(a)', expected: 'reject', schema: 'topic', content: sectionWith(null, ['a', 'a']) },
  ],
});
async function runExt11(answer) {
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: EXT11,
    format: 'SCH-DITA',
    standard: DITA3,
    schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00011', title: 'Orden de la lista de referencias consolidadas', definition: '', proposal: 'Los apartados de la lista de referencias consolidadas van (a), (b), (c)… sin saltos.' },
    vocabulary: vocabDita,
    parseXml,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      return answer;
    },
    fetchSchemaCards,
    fetchStructure,
  });
  return { result, asked };
}
{
  const setup = await prepareRuleTestSetup({ ruleXml: EXT11, standard: DITA3, schemaLocation: 'flat', fetchSchemaCards, fetchStructure, format: 'SCH-DITA', parseXml });
  const rule = setup.promptPlacements.find((p) => p.role === 'rule');
  check('EXT-00011: tested on a topic', rule?.root === 'topic', JSON.stringify(rule && { schema: rule.schema, path: rule.path }));
  check('EXT-00011: the placement carries the topic\'s title', rule?.topicTitle?.value === TITLE, JSON.stringify(rule?.topicTitle));

  for (const [name, answer] of [['the real failure (title also on the section)', ANSWER_REAL_FAILURE], ['a plain section', ANSWER_GOOD]]) {
    const { result, asked } = await runExt11(answer);
    const prompt = asked[0].systemPrompt;
    check(`EXT-00011 ${name}: prompt says the application writes the topic's title`, prompt.includes(`The application already writes the <title> of <topic> as "${TITLE}"`), prompt.split('your content goes')[1]?.slice(0, 400));
    check(`EXT-00011 ${name}: the title block says it is the topic itself`, prompt.includes('Here that element is the <topic> itself') && !prompt.includes('<section><title>Parts list</title>'));
    check(`EXT-00011 ${name}: no correction round`, result.status === 'ready' && (result.correction?.attempted || 0) === 0, JSON.stringify(result.correction));
    check(`EXT-00011 ${name}: every example has the topic's title`, result.examples.every((e) => e.xml.startsWith(`<topic>\n  <title>${TITLE}</title>`)), result.examples[0]?.xml.slice(0, 120));
    check(`EXT-00011 ${name}: every example says the app set it`, result.examples.every((e) => e.topicTitleSet === TITLE));
    const statuses = result.runs.map((r) => r.result.status).join(',');
    check(`EXT-00011 ${name}: (a)(c), (b)(c), (a)(a) rejected, the correct one accepted`, statuses === 'accepted,rejected,rejected,rejected', statuses);
    const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(EXT11, 'SCH-DITA', { parseXml }));
    check(`EXT-00011 ${name}: verdict Correct`, verdict.kind === 'correct', JSON.stringify(verdict));
  }
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  check('note EN', en('records.ruleTest.topicTitleSet', { title: TITLE }) === `Adjusted by the app: the topic's title is «${TITLE}», as the rule asks.`);
  check('note ES', es('records.ruleTest.topicTitleSet', { title: TITLE }) === `Ajustado por la app: el título del topic es «${TITLE}», como pide la regla.`);
}

// ─── 4. EXT-00001 of the DITA 3.0 template: unchanged ───────────────────────
{
  const ext1 = readPublicTemplate('brdp-template-dita-xpath3.xlsx').find((r) => r.ID === 'BRDP-EXT-00001');
  const setup = await prepareRuleTestSetup({ ruleXml: ext1.Rule, standard: DITA3, schemaLocation: 'flat', fetchSchemaCards, fetchStructure, format: 'SCH-DITA', parseXml });
  check('EXT-00001: no topic title (a titled <section> holds the table)', setup.promptPlacements.every((p) => !p.topicTitle));
}

// ─── 5. Part 2: "several <title>" warning only where it can repeat ──────────
{
  const ditaGraph = schemaGraph(DITA3);
  const s42Graph = schemaGraph('S1000D 4.2');
  const opts = { parseXml };
  const ditaWarn = textFunctionWarnings(EXT11, 'SCH-DITA', ditaGraph, opts);
  check('EXT-00011: no "several <title>" warning (only a topic can be the "*" step)', ditaWarn.length === 0, JSON.stringify(ditaWarn));
  check('EXT-00011: no "several <title>" request in the prompt', repeatingComparisons(EXT11, 'SCH-DITA', viewsFromGraph(ditaGraph), opts).length === 0);
  // Before: the "*" step counted every element with a <title>, <section>
  // among them (the merged DITA model lets a section repeat it).
  const sectionCtx = textFunctionWarnings(ctxRule("section[normalize-space(title) = 'X']//p"), 'SCH-DITA', ditaGraph, opts);
  check('DITA section[normalize-space(title)]: the warning stays where a section can repeat it', sectionCtx.some((w) => w.argument === 'title'), JSON.stringify(sectionCtx));
  const starLast = textFunctionWarnings(ctxRule("*[normalize-space(title) = 'X']"), 'SCH-DITA', ditaGraph, opts);
  check('DITA *[normalize-space(title)] with nothing below: every element counts, as before', starLast.some((w) => w.argument === 'title'), JSON.stringify(starLast));
  const s1000d = `<structureObjectRule><objectPath allowedObjectFlag="0">//levelledPara[normalize-space(para) = 'X']</objectPath><objectUse>x</objectUse></structureObjectRule>`;
  const sWarn = textFunctionWarnings(s1000d, 'BREX-4.2', s42Graph, opts);
  check('S1000D normalize-space(para) (para repeats): still warned', sWarn.some((w) => w.argument === 'para'), JSON.stringify(sWarn));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
