// Test de reglas: referencias, antepasados y reglas de esquema prohibido.
// The real rules of «Official Default CMP ATA - 1000BR 4.2 - 009» that failed
// in the run of scripts/run-project-rule-tests.mjs, verbatim, on the REAL
// S1000D 4.2 structures (scripts/rule-test-fixtures/structures.json) and the
// real element graph (scripts/lib/schemaGraph.mjs). The LLM is a fake that
// returns fixed examples, so what is tested is the application's part:
// placement, prompt, assembly, engine run and verdict.
//   node scripts/test-rule-test-cmp.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { generateRuleTestExamples, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { materializeExample, runExample, ruleTestVerdict, stripDefaultNamespace } from '../src/utils/ruleTest.js';
import { metadataXml, placeExample, ruleTargets } from '../src/utils/ruleTestSkeleton.js';
import { formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { formatCoverageItem } from '../src/validation/schemaCoverage.js';
import { parseRuleTestResponse } from '../src/prompts/ruleTestExamplesPrompt.js';
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
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const S42 = 'S1000D 4.2';
const F = 'BREX-4.2';
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (schema) => STRUCTURES[`${S42}|${schema}`];
const vocabJson = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-4-2.json', import.meta.url)));
const vocabulary = { elements: new Set(vocabJson.elements), attributes: new Set(vocabJson.attributes) };
const graph = schemaGraph(S42);
const CARDS = JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-4-2.json', import.meta.url)));

// ─── The real rules, verbatim ───────────────────────────────────────────────
const sor = (path, use) => `<structureObjectRule><objectPath allowedObjectFlag="0">${path}</objectPath><objectUse>${use}</objectUse></structureObjectRule>`;
const inContext = (schema, body) => `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${schema}.xsd"><structureObjectRuleGroup>${body}</structureObjectRuleGroup></contextRules>`;
const EXT39 = sor(
  '//internalRef[not(attribute::internalRefId = //figure/@id or attribute::internalRefId = //figureAlts/@id or attribute::internalRefId = //table/@id or attribute::internalRefId = //multimedia/@id or attribute::internalRefId = //multimediaAlts/@id or attribute::internalRefId = //supplyDescr/@id or attribute::internalRefId = //embeddedSupplyDescr/@id or attribute::internalRefId = //supportEquipDescr/@id or attribute::internalRefId = //embeddedSupportEquipDescr/@id or attribute::internalRefId = //spareDescr/@id or attribute::internalRefId = //embeddedSpareDescr/@id or attribute::internalRefId = //levelledPara/@id or attribute::internalRefId = //levelledParaAlts/@id or attribute::internalRefId = //proceduralStep/@id or attribute::internalRefId = //proceduralStepAlts/@id or attribute::internalRefId = //graphic/@id or attribute::internalRefId = //multimediaObject/@id or attribute::internalRefId = //hotspot/@id)]',
  'BREX-CMMST-00100: The @internalRef can only target figure, figureAlts, table, multimedia, multimediaAlts, supplyDescr, embeddedSupplyDescr, supportEquipDescr, embeddedSupportEquipDescr, spareDescr, embeddedSpareDescr, levelledPara, levelledParaAlts, proceduralStep, proceduralStepAlts, graphic, multimediaObject, and hotspot elements.'
);
const EXT08 = sor(
  '//internalRef[ancestor::title and not(ancestor::title/parent::definitionList/parent::legend/parent::figure/@id = @internalRefId)]',
  'BREX-CMMST-00095/BREX-CMMST-00119: The &lt;internalRef&gt; element cannot be used within the &lt;title&gt; element except within the figure/legend/defnitionList/title element and then only when it points to the parent figure.'
);
const EXT181 = sor(
  `//dmStatus/@issueType="changed" and (/dmodule/identAndStatusSection/dmStatus/reasonForUpdate[not(@id = /dmodule//@reasonForUpdateRefIds/tokenize(normalize-space(), '\\s'))])`,
  'BREX-CMMST-00007 (DM_identAndStatusSection): In a changed data module, all &lt;reasonForUpdate&gt; elements must be referenced within the data module.'
);
const EXT224 = inContext('pm', sor(
  `//pmStatus/@issueType="changed" and (/pm/identAndStatusSection/pmStatus/reasonForUpdate[not(@id = /pm//@reasonForUpdateRefIds/tokenize(normalize-space(), '\\s'))])`,
  'BREX-CMMST-00007 (PM_identAndStatusSection): In a changed publication module, all &lt;reasonForUpdate&gt; elements must be referenced within the publication module.'
));
const FORBIDDEN = { container: 'EXT-00076', checklist: 'EXT-00087', sb: 'EXT-00088', schedul: 'EXT-00089', wrngdata: 'EXT-00090' };
const forbiddenRule = (schema) => inContext(schema, sor('//dmodule', `BREX-CMMST-00006: The ${schema} schema is not allowed.`));
const EXT86 = inContext('icnmetadata', sor('//icnMetadataFile', 'BREX-CMMST-00006: The icnmetadata schema is not allowed.'));
const EXT272 = inContext('ipd', sor('//footnote | //footnoteRef', 'BREX-CMMST-00272: Footnotes are not allowed in IPD.'));

// ─── Fetchers: the real structures and graph, no schema cards ───────────────
const fetchers = {
  fetchSchemaCards: async (_std, names) => ({
    cards: Object.fromEntries(names.filter((n) => CARDS.cards[n]).map((n) => [n, { variants: CARDS.cards[n], parents: CARDS.parents[n] || [] }])),
    document_schemas: graph.schemas,
  }),
  fetchStructure: async (_std, schema) => (structureOf(schema) ? { available: true, ...structureOf(schema) } : { available: false }),
  fetchSchemaGraph: async () => graph,
};
const brdp = (id) => ({ identifier: id, title: 't', definition: 'd', proposal: 'p' });
async function generate(ruleXml, answers, id = 'BRDP-EXT-X') {
  const asked = [];
  const proposalChecks = [];
  const result = await generateRuleTestExamples({
    ruleXml, format: F, standard: S42, schemaLocation: 'flat', brdp: brdp(id), vocabulary, parseXml, ...fetchers,
    ruleDescription: 'description',
    askProposalCheck: async () => {
      proposalChecks.push(1);
      return '{"implements": "yes", "reason": ""}';
    },
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      const answer = answers[asked.length - 1];
      if (answer === undefined) throw new Error('unexpected LLM call');
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
  const verdict = result?.status === 'ready' ? ruleTestVerdict(result.examples, result.runs, null, result.proposalCheck, null, result.coverage) : null;
  return { result, asked, verdict, proposalChecks };
}
const setupFor = async (ruleXml) => prepareRuleTestSetup({ ruleXml, standard: S42, schemaLocation: 'flat', ...fetchers, format: F, parseXml });

// ─── Part 1.1: reference destinations (EXT-00039) ──────────────────────────
{
  const t = ruleTargets(EXT39);
  check('1a targets: one reference, 18 destinations', t.references.length === 1 && t.references[0].element === 'internalRef' && t.references[0].attribute === 'internalRefId' && t.references[0].destinations.length === 18, JSON.stringify(t.references));
  check('1a targets: destinations in the rule order', t.references[0].destinations.slice(0, 3).map((d) => `${d.name}/@${d.attribute}`).join() === 'figure/@id,figureAlts/@id,table/@id');
  const prep = await setupFor(EXT39);
  const p = prep.promptPlacements.find((x) => x.role === 'rule');
  check('1a placement: descript at <levelledPara> (never <para>, where no destination fits)', p.schema === 'descript' && p.insertion === 'levelledPara', `${p.schema} ${p.insertion}`);
  check('1a placement: writable destinations first', p.references[0].destinations[0].writable && p.references[0].destinations.slice(0, 10).every((d) => d.writable) && !p.references[0].destinations[10].writable, JSON.stringify(p.references[0].destinations.map((d) => [d.name, d.writable])));
  check('1a placement: ways to the first ones', p.references[0].ways.map((w) => w.join('/')).join(';') === 'levelledPara/figure;levelledPara/figureAlts;levelledPara/table', JSON.stringify(p.references[0].ways));
  check('1a no SEVERAL NODES for //X/@id', prep.several.length === 0, JSON.stringify(prep.several));
  const accept = { label: 'points to a figure', expected: 'accept', schema: 'descript', content: '<figure id="f1"><title>Pump</title><graphic infoEntityIdent="ICN-00001"/></figure><para>See <internalRef internalRefId="f1"/>.</para>' };
  const reject = { label: 'points to a paragraph', expected: 'reject', schema: 'descript', content: '<para id="p1">Remove the cover.</para><para>See <internalRef internalRefId="p1"/>.</para>' };
  const { result, asked, verdict } = await generate(EXT39, [{ examples: [accept, reject] }], 'BRDP-EXT-00039');
  const prompt = asked[0].systemPrompt;
  check('1a prompt: destinations line', prompt.includes('The rule compares @internalRefId of <internalRef> with the @id of <figure>, <figureAlts>, <table>, <multimedia>, <multimediaAlts>, <levelledPara>, <levelledParaAlts>, <graphic> (10 more): an example meant to be accepted contains one of those elements with that @id; the reject example points to an element that exists in the example but is not in the list.'), prompt);
  check('1a prompt: way to the first ones', prompt.includes('The valid way to the first of them from <levelledPara>: levelledPara/figure; levelledPara/figureAlts; levelledPara/table.'));
  check('1a prompt: no SEVERAL NODES', !prompt.includes('SEVERAL NODES'));
  check('1a prompt: content goes inside <levelledPara>', prompt.includes('your content goes directly inside <levelledPara>, at\n  dmodule/content/description/levelledPara.'));
  check('1a accept example accepted', result.runs[0].result?.status === 'accepted', JSON.stringify(result.runs[0].validation));
  check('1a reject example rejected, <internalRef> highlighted', result.runs[1].result?.status === 'rejected' && result.runs[1].result.selectedNodePaths.join() === '/dmodule[1]/content[1]/description[1]/levelledPara[1]/para[2]/internalRef[1]', JSON.stringify(result.runs[1].result));
  check('1a verdict correct, one LLM call', verdict?.kind === 'correct' && asked.length === 1, JSON.stringify(verdict));
  // No point reaches a destination (only the identification and status
  // section has <reasonForUpdate>): the placement is what it was.
  const sectionOnly = sor('//internalRef[not(@internalRefId = //reasonForUpdate/@id)]', 'x');
  const plain = sor('//internalRef', 'x');
  const a = placeExample(structureOf('descript'), ruleTargets(sectionOnly));
  const b = placeExample(structureOf('descript'), ruleTargets(plain));
  check('1a no reachable destination: placement as today', a.insertion === b.insertion && a.insertion === 'para', `${a.insertion} ${b.insertion}`);
}

// ─── Part 1.2: chain of ancestors (EXT-00008) ──────────────────────────────
{
  const t = ruleTargets(EXT08);
  check('1b targets: chain title/definitionList/legend/figure', t.chains.length === 1 && t.chains[0].chain.map((s) => `${s.link}:${s.name}`).join() === 'ancestor:title,parent:definitionList,parent:legend,parent:figure', JSON.stringify(t.chains));
  const prep = await setupFor(EXT08);
  const p = prep.promptPlacements.find((x) => x.role === 'rule');
  check('1b placement: <levelledPara> (holds <figure>)', p.insertion === 'levelledPara', p.insertion);
  check('1b chain way', p.chainWays?.[0]?.way.join('/') === 'levelledPara/figure/legend/definitionList/title/internalRef', JSON.stringify(p.chainWays));
  check('1b no SEVERAL NODES for the chain', prep.several.length === 0, JSON.stringify(prep.several));
  const legend = (target) => `<figure id="f1"><title>Pump</title><graphic infoEntityIdent="ICN-00001"/><legend><definitionList><title>Key to <internalRef internalRefId="${target}"/></title><definitionListItem><listItemTerm>1</listItemTerm><listItemDefinition><para>Valve</para></listItemDefinition></definitionListItem></definitionList></legend></figure>`;
  const examples = [
    { label: 'points to its figure', expected: 'accept', schema: 'descript', content: legend('f1') },
    { label: 'points to another figure', expected: 'reject', schema: 'descript', content: `${legend('f2')}<figure id="f2"><title>Valve</title><graphic infoEntityIdent="ICN-00002"/></figure>` },
    { label: 'outside a title', expected: 'accept', schema: 'descript', content: '<figure id="f1"><title>Pump</title><graphic infoEntityIdent="ICN-00001"/></figure><para>See <internalRef internalRefId="f1"/>.</para>' },
  ];
  const { result, asked, verdict } = await generate(EXT08, [{ examples }], 'BRDP-EXT-00008');
  check('1b prompt: the chain line', asked[0].systemPrompt.includes("The rule's condition looks at figure/legend/definitionList/title around <internalRef>: write it by exactly this way: levelledPara/figure/legend/definitionList/title/internalRef."), asked[0].systemPrompt);
  check('1b own figure accepted', result.runs[0].result?.status === 'accepted', JSON.stringify(result.runs[0].validation));
  check('1b other figure rejected', result.runs[1].result?.status === 'rejected', JSON.stringify(result.runs[1]));
  check('1b outside a title accepted', result.runs[2].result?.status === 'accepted');
  check('1b verdict correct', verdict?.kind === 'correct', JSON.stringify(verdict));
  // A chain no schema can write: not executable, before any LLM call.
  const impossible = sor('//internalRef[ancestor::title/parent::legend]', 'x');
  const none = await generate(impossible, []);
  check('1b no chain fits: not executable without the LLM', none.result?.status === 'not_executable' && none.result.reason.code === 'example_no_room' && none.asked.length === 0, JSON.stringify({ s: none.result?.status, r: none.result?.reason, asked: none.asked.length }));
  check('1b reason EN/ES', formatRuleTestReason(none.result.reason, en).includes('<legend>') && formatRuleTestReason(none.result.reason, es).includes('cabe <legend>'), formatRuleTestReason(none.result.reason, es));
}

// ─── Part 1.3: a loose attribute in the condition (EXT-00181, EXT-00224) ────
function changedSection(placement, wrapper) {
  // The minimal section with issueType="changed" and one <reasonForUpdate>.
  const { xml } = metadataXml(placement.metadata.tree);
  return xml
    .replace(`<${wrapper}>`, `<${wrapper} issueType="changed">`)
    .replace('</qualityAssurance>', '</qualityAssurance><reasonForUpdate id="rfu-0001"><simplePara>Torque value changed.</simplePara></reasonForUpdate>');
}
{
  const t = ruleTargets(EXT181);
  check('1c targets: loose attribute', t.looseAttributes.length === 1 && t.looseAttributes[0].attribute === 'reasonForUpdateRefIds' && t.looseAttributes[0].root === 'dmodule', JSON.stringify(t.looseAttributes));
  const prep = await setupFor(EXT181);
  const p = prep.promptPlacements.find((x) => x.role === 'rule');
  check('1c placement: metadata AND content', p.metadata?.insertion === true && p.contentInsertion === true && p.insertion === 'para', JSON.stringify({ meta: p.metadata?.insertion, content: p.contentInsertion, ins: p.insertion }));
  const carriers = p.attributeCarriers.find((c) => c.attribute === 'reasonForUpdateRefIds');
  check('1c carriers in the prompt', carriers?.inPrompt && carriers.nearest?.from === 'content', JSON.stringify(carriers?.nearest));
  const metadata = changedSection(p, 'dmStatus');
  const examples = [
    { label: 'referenced from the content', expected: 'accept', schema: 'descript', metadata, content: 'Tighten to <quantity reasonForUpdateRefIds="rfu-0001">25 N.m</quantity>.' },
    { label: 'not referenced', expected: 'reject', schema: 'descript', metadata, content: 'Tighten the bolt.' },
  ];
  const { result, asked, verdict } = await generate(EXT181, [{ examples }], 'BRDP-EXT-00181');
  check('1c prompt: carriers line', asked[0].systemPrompt.includes('@reasonForUpdateRefIds goes on: <accessPointRef>'), asked[0].systemPrompt);
  check('1c prompt: metadata and content', asked[0].systemPrompt.includes('your content goes directly inside <para>') && asked[0].systemPrompt.includes('your "metadata" is the WHOLE <identAndStatusSection>'));
  check('1c referenced accepted', result.runs[0].result?.status === 'accepted', JSON.stringify(result.runs[0].validation));
  check('1c unreferenced rejected', result.runs[1].result?.status === 'rejected', JSON.stringify(result.runs[1]));
  check('1c verdict correct', verdict?.kind === 'correct', JSON.stringify(verdict));
}
{
  const prep = await setupFor(EXT224);
  const p = prep.promptPlacements.find((x) => x.role === 'rule');
  check('1c pm: placement metadata AND content', p.schema === 'pm' && p.metadata?.insertion === true && p.contentInsertion === true, JSON.stringify({ s: p.schema, meta: p.metadata?.insertion, content: p.contentInsertion }));
  const metadata = changedSection(p, 'pmStatus');
  const entry = (ref) => `<dmRef${ref ? ' reasonForUpdateRefIds="rfu-0001"' : ''}><dmRefIdent><dmCode assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="A" modelIdentCode="EXAMPLE" subSubSystemCode="0" subSystemCode="0" systemCode="00" systemDiffCode="A"/></dmRefIdent></dmRef>`;
  const { result, verdict } = await generate(EXT224, [{ examples: [
    { label: 'referenced', expected: 'accept', schema: 'pm', metadata, content: entry(true) },
    { label: 'not referenced', expected: 'reject', schema: 'pm', metadata, content: entry(false) },
  ] }], 'BRDP-EXT-00224');
  check('1c pm referenced accepted', result.runs[0].result?.status === 'accepted', JSON.stringify(result.runs[0].validation));
  check('1c pm unreferenced rejected', result.runs[1].result?.status === 'rejected', JSON.stringify(result.runs[1]));
  check('1c pm verdict correct', verdict?.kind === 'correct', JSON.stringify(verdict));
}

// ─── Part 2.1: a schema forbidden by a context block ────────────────────────
for (const [schema, id] of Object.entries(FORBIDDEN)) {
  const { result, asked, verdict, proposalChecks } = await generate(forbiddenRule(schema), [], `BRDP-${id}`);
  check(`2a ${id} (${schema}): no LLM call, not even the Proposal check`, asked.length === 0 && proposalChecks.length === 0, `${asked.length} ${proposalChecks.length}`);
  check(`2a ${id}: minimal document of ${schema} rejected, another accepted`,
    result.status === 'ready' && result.examples.length === 2 && result.examples[0].schema === schema && result.examples[0].expected === 'reject' && result.runs[0].result.status === 'rejected'
    && result.examples[1].expected === 'accept' && result.examples[1].schema !== schema && result.runs[1].result.status === 'accepted',
    JSON.stringify(result.examples?.map((e, i) => [e.schema, e.expected, result.runs[i].result?.status])));
  check(`2a ${id}: built by the application, not editable`, result.examples.every((e) => e.minimalDocument === true));
  check(`2a ${id}: verdict correct`, verdict?.kind === 'correct', JSON.stringify(verdict));
}
{
  // EXT-00086: the application now writes the <imfIdentAndStatusSection> of
  // <icnMetadataFile>, so it is tested like the other forbidden schemas.
  const { result, asked, verdict, proposalChecks } = await generate(EXT86, [], 'BRDP-EXT-00086');
  check('2a EXT-00086: no LLM call, not even the Proposal check', asked.length === 0 && proposalChecks.length === 0, `${asked.length} ${proposalChecks.length}`);
  check('2a EXT-00086: minimal icnmetadata document rejected, another accepted',
    result.status === 'ready' && result.examples.length === 2 && result.examples[0].schema === 'icnmetadata' && result.runs[0].result.status === 'rejected'
    && result.examples[1].schema !== 'icnmetadata' && result.runs[1].result.status === 'accepted',
    JSON.stringify(result.reason || result.examples?.map((e, i) => [e.schema, e.expected, result.runs[i].result?.status])));
  check('2a EXT-00086: the minimal document has its section', /<icnMetadataFile[^>]*>\s*<imfIdentAndStatusSection>/.test(result.examples?.[0]?.xml || ''), result.examples?.[0]?.xml);
  check('2a EXT-00086: verdict correct', verdict?.kind === 'correct', JSON.stringify(verdict));
  // //dmodule flag 0 outside a context block: as before (the LLM writes the examples).
  const general = await generate(sor('//dmodule', 'x'), ['{"examples": []}']);
  check('2a //dmodule without a context: the LLM is asked, as before', general.asked.length === 1);
}

// ─── Part 2.2: nothing the rule forbids exists in its context schema ────────
{
  const { result, asked, verdict, proposalChecks } = await generate(EXT272, [], 'BRDP-EXT-00272');
  check('2b EXT-00272: no LLM call', asked.length === 0 && proposalChecks.length === 0, asked.length);
  check('2b EXT-00272: covered by the schema', verdict?.kind === 'schema_covered' && verdict.items[0].kind === 'absentInContext', JSON.stringify(verdict));
  check('2b EXT-00272: text EN', formatCoverageItem(verdict.items[0], en) === 'the ipd schema has no <footnote> or <footnoteRef>', formatCoverageItem(verdict.items[0], en));
  check('2b EXT-00272: text ES', formatCoverageItem(verdict.items[0], es) === 'en el esquema ipd no existen <footnote> ni <footnoteRef>', formatCoverageItem(verdict.items[0], es));
  check('2b EXT-00272: minimal ipd document shown, accepted', result.examples.length === 1 && result.examples[0].schema === 'ipd' && result.runs[0].result.status === 'accepted');
  check('2b EXT-00272: its note names what the rule looks for', result.examples[0].absentNames.join() === 'footnote,footnoteRef');
  check('2b note EN/ES', en('records.ruleTest.minimalDocumentAbsent', { schema: 'ipd', root: 'dmodule', names: '<footnote>, <footnoteRef>' }).endsWith('the rule looks for <footnote>, <footnoteRef>, which no ipd document can contain.')
    && es('records.ruleTest.minimalDocumentAbsent', { schema: 'ipd', root: 'dmodule', names: '<footnote>' }).endsWith('la regla busca <footnote>, que ningún documento ipd puede contener.'));
  check('2b one element: singular text', formatCoverageItem({ kind: 'absentInContext', schema: 'ipd', names: ['footnote'] }, es) === 'en el esquema ipd no existe <footnote>');
  // One of them exists in ipd: a normal test.
  const mixed = await generate(inContext('ipd', sor('//footnote | //para', 'x')), ['{"examples": []}']);
  check('2b //footnote | //para in ipd: tested as today (LLM asked)', mixed.asked.length === 1);
  // A general rule with an element that does not exist: as before.
  const general = await generate(sor('//footnote', 'x'), ['{"examples": []}']);
  check('2b general rule: as before (LLM asked)', general.asked.length === 1);
}

// ─── Part 2.3: a default namespace on the content ───────────────────────────
{
  check('2c strip default xmlns', stripDefaultNamespace('<dmodule xmlns="http://www.s1000d.org/S1000D_4-2"><a/></dmodule>').text === '<dmodule><a/></dmodule>');
  const kept = '<dmodule xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><a/></dmodule>';
  check('2c prefixed declarations untouched', stripDefaultNamespace(kept).text === kept && stripDefaultNamespace(kept).removed.length === 0);
  check('2c nested default xmlns untouched', stripDefaultNamespace('<a><b xmlns="u"/></a>').removed.length === 0);
  check('2c both declarations: only the default one goes', stripDefaultNamespace('<a xmlns:xlink="x" xmlns="u"/>').text === '<a xmlns:xlink="x"/>');
  const rule = sor('//dmodule', 'x');
  const prep = await setupFor(rule);
  const setup = { ...prep.setup, standard: S42 };
  const content = `<dmodule xmlns="http://www.s1000d.org/S1000D_4-2" xmlns:xlink="http://www.w3.org/1999/xlink">${metadataXml(prep.promptPlacements[0].metadata.tree).xml}<content><description><levelledPara><para>Text.</para></levelledPara></description></content></dmodule>`;
  const m = materializeExample({ label: 'whole', expected: 'reject', schema: 'descript', content }, setup, parseXml);
  check('2c namespace removed, noted', m.namespacesRemoved.join() === 'http://www.s1000d.org/S1000D_4-2' && !m.content.includes('xmlns="') && m.content.includes('xmlns:xlink='), JSON.stringify(m.namespacesRemoved));
  const r = runExample(rule, F, m, { vocabulary, parseXml, schemaLocation: 'flat' });
  check('2c //dmodule selects it', r.result?.status === 'rejected' && r.result.selectedNodePaths.length === 1, JSON.stringify(r.result));
  check('2c note EN/ES', en('records.ruleTest.namespaceRemoved', { namespace: 'u' }) === 'Adjusted by the app: removed xmlns="u" (S1000D uses no namespace).' && es('records.ruleTest.namespaceRemoved', { namespace: 'u' }) === 'Ajustado por la app: se quitó xmlns="u" (S1000D no usa espacio de nombres).');
  const dita = materializeExample({ label: 'x', expected: 'accept', schema: 'descript', content: '<p xmlns="u">x</p>' }, { ...setup, standard: 'DITA 1.3 Xpath2.0' }, parseXml);
  check('2c DITA unchanged', dita.content === '<p xmlns="u">x</p>' && dita.namespacesRemoved.length === 0);
}

// ─── Part 2.4: an example without content ───────────────────────────────────
{
  const parsed = parseRuleTestResponse('{"examples": [{"label": "a", "expected": "accept", "schema": "descript", "content": "<para>x</para>"}, {"label": "b", "expected": "reject", "schema": "descript"}]}');
  check('2d parser keeps an example without content', parsed.ok && parsed.examples.length === 2 && parsed.examples[1].noContent === true, JSON.stringify(parsed));
  const useless = parseRuleTestResponse('{"examples": [{"label": "a", "expected": "accept", "schema": "descript"}]}');
  check('2d parser: no example with content → error', !useless.ok && /no "content"/.test(useless.error), JSON.stringify(useless));
  const accept = { label: 'with emphasis elsewhere', expected: 'accept', schema: 'descript', content: 'Remove the cover.' };
  const rule = sor('//emphasis', 'x');
  const first = { examples: [accept, { label: 'with emphasis', expected: 'reject', schema: 'descript' }] };
  const second = { examples: [accept, { label: 'with emphasis', expected: 'reject', schema: 'descript', content: 'Do <emphasis>not</emphasis> remove.' }] };
  const { result, asked, verdict } = await generate(rule, [first, second]);
  check('2d the test goes on: one correction round', asked.length === 2 && asked[1].messages.at(-1).content.includes('Example 2 ("with emphasis"):\n- the example has no "content": write it'), asked[1]?.messages.at(-1).content);
  check('2d corrected and run', result.status === 'ready' && result.runs[1].result?.status === 'rejected' && verdict?.kind === 'correct', JSON.stringify(verdict));
  check('2d panel text EN/ES', en('records.ruleTest.missingContent') === 'the example has no content' && es('records.ruleTest.missingContent') === 'el ejemplo no tiene contenido');
}

// ─── Rules without these patterns: placement unchanged ──────────────────────
{
  const rules = [sor('//emphasis', 'x'), sor('//para[@id]', 'x'), sor('//internalRef[@internalRefId = "x"]', 'x'), sor('//dmStatus/@issueType', 'x')];
  for (const rule of rules) {
    const t = ruleTargets(rule);
    check(`no pattern: ${rule.slice(0, 80)}`, t.references.length === 0 && t.chains.length === 0 && t.looseAttributes.length === 0);
  }
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
