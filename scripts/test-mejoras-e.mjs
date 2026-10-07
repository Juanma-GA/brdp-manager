// Mejoras E: "Already covered by the schema", conditions that cannot be met
// and rules that error on an example. The four real rules (S1000D 3.0.1,
// BRDP-EXT-02805, -02802, -02792 and the corrected rule suggested for it)
// verbatim, on the REAL 3.0.1 structures, vocabulary and element graph.
//   node scripts/test-mejoras-e.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { runExample, ruleTestVerdict } from '../src/utils/ruleTest.js';
import { analyzeRule, runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { engineErrorText, formatRuleTestReason, verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
import { generateRuleTestExamples, labelNote } from '../src/utils/ruleTestRun.js';
import { metadataXml } from '../src/utils/ruleTestSkeleton.js';
import { formatCoverageItem, schemaCoverage } from '../src/validation/schemaCoverage.js';
import { checkRulePaths, formatPathProblem } from '../src/validation/rulePathCheck.js';
import { formatRuleDefect, formatRuleFix, proposeRuleCorrection } from '../src/validation/ruleCorrection.js';
import { extractContextCandidates, resolvePhraseCandidates } from '../src/validation/schemaValidation.js';
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
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const vocabulary = vocabOf('schema-vocabulary-3-0-1.json');
const graph = schemaGraph(S301);
const objrule = (path, flag = '0') => `<objrule id="R"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse></objrule>`;

const CASE1 = '<objrule id="XML-R-2817"><objpath objappl="0">//inlineapplics[not(ancestor::idstatus)]</objpath><objuse>Prohibir inlineapplics fuera de idstatus</objuse></objrule>';
const CASE2 = '<objrule id="XML-R-2814"><objpath objappl="0">//avee/*[not(self::modelic or self::sdc or self::chapnum or self::section or self::subsect or self::subject or self::discode or self::discodev or self::incode or self::incodev or self::itemloc)]</objpath><objuse>Prohibir avee con hijos no permitidos</objuse></objrule>';
const CASE3_PATH = "//idstatus//applic[not(displaytext/p[normalize-space(.)='VCR 8X8 DRAGON'])]/evaluate/evaluate[@operator='and'][not( ancestor::applic/displaytext/p[normalize-space(.) = concat( (assert[@actidref='version']/@actvalues), ' ', (assert[@actidref='variante']/@actvalues) )])]";
const CASE4_BAD_PATH = "//idstatus//applic[not(displaytext/p[normalize-space(.)='VCR 8X8 DRAGON'])]/evaluate/evaluate[@operator='and' and not(assert[@actidref='version'] and assert[@actidref='variante'] and normalize-space(concat(assert[@actidref='version']/@actvalues, ' ', assert[@actidref='variante']/@actvalues)) = normalize-space(ancestor::applic/displaytext/p))]";
const CASE4_GOOD_PATH = "//idstatus//applic[not(displaytext/p[normalize-space(.)='VCR 8X8 DRAGON'])]/evaluate/evaluate[@operator='and'][not(some $p in ancestor::applic/displaytext/p satisfies normalize-space($p) = concat(assert[@actidref='version']/@actvalues, ' ', assert[@actidref='variante']/@actvalues))]";
const AVEE = '<avee><modelic>AA</modelic><sdc>A</sdc><chapnum>00</chapnum><section>0</section><subsect>0</subsect><subject>00</subject><discode>00</discode><discodev>A</discodev><incode>040</incode><incodev>A</incodev><itemloc>D</itemloc></avee>';

// The real 3.0.1 structures, as GET /api/schema-cards and /structure give them.
const DOCS = Object.keys(STRUCTURES).filter((k) => k.startsWith(`${S301}|`)).map((k) => k.split('|')[1]).sort();
const fetchers = {
  fetchSchemaCards: async (_std, names) => ({
    cards: Object.fromEntries(
      names
        .map((n) => [n, DOCS.filter((d) => structureOf(d).elements[n])])
        .filter(([, schemas]) => schemas.length)
        .map(([n, schemas]) => [n, { variants: [{ schemas, attributes: [], children: [], resolved: true }], parents: [] }])
    ),
    document_schemas: DOCS,
  }),
  fetchStructure: async (_std, schema) => (structureOf(schema) ? { available: true, ...structureOf(schema) } : { available: false }),
};
const minimal = metadataXml(structureOf('descript').skeleton.metadata.tree).xml;
const brdp = { identifier: 'BRDP-EXT-X', title: 't', definition: 'd', proposal: 'p' };

async function generate(ruleXml, answers, { withGraph = true } = {}) {
  const prompts = [];
  let i = 0;
  const result = await generateRuleTestExamples({
    ruleXml,
    format: F,
    standard: S301,
    schemaLocation: 'flat',
    brdp,
    vocabulary,
    parseXml,
    ask: async (_m, systemPrompt) => {
      prompts.push(systemPrompt);
      return JSON.stringify(answers[Math.min(i++, answers.length - 1)]);
    },
    ...fetchers,
    fetchSchemaGraph: withGraph ? async () => graph : null,
  });
  return { result, prompts, calls: i };
}

// ─── Part 1.2: covered by the schema, found before any LLM call ───────────
{
  const c1 = schemaCoverage(CASE1, F, graph, { parseXml });
  check('case 1: onlyInside <inlineapplics> / <idstatus>', c1?.items?.[0]?.kind === 'onlyInside' && c1.items[0].element === 'inlineapplics' && c1.items[0].other === 'idstatus', JSON.stringify(c1));
  check('case 1: text ES', formatCoverageItem(c1.items[0], es) === '<inlineapplics> solo puede ir dentro de <idstatus>');
  const c2 = schemaCoverage(CASE2, F, graph, { parseXml });
  check('case 2: childrenListed <avee> with its 11 children', c2?.items?.[0]?.kind === 'childrenListed' && c2.items[0].children.length === 11, JSON.stringify(c2));
  check(
    'BRDP-EXT-02650 shape (more "and" conditions): covered',
    schemaCoverage(objrule('//safety/*[not(self::safecond or self::nosafety) and not(@id)]'), F, graph, { parseXml })?.items?.[0]?.kind === 'childrenListed'
  );
  check('<supequi> list missing children: normal test', schemaCoverage(objrule('//supequi/*[not(self::nomen or self::nsn or self::identno or self::qty)]'), F, graph, { parseXml }) === null);
  check('<applic> outside <idstatus> can exist: normal test', schemaCoverage(objrule('//applic[not(ancestor::idstatus)]'), F, graph, { parseXml }) === null);
  check('flag 1: never covered', schemaCoverage(objrule('//inlineapplics[not(ancestor::idstatus)]', '1'), F, graph, { parseXml }) === null);
  check('no graph: nothing concluded', schemaCoverage(CASE1, F, null, { parseXml }) === null);
  check('Schematron DITA: not applied', schemaCoverage('<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"><sch:rule context="note"><sch:assert test="@type">x</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA', graph, { parseXml }) === null);
  check('parent:: covered', schemaCoverage(objrule('//inlineapplics[not(parent::status)]'), F, graph, { parseXml })?.items?.[0]?.kind === 'onlyDirectlyInside');
}

// ─── Part 1.4: an accept example runs; the verdict is schema_covered ───────
{
  const inline = minimal.replace('</applic>', '</applic><inlineapplics><applic id="a1"><displaytext><p>All</p></displaytext></applic></inlineapplics>');
  const { result, prompts, calls } = await generate(CASE1, [
    { examples: [{ label: 'inlineapplics in status', expected: 'accept', schema: 'descript', metadata: inline, content: '<para>Text.</para>' }] },
  ]);
  check('case 1: prompt asks for NO reject example', /NO example meant to be rejected/.test(prompts[0] || ''), (prompts[0] || '').slice(0, 200));
  check('case 1: one LLM call (accept only)', calls === 1, String(calls));
  check('case 1: ready with coverage', result.status === 'ready' && result.coverage?.items?.length === 1, result.error);
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(CASE1, F, { parseXml }), null, null, result.coverage);
  check('case 1: accept example ran and was accepted', result.runs[0]?.result?.status === 'accepted');
  check('case 1: verdict schema_covered via path', verdict.kind === 'schema_covered' && verdict.via === 'path', JSON.stringify(verdict));
  const record = verdictToTestRecord(verdict);
  check('case 1: recorded as schema_covered', record.result === 'schema_covered' && record.reason.code === 'test_schema_covered', JSON.stringify(record));
  check('case 1: reason ES', /el esquema ya lo incluye: <inlineapplics> solo puede ir dentro de <idstatus>/.test(formatRuleTestReason(record.reason, es)), formatRuleTestReason(record.reason, es));
  check('case 1: reason EN', /already covered by the schema: <inlineapplics> can only go inside <idstatus>/i.test(formatRuleTestReason(record.reason, en)), formatRuleTestReason(record.reason, en));
  // The accept example is rejected → a failed test.
  const rejectedRun = { ...result.runs[0], result: { ...result.runs[0].result, status: 'rejected' }, matches: false };
  const failedVerdict = ruleTestVerdict(result.examples, [rejectedRun], null, null, null, result.coverage);
  check('case 1: accept example rejected → failed (strict)', failedVerdict.kind === 'incorrect' && failedVerdict.strict, JSON.stringify(failedVerdict));
}
{
  const { result } = await generate(CASE2, [
    { examples: [{ label: 'valid avee', expected: 'accept', schema: 'descript', metadata: minimal, content: `See <refdm>${AVEE}</refdm>.` }] },
  ]);
  check('case 2: ready with coverage, no correction', result.status === 'ready' && result.coverage?.items?.[0]?.kind === 'childrenListed', result.error || JSON.stringify(result.runs?.[0]?.validation?.structure));
  const verdict = ruleTestVerdict(result.examples, result.runs, null, null, null, result.coverage);
  check('case 2: verdict schema_covered', verdict.kind === 'schema_covered', JSON.stringify(verdict));
}

// ─── Part 1.3 (Remates de Mejoras G 1.1): a reject example with <emphasis>
// in <avee>. Without the graph it is never "ruled out by the schema" (normal
// correction round); with the graph, only an alternative of the rule that the
// schema covers by that relation counts.
{
  const emphasisAvee = AVEE.replace('</avee>', '<emphasis>x</emphasis></avee>');
  const answer = {
    examples: [
      { label: 'valid avee', expected: 'accept', schema: 'descript', metadata: minimal, content: `See <refdm>${AVEE}</refdm>.` },
      { label: 'disallowed child element (emphasis)', expected: 'reject', schema: 'descript', metadata: minimal, content: `See <refdm>${emphasisAvee}</refdm>.` },
    ],
  };
  const { result, calls } = await generate(CASE2, [answer, answer], { withGraph: false });
  check('1.3: no coverage without graph', !result.coverage);
  check('1.3: without graph the <emphasis> example goes to the correction round', calls === 2, String(calls));
  check('1.3: without graph never schemaCovered', !result.runs[1]?.schemaCovered, JSON.stringify(result.runs[1]?.schemaCovered));

  // Two alternatives, only one covered (children listed of <avee>): with
  // the graph, the <emphasis> example is ruled out by the schema.
  const casePath = CASE2.match(/<objpath[^>]*>([\s\S]*)<\/objpath>/)[1];
  const unionRule = objrule(`${casePath} | //para[@id = 'bad']`);
  const onlyCovered = {
    examples: [
      { ...answer.examples[0], content: `<para>${answer.examples[0].content}</para>` },
      { ...answer.examples[1], content: `<para>${answer.examples[1].content}</para>` },
    ],
  };
  const c = await generate(unionRule, [onlyCovered, onlyCovered]);
  check('1.3: union rule is not covered as a whole', !c.result.coverage);
  check('1.3: the <emphasis> example is not corrected (one LLM call)', c.calls === 1, String(c.calls));
  const run = c.result.runs[1];
  check('1.3: reject example marked schemaCovered', run?.schemaCovered?.items?.[0]?.element === 'emphasis' && run.schemaCovered.items[0].parent === 'avee', JSON.stringify(run?.schemaCovered));
  const verdict = ruleTestVerdict(c.result.examples, c.result.runs, null, null, null, null);
  check('1.3: verdict schema_covered via examples', verdict.kind === 'schema_covered' && verdict.via === 'examples', JSON.stringify(verdict));
  check('1.3: item text ES', formatCoverageItem(verdict.items[0], es) === 'el esquema no admite <emphasis> dentro de <avee>');

  // Only one of two reject examples covered: the other gives the verdict.
  const mixed = {
    // With the //para alternative the insertion point is <para0>.
    examples: [
      { ...answer.examples[0], content: `<para>${answer.examples[0].content}</para>` },
      { label: 'para with a bad id', expected: 'reject', schema: 'descript', metadata: minimal, content: `<para id="bad">Text.</para>` },
      { ...answer.examples[1], content: `<para>${answer.examples[1].content}</para>` },
    ],
  };
  const m = await generate(unionRule, [mixed, mixed]);
  const statuses = m.result.runs.map((r) => r.result?.status || (r.schemaCovered ? 'covered' : 'invalid'));
  check('1.3 mixed: covered example not counted, other rejected', JSON.stringify(statuses) === '["accepted","rejected","covered"]', JSON.stringify(statuses));
  check('1.3 mixed: verdict from the other examples (correct)', ruleTestVerdict(m.result.examples, m.result.runs).kind === 'correct', JSON.stringify(ruleTestVerdict(m.result.examples, m.result.runs)));
}

// ─── Part 1.3 limit: a nesting the schema allows by another way ─────────
{
  // S1-00507-like (S1000D 4.2): <randomList> directly in <randomList> is not
  // allowed, but the schema allows it through listItem/para -- the example
  // is merely written wrong, never "covered by the schema".
  const structures42 = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
  const descript42 = structures42['S1000D 4.2|descript'];
  const rule = '<structureObjectRule id="R"><objectPath allowedObjectFlag="0">//randomList//randomList</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const xml = '<dmodule><content><description><levelledPara><para><randomList><listItem><para>A</para></listItem><randomList><listItem><para>B</para></listItem></randomList></randomList></para></levelledPara></description></content></dmodule>';
  const run = runExample(rule, 'BREX-4.2', { label: 'nested', expected: 'reject', xml, schema: 'descript', structure: descript42 }, { parseXml });
  check('1.3 limit: wrong nesting is not "covered by the schema"', run.validation.runnable === false && !run.schemaCovered, JSON.stringify(run.schemaCovered));
}

// ─── Part 1.5: truthful label after a correction ───────────────────────────
{
  const before = `<para>See <refdm>${AVEE.replace('</avee>', '<emphasis>x</emphasis></avee>')}</refdm>.</para>`;
  const after = `<para>See <refdm>${AVEE}</refdm>.</para>`;
  const note = labelNote('disallowed child element (emphasis)', after, before);
  check('1.5: label note says <emphasis> removed', note?.removed?.[0] === 'emphasis', JSON.stringify(note));
  check('1.5: text ES', es('records.ruleTest.labelRemoved', { names: '<emphasis>' }) === 'corregido: se quitó <emphasis>');
  check('1.5: nothing when unchanged', labelNote('disallowed child element (emphasis)', before, before) === null);
}

// ─── Part 2.1: a condition that cannot be met (case 3) ─────────────────────
{
  const res = checkRulePaths(objrule(CASE3_PATH), F, graph, { parseXml });
  check('case 3: one problem', res.problems.length === 1, JSON.stringify(res.problems));
  const p = res.problems[0];
  check('case 3: <p> has no <assert>, read from <evaluate>', p && p.parent === 'p' && p.element === 'assert' && p.readFrom === 'evaluate', JSON.stringify(p));
  const textEs = formatPathProblem(p, es, { format: F });
  check('case 3: ES "no se puede cumplir"', /no se puede cumplir tal como está escrita: <p> no tiene <assert>\./.test(textEs), textEs);
  check('case 3: ES read from', textEs.includes('<assert> es hijo de <evaluate>; dentro de p[…] la ruta se lee desde <p>.'), textEs);
  check('case 3: EN', /<p> has no <assert>\./.test(formatPathProblem(p, en, { format: F })));
  const correction = proposeRuleCorrection(objrule(CASE3_PATH), F, { vocabulary, graph, standard: S301, parseXml, otherVocabularies: [] });
  check('case 3: defect without proposal', correction.defects.length > 0 && !correction.proposal, JSON.stringify(correction.defects.map((d) => d.code)));
}

// ─── Part 2.2: correct nested predicates, no warning ───────────────────────
for (const path of [
  "//idstatus//applic[displaytext/p[normalize-space(.)='VCR 8X8 DRAGON'] and count(displaytext/p) &gt; 1]",
  "//idstatus//applic[not(displaytext/p[normalize-space(.)='VCR 8X8 DRAGON']) and count(displaytext/p) &gt; 1][count(evaluate/evaluate[@operator='and']) != count(displaytext/p)]",
  '//prelreqs/pmd[preceding-sibling::*[self::reqconds or self::reqpers or self::supequip or self::supplies or self::spares or self::safety] and ( /dmodule/content/proced or /dmodule/content/schedule )]',
  '//brexref[not(preceding-sibling::*[1][self::techstd])]',
  '//inlineapplics[not(applic[@id])]',
  "//pmd/opndurn[@proced and (/dmodule/content/proced or /dmodule/content/schedule) and (some $e in //reqpers/esttime satisfies number(translate(normalize-space($e), ',', '.')) &gt; number(translate(@proced, ',', '.')))]",
  CASE4_GOOD_PATH,
  CASE4_BAD_PATH,
]) {
  const res = checkRulePaths(objrule(path), F, graph, { parseXml });
  check(`2.2 no warning: ${path.slice(0, 60)}`, res.problems.length === 0, JSON.stringify(res.problems));
}

// ─── Part 2.3: engine error on an example (case 4) ─────────────────────────
{
  const doc = (ps) =>
    `<dmodule><idstatus><status><applic><displaytext>${ps.map((p) => `<p>${p}</p>`).join('')}</displaytext><evaluate andOr="or"><evaluate operator="and"><assert actidref="version" actvalues="A"/><assert actidref="variante" actvalues="B"/></evaluate></evaluate></applic></status></idstatus></dmodule>`;
  const bad = objrule(CASE4_BAD_PATH);
  const good = objrule(CASE4_GOOD_PATH);
  check('case 4: analyzeRule executable', analyzeRule(bad, F, { parseXml }).status === 'executable');
  const one = runRuleOnFragment(bad, F, doc(['A B']), 'descript', { parseXml });
  check('case 4: one <p> runs', one.status === 'accepted', one.status);
  const two = runRuleOnFragment(bad, F, doc(['A B', 'C D']), 'descript', { parseXml });
  check('case 4: two <p> → status error (never not_executable)', two.status === 'error' && two.runtimeErrors?.length === 1, JSON.stringify(two));
  const err = two.runtimeErrors[0];
  check('case 4: XPTY0004 kept', err.code === 'XPTY0004' && /normalize-space/.test(err.message), JSON.stringify(err));
  check('case 4: plain text ES', engineErrorText(err, es) === 'normalize-space() ha recibido varios <p> y solo admite uno.', engineErrorText(err, es));
  check('case 4: plain text EN', engineErrorText(err, en) === 'normalize-space() received several <p> and only accepts one.', engineErrorText(err, en));
  const examples = [
    { label: 'two paragraphs', expected: 'accept', xml: doc(['A B', 'C D']), schema: 'descript' },
    { label: 'wrong text', expected: 'reject', xml: doc(['X Y']), schema: 'descript' },
  ];
  const runs = examples.map((e) => runExample(bad, F, e, { parseXml }));
  check('case 4: example run matches false', runs[0].matches === false && runs[0].result.status === 'error');
  const verdict = ruleTestVerdict(examples, runs);
  check('case 4: verdict failed with engine errors', verdict.kind === 'incorrect' && verdict.engineErrors?.[0]?.label === 'two paragraphs', JSON.stringify(verdict));
  const record = verdictToTestRecord(verdict);
  check('case 4: recorded as failed / test_engine_error', record.result === 'failed' && record.reason.code === 'test_engine_error', JSON.stringify(record));
  const reasonEs = formatRuleTestReason(record.reason, es);
  check('case 4: reason ES gives the plain cause and the engine message', reasonEs.includes('normalize-space() ha recibido varios <p> y solo admite uno.') && reasonEs.includes('XPTY0004'), reasonEs);
  check('case 4: the good rule never errors', runExample(good, F, examples[0], { parseXml }).result.status !== 'error');
  check('case 4: the good rule on two <p>: accepted', runRuleOnFragment(good, F, doc(['X Y', 'A B']), 'descript', { parseXml }).status === 'accepted');
  check('case 4: the good rule rejects a wrong <p>', runRuleOnFragment(good, F, doc(['X Y']), 'descript', { parseXml }).status === 'rejected');
  // An XPath that does not compile is still "not executable" up front.
  check('static XPath error unchanged', analyzeRule(objrule('//para[@x = ]'), F, { parseXml }).status === 'not_executable');
}

// ─── Part 2.4a: possible fix not proposed, said (BRDP-EXT-02656) ───────────
{
  const rule = objrule('//reqconds/reqcblst//cbsublst[@cheksum] | //reqconds/reqcblst//cbdata[@cheksum] | //reqconds/reqcblst//cb[@cheksum]');
  const res = proposeRuleCorrection(rule, F, { vocabulary, graph, standard: S301, parseXml, otherVocabularies: [] });
  check('2.4a: no proposal', !res.proposal);
  check('2.4a: one blocked fix', res.blocked?.length === 1, JSON.stringify(res.blocked));
  const b = res.blocked[0];
  const line = es('records.ruleCorrection.blockedFix', {
    fix: formatRuleFix(b.defect.fix, es).replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()),
    defects: b.newDefects.map((d) => formatRuleDefect(d, es, { format: F, short: true })).join(' '),
  });
  check('2.4a: text ES', /^Arreglo posible: cambiar @cheksum por @checksum\. No se propone porque, con ese cambio, <cbdata> no tiene @checksum/.test(line), line);
}

// ─── Part 2.4b: no "Did you mean" after a prefixed name ────────────────────
{
  const v42 = vocabOf('schema-vocabulary-4-2.json');
  const c = extractContextCandidates('Decidir sobre el atributo @xsi:noNamespaceSchemaLocation para el elemento <dmodule>');
  check('2.4b: no candidate "para"', resolvePhraseCandidates(c.phraseCandidates, v42).length === 0, JSON.stringify(c.phraseCandidates));
  const ok = extractContextCandidates('el atributo applicRefId debe indicarse');
  check('2.4b: plain phrase still suggested', resolvePhraseCandidates(ok.phraseCandidates, v42).some((s) => s.name === 'applicRefId'));
  const pair = extractContextCandidates('el atributo <para/@id> y nada más');
  check('2.4b: <element/@attribute> ends the phrase too', pair.phraseCandidates.length === 0, JSON.stringify(pair.phraseCandidates));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
