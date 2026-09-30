// Tests for src/utils/ruleTestEngine.js (Test rule, T1 of 4) -- plain Node,
// the real module, no test runner (same convention as the other
// scripts/test-*.mjs). Run: node scripts/test-rule-test-engine.mjs
//
// 1. Own cases: flags 0/1/2, objectValue single/range/pattern, 3.0.1 objval,
//    context blocks (right schema / other schema / unknown / inferred from
//    xsi), document(), invalid XPath, nonContextRule, unsupported format,
//    malformed input, absolute root mismatch.
// 2. The rules already used in other tests: //emphasis flag 0, @emphasisType
//    em01/em02, the proced context rule and the descript Master rule (both
//    wrapped by the real wrapRuleInSchemaContexts()).
// 3. EVERY Verified rule of the curated templates 4.2, 4.1 and 3.0.1, read
//    from public/brdp-template-*.xlsx: a hand-written fragment that breaks it
//    and one that complies, or the expected not-executable reason. A rule
//    missing from the table below fails the run, so a template change can't
//    silently skip the check.
import { DOMParser } from '@xmldom/xmldom';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { wrapRuleInSchemaContexts } from '../src/utils/ruleSchemaContext.js';
import { brexToSchematron } from '../src/api/brexToSchematron.js';
import { wrapRuleXmlFragment } from '../src/utils/ruleXmlFragment.js';
import fontoxpath from 'fontoxpath';
import i18n from '../src/i18n/index.js';
import { formatRuleTestReason } from '../src/utils/ruleTestReasons.js';

// Reasons are { code, params } since T3; the checks below compare the
// English text the interface shows for them (the real i18n resources), and
// section 4 checks the codes themselves.
const tEn = i18n.getFixedT('en');
const reasonText = (reason) => formatRuleTestReason(reason, tEn);

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

// xmldom never throws and only warns on some malformed input (an unclosed
// tag), so any message it reports counts as malformed here.
function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_level, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
// Every engine run of a rule with values is replayed through the Schematron
// that Generate would produce (section 3): same rule, same fragment.
const valueRuns = [];
const run = (rule, format, fragment, schema = null) => {
  const result = runRuleOnFragment(rule, format, fragment, schema, { parseXml });
  if (/<(objectValue|objval)\b/.test(rule)) valueRuns.push({ rule, format, fragment, schema, result });
  return result;
};
const toSchematron = (rule) => brexToSchematron(wrapRuleXmlFragment(rule), { DOMParserImpl: DOMParser });

// The verdict of the generated Schematron on a fragment, evaluated with
// fontoxpath: every sch:rule context (a pattern, matched as a path from the
// document) and its sch:assert test; any failed assert means rejected.
const SCH_NS = { xsi: 'http://www.w3.org/2001/XMLSchema-instance', xlink: 'http://www.w3.org/1999/xlink' };
function schematronVerdict(rule, fragment) {
  const sch = parseXml(toSchematron(rule));
  const doc = parseXml(fragment);
  const options = { language: fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE, namespaceResolver: (p) => (p ? SCH_NS[p] ?? null : null) };
  const rules = Array.from(sch.getElementsByTagName('sch:rule'));
  for (const r of rules) {
    const context = r.getAttribute('context');
    const nodes = fontoxpath.evaluateXPathToNodes(context.startsWith('/') ? context : `//${context}`, doc, null, null, options);
    const test = r.getElementsByTagName('sch:assert')[0].getAttribute('test');
    for (const node of nodes) {
      if (!fontoxpath.evaluateXPathToBoolean(test, node, null, null, options)) return 'rejected';
    }
  }
  return 'accepted';
}

function expect(name, result, status, extra = {}) {
  check(`${name}: status ${status}`, result.status === status, JSON.stringify(result));
  if (extra.reason !== undefined) {
    const got = extra.reason === null ? result.notExecutableReason : reasonText(result.notExecutableReason);
    const ok = extra.reason instanceof RegExp ? extra.reason.test(got) : got === extra.reason;
    check(`${name}: reason`, ok, `got: ${got}`);
  }
  if (extra.nodePaths) {
    const got = result.violations.flatMap((v) => v.nodePaths);
    check(`${name}: nodePaths`, JSON.stringify(got) === JSON.stringify(extra.nodePaths), `got: ${JSON.stringify(got)}`);
  }
  if (extra.selected) {
    check(`${name}: selectedNodePaths`, JSON.stringify(result.selectedNodePaths) === JSON.stringify(extra.selected), `got: ${JSON.stringify(result.selectedNodePaths)}`);
  }
  if (extra.partial) {
    check(`${name}: reports the non-executable part`, extra.partial.test(reasonText(result.notExecutableReason)), `got: ${reasonText(result.notExecutableReason)}`);
  }
  return result;
}

const sor = (flag, path, values = '', use = 'use') =>
  `<structureObjectRule><objectPath${flag === null ? '' : ` allowedObjectFlag="${flag}"`}>${path}</objectPath><objectUse>${use}</objectUse>${values}</structureObjectRule>`;
const ov = (form, allowed) => `<objectValue valueForm="${form}" valueAllowed="${allowed}"/>`;
const DM = (body, attrs = '') => `<dmodule${attrs}><identAndStatusSection/><content>${body}</content></dmodule>`;
const XSI = (url) => ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${url}"`;

// ─── 1. Own cases ───────────────────────────────────────────────────────────
// Flag 0
{
  const rule = sor('0', '//emphasis', '', 'BRDP-X. &lt;emphasis&gt; must not be used.');
  const bad = expect('flag 0 //emphasis, breaking', run(rule, 'BREX-4.2', '<para>A <emphasis>b</emphasis> c <emphasis>d</emphasis></para>'), 'rejected',
    { nodePaths: ['/para[1]/emphasis[1]', '/para[1]/emphasis[2]'], selected: ['/para[1]/emphasis[1]', '/para[1]/emphasis[2]'] });
  check('flag 0: violation carries the objectUse text', bad.violations[0]?.message === 'BRDP-X. <emphasis> must not be used.', JSON.stringify(bad.violations));
  expect('flag 0 //emphasis, complying', run(rule, 'BREX-4.2', '<para>A plain paragraph.</para>'), 'accepted', { selected: [] });
  expect('flag 0 + values: only the listed (forbidden) values violate',
    run(sor('0', '//@issueType', ov('single', 'revised')), 'BREX-4.2', '<x><a issueType="revised"/><a issueType="changed"/></x>'), 'rejected',
    { nodePaths: ['/x[1]/a[1]/@issueType'], selected: ['/x[1]/a[1]/@issueType', '/x[1]/a[2]/@issueType'] });
}
// Flag 1
{
  const rule = sor('1', '//itemSeqNumber/partSegment');
  const two = '<itemSeqNumber><partSegment/></itemSeqNumber><itemSeqNumber><partRef/></itemSeqNumber>';
  expect('flag 1 per parent, one itemSeqNumber without partSegment', run(rule, 'BREX-4.2', DM(two)), 'rejected',
    { nodePaths: ['/dmodule[1]/content[1]/itemSeqNumber[2]'] });
  expect('flag 1 per parent, all present', run(rule, 'BREX-4.2', DM('<itemSeqNumber><partSegment/></itemSeqNumber>')), 'accepted');
  expect('flag 1 on a fragment that is not a whole DM', run(rule, 'BREX-4.2', `<catalogSeqNumber>${two}</catalogSeqNumber>`), 'not_executable',
    { reason: 'A mandatory-node rule can only be judged on a whole data module.' });
  expect('flag 1 on a whole pm counts as a whole document', run(sor('1', '//pmEntry'), 'BREX-4.2', '<pm><content><pmEntry/></content></pm>'), 'accepted');
  const whole = sor('1', "//@assyCode[matches(., '^\\d{2}$')]");
  expect('flag 1 without a parent step: whole document, missing', run(whole, 'BREX-4.2', DM('', ' assyCode="123"')), 'rejected', { nodePaths: ['/dmodule[1]'] });
  expect('flag 1 without a parent step: whole document, present', run(whole, 'BREX-4.2', DM('', ' assyCode="12"')), 'accepted');
  const withValue = sor('1', '//copyright/copyrightPara/emphasis[1]', ov('single', 'Copyright (C) 2024'));
  expect('flag 1 + value: node present with a wrong value', run(withValue, 'BREX-4.2', DM('<copyright><copyrightPara><emphasis>Copyright 2023</emphasis></copyrightPara></copyright>')), 'rejected',
    { nodePaths: ['/dmodule[1]/content[1]/copyright[1]/copyrightPara[1]/emphasis[1]'] });
}
// Flag 2
{
  expect('flag 2 without values never rejects', run(sor('2', '//para'), 'BREX-4.2', '<x><para/></x>'), 'accepted', { selected: ['/x[1]/para[1]'] });
  expect('absent allowedObjectFlag = 2 (XSD default)', run(sor(null, '//@a', ov('single', 'ok')), 'BREX-4.2', '<x a="no"/>'), 'rejected');
}
// objectValue single / range / pattern
{
  const emph = sor('2', '//@emphasisType', ov('single', 'em01') + ov('single', 'em02'), 'emphasisType em01/em02 only');
  expect('@emphasisType em01/em02, breaking', run(emph, 'BREX-4.2', '<para><emphasis emphasisType="em03">a</emphasis><emphasis emphasisType="em01">b</emphasis></para>'), 'rejected',
    { nodePaths: ['/para[1]/emphasis[1]/@emphasisType'] });
  expect('@emphasisType em01/em02, complying', run(emph, 'BREX-4.2', '<para><emphasis emphasisType="em02">a</emphasis><emphasis>b</emphasis></para>'), 'accepted');
  expect('single is exact (no whitespace normalisation)', run(sor('2', '//name', ov('single', 'ACME')), 'BREX-4.2', '<x><name> ACME</name></x>'), 'rejected');
  expect('value of an element is its whole text', run(sor('2', '//name', ov('single', 'ACME CORP')), 'BREX-4.2', '<x><name>ACME <b>CORP</b></name></x>'), 'accepted');
  expect('valueForm absent = single', run(sor('2', '//@a', '<objectValue valueAllowed="ok"/>'), 'BREX-4.2', '<x a="ok"/>'), 'accepted');

  const numeric = sor('2', '//@level', ov('range', '1~10'));
  expect('numeric range, inside (numeric comparison: 5 in 1~10)', run(numeric, 'BREX-4.2', '<x level="5"/>'), 'accepted');
  expect('numeric range, outside', run(numeric, 'BREX-4.2', '<x level="11"/>'), 'rejected');
  expect('numeric range, non-numeric value is outside', run(numeric, 'BREX-4.2', '<x level="five"/>'), 'rejected');
  const text = sor('2', '//@caveat', ov('range', 'cv01~cv20'));
  expect('text range, inside', run(text, 'BREX-4.2', '<x caveat="cv05"/>'), 'accepted');
  expect('text range, outside', run(text, 'BREX-4.2', '<x caveat="cv30"/>'), 'rejected');
  expect('range mixing number and text', run(sor('2', '//@a', ov('range', '1~b')), 'BREX-4.2', '<x a="1"/>'), 'not_executable',
    { reason: "Range '1~b' mixes a number and text; Generate compares it as text and flags it, so the test gives no verdict." });
  const mixedSch = toSchematron(sor('2', '//@a', ov('range', '1~b')).replace('<structureObjectRule>', '<structureObjectRule id="R-MIX">'));
  check('mixed range: the generated Schematron carries a warning comment', mixedSch.includes("<!-- R-MIX: range '1~b' mixes a number and text; it is compared as text -->"), mixedSch);
  check('mixed range: the generated Schematron still compares as text', mixedSch.includes("string(.) ge '1' and string(.) le 'b'"), mixedSch);
  expect('encargo: range 1~10 with 5', run(numeric, 'BREX-4.2', '<x level="5"/>'), 'accepted');
  expect('encargo: range em01~em05 with em03', run(sor('2', '//@code', ov('range', 'em01~em05')), 'BREX-4.2', '<x code="em03"/>'), 'accepted');
  expect('range em01~em05 with em07', run(sor('2', '//@code', ov('range', 'em01~em05')), 'BREX-4.2', '<x code="em07"/>'), 'rejected');
  check('numeric range compiles to number(.)', toSchematron(numeric).includes("number(.) ge number('1') and number(.) le number('10')"), toSchematron(numeric));
  expect('range without ~', run(sor('2', '//@a', ov('range', '1-10')), 'BREX-4.2', '<x a="1"/>'), 'not_executable',
    { reason: "Range '1-10' is not in the form from~to." });

  const pattern = sor('2', '//@code', ov('pattern', 'em0[1-2]'));
  expect('pattern, whole value matches', run(pattern, 'BREX-4.2', '<x code="em01"/>'), 'accepted');
  expect('pattern, no match', run(pattern, 'BREX-4.2', '<x code="xx"/>'), 'rejected');
  expect('pattern is anchored: matching only part of the value is a violation', run(pattern, 'BREX-4.2', '<x code="em01x"/>'), 'rejected');
  expect('encargo: pattern em0[1-5] with em05x', run(sor('2', '//@code', ov('pattern', 'em0[1-5]')), 'BREX-4.2', '<x code="em05x"/>'), 'rejected');
  check('pattern compiles to an anchored matches()', toSchematron(pattern).includes("matches(string(.), '^(em0[1-2])$')"), toSchematron(pattern));
  expect('anchored pattern decides on its own', run(sor('2', '//@code', ov('pattern', '^[A-Z]{2}$')), 'BREX-4.2', '<x code="ABC"/>'), 'rejected');
  expect('unknown valueForm', run(sor('2', '//@a', ov('list', 'a b')), 'BREX-4.2', '<x a="a"/>'), 'not_executable',
    { reason: "Value check 'list' is not supported by the test engine." });
  expect('invalid regex is an XPath error', run(sor('2', '//@a', ov('pattern', '[a')), 'BREX-4.2', '<x a="a"/>'), 'not_executable', { reason: /^XPath error: / });
}
// 3.0.1 objrule / objval
{
  const objrule = (appl, path, vals = '') => `<objrule id="R1"><objpath${appl === null ? '' : ` objappl="${appl}"`}>${path}</objpath><objuse>use</objuse>${vals}</objrule>`;
  expect('3.0.1 objappl 0', run(objrule('0', '//randlist'), 'BREX-3.0.1', '<para><randlist/></para>'), 'rejected', { nodePaths: ['/para[1]/randlist[1]'] });
  expect('3.0.1 no objappl + objval = value check', run(objrule(null, '//@emph', '<objval valtype="single" val1="em01"/>'), 'BREX-3.0.1', '<p emph="em02"/>'), 'rejected');
  expect('3.0.1 objval without valtype = single', run(objrule(null, '//@emph', '<objval val1="em01"/>'), 'BREX-3.0.1', '<p emph="em01"/>'), 'accepted');
  expect('3.0.1 no objappl, no objval = never rejects', run(objrule(null, '//para'), 'BREX-3.0.1', '<para/>'), 'accepted');
  expect('3.0.1 range val1..val2', run(objrule(null, '//@n', '<objval valtype="range" val1="1" val2="9"/>'), 'BREX-3.0.1', '<p n="12"/>'), 'rejected');
  expect('3.0.1 single with val2 is not confirmed', run(objrule(null, '//@n', '<objval valtype="single" val1="a" val2="//x"/>'), 'BREX-3.0.1', '<p n="a"/>'), 'not_executable',
    { reason: "Value check 'single with val2' is not supported by the test engine." });
  expect('3.0.1 pattern does not exist', run(objrule(null, '//@n', '<objval valtype="pattern" val1="a"/>'), 'BREX-3.0.1', '<p n="a"/>'), 'not_executable',
    { reason: "Value check 'pattern' is not supported by the test engine." });
  expect('3.0.1 objappl 2 is not valid', run(objrule('2', '//x'), 'BREX-3.0.1', '<x/>'), 'not_executable', { reason: 'objappl="2" is not a valid value (only 0, 1).' });
  expect('3.0.1 objappl 1 on a whole dmodule', run(objrule('1', '//status/qa'), 'BREX-3.0.1', '<dmodule><idstatus><status/></idstatus></dmodule>'), 'rejected',
    { nodePaths: ['/dmodule[1]/idstatus[1]/status[1]'] });
  expect('4.x flag 3 is not valid', run(sor('3', '//x'), 'BREX-4.2', '<x/>'), 'not_executable', { reason: 'allowedObjectFlag="3" is not a valid value (only 0, 1, 2).' });
}
// Context blocks
{
  const general = sor('0', '//emphasis', '', 'no emphasis in procedures');
  const proced = wrapRuleInSchemaContexts(general, 'BREX-4.2', 'S1000D 4.2', ['proced']);
  check('proced rule is wrapped in a contextRules block', proced.includes('rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"'), proced);
  const frag = '<para><emphasis>x</emphasis></para>';
  expect('context rule, fragment of the right schema', run(proced, 'BREX-4.2', frag, 'proced'), 'rejected');
  const other = expect('context rule, fragment of another schema: the rule does not apply', run(proced, 'BREX-4.2', frag, 'descript'), 'accepted',
    { reason: null, selected: [] });
  check('context rule, other schema: outOfScopeSchemas names it', JSON.stringify(other.outOfScopeSchemas) === '["proced"]', JSON.stringify(other));
  expect('context rule, schema unknown', run(proced, 'BREX-4.2', frag), 'not_executable',
    { reason: 'This rule applies only to the proced schema, and the fragment\'s schema is not known.' });
  expect('context rule, schema inferred from xsi:noNamespaceSchemaLocation',
    run(proced, 'BREX-4.2', DM('<para><emphasis>x</emphasis></para>', XSI('http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd'))), 'rejected');
  expect('general rule applies whatever the schema', run(general, 'BREX-4.2', frag, 'ipd'), 'rejected');

  const descript = wrapRuleInSchemaContexts('<objrule id="R-D"><objpath objappl="0">//emphasis</objpath><objuse>no emphasis</objuse></objrule>', 'BREX-3.0.1', 'S1000D 3.0.1', ['descript'], 'master');
  check('descript Master rule uses the master URL', descript.includes('context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd"'), descript);
  expect('descript Master rule, descript fragment', run(descript, 'BREX-3.0.1', frag, 'descript'), 'rejected');
  expect('descript Master rule, complying descript fragment', run(descript, 'BREX-3.0.1', '<para>x</para>', 'descript'), 'accepted');
  expect('descript Master rule, proced fragment: does not apply', run(descript, 'BREX-3.0.1', frag, 'proced'), 'accepted');

  const both = wrapRuleInSchemaContexts(sor('0', '//emphasis').replace('<structureObjectRule>', '<structureObjectRule id="R">'), 'BREX-4.2', 'S1000D 4.2', ['proced', 'ipd']);
  const r = expect('two context blocks: only the matching one runs', run(both, 'BREX-4.2', frag, 'ipd'), 'rejected');
  check('two context blocks: the violation is the ipd copy', r.violations.length === 1 && r.violations[0].ruleId === 'R-ipd', JSON.stringify(r.violations));
  check('two context blocks: the other block is not reported as non-executable', r.notExecutableReason === null, r.notExecutableReason);
}
// Not executable
{
  expect('document()', run(sor('0', "document('other.xml')//dmodule"), 'BREX-4.2', '<x/>'), 'not_executable',
    { reason: 'The rule reads another file (document()), which is not available in a test.' });
  expect('doc()', run(sor('0', 'doc($uri)//x'), 'BREX-4.2', '<x/>'), 'not_executable', { reason: /reads another file/ });
  expect('"doc(" inside a string literal is not a call', run(sor('0', "//p[. = 'see doc(1)']"), 'BREX-4.2', '<x><p>see doc(1)</p></x>'), 'rejected');
  const bad = expect('invalid XPath', run(sor('0', '//para['), 'BREX-4.2', '<x/>'), 'not_executable', { reason: /^XPath error: .*XPST0003/ });
  check('XPath error message is one line', !bad.notExecutableReason.params.message.includes('\n'), bad.notExecutableReason.params.message);
  expect('unknown prefix is an XPath error', run(sor('0', '//foo:bar'), 'BREX-4.2', '<x/>'), 'not_executable', { reason: /^XPath error: .*XPST0081/ });
  expect('nonContextRule only', run('<nonContextRule><simplePara>Decide X.</simplePara></nonContextRule>', 'BREX-4.2', '<x/>'), 'not_executable',
    { reason: 'This rule has no XPath to execute (nonContextRule).' });
  expect('3.0.1 nonContextRule comment only', run('<!-- nonContextRule id="BRDP-1": no XPath -->', 'BREX-3.0.1', '<x/>'), 'not_executable',
    { reason: 'This rule has no XPath to execute (nonContextRule).' });
  expect('unknown rule format', run(sor('0', '//x'), 'XSD-1.1', '<x/>'), 'not_executable', { reason: /^Rule format 'XSD-1.1' is not supported/ });
  expect('malformed fragment', run(sor('0', '//x'), 'BREX-4.2', '<a><b></a>'), 'not_executable', { reason: /^The test fragment is not well-formed XML: / });
  expect('malformed rule', run('<structureObjectRule><objectPath>//x</structureObjectRule>', 'BREX-4.2', '<x/>'), 'not_executable', { reason: /^The rule is not well-formed XML: / });
  expect('no rule element', run('<objectUse>x</objectUse>', 'BREX-4.2', '<x/>'), 'not_executable', { reason: 'The rule contains no <structureObjectRule> to execute.' });
  expect('path returning a boolean', run(sor('0', '//a and //b'), 'BREX-4.2', '<x/>'), 'not_executable',
    { reason: "The rule's path does not select nodes (it returns a boolean), so there is nothing to judge." });
  expect('absolute path on a fragment with another root', run(sor('0', '/dmodule/content//thead'), 'BREX-4.2', '<table><thead/></table>'), 'not_executable',
    { reason: "The rule's path starts at /dmodule, but this fragment's root element is <table>; it can only be judged on a fragment whose root is <dmodule>." });
  expect('path continuing after a predicate is not absolute', run(sor('0', "/dmodule/content[@a] /para"), 'BREX-4.2', DM('<para/>').replace('<content>', '<content a="1">')), 'rejected');
  expect('absolute path inside a predicate is checked too', run(sor('0', '//qty[/dmodule/content/proced]'), 'BREX-4.2', '<proced><qty/></proced>'), 'not_executable', { reason: /starts at \/dmodule/ });
  const partial = expect('mixed rule: runs the executable part',
    run(`<rules>${sor('0', '//x')}<nonContextRule><simplePara>y</simplePara></nonContextRule></rules>`, 'BREX-4.2', '<a><x/></a>'), 'rejected',
    { partial: /rule 2: This rule has no XPath to execute \(nonContextRule\)\./ });
  check('mixed rule: notExecutableParts lists the part', partial.notExecutableParts.length === 1 && partial.notExecutableParts[0].ruleId === 'rule 2', JSON.stringify(partial.notExecutableParts));
}

// ─── 2. Curated template rules ──────────────────────────────────────────────
const OTHER_FILE = /reads another file/;
const NON_CONTEXT = 'This rule has no XPath to execute (nonContextRule).';
// Per rule: { schema, bad, good } (bad → rejected, good → accepted), or
// { schema, never: fragment } for a rule that can't reject any fragment, or
// { schema, notExecutable: reason, fragment }. `partial` = the reason of the
// part that can't run in a rule that otherwise runs.
const TEMPLATE_CASES = {
  'BREX-4.2': {
    'BRDP-S1-00133': { bad: '<para>Set <parameter>P1</parameter>.</para>', good: '<para>Set the pressure.</para>' },
    'BRDP-S1-00338': {
      bad: '<dmodule><identAndStatusSection><dmAddress><dmIdent><dmCode modelIdentCode="BIKE" assyCode="123"/></dmIdent></dmAddress></identAndStatusSection><content/></dmodule>',
      good: '<dmodule><identAndStatusSection><dmAddress><dmIdent><dmCode modelIdentCode="BIKE" assyCode="12"/></dmIdent></dmAddress></identAndStatusSection><content/></dmodule>',
      // Stored-rules lint round: the template had allowedObjectFlag="1" on
      // //@assyCode[matches(...)], which only required ONE good assyCode --
      // a bad one next to it (here in a dmRef) was accepted. Now flag 0 on
      // //@assyCode[string-length(.) != 2]: every bad value is rejected.
      alsoBad: [
        '<dmodule><identAndStatusSection><dmAddress><dmIdent><dmCode modelIdentCode="BIKE" assyCode="12"/></dmIdent></dmAddress></identAndStatusSection><content><description><para><dmRef><dmRefIdent><dmCode modelIdentCode="BIKE" assyCode="123"/></dmRefIdent></dmRef></para></description></content></dmodule>',
        '<dmodule><identAndStatusSection><dmAddress><dmIdent><dmCode modelIdentCode="BIKE" assyCode="A"/></dmIdent></dmAddress></identAndStatusSection><content/></dmodule>',
      ],
      // The Proposal says two CHARACTERS, not two digits.
      alsoGood: ['<dmodule><identAndStatusSection><dmAddress><dmIdent><dmCode modelIdentCode="BIKE" assyCode="AB"/></dmIdent></dmAddress></identAndStatusSection><content/></dmodule>'],
    },
    'BRDP-S1-00065': {
      bad: DM('<copyright><copyrightPara><emphasis>Copyright 2023</emphasis> Lufthansa Technik AG.</copyrightPara></copyright>'),
      good: DM('<copyright><copyrightPara><emphasis>Copyright (C) 2024</emphasis> Lufthansa Technik AG.</copyrightPara></copyright>'),
    },
    'BRDP-S1-00507': {
      bad: '<randomList><listItem><para>a</para><randomList><listItem><para>b</para></listItem></randomList></listItem></randomList>',
      good: '<randomList><listItem><para>a</para></listItem></randomList>',
      partial: NON_CONTEXT,
      // Templates round: second rule, listItemPrefix must be pf02 (a
      // randomList without the attribute uses the default, pf02).
      alsoBad: ['<randomList listItemPrefix="pf07"><listItem><para>a</para></listItem></randomList>'],
      alsoGood: ['<randomList listItemPrefix="pf02"><listItem><para>a</para></listItem></randomList>'],
    },
    'BRDP-S1-00053': { bad: '<dmStatus issueType="revised"/>', good: '<dmStatus issueType="changed"/>' },
    // Templates round: replaces BRDP-S1-00070 (Lufthansa's own CAGE code).
    'BRDP-S1-00187': {
      schema: 'proced',
      bad: '<mainProcedure><proceduralStep><para>a</para><proceduralStep><para>only one</para></proceduralStep></proceduralStep></mainProcedure>',
      good: '<mainProcedure><proceduralStep><para>a</para><proceduralStep><para>b</para></proceduralStep><proceduralStep><para>c</para></proceduralStep></proceduralStep><proceduralStep><para>d</para></proceduralStep></mainProcedure>',
    },
    'BRDP-S1-00219': {
      schema: 'ipd',
      bad: DM('<catalogSeqNumber><itemSeqNumber><partRef/></itemSeqNumber></catalogSeqNumber>'),
      good: DM('<catalogSeqNumber><itemSeqNumber><partSegment/></itemSeqNumber></catalogSeqNumber>'),
    },
    'BRDP-EXT-00001': { notExecutable: NON_CONTEXT, fragment: '<para/>' },
    'BRDP-S1-00006': {
      schema: 'fault',
      bad: DM('<faultIsolation/>', XSI('http://www.s1000d.org/S1000D_4-2/xml_schema_flat/fault.xsd')),
      goodSchema: 'proced',
      good: DM('<procedure/>', XSI('http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd')),
    },
    'BRDP-S1-00377': {
      schema: 'comrep',
      bad: '<commonRepository><applicRepository/></commonRepository>',
      good: '<commonRepository><partRepository/><toolRepository/></commonRepository>',
    },
  },
  'BREX-4.1': {
    // Templates round: replaces BRDP-EXT-00027 (the root must be dmodule --
    // nothing to reject in a data module).
    'BRDP-EXT-00036': {
      bad: '<dmodule><identAndStatusSection><dmAddress><dmIdent><issueInfo issueNumber="001" inWork="00"/></dmIdent></dmAddress><dmStatus issueType="changed"/></identAndStatusSection></dmodule>',
      good: '<dmodule><identAndStatusSection><dmAddress><dmIdent><issueInfo issueNumber="001" inWork="00"/></dmIdent></dmAddress><dmStatus issueType="new"/></identAndStatusSection></dmodule>',
      alsoGood: ['<dmodule><identAndStatusSection><dmAddress><dmIdent><issueInfo issueNumber="002" inWork="00"/></dmIdent></dmAddress><dmStatus issueType="changed"/></identAndStatusSection></dmodule>'],
    },
    'BRDP-EXT-00037': {
      bad: '<dmodule><identAndStatusSection><dmAddress><dmIdent><issueInfo issueNumber="001" inWork="00"/></dmIdent></dmAddress><dmStatus><reasonForUpdate/></dmStatus></identAndStatusSection></dmodule>',
      good: '<dmodule><identAndStatusSection><dmAddress><dmIdent><issueInfo issueNumber="001" inWork="00"/></dmIdent></dmAddress><dmStatus/></identAndStatusSection></dmodule>',
    },
    // Templates round: rewritten from flag 2 without values (nothing could
    // break them) to rules that reject what their objectUse says.
    'BRDP-EXT-00040': {
      bad: '<para><changeInline changeMark="1"><emphasis>All</emphasis></changeInline> of it</para>',
      good: '<para>Text <changeInline changeMark="1">new words</changeInline>.</para>',
      alsoBad: ['<para><changeInline changeMark="1"> <emphasis>a</emphasis> <emphasis>b</emphasis> </changeInline></para>'],
    },
    'BRDP-EXT-00041': {
      bad: '<content><para id="par-0001" changeType="delete">Old</para><para><internalRef internalRefId="par-0001"/></para></content>',
      good: '<content><para id="par-0001" changeType="delete">Old</para><para><internalRef internalRefId="par-0002"/></para><para id="par-0002">New</para></content>',
    },
    // Replaces BRDP-EXT-00044 ("editorial changes must not be marked": the
    // meaning of updateReasonType urt01–urt99 is not in the schema or sources/).
    'BRDP-EXT-00014': {
      bad: '<dmodule><identAndStatusSection><dmStatus issueType="new"/></identAndStatusSection><content><para changeMark="1">x</para></content></dmodule>',
      good: '<dmodule><identAndStatusSection><dmStatus issueType="changed"/></identAndStatusSection><content><para changeMark="1">x</para></content></dmodule>',
      alsoGood: ['<dmodule><identAndStatusSection><dmStatus issueType="new"/></identAndStatusSection><content><para>x</para></content></dmodule>'],
    },
    'BRDP-EXT-00007': {
      schema: 'dml',
      bad: '<dml><dmlIdent><dmlCode dmlType="s"/></dmlIdent><dmlContent><dmlEntry><answer/></dmlEntry></dmlContent></dml>',
      good: '<dml><dmlIdent><dmlCode dmlType="s"/></dmlIdent><dmlContent><dmlEntry><dmRef/></dmlEntry></dmlContent></dml>',
    },
    'BRDP-EXT-00013': {
      schema: 'pm',
      bad: '<pm><identAndStatusSection><pmStatus issueType="new"/></identAndStatusSection><content><pmEntry changeMark="1"/></content></pm>',
      good: '<pm><identAndStatusSection><pmStatus issueType="changed"/></identAndStatusSection><content><pmEntry changeMark="1"/></content></pm>',
    },
    // Templates round: was a boolean expression (and/or); now a path.
    'BRDP-EXT-00019': {
      schema: 'update',
      bad: '<dataUpdateFile><updateIdentAndStatusSection><updateAddress><updateIdent><updateCode infoCode="00N"/></updateIdent></updateAddress></updateIdentAndStatusSection><content><update><insertObjectGroup><insertObject><partSpec/></insertObject></insertObjectGroup></update></content></dataUpdateFile>',
      good: '<dataUpdateFile><updateIdentAndStatusSection><updateAddress><updateIdent><updateCode infoCode="00N"/></updateIdent></updateAddress></updateIdentAndStatusSection><content><update><insertObjectGroup><insertObject><toolSpec/></insertObject></insertObjectGroup></update></content></dataUpdateFile>',
      alsoGood: ['<dataUpdateFile><updateIdentAndStatusSection><updateAddress><updateIdent><updateCode infoCode="00E"/></updateIdent></updateAddress></updateIdentAndStatusSection><content><update><insertObjectGroup><insertObject><partSpec/></insertObject></insertObjectGroup></update></content></dataUpdateFile>'],
    },
    'BRDP-EXT-00001': {
      schema: 'dml',
      bad: '<dml><dmlIdent><dmlCode dmlType="p"/></dmlIdent><dmlContent><dmlEntry><commentRef/></dmlEntry></dmlContent></dml>',
      good: '<dml><dmlIdent><dmlCode dmlType="p"/></dmlIdent><dmlContent><dmlEntry><dmRef/></dmlEntry></dmlContent></dml>',
    },
    'BRDP-EXT-00012': {
      schema: 'ddn',
      bad: '<ddn><ddnContent><deliveryList><dispatchFileName>x</dispatchFileName><entityControlNumber>ICN-BIKE-0001</entityControlNumber></deliveryList></ddnContent></ddn>',
      good: '<ddn><ddnContent><deliveryList><entityControlNumber>BIKE-0001</entityControlNumber></deliveryList></ddnContent></ddn>',
    },
  },
  'BREX-3.0.1': {
    'BRDP-EXT-02634': {
      bad: '<dmodule><content><table><tgroup cols="1"><thead><colspec colname="c1"/><row/></thead></tgroup></table></content></dmodule>',
      good: '<dmodule><content><table><tgroup cols="1"><colspec colname="c1"/><thead><row/></thead><tbody/></tgroup></table></content></dmodule>',
    },
    'BRDP-EXT-02635': {
      bad: '<dmodule><content><table><tgroup cols="1"><thead><row/></thead></tgroup></table></content></dmodule>',
      good: '<dmodule><content><table><tgroup cols="1"><tbody><row/></tbody></tgroup></table></content></dmodule>',
    },
    'BRDP-EXT-02764': { bad: '<avehcfg><jacked status="maybe"/><fuel status="yes"/></avehcfg>', good: '<avehcfg><jacked status="Yes"/><fuel status="na"/></avehcfg>' },
    'BRDP-EXT-00001': {
      bad: '<dmodule><idstatus><status><orig origname="ACME ENGINEERING">9AAAA</orig></status></idstatus></dmodule>',
      good: '<dmodule><idstatus><status><orig origname="INDRA SISTEMAS SA">9BBBB</orig></status></idstatus></dmodule>',
    },
    'BRDP-EXT-02767': { bad: '<step1><title>Remove</title><para>x</para></step1>', good: '<step1><para>x</para><step2><para>y</para></step2></step1>' },
    'BRDP-S1-00019': {
      bad: '<dmodule><content><proced><prelreqs><reqpers><perskill skill="sk09"/></reqpers><reqpers/></prelreqs></proced></content></dmodule>',
      good: '<dmodule><content><proced><prelreqs><reqpers><perskill skill="sk01"/></reqpers></prelreqs></proced></content></dmodule>',
    },
    'BRDP-S1-00024': {
      bad: '<dmodule><idstatus><status><qa><firstver type="onobject"/></qa></status></idstatus></dmodule>',
      good: '<dmodule><idstatus><status><qa><firstver type="tabtop"/></qa></status></idstatus></dmodule>',
    },
    'BRDP-EXT-00006': {
      bad: '<status><orig origname="TESS-DEFENCE SA">1234A</orig></status>',
      good: '<status><orig origname="TESS-DEFENCE SA">9AEWB</orig><orig origname="INDRA SISTEMAS SA">1234A</orig></status>',
    },
    'BRDP-S1-00025': {
      bad: '<dmodule><content><proced><supply><qty uom="ZZ">2</qty></supply><spare><qty>3</qty></spare></proced></content></dmodule>',
      good: '<dmodule><content><proced><supply><qty uom="EA">2</qty></supply><spare><qty>AR</qty></spare></proced></content></dmodule>',
    },
    'BRDP-EXT-00267': {
      bad: '<dmodule><idstatus><dmaddres><dmc><avee><chapnum>A21</chapnum><section>0</section><subsect>1</subsect><subject>0</subject></avee></dmc><dmtitle><techname>CIGUENAL</techname></dmtitle></dmaddres></idstatus></dmodule>',
      good: '<dmodule><idstatus><dmaddres><dmc><avee><chapnum>A21</chapnum><section>0</section><subsect>1</subsect><subject>0</subject></avee></dmc><dmtitle><techname>CIGÜEÑAL</techname></dmtitle></dmaddres></idstatus></dmodule>',
    },
  },
};

const TEMPLATE_FILES = { 'BREX-4.2': '4-2', 'BREX-4.1': '4-1', 'BREX-3.0.1': '3-0-1' };
const notExecutableInTemplates = [];
const neverRejects = [];
for (const [format, suffix] of Object.entries(TEMPLATE_FILES)) {
  const rows = readPublicTemplate(`brdp-template-${suffix}.xlsx`).filter((r) => r['Rule Status'] === 'Verified' && r.Rule);
  const cases = TEMPLATE_CASES[format];
  check(`${format} template: 10 Verified rules`, rows.length === 10, `got ${rows.length}`);
  check(`${format} template: every rule has a case`, rows.every((r) => cases[r.ID]), rows.filter((r) => !cases[r.ID]).map((r) => r.ID).join(', '));
  for (const row of rows) {
    const c = cases[row.ID];
    if (!c) continue;
    const name = `${format} ${row.ID}`;
    const schema = c.schema || null;
    if (c.notExecutable) {
      expect(`${name}, not executable`, run(row.Rule, format, c.fragment, schema), 'not_executable', { reason: c.notExecutable });
      notExecutableInTemplates.push(`${format} ${row.ID}: ${c.notExecutable}`);
      continue;
    }
    if (c.never) {
      const r = expect(`${name}, no fragment can break it`, run(row.Rule, format, c.never, schema), 'accepted');
      check(`${name}: the path does select the node`, r.selectedNodePaths.length > 0, JSON.stringify(r));
      neverRejects.push(`${format} ${row.ID}`);
      continue;
    }
    const extra = c.partial ? { partial: new RegExp(c.partial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) } : {};
    const bad = expect(`${name}, breaking fragment`, run(row.Rule, format, c.bad, schema), 'rejected', extra);
    check(`${name}: breaking fragment has node paths`, bad.violations.every((v) => v.nodePaths.length > 0), JSON.stringify(bad.violations));
    expect(`${name}, complying fragment`, run(row.Rule, format, c.good, c.goodSchema || schema), 'accepted', extra);
    (c.alsoBad || []).forEach((f, i) => expect(`${name}, breaking fragment ${i + 2}`, run(row.Rule, format, f, schema), 'rejected', extra));
    (c.alsoGood || []).forEach((f, i) => expect(`${name}, complying fragment ${i + 2}`, run(row.Rule, format, f, schema), 'accepted', extra));
    if (c.partial) notExecutableInTemplates.push(`${format} ${row.ID} (part): ${c.partial}`);
  }
}

// ─── 3. Engine and generated Schematron agree ───────────────────────────────
// Rules with objectValue/objval (own cases + templates): the engine verdict
// must equal the verdict of the Schematron brexToSchematron.js generates.
let coherent = 0;
const coherentStatuses = new Set();
for (const r of valueRuns) {
  if (r.result.status === 'not_executable') continue;
  const sch = schematronVerdict(r.rule, r.fragment);
  check(`coherence (${r.format}): engine ${r.result.status} = Schematron ${sch}\n     rule: ${r.rule.replace(/\s+/g, ' ').slice(0, 160)}\n     fragment: ${r.fragment.slice(0, 160)}`, sch === r.result.status);
  coherent += 1;
  coherentStatuses.add(sch);
}
check('coherence compared both accepted and rejected verdicts', coherentStatuses.size === 2, [...coherentStatuses].join(','));
check('coherence covered the template value rules', coherent >= 20, `only ${coherent} runs compared`);
console.log(`Coherence: ${coherent} engine runs on rules with values replayed through the generated Schematron.`);

// ─── 4. Reasons are codes (T3, Part 0) ──────────────────────────────────────
// Every reason the engine gives is { code, params }, and every code has an
// English and a Spanish text in the real i18n resources.
{
  const tEs = i18n.getFixedT('es');
  const codeOf = (r) => r.notExecutableReason && r.notExecutableReason.code;
  const cases = [
    ['document()', run(sor('0', "document('x.xml')//dmodule"), 'BREX-4.2', '<x/>'), 'external_document', { fn: 'document()' }],
    ['doc()', run(sor('0', 'doc($u)//x'), 'BREX-4.2', '<x/>'), 'external_document', { fn: 'doc()' }],
    ['collection()', run(sor('0', "collection('c')//x"), 'BREX-4.2', '<x/>'), 'external_document', { fn: 'collection()' }],
    ['nonContextRule', run('<nonContextRule><simplePara>y</simplePara></nonContextRule>', 'BREX-4.2', '<x/>'), 'non_context_rule', {}],
    ['path that is not a path', run(sor('0', '//a and //b'), 'BREX-4.2', '<x/>'), 'path_not_nodes', { kind: 'boolean' }],
    ['XPath error', run(sor('0', '//para['), 'BREX-4.2', '<x/>'), 'xpath_error', null],
    ['allowedObjectFlag="1" outside a whole DM', run(sor('1', '//para/title'), 'BREX-4.2', '<levelledPara><para/></levelledPara>'), 'mandatory_whole_document', {}],
    ['unsupported valueForm', run(sor('2', '//@a', '<objectValue valueForm="list" valueAllowed="x"/>'), 'BREX-4.2', '<x a="1"/>'), 'unsupported_value_form', { form: 'list' }],
    ['3.0.1 single with val2', run('<objrule><objpath objappl="0">//@a</objpath><objuse>u</objuse><objval valtype="single" val1="x" val2="y"/></objrule>', 'BREX-3.0.1', '<x a="1"/>'), 'unsupported_value_form', { form: 'single with val2' }],
    ['mixed range', run(sor('2', '//@a', ov('range', '1~b')), 'BREX-4.2', '<x a="1"/>'), 'mixed_range', { from: '1', to: 'b' }],
    ['unknown format', run(sor('0', '//x'), 'XSD-1.1', '<x/>'), 'unsupported_format', { format: 'XSD-1.1' }],
    ['absolute path with another root', run(sor('0', '/dmodule/content//thead'), 'BREX-4.2', '<table><thead/></table>'), 'absolute_root', { name: 'dmodule', root: 'table' }],
    ['malformed fragment', run(sor('0', '//x'), 'BREX-4.2', '<a><b></a>'), 'fragment_not_well_formed', null],
    ['malformed rule', run('<structureObjectRule><objectPath>//x</structureObjectRule>', 'BREX-4.2', '<x/>'), 'rule_not_well_formed', null],
    ['no rule element', run('<objectUse>x</objectUse>', 'BREX-4.2', '<x/>'), 'no_rule_element', { element: 'structureObjectRule' }],
    ['empty path', run(sor('0', ''), 'BREX-4.2', '<x/>'), 'empty_path', { element: 'objectPath' }],
    ['invalid flag', run(sor('7', '//x'), 'BREX-4.2', '<x/>'), 'invalid_flag', { attr: 'allowedObjectFlag', value: '7', allowed: '0, 1, 2' }],
    ['bad range', run(sor('2', '//@a', ov('range', '1-5')), 'BREX-4.2', '<x a="1"/>'), 'bad_range', { text: '1-5' }],
    ['missing value', run(sor('2', '//@a', '<objectValue valueForm="single"/>'), 'BREX-4.2', '<x a="1"/>'), 'missing_value', { element: 'objectValue', attr: 'valueAllowed' }],
  ];
  for (const [name, result, code, params] of cases) {
    check(`code: ${name} → ${code}`, codeOf(result) === code, JSON.stringify(result.notExecutableReason));
    if (params) check(`code: ${name} params`, JSON.stringify(result.notExecutableReason?.params) === JSON.stringify(params), JSON.stringify(result.notExecutableReason?.params));
    const en = reasonText(result.notExecutableReason);
    const es = formatRuleTestReason(result.notExecutableReason, tEs);
    check(`code: ${name} has English text`, en && en !== code && !en.includes('{{'), en);
    check(`code: ${name} has a different Spanish text`, es && es !== code && es !== en && !es.includes('{{'), es);
  }
  // Several parts: a "parts" reason naming each part, translated part by part.
  const multi = run(`<rules>${sor('0', "document('x')//a")}<nonContextRule><simplePara>y</simplePara></nonContextRule></rules>`, 'BREX-4.2', '<a/>');
  check('code: several parts → parts', codeOf(multi) === 'parts' && multi.notExecutableReason.params.parts.length === 2, JSON.stringify(multi.notExecutableReason));
  check('code: parts in English', reasonText(multi.notExecutableReason) === 'rule 1: The rule reads another file (document()), which is not available in a test. rule 2: This rule has no XPath to execute (nonContextRule).', reasonText(multi.notExecutableReason));
  check('code: parts in Spanish', formatRuleTestReason(multi.notExecutableReason, tEs) === 'rule 1: La regla lee otro fichero (document()), que no está disponible en una prueba. rule 2: Esta regla no tiene XPath que ejecutar (nonContextRule).', formatRuleTestReason(multi.notExecutableReason, tEs));
  // Every code the module declares has a text in both languages.
  const { ENGINE_REASON_CODES, VERDICT_REASON_CODES } = await import('../src/utils/ruleTestReasons.js');
  for (const code of [...ENGINE_REASON_CODES, ...VERDICT_REASON_CODES.filter((c) => c !== 'test_incorrect'), 'part']) {
    for (const lng of ['en', 'es']) check(`i18n ${lng}: records.ruleTest.reasons.${code}`, i18n.exists(`records.ruleTest.reasons.${code}`, { lng }));
  }
  for (const which of ['permissive', 'strict', 'both']) {
    for (const lng of ['en', 'es']) check(`i18n ${lng}: test_incorrect.${which}`, i18n.exists(`records.ruleTest.reasons.test_incorrect.${which}`, { lng }));
  }
  // An unknown code (a newer build's reason) shows the code, never "".
  check('unknown code falls back to the code', reasonText({ code: 'from_the_future', params: {} }) === 'from_the_future');
}

console.log('\nTemplate rules not executable (whole or in part):');
for (const line of notExecutableInTemplates) console.log(`  - ${line}`);
console.log('Template rules that no fragment can break (allowedObjectFlag="2" without objectValue):');
for (const line of neverRejects) console.log(`  - ${line}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
