// La recolocación no debe duplicar un elemento que la app ya creó: moving
// an element the LLM put where the schema does not allow it builds the
// missing containers with their required children (chainNode); when a
// later move brings the LLM's own element of that name, at most once there,
// it takes the place of the one the app built. Real case BRDP-EXT-00134
// (default S1000D 4.2 BREX, comrep): the LLM wrote <referencedApplicGroup>
// and <commonRepository> straight inside <dmodule>; moving the first built
// <content> with a minimal <commonRepository>, and the LLM's one was then
// put next to it ("<content> allows at most 1 <commonRepository>").
// REAL S1000D 4.2 structures; the LLM is a fake with fixed examples.
//   node scripts/test-relocation-filler.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { relocateMisplacedElements } from '../src/utils/schemaPlacement.js';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { ruleTestVerdict } from '../src/utils/ruleTest.js';
import { metadataXml } from '../src/utils/ruleTestSkeleton.js';
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
const S42 = 'S1000D 4.2';
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const COMREP = STRUCTURES[`${S42}|comrep`];
const RULES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/default-brex-4-2.json', import.meta.url))).rules;
const EXT134 = RULES['BRDP-EXT-00134'].rule_xml;
const v = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-4-2.json', import.meta.url)));
const VOCAB = { elements: new Set(v.elements), attributes: new Set(v.attributes) };
const CARDS = JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-4-2.json', import.meta.url)));
const count = (text, name) => (text.match(new RegExp(`<${name}[\\s>/]`, 'g')) || []).length;

const APPLIC = '<referencedApplicGroup><applic id="app-0001"><displayText><simplePara>Model A</simplePara></displayText><expression><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></expression></applic></referencedApplicGroup>';
const REPO = '<commonRepository><supplyRepository><supplySpec><supplyIdent supplyNumber="S1" supplyNumberType="sp01"/><name>Grease</name></supplySpec></supplyRepository></commonRepository>';
const REPO2 = '<commonRepository><toolRepository><toolSpec><toolIdent manufacturerCodeValue="12345" toolNumber="T1"/><itemIdentData><descrForPart>Torque wrench</descrForPart></itemIdentData></toolSpec></toolRepository></commonRepository>';

// ─── 1. relocateMisplacedElements on the real comrep structure ─────────────
check('fixture: <content> requires <commonRepository>, at most 1', JSON.stringify(COMREP.models.content.required) === '["commonRepository"]' && COMREP.models.content.max.commonRepository === 1);
{
  // The real case: <referencedApplicGroup> first (builds <content> with a
  // minimal <commonRepository>), then the LLM's <commonRepository>.
  const r = relocateMisplacedElements(`${APPLIC}\n${REPO}`, COMREP, 'dmodule');
  check('real case: both moved', r.moved.map((m) => `${m.element}>${m.path.join('/')}`).join() === 'referencedApplicGroup>dmodule/content/referencedApplicGroup,commonRepository>dmodule/content/commonRepository', JSON.stringify(r.moved));
  check('real case: one <content>, one <commonRepository>', count(r.text, 'content') === 1 && count(r.text, 'commonRepository') === 1, r.text);
  check("real case: the <commonRepository> is the LLM's, with <supplyRepository>", r.text.includes(REPO) && !r.text.includes('EXAMPLE'), r.text);
  check('real case: <referencedApplicGroup> before <commonRepository> (XSD order)', r.text.indexOf('<referencedApplicGroup') < r.text.indexOf('<commonRepository'), r.text);
  check('real case: no marker left', !r.text.includes('data-brdp'), r.text);
  check('real case: the LLM elements byte for byte', r.text.includes(APPLIC) && r.text.includes(REPO));
}
{
  // The other order: <commonRepository> first builds <content> around it
  // (no minimal one), then <referencedApplicGroup> reuses it.
  const r = relocateMisplacedElements(`${REPO}${APPLIC}`, COMREP, 'dmodule');
  check('other order: one <commonRepository>, the LLM\'s', count(r.text, 'commonRepository') === 1 && r.text.includes(REPO), r.text);
  check('other order: <referencedApplicGroup> before it', r.text.indexOf('<referencedApplicGroup') < r.text.indexOf('<commonRepository'), r.text);
}
{
  // Two <commonRepository> written by the LLM: never merged nor replaced --
  // both stay (the minimal one goes), the example shows "at most 1".
  const r = relocateMisplacedElements(`${APPLIC}${REPO}${REPO2}`, COMREP, 'dmodule');
  check('two from the LLM: exactly the two', count(r.text, 'commonRepository') === 2 && r.text.includes(REPO) && r.text.includes(REPO2) && !r.text.includes('EXAMPLE'), r.text);
}
{
  // Only <referencedApplicGroup>: the minimal <commonRepository> stays (the
  // content needs one), as before.
  const r = relocateMisplacedElements(APPLIC, COMREP, 'dmodule');
  check('no LLM <commonRepository>: the minimal one stays', count(r.text, 'commonRepository') === 1 && r.text.includes('supplyNumber="EXAMPLE"') && !r.text.includes('data-brdp'), r.text);
}
{
  // Nothing built by the app: a valid content stays byte for byte.
  const valid = `<content>${APPLIC}${REPO}</content>`;
  const r = relocateMisplacedElements(valid, COMREP, 'dmodule');
  check('nothing to move: untouched', r.moved.length === 0 && r.text === valid);
}

// ─── 2. Synthetic models: maximum above 1, a filler the LLM went into ──────
{
  const elements = {
    top: { children: ['box'], attributes: [] },
    box: { children: ['x', 'y'], attributes: [] },
    x: { children: ['z'], attributes: [] },
    y: { children: [], attributes: [] },
    z: { children: [], attributes: [] },
  };
  const models = (maxX) => ({
    top: { order: ['box'], required: [], text: false, attributes: [] },
    box: { order: ['y', 'x'], required: ['x'], text: false, attributes: [], max: maxX == null ? {} : { x: maxX } },
    x: { order: ['z'], required: [], text: true, attributes: [] },
    y: { order: [], required: [], text: true, attributes: [] },
    z: { order: [], required: [], text: true, attributes: [] },
  });
  const one = relocateMisplacedElements('<top><y>Y</y><x>LLM</x></top>', { elements, models: models(1) }, null);
  check('synthetic max 1: the LLM\'s <x> replaces the built one', one.text === '<top><box><y>Y</y><x>LLM</x></box></top>', one.text);
  const two = relocateMisplacedElements('<top><y>Y</y><x>LLM</x></top>', { elements, models: models(2) }, null);
  check('synthetic max 2: both stay, as before', two.text === '<top><box><y>Y</y><x/><x>LLM</x></box></top>', two.text);
  const unbounded = relocateMisplacedElements('<top><y>Y</y><x>LLM</x></top>', { elements, models: models(null) }, null);
  check('synthetic no maximum: both stay, as before', unbounded.text === '<top><box><y>Y</y><x/><x>LLM</x></box></top>', unbounded.text);
  // The built <x> took the LLM's <z> first (it is no longer the app's only):
  // the LLM's own <x> does not replace it.
  const into = relocateMisplacedElements('<top><y>Y</y><z>Z</z><x>LLM</x></top>', { elements, models: models(1) }, null);
  check('synthetic: a built <x> holding the LLM\'s <z> is kept', into.text.includes('<z>Z</z>') && into.text.includes('<x>LLM</x>') && !into.text.includes('data-brdp'), into.text);
}

// ─── 3. EXT-00134 end to end: the example as the LLM wrote it ──────────────
const graph = schemaGraph(S42);
const fetchers = {
  fetchSchemaCards: async (_s, names) => ({
    cards: Object.fromEntries(names.filter((n) => CARDS.cards[n]).map((n) => [n, { variants: CARDS.cards[n], parents: CARDS.parents[n] || [] }])),
    document_schemas: graph.schemas,
  }),
  fetchStructure: async (_s, schema) => (STRUCTURES[`${S42}|${schema}`] ? { available: true, ...STRUCTURES[`${S42}|${schema}`] } : { available: false }),
  fetchSchemaGraph: async () => graph,
};
async function generate(answers) {
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: EXT134, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00134', title: 't', definition: 'd', proposal: 'p' }, vocabulary: VOCAB, parseXml, ...fetchers,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      const answer = answers[asked.length - 1];
      if (answer === undefined) throw new Error('unexpected LLM call');
      return JSON.stringify(answer);
    },
  });
  const verdict = result?.status === 'ready' ? ruleTestVerdict(result.examples, result.runs, null, null, null, result.coverage) : null;
  return { result, asked, verdict };
}
const SEC = metadataXml(COMREP.skeleton.metadata.tree, 1).xml.trimStart();
const SEC_REJECT = SEC.replace(/(<simplePara>All<\/simplePara>\s*<\/displayText>)/, '$1<expression><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></expression>');
{
  const { result, asked, verdict } = await generate([{
    examples: [
      { label: 'expression in referencedApplicGroup', expected: 'accept', schema: 'comrep', metadata: SEC, content: `${APPLIC}\n${REPO}` },
      { label: 'expression in dmStatus', expected: 'reject', schema: 'comrep', metadata: SEC_REJECT, content: `${APPLIC}\n${REPO}` },
    ],
  }]);
  check('EXT-00134: one LLM call (no correction round)', asked.length === 1, asked.length);
  for (const [i, ex] of result.examples.entries()) {
    check(`EXT-00134 ${ex.label}: moved by the app`, ex.relocated?.map((m) => m.element).join() === 'referencedApplicGroup,commonRepository', JSON.stringify(ex.relocated));
    check(`EXT-00134 ${ex.label}: one <commonRepository>, the LLM's`, count(ex.xml, 'commonRepository') === 1 && ex.xml.includes(REPO), ex.xml);
    check(`EXT-00134 ${ex.label}: valid`, result.runs[i].validation.runnable, JSON.stringify(result.runs[i].validation.structure));
  }
  check('EXT-00134: accept accepted, reject rejected', result.runs.map((r) => r.result?.status).join() === 'accepted,rejected', JSON.stringify(result.runs.map((r) => r.result)));
  check('EXT-00134: correct verdict', verdict?.kind === 'correct', JSON.stringify(verdict));
}
{
  // Two <commonRepository> written by the LLM: "at most 1" and the
  // correction round, as before.
  const { asked } = await generate([
    {
      examples: [
        { label: 'two repositories', expected: 'accept', schema: 'comrep', metadata: SEC, content: `${APPLIC}${REPO}${REPO2}` },
        { label: 'expression in dmStatus', expected: 'reject', schema: 'comrep', metadata: SEC_REJECT, content: `${APPLIC}${REPO}` },
      ],
    },
    {
      examples: [
        { label: 'two repositories', expected: 'accept', schema: 'comrep', metadata: SEC, content: `${APPLIC}${REPO}` },
        { label: 'expression in dmStatus', expected: 'reject', schema: 'comrep', metadata: SEC_REJECT, content: `${APPLIC}${REPO}` },
      ],
    },
  ]);
  check('two from the LLM: a correction round', asked.length === 2, asked.length);
  check('two from the LLM: the correction names "at most 1 <commonRepository>"', /at most 1 <commonRepository>/.test(JSON.stringify(asked[1]?.messages || '')), JSON.stringify(asked[1]?.messages).slice(-1500));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
