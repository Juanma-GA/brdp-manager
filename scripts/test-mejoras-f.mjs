// Mejoras F: the test document (root, condition, minimal document) and what
// the schema already makes mandatory. The real S1000D 3.0.1 rules of the
// five cases (BRDP-EXT-02770, -02651, -02719, -02640, -02636) verbatim, on
// the REAL 3.0.1 structures, vocabulary, element graph and skeletons.
//   node scripts/test-mejoras-f.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { minimalDocumentRuns, newlyRejectedMinimalDocuments } from '../src/utils/ruleMinimalDocuments.js';
import { generateRuleTestExamples, isRootSelfRule, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { ruleTestVerdict, verdictCause } from '../src/utils/ruleTest.js';
import { describeRule } from '../src/utils/ruleTestEngine.js';
import { formatRuleTestReason, ruleDescriptionText, verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
import { formatCoverageItem, schemaCoverage } from '../src/validation/schemaCoverage.js';
import { absoluteConditionRequirements } from '../src/validation/rulePathCheck.js';
import { xpathBalanceProblem } from '../src/validation/xpathBalance.js';
import { formatSchemaIssue, invalidRuleXPaths, xpathIssues } from '../src/validation/schemaValidation.js';
import { formatRuleDefect, proposeRuleCorrection } from '../src/validation/ruleCorrection.js';
import { lintWarnings } from '../src/utils/ruleLint.js';
import { ruleFormatRules } from '../src/prompts/ruleFormatRules.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { schemaGraph } from './lib/schemaGraph.mjs';
import { metadataXml } from '../src/utils/ruleTestSkeleton.js';

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
const S301 = 'S1000D 3.0.1';
const F = 'BREX-3.0.1';
const graph = schemaGraph(S301);
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (schema) => STRUCTURES[`${S301}|${schema}`];
const vocabJson = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-3-0-1.json', import.meta.url)));
const vocabulary = { elements: new Set(vocabJson.elements), attributes: new Set(vocabJson.attributes) };
const objrule = (path, flag = '0', extra = '') => `<objrule id="R"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse>${extra}</objrule>`;
const runs = (rule, g = graph) => minimalDocumentRuns(rule, F, g, { standard: S301, schemaLocation: 'flat', parseXml });

// The five real rules, verbatim.
const CASE1 = '<objrule id="XML-R-2770"><objpath objappl="0">/*[not(self::dmodule)]</objpath><objuse>El elemento raíz debe ser dmodule</objuse></objrule>';
const CASE2 = '<objrule id="XML-R-2651"><objpath objappl="0">/*[ ( /dmodule/content/proced or /dmodule/content/schedule ) and not(//reqconds) ]</objpath><objuse>Los DM de procedimiento y de mantenimiento programado deben llevar reqconds</objuse></objrule>';
const CASE2_CORRECTED = '<objrule id="XML-R-2651"><objpath objappl="1">//reqconds[ /dmodule/content/proced or /dmodule/content/schedule ]</objpath><objuse>Los DM de procedimiento y de mantenimiento programado deben llevar reqconds</objuse></objrule>';
const CASE3 = "<objrule id=\"XML-R-2719\"><objpath objappl=\"0\">//*[text()[contains(., '  ')]]</objpath><objuse>No se permiten dobles espacios</objuse></objrule>";
const CASE3_GOOD = "<objrule id=\"XML-R-2719\"><objpath objappl=\"0\">//*[text()[matches(., '\\S {2,}|^ {2,}')]]</objpath><objuse>No se permiten dobles espacios</objuse></objrule>";
const CASE4A = '<objrule id="XML-R-2640"><objpath objappl="0">/*[ not(//dmaddres/issno)) ]</objpath><objuse>Todo DM lleva issno</objuse></objrule>';
const CASE4B = '<objrule id="XML-R-2640"><objpath objappl="0">//dmaddres[not(issno)]</objpath><objuse>Todo DM lleva issno</objuse></objrule>';
const CASE5_CORRECTED = '<objrule id="XML-R-2636"><objpath objappl="1">/dmodule/content//tbody/row/@rowsep</objpath><objuse>Cada row de tbody lleva rowsep 0</objuse><objval valtype="single" val1="0"/></objrule>';

const schemasFetchers = (g = graph) => ({
  fetchSchemaCards: async (_std, names) => ({
    cards: Object.fromEntries(
      names
        .map((n) => [n, g.schemas.filter((s) => (g.elements[n] || []).some((e) => e[0].includes(s)))])
        .filter(([, schemas]) => schemas.length)
        .map(([n, schemas]) => [n, { variants: [{ schemas, attributes: [], children: [], resolved: true }], parents: [] }])
    ),
    document_schemas: g.schemas,
  }),
  fetchStructure: async (_std, schema) => (structureOf(schema) ? { available: true, ...structureOf(schema) } : { available: false }),
});
const brdp = { identifier: 'BRDP-EXT-X', title: 't', definition: 'd', proposal: 'p' };
async function generate(ruleXml, answers, { g = graph, proposalCheck = null } = {}) {
  let calls = 0;
  const result = await generateRuleTestExamples({
    ruleXml,
    format: F,
    standard: S301,
    schemaLocation: 'flat',
    brdp,
    vocabulary,
    parseXml,
    ask: async () => JSON.stringify(answers[Math.min(calls++, answers.length - 1)]),
    ...schemasFetchers(g),
    fetchSchemaGraph: async () => g,
    ...(proposalCheck ? { askProposalCheck: async () => JSON.stringify(proposalCheck), ruleDescription: 'x' } : {}),
  });
  const verdict = result.status === 'ready' ? ruleTestVerdict(result.examples, result.runs, null, result.proposalCheck, null, result.coverage) : null;
  return { result, calls, verdict };
}

// ─── Backend data: skeletons and what is required, with the graph ────────
check('graph: 19 schemas of 3.0.1 with a skeleton', Object.keys(graph.skeletons || {}).length === 19, Object.keys(graph.skeletons || {}).join(','));
check('graph: <issno> required in <dmaddres>', (graph.required?.dmaddres || []).some(([, children]) => children.includes('issno')));
check('graph: <language> NOT required in <dmaddres>', !(graph.required?.dmaddres || []).some(([, children]) => children.includes('language')));
check('graph: @cbnbr required in <cb>', (graph.required?.cb || []).some(([, , attrs]) => attrs.includes('cbnbr')));

// ─── 1.1 The minimal document of each type ────────────────────────────────
{
  const r1 = runs(CASE1);
  check('case 1: rejects exactly comment, ddn, dml, pm', r1.rejected.join(',') === 'comment,ddn,dml,pm', r1.rejected.join(','));
  check('case 1: 19 counted', r1.counted === 19, String(r1.counted));
  const r2 = runs(CASE2);
  check('case 2: rejects the minimal proced and schedul (no <reqconds> written)', r2.rejected.join(',') === 'proced,schedul', r2.rejected.join(','));
  check('case 2: comment/ddn/dml/pm do not count (path anchored on <dmodule>)', r2.counted === 15 && r2.results.filter((x) => x.status === 'not_executable').length === 4);
  const r3 = runs(CASE3);
  check('case 3: rejects descript, pm, proced, schedul (the indentation)', ['descript', 'pm', 'proced', 'schedul'].every((s) => r3.rejected.includes(s)), r3.rejected.join(','));
  check('case 3 good (matches): rejects none', runs(CASE3_GOOD).rejected.length === 0);
  const rqa = runs(objrule('/*[not(//status/qa)]'));
  check('/*[not(//status/qa)]: rejects ddn, pm…', ['ddn', 'pm'].every((s) => rqa.rejected.includes(s)) && !rqa.rejected.includes('descript'), rqa.rejected.join(','));
  check('/*[not(//dmaddres)]: rejects ddn, pm…', ['ddn', 'pm'].every((s) => runs(objrule('/*[not(//dmaddres)]')).rejected.includes(s)));
  const r00001 = runs(objrule('//orig/@origname', '1', '<objval valtype="single" val1="A"/>'));
  check('BRDP-EXT-00001 shape (//orig/@origname, objappl 1 + values): rejects the minimal data modules', r00001.rejected.includes('descript'), r00001.rejected.join(','));
  check('text ES, case 1', es('records.ruleTest.minimalRejects', { schemas: r1.rejected.join(', '), count: 4, total: 19 }) === 'Sin nada escrito para la prueba, la regla ya rechaza los documentos de tipo: comment, ddn, dml, pm (4 de 19).');
  // (c) The corrected rule of case 2 rejects a descript the previous accepted.
  const newly = newlyRejectedMinimalDocuments(runs(CASE2), runs(CASE2_CORRECTED));
  check('case 2 corrected: newly rejects descript', newly.includes('descript'), newly.join(','));
  check('case 2 corrected: proced is not "newly" rejected (both reject it)', !newly.includes('proced'));
  check('text ES (c), one', es('records.ruleTest.minimalNewlyRejected', { count: 1, schemas: 'descript' }) === 'Esta regla rechaza un documento de tipo descript sin nada escrito para la prueba; la regla anterior lo aceptaba. Revísala antes de aceptarla.');
  // A rule limited to one schema: the others are "not applicable", never counted.
  const scoped = '<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd"><structrules>' + objrule('//para') + '</structrules></contextrules>';
  const rScoped = runs(scoped);
  check('context rule: only proced counted', rScoped.counted === 1 && rScoped.results.filter((x) => x.status === 'not_applicable').length === 18, `${rScoped.counted}`);
  check('no skeletons: not available', !minimalDocumentRuns(CASE1, F, { ...graph, skeletons: {} }, { standard: S301, parseXml }).available);
  // DITA: with the topic-type skeletons.
  const dita = schemaGraph('DITA 1.3 Xpath2.0');
  const ditaRule = '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p"><sch:rule context="title"><sch:report id="r" test="true()" role="error">t</sch:report></sch:rule></sch:pattern>';
  const rd = minimalDocumentRuns(ditaRule, 'SCH-DITA', dita, { standard: 'DITA 1.3 Xpath2.0', parseXml });
  check('DITA: minimal documents of the topic types', rd.available && rd.counted >= 5, JSON.stringify(rd.results.map((x) => `${x.schema}:${x.status}`)));
}

// ─── 1.2 A rule on the root ───────────────────────────────────────────────
{
  check('case 1 is a root rule', isRootSelfRule(CASE1, F, { parseXml }));
  check('/pm is not (unchanged)', !isRootSelfRule(objrule('/pm'), F, { parseXml }) && !isRootSelfRule(objrule('/ddn'), F, { parseXml }));
  check('/*[not(//status/qa)] is not (normal test)', !isRootSelfRule(objrule('/*[not(//status/qa)]'), F, { parseXml }));
  check('case 2 is not', !isRootSelfRule(CASE2, F, { parseXml }));
  const { result, calls, verdict } = await generate(CASE1, [{ examples: [] }], { proposalCheck: { implements: 'yes', reason: '' } });
  check('case 1: no LLM call for the examples', calls === 0, String(calls));
  check('case 1: descript accepted, pm rejected', result.examples.map((e) => `${e.schema}:${e.expected}`).join(',') === 'descript:accept,pm:reject', result.examples.map((e) => `${e.schema}:${e.expected}`).join(','));
  check('case 1: built by the application', result.examples.every((e) => e.minimalDocument === true));
  check('case 1: runs as expected', result.runs.every((r) => r.matches === true));
  check('case 1: verdict Correct', verdict?.kind === 'correct', JSON.stringify(verdict));
  const dmOnly = { ...graph, skeletons: Object.fromEntries(Object.entries(graph.skeletons).filter(([, v]) => v.path[0] === 'dmodule')) };
  const covered = await generate(CASE1, [{ examples: [] }], { g: dmOnly });
  check('all roots <dmodule>: "Already covered by the schema"', covered.verdict?.kind === 'schema_covered' && covered.verdict.items[0].kind === 'rootsAllowed', JSON.stringify(covered.verdict));
  check('rootsAllowed text ES', formatCoverageItem(covered.verdict.items[0], es) === 'todos los tipos de documento del estándar tienen <dmodule> como raíz, y la regla la admite');
  const all = await generate(objrule('/*[self::dmodule or self::pm or self::ddn or self::dml or self::comment]'), [{ examples: [] }]);
  check('rejects every root: review', all.verdict?.kind === 'review' && all.verdict.rootAll === true, JSON.stringify(all.verdict));
  check('review recorded with its own reason', verdictToTestRecord(all.verdict).reason.code === 'test_root_rejects_all');
  check('review text ES', es('records.ruleTest.verdicts.reviewRootAll') === 'Revisar: la regla rechaza la raíz de todos los tipos de documento.');
  // Description.
  const d1 = ruleDescriptionText(describeRule(CASE1, F, { parseXml }), es);
  check('describe case 1 ES', d1.includes('El elemento raíz del documento debe ser <dmodule>'), d1);
  const dAny = ruleDescriptionText(describeRule(objrule('/*[not(//reqconds)]'), F, { parseXml }), es);
  check('describe /*[not(//x)] ES: any type of document', dAny.includes('Todo documento, de cualquier tipo, debe contener algún <reqconds>'), dAny);
}

// ─── 1.3 The test schema meets the condition's absolute paths ────────────
{
  check('case 2: requirement proced or schedule', JSON.stringify(absoluteConditionRequirements(CASE2, F, { parseXml })) === JSON.stringify([[['dmodule', 'content', 'proced'], ['dmodule', 'content', 'schedule']]]));
  check('negated: no requirement', absoluteConditionRequirements(objrule('//reqconds[not(/dmodule/content/proced)]'), F, { parseXml }).length === 0);
  const prep = await prepareRuleTestSetup({ ruleXml: CASE2, standard: S301, schemaLocation: 'flat', ...schemasFetchers(), format: F, parseXml });
  check('case 2: tested on proced', prep.promptPlacements[0]?.schema === 'proced', prep.promptPlacements.map((p) => p.schema).join(','));
  check('case 2: insertion point reaches <reqconds> (proced)', prep.promptPlacements[0]?.insertion === 'proced', prep.promptPlacements[0]?.insertion);
  const prepNeg = await prepareRuleTestSetup({ ruleXml: objrule('//reqconds[not(/dmodule/content/proced)]'), standard: S301, schemaLocation: 'flat', ...schemasFetchers(), format: F, parseXml });
  check('not(/dmodule/content/proced): 1.3 does not apply', prepNeg.promptPlacements[0]?.schema !== undefined && !prepNeg.unreachable);
  const SAFETY = objrule('//safety/*[not(self::safecond or self::nosafety) and ( /dmodule/content/proced or /dmodule/content/schedule )]');
  const prepSafety = await prepareRuleTestSetup({ ruleXml: SAFETY, standard: S301, schemaLocation: 'flat', ...schemasFetchers(), format: F, parseXml, acceptOnly: true });
  check('safety rule: proced', prepSafety.promptPlacements[0]?.schema === 'proced', prepSafety.promptPlacements.map((p) => p.schema).join(','));
  check('safety rule: covered by the schema', schemaCoverage(SAFETY, F, graph, { parseXml })?.items?.[0]?.kind === 'childrenListed');
  const none = await prepareRuleTestSetup({ ruleXml: objrule('/*[/dmodule/content/nothere and not(//para)]'), standard: S301, schemaLocation: 'flat', ...schemasFetchers(), format: F, parseXml });
  check('no schema meets it: not executable before any LLM call', none.unreachable?.code === 'condition_no_schema', JSON.stringify(none.unreachable));
  check('condition_no_schema text ES', formatRuleTestReason(none.unreachable, es).startsWith('ningún esquema de S1000D 3.0.1 tiene /dmodule/content/nothere'), formatRuleTestReason(none.unreachable, es));
  // The whole flow: accepted with <reqconds>, rejected without -> Correct.
  const PRELREQS = '<prelreqs><reqconds><noconds/></reqconds><reqpers><person man="A"/></reqpers><supequip><nosupeq/></supequip><supplies><nosupply/></supplies><spares><nospares/></spares><safety><nosafety/></safety></prelreqs>';
  const MAIN = '<mainfunc><step1><para>Do it.</para></step1></mainfunc>';
  const { verdict, result } = await generate(CASE2, [
    { examples: [
      { label: 'with reqconds', expected: 'accept', schema: 'proced', content: PRELREQS + MAIN },
      { label: 'without reqconds', expected: 'reject', schema: 'proced', content: MAIN },
    ] },
  ]);
  check('case 2: Correct', verdict?.kind === 'correct', JSON.stringify(verdict) + JSON.stringify(result.runs?.map((r) => r.validation?.structure)));
}

// ─── 1.4 Why the rule rejected an accept example ──────────────────────────
{
  const { result, verdict } = await generate(CASE3, [
    { examples: [
      { label: 'one space', expected: 'accept', schema: 'descript', content: 'Text with one space.' },
      { label: 'two spaces', expected: 'reject', schema: 'descript', content: 'Text with  two spaces.' },
    ] },
  ]);
  const rejection = result.runs[0].rejection;
  check('case 3: accept example rejected', result.runs[0].result.status === 'rejected');
  check('case 3: at most 5 nodes shown, "and N more"', rejection.nodes.length === 5 && rejection.more > 0, JSON.stringify(rejection));
  check('case 3: all in the document built by the application', rejection.allAppBuilt === true);
  const cause = verdictCause(verdict, result.runs);
  check('case 3: the cause is the application-built document, not "review that example"', cause?.appBuilt === true, JSON.stringify(cause));
  check('case 3: reject example (LLM text) is NOT counted as application-built', !result.runs[1].rejection);
  const written = await generate(objrule('//emphasis'), [
    { examples: [
      { label: 'emphasis', expected: 'accept', schema: 'descript', content: 'Text <emphasis>x</emphasis>.' },
      { label: 'none', expected: 'reject', schema: 'descript', content: 'Text.' },
    ] },
  ]);
  check('//emphasis: the rejected node was written for the test', written.result.runs?.[0]?.rejection?.allAppBuilt === false, JSON.stringify(written.result.runs?.[0]?.rejection) + written.result.status);
  check('//emphasis: the verdict still says to review the example', verdictCause(written.verdict, written.result.runs)?.appBuilt !== true);
  check('rejectedAppBuilt ES', es('records.ruleTest.rejectedAppBuilt', { count: 16 }) === '; todos están en el documento montado por la aplicación, no en lo escrito para la prueba');
}

// ─── 1.5 The text line in the Suggest Rule format rules ───────────────────
for (const f of ['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1', 'SCH-DITA']) {
  check(`${f}: indentation is text`, ruleFormatRules(f, 'DITA 1.3 Xpath2.0').includes('The indentation and line breaks between elements are text nodes too'));
}
check('describe keeps both spaces of contains(., \'  \')', ruleDescriptionText(describeRule(CASE3, F, { parseXml }), es).includes("contains(., '  ')"));

// ─── 2.1 What the schema already makes mandatory ─────────────────────────
{
  const cov = (path) => schemaCoverage(objrule(path), F, graph, { parseXml });
  const c4b = schemaCoverage(CASE4B, F, graph, { parseXml });
  check('case 4b: <issno> required in <dmaddres>', c4b?.items?.[0]?.kind === 'requiredChild' && formatCoverageItem(c4b.items[0], es) === '<issno> es obligatorio en <dmaddres>', JSON.stringify(c4b));
  check('02635 tgroup[not(tbody)]: covered', cov('/dmodule/content//tgroup[not(tbody)]')?.items?.[0]?.kind === 'requiredChild');
  const c57 = cov('//reqconds/reqcblst//cb[ not(@cbnbr) ]');
  check('02657 cb[not(@cbnbr)]: covered, text', c57?.items?.[0]?.kind === 'requiredAttribute' && formatCoverageItem(c57.items[0], es) === '@cbnbr es obligatorio en <cb>');
  check('dmaddres[not(language)]: normal test', cov('//dmaddres[not(language)]') === null);
  check('table[not(title)]: normal test', cov('/dmodule/content//table[not(title)]') === null);
  check('cb[not(@cbaction)]: normal test', cov('//reqconds/reqcblst//cb[ not(@cbaction) ]') === null);
  check('supequi|supply|spare[not(qty)]: covered only with the three', cov('//supequi[not(qty)] | //supply[not(qty)] | //spare[not(qty)]')?.items?.length === 3);
  check('a child of a required choice never counts (reqconds[not(noconds)])', cov('//reqconds[not(noconds)]') === null);
  check('avehcfg[not(jacked)] covered', cov('//avehcfg[not(jacked)]')?.items?.[0]?.kind === 'requiredChild');
  check('flag 1: never covered', schemaCoverage(objrule('//dmaddres[not(issno)]', '1'), F, graph, { parseXml }) === null);
  // The whole flow: accept example only, "Already covered by the schema".
  const { verdict, calls } = await generate(CASE4B, [
    { examples: [{ label: 'issno', expected: 'accept', schema: 'descript', metadata: metadataXml(structureOf('descript').skeleton.metadata.tree).xml, content: 'Text.' }] },
  ]);
  check('case 4b: "Already covered by the schema"', verdict?.kind === 'schema_covered', JSON.stringify(verdict));
  check('case 4b: one call (accept only)', calls === 1);
}

// ─── 2.2 Mandatory with values ───────────────────────────────────────────
{
  const w = lintWarnings(CASE5_CORRECTED, F, 'panel', es, { parseXml });
  const amber = w.find((x) => x.code === 'flag1_with_values');
  check('case 5 corrected: amber warning', amber?.amber === true, JSON.stringify(w));
  check('case 5 corrected: the exact text', amber?.detail === "Con objappl=\"1\" y valores no todos los validadores hacen lo mismo: unos exigen el valor en cada <row>; otros solo que el documento tenga algún @rowsep, y entonces rechazan un documento sin <row>. Para exigirlo en cada <row>, prohíbe lo contrario: row[not(@rowsep='0')].", amber?.detail);
  check('in the suggestion too', lintWarnings(CASE5_CORRECTED, F, 'suggestion', es, { parseXml }).some((x) => x.code === 'flag1_with_values'));
  check('flag 0 with the opposite: no warning', !lintWarnings(objrule("/dmodule/content//tbody/row[not(@rowsep='0')]"), F, 'panel', es, { parseXml }).some((x) => x.code === 'flag1_with_values'));
  check('values without objappl: no warning', !lintWarnings('<objrule id="R"><objpath>//@emph</objpath><objuse>x</objuse><objval valtype="single" val1="em01"/></objrule>', F, 'panel', es, { parseXml }).some((x) => x.code === 'flag1_with_values'));
  for (const f of ['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']) {
    const rules = ruleFormatRules(f, '');
    check(`${f}: rule 9 forbids the opposite`, rules.includes("X[not(@a='v')]") && rules.includes("//acmeElement[not(@acmeAttr='1')]"));
  }
  check('3.0.1 rule 5 no longer sends a mandatory node to objappl="1"', !ruleFormatRules('BREX-3.0.1', '').includes('then objappl="1"'));
}

// ─── 2.3 XPath errors in plain words ─────────────────────────────────────
{
  const cases = [
    ['/*[ not(//dmaddres/issno)) ]', 'extraCloseParen'],
    ['(//a', 'missingCloseParen'],
    ['//a[b', 'missingCloseBracket'],
    ['//a]', 'extraCloseBracket'],
    ["//a[@x='y]", 'missingCloseQuote'],
    ["//p[contains(., ')')]", null],
    ['//a[(b]', 'missingCloseParen'],
  ];
  for (const [expr, want] of cases) check(`balance ${expr}`, xpathBalanceProblem(expr) === want, String(xpathBalanceProblem(expr)));
  const a = analyzeRule(CASE4A, F, { parseXml });
  const text = formatRuleTestReason(a.reason, es);
  check('case 4a: "Sobra un paréntesis de cierre." then the engine message', a.status === 'not_executable' && text.startsWith('Sobra un paréntesis de cierre. Error de XPath: XPST0003'), text);
  check('case 4a: editor warning', formatSchemaIssue(xpathIssues(invalidRuleXPaths(CASE4A))[0], es).startsWith('Sobra un paréntesis de cierre.'));
  const correction = proposeRuleCorrection(CASE4A, F, { graph, vocabulary, parseXml });
  const defect = (correction?.unfixable || correction?.defects || []).find((d) => d.code === 'xpath_invalid');
  check('case 4a: "Defecto detectado"', defect && formatRuleDefect(defect, es).startsWith('Sobra un paréntesis de cierre.'), JSON.stringify(correction));
  check('texts EN', en('records.xpathBalance.missingCloseQuote') === 'A quote is not closed.' && es('records.xpathBalance.missingCloseBracket') === 'Falta cerrar un corchete.');
}

// ─── 2.4 "//" says "at any level" ────────────────────────────────────────
{
  const d = ruleDescriptionText(describeRule(objrule('//reqconds/reqcblst//*[@checksum]'), F, { parseXml }), es);
  check('//reqcblst//*[@checksum]: at any level', d.includes('Cualquier elemento dentro de <reqcblst>, a cualquier nivel, con @checksum'), d);
  const d2 = ruleDescriptionText(describeRule(objrule('//reqcblst/*[@checksum]'), F, { parseXml }), es);
  check('//reqcblst/*[@checksum]: child', d2.includes('Cualquier elemento hijo de <reqcblst>'), d2);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
