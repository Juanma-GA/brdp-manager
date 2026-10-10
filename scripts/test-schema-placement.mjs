// Ruta del esquema para las reglas sobre la sección de identificación y
// estado -- plain-Node tests (no test runner in this repo), on the REAL
// structures the backend serves (scripts/rule-test-fixtures/structures.json,
// dumped by backend/scripts/dump_rule_test_structures.py, with each
// element's content model) and the REAL XSDs (sources/SchemasS1000D, checked
// with xmllint-wasm).
//
//   node scripts/test-schema-placement.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { validateXML } from 'xmllint-wasm';
import { chainNode, minimalNode, relocateMisplacedElements, renderNode, sectionRoutes, simplePaths } from '../src/utils/schemaPlacement.js';
import { metadataXml, placeExample, ruleTargets } from '../src/utils/ruleTestSkeleton.js';
import { exampleFailures, generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { materializeExample, runExample, ruleTestVerdict } from '../src/utils/ruleTest.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import i18n from '../src/i18n/index.js';

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
  const doc = new DOMParser({
    onError: (level, msg) => {
      throw new Error(msg);
    },
  }).parseFromString(text, 'text/xml');
  return doc;
}

const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (standard, schema) => STRUCTURES[`${standard}|${schema}`];
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const VOCAB = { 'S1000D 4.2': vocabOf('schema-vocabulary-4-2.json'), 'S1000D 4.1': vocabOf('schema-vocabulary-4-1.json'), 'S1000D 3.0.1': vocabOf('schema-vocabulary-3-0-1.json') };
const ISSUE_DIR = { 'S1000D 4.2': '4.2', 'S1000D 4.1': '4.1', 'S1000D 3.0.1': '3.0.1' };
const XSD_CACHE = {};
function xsdFiles(standard) {
  if (!XSD_CACHE[standard]) {
    const dir = new URL(`../sources/SchemasS1000D/${ISSUE_DIR[standard]}/`, import.meta.url);
    XSD_CACHE[standard] = fs.readdirSync(dir).filter((f) => f.endsWith('.xsd')).map((f) => ({ fileName: f, contents: fs.readFileSync(new URL(f, dir), 'utf8') }));
  }
  return XSD_CACHE[standard];
}
// XSD errors inside the identification and status section of an assembled
// document (the skeleton's body of some schemas -- an empty pmEntry -- is not
// what these tests are about).
async function sectionXsdErrors(standard, schema, xml) {
  const files = xsdFiles(standard);
  const main = files.find((f) => f.fileName === `${schema}.xsd`);
  const text = xml.replace(/ xsi:noNamespaceSchemaLocation="[^"]*"/, '').replace(/ xmlns:xsi="[^"]*"/, '');
  const lines = text.split('\n');
  const open = lines.findIndex((l) => /<(identAndStatusSection|idstatus)\b/.test(l)) + 1;
  const close = lines.findIndex((l) => /<\/(identAndStatusSection|idstatus)>/.test(l)) + 1;
  const result = await validateXML({ xml: { fileName: 'doc.xml', contents: text }, schema: main, preload: files.filter((f) => f !== main) });
  return result.errors
    .map((e) => e.rawMessage || e.message)
    .filter((m) => {
      const line = Number(/doc\.xml:(\d+)/.exec(m)?.[1]);
      return line >= open && line <= close;
    });
}

const S42 = 'S1000D 4.2';
const S41 = 'S1000D 4.1';
const S301 = 'S1000D 3.0.1';
// BRDP-S1-00065 (Lufthansa): the copyright notice. //copyright, with a value
// check so the wrong year is rejected.
const R65 = `<structureObjectRule id="BRDP-S1-00065"><objectPath allowedObjectFlag="0">//copyright[not(contains(., 'Copyright © 2024 by Lufthansa Technik AG'))]</objectPath><objectUse>BRDP-S1-00065. The copyright notice must be the Lufthansa Technik AG one of 2024.</objectUse></structureObjectRule>`;
const R65_FULL = `<structureObjectRule id="BRDP-S1-00065"><objectPath allowedObjectFlag="0">//dmStatus/dataRestrictions/restrictionInfo/copyright[not(contains(., 'Copyright © 2024 by Lufthansa Technik AG'))]</objectPath><objectUse>BRDP-S1-00065.</objectUse></structureObjectRule>`;
const R301 = `<objrule><objpath objappl="0">//copyright[not(contains(., 'Copyright © 2024 by Lufthansa Technik AG'))]</objpath><objuse>BRDP-S1-00065.</objuse></objrule>`;
const NOTICE = 'Copyright © 2024 by Lufthansa Technik AG.';
const WRONG_YEAR = 'Copyright © 2023 by Lufthansa Technik AG.';

// The minimal section with `extra` right after <security> (where an LLM put
// the copyright in the real run).
function sectionWith(standard, schema, extra) {
  const tree = structureOf(standard, schema).skeleton.metadata.tree;
  return metadataXml(tree).xml.replace(/(<security\b[^>]*\/>)/, `$1${extra}`);
}
const copyrightOf = (standard, text) => (standard === S301 ? `<copyright><para>${text}</para></copyright>` : `<copyright><copyrightPara>${text}</copyrightPara></copyright>`);

// ─── Part 1: the way from the section, per issue ────────────────────────────
{
  const expected = {
    [`${S42}|descript`]: { path: 'dmStatus/dataRestrictions/restrictionInfo/copyright', after: 'security', minimal: ['<restrictionInstructions>', '<dataDistribution>…</dataDistribution>', '<copyrightPara>…</copyrightPara>'] },
    [`${S41}|descript`]: { path: 'dmStatus/dataRestrictions/restrictionInfo/copyright', after: 'security', minimal: ['<restrictionInstructions>', '<dataDistribution>…</dataDistribution>', '<copyrightPara>…</copyrightPara>'] },
    // 3.0.1: <copyright> is somewhere else -- status/datarest/inform, with
    // the required instruct/distrib.
    [`${S301}|descript`]: { path: 'status/datarest/inform/copyright', after: 'security', minimal: ['<instruct>', '<distrib>…</distrib>', '<para>…</para>'] },
    // A publication module works the same, from its pmStatus.
    [`${S42}|pm`]: { path: 'pmStatus/dataRestrictions/restrictionInfo/copyright', after: 'security', minimal: ['<restrictionInstructions>', '<dataDistribution>…</dataDistribution>'] },
    [`${S301}|pm`]: { path: 'pmstatus/datarest/inform/copyright', after: 'security', minimal: ['<instruct>', '<distrib>…</distrib>'] },
  };
  for (const [key, want] of Object.entries(expected)) {
    const [standard, schema] = key.split('|');
    const rule = standard === S301 ? R301 : R65;
    const placement = placeExample(structureOf(standard, schema), ruleTargets(rule));
    const routes = placement.metadata?.routes || [];
    check(`${key}: the rule looks at the section`, placement.metadata?.insertion === true);
    check(`${key}: one way, the right one`, routes.length === 1 && !routes[0].several && routes[0].paths.length === 1 && routes[0].paths[0].join('/') === want.path, JSON.stringify(routes));
    check(`${key}: its first container goes right after <${want.after}>`, routes[0]?.position?.after === want.after, JSON.stringify(routes[0]?.position));
    check(`${key}: the minimum has its required children`, want.minimal.every((m) => routes[0]?.minimal?.includes(m)), routes[0]?.minimal);
  }
  // The minimum is valid against the real XSD: the minimal section with the
  // route's minimum (text filled) right after <security>.
  for (const [standard, schema] of [[S42, 'descript'], [S41, 'descript'], [S301, 'descript'], [S42, 'pm'], [S301, 'pm']]) {
    const rule = standard === S301 ? R301 : R65;
    const setup = setupFor(standard, rule, schema);
    const minimal = setup.placements[schema].placement.metadata.routes[0].minimal.replace(/…/g, 'x').replace(/\n\s*/g, '');
    const ex = materializeExample({ label: 'm', expected: 'accept', schema, content: '', metadata: sectionWith(standard, schema, minimal) }, setup, parseXml);
    check(`${standard} ${schema}: the route's minimum is valid against the XSD`, ex.relocated === undefined, JSON.stringify(ex.relocated));
    const errors = await sectionXsdErrors(standard, schema, ex.xml);
    check(`${standard} ${schema}: XSD, no error in the section`, errors.length === 0, errors.join(' | '));
  }
}

// The prompt: the way, the position and the minimum.
{
  const placement = placeExample(structureOf(S42, 'descript'), ruleTargets(R65));
  const prompt = buildRuleTestExamplesPrompt({ brdp: { identifier: 'BRDP-S1-00065', title: 'Use of the element <copyright>', definition: 'd', proposal: 'p' }, standard: S42, format: 'BREX-4.2', ruleXml: R65, placements: [{ schema: 'descript', role: 'rule', ...placement }] });
  check('prompt: says <copyright> is not directly inside the section', prompt.includes('<copyright> is not directly inside any element of that section.'));
  check('prompt: the way down', prompt.includes('    dmStatus/dataRestrictions/restrictionInfo/copyright'));
  check('prompt: where the first container goes', prompt.includes('<dataRestrictions> goes inside <dmStatus>, right after <security>,'));
  check('prompt: the minimum with its required children', prompt.includes('      <restrictionInstructions>\n        <dataDistribution>…</dataDistribution>\n      </restrictionInstructions>'));
}

// The rule written with the whole way: the same way (through its own steps).
{
  const placement = placeExample(structureOf(S42, 'descript'), ruleTargets(R65_FULL));
  const routes = placement.metadata.routes || [];
  check('full path: one route, to <copyright>, through the rule\'s steps', routes.length === 1 && routes[0].paths[0].join('/') === 'dmStatus/dataRestrictions/restrictionInfo/copyright', JSON.stringify(routes));
}

// A rule on a metadatum directly there: nothing -- the prompt does not change.
{
  const R = '<structureObjectRule><objectPath allowedObjectFlag="2">//dmStatus/security/@securityClassification</objectPath><objectUse>x</objectUse><objectValue valueForm="single" valueAllowed="01"/></structureObjectRule>';
  const placement = placeExample(structureOf(S42, 'descript'), ruleTargets(R));
  check('direct metadatum: no route', placement.metadata.insertion === true && placement.metadata.routes === undefined, JSON.stringify(placement.metadata.routes));
  const withModels = buildRuleTestExamplesPrompt({ brdp: { identifier: 'X', title: 't', definition: 'd', proposal: 'p' }, standard: S42, format: 'BREX-4.2', ruleXml: R, placements: [{ schema: 'descript', role: 'rule', ...placement }] });
  const noModels = { ...structureOf(S42, 'descript'), models: undefined };
  const without = buildRuleTestExamplesPrompt({ brdp: { identifier: 'X', title: 't', definition: 'd', proposal: 'p' }, standard: S42, format: 'BREX-4.2', ruleXml: R, placements: [{ schema: 'descript', role: 'rule', ...placeExample(noModels, ruleTargets(R)) }] });
  check('direct metadatum: prompt identical to the one without content models', withModels === without);
  check('direct metadatum: prompt says nothing about a way down', !withModels.includes('is not directly inside'));
}

// Several ways: all of them in the prompt (at most 3), no minimum, and Part 2
// does not move anything.
{
  const R = '<structureObjectRule><objectPath allowedObjectFlag="0">//dmStatus//externalPubRef</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const placement = placeExample(structureOf(S42, 'descript'), ruleTargets(R));
  const routes = placement.metadata.routes || [];
  check('several ways: one route marked several, at most 3 ways', routes.length === 1 && routes[0].several && routes[0].paths.length === 3 && routes[0].minimal === null && routes[0].position === null, JSON.stringify(routes));
  check('several ways: the shortest first', routes[0].paths[0].join('/') === 'dmStatus/functionalItemRef/refs/externalPubRef', JSON.stringify(routes[0].paths));
  const prompt = buildRuleTestExamplesPrompt({ brdp: { identifier: 'X', title: 't', definition: 'd', proposal: 'p' }, standard: S42, format: 'BREX-4.2', ruleXml: R, placements: [{ schema: 'descript', role: 'rule', ...placement }] });
  check('several ways: the prompt gives them all', prompt.includes('Valid ways\n  down in this schema (use one of them):') && routes[0].paths.every((p) => prompt.includes(`    ${p.join('/')}`)));
  const misplaced = sectionWith(S42, 'descript', '<externalPubRef><externalPubRefIdent><externalPubCode>X</externalPubCode></externalPubRefIdent></externalPubRef>');
  const moved = relocateMisplacedElements(misplaced, structureOf(S42, 'descript'), 'dmodule');
  check('several ways: Part 2 leaves the example as it is', moved.moved.length === 0 && moved.text === misplaced);
}

// ─── Part 2: moving a misplaced element down the only way ──────────────────
function setupFor(standard, ruleXml, schema) {
  const structure = structureOf(standard, schema);
  return { standard, schemaLocation: 'flat', placements: { [schema]: { structure, placement: placeExample(structure, ruleTargets(ruleXml)) } } };
}
{
  for (const [standard, schema, parent] of [[S42, 'descript', 'dmStatus'], [S41, 'descript', 'dmStatus'], [S301, 'descript', 'status'], [S42, 'pm', 'pmStatus']]) {
    const rule = standard === S301 ? R301 : R65;
    const setup = setupFor(standard, rule, schema);
    const format = standard === S301 ? 'BREX-3.0.1' : standard === S41 ? 'BREX-4.1' : 'BREX-4.2';
    const examples = [
      { label: 'notice', expected: 'accept', schema, content: '', metadata: sectionWith(standard, schema, copyrightOf(standard, NOTICE)) },
      { label: 'wrong year', expected: 'reject', schema, content: '', metadata: sectionWith(standard, schema, copyrightOf(standard, WRONG_YEAR)) },
    ];
    const materialized = examples.map((ex) => materializeExample(ex, setup, parseXml));
    const runs = materialized.map((ex) => runExample(rule, format, ex, { vocabulary: VOCAB[standard], parseXml }));
    const verdict = ruleTestVerdict(materialized, runs, analyzeRule(rule, format, { parseXml }));
    const key = `${standard} ${schema}`;
    check(`${key}: <copyright> in <${parent}> moved by the app`, materialized.every((m) => m.relocated?.length === 1 && m.relocated[0].element === 'copyright' && m.relocated[0].parent === parent), JSON.stringify(materialized.map((m) => m.relocated)));
    check(`${key}: both examples valid`, runs.every((r) => r.validation.runnable), JSON.stringify(runs.map((r) => r.validation.structure)));
    check(`${key}: notice accepted, wrong year rejected`, runs.map((r) => r.result?.status).join() === 'accepted,rejected', JSON.stringify(runs.map((r) => r.result?.status)));
    check(`${key}: verdict correct`, verdict.kind === 'correct', JSON.stringify(verdict));
    check(`${key}: the moved element kept its text exactly`, materialized[1].metadata.includes(copyrightOf(standard, WRONG_YEAR)));
    for (const m of materialized) {
      const errors = await sectionXsdErrors(standard, schema, m.xml);
      check(`${key} (${m.label}): XSD, no error in the section`, errors.length === 0, errors.join(' | '));
    }
  }
}

// Existing containers are reused; the new one goes in the XSD's order.
{
  const structure = structureOf(S42, 'descript');
  const text = sectionWith(S42, 'descript', '<dataRestrictions><restrictionInstructions><dataDistribution>A</dataDistribution></restrictionInstructions></dataRestrictions><copyright><copyrightPara>C</copyrightPara></copyright>');
  const moved = relocateMisplacedElements(text, structure, 'dmodule');
  check('reuse: moved once', moved.moved.length === 1);
  check('reuse: into the existing <dataRestrictions>, after its <restrictionInstructions>',
    moved.text.includes('<dataRestrictions><restrictionInstructions><dataDistribution>A</dataDistribution></restrictionInstructions><restrictionInfo><copyright><copyrightPara>C</copyrightPara></copyright></restrictionInfo></dataRestrictions>')
      && !moved.text.includes('</dataRestrictions><copyright>'), moved.text);
  // A misplaced element before its place: removed there, inserted after.
  const before = metadataXml(structure.skeleton.metadata.tree).xml.replace('<dmStatus>', '<dmStatus><copyright><copyrightPara>C</copyrightPara></copyright>');
  const movedBefore = relocateMisplacedElements(before, structure, 'dmodule');
  check('order: a copyright written before <security> ends up after it', movedBefore.moved.length === 1
    && /<security [^>]*\/>\s*<dataRestrictions>/.test(movedBefore.text) && !movedBefore.text.includes('<dmStatus><copyright>'), movedBefore.text);
}

// Nothing to do: a valid example stays byte for byte; a <para> inside a
// <para> (many ways: footnote, lists, …) is left for the correction round.
{
  const structure = structureOf(S42, 'descript');
  const valid = sectionWith(S42, 'descript', '<dataRestrictions><restrictionInstructions><dataDistribution>A</dataDistribution></restrictionInstructions></dataRestrictions>');
  const r = relocateMisplacedElements(valid, structure, 'dmodule');
  check('valid example: untouched', r.moved.length === 0 && r.text === valid);
  const para = relocateMisplacedElements('<para>Text <para>inner</para></para>', structure, 'levelledPara');
  check('para in para: several ways, nothing moved', para.moved.length === 0);
  check('para in para: at the insertion point too', relocateMisplacedElements('<para>Text.</para>', structure, 'para').moved.length === 0);
  check('unbalanced text: untouched', relocateMisplacedElements('<dmStatus><copyright>', structure, 'identAndStatusSection').text === '<dmStatus><copyright>');
  check('no content models: untouched', relocateMisplacedElements(sectionWith(S42, 'descript', copyrightOf(S42, NOTICE)), { ...structure, models: undefined }, 'dmodule').moved.length === 0);
}

// Content too: the same mechanism in the content of an example.
{
  const structure = structureOf(S42, 'descript');
  const paths = simplePaths(structure.elements, ['levelledPara'], 'copyright', 2);
  check('simplePaths: none from the content to <copyright>', paths.paths.length === 0 && paths.complete);
}

// Synthetic models: a required choice, an attribute with no known value, the
// budget.
{
  const elements = {
    a: { children: ['b', 'x'], attributes: [] },
    b: { children: ['c', 'd', 'target'], attributes: [] },
    c: { children: [], attributes: [] },
    d: { children: ['e'], attributes: ['k'] },
    e: { children: [], attributes: [] },
    x: { children: ['target'], attributes: [] },
    target: { children: [], attributes: [] },
  };
  const models = {
    a: { order: ['b', 'x'], required: [], text: false, attributes: [] },
    b: { order: ['c', 'd', 'target'], required: [['d', 'c']], text: false, attributes: [] },
    c: { order: [], required: [], text: true, attributes: [] },
    d: { order: ['e'], required: ['e'], text: false, attributes: [['k', null]] },
    e: { order: [], required: [], text: true, attributes: [] },
    x: { order: ['target'], required: [], text: false, attributes: [] },
    target: { order: [], required: [], text: true, attributes: [] },
  };
  check('minimal: a required choice takes the buildable, smallest one', renderNode(minimalNode(models, 'b')) === '<b><c/></b>');
  check('minimal: an attribute with no known value → not built', minimalNode(models, 'd') === null);
  check('chain: the next link fills a required choice', renderNode(chainNode(models, ['b', 'c'], { raw: '<c>X</c>' })) === '<b><c>X</c></b>');
  check('chain: …or goes in the XSD order', renderNode(chainNode(models, ['b', 'target'], { raw: '<target/>' })) === '<b><c/><target/></b>');
  const two = simplePaths(elements, ['a'], 'target', 4);
  check('simplePaths: both ways, shortest first', two.paths.map((p) => p.join('/')).join() === 'a/b/target,a/x/target' && two.complete);
  const moved = relocateMisplacedElements('<a><target/></a>', { elements, models }, null);
  check('synthetic: two ways → not moved', moved.moved.length === 0);
  const single = relocateMisplacedElements('<b><e/></b>', { elements: { ...elements, b: { ...elements.b, children: ['c', 'd'] } }, models }, null);
  check('synthetic: the only way needs <d>, whose @k has no value → not moved', single.moved.length === 0);
}

// ─── Through generateRuleTestExamples: no correction round ──────────────────
{
  const structure = structureOf(S42, 'descript');
  let asked = 0;
  const result = await generateRuleTestExamples({
    ruleXml: R65, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-S1-00065', title: 'Use of the element <copyright>', definition: 'd', proposal: 'p' },
    vocabulary: VOCAB[S42], parseXml,
    ask: async () => {
      asked += 1;
      return JSON.stringify({ proposalMismatch: null, examples: [
        { label: 'notice', expected: 'accept', schema: 'descript', metadata: sectionWith(S42, 'descript', copyrightOf(S42, NOTICE)) },
        { label: 'wrong year', expected: 'reject', schema: 'descript', metadata: sectionWith(S42, 'descript', copyrightOf(S42, WRONG_YEAR)) },
      ] });
    },
    // No cards (the prompt just has no SCHEMA FACTS); which schemas have
    // each name, from the real structure.
    fetchSchemaCards: async (_std, names) => ({ cards: {}, document_schemas: ['descript'], element_schemas: Object.fromEntries(names.map((n) => [n, structure.elements[n] ? ['descript'] : []])) }),
    fetchStructure: async () => ({ available: true, ...structure }),
  });
  check('S1-00065 end to end: one LLM call, no correction round', asked === 1, String(asked));
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(R65, 'BREX-4.2', { parseXml }));
  check('S1-00065 end to end: accepted / rejected, verdict correct', result.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && verdict.kind === 'correct', JSON.stringify(verdict));
  check('S1-00065 end to end: both corrected by the app', result.examples.every((e) => e.relocated?.length === 1));
  const failures = exampleFailures(result.examples, result.examples, result.runs, { ruleXml: R65, standard: S42, format: 'BREX-4.2', parseXml });
  check('S1-00065 end to end: nothing left for a correction round', failures.length === 0, JSON.stringify(failures));
}

// The panel's note, EN/ES.
{
  const moves = '<copyright> → dmStatus/dataRestrictions/restrictionInfo';
  check('note EN', i18n.getFixedT('en')('records.ruleTest.relocated', { moves }) === `Corrected by the application (placement according to the schema): ${moves}.`);
  check('note ES', i18n.getFixedT('es')('records.ruleTest.relocated', { moves }) === `Corregido por la aplicación (colocación según el esquema): ${moves}.`);
}

// sectionRoutes on its own: nothing for a name already in the section.
{
  const structure = structureOf(S42, 'descript');
  check('sectionRoutes: names in the section or directly inside → []', sectionRoutes(structure, structure.skeleton.metadata, ['dmStatus', 'security', 'dataRestrictions']).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
