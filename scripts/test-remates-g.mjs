// Remates de Mejoras G: "the schema already rules this out" only when the
// rule says so (1.1), mandatory value lists as two rules (1.2) and the full
// path in the "every document must contain" sentence (1.3). Real S1000D
// 3.0.1 rules verbatim (BRDP-EXT-02642, -02647, the template's EXT-00001)
// on the REAL 3.0.1 structures, vocabulary and element graph.
//   node scripts/test-remates-g.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { runExample, ruleTestVerdict } from '../src/utils/ruleTest.js';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { metadataXml } from '../src/utils/ruleTestSkeleton.js';
import { minimalDocument } from '../src/utils/ruleMinimalDocuments.js';
import { documentPresence, schemaCoverage } from '../src/validation/schemaCoverage.js';
import { runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { presencePathText } from '../src/utils/ruleTestReasons.js';
import { lintWarnings } from '../src/utils/ruleLint.js';
import { ruleFormatRules } from '../src/prompts/ruleFormatRules.js';
import { ruleElementIds } from '../src/utils/ruleSplit.js';
import { documentPresenceTest } from '../src/utils/ruleTestRun.js';
import { readPublicTemplate } from './lib/readXlsx.mjs';
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
const S301 = 'S1000D 3.0.1';
const F = 'BREX-3.0.1';
const structureOf = (schema) => STRUCTURES[`${S301}|${schema}`];
const vocabJson = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-3-0-1.json', import.meta.url)));
const vocabulary = { elements: new Set(vocabJson.elements), attributes: new Set(vocabJson.attributes) };
const graph = schemaGraph(S301);
const objrule = (path, flag = '0', id = 'R') => `<objrule id="${id}"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse></objrule>`;

const DOCS = Object.keys(STRUCTURES).filter((k) => k.startsWith(`${S301}|`)).map((k) => k.split('|')[1]).sort();
const fetchers = {
  fetchSchemaCards: async (_std, names) => ({
    available: true,
    cards: Object.fromEntries(
      names
        .map((n) => [n, DOCS.filter((d) => structureOf(d).elements[n])])
        .filter(([, schemas]) => schemas.length)
        .map(([n, schemas]) => [n, { variants: [{ schemas, attributes: [], children: [], resolved: true }], parents: [] }])
    ),
    document_schemas: DOCS,
  }),
  fetchStructure: async (_std, schema) => (structureOf(schema) ? { available: true, ...structureOf(schema) } : { available: false }),
  fetchSchemaAttribute: async () => ({ available: true, owners: [] }),
};
const minimal = metadataXml(structureOf('descript').skeleton.metadata.tree).xml;
const brdp = { identifier: 'BRDP-EXT-X', title: 't', definition: 'd', proposal: 'p' };

async function generate(ruleXml, answers, { withGraph = true } = {}) {
  const asked = [];
  let i = 0;
  const result = await generateRuleTestExamples({
    ruleXml,
    format: F,
    standard: S301,
    schemaLocation: 'flat',
    brdp,
    vocabulary,
    parseXml,
    ask: async (messages) => {
      asked.push(messages);
      return JSON.stringify(answers[Math.min(i++, answers.length - 1)]);
    },
    ...fetchers,
    fetchSchemaGraph: withGraph ? async () => graph : null,
  });
  return { result, asked, calls: i };
}
const lastMessage = (asked) => asked[asked.length - 1]?.[asked[asked.length - 1].length - 1]?.content || '';
const statusOf = (r) => r.result?.status || (r.schemaCovered ? 'covered' : 'invalid');

// ─── 1.1: "the schema already rules this out" only when the rule says it ─────
// BRDP-EXT-02642, verbatim, and the LLM's example of the real case.
const EXT02642 = `<objrule id="XML-R-2642"><objpath objappl="0">//*[@mark and /dmodule/idstatus/dmaddres/issno/@issno = '001']</objpath><objuse>Prohibir marcas de cambio en la emisión 001</objuse></objrule>`;
const NESTED_PARA = '<para0><para><para mark="1">Check the pump.</para></para></para0>';

check('1.1 precondition: issue 001 in the minimal section', /issno="001"/.test(minimal), minimal.slice(0, 400));
check('1.1 precondition: case 1 is not covered by the schema', schemaCoverage(EXT02642, F, graph, { parseXml }) === null);

// The real example verbatim, in the document the application builds for
// descript: never "ruled out by the schema", with or without the graph.
{
  const doc = minimalDocument(graph, S301, 'descript', 'flat').xml.replace(/<para0>[\s\S]*<\/para0>|<para0\s*\/>/, NESTED_PARA);
  check('case 1: verbatim example in the document', doc.includes(NESTED_PARA));
  const ex = { label: 'change mark in issue 001', expected: 'reject', xml: doc, schema: 'descript', structure: structureOf('descript') };
  for (const g of [graph, null]) {
    const run = runExample(EXT02642, F, ex, { vocabulary, parseXml, graph: g });
    check(`case 1 runExample (${g ? 'graph' : 'no graph'}): not valid, not covered`, run.validation.runnable === false && !run.schemaCovered, JSON.stringify(run.schemaCovered));
    check(`case 1 runExample (${g ? 'graph' : 'no graph'}): the reason is <para> inside <para>`, run.validation.structure.some((p) => p.kind === 'notAllowed' && p.element === 'para' && p.parent === 'para'), JSON.stringify(run.validation.structure));
  }
}

// Through the test (one correction round), for the three rules: the nested
// <para> goes to the correction round with its reason.
for (const [label, rule, accept, nested, fixed] of [
  ['case 1 (BRDP-EXT-02642)', EXT02642, 'Check the pump.', '<para mark="1">Check the pump.</para>', null],
  ['//para[@mark]', objrule('//para[@mark]'), '<para>Check the pump.</para>', '<para><para mark="1">Check the pump.</para></para>', '<para mark="1">Check the pump.</para>'],
  ['//*[@mark]', objrule('//*[@mark]'), 'Check the pump.', '<para mark="1">Check the pump.</para>', null],
]) {
  check(`${label}: rule not covered`, schemaCoverage(rule, F, graph, { parseXml }) === null);
  const ok = { label: 'no change marks', expected: 'accept', schema: 'descript', metadata: minimal, content: accept };
  const bad = { label: 'change mark in issue 001', expected: 'reject', schema: 'descript', metadata: minimal, content: nested };
  const answers = [{ examples: [ok, bad] }];
  if (fixed) answers.push({ examples: [ok, { ...bad, content: fixed }] });
  const { result, asked, calls } = await generate(rule, answers);
  check(`${label}: ready`, result.status === 'ready', result.error);
  check(`${label}: accept example ran`, statusOf(result.runs[0]) === 'accepted', statusOf(result.runs[0]));
  check(`${label}: the nested <para> goes to the correction round (two LLM calls)`, calls === 2, String(calls));
  check(`${label}: correction says <para> is not allowed inside <para>`, /<para> is not allowed inside <para>/.test(lastMessage(asked)), lastMessage(asked).slice(0, 600));
  check(`${label}: no example marked "ruled out by the schema"`, result.runs.every((r) => !r.schemaCovered), JSON.stringify(result.runs.map((r) => r.schemaCovered)));
  if (fixed) {
    check(`${label}: corrected example rejected, verdict correct`, statusOf(result.runs[1]) === 'rejected' && ruleTestVerdict(result.examples, result.runs).kind === 'correct', JSON.stringify(result.runs.map(statusOf)));
  } else {
    check(`${label}: still nested after correction → not valid with its reason`, statusOf(result.runs[1]) === 'invalid' && result.runs[1].validation.structure.some((p) => p.element === 'para' && p.parent === 'para'), statusOf(result.runs[1]));
    check(`${label}: verdict no_runnable, never schema_covered`, ruleTestVerdict(result.examples, result.runs).kind !== 'schema_covered', JSON.stringify(ruleTestVerdict(result.examples, result.runs)));
  }
}

// Two alternatives, one covered by the schema (children listed of <safety>
// in proced): an example whose <safety> has a child the schema does not allow
// is ruled out by the schema; one with <para> in <para> is not.
{
  const RULE = objrule('//safety/*[not(self::safecond or self::nosafety)] | //para[@mark]');
  check('two alternatives: the rule as a whole is not covered', schemaCoverage(RULE, F, graph, { parseXml }) === null);
  check('two alternatives: <safety> exists in proced', Boolean(structureOf('proced').elements.safety));
  const ok = { label: 'ok', expected: 'accept', schema: 'proced', metadata: minimal, content: '<mainfunc><step1><para>Check the pump.</para></step1></mainfunc>' };
  const safetyBad = { label: 'safety with a para', expected: 'reject', schema: 'proced', metadata: minimal, content: '<prelreqs><safety><para>Wrong.</para></safety></prelreqs><mainfunc><step1><para>Check.</para></step1></mainfunc>' };
  const r1 = await generate(RULE, [{ examples: [ok, safetyBad] }]);
  check('two alternatives: accept example ran', statusOf(r1.result.runs[0]) === 'accepted', JSON.stringify(r1.result.runs[0].validation?.structure));
  check('two alternatives: <safety> example ruled out by the schema (one LLM call)', r1.calls === 1 && r1.result.runs[1]?.schemaCovered?.items?.[0]?.parent === 'safety', JSON.stringify({ calls: r1.calls, sc: r1.result.runs[1]?.schemaCovered }));
  const verdict = ruleTestVerdict(r1.result.examples, r1.result.runs);
  check('two alternatives: verdict "already ruled out" text EN', verdict.kind === 'schema_covered' && verdict.via === 'examples', JSON.stringify(verdict));
  check('two alternatives: example line ES', /El esquema ya lo excluye/.test(es('records.ruleTest.schemaCoveredExample', { detail: 'x' })));
  const paraBad = { label: 'nested para', expected: 'reject', schema: 'proced', metadata: minimal, content: '<mainfunc><step1><para><para mark="1">Check.</para></para></step1></mainfunc>' };
  const r2 = await generate(RULE, [{ examples: [ok, paraBad] }]);
  check('two alternatives: <para> in <para> goes to the correction round', r2.calls === 2 && !r2.result.runs[1]?.schemaCovered, JSON.stringify({ calls: r2.calls, sc: r2.result.runs[1]?.schemaCovered }));
  const both = { label: 'safety and nested para', expected: 'reject', schema: 'proced', metadata: minimal, content: '<prelreqs><safety><para>Wrong.</para></safety></prelreqs><mainfunc><step1><para><para mark="1">Also.</para></para></step1></mainfunc>' };
  const r3 = await generate(RULE, [{ examples: [ok, both] }]);
  check('two alternatives: another misplaced element → correction round', r3.calls === 2 && !r3.result.runs[1]?.schemaCovered, JSON.stringify({ calls: r3.calls, sc: r3.result.runs[1]?.schemaCovered }));
  const r4 = await generate(RULE, [{ examples: [ok, safetyBad] }], { withGraph: false });
  check('two alternatives without graph: never ruled out by the schema', r4.calls === 2 && !r4.result.runs[1]?.schemaCovered, JSON.stringify({ calls: r4.calls }));
  check('EN line unchanged', /The schema already rules this out/.test(en('records.ruleTest.schemaCoveredExample', { detail: 'x' })));
}

// ─── 1.2 a: rule 9 of the BREX prompt, in the three formats ────────────────
for (const f of ['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']) {
  const rules = ruleFormatRules(f, '');
  const line9 = rules.split('\n').find((l) => l.startsWith('9. ')) || '';
  check(`${f} rule 9: one value → one rule on X[not(@a='v')]`, line9.includes("X[not(@a='v')]") && line9.includes('one rule'), line9);
  check(`${f} rule 9: several values → {ID}-1 list and {ID}-2 X[not(@a)]`, line9.includes('{ID}-1 with the list') && line9.includes('{ID}-2') && line9.includes('X[not(@a)]'), line9);
  check(`${f} rule 9: only the list when SCHEMA FACTS say @a is required`, line9.includes('when SCHEMA FACTS say @a is required in <X>, write only {ID}-1'), line9);
  check(`${f} rule 9: never the list as a condition, never flag 1 with values`, line9.includes("Never the list as a condition (X[not(@a='v1' or @a='v2')])") && /never (allowedObjectFlag|objappl)="1" with values/.test(line9), line9);
  check(`${f} rule 9: invented example with both rules`, rules.includes('//acmeElement/@acmeAttr') && rules.includes('//acmeElement[not(@acmeAttr)]') && !/origname|rowsep/.test(rules));
}
check('3.0.1 rule 9 list rule without objappl', ruleFormatRules('BREX-3.0.1', '').includes('{ID}-1: <objpath>//acmeElement/@acmeAttr</objpath>'));
check('4.2 rule 9 list rule with allowedObjectFlag="2"', ruleFormatRules('BREX-4.2', '').includes('{ID}-1: <objectPath allowedObjectFlag="2">//acmeElement/@acmeAttr</objectPath>'));

// ─── 1.2 b: "mandatory with values" proposes the same ────────────────────
{
  const objvals = (vs) => vs.map((v) => `<objval valtype="single" val1="${v}"/>`).join('');
  const flag1 = (path, vs) => `<objrule id="R"><objpath objappl="1">${path}</objpath><objuse>x</objuse>${objvals(vs)}</objrule>`;
  const detail = (rule, t, format = F, opts = { schemaGraph: graph }) => lintWarnings(rule, format, 'panel', t, { parseXml, ...opts }).find((w) => w.code === 'flag1_with_values')?.detail || '';
  const one = detail(flag1('//tbody/row/@rowsep', ['0']), es);
  check('1.2b one value: forbid the opposite (unchanged)', one.endsWith("Para exigirlo en cada <row>, prohíbe lo contrario: row[not(@rowsep='0')]."), one);
  const several = detail(flag1('//orig/@origname', ['a', 'b', 'c']), es);
  check('1.2b several values ES: two rules', several.endsWith('Para exigirlo en cada <orig> con uno de esos valores, escribe dos reglas: una con la lista de valores en orig/@origname (sin objappl) y otra con objappl="0" en orig[not(@origname)].'), several);
  check('1.2b several values: never the list as a condition', !several.includes(" or @origname="), several);
  const severalEn = detail(flag1('//orig/@origname', ['a', 'b']), en);
  check('1.2b several values EN', severalEn.endsWith('To require it on every <orig> with one of these values, write two rules: one with the list of values on orig/@origname (without objappl) and another one with objappl="0" on orig[not(@origname)].'), severalEn);
  const required = detail(flag1('//status/qa/firstver/@type', ['a', 'b']), es);
  check('1.2b @type required in <firstver> (graph): only the list', required.endsWith('El esquema ya hace obligatorio @type en <firstver>: basta con la lista de valores en firstver/@type (sin objappl).'), required);
  const noGraph = detail(flag1('//status/qa/firstver/@type', ['a', 'b']), es, F, {});
  check('1.2b without graph: two rules (never claims "required")', noGraph.includes('escribe dos reglas'), noGraph);
  const r42 = '<structureObjectRule id="R"><objectPath allowedObjectFlag="1">//orig/@origname</objectPath><objectUse>x</objectUse><objectValue valueForm="single" valueAllowed="a">a</objectValue><objectValue valueForm="single" valueAllowed="b">b</objectValue></structureObjectRule>';
  check('1.2b 4.2: the list with allowedObjectFlag="2"', detail(r42, en, 'BREX-4.2', {}).includes('orig/@origname (with allowedObjectFlag="2")'));
}

// ─── 1.2 c: the 3.0.1 template, BRDP-EXT-00001 as two rules ────────────────
{
  const rows = readPublicTemplate('brdp-template-3-0-1.xlsx');
  const row = rows.find((r) => r.ID === 'BRDP-EXT-00001');
  check('template EXT-00001: two rules with distinct ids', JSON.stringify(ruleElementIds(row.Rule, F)) === '["XML-R-0001-1","XML-R-0001-2"]', JSON.stringify(ruleElementIds(row.Rule, F)));
  check('template EXT-00001: list rule without objappl, six objval', /<objpath>\/\/orig\/@origname<\/objpath>/.test(row.Rule) && (row.Rule.match(/<objval /g) || []).length === 6);
  check('template EXT-00001: required rule', row.Rule.includes('<objpath objappl="0">//orig[not(@origname)]</objpath>'));
  check('template EXT-00001: Proposal names the attribute and the six values', row.Proposal.startsWith('Todo <orig> debe llevar el atributo @origname, con uno de estos 6 valores:') && (row.Proposal.match(/"/g) || []).length === 12);
  check('template EXT-00001: no lint finding', lintWarnings(row.Rule, F, 'panel', en, { parseXml, schemaGraph: graph }).length === 0, JSON.stringify(lintWarnings(row.Rule, F, 'panel', en, { parseXml })));
  const doc = (orig) => `<dmodule><idstatus><status>${orig}</status></idstatus></dmodule>`;
  const status = (orig) => runRuleOnFragment(row.Rule, F, doc(orig), null, { parseXml }).status;
  check('EXT-00001: a value of the list accepted', status('<orig origname="TESS-DEFENCE SA">1</orig>') === 'accepted');
  check('EXT-00001: another value rejected', status('<orig origname="ACME SL">1</orig>') === 'rejected');
  check('EXT-00001: <orig> without @origname rejected', status('<orig>1</orig>') === 'rejected');
  const s1 = rows.find((r) => r.ID === 'BRDP-S1-00024');
  check('template S1-00024 unchanged', s1.Rule.includes("//status/qa/firstver[not(@type='tabtop')]") && ruleElementIds(s1.Rule, F).length === 1);
}

// ─── 1.3: the whole path in "every document must contain" ──────────────────
{
  const EXT02647 = objrule('/*[not(//status/qa)]', '0', 'XML-R-2647');
  const p = documentPresence(EXT02647, F, graph, { parseXml });
  check('EXT-02647: <qa> cannot exist in comment, ddn, dml, pm', JSON.stringify(p?.cannot) === '["comment","ddn","dml","pm"]', JSON.stringify(p?.cannot));
  const esText = es('records.ruleTest.describe.presenceNever', { schemas: 'comment, ddn, dml y pm', target: presencePathText(p.names, es) });
  check('1.3 ES: <qa> dentro de <status>', esText === 'En comment, ddn, dml y pm, <qa> dentro de <status> no puede existir: la regla rechaza siempre esos documentos.', esText);
  const enText = en('records.ruleTest.describe.presenceNever', { schemas: 'comment, ddn, dml and pm', target: presencePathText(p.names, en) });
  check('1.3 EN: <qa> inside <status>', enText === 'In comment, ddn, dml and pm, <qa> inside <status> cannot exist: the rule always rejects those documents.', enText);
  const single = documentPresence(objrule('/*[not(//dmaddres)]'), F, graph, { parseXml });
  check('1.3 one step as today', presencePathText(single.names, es) === '<dmaddres>');
  check('1.3 three steps', presencePathText(['idstatus', 'status', 'qa'], es) === '<qa> dentro de <status> dentro de <idstatus>');
  // The note of the examples the application builds names the whole path too.
  const test = documentPresenceTest({ ruleXml: EXT02647, format: F, standard: S301, schemaLocation: 'flat', graph, vocabulary, parseXml });
  const built = (test?.examples || []).filter((e) => e.minimalDocument);
  check('1.3 app-built examples carry the path', built.length > 0 && built.every((e) => JSON.stringify(e.presenceNames) === '["status","qa"]'), JSON.stringify(built.map((e) => e.presenceNames)));
  const note = es('records.ruleTest.minimalDocumentPresence', { schema: 'pm', root: 'pm', target: presencePathText(built[0].presenceNames, es) });
  check('1.3 note ES', note.endsWith('el esquema decide si <qa> dentro de <status> está.'), note);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
