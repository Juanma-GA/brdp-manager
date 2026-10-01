// Configurable schema location (flat / master / custom pattern) -- the single
// URL generator, recognition in the three forms, pattern validation,
// Generate's rewriting of rule schema URLs (context blocks, allowed values,
// unrecognized values reported), the BREX DM's own brex.xsd, the Schematron
// export, and a rule test with context blocks in a custom-pattern project.
// Run: node scripts/test-schema-location.mjs
import fs from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  recognizeSchemaUrl,
  rewriteRuleSchemaUrls,
  schemaContextUrl,
  schemaLocationOf,
  schemaLocationOptions,
  schemaNameFromContext,
  contextSchemasOfRule,
  setDmoduleSchemaLocation,
  validateSchemaPattern,
  wrapRuleInSchemaContexts,
} from '../src/utils/ruleSchemaContext.js';
import { brexToSchematron } from '../src/api/brexToSchematron.js';
import { analyzeRule, runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { ruleTestVerdict } from '../src/utils/ruleTest.js';
import { retiredTemplateRows } from './lib/readXlsx.mjs';
import i18n from '../src/i18n/index.js';

// The 4.1 / 3.0.1 generators assemble as text; checkWellFormed and the
// Schematron converter use the browser's DOMParser -- here xmldom, with the
// one querySelector('parsererror') checkWellFormed reads. The 4.2 generator
// assembles with the browser DOM (querySelector) and is checked in the
// browser (scripts/verify-schema-location.mjs).
class NodeDOMParser {
  parseFromString(text) {
    const messages = [];
    const doc = new DOMParser({ errorHandler: (level, msg) => level !== 'warning' && messages.push(msg) }).parseFromString(text, 'text/xml');
    doc.querySelector = (selector) => (selector === 'parsererror' && messages.length ? { textContent: messages[0] } : null);
    return doc;
  }
}
globalThis.DOMParser = NodeDOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { generateBREX41 } = await import('../src/api/generateBREX41.js');
const { generateBREX301 } = await import('../src/api/generateBREX301.js');
const { generateBREXSch } = await import('../src/api/generateBREXSch.js');

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
  if (messages.length) throw new Error(messages[0].split('\n')[0]);
  return doc;
}

const S42 = 'S1000D 4.2';
const S41 = 'S1000D 4.1';
const S301 = 'S1000D 3.0.1';
const FLAT42 = (s) => `http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${s}.xsd`;
const REL = '../schemas/{schema}.xsd';
const LOCAL = 'file:///C:/CSDB/schemas/{schema}.xsd';
const V42 = '{schema}_v42.xsd';

// ─── Options per standard ───────────────────────────────────────────────────
check('options 3.0.1: flat, master, custom', schemaLocationOptions(S301).join() === 'flat,master,custom');
check('options 4.2: flat, custom (no master)', schemaLocationOptions(S42).join() === 'flat,custom');
check('options 4.1: flat, custom (no master)', schemaLocationOptions(S41).join() === 'flat,custom');
check('options DITA: none', schemaLocationOptions('DITA 1.3 Xpath2.0').length === 0);

// ─── Pattern validation ─────────────────────────────────────────────────────
const code = (p) => validateSchemaPattern(p)?.code || null;
check('valid: relative', code(REL) === null);
check('valid: file URL', code(LOCAL) === null);
check('valid: suffix', code(V42) === null);
check('invalid: empty', code('') === 'empty' && code('   ') === 'empty' && code(undefined) === 'empty');
check('invalid: no {schema}', code('../schemas/proced.xsd') === 'missing_placeholder');
check('invalid: {schema} twice', code('{schema}/{schema}.xsd') === 'repeated_placeholder');
check('invalid: line break', code('../schemas/\n{schema}.xsd') === 'line_break');
check('invalid: " ', code('../"{schema}.xsd') === 'forbidden_char' && validateSchemaPattern('../"{schema}.xsd').params.char === '"');
check('invalid: <', code('<{schema}.xsd') === 'forbidden_char');
check('invalid: &', code('a&b/{schema}.xsd') === 'forbidden_char');
for (const lng of ['en', 'es']) {
  const t = i18n.getFixedT(lng);
  for (const c of ['empty', 'missing_placeholder', 'repeated_placeholder', 'line_break']) {
    const text = t(`config.fields.schemaPatternErrors.${c}`);
    check(`${lng}: reason ${c}`, text && !text.startsWith('config.'), text);
  }
  const fc = t('config.fields.schemaPatternErrors.forbidden_char', { char: '"' });
  check(`${lng}: reason forbidden_char names the char`, fc.includes('"') && !fc.includes('{{'), fc);
}

// ─── The project's setting ──────────────────────────────────────────────────
check('absent -> flat', schemaLocationOf({}, S42) === 'flat' && schemaLocationOf(undefined, S301) === 'flat');
check('3.0.1 master kept', schemaLocationOf({ schemaLocation: 'master' }, S301) === 'master');
check('4.2 master (old data) -> flat', schemaLocationOf({ schemaLocation: 'master' }, S42) === 'flat');
check('4.1 master (old data) -> flat', schemaLocationOf({ schemaLocation: 'master' }, S41) === 'flat');
check('custom -> the pattern', schemaLocationOf({ schemaLocation: 'custom', schemaLocationPattern: ` ${REL} ` }, S42) === REL);
check('custom invalid -> flat', schemaLocationOf({ schemaLocation: 'custom', schemaLocationPattern: '../x.xsd' }, S42) === 'flat');
check('no standard: master kept (legacy callers)', schemaLocationOf({ schemaLocation: 'master' }) === 'master');

// ─── Generation and recognition, the three forms ────────────────────────────
check('flat URL', schemaContextUrl(S42, 'proced', 'flat') === FLAT42('proced'));
check('master URL 3.0.1', schemaContextUrl(S301, 'descript', 'master') === 'http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd');
check('custom URL relative', schemaContextUrl(S42, 'proced', REL) === '../schemas/proced.xsd');
check('custom URL file', schemaContextUrl(S42, 'descript', LOCAL) === 'file:///C:/CSDB/schemas/descript.xsd');
check('custom URL suffix', schemaContextUrl(S42, 'proced', V42) === 'proced_v42.xsd');
for (const [std, loc] of [[S42, 'flat'], [S41, 'flat'], [S301, 'flat'], [S301, 'master'], [S42, REL], [S41, LOCAL], [S301, V42]]) {
  const bad = ['proced', 'descript', 'pm', 'comment', 'appliccrossreftable', 'brex'].filter(
    (s) => recognizeSchemaUrl(schemaContextUrl(std, s, loc), std, loc) !== s
  );
  check(`round trip ${std} ${loc}`, bad.length === 0, bad.join(' '));
}
check('{schema}_v42.xsd: proced_v42.xsd -> proced', recognizeSchemaUrl('proced_v42.xsd', S42, V42) === 'proced');
check('lenient recognition uses the pattern first', schemaNameFromContext('proced_v42.xsd', V42) === 'proced' && schemaNameFromContext('proced_v42.xsd') === 'proced_v42');
check('flat recognized whatever the current setting', recognizeSchemaUrl(FLAT42('fault'), S42, REL) === 'fault');
check('master recognized on 4.x (old data)', recognizeSchemaUrl('http://www.s1000d.org/S1000D_4-2/xml_schema_master/dm/procedSchema.xsd', S42, 'flat') === 'proced');
check('master with a wrong folder: not recognized', recognizeSchemaUrl('http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/pm/descriptSchema.xsd', S301, 'master') === null);
check('another issue: not recognized', recognizeSchemaUrl(FLAT42('proced'), S41, 'flat') === null);
check('another pattern: not recognized', recognizeSchemaUrl('../other/proced.xsd', S42, REL) === null);
check('an old pattern, not the current one: not recognized', recognizeSchemaUrl('proced_v42.xsd', S42, REL) === null);
check('wrap with a custom pattern', wrapRuleInSchemaContexts('<structureObjectRule id="r"/>', 'BREX-4.2', S42, ['proced'], REL).includes('<contextRules rulesContext="../schemas/proced.xsd">'));
check('3.0.1 master wrap unchanged', wrapRuleInSchemaContexts('<objrule id="r"/>', 'BREX-3.0.1', S301, ['descript'], 'master').includes('<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd">'));
check('contextSchemasOfRule with the pattern', contextSchemasOfRule('<contextRules rulesContext="proced_v42.xsd"><structureObjectRuleGroup/></contextRules>', V42).schemas.join() === 'proced');
check('dmodule xsi rewritten', setDmoduleSchemaLocation(`<dmodule a="1" xsi:noNamespaceSchemaLocation="${FLAT42('brex')}" b="2">`, '../schemas/brex.xsd') === '<dmodule a="1" xsi:noNamespaceSchemaLocation="../schemas/brex.xsd" b="2">');

// ─── Generate rewriting (stored rule never changed) ─────────────────────────
const PROC_FLAT = `<contextRules rulesContext="${FLAT42('proced')}">\n  <structureObjectRuleGroup>\n    <structureObjectRule id="R1"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>u</objectUse></structureObjectRule>\n  </structureObjectRuleGroup>\n</contextRules>`;
{
  const r = rewriteRuleSchemaUrls(PROC_FLAT, 'BREX-4.2', S42, REL);
  check('flat rulesContext -> pattern', r.xml.includes('rulesContext="../schemas/proced.xsd"') && r.rewritten.length === 1 && r.unrecognized.length === 0, r.xml);
  check('flat rule under flat: nothing rewritten', rewriteRuleSchemaUrls(PROC_FLAT, 'BREX-4.2', S42, 'flat').rewritten.length === 0);
  check('the stored text is not touched', PROC_FLAT.includes(FLAT42('proced')));
  const unknown = PROC_FLAT.replace(FLAT42('proced'), 'urn:csdb:proced');
  const u = rewriteRuleSchemaUrls(unknown, 'BREX-4.2', S42, REL);
  check('unknown rulesContext: kept and reported', u.xml === unknown && u.unrecognized.length === 1 && u.unrecognized[0].value === 'urn:csdb:proced' && u.unrecognized[0].where === 'context');
  const commented = `<!-- old: rulesContext="${FLAT42('proced')}" -->\n${PROC_FLAT}`;
  const c = rewriteRuleSchemaUrls(commented, 'BREX-4.2', S42, REL);
  check('comments are left byte for byte', c.xml.startsWith(`<!-- old: rulesContext="${FLAT42('proced')}" -->`));
  const values = '<structureObjectRule id="E"><objectPath allowedObjectFlag="2">//@emphasisType</objectPath><objectUse>u</objectUse><objectValue valueForm="single" valueAllowed="em01"/></structureObjectRule>';
  check('ordinary values: not reported', rewriteRuleSchemaUrls(values, 'BREX-4.2', S42, REL).unrecognized.length === 0);
}
const S00006 = retiredTemplateRows().find((r) => r.ID === 'BRDP-S1-00006').Rule;
const s6Values = (S00006.match(/valueAllowed="/g) || []).length;
const s6Contexts = (S00006.match(/rulesContext="/g) || []).length;
{
  const r = rewriteRuleSchemaUrls(S00006, 'BREX-4.2', S42, LOCAL);
  check(`BRDP-S1-00006: all ${s6Values} valueAllowed rewritten`, r.rewritten.filter((x) => x.where === 'value').length === s6Values, JSON.stringify(r.rewritten.map((x) => x.to)));
  check(`BRDP-S1-00006: all ${s6Contexts} rulesContext rewritten`, r.rewritten.filter((x) => x.where === 'context').length === s6Contexts);
  check('BRDP-S1-00006: no flat URL left, nothing unrecognized', !r.xml.includes('xml_schema_flat') && r.unrecognized.length === 0);
  check('BRDP-S1-00006: brex.xsd follows too', r.xml.includes('valueAllowed="file:///C:/CSDB/schemas/brex.xsd"'));
  const foreign = S00006.replace(FLAT42('ddn'), 'http://example.com/ddn-2.xsd').replace(FLAT42('ipd'), 'ipd');
  const f = rewriteRuleSchemaUrls(foreign, 'BREX-4.2', S42, LOCAL);
  check('unrecognized values of a schema-location rule are reported', f.unrecognized.map((x) => x.value).join() === 'http://example.com/ddn-2.xsd,ipd', JSON.stringify(f.unrecognized));
}
{
  const r301 = `<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd"><structrules><objrule id="A"><objpath objappl="0">//@xsi:noNamespaceSchemaLocation</objpath><objuse>u</objuse><objval valtype="single" val1="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd"/></objrule></structrules></contextrules>`;
  const r = rewriteRuleSchemaUrls(r301, 'BREX-3.0.1', S301, 'master');
  check('3.0.1 master: context unchanged, objval val1 rewritten to master', r.rewritten.length === 1 && r.xml.includes('val1="http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/procedSchema.xsd"'), r.xml);
}

// The generators: stored rules in, rewritten output + report out.
const approvals = (list) => new Map(list.map((a) => [a.brdp_id, { status: 'approved', ...a }]));
const summary = (file) => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
{
  const to41 = (text) => text.replaceAll('S1000D_4-2', 'S1000D_4-1');
  const FLAT41 = (s) => `http://www.s1000d.org/S1000D_4-1/xml_schema_flat/${s}.xsd`;
  const brdps = [
    { id: 'a', identifier: 'BRDP-PROC', validation: 'Validated' },
    { id: 'b', identifier: 'BRDP-S1-00006', validation: 'Validated' },
    { id: 'c', identifier: 'BRDP-URN', validation: 'Validated' },
  ];
  const stored = [
    { brdp_id: 'a', rule_xml: to41(PROC_FLAT) },
    { brdp_id: 'b', rule_xml: to41(S00006) },
    { brdp_id: 'c', rule_xml: to41(PROC_FLAT).replace(FLAT41('proced'), 'urn:csdb:proced').replace('R1', 'R3') },
  ];
  const before = JSON.stringify(stored);
  const config = { modelIdentCode: 'ABC', schemaLocation: 'custom', schemaLocationPattern: REL };
  const opts = { approvals: approvals(stored), schemaSummary: summary('brex-schema-summary-4-1.json') };
  const out = await generateBREX41(brdps, config, opts);
  check('Generate: well formed', out.valid, out.error);
  check('Generate: rulesContext in the project form', out.xml.includes('rulesContext="../schemas/proced.xsd"'));
  check('Generate: BREX DM brex.xsd in the project form', /<dmodule\b[^>]*xsi:noNamespaceSchemaLocation="\.\.\/schemas\/brex\.xsd"/.test(out.xml));
  check('Generate: no flat URL left', !out.xml.includes('xml_schema_flat'));
  check('Generate: report lists the rewritten rules', out.schemaUrls.rewritten.map((r) => r.identifier).join() === 'BRDP-PROC,BRDP-S1-00006', JSON.stringify(out.schemaUrls));
  check('Generate: S1-00006 values listed', out.schemaUrls.rewritten[1]?.values.filter((v) => v.where === 'value').length === s6Values);
  check('Generate: unrecognized rule listed, left as written', out.schemaUrls.unrecognized[0]?.identifier === 'BRDP-URN' && out.xml.includes('rulesContext="urn:csdb:proced"'));
  check('Generate: stored rules unchanged', JSON.stringify(stored) === before);
  const sch = await generateBREXSch(brdps, config, { baseGenerator: generateBREX41, ...opts });
  check('Schematron: the condition uses the pattern path', sch.xml.includes("@xsi:noNamespaceSchemaLocation = '../schemas/proced.xsd'"), (sch.xml.match(/noNamespaceSchemaLocation = [^)]*/g) || []).join(' | '));
  check('Schematron: no flat URL left, report carried', !sch.xml.includes('xml_schema_flat') && sch.schemaUrls.rewritten.length === 2);
  check('Schematron: S1-00006 allowed values use the pattern', sch.xml.includes("'../schemas/descript.xsd'"));
  const flatOut = await generateBREX41(brdps.slice(0, 1), { modelIdentCode: 'ABC' }, opts);
  check('flat: unchanged output, empty report', flatOut.xml.includes(`rulesContext="${FLAT41('proced')}"`) && flatOut.schemaUrls.rewritten.length === 0 && /xsi:noNamespaceSchemaLocation="http:\/\/www\.s1000d\.org\/S1000D_4-1\/xml_schema_flat\/brex\.xsd"/.test(flatOut.xml));
  const oldMaster = await generateBREX41(brdps.slice(0, 1), { modelIdentCode: 'ABC', schemaLocation: 'master' }, opts);
  check('4.x with old "master" stored: generated as flat', oldMaster.schemaUrls.location === 'flat' && oldMaster.xml.includes(FLAT41('proced')));
}
{
  const rule41 = PROC_FLAT.replaceAll('4-2', '4-1');
  const out = await generateBREX41([{ id: 'a', identifier: 'BRDP-41', validation: 'Validated' }], { modelIdentCode: 'ABC', schemaLocation: 'custom', schemaLocationPattern: V42 }, { approvals: approvals([{ brdp_id: 'a', rule_xml: rule41 }]), schemaSummary: summary('brex-schema-summary-4-1.json') });
  check('4.1 Generate: pattern + brex.xsd', out.valid && out.xml.includes('rulesContext="proced_v42.xsd"') && /xsi:noNamespaceSchemaLocation="brex_v42\.xsd"/.test(out.xml), out.error);
}
{
  const rule301 = '<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/descript.xsd"><structrules><objrule id="A"><objpath objappl="0">//emphasis</objpath><objuse>u</objuse></objrule></structrules></contextrules>';
  const out = await generateBREX301([{ id: 'a', identifier: 'BRDP-301', validation: 'Validated' }], { modelIdentCode: 'ABC', schemaLocation: 'master' }, { approvals: approvals([{ brdp_id: 'a', rule_xml: rule301 }]), schemaSummary: summary('brex-schema-summary-3-0-1.json') });
  check('3.0.1 master Generate: context in master form', out.valid && out.xml.includes('context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd"'), out.error);
  check('3.0.1 master Generate: brex.xsd in master form', /xsi:noNamespaceSchemaLocation="http:\/\/www\.s1000d\.org\/S1000D_3-0-1\/xml_schema_master\/dm\/brexSchema\.xsd"/.test(out.xml));
}

// ─── Rule test in a custom-pattern project ──────────────────────────────────
{
  const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
  const vocab = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-4-2.json', import.meta.url)));
  const vocabulary = { elements: new Set(vocab.elements), attributes: new Set(vocab.attributes) };
  const inner = '<structureObjectRule id="R1"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis in procedures.</objectUse></structureObjectRule>';
  for (const pattern of [REL, V42]) {
    const ruleXml = wrapRuleInSchemaContexts(inner, 'BREX-4.2', S42, ['proced'], pattern);
    const g = await generateRuleTestExamples({
      ruleXml, format: 'BREX-4.2', standard: S42, schemaLocation: pattern,
      brdp: { identifier: 'BRDP-LOC', title: 'Emphasis in procedures', definition: 'd', proposal: 'In procedural data modules, <emphasis> shall not be used.' },
      vocabulary, parseXml,
      ask: async () => JSON.stringify({ proposalMismatch: null, examples: [
        { label: 'plain', expected: 'accept', schema: 'proced', content: 'Open the panel.' },
        { label: 'emphasis', expected: 'reject', schema: 'proced', content: 'Open the <emphasis>panel</emphasis>.' },
        { label: 'descript', expected: 'accept', schema: 'descript', content: 'The <emphasis>panel</emphasis>.' },
      ] }),
      fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript', 'proced'] }),
      fetchStructure: async (_std, schema) => ({ available: true, ...STRUCTURES[`${S42}|${schema}`] }),
    });
    const verdict = ruleTestVerdict(g.examples, g.runs, analyzeRule(ruleXml, 'BREX-4.2', { parseXml }));
    check(`rule test ${pattern}: examples carry the project's schema URL`, g.examples[0].xml.includes(`xsi:noNamespaceSchemaLocation="${schemaContextUrl(S42, 'proced', pattern)}"`), g.examples[0].xml.slice(0, 300));
    check(`rule test ${pattern}: verdict correct`, verdict.kind === 'correct', JSON.stringify({ verdict, runs: g.runs.map((r) => r.result?.status) }));
    check(`rule test ${pattern}: descript is out of scope`, (g.runs[2].result?.outOfScopeSchemas || []).includes('proced'), JSON.stringify(g.runs[2].result));
  }
  // The engine on a document whose own xsi carries the pattern (no schema given).
  const ruleXml = wrapRuleInSchemaContexts(inner, 'BREX-4.2', S42, ['proced'], V42);
  const doc = '<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="proced_v42.xsd"><content><para><emphasis>x</emphasis></para></content></dmodule>';
  check('engine: schema read from the pattern xsi', runRuleOnFragment(ruleXml, 'BREX-4.2', doc, null, { parseXml, schemaLocation: V42 }).status === 'rejected');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
