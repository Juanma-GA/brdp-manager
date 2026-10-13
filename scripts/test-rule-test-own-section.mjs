// Test de reglas: condiciones sobre la sección de identificación del propio
// documento (BRDP-EXT-00134 of the default S1000D 4.2 BREX, verbatim from
// scripts/rule-test-fixtures/default-brex-4-2.json) on the REAL S1000D 4.2
// and 3.0.1 structures. The LLM is a fake with fixed examples: what is
// tested is the application's part -- the value conditions read from the
// rule, the minimal section with the values, the section always present,
// the values set in a section the LLM wrote, and "not executable" when a
// value cannot be set (Part 2).
//   node scripts/test-rule-test-own-section.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { generateRuleTestExamples, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { ruleTestVerdict } from '../src/utils/ruleTest.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { assembleExample, metadataXml } from '../src/utils/ruleTestSkeleton.js';
import {
  ownSectionConditions,
  resolveOwnSectionValues,
  sectionTreeWithValues,
  sectionValuesLabel,
  setSectionValuesInDocument,
  setSectionValuesInText,
} from '../src/utils/ownSectionValues.js';
import { formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
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
const S301 = 'S1000D 3.0.1';
const FORMAT = { [S42]: 'BREX-4.2', [S301]: 'BREX-3.0.1' };
const RULES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/default-brex-4-2.json', import.meta.url))).rules;
const EXT134 = RULES['BRDP-EXT-00134'].rule_xml;
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (std, schema) => STRUCTURES[`${std}|${schema}`];
const vocabularyOf = (file) => {
  const v = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(v.elements), attributes: new Set(v.attributes) };
};
const VOCAB = { [S42]: vocabularyOf('schema-vocabulary-4-2.json'), [S301]: vocabularyOf('schema-vocabulary-3-0-1.json') };
const CARDS = {
  [S42]: JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-4-2.json', import.meta.url))),
  [S301]: JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-3-0-1.json', import.meta.url))),
};
const fetchersFor = (std) => {
  const graph = schemaGraph(std);
  return {
    fetchSchemaCards: async (_s, names) => ({
      cards: Object.fromEntries(names.filter((n) => CARDS[std].cards[n]).map((n) => [n, { variants: CARDS[std].cards[n], parents: CARDS[std].parents[n] || [] }])),
      document_schemas: graph.schemas,
    }),
    fetchStructure: async (_s, schema) => (structureOf(std, schema) ? { available: true, ...structureOf(std, schema) } : { available: false }),
    fetchSchemaGraph: async () => graph,
  };
};
const brdp = (id) => ({ identifier: id, title: 't', definition: 'd', proposal: 'p' });
async function generate(ruleXml, answers, std = S42) {
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml, format: FORMAT[std], standard: std, schemaLocation: 'flat', brdp: brdp('BRDP-X'), vocabulary: VOCAB[std], parseXml, ...fetchersFor(std),
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      const answer = answers[asked.length - 1];
      if (answer === undefined) throw new Error('unexpected LLM call');
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
  const verdict = result?.status === 'ready' ? ruleTestVerdict(result.examples, result.runs, null, null, null, result.coverage) : null;
  return { result, asked, verdict };
}
const setupFor = (ruleXml, std = S42) => prepareRuleTestSetup({ ruleXml, standard: std, schemaLocation: 'flat', ...fetchersFor(std), format: FORMAT[std], parseXml });
const sor = (path, flag = 0) => `<structureObjectRule><objectPath allowedObjectFlag="${flag}">${path}</objectPath><objectUse>x</objectUse></structureObjectRule>`;
const objrule = (path) => `<objrule><objpath objappl="0">${path}</objpath><objuse>x</objuse></objrule>`;
const COMREP = structureOf(S42, 'comrep');
const DESCRIPT42 = structureOf(S42, 'descript');
const DESCRIPT301 = structureOf(S301, 'descript');
const resolve = (ruleXml, structure) => resolveOwnSectionValues(ownSectionConditions(ruleXml), structure, structure.skeleton.metadata);

// ─── 1. Which conditions count ──────────────────────────────────────────────
{
  const r = resolve(EXT134, COMREP);
  check('1 EXT-00134: one value', r.values.length === 1 && r.unavailable.length === 0, JSON.stringify(r));
  const v = r.values[0];
  check('1 EXT-00134: @infoCode="0A2" on the own <dmCode>', v?.attribute === 'infoCode' && v.value === '0A2' && v.element === 'dmCode', JSON.stringify(v));
  check('1 EXT-00134: path from the section', v?.path.map((s) => s.name).join('/') === 'identAndStatusSection/dmAddress/dmIdent/dmCode', JSON.stringify(v?.path));
  check('1 EXT-00134: the minimal section had 040', v?.original === '040', JSON.stringify(v));
}
const FORMS = [
  ['@ and double quotes', `//para[ancestor::dmodule/identAndStatusSection/dmAddress/dmIdent/dmCode[@infoCode="0A2"]]`],
  ['attribute:: and single quotes', `//para[ancestor::dmodule[child::identAndStatusSection[child::dmAddress[child::dmIdent[child::dmCode[attribute::infoCode='0A2']]]]]]`],
  ['= with a path to the attribute', `//para[ancestor::dmodule/identAndStatusSection/dmAddress/dmIdent/dmCode/@infoCode = '0A2']`],
  ['value on the left', `//para[ancestor::dmodule//dmIdent/dmCode[ "0A2" = @infoCode ]]`],
  ['absolute path in the predicate', `//para[/dmodule/identAndStatusSection/dmAddress/dmIdent/dmCode/@infoCode = "0A2"]`],
  ['predicate of an earlier step', `//dmodule[identAndStatusSection/dmAddress/dmIdent/dmCode/@infoCode = "0A2"]//para`],
  ['eq', `//para[ancestor::dmodule//dmIdent/dmCode/@infoCode eq "0A2"]`],
];
for (const [name, path] of FORMS) {
  const r = resolve(sor(path), DESCRIPT42);
  check(`1 form ${name}: infoCode 0A2 on the own dmCode`, r.values.length === 1 && r.values[0].value === '0A2' && r.values[0].path.map((s) => s.name).join('/') === 'identAndStatusSection/dmAddress/dmIdent/dmCode', JSON.stringify(r));
}
const NONE = [
  ['negated value', `//para[ancestor::dmodule[not(descendant::identAndStatusSection/dmAddress/dmIdent/dmCode[@infoCode="0A2"])]]`],
  ['negated attribute test', `//para[ancestor::dmodule//dmIdent/dmCode[not(@infoCode = '0A2')]]`],
  ['!=', `//para[ancestor::dmodule//dmIdent/dmCode/@infoCode != '0A2']`],
  ['value under or', `//para[ancestor::dmodule//dmIdent/dmCode/@infoCode = '0A2' or ancestor::dmodule//dmIdent/dmCode/@infoCode = '0A3']`],
  ['the decision itself', `//dmIdent/dmCode[@infoCode = "0A2"]`],
  ['inside the checked node', `//dmIdent[dmCode/@infoCode = "0A2"]`],
  ['S1-00052 (the attribute is the path)', `//dmIdent/dmCode/@infoCode`],
  ['a reference of the content', `//dmRef[dmRefIdent/dmCode/@infoCode = "055"]`],
  ['ambiguous (own code and the brexDmRef)', `//para[ancestor::dmodule//dmCode/@infoCode = "0A2"]`],
  ['content only', `//emphasis`],
  ['top-level comparison of a condition', `//dmStatus/@issueType = "changed" and //para`],
];
for (const [name, path] of NONE) {
  const r = resolve(sor(path), DESCRIPT42);
  check(`1 none: ${name}`, r.values.length === 0 && r.unavailable.length === 0, JSON.stringify(r));
}
{
  // Another attribute of the checked node is a condition for it to apply.
  const r = resolve(sor(`//dmIdent/dmCode[@infoCode = "0A2"]/@assyCode`), DESCRIPT42);
  check('1 condition on another attribute of the checked node', r.values.length === 1 && r.values[0].attribute === 'infoCode', JSON.stringify(r));
  // The checked node is the root: the whole document is below it.
  const root = resolve(sor(`//dmodule[descendant::identAndStatusSection/dmAddress/dmIdent/dmCode[@infoCode='0A2'] and not(descendant::referencedApplicGroup)]`), COMREP);
  check('1 checked root: the condition counts', root.values.length === 1, JSON.stringify(root));
}
{
  // CIR EXT-00014…00025: the value is on the checked <updateCode> itself.
  for (const n of [14, 17, 19, 20, 22, 23, 25]) {
    const ruleXml = RULES[`BRDP-EXT-${String(n).padStart(5, '0')}`].rule_xml;
    const r = resolveOwnSectionValues(ownSectionConditions(ruleXml), structureOf(S42, 'update'), structureOf(S42, 'update').skeleton.metadata);
    check(`1 CIR EXT-000${n}: no changes`, r.values.length === 0 && r.unavailable.length === 0, JSON.stringify(r));
  }
}
{
  // 3.0.1: <incode> is an element; its text is the value.
  for (const path of [`//para[ancestor::dmodule/idstatus/dmaddres/dmc/avee[incode="0A2"]]`, `//para[ancestor::dmodule/idstatus/dmaddres/dmc/avee/incode = '0A2']`]) {
    const r = resolve(objrule(path), DESCRIPT301);
    check(`1 3.0.1 ${path}`, r.values.length === 1 && r.values[0].attribute === null && r.values[0].element === 'incode' && r.values[0].original === '040', JSON.stringify(r));
  }
  // The brexref's <avee> also has <incode>: //avee alone is ambiguous.
  const r = resolve(objrule(`//para[ancestor::dmodule//avee[incode="0A2"]]`), DESCRIPT301);
  check('1 3.0.1 //avee ambiguous: no changes', r.values.length === 0, JSON.stringify(r));
}
{
  // Part 2: a value the minimal section has no node for.
  const r = resolve(sor(`//para[ancestor::dmodule/identAndStatusSection/dmStatus/applicRef/@applicRefId = 'app-01']`), DESCRIPT42);
  check('1 no node in the minimal section: unavailable', r.values.length === 0 && r.unavailable.length === 1 && r.unavailable[0].attribute === 'applicRefId', JSON.stringify(r));
  // A schema whose section the application does not build (3.0.1 ddn has none).
  const ddn = structureOf(S301, 'ddn');
  const none = resolveOwnSectionValues(ownSectionConditions(objrule(`//ddn[idstatus/dmaddres/dmc/avee/incode = "0A2"]`)), ddn, ddn.skeleton.metadata);
  check('1 3.0.1 ddn without a section: nothing (no idstatus there)', none.values.length === 0, JSON.stringify(none));
}

// ─── 2. Setting the values ──────────────────────────────────────────────────
{
  const { values } = resolve(EXT134, COMREP);
  const tree = sectionTreeWithValues(COMREP.skeleton.metadata.tree, values);
  const xml = metadataXml(tree, 0).xml;
  check('2 tree: own dmCode infoCode 0A2', /<dmIdent>\s*<dmCode [^>]*infoCode="0A2"/.test(xml), xml);
  check('2 tree: brexDmRef keeps 022', /<dmRefIdent>\s*<dmCode [^>]*infoCode="022"/.test(xml), xml);
  check('2 tree: a copy (the skeleton is untouched)', /infoCode="040"/.test(metadataXml(COMREP.skeleton.metadata.tree, 0).xml));
  const written = metadataXml(COMREP.skeleton.metadata.tree, 0).xml;
  const forced = setSectionValuesInText(written, values, { force: true });
  check('2 text, force: set', forced.set.length === 1 && /<dmIdent>\s*<dmCode [^>]*infoCode="0A2"/.test(forced.text), forced.text);
  check('2 text: only that attribute changes', forced.text.replace('infoCode="0A2"', 'infoCode="040"') === written);
  const other = written.replace(/(<dmIdent>\s*<dmCode [^>]*)infoCode="040"/, '$1infoCode="0A3"');
  check('2 text, accept with another value: kept', setSectionValuesInText(other, values, { force: false }).set.length === 0);
  check('2 text, reject with another value: set', setSectionValuesInText(other, values, { force: true }).set.length === 1);
  check('2 text, accept with the minimal value: set', setSectionValuesInText(written, values, { force: false }).set.length === 1);
  const missing = written.replace(/(<dmIdent>\s*<dmCode [^>]*) infoCode="040"/, '$1');
  const added = setSectionValuesInText(missing, values, { force: false });
  check('2 text, accept without the attribute: added', added.set.length === 1 && /<dmIdent>\s*<dmCode [^>]*infoCode="0A2"/.test(added.text), added.text);
  check('2 text, without the element: missing', setSectionValuesInText('<identAndStatusSection/>', values, { force: true }).missing.length === 1);
  check('2 label', sectionValuesLabel(values) === '<dmCode infoCode="0A2">', sectionValuesLabel(values));
  // 3.0.1 text value.
  const r301 = resolve(objrule(`//para[ancestor::dmodule/idstatus/dmaddres/dmc/avee/incode = '0A2']`), DESCRIPT301);
  const w301 = metadataXml(DESCRIPT301.skeleton.metadata.tree, 0).xml;
  const s301 = setSectionValuesInText(w301, r301.values, { force: true });
  check('2 3.0.1: dmc/avee/incode 0A2, brexref keeps 022', /<dmc>\s*<avee>[\s\S]*?<incode>0A2<\/incode>/.test(s301.text) && /<refdm>\s*<avee>[\s\S]*?<incode>022<\/incode>/.test(s301.text), s301.text);
  check('2 3.0.1 label', sectionValuesLabel(r301.values) === '<incode>0A2</incode>');
  // Whole document: set in its section, or the minimal one written.
  const sectionXml = metadataXml(sectionTreeWithValues(COMREP.skeleton.metadata.tree, values), 1).xml;
  const doc = `<dmodule>\n  ${written}\n  <content/>\n</dmodule>`;
  const inDoc = setSectionValuesInDocument(doc, 'dmodule', sectionXml, values, { force: true });
  check('2 whole document with a section: set', !inDoc.built && inDoc.set.length === 1 && /<dmIdent>\s*<dmCode [^>]*infoCode="0A2"/.test(inDoc.text), inDoc.text);
  const bare = setSectionValuesInDocument('<dmodule><content/></dmodule>', 'dmodule', sectionXml, values, { force: false });
  check('2 whole document without a section: the minimal one written first', bare.built && /^<dmodule>\n\s*<identAndStatusSection>[\s\S]*infoCode="0A2"[\s\S]*<\/identAndStatusSection><content\/><\/dmodule>$/.test(bare.text), bare.text);
}

// ─── 3. EXT-00134 end to end ────────────────────────────────────────────────
const SEC040 = metadataXml(COMREP.skeleton.metadata.tree, 1).xml.trimStart();
const SEC_REJECT = SEC040.replace(/(<simplePara>All<\/simplePara>\s*<\/displayText>)/, '$1<expression><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></expression>');
const REPO = '<commonRepository><warningRepository><warningSpec><warningIdent warningIdentNumber="W-001"/><warningAndCautionPara>Do not touch.</warningAndCautionPara></warningSpec></warningRepository></commonRepository>';
const ACCEPT_CONTENT = `<content>${REPO}<referencedApplicGroup><applic id="app-0001"><displayText><simplePara>Model A</simplePara></displayText><expression><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></expression></applic></referencedApplicGroup></content>`;
const REJECT_CONTENT = `<content>${REPO}<referencedApplicGroup><applic id="app-0001"><displayText><simplePara>Model A</simplePara></displayText><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></applic></referencedApplicGroup></content>`;
check('3 fixture: reject section has an <expression> in dmStatus/applic', SEC_REJECT !== SEC040);
{
  const setup = await setupFor(EXT134);
  const p = setup.promptPlacements.find((x) => x.role === 'rule');
  check('3 EXT-00134: comrep, content at the root', p?.schema === 'comrep' && p.insertion === 'dmodule' && p.metadata?.insertion === true, JSON.stringify({ s: p?.schema, i: p?.insertion }));
  check('3 EXT-00134: the placement carries the value', p?.metadata?.values?.length === 1);
  const prompt = buildRuleTestExamplesPrompt({ brdp: brdp('BRDP-EXT-00134'), ruleXml: EXT134, format: 'BREX-4.2', standard: S42, contextSchemas: setup.contextSchemas, placements: setup.promptPlacements, schemaFacts: setup.schemaFacts });
  check('3 prompt: the minimal section shows infoCode 0A2', /<dmIdent>\s*<dmCode [^>]*infoCode="0A2"/.test(prompt));
  check('3 prompt: says which values the section has', prompt.includes('The rule applies only to a data module whose identification and status section\n  has @infoCode="0A2" on <dmCode> (identAndStatusSection/dmAddress/dmIdent/dmCode); the minimal section above already has it.'), prompt);
}
for (const [variant, acceptMeta] of [['the LLM kept infoCode 040', SEC040], ['no section from the LLM', undefined]]) {
  const answer = {
    examples: [
      { label: 'expression in referencedApplicGroup', expected: 'accept', schema: 'comrep', ...(acceptMeta ? { metadata: acceptMeta } : {}), content: ACCEPT_CONTENT },
      { label: 'expression in dmStatus', expected: 'reject', schema: 'comrep', metadata: SEC_REJECT, content: REJECT_CONTENT },
    ],
  };
  const { result, asked, verdict } = await generate(EXT134, [answer]);
  check(`3 ${variant}: one LLM call`, asked.length === 1, asked.length);
  check(`3 ${variant}: correct verdict`, verdict?.kind === 'correct', JSON.stringify(verdict));
  const [acc, rej] = result.examples;
  check(`3 ${variant}: accept accepted`, result.runs[0].result?.status === 'accepted', JSON.stringify(result.runs[0].result));
  check(`3 ${variant}: reject rejected`, result.runs[1].result?.status === 'rejected', JSON.stringify(result.runs[1].result));
  check(`3 ${variant}: the section is in every document`, result.examples.every((e) => /<identAndStatusSection>/.test(e.xml)));
  check(`3 ${variant}: the own dmCode has 0A2 in every document`, result.examples.every((e) => /<dmIdent>\s*<dmCode [^>]*infoCode="0A2"/.test(e.xml)));
  check(`3 ${variant}: reject note`, rej.sectionValuesSet?.length === 1 && !rej.sectionBuilt, JSON.stringify({ s: rej.sectionValuesSet, b: rej.sectionBuilt }));
  if (acceptMeta) check(`3 ${variant}: accept note (value set)`, acc.sectionValuesSet?.length === 1, JSON.stringify(acc.sectionValuesSet));
  else check(`3 ${variant}: accept note (section written by the app)`, acc.sectionBuilt?.length === 1 && !acc.sectionValuesSet, JSON.stringify(acc));
}
{
  // An example meant to be accepted with another value: a document the rule
  // does not apply to -- kept.
  const other = SEC040.replace(/(<dmIdent>\s*<dmCode [^>]*)infoCode="040"/, '$1infoCode="0A3"');
  const answer = {
    examples: [
      { label: 'not a repository', expected: 'accept', schema: 'comrep', metadata: other.replace(/(<simplePara>All<\/simplePara>\s*<\/displayText>)/, '$1<expression><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></expression>'), content: REJECT_CONTENT },
      { label: 'expression in dmStatus', expected: 'reject', schema: 'comrep', metadata: SEC_REJECT, content: REJECT_CONTENT },
    ],
  };
  const { result, verdict } = await generate(EXT134, [answer]);
  check('3 accept with infoCode 0A3: kept, no note', !result.examples[0].sectionValuesSet && /infoCode="0A3"/.test(result.examples[0].xml));
  check('3 accept with infoCode 0A3: accepted (the rule does not apply)', result.runs[0].result?.status === 'accepted');
  check('3 accept with infoCode 0A3: correct verdict', verdict?.kind === 'correct', JSON.stringify(verdict));
}
{
  // The insertion point is the root: the section used to be dropped.
  const p = (await setupFor(EXT134)).promptPlacements.find((x) => x.role === 'rule');
  const { xml } = assembleExample({ standard: S42, schema: 'comrep', schemaLocation: 'flat', placement: p, content: '<content/>', metadata: SEC040 });
  check('3 root insertion: section then content', /<dmodule [^>]*>\n\s*<identAndStatusSection>[\s\S]*<\/identAndStatusSection>\n\s*<content\/>\n<\/dmodule>$/.test(xml), xml);
}

// ─── 4. Whole document (the rule checks the root) ───────────────────────────
{
  const rootRule = sor(`//dmodule[descendant::identAndStatusSection/dmAddress/dmIdent/dmCode[@infoCode='0A2'] and descendant::commonRepository and not(descendant::referencedApplicGroup)]`);
  const setup = await setupFor(rootRule);
  const p = setup.promptPlacements.find((x) => x.role === 'rule');
  check('4 whole document placement with the value', p && p.path.length === 0 && p.metadata?.values?.length === 1, JSON.stringify({ path: p?.path, v: p?.metadata?.values }));
  const answer = {
    examples: [
      { label: 'with a group', expected: 'accept', schema: p.schema, content: `<dmodule>${ACCEPT_CONTENT}</dmodule>` },
      { label: 'without a group', expected: 'reject', schema: p.schema, content: `<dmodule><content>${REPO}</content></dmodule>` },
    ],
  };
  const { result, verdict } = await generate(rootRule, [answer]);
  check('4 whole document: the section written in both', result.examples.every((e) => e.sectionBuilt?.length === 1 && /<identAndStatusSection>[\s\S]*infoCode="0A2"/.test(e.xml)), JSON.stringify(result.examples.map((e) => e.xml)));
  check('4 whole document: correct verdict', verdict?.kind === 'correct', JSON.stringify(verdict));
}

// ─── 5. 3.0.1 ───────────────────────────────────────────────────────────────
{
  const rule301 = objrule(`//para[ancestor::dmodule/idstatus/dmaddres/dmc/avee[incode="0A2"]]`);
  const setup = await setupFor(rule301, S301);
  const p = setup.promptPlacements.find((x) => x.role === 'rule');
  check('5 3.0.1: placement with the value', p?.metadata?.values?.length === 1 && p.metadata.values[0].element === 'incode', JSON.stringify(p?.metadata?.values));
  const sec301 = metadataXml(structureOf(S301, p.schema).skeleton.metadata.tree, 1).xml.trimStart();
  const other = sec301.replace(/(<dmc>\s*<avee>[\s\S]*?)<incode>040<\/incode>/, '$1<incode>041</incode>');
  check('5 3.0.1 fixture', other !== sec301);
  const answer = {
    examples: [
      { label: 'other info code', expected: 'accept', schema: p.schema, metadata: other, content: '<para>Text.</para>' },
      { label: 'info code 0A2', expected: 'reject', schema: p.schema, content: '<para>Text.</para>' },
    ],
  };
  const { result, verdict } = await generate(rule301, [answer], S301);
  check('5 3.0.1: reject section written with <incode>0A2</incode>', result.examples[1].sectionBuilt?.length === 1 && /<dmc>\s*<avee>[\s\S]*?<incode>0A2<\/incode>/.test(result.examples[1].xml), result.examples[1].xml);
  check('5 3.0.1: accept keeps 041', /<incode>041<\/incode>/.test(result.examples[0].xml));
  check('5 3.0.1: correct verdict', verdict?.kind === 'correct', JSON.stringify(verdict));
}

// ─── 6. Outside the pattern: no changes ─────────────────────────────────────
{
  for (const ruleXml of [sor('//emphasis'), sor(`//para[ancestor::dmodule//dmIdent/dmCode[not(@infoCode = '0A2')]]`), RULES['BRDP-EXT-00014'].rule_xml]) {
    const setup = await setupFor(ruleXml);
    check('6 no values on any placement', setup.promptPlacements.every((p) => !p.metadata?.values), ruleXml.slice(0, 120));
    const prompt = buildRuleTestExamplesPrompt({ brdp: brdp('X'), ruleXml, format: 'BREX-4.2', standard: S42, contextSchemas: setup.contextSchemas, placements: setup.promptPlacements, schemaFacts: setup.schemaFacts });
    check('6 no "applies only" line', !prompt.includes('The rule applies only to a'), ruleXml.slice(0, 120));
  }
}

// ─── 7. Notes (EN/ES) ───────────────────────────────────────────────────────
check('7 note EN', en('records.ruleTest.sectionValuesSet', { values: '<dmCode infoCode="0A2">' }) === 'Adjusted by the app: the identification and status section has <dmCode infoCode="0A2">, the condition the rule asks for.');
check('7 note ES', es('records.ruleTest.sectionValuesSet', { values: '<dmCode infoCode="0A2">' }) === 'Ajustado por la app: la sección de identificación lleva <dmCode infoCode="0A2">, la condición que pide la regla.');
check('7 built EN', en('records.ruleTest.sectionBuilt', { values: '<dmCode infoCode="0A2">' }).startsWith('Written by the app: the example had no identification and status section'));
check('7 built ES', es('records.ruleTest.sectionBuilt', { values: '<dmCode infoCode="0A2">' }).startsWith('Escrita por la app: el ejemplo no traía la sección de identificación'));

// PART2-TESTS
void formatRuleTestReason;

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
