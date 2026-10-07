// Mejoras G: how many times each element can appear, and what the rule
// reaches. The real S1000D 3.0.1 rules of the five cases (BRDP-EXT-02786,
// -02792/-02642…-02646, -02656, -02651, -02715) verbatim, on the REAL 3.0.1
// structures, vocabulary, element graph (with its maxima) and skeletons.
//   node scripts/test-mejoras-g.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { minimalDocument } from '../src/utils/ruleMinimalDocuments.js';
import { documentPresenceTest, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { exampleProblems, runExample, ruleTestVerdict, validateExample } from '../src/utils/ruleTest.js';
import { describeRule } from '../src/utils/ruleTestEngine.js';
import { formatRuleTestReason, ruleDescriptionText, verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
import { formatCoverageItem, schemaCoverage } from '../src/validation/schemaCoverage.js';
import { checkExampleStructure, formatSchemaIssue, invalidRuleXPaths, structureIssues, xpathIssues } from '../src/validation/schemaValidation.js';
import {
  formatTextFunctionWarning,
  reachBeyondProposal,
  repeatingComparisons,
  severalUncovered,
  singleChildPairs,
  starReach,
  textFunctionWarnings,
  viewFromStructure,
} from '../src/validation/ruleRepetition.js';
import { alignRuleIds, ruleElementIds } from '../src/utils/ruleSplit.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { ruleFormatRules } from '../src/prompts/ruleFormatRules.js';
import { placeExample, ruleTargets } from '../src/utils/ruleTestSkeleton.js';
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
const S301 = 'S1000D 3.0.1';
const F = 'BREX-3.0.1';
const graph = schemaGraph(S301);
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (schema) => STRUCTURES[`${S301}|${schema}`];
const vocabJson = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-3-0-1.json', import.meta.url)));
const vocabulary = { elements: new Set(vocabJson.elements), attributes: new Set(vocabJson.attributes) };
const placementsFor = (rule, schema = 'descript') => [{ schema, role: 'rule', ...placeExample(structureOf(schema), ruleTargets(rule)) }];
const objrule = (path, flag = '0', id = 'R') => `<objrule id="${id}"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse></objrule>`;

// The five real rules, verbatim.
const CASE1 = objrule("//idstatus//applic[not(DRAGON) and count(displaytext/p) &gt; 1][count(evaluate/evaluate[@operator='and']) != count(displaytext/p)]", '0', 'XML-R-2786');
const CASE2 = objrule("//evaluate[normalize-space(concat(@actidref, ' ', @actreftype)) = normalize-space(ancestor::applic/displaytext/p)]", '0', 'XML-R-2792');
const CASE2B = objrule("//status/rfu[ string(//refdm/issno/@issno) = '000' or string(//refdm/issno/@inwork) = '00' ]", '0', 'XML-R-2642');
const CASE3 = objrule('//reqconds/reqcblst//*[@checksum]', '0', 'XML-R-2656');
const CASE3_PROPOSAL = 'Ningún <cbsublst> ni <cb> dentro de <reqcblst> puede llevar @checksum';
const CASE4_PREVIOUS = objrule('/*[ ( /dmodule/content/proced or /dmodule/content/schedule ) and not(//reqconds) ]', '0', 'XML-R-2655');
const CASE4_LLM = objrule('//reqconds[ /dmodule/content/proced or /dmodule/content/schedule ]', '1', 'XML-R-2652');
const CASE5 = objrule('/*[not(//dmaddres)]', '0', 'XML-R-2715');

// ─── 1.1 Data: the maxima in the graph and in the structures ──────────────
const maxOf = (parent, child, schema = 'descript') => {
  const entry = (graph.maxima?.[parent] || []).find(([schemas]) => schemas.includes(schema));
  return entry ? entry[1][child] : undefined;
};
check('1.1 applic/evaluate 1', maxOf('applic', 'evaluate') === 1);
check('1.1 applic/displaytext 1', maxOf('applic', 'displaytext') === 1);
check('1.1 dmaddres/issno 1', maxOf('dmaddres', 'issno') === 1);
check('1.1 displaytext/p unbounded (no finite maximum)', maxOf('displaytext', 'p') === undefined);
check('1.1 evaluate/evaluate unbounded', maxOf('evaluate', 'evaluate') === undefined);
check('1.1 structure models carry max', structureOf('descript').models.applic.max.evaluate === 1 && structureOf('descript').models.displaytext.max.p === undefined);

// ─── 1.2 Example check: more children than allowed ────────────────────────
const minimal = minimalDocument(graph, S301, 'descript', 'flat').xml;
const twoEvaluates = minimal.replace('</displaytext>', '</displaytext><evaluate/><evaluate/>');
{
  const problems = checkExampleStructure(parseXml(twoEvaluates), structureOf('descript'));
  const tooMany = problems.find((p) => p.kind === 'tooMany');
  check('1.2 caso 1: two <evaluate> in <applic> → tooMany', tooMany && tooMany.parent === 'applic' && tooMany.element === 'evaluate' && tooMany.max === 1 && tooMany.count === 2, JSON.stringify(problems));
  check('1.2 text ES', formatSchemaIssue(structureIssues([tooMany], { schema: 'descript' })[0], es) === '<applic> admite como mucho 1 <evaluate>; el ejemplo tiene 2');
  check('1.2 text EN', formatSchemaIssue(structureIssues([tooMany], { schema: 'descript' })[0], en) === '<applic> allows at most 1 <evaluate>; the example has 2');
  const validation = validateExample(twoEvaluates, vocabulary, parseXml, structureOf('descript'));
  check('1.2 not runnable', validation.runnable === false);
  const lines = exampleProblems(validation, { standard: S301, schema: 'descript' });
  check('1.2 correction line', lines.some((l) => l.startsWith('<applic> allows at most 1 <evaluate>; the example has 2')), lines.join('\n'));
  check('1.2 card of the parent with its maxima', lines.some((l) => l.startsWith('card of <applic>') && /at most 1 of each: <assert>, <displaytext>, <evaluate>/.test(l)), lines.join('\n'));
  check('1.2 card of the child', lines.some((l) => l.startsWith('card of <evaluate>')), lines.join('\n'));
  const run = runExample(CASE1, F, { xml: twoEvaluates, structure: structureOf('descript'), schema: 'descript', expected: 'accept' }, { vocabulary, parseXml });
  check('1.2 the example is not run as valid', !run.result, JSON.stringify(run.result));
  // valid cases
  const ok = (xml) => !checkExampleStructure(parseXml(xml), structureOf('descript')).some((p) => p.kind === 'tooMany');
  check('1.2 <evaluate> with five <evaluate> inside: valid', ok(minimal.replace('</displaytext>', '</displaytext><evaluate><evaluate/><evaluate/><evaluate/><evaluate/><evaluate/></evaluate>')));
  check('1.2 <displaytext> with four <p>: valid', ok(minimal.replace('</displaytext>', '<p>b</p><p>c</p><p>d</p></displaytext>')));
  check('1.2 <applic> with <displaytext> and one <evaluate>: valid', ok(minimal.replace('</displaytext>', '</displaytext><evaluate/>')));
  check('1.2 <assert> and <evaluate> at once: not detected (not modelled)', ok(minimal.replace('</displaytext>', '</displaytext><assert/><evaluate/>')));
}

// ─── 1.3 "Already covered by the schema" by maximum ───────────────────────
{
  const cov = schemaCoverage(objrule('//applic[count(evaluate) &gt; 1]'), F, graph, { parseXml });
  check('1.3 //applic[count(evaluate) > 1] → covered', cov?.items?.[0]?.kind === 'maxChildren' && cov.items[0].max === 1, JSON.stringify(cov));
  check('1.3 reason ES', formatCoverageItem(cov.items[0], es) === '<applic> admite como mucho 1 <evaluate>');
  check('1.3 //displaytext[count(p) > 3] → normal test', schemaCoverage(objrule('//displaytext[count(p) &gt; 3]'), F, graph, { parseXml }) === null);
  check('1.3 //applic[count(evaluate) >= 1] → normal test', schemaCoverage(objrule('//applic[count(evaluate) &gt;= 1]'), F, graph, { parseXml }) === null);
  check('1.3 caso 1 rule → normal test', schemaCoverage(CASE1, F, graph, { parseXml }) === null);
  check('1.3 flag 1 never covered', schemaCoverage(objrule('//applic[count(evaluate) &gt; 1]', '1'), F, graph, { parseXml }) === null);
}

// ─── 1.4 Examples prompt: "at most one <evaluate> inside <applic>" ─────────
{
  const v = [viewFromStructure(structureOf('descript'))];
  const pairs = singleChildPairs(CASE1, F, v, { parseXml });
  const names = pairs.map((p) => `${p.parent}/${p.child}`).sort().join(',');
  check('1.4 caso 1 pairs with max 1', names === 'applic/displaytext,applic/evaluate', names);
  const prompt = buildRuleTestExamplesPrompt({
    brdp: { identifier: 'BRDP-EXT-02786', title: 't', definition: 'd', proposal: 'p' },
    standard: S301,
    format: F,
    ruleXml: CASE1,
    placements: placementsFor(CASE1),
    schemaFacts: [{ name: 'applic', entry: { variants: [{ schemas: ['descript'], attributes: [], children: ['displaytext', 'evaluate'], resolved: true }], parents: ['status'] } }],
    limits: pairs,
  });
  check('1.4 line in the parent card', /<applic> \(schemas: descript\)[\s\S]*allowed inside: status\n {2}at most one <displaytext> inside <applic>\n {2}at most one <evaluate> inside <applic>/.test(prompt), prompt.slice(prompt.indexOf('SCHEMA FACTS')));
  const loose = buildRuleTestExamplesPrompt({ brdp: { identifier: 'X', title: 't', definition: 'd', proposal: 'p' }, standard: S301, format: F, ruleXml: CASE1, placements: placementsFor(CASE1), limits: pairs });
  check('1.4 without a card: its own block', loose.includes('AT MOST ONE (the schema allows no more):\n- at most one <displaytext> inside <applic>'));
  const without = buildRuleTestExamplesPrompt({ brdp: { identifier: 'X', title: 't', definition: 'd', proposal: 'p' }, standard: S301, format: F, ruleXml: CASE1, placements: placementsFor(CASE1) });
  check('1.4 no limits → no lines', !without.includes('at most one'));
}

// ─── 1.5 Text functions over paths that can give several nodes ────────────
{
  const w = (rule) => textFunctionWarnings(rule, F, graph, { parseXml });
  const c2 = w(CASE2);
  check('1.5 caso 2: normalize-space over ancestor::applic/displaytext/p', c2.length === 1 && c2[0].argument === 'ancestor::applic/displaytext/p' && c2[0].repeating === 'p', JSON.stringify(c2));
  check(
    '1.5 text ES (literal)',
    formatTextFunctionWarning(c2[0], es) ===
      'normalize-space() recibe ancestor::applic/displaytext/p, que puede dar varios <p>. Con más de uno, la regla da error o mira solo el primero. Para «algún <p>» usa some $p in … satisfies …; para el primero, añade [1].',
    formatTextFunctionWarning(c2[0], es)
  );
  check('1.5 text EN', formatTextFunctionWarning(c2[0], en).startsWith('normalize-space() receives ancestor::applic/displaytext/p, which can give several <p>.'));
  const c2b = w(CASE2B);
  check('1.5 string(//refdm/issno/@issno) (02642-02646)', c2b.some((x) => x.fn === 'string' && x.argument === '//refdm/issno/@issno' && x.repeating === 'refdm'), JSON.stringify(c2b));
  for (const path of [
    "//supequi[normalize-space(nomen) = 'x']",
    "//p[normalize-space(.) = 'x']",
    "//dmaddres[string(@issno) = '000']",
    "//status[string(//dmaddres/issno/@issno) = '000']",
    "//evaluate[normalize-space(ancestor::applic/displaytext/p[1]) = 'x']",
    "//evaluate[some $p in ancestor::applic/displaytext/p satisfies normalize-space($p) = 'x']",
    '//para[@refapplic = //inlineapplics/applic/@id]',
  ]) {
    check(`1.5 no warning: ${path}`, w(objrule(path)).length === 0, JSON.stringify(w(objrule(path))));
  }
  const rules = ruleFormatRules(F, S301);
  check('1.5 Suggest Rule format line (BREX)', rules.includes('10. A text function (normalize-space, string, concat, contains…) takes ONE node'));
  check('1.5 Suggest Rule format line (Schematron)', ruleFormatRules('SCH-DITA', 'DITA 1.3 Xpath2.0').includes('14. A text function'));
  // DITA: a single merged schema
  const dita = schemaGraph('DITA 1.3 Xpath2.0');
  const sch = '<sch:pattern id="p-X"><sch:rule context="step"><sch:assert id="X" test="normalize-space(info) != \'\'">x</sch:assert></sch:rule></sch:pattern>';
  check('1.5 DITA: info can repeat in <step> → warning', textFunctionWarnings(sch, 'SCH-DITA', dita, { parseXml }).length === 1);
  const sch1 = '<sch:pattern id="p-X"><sch:rule context="step"><sch:assert id="X" test="normalize-space(cmd) != \'\'">x</sch:assert></sch:rule></sch:pattern>';
  check('1.5 DITA: <cmd> once in <step> → no warning', textFunctionWarnings(sch1, 'SCH-DITA', dita, { parseXml }).length === 0);
}

// ─── 1.6 Examples with several ────────────────────────────────────────────
{
  const v = [viewFromStructure(structureOf('descript'))];
  const r2 = repeatingComparisons(CASE2, F, v, { parseXml });
  check('1.6 caso 2: several <p> requested', r2.length === 1 && r2[0].element === 'p' && r2[0].parent === 'displaytext', JSON.stringify(r2));
  const some = repeatingComparisons(objrule("//evaluate[some $p in ancestor::applic/displaytext/p satisfies normalize-space($p) = 'x']"), F, v, { parseXml });
  check('1.6 some … satisfies: several <p> requested', some.length === 1 && some[0].element === 'p');
  const nofn = repeatingComparisons(objrule('//para[@refapplic = //inlineapplics/applic/@id]'), F, v, { parseXml });
  check('1.6 without a function: several <applic>', nofn.length === 1 && nofn[0].element === 'applic', JSON.stringify(nofn));
  check('1.6 no comparison → nothing', repeatingComparisons(objrule('//emphasis'), F, v, { parseXml }).length === 0);
  const prompt = buildRuleTestExamplesPrompt({ brdp: { identifier: 'X', title: 't', definition: 'd', proposal: 'p' }, standard: S301, format: F, ruleXml: CASE2, placements: placementsFor(CASE2), several: r2 });
  check('1.6 prompt asks for two or more', prompt.includes('SEVERAL NODES') && prompt.includes('- ancestor::applic/displaytext/p can give several <p>.') && prompt.includes('carry\ntwo or more of that element there, with different values.'));
  check('1.6 no request → prompt unchanged', !buildRuleTestExamplesPrompt({ brdp: { identifier: 'X', title: 't', definition: 'd', proposal: 'p' }, standard: S301, format: F, ruleXml: CASE2, placements: placementsFor(CASE2) }).includes('SEVERAL NODES'));
  // panel note
  const onePara = { xml: minimal, expected: 'accept' };
  const twoPara = { xml: minimal.replace('</displaytext>', '<p>b</p></displaytext>'), expected: 'accept' };
  const ran = { result: { status: 'accepted' } };
  check('1.6 no example with two <p> → note', severalUncovered(r2, [onePara], [ran], parseXml).join() === 'p');
  check('1.6 an example with two <p> → no note', severalUncovered(r2, [onePara, twoPara], [ran, ran], parseXml).length === 0);
  check('1.6 not executed → does not count', severalUncovered(r2, [twoPara], [{ result: null }], parseXml).join() === 'p');
  check('1.6 note ES', es('records.ruleTest.repetition.severalUncovered', { element: '<p>' }) === 'Ningún ejemplo tiene más de un <p>: la prueba no cubre ese caso.');
  // through the real setup
  const fetchers = {
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: graph.schemas }),
    fetchStructure: async (_s, schema) => (structureOf(schema) ? { available: true, ...structureOf(schema) } : { available: false }),
  };
  const prep = await prepareRuleTestSetup({ ruleXml: CASE2, standard: S301, schemaLocation: 'flat', ...fetchers, format: F, parseXml });
  check('1.6 setup carries several', (prep.several || []).some((s) => s.element === 'p'), JSON.stringify(prep.several));
  const prep1 = await prepareRuleTestSetup({ ruleXml: CASE1, standard: S301, schemaLocation: 'flat', ...fetchers, format: F, parseXml });
  check('1.4 setup carries the caso 1 limits', (prep1.limits || []).some((l) => l.parent === 'applic' && l.child === 'evaluate'), JSON.stringify(prep1.limits));
}

// ─── 2.1 What a "*[@a]" step reaches ──────────────────────────────────────
{
  const reach = starReach(CASE3, F, graph, { parseXml });
  check('2.1 caso 3 reaches <cb>, <cblst>, <cbsublst>', reach.length === 1 && reach[0].elements.join(',') === 'cb,cblst,cbsublst', JSON.stringify(reach));
  check('2.1 list ES', es('records.ruleTest.reach.list', { path: reach[0].path, names: '<cb>, <cblst> y <cbsublst>' }) === '//reqconds/reqcblst//*[@checksum] alcanza a <cb>, <cblst> y <cbsublst>.');
  const beyond = reachBeyondProposal(reach, CASE3_PROPOSAL);
  check('2.1 warning: <cblst> not in the Proposal', beyond.join() === 'cblst', beyond.join());
  check('2.1 warning ES', es('records.ruleTest.reach.beyond', { names: '<cblst>' }) === 'La regla alcanza también a <cblst>, que la Propuesta no menciona.');
  const mark = starReach(objrule("//*[@mark and @mark != '1']"), F, graph, { parseXml });
  check('2.1 //*[@mark and …] → 316 elements', mark.length === 1 && mark[0].elements.length === 316, String(mark[0]?.elements.length));
  check('2.1 316 → no Proposal warning', reachBeyondProposal(mark, CASE3_PROPOSAL).length === 0);
  check('2.1 //supequi/*[not(self::…)] → unchanged', starReach(objrule('//supequi/*[not(self::nomen or self::refs)]'), F, graph, { parseXml }).length === 0);
  check('2.1 Proposal without marked elements → no warning', reachBeyondProposal(reach, 'Nothing about it').length === 0);
}

// ─── 2.2 Rule ids ─────────────────────────────────────────────────────────
{
  const a = alignRuleIds(CASE4_LLM, F, CASE4_PREVIOUS);
  check('2.2 a caso 4: offered with id="XML-R-2655"', ruleElementIds(a.xml, F).join() === 'XML-R-2655', a.xml);
  const two = alignRuleIds(objrule('//a', '0', 'X') + objrule('//b', '0', 'Y'), F, CASE4_PREVIOUS);
  check('2.2 a two rules where there was one → -1 and -2', ruleElementIds(two.xml, F).join() === 'XML-R-2655-1,XML-R-2655-2', two.xml);
  check('2.2 b text ES', es('records.ruleTest.idClash', { id: 'XML-R-2652', identifiers: 'BRDP-S1-00024' }) === 'El id XML-R-2652 ya lo usa la regla de BRDP-S1-00024. Dos reglas con el mismo id dan un BREX no válido.');
}

// ─── 2.3 "Every document must contain <x>" solved with the schema ─────────
{
  const run = (rule) => documentPresenceTest({ ruleXml: rule, format: F, standard: S301, schemaLocation: 'flat', graph, vocabulary, parseXml });
  const t5 = run(CASE5);
  check('2.3 caso 5: no LLM, descript accepted, pm rejected', t5 && t5.examples.map((e) => `${e.schema}:${e.expected}`).join() === 'descript:accept,pm:reject', JSON.stringify(t5?.examples?.map((e) => e.schema)));
  const v5 = ruleTestVerdict(t5.examples, t5.runs, null, null, null, t5.coverage);
  check('2.3 caso 5 → Correct', v5.kind === 'correct', JSON.stringify(v5));
  check('2.3 caso 5: never there in comment, ddn, dml, pm', t5.presence.cannot.join() === 'comment,ddn,dml,pm');
  check(
    '2.3 description line ES',
    es('records.ruleTest.describe.presenceNever', { schemas: new Intl.ListFormat('es', { type: 'conjunction' }).format(t5.presence.cannot), target: '<dmaddres>' }) ===
      'En comment, ddn, dml y pm, <dmaddres> no puede existir: la regla rechaza siempre esos documentos.'
  );
  const qa = run(objrule('/*[not(//status/qa)]', '0', 'XML-R-2647'));
  check('2.3 02647 /*[not(//status/qa)] → same as caso 5', qa && ruleTestVerdict(qa.examples, qa.runs, null, null, null, qa.coverage).kind === 'correct');
  for (const path of ['/dmodule[not(idstatus/dmaddres)]', '/dmodule[not(//dmaddres)]']) {
    const r = run(objrule(path));
    const v = r && ruleTestVerdict(r.examples, r.runs, null, null, null, r.coverage);
    check(`2.3 ${path} → Already covered`, v?.kind === 'schema_covered', JSON.stringify(v));
    if (v?.kind === 'schema_covered') {
      check(`2.3 ${path} reason ES`, formatRuleTestReason(verdictToTestRecord(v).reason, es).includes('<dmaddres> es obligatorio en todo documento con raíz <dmodule>'), formatRuleTestReason(verdictToTestRecord(v).reason, es));
    }
  }
  check('2.3 /*[not(//status/actref)] → normal test', run(objrule('/*[not(//status/actref)]')) === null);
  check('2.3 /dmodule[not(//actref)] (02613) → normal test', run(objrule('/dmodule[not(//actref)]')) === null);
  check('2.3 /*[not(self::dmodule)] → not this test', run(objrule('/*[not(self::dmodule)]')) === null);
}

// ─── 2.4 Remates ──────────────────────────────────────────────────────────
{
  const issues = xpathIssues(invalidRuleXPaths(objrule('/*[ not(//dmaddres/issno)) ]')));
  check('2.4 a unbalanced parenthesis while typing', issues.length === 1 && formatSchemaIssue(issues[0], es).startsWith('Sobra un paréntesis de cierre.'), issues.map((i) => formatSchemaIssue(i, es)).join());
  check('2.4 b rejectedMore text', es('records.ruleTest.rejectedMore', { count: 3 }) === ' y 3 más');
  const d = describeRule(objrule('/*[not(//status/actref)]'), F, { parseXml });
  const text = ruleDescriptionText(d, es);
  check('2.4 c description with the whole path', text.includes('Todo documento, de cualquier tipo, debe contener algún <actref> dentro de <status>'), text);
  check('2.4 c EN', ruleDescriptionText(d, en).includes('must contain at least one <actref> inside <status>'), ruleDescriptionText(d, en));
  const d2 = ruleDescriptionText(describeRule(objrule('/dmodule[not(//actref)]'), F, { parseXml }), es);
  check('2.4 c /dmodule[not(//actref)] unchanged', d2.includes('Todo documento debe contener algún <actref> (se aplica a los documentos <dmodule>'), d2);
  // d: an accept example the rule rejects
  const run = runExample(objrule('/*[not(//status/actref)]'), F, { xml: minimal, structure: structureOf('descript'), schema: 'descript', expected: 'accept' }, { vocabulary, parseXml });
  check('2.4 d rejection names what is missing', run.rejection?.missing?.target === '<actref>' && run.rejection.missing.container === '<status>', JSON.stringify(run.rejection));
  check('2.4 d text ES', es('records.ruleTest.rejectedMissingInside', { target: '<actref>', container: '<status>' }) === 'Por qué la regla lo rechazó: el documento no contiene ningún <actref> dentro de <status>.');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
