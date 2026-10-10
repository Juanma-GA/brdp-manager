// Mejoras C, Part 2: where an element the rule names goes (prompt,
// correction round) and its move to its only parent, on the REAL schema
// structures (scripts/rule-test-fixtures/structures.json).
//   node scripts/test-rule-place.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { elementPlaces, placeSentence, relocateToOnlyParent } from '../src/utils/schemaPlacement.js';
import { exampleFailures, generateRuleTestExamples, placementPlaces, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { materializeExample, runExample, ruleTestVerdict } from '../src/utils/ruleTest.js';
import { placeExample, ruleTargets } from '../src/utils/ruleTestSkeleton.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { readTextFile } from './lib/textFile.mjs';

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
const parseXml = (x) => {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(x, 'text/xml');
  if (messages.length) throw new Error(messages[0]);
  return doc;
};
const structures = JSON.parse(readTextFile(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const S = (standard, schema) => ({ available: true, ...structures[`${standard}|${schema}`] });
const fetchersFor = (standard) => {
  const schemas = Object.keys(structures).filter((k) => k.startsWith(`${standard}|`)).map((k) => k.split('|')[1]);
  return {
    fetchSchemaCards: async (_std, names) => ({
      cards: Object.fromEntries(
        names
          .filter((n) => schemas.some((s) => structures[`${standard}|${s}`].elements[n]))
          .map((n) => {
            const own = schemas.filter((s) => structures[`${standard}|${s}`].elements[n]);
            const el = structures[`${standard}|${own[0]}`].elements[n];
            const parents = Object.entries(structures[`${standard}|${own[0]}`].elements).filter(([, e]) => e.children.includes(n)).map(([p]) => p);
            return [n, { variants: [{ schemas: own, children: el.children, attributes: el.attributes.map((a) => ({ name: a, required: false, enum: null })), resolved: true }], parents }];
          })
      ),
      document_schemas: schemas,
    }),
    fetchStructure: async (_std, schema) => S(standard, schema),
    fetchSchemaAttribute: async () => ({ available: false }),
  };
};

// ─── Case c: BRDP-EXT-02613 (3.0.1), /dmodule[not(//actref)] ───────────────
const RULE_C = '<objrule id="BRDP-EXT-02613"><objpath objappl="0">/dmodule[not(//actref)]</objpath><objuse>Every data module must reference its applicability cross-reference table.</objuse></objrule>';
const descript301 = S('S1000D 3.0.1', 'descript');
const placementC = placeExample(descript301, ruleTargets(RULE_C));
check('c: whole document', placementC.insertion === null && placementC.root === 'dmodule');
const placesC = placementPlaces(descript301, placementC, RULE_C);
check('c: one place', placesC.length === 1 && placesC[0].element === 'actref', JSON.stringify(placesC));
check('c: sentence', placeSentence(placesC[0]) === '<actref> goes inside <status> (dmodule/idstatus/status), after <orig> and before <applic>.', placeSentence(placesC[0] || {}));

const setupC = await prepareRuleTestSetup({ ruleXml: RULE_C, standard: 'S1000D 3.0.1', schemaLocation: null, ...fetchersFor('S1000D 3.0.1') });
const pc = setupC.promptPlacements[0];
check('c: prepare gives the place', pc.schema === 'descript' && pc.places?.[0]?.element === 'actref');
const promptC = buildRuleTestExamplesPrompt({
  brdp: { identifier: 'BRDP-EXT-02613', title: 'T', definition: 'D', proposal: 'Every data module shall reference its applicability cross-reference table.' },
  standard: 'S1000D 3.0.1',
  format: 'BREX-3.0.1',
  ruleXml: RULE_C,
  contextSchemas: [],
  placements: setupC.promptPlacements,
  schemaFacts: [],
});
check('c: prompt line', promptC.includes('\n  <actref> goes inside <status> (dmodule/idstatus/status), after <orig> and before <applic>.'));

// The examples the LLM writes: whole documents. The real failure put
// <actref> inside <descript>; it is moved into <status>.
const minimalSection = (inStatus = '') =>
  `<idstatus><dmaddres><dmc><avee><modelic>EXAMPLE</modelic><sdc>A</sdc><chapnum>00</chapnum><section>0</section><subsect>0</subsect><subject>00</subject><discode>00</discode><discodev>A</discodev><incode>040</incode><incodev>A</incodev><itemloc>A</itemloc></avee></dmc><dmtitle><techname>Example</techname></dmtitle><issno issno="001"/><issdate day="01" month="01" year="2026"/><language country="US" language="en"/></dmaddres><status><security class="01"/><rpc>Example company</rpc><orig>Example company</orig>${inStatus}<applic><displaytext><p>All</p></displaytext></applic><brexref><refdm><avee><modelic>EXAMPLE</modelic><sdc>A</sdc><chapnum>00</chapnum><section>0</section><subsect>0</subsect><subject>00</subject><discode>00</discode><discodev>A</discodev><incode>022</incode><incodev>A</incodev><itemloc>D</itemloc></avee></refdm></brexref><qa><unverif/></qa></status></idstatus>`;
const ACTREF = '<actref><refdm><avee><modelic>EXAMPLE</modelic><sdc>A</sdc><chapnum>00</chapnum><section>0</section><subsect>0</subsect><subject>00</subject><discode>00</discode><discodev>A</discodev><incode>00W</incode><incodev>A</incodev><itemloc>A</itemloc></avee></refdm></actref>';
const doc = (status, body) => `<dmodule>${minimalSection(status)}<content><descript><para0><title>Removal</title><para>Remove the cover.</para>${body}</para0></descript></content></dmodule>`;
const setup = { ...setupC.setup, rule: { ruleXml: RULE_C, format: 'BREX-3.0.1', names: ['dmodule', 'actref'] } };
const misplaced = materializeExample({ label: 'misplaced', expected: 'accept', schema: 'descript', content: doc('', ACTREF) }, setup, parseXml);
check('c: moved', misplaced.relocated?.length === 1 && misplaced.relocated[0].element === 'actref' && misplaced.relocated[0].onlyParent, JSON.stringify(misplaced.relocated));
check('c: moved between orig and applic', /<orig>Example company<\/orig><actref>[\s\S]*<\/actref><applic>/.test(misplaced.content), misplaced.content);
check('c: not left in descript', !/<descript>[\s\S]*<actref>/.test(misplaced.content));
check('c: path shown', misplaced.relocated[0].path.join('/') === 'dmodule/idstatus/status/actref', misplaced.relocated[0].path.join('/'));
const runMisplaced = runExample(RULE_C, 'BREX-3.0.1', misplaced, { parseXml });
check('c: valid after the move', runMisplaced.validation.runnable, JSON.stringify(runMisplaced.validation.structure));
check('c: accepted', runMisplaced.result?.status === 'accepted');
const withoutActref = materializeExample({ label: 'no actref', expected: 'reject', schema: 'descript', content: doc('', '') }, setup, parseXml);
const runWithout = runExample(RULE_C, 'BREX-3.0.1', withoutActref, { parseXml });
check('c: reject example rejected', runWithout.validation.runnable && runWithout.result?.status === 'rejected');
check('c: verdict correct', ruleTestVerdict([misplaced, withoutActref], [runMisplaced, runWithout]).kind === 'correct');
// already in place: untouched
const inPlace = materializeExample({ label: 'ok', expected: 'accept', schema: 'descript', content: doc(ACTREF, '') }, setup, parseXml);
check('c: in place, nothing moved', !inPlace.relocated && inPlace.content === doc(ACTREF, ''));

// end to end, with the real failure as the LLM's answer: one LLM call, no
// correction round, verdict correct
const calls = [];
const result = await generateRuleTestExamples({
  ruleXml: RULE_C,
  format: 'BREX-3.0.1',
  standard: 'S1000D 3.0.1',
  schemaLocation: null,
  brdp: { identifier: 'BRDP-EXT-02613', title: 'T', definition: 'D', proposal: 'P' },
  vocabulary: null,
  ask: async (messages) => {
    calls.push(messages);
    return JSON.stringify({
      examples: [
        { label: 'With the ACT reference', expected: 'accept', schema: 'descript', content: doc('', ACTREF) },
        { label: 'Without it', expected: 'reject', schema: 'descript', content: doc('', '') },
      ],
    });
  },
  ...fetchersFor('S1000D 3.0.1'),
  parseXml,
});
check('c e2e: ready', result.status === 'ready', JSON.stringify(result).slice(0, 300));
check('c e2e: one LLM call', calls.length === 1);
check('c e2e: no correction round', result.correction === null);
check('c e2e: verdict correct', result.status === 'ready' && ruleTestVerdict(result.examples, result.runs).kind === 'correct');

// ─── Never moved when it changes what the rule decides ──────────────────────
// /dmodule/idstatus/status/actref: an <actref> the LLM put in <dmaddres> is
// not selected; moved into the status it would be -- so it stays, and the
// correction says where it goes.
const RULE_CONTENT = '<objrule id="R"><objpath objappl="0">/dmodule/idstatus/status/actref</objpath><objuse>x</objuse></objrule>';
const setupContent = await prepareRuleTestSetup({ ruleXml: RULE_CONTENT, standard: 'S1000D 3.0.1', schemaLocation: null, ...fetchersFor('S1000D 3.0.1') });
const pContent = setupContent.promptPlacements[0];
const setupC2 = { ...setupContent.setup, rule: { ruleXml: RULE_CONTENT, format: 'BREX-3.0.1', names: ['dmodule', 'idstatus', 'status', 'actref'] } };
check('changes the result: only the section is written', pContent.metadata && pContent.contentInsertion === false, JSON.stringify(pContent).slice(0, 300));
// the LLM put <actref> in <dmaddres>: moved into <status> the rule would select it
const wrongSection = minimalSection('').replace('</dmaddres>', `${ACTREF}</dmaddres>`);
const kept = materializeExample({ label: 'x', expected: 'accept', schema: pContent.schema, metadata: wrongSection }, setupC2, parseXml);
check('changes the result: not moved', !(kept.relocated || []).some((m) => m.onlyParent), JSON.stringify(kept.relocated));
const keptRun = runExample(RULE_CONTENT, 'BREX-3.0.1', kept, { parseXml });
const failuresContent = exampleFailures([kept], [kept], [keptRun], { ruleXml: RULE_CONTENT, standard: 'S1000D 3.0.1', format: 'BREX-3.0.1', setup: setupContent.setup, parseXml });
check(
  'changes the result: correction says where it goes',
  failuresContent[0]?.problems.some((p) => p.includes('is not allowed inside') && p.includes('<actref> goes inside <status> (dmodule/idstatus/status), after <orig> and before <applic>.')),
  JSON.stringify(failuresContent)
);

// ─── Several possible parents: not moved, the correction lists them ────────
// 4.2 <applicRef>: inside <dmStatus> or <referencedApplicGroupRef>.
const RULE_APPLICREF = '<structureObjectRule id="R"><objectPath allowedObjectFlag="0">//applicRef[@applicIdentValue]</objectPath><objectUse>x</objectUse></structureObjectRule>';
const descript42 = S('S1000D 4.2', 'descript');
const placesApplic = placementPlaces(descript42, placeExample(descript42, ruleTargets(RULE_APPLICREF)), RULE_APPLICREF);
check('several parents: listed', placesApplic.some((p) => p.element === 'applicRef' && p.parents.length === 2 && placeSentence(p) === '<applicRef> goes inside <dmStatus> or <referencedApplicGroupRef>.'), JSON.stringify(placesApplic));
const several = relocateToOnlyParent('<dmodule><identAndStatusSection><dmStatus/></identAndStatusSection><content><description><para><applicRef applicIdentValue="a"/></para></description></content></dmodule>', descript42, null, ['applicRef']);
check('several parents: not moved', several.moved.length === 0);

// ─── An element the rule does not name: as before ──────────────────────────
const notNamed = relocateToOnlyParent(doc('', ACTREF), descript301, null, ['dmodule']);
check('not named: not moved', notNamed.moved.length === 0);

// ─── Fits where the LLM writes: no sentence ────────────────────────────────
const RULE_EMPH = '<structureObjectRule id="R"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>x</objectUse></structureObjectRule>';
check('fits: no place', placementPlaces(descript42, placeExample(descript42, ruleTargets(RULE_EMPH)), RULE_EMPH).length === 0);
// the rule's own path already writes it under its parent
const RULE_CHILD = '<objrule id="R"><objpath objappl="0">//status/actref</objpath><objuse>x</objuse></objrule>';
check('own path: no place', placementPlaces(descript301, placeExample(descript301, ruleTargets(RULE_CHILD)), RULE_CHILD).length === 0);
// too many parents (title): nothing
const RULE_TITLE = '<objrule id="R"><objpath objappl="0">/dmodule[//title = "x"]</objpath><objuse>x</objuse></objrule>';
check('many parents: nothing', !placementPlaces(descript301, placeExample(descript301, ruleTargets(RULE_TITLE)), RULE_TITLE).some((p) => p.element === 'title'));
check('elementPlaces without a root', elementPlaces(descript301, {}, ['actref']).length === 0);

void fs;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
