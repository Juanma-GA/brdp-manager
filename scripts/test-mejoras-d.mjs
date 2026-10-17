// Mejoras D: the example is written where the whole rule path fits, the
// description never hides a condition, and "any <figure>" instead of "its
// <figure>" is warned about. Rules A and B verbatim (BRDP-EXT-02816 and
// BRDP-EXT-02815, S1000D 3.0.1), on the REAL 3.0.1 structures and graph.
//   node scripts/test-mejoras-d.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { materializeExample, runExample, ruleTestVerdict } from '../src/utils/ruleTest.js';
import { analyzeRule, describeRule, runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { formatRuleDescription, formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { placeExample, ruleTargets } from '../src/utils/ruleTestSkeleton.js';
import { applyRulePathFix, checkAncestorAbsolutePaths, checkRulePaths, formatAncestorProblem, formatPathFix } from '../src/validation/rulePathCheck.js';
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
const structureOf = (standard, schema) => STRUCTURES[`${standard}|${schema}`];
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const vocabulary301 = vocabOf('schema-vocabulary-3-0-1.json');
const S301 = 'S1000D 3.0.1';
const S42 = 'S1000D 4.2';

const RULE_A = '<objrule id="XML-R-2828"><objpath objappl="0">//figure//legend/deflist/def[not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)]</objpath><objuse>Prohibir &lt;def&gt; que no coincida con ningun @title de los elementos de tipo &lt;hotspot&gt; de su &lt;figure&gt;</objuse></objrule>';
const RULE_B = '<objrule id="XML-R-2826"><objpath objappl="0">//figure//legend/deflist/term[not(. = //figure//graphic//hotspot/@apsname)]</objpath><objuse>Prohibir &lt;term&gt; que no coincida con algun atributo @apsname de los elementos de tipo &lt;hotspot&gt; de su &lt;figure&gt;</objuse></objrule>';
const objrule = (path, flag = '0') => `<objrule id="R"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse></objrule>`;
const sor = (path, flag = '0') => `<structureObjectRule id="R"><objectPath allowedObjectFlag="${flag}">${path}</objectPath><objectUse>x</objectUse></structureObjectRule>`;

// GET /api/schema-cards and /structure, from the real fixture structures.
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

// ─── Part 1.1: the insertion point holds the outermost element ─────────────
{
  const descript = structureOf(S301, 'descript');
  const placed = placeExample(descript, ruleTargets(RULE_A), { withRoutes: true });
  check('A: insertion point <para0>, never <para> (where <figure> does not go)', placed.insertion === 'para0' && placed.path.join('/') === 'dmodule/content/descript/para0', `${placed.insertion} ${placed.path.join('/')}`);
  check('A: <figure> is allowed directly there', placed.allowedChildren.includes('figure'));
  check('A: the whole way of the path is given', JSON.stringify(placed.writePaths) === '[["para0","figure","legend","deflist","def"]]', JSON.stringify(placed.writePaths));
  check('A: routes to <graphic>/<hotspot> of the condition', placed.routes && placed.routes.steps.some((s) => s.parent === 'figure' && s.children.includes('graphic')) && placed.routes.steps.some((s) => s.parent === 'graphic' && s.children.includes('hotspot')), JSON.stringify(placed.routes));
  check('A: no entryMissing', !placed.entryMissing);

  const fetchers = fetchersFor(S301);
  const setup = await prepareRuleTestSetup({ ruleXml: RULE_A, standard: S301, schemaLocation: 'flat', ...fetchers });
  const rulePlacement = setup.promptPlacements.find((p) => p.role === 'rule');
  check('A: setup tests descript at <para0>', rulePlacement?.schema === 'descript' && rulePlacement.insertion === 'para0', JSON.stringify(setup.promptPlacements.map((p) => [p.schema, p.insertion])));
  check('A: reachable (no "not executable")', setup.unreachable === null, JSON.stringify(setup.unreachable));
  const prompt = buildRuleTestExamplesPrompt({
    brdp: { identifier: 'BRDP-EXT-02816', title: 'Def in legend', definition: 'x', proposal: 'No se admite ningún <def> que no coincida con ningun @title de los elementos de tipo <hotspot> de su <figure>.' },
    standard: S301, format: 'BREX-3.0.1', ruleXml: RULE_A, placements: setup.promptPlacements,
  });
  check('A: prompt places the content in <para0>', prompt.includes('your content goes directly inside <para0>'), prompt);
  check('A: prompt gives the whole path', prompt.includes("The rule's path, written from <para0>: para0/figure/legend/deflist/def."), prompt);

  const figure = (titles, defs) => `<figure><title>Pump</title><graphic boardno="ICN-1">${titles.map((t, i) => `<hotspot apsid="h${i}" apsname="${t}" title="${t}"/>`).join('')}</graphic><legend><deflist>${defs.map((d) => `<term>${d}</term><def>${d}</def>`).join('')}</deflist></legend></figure>`;
  const examples = [
    { label: 'defs match the hotspots', expected: 'accept', schema: 'descript', content: figure(['Pump', 'Filter'], ['Pump', 'Filter']) },
    { label: 'one def matches no hotspot', expected: 'reject', schema: 'descript', content: figure(['Pump'], ['Pump', 'Valve']) },
  ];
  const materialized = examples.map((ex) => materializeExample(ex, setup.setup, parseXml));
  const runs = materialized.map((ex) => runExample(RULE_A, 'BREX-3.0.1', ex, { vocabulary: vocabulary301, parseXml }));
  check('A: both examples run (valid in descript)', runs.every((r) => r.validation.runnable), JSON.stringify(runs.map((r) => r.validation)));
  check('A: accepted / rejected', runs.map((r) => r.result?.status).join() === 'accepted,rejected', JSON.stringify(runs.map((r) => r.result)));
  const verdict = ruleTestVerdict(materialized, runs, analyzeRule(RULE_A, 'BREX-3.0.1', { parseXml }));
  check('A: verdict correct (never no_runnable / not_executable)', verdict.kind === 'correct', JSON.stringify(verdict));

  // Unchanged: a single step, and a path from the root.
  check('//para keeps <para0> (as before)', placeExample(descript, ruleTargets(objrule('//para'))).insertion === 'para0');
  check('//emphasis keeps <para> (as before)', placeExample(descript, ruleTargets(objrule('//emphasis'))).insertion === 'para');
  const fromRoot = placeExample(descript, ruleTargets(objrule('/dmodule/content/descript/para0/para/randlist')));
  check('/dmodule/content/…/para/randlist keeps <para>, no extra path', fromRoot.insertion === 'para' && !fromRoot.writePaths, `${fromRoot.insertion} ${JSON.stringify(fromRoot.writePaths)}`);
  const deflistOnly = placeExample(descript, ruleTargets(objrule('//deflist/def')));
  check('//deflist/def keeps <para> (deflist fits there)', deflistOnly.insertion === 'para' && !deflistOnly.writePaths);
  // A union whose first steps differ: one point that holds both.
  const union = placeExample(descript, ruleTargets(objrule('//figure/legend/deflist/def | //randlist/item')), { withRoutes: true });
  check('union //figure/… | //randlist/item: one point holding both (<para0>)', union.insertion === 'para0' && union.allowedChildren.includes('figure'), union.insertion);
  // 4.2: //figure//legend/definitionList/… -- <figure> is not inside <para> either.
  const d42 = structureOf(S42, 'descript');
  const f42 = placeExample(d42, ruleTargets(sor('//figure/legend/definitionList/definitionListItem')));
  check('4.2 //figure/legend/…: a point that holds <figure>', d42.elements[f42.insertion].children.includes('figure') || f42.insertion === 'levelledPara', f42.insertion);
  // No point holds it in the schema → the caller is told, the next schema is
  // tried, and with none: not executable, before any LLM call.
  // (fake structures: <figure> without <legend>)
  const noLegend = (structure) => {
    const copy = JSON.parse(JSON.stringify(structure));
    copy.elements.figure.children = copy.elements.figure.children.filter((c) => c !== 'legend');
    return copy;
  };
  const fake = noLegend(descript);
  const missing = placeExample(fake, ruleTargets(RULE_A));
  check('no room: entryMissing names <figure> and <def>', JSON.stringify(missing.entryMissing) === '{"outer":["figure"],"checked":["def"]}', JSON.stringify(missing.entryMissing));
  const noRoom = await prepareRuleTestSetup({
    ruleXml: RULE_A, standard: S301, schemaLocation: 'flat',
    fetchSchemaCards: fetchers.fetchSchemaCards,
    fetchStructure: async (_std, schema) => ({ available: true, ...noLegend(structureOf(S301, schema)) }),
  });
  check('no room anywhere: not executable with the exact reason', noRoom.unreachable?.code === 'example_no_room', JSON.stringify(noRoom.unreachable));
  check('no room EN', formatRuleTestReason(noRoom.unreachable, en) === `no ${S301} schema has room for <figure> with <def> inside it.`, formatRuleTestReason(noRoom.unreachable, en));
  check('no room ES', formatRuleTestReason(noRoom.unreachable, es) === `en ningún esquema de ${S301} cabe <figure> con <def> dentro.`, formatRuleTestReason(noRoom.unreachable, es));
  // descript has no room, proced has: the next candidate is used.
  const nextSchema = await prepareRuleTestSetup({
    ruleXml: RULE_A, standard: S301, schemaLocation: 'flat',
    fetchSchemaCards: fetchers.fetchSchemaCards,
    fetchStructure: async (_std, schema) => ({ available: true, ...(schema === 'descript' ? fake : structureOf(S301, schema)) }),
  });
  const nextRule = nextSchema.promptPlacements.find((p) => p.role === 'rule');
  check('no room in descript: the next candidate schema is used', nextSchema.unreachable === null && nextRule && nextRule.schema !== 'descript' && !nextRule.entryMissing, JSON.stringify(nextSchema.promptPlacements.map((p) => [p.schema, p.insertion])));
}

// ─── Part 1.2: the description never hides the condition ──────────────────
{
  const lines = (rule, format, t) => formatRuleDescription(describeRule(rule, format, { parseXml }), t).lines;
  check('A EN: the literal condition', lines(RULE_A, 'BREX-3.0.1', en)[0] === '<def> matching the condition [not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)] must not appear (path //figure//legend/deflist/def[not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)]).', lines(RULE_A, 'BREX-3.0.1', en)[0]);
  check('A ES: the literal condition', lines(RULE_A, 'BREX-3.0.1', es)[0].startsWith('<def> que cumpla la condición [not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)] no puede aparecer'), lines(RULE_A, 'BREX-3.0.1', es)[0]);
  check('not(ancestor::X) ES', lines(sor('//commonInfo[not(ancestor::procedure)]'), 'BREX-4.2', es)[0].startsWith('<commonInfo> fuera de <procedure> no puede aparecer'));
  check('not(ancestor::X) EN', lines(sor('//commonInfo[not(ancestor::procedure)]'), 'BREX-4.2', en)[0].startsWith('<commonInfo> outside <procedure> must not appear'));
  check('ancestor::X ES', lines(sor('//commonInfo[ancestor::procedure]'), 'BREX-4.2', es)[0].startsWith('<commonInfo> dentro de <procedure> no puede aparecer'));
  check('parent::X EN', lines(sor('//title[parent::figure]'), 'BREX-4.2', en)[0].startsWith('<title> directly inside <figure> must not appear'));
  check('not(ancestor::X) plus another condition → literal, complete', lines(sor('//commonInfo[not(ancestor::procedure) and @id]'), 'BREX-4.2', es)[0].startsWith('<commonInfo> que cumpla la condición [not(ancestor::procedure) and @id] no puede aparecer'));
  check('flag 1 (mandatory) with a predicate', lines(sor('//proced/step1[title]', '1'), 'BREX-4.2', es)[0].startsWith('Cada <proced> debe contener <step1> que cumpla la condición [title]'), lines(sor('//proced/step1[title]', '1'), 'BREX-4.2', es)[0]);
  check('flag 2 with values on an owner with a predicate', lines(sor('//emphasis[ancestor::title]/@emphasisType', '2').replace('</objectUse>', '</objectUse><objectValue valueForm="single" valueAllowed="em01"/>'), 'BREX-4.2', en)[0].startsWith('@emphasisType of <emphasis> inside <title>, when it appears, can only take: em01'));
  check('objappl 1 3.0.1', lines(objrule('//figure[not(ancestor::para0)]', '1'), 'BREX-3.0.1', es)[0].includes('<figure> fuera de <para0>'), lines(objrule('//figure[not(ancestor::para0)]', '1'), 'BREX-3.0.1', es)[0]);
  // Unchanged: no predicate, and the predicates already explained.
  check('no predicate unchanged', lines(sor('//emphasis'), 'BREX-4.2', en)[0] === '<emphasis> must not appear (path //emphasis).');
  check('attribute predicate unchanged', lines(sor('//entry[@applicRefId]'), 'BREX-4.2', en)[0] === '<entry> with @applicRefId must not appear (path //entry[@applicRefId]).');
  check('/dmodule[not(//actref)] unchanged', lines(objrule('/dmodule[not(//actref)]'), 'BREX-3.0.1', en)[0].startsWith('Every document must contain at least one <actref>'));
  check('threshold unchanged', lines(sor('//proceduralStep[count(ancestor::proceduralStep) &gt; 5]'), 'BREX-4.2', en)[0].startsWith('<proceduralStep> must not be nested'));
}

// ─── Part 2: "any <figure>" instead of "its <figure>" ──────────────────────
{
  const g301 = schemaGraph(S301);
  const warn = (rule, format = 'BREX-3.0.1') => checkAncestorAbsolutePaths(rule, format, { parseXml });
  const b = warn(RULE_B);
  check('B: one warning', b.length === 1 && b[0].ancestor === 'figure' && b[0].looked === 'hotspot' && b[0].checked === 'term', JSON.stringify(b));
  check('B: ES text', formatAncestorProblem(b[0], es) === 'La condición mira los <hotspot> de cualquier <figure> del documento, no solo los del <figure> que contiene a <term>. Si la decisión habla de «su» <figure>, usa ancestor::figure.', formatAncestorProblem(b[0], es));
  check('B: EN text', formatAncestorProblem(b[0], en) === 'The condition looks at the <hotspot> of any <figure> in the document, not only those of the <figure> that contains <term>. If the decision speaks of «its» <figure>, use ancestor::figure.', formatAncestorProblem(b[0], en));
  check('B: fix button', formatPathFix(b[0].fix, es) === 'Cambiar //figure//graphic//hotspot/@apsname por ancestor::figure//graphic//hotspot/@apsname', formatPathFix(b[0].fix, es));
  const fixed = applyRulePathFix(RULE_B, b[0].fix);
  check('B: the fix gives ancestor::figure', fixed.changed && fixed.xml.includes('<objpath objappl="0">//figure//legend/deflist/term[not(. = ancestor::figure//graphic//hotspot/@apsname)]</objpath>'), fixed.xml);
  check('B: objuse untouched by the fix', fixed.xml.includes('de su &lt;figure&gt;</objuse>'));
  check('B fixed: no warning any more', warn(fixed.xml).length === 0);
  check('B: no impossible-path warning (the path exists)', checkRulePaths(RULE_B, 'BREX-3.0.1', g301, { parseXml }).problems.length === 0);
  // The two-figure document: before, only "Valve" is rejected; after the
  // fix, "Filter" too (its hotspot is in the OTHER figure).
  const twoFigures = `<dmodule><content><descript><para0>
<figure><title>One</title><graphic boardno="ICN-1"><hotspot apsid="h1" apsname="Pump"/></graphic><legend><deflist><term>Pump</term><def>a</def><term>Filter</term><def>b</def></deflist></legend></figure>
<figure><title>Two</title><graphic boardno="ICN-2"><hotspot apsid="h2" apsname="Filter"/></graphic><legend><deflist><term>Valve</term><def>c</def></deflist></legend></figure>
</para0></descript></content></dmodule>`;
  const rejected = (rule) => {
    const r = runRuleOnFragment(rule, 'BREX-3.0.1', twoFigures, 'descript', { parseXml });
    return r.violations.flatMap((v) => v.nodePaths).length;
  };
  check('two figures, before: rejects 1 (Valve)', rejected(RULE_B) === 1, String(rejected(RULE_B)));
  check('two figures, after the fix: rejects 2 (Filter and Valve)', rejected(fixed.xml) === 2, String(rejected(fixed.xml)));
  // No warning.
  check('A (already ancestor::figure): no warning', warn(RULE_A).length === 0);
  check('/dmodule[not(//actref)]: no warning (root)', warn(objrule('/dmodule[not(//actref)]')).length === 0);
  check('//figure[not(@id = //figure/@id)]: no warning (the checked element itself)', warn(objrule('//figure[not(@id = //figure/@id)]')).length === 0);
  check('//table//entry[@applicRefId = //applic/@id]: no warning (applic is no step of the path)', warn(sor('//table//entry[@applicRefId = //applic/@id]'), 'BREX-4.2').length === 0);
  check('//dmodule//para[. = //dmodule//x]: no warning (document root)', warn(sor('//dmodule//para[. = //dmodule//x]'), 'BREX-4.2').length === 0);
  check('Schematron DITA: never checked', checkAncestorAbsolutePaths('<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"><sch:rule context="fig//dt"><sch:assert test=". = //fig//area/@title">x</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA', { parseXml }).length === 0);
  // Warning with a predicate on X: the button keeps it.
  const own = warn(objrule("//figure//term[. = //figure[@id='f1']//hotspot/@apsname]"));
  check("//figure[@id='f1'] in the condition: warned", own.length === 1 && own[0].fix?.to === "ancestor::figure[@id='f1']//hotspot/@apsname", JSON.stringify(own));
  const ownFixed = applyRulePathFix(objrule("//figure//term[. = //figure[@id='f1']//hotspot/@apsname]"), own[0].fix);
  check("…its button gives ancestor::figure[@id='f1']", ownFixed.xml.includes("//figure//term[. = ancestor::figure[@id='f1']//hotspot/@apsname]"), ownFixed.xml);
  // Other forms: a warning without a button.
  const deep = warn(objrule('//figure//term[. = /dmodule//figure//hotspot/@apsname]'));
  check('/dmodule//figure//… : warned, no button', deep.length === 1 && deep[0].fix === null, JSON.stringify(deep));
  const mid = warn(objrule('//figure//term[. = //graphic/figure/hotspot/@apsname]'));
  check('X mid-path: warned, no button', mid.length === 1 && mid[0].fix === null, JSON.stringify(mid));
  // With an impossible path too: both warnings, each fixes its own.
  const both2 = '<objrule id="R"><objpath objappl="0">//reqpers/perscat/trade[not(. = //reqpers//x)]</objpath><objuse>x</objuse></objrule>';
  const anc2 = warn(both2);
  const imp2 = checkRulePaths(both2, 'BREX-3.0.1', g301, { parseXml }).problems.filter((p) => !p.inPredicate);
  check('impossible path + any-ancestor: both warnings', anc2.length === 1 && imp2.length === 1 && imp2[0].fix, JSON.stringify({ anc2, imp2 }));
  const afterOne = applyRulePathFix(both2, anc2[0].fix).xml;
  const afterTwo = applyRulePathFix(afterOne, imp2[0].fix).xml;
  check('…each button fixes its own', afterTwo.includes('//reqpers/trade[not(. = ancestor::reqpers//x)]'), afterTwo);
  // No graph (S1000D 5.0, a standard with none): Part 2 still works.
  check('no graph needed (4.2 form of B)', warn(sor('//figure//legend/definitionList/definitionListItem/listItemTerm[not(. = //figure//graphic//hotspot/@applicationStructureName)]'), 'BREX-4.2').length === 1);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
