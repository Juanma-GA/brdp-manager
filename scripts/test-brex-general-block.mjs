// The general rules block of a BREX 4.x has no rulesContext attribute.
// s1kd-brexcheck applies a block only when it has no rulesContext or the
// attribute equals the DM's schema (scripts/lib/brexcheckEmulation.mjs, its
// XPath copied verbatim), so the old <contextRules rulesContext=""> applied
// to no schema at all. Checks: the 4.1 / 3.0.1 generators (4.2 assembles
// with the browser DOM -- scripts/verify-brex-general-block.mjs), validity
// against brex.xsd, the Generate safety net, the Schematron export, and the
// rule test engine's condition against s1kd-brexcheck's.
// Run: node scripts/test-brex-general-block.mjs
import fs from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { validateXML } from 'xmllint-wasm';
import { countEmptySchemaContextBlocks } from '../src/utils/ruleSchemaContext.js';
import { brexToSchematron } from '../src/api/brexToSchematron.js';
import { analyzeRule, describeRule, runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { brexcheckErrors, selectedRules } from './lib/brexcheckEmulation.mjs';
import i18n from '../src/i18n/index.js';

// Same shim as scripts/test-schema-location.mjs.
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
const approvals = (list) => new Map(list.map((a) => [a.brdp_id, { status: 'approved', ...a }]));
const summary = (file) => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
async function xsdErrors(dir, main, xml) {
  const base = new URL(`../sources/${dir}/`, import.meta.url);
  const files = fs.readdirSync(base).filter((f) => f.endsWith('.xsd')).map((f) => ({ fileName: f, contents: fs.readFileSync(new URL(f, base), 'utf8') }));
  const text = xml.replace(/ xsi:noNamespaceSchemaLocation="[^"]*"/, '');
  const result = await validateXML({ xml: { fileName: 'brex.xml', contents: text }, schema: files.find((f) => f.fileName === main), preload: files.filter((f) => f.fileName !== main) });
  return result.errors.map((e) => e.rawMessage || e.message);
}
const brdp = (id, identifier) => ({ id, identifier, validation: 'Validated' });

// ─── Safety-net counter ─────────────────────────────────────────────────────
check('count: rulesContext=""', countEmptySchemaContextBlocks('<brex><contextRules rulesContext=""><x/></contextRules></brex>') === 1);
check('count: whitespace-only counts as empty', countEmptySchemaContextBlocks("<contextRules rulesContext=' '/>") === 1);
check('count: 3.0.1 context=""', countEmptySchemaContextBlocks('<contextrules context=""/>') === 1);
check('count: no attribute is fine', countEmptySchemaContextBlocks('<contextRules><x/></contextRules><contextrules/>') === 0);
check('count: a schema is fine', countEmptySchemaContextBlocks('<contextRules rulesContext="proced.xsd"/>') === 0);
check('count: inside a comment ignored', countEmptySchemaContextBlocks('<!-- <contextRules rulesContext=""> -->') === 0);

// ─── BREX 4.1: general block without the attribute ──────────────────────────
const FLAT41 = (s) => `http://www.s1000d.org/S1000D_4-1/xml_schema_flat/${s}.xsd`;
const FOOTNOTE = '<structureObjectRule id="BRDP-FOOT"><objectPath allowedObjectFlag="0">//footnote</objectPath><objectUse>BRDP-FOOT. Footnotes must not be used.</objectUse></structureObjectRule>';
const WRAPPED_EMPTY = '<contextRules rulesContext=""><structureObjectRuleGroup><structureObjectRule id="BRDP-WRAP"><objectPath allowedObjectFlag="0">//randomList</objectPath><objectUse>BRDP-WRAP.</objectUse></structureObjectRule></structureObjectRuleGroup></contextRules>';
const PROC41 = `<contextRules rulesContext="${FLAT41('proced')}"><structureObjectRuleGroup><structureObjectRule id="BRDP-PROC"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>BRDP-PROC.</objectUse></structureObjectRule></structureObjectRuleGroup></contextRules>`;
{
  const out = await generateBREX41(
    [brdp('a', 'BRDP-FOOT'), brdp('b', 'BRDP-WRAP'), brdp('c', 'BRDP-PROC')],
    { modelIdentCode: 'ABC' },
    { approvals: approvals([{ brdp_id: 'a', rule_xml: FOOTNOTE }, { brdp_id: 'b', rule_xml: WRAPPED_EMPTY }, { brdp_id: 'c', rule_xml: PROC41 }]), schemaSummary: summary('brex-schema-summary-4-1.json') }
  );
  check('4.1: well formed', out.valid, out.error);
  check('4.1: no rulesContext="" in the output', !/rulesContext\s*=\s*""/.test(out.xml));
  check('4.1: safety net reports 0', out.emptyContextBlocks === 0);
  const general = /<contextRules>([\s\S]*?)<\/contextRules>/.exec(out.xml)?.[1] || '';
  check('4.1: general block <contextRules> without the attribute', general.length > 0);
  check('4.1: general rule in the general block', general.includes('id="BRDP-FOOT"'));
  check('4.1: rule stored in rulesContext="" goes to the general block', general.includes('id="BRDP-WRAP"'));
  check('4.1: schema block unchanged', out.xml.includes(`<contextRules rulesContext="${FLAT41('proced')}">`) && !general.includes('BRDP-PROC'));
  check('4.1: general block before the schema block', out.xml.indexOf('<contextRules>') < out.xml.indexOf(`rulesContext="${FLAT41('proced')}"`));
  const errs = await xsdErrors('S4.1', 'brex4.1.xsd', out.xml);
  check('4.1: valid against brex4.1.xsd', errs.length === 0, errs.slice(0, 3).join(' | '));

  // s1kd-brexcheck: a general rule applies to a descriptive DM with a <footnote>.
  const brexDoc = parseXml(out.xml);
  const dm = (schema, body) => parseXml(`<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${FLAT41(schema)}"><content>${body}</content></dmodule>`);
  const ids = (schema) => selectedRules(brexDoc, FLAT41(schema)).map((r) => r.getAttribute('id')).sort().join();
  check('s1kd selection, descript: the two general rules', ids('descript') === 'BRDP-FOOT,BRDP-WRAP', ids('descript'));
  check('s1kd selection, proced: general rules + proced', ids('proced') === 'BRDP-FOOT,BRDP-PROC,BRDP-WRAP', ids('proced'));
  const errors = brexcheckErrors(brexDoc, dm('descript', '<description><levelledPara><para>Text<footnote><para>n</para></footnote></para></levelledPara></description>'));
  check('s1kd: <footnote> in a descriptive DM is an error', errors.some((e) => e.id === 'BRDP-FOOT'), JSON.stringify(errors));
  check('s1kd: the proced rule does not apply to descript', !errors.some((e) => e.id === 'BRDP-PROC'));
  // And the old output: nothing general applied.
  const old = parseXml(out.xml.replace('<contextRules>', '<contextRules rulesContext="">'));
  check('s1kd: with rulesContext="" the general rules applied nowhere', selectedRules(old, FLAT41('descript')).length === 0);

  const sch = await generateBREXSch([brdp('a', 'BRDP-FOOT'), brdp('c', 'BRDP-PROC')], { modelIdentCode: 'ABC' }, { baseGenerator: generateBREX41, approvals: approvals([{ brdp_id: 'a', rule_xml: FOOTNOTE }, { brdp_id: 'c', rule_xml: PROC41 }]), schemaSummary: summary('brex-schema-summary-4-1.json') });
  check('Schematron: safety net carried', sch.emptyContextBlocks === 0);
  const asserts = [...sch.xml.matchAll(/<sch:assert[^>]*test="([^"]*)"/g)].map((m) => m[1]);
  check('Schematron: the general rule has no schema condition', asserts.length === 2 && asserts.filter((t) => t.includes('noNamespaceSchemaLocation')).length === 1, asserts.join(' | '));
}
// brexToSchematron directly on a 4.2 BREX with an attribute-less general block.
{
  const brex = `<dmodule><content><brex><contextRules><structureObjectRuleGroup>${FOOTNOTE}</structureObjectRuleGroup></contextRules><contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"><structureObjectRuleGroup><structureObjectRule id="P"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>u</objectUse></structureObjectRule></structureObjectRuleGroup></contextRules></brex></content></dmodule>`;
  const sch = brexToSchematron(brex, { preserveBrdpId: true });
  const tests = [...sch.matchAll(/<sch:assert[^>]*test="([^"]*)"/g)].map((m) => m[1]);
  check('brexToSchematron 4.2: general rule without schema condition', tests.some((t) => !t.includes('noNamespaceSchemaLocation')), tests.join(' | '));
  check('brexToSchematron 4.2: proced rule with its condition', tests.some((t) => t.includes("noNamespaceSchemaLocation = 'http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd'")));
}

// ─── BREX 3.0.1 unchanged ────────────────────────────────────────────────────
{
  const rule = '<objrule id="R301"><objpath objappl="0">//footnote</objpath><objuse>u</objuse></objrule>';
  const out = await generateBREX301([brdp('a', 'BRDP-301')], { modelIdentCode: 'ABC' }, { approvals: approvals([{ brdp_id: 'a', rule_xml: rule }]), schemaSummary: summary('brex-schema-summary-3-0-1.json') });
  check('3.0.1: well formed, general <contextrules> without context', out.valid && /<contextrules>\s*<structrules>[\s\S]*id="R301"/.test(out.xml), out.error);
  check('3.0.1: no context="" and 0 reported', !/context\s*=\s*""/.test(out.xml) && out.emptyContextBlocks === 0);
  const errs = await xsdErrors('S3.0.1', 'brex.xsd', out.xml);
  check('3.0.1: valid against brex.xsd', errs.length === 0, errs.slice(0, 3).join(' | '));
  const errors = brexcheckErrors(parseXml(out.xml), parseXml('<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/descript.xsd"><content><descript><para0><para>x<footnote><para>n</para></footnote></para></para0></descript></content></dmodule>'));
  check('3.0.1 s1kd: <footnote> is an error', errors.some((e) => e.id === 'R301'));
}

// ─── Rule test engine: same condition as s1kd-brexcheck ─────────────────────
const FLAT42 = (s) => `http://www.s1000d.org/S1000D_4-2/xml_schema_flat/${s}.xsd`;
const rule42 = (id) => `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">//footnote</objectPath><objectUse>${id}</objectUse></structureObjectRule>`;
const block = (attr, id) => `<contextRules${attr}><structureObjectRuleGroup>${rule42(id)}</structureObjectRuleGroup></contextRules>`;
const BLOCKS = {
  none: block('', 'G'),
  empty: block(' rulesContext=""', 'E'),
  proced: block(` rulesContext="${FLAT42('proced')}"`, 'P'),
  descript: block(` rulesContext="${FLAT42('descript')}"`, 'D'),
};
const fragment = (schema) => `<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${FLAT42(schema)}"><content><description><levelledPara><para>x<footnote><para>n</para></footnote></para></levelledPara></description></content></dmodule>`;
const ALL = parseXml(`<brex>${Object.values(BLOCKS).join('')}</brex>`);
for (const schema of ['descript', 'proced', 'ipd']) {
  const s1kd = new Set(selectedRules(ALL, FLAT42(schema)).map((r) => r.getAttribute('id')));
  for (const [kind, xml] of Object.entries(BLOCKS)) {
    const id = /id="([^"]+)"/.exec(xml)[1];
    const r = runRuleOnFragment(xml, 'BREX-4.2', fragment(schema), null, { parseXml });
    const engineApplies = r.status === 'rejected';
    check(`engine = s1kd: block ${kind}, ${schema} DM`, engineApplies === s1kd.has(id), `engine ${r.status}, s1kd ${s1kd.has(id)}`);
  }
}
{
  const r = runRuleOnFragment(BLOCKS.empty, 'BREX-4.2', fragment('descript'), null, { parseXml });
  check('engine: rulesContext="" not executable', r.status === 'not_executable' && r.notExecutableReason?.code === 'empty_schema_context', JSON.stringify(r.notExecutableReason));
  check('engine: reason params', r.notExecutableReason?.params?.element === 'contextRules' && r.notExecutableReason?.params?.attr === 'rulesContext');
  const a = analyzeRule(BLOCKS.empty, 'BREX-4.2', { parseXml });
  check('analyzeRule: rulesContext="" not executable up front', a.status === 'not_executable' && a.reason?.code === 'empty_schema_context', JSON.stringify(a));
  check('analyzeRule: no attribute is executable', analyzeRule(BLOCKS.none, 'BREX-4.2', { parseXml }).status === 'executable');
  const both = analyzeRule(BLOCKS.none + BLOCKS.empty, 'BREX-4.2', { parseXml });
  check('analyzeRule: general + empty block is partial', both.status === 'partial' && both.parts[0]?.ruleId === 'E');
  const ws = runRuleOnFragment(block(' rulesContext="  "', 'W'), 'BREX-4.2', fragment('descript'), null, { parseXml });
  check('engine: whitespace-only rulesContext is empty too', ws.notExecutableReason?.code === 'empty_schema_context');
  const d = describeRule(BLOCKS.empty, 'BREX-4.2', { parseXml });
  check('describeRule: empty block explained', d.statements[0]?.statement.code === 'describe_not_executable' && d.statements[0]?.statement.params.reason.code === 'empty_schema_context');
  const en = formatRuleTestReason(r.notExecutableReason, i18n.getFixedT('en'));
  const es = formatRuleTestReason(r.notExecutableReason, i18n.getFixedT('es'));
  check('message EN', en.includes('<contextRules> with an empty rulesContext') && en.includes('s1kd-brexcheck') && en.includes('no schema'), en);
  check('message ES', es.includes('<contextRules> con el rulesContext vacío') && es.includes('ningún esquema'), es);
  // 3.0.1: <contextrules context=""> the same.
  const r301 = runRuleOnFragment('<contextrules context=""><structrules><objrule id="O"><objpath objappl="0">//footnote</objpath><objuse>u</objuse></objrule></structrules></contextrules>', 'BREX-3.0.1', fragment('descript'), null, { parseXml });
  check('engine 3.0.1: context="" not executable', r301.notExecutableReason?.code === 'empty_schema_context' && r301.notExecutableReason.params.attr === 'context');
  const g301 = runRuleOnFragment('<contextrules><structrules><objrule id="O"><objpath objappl="0">//footnote</objpath><objuse>u</objuse></objrule></structrules></contextrules>', 'BREX-3.0.1', fragment('descript'), null, { parseXml });
  check('engine 3.0.1: no context is general', g301.status === 'rejected');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
