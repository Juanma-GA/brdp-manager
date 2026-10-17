// Test de reglas: el caso "dentro/fuera de X" no puede depender solo de los
// metadatos del documento, y un ejemplo sigue en su lado después de
// cualquier corrección. Real case (S1000D 3.0.1, general rule):
// //descendant-or-self::seqlist[not(ancestor-or-self::descript)] -- in
// descript a <seqlist> outside <descript> is only possible inside idstatus
// (…/copyright/para): the test used descript alone and Mistral put
// <seqlist> directly in <descript> (invalid, "inconclusive"); in a second
// run the "outside" example was moved into <descript>/<para> and the test
// said "failed". On the REAL structures of the fixture.
//   node scripts/test-relation-sides.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { materializeExample, runExample, ruleTestVerdict } from '../src/utils/ruleTest.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { formatRuleTestReason, verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
import { generateRuleTestExamples, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { placeExample, relationCases, ruleTargets } from '../src/utils/ruleTestSkeleton.js';
import { wrapRuleInSchemaContexts } from '../src/utils/ruleSchemaContext.js';

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
const structureOf = (standard, schema) => STRUCTURES[`${standard}|${schema}`];
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const S301 = 'S1000D 3.0.1';
const S42 = 'S1000D 4.2';
const vocabulary301 = vocabOf('schema-vocabulary-3-0-1.json');
const fetchersFor = (standard) => {
  const docs = Object.keys(STRUCTURES).filter((k) => k.startsWith(`${standard}|`)).map((k) => k.split('|')[1]).sort();
  return {
    fetchSchemaCards: async (_std, names) => ({
      cards: Object.fromEntries(
        names
          .map((n) => [n, docs.filter((d) => structureOf(standard, d).elements[n])])
          .filter(([, schemas]) => schemas.length)
          .map(([n, schemas]) => [n, { variants: [{ schemas, attributes: [], children: [], resolved: true }], parents: [] }])
      ),
      document_schemas: docs,
    }),
    fetchStructure: async (_std, schema) => {
      const st = structureOf(standard, schema);
      return st ? { available: true, ...st } : { available: false };
    },
  };
};
const objrule = (path, flag = '0') => `<objrule id="R"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse></objrule>`;
const brdp = { identifier: 'BRDP-EXT-09001', title: 'Sequential lists', definition: 'Decide where sequential lists are used.', proposal: 'Sequential lists are only used in descriptive data modules.' };
const SEQ = objrule('//descendant-or-self::seqlist[not(ancestor-or-self::descript)]');
const seqlist = '<seqlist><item><para>First.</para></item><item><para>Second.</para></item></seqlist>';
const f301 = fetchersFor(S301);
const prepare = (ruleXml, standard = S301, fetchers = f301, format = 'BREX-3.0.1') =>
  prepareRuleTestSetup({ ruleXml, standard, schemaLocation: 'flat', format, ...fetchers });
const promptOf = (ruleXml, prep, standard = S301, format = 'BREX-3.0.1') =>
  buildRuleTestExamplesPrompt({ brdp, standard, format, ruleXml, contextSchemas: prep.contextSchemas, placements: prep.promptPlacements });

// ─── Part 1: a case only the identification and status section allows ─────
{
  const r = { element: 'seqlist', axis: 'ancestor', ancestor: 'descript' };
  check('relationCases 3.0.1 descript: outside only in the section', JSON.stringify(relationCases(structureOf(S301, 'descript'), r)) === '{"inside":true,"outside":false,"metadataOnly":["outside"]}', JSON.stringify(relationCases(structureOf(S301, 'descript'), r)));
  check('relationCases 3.0.1 proced: outside in the content', JSON.stringify(relationCases(structureOf(S301, 'proced'), r)) === '{"inside":false,"outside":true}');
  check('relationCases without a section: unchanged (DITA topic)', !('metadataOnly' in relationCases(structureOf('DITA 1.3 Xpath2.0', 'topic'), { element: 'ul', axis: 'ancestor', ancestor: 'section' })));

  const prep = await prepare(SEQ);
  const pl = prep.promptPlacements;
  check('seqlist: outside (selected) in proced, inside in descript', JSON.stringify(pl.map((p) => [p.schema, p.relation?.inside, p.relation?.selected])) === '[["proced",false,true],["descript",true,false]]', JSON.stringify(pl.map((p) => [p.schema, p.relation])));
  check('seqlist: the way of each case', pl[0]?.relation?.way?.join('/') === 'dmodule/content/proced/mainfunc/step1/para/seqlist' && pl[1]?.relation?.way?.join('/') === 'dmodule/content/descript/para0/para/seqlist', JSON.stringify(pl.map((p) => p.relation?.way)));
  const prompt = promptOf(SEQ, prep);
  check('seqlist: the prompt never says "every example uses the descript schema"', !prompt.includes('every example uses the "descript" schema'), prompt.slice(0, 2000));
  check('seqlist: the prompt gives both schemas and ways',
    prompt.includes('- "proced": examples where <seqlist> is NOT inside <descript>; way: dmodule/content/proced/mainfunc/step1/para/seqlist')
    && prompt.includes('- "descript": examples where <seqlist> is inside <descript>; way: dmodule/content/descript/para0/para/seqlist')
    && !prompt.includes('by any other valid way'));
  const ex = [
    { label: 'seqlist in a procedure', expected: 'reject', schema: 'proced', content: seqlist },
    { label: 'seqlist in a description', expected: 'accept', schema: 'descript', content: seqlist },
  ];
  const materialized = ex.map((e) => materializeExample(e, prep.setup, parseXml));
  const runs = materialized.map((e) => runExample(SEQ, 'BREX-3.0.1', e, { vocabulary: vocabulary301, parseXml }));
  check('seqlist: both examples valid', runs.every((x) => x.validation.runnable), JSON.stringify(runs.map((x) => x.validation.structure)));
  check('seqlist: selected (rejected) in proced, accepted in descript, verdict correct',
    runs.map((x) => x.result?.status).join() === 'rejected,accepted' && ruleTestVerdict(materialized, runs, analyzeRule(SEQ, 'BREX-3.0.1', { parseXml })).kind === 'correct',
    JSON.stringify(runs.map((x) => x.result?.status)));

  // Reversed: [ancestor::descript] selects the one inside.
  const IN = objrule('//descendant-or-self::seqlist[ancestor-or-self::descript]');
  const pIn = await prepare(IN);
  check('[ancestor::descript]: selected inside in descript, the other in proced', JSON.stringify(pIn.promptPlacements.map((p) => [p.schema, p.relation?.inside, p.relation?.selected])) === '[["descript",true,true],["proced",false,false]]', JSON.stringify(pIn.promptPlacements.map((p) => p.schema)));

  // Both cases in the content of the test schema: one schema, as before.
  const both = objrule('//para[not(ancestor::table)]');
  const pBoth = await prepare(both);
  check('both cases in the content: one schema, no split', pBoth.promptPlacements.length === 1 && !pBoth.promptPlacements[0].relation, JSON.stringify(pBoth.promptPlacements.map((p) => p.schema)));
  const bothPrompt = promptOf(both, pBoth);
  check('both cases in the content: the way outside is given, never "any other valid way"', /and <para> outside by exactly (this way|one of these ways)/.test(bothPrompt) && !bothPrompt.includes('by any other valid way'), bothPrompt.split('\n').filter((l) => l.includes('<para>')).join('\n'));

  // A schema-context rule: its schema, no split.
  const scoped = wrapRuleInSchemaContexts(SEQ, 'BREX-3.0.1', S301, ['descript']);
  const pScoped = await prepare(scoped);
  check('context rule: its schema, no split', pScoped.promptPlacements.filter((p) => p.role === 'rule').map((p) => p.schema).join() === 'descript' && pScoped.promptPlacements.every((p) => !p.relation), JSON.stringify(pScoped.promptPlacements.map((p) => [p.schema, p.role])));

  // Only the section allows the case in every schema (S1000D 4.2,
  // BRDP-EXT-00134 in comrep: <expression> outside <referencedApplicGroup>
  // only in dmStatus/applic): as before, one schema, the root as insertion
  // point -- and the way through the section in the prompt.
  const f42 = fetchersFor(S42);
  const EXPR = '<structureObjectRule><objectPath allowedObjectFlag="0">//expression[not(ancestor::referencedApplicGroup)]</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const comrep = structureOf(S42, 'comrep');
  check('comrep: <expression> outside only in the section', JSON.stringify(relationCases(comrep, { element: 'expression', axis: 'ancestor', ancestor: 'referencedApplicGroup' })) === '{"inside":true,"outside":false,"metadataOnly":["outside"]}');
  const placed = placeExample(comrep, ruleTargets(EXPR), { withRoutes: true });
  check('comrep: insertion at the root, as before', placed.insertion === 'dmodule', placed.insertion);
  const way = placed.relationWays?.[0];
  check('comrep: both ways, the outside one through the section', way?.way?.join('/') === 'dmodule/content/referencedApplicGroup/applic/expression' && way?.outside?.join('/') === 'dmodule/identAndStatusSection/dmStatus/applic/expression' && JSON.stringify(way?.section) === '["outside"]', JSON.stringify(way));
  const pExpr = await prepare(EXPR, S42, f42, 'BREX-4.2');
  check('expression: no other schema allows it in the content -- no split', pExpr.promptPlacements.every((p) => !p.relation), JSON.stringify(pExpr.promptPlacements.map((p) => [p.schema, p.relation])));
}

// ─── Part 3: an example stays on its side after any fix ───────────────────
// (a) The second real run: the old placement (descript only, content at
// <dmodule>), the "outside" example written directly in <content>
// (invalid) and the correction writing it in <descript>/<para> -- inside.
// The correction round passes the side of the first example
// (relationIntended), as generateRuleTestExamples does.
{
  const descript = structureOf(S301, 'descript');
  const setup = { standard: S301, schemaLocation: 'flat', placements: { descript: { structure: descript, placement: placeExample(descript, ruleTargets(SEQ), { withRoutes: true }) } }, keepBrexReference: false };
  check('(a) setup: content at <dmodule>, the relation known', setup.placements.descript.placement.insertion === 'dmodule' && setup.placements.descript.placement.relationWays?.length === 1, JSON.stringify(setup.placements.descript.placement.path));
  const first = materializeExample({ label: 'seqlist outside descript', expected: 'reject', schema: 'descript', content: `<content>${seqlist}</content>` }, setup, parseXml);
  check('(a) the first example is outside <descript>', first.relationSides?.['seqlist|ancestor|descript'] === 'outside' && !first.sideChanged, JSON.stringify(first.relationSides));
  const inside = `<content><descript><para0><title>T</title><para>${seqlist}</para></para0></descript></content>`;
  const materialized = [
    materializeExample({ label: 'seqlist outside descript', expected: 'reject', schema: 'descript', content: inside, relationIntended: first.relationSides }, setup, parseXml),
    materializeExample({ label: 'seqlist inside descript', expected: 'accept', schema: 'descript', content: inside }, setup, parseXml),
  ];
  const runs = materialized.map((e) => runExample(SEQ, 'BREX-3.0.1', e, { vocabulary: vocabulary301, parseXml }));
  check('(a) both corrected examples valid, the rule accepts both', runs.every((r) => r.result?.status === 'accepted'), JSON.stringify(runs.map((r) => [r.result?.status, r.validation.structure])));
  check('(a) said: the correction moved it to the other side', JSON.stringify(materialized[0].sideChanged) === '{"element":"seqlist","ancestor":"descript","axis":"ancestor","intended":"outside","by":"correction"}', JSON.stringify(materialized[0].sideChanged));
  check('(a) the inside example is not marked', !materialized[1].sideChanged && materialized[1].relationSides?.['seqlist|ancestor|descript'] === 'inside', JSON.stringify(materialized[1].relationSides));
  const verdict = ruleTestVerdict(materialized, runs, analyzeRule(SEQ, 'BREX-3.0.1', { parseXml }));
  check('(a) verdict inconclusive (relation_side), never failed', verdict.kind === 'inconclusive' && verdict.why === 'relation_side' && verdict.side === 'outside', JSON.stringify(verdict));
  check('(a) record', JSON.stringify(verdictToTestRecord(verdict)) === '{"result":"inconclusive","reason":{"code":"test_relation_side","params":{"element":"seqlist","ancestor":"descript","axis":"ancestor","side":"outside"}}}', JSON.stringify(verdictToTestRecord(verdict)));
  check('(a) reason EN', formatRuleTestReason(verdictToTestRecord(verdict).reason, en) === 'a fix moved the example with <seqlist> outside <descript> to the other side, and no other valid example tests that case', formatRuleTestReason(verdictToTestRecord(verdict).reason, en));
  check('(a) reason ES', formatRuleTestReason(verdictToTestRecord(verdict).reason, es) === 'una corrección cambió de lado el ejemplo con <seqlist> fuera de <descript> y no queda otro ejemplo válido de ese caso');
  check('(a) example note ES', es('records.ruleTest.sideChanged', { element: 'seqlist', now: es('records.ruleTest.relationSides.inside', { ancestor: 'descript' }), side: es('records.ruleTest.relationSides.outside', { ancestor: 'descript' }) }) === 'La corrección dejó <seqlist> dentro de <descript>: este ejemplo ya no prueba el caso fuera de <descript>, así que no cuenta para el resultado.');
  // Another valid example on that side: only the moved one does not count
  // -- the verdict is the one of the others alone.
  const outsideToo = { ...materialized[1], label: 'another outside example', relationSides: { 'seqlist|ancestor|descript': 'outside' } };
  const analysis = analyzeRule(SEQ, 'BREX-3.0.1', { parseXml });
  const v2 = ruleTestVerdict([...materialized, outsideToo], [...runs, runs[1]], analysis);
  const vOthers = ruleTestVerdict([materialized[1], outsideToo], [runs[1], runs[1]], analysis);
  check('(a) another example of that side: the verdict of the others alone', v2.why !== 'relation_side' && JSON.stringify(v2) === JSON.stringify(vOthers), JSON.stringify([v2, vOthers]));
  // A hand edit is the person's example: its side is its own.
  const { editExample } = await import('../src/utils/ruleTest.js');
  const edited = editExample(materialized[0], inside, undefined, setup, parseXml);
  check('(a) a hand edit is not marked', !edited.sideChanged, JSON.stringify(edited.sideChanged));
}

// (c) The application's own fix: an element written where the schema does
// not allow it, moved down the only way -- into the other element (a
// minimal structure: <item> only goes inside <box>).
{
  const el = (children, attributes = []) => ({ children, attributes });
  const model = (order) => ({ attributes: [], enums: {}, max: {}, order, required: [], text: false });
  const structure = {
    elements: { doc: el(['body']), body: el(['box', 'note']), box: el(['item']), item: el([]), note: el([]) },
    models: { doc: model(['body']), body: model(['box', 'note']), box: model(['item']), item: { ...model([]), text: true }, note: { ...model([]), text: true } },
    enum_lists: {},
    nesting: {},
    skeleton: { path: ['doc', 'body'], insertion: 'body', metadata: null },
  };
  const rule = '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"><sch:rule context="item[not(ancestor::box)]"><sch:assert test="false()">x</sch:assert></sch:rule></sch:pattern>';
  const placement = placeExample(structure, ruleTargets(rule));
  placement.relation = { element: 'item', ancestor: 'box', axis: 'ancestor', negated: true, inside: false, selected: true, way: null };
  const setup = { standard: 'DITA 1.3 Xpath2.0', schemaLocation: 'flat', placements: { doc: { structure, placement } } };
  const m = materializeExample({ label: 'item outside box', expected: 'reject', schema: 'doc', content: '<item>x</item>' }, setup, parseXml);
  check('(c) moved into <box> by the application', (m.relocated || []).length === 1 && /<box><item>x<\/item><\/box>/.test(m.xml), `${JSON.stringify(m.relocated)} ${m.xml}`);
  check('(c) said: moved to the other side by the application', m.sideChanged?.by === 'application' && m.sideChanged.intended === 'outside', JSON.stringify(m.sideChanged));
}

// (b) The correction round's fix: the "outside" example in proced is
// invalid; the correction writes it in descript -- inside <descript>.
{
  const answers = [
    JSON.stringify({ examples: [
      { label: 'seqlist in a procedure', expected: 'reject', schema: 'proced', content: '<seqlist><para>Not an item.</para></seqlist>' },
      { label: 'seqlist in a description', expected: 'accept', schema: 'descript', content: seqlist },
    ] }),
    JSON.stringify({ examples: [
      { label: 'seqlist in a procedure', expected: 'reject', schema: 'descript', content: seqlist },
      { label: 'seqlist in a description', expected: 'accept', schema: 'descript', content: seqlist },
    ] }),
  ];
  let call = 0;
  const g = await generateRuleTestExamples({
    ruleXml: SEQ, format: 'BREX-3.0.1', standard: S301, schemaLocation: 'flat', brdp, vocabulary: vocabulary301, parseXml,
    ask: async () => answers[call++], ...f301,
  });
  check('(b) two calls: examples and correction', call === 2 && g.status === 'ready', JSON.stringify([call, g.status, g.error]));
  check('(b) the corrected example says it changed side', g.examples?.[0]?.sideChanged?.by === 'correction' && g.examples[0].sideChanged.intended === 'outside', JSON.stringify(g.examples?.[0]?.sideChanged));
  const verdict = ruleTestVerdict(g.examples, g.runs, analyzeRule(SEQ, 'BREX-3.0.1', { parseXml }));
  check('(b) verdict inconclusive (relation_side), never failed', verdict.kind === 'inconclusive' && verdict.why === 'relation_side', JSON.stringify(verdict));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
