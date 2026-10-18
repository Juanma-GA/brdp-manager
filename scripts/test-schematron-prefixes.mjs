// Generate (Schematron DITA): namespace prefixes the XPath uses without a
// <sch:ns> declaration. A real Schematron compiler refuses the document
// (XPST0081); only <sch:ns> declares a prefix for the XPath of the rules
// (checked with SchXslt + Saxon: an xmlns: on a sch:pattern does not).
//
// Real rules: the Navantia "DITA 1.3 Xpath3.0" rules imported from its
// Schematron (scripts/rule-test-fixtures/schematron-extract-rules.json),
// with their xmlns:xs removed, the shape of the rules that came from Excel
// in production (functions typed "as xs:string", no declaration anywhere),
// and the curated DITA templates.
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { generateSchematronDITA, checkWellFormedSchematron } from '../src/api/generateSchematronDITA.js';
import {
  ruleUndeclaredPrefixes,
  schematronPrefixUses,
  undeclaredSchematronPrefixes,
  xpathPrefixes,
} from '../src/utils/xpathPrefixes.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { readTextFile } from './lib/textFile.mjs';

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const ROOT = new URL('../', import.meta.url);
const summary = JSON.parse(readTextFile(new URL('public/schematron-dita-schema-summary.json', ROOT)));
const extract = JSON.parse(readTextFile(new URL('scripts/rule-test-fixtures/schematron-extract-rules.json', ROOT)));
const XS = 'http://www.w3.org/2001/XMLSchema';

function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_level, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0]);
  return doc;
}

async function generate(rules, standard = 'DITA 1.3 Xpath3.0') {
  const brdps = rules.map((r, i) => ({ id: `b${i}`, identifier: r.identifier, validation: 'Validated' }));
  const approvals = rules.map((r, i) => ({ brdp_id: `b${i}`, status: 'approved', rule_xml: r.rule_xml }));
  return generateSchematronDITA(brdps, { projectName: 'P' }, { approvals, schemaSummary: summary, standard });
}

const nsLines = (xml) => xml.split('\n').filter((l) => /<sch:ns\b/.test(l));
const count = (xml, prefix) => nsLines(xml).filter((l) => l.includes(`prefix="${prefix}"`)).length;
const withoutXmlnsXs = (rule) => rule.replace(/\s+xmlns:xs="[^"]*"/g, '');

// ─── 1. Prefixes of one XPath expression ────────────────────────────────────
const prefixCases = [
  ['function($t as element()) as xs:string { string($t) }', ['xs']],
  ['fn:head($docs)', ['fn']],
  ['math:sqrt(4) + map:size($m) + array:size($a)', ['array', 'map', 'math']],
  ["child::title and descendant-or-self::p", []],
  ["let $a := 1 return $a", []],
  ["normalize-space(.) = 'xs:string'", []],
  ['. = "fn:head(x)"', []],
  ["contains(., 'it''s xs:x')", []],
  ['(: xs:string fn:head :) count(*)', []],
  ['(: outer (: xs:a :) fn:b :) 1', []],
  ['Q{http://www.w3.org/2001/XMLSchema}string(.)', []],
  ['@xlink:href', ['xlink']],
  ['@xml:lang = "es"', []],
  ["map{'a': 1}", []],
  ['foo:* | bar:x', ['bar', 'foo']],
  ['. = &quot;xs:x&quot; and xs:integer(.) &gt; 1', ['xs']],
  ['$p:var', ['p']],
  ['$valor(., $colDe($cab, &apos;Cant.&apos;))', []],
  ['matches(., "^file:/+[^:]+/.+/$")', []],
];
for (const [expr, expected] of prefixCases) {
  const got = [...xpathPrefixes(expr)].sort();
  check(`prefixes of ${expr}`, JSON.stringify(got) === JSON.stringify(expected), `got ${JSON.stringify(got)}`);
}

// ─── 2. Uses in a Schematron: attributes only, comments never ──────────────
{
  const sch = `<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron">
  <!-- <sch:let name="x" value="fn:head(.)"/> -->
  <sch:let name="g" value="math:pi()"/>
  <sch:pattern id="p-A"><sch:rule context="topic"><sch:assert id="A" test="xs:string(.) != ''">Text that says xs:string and fn:head, <sch:value-of select="err:x(.)"/></sch:assert></sch:rule></sch:pattern>
  <pattern><rule context="foo:topic"><report id="B" test="true()">x</report></rule></pattern>
</sch:schema>`;
  const uses = schematronPrefixUses(sch);
  check('uses: comment fn: not counted', !uses.has('fn'));
  check('uses: xs: of p-A', [...(uses.get('xs') || [])].join() === 'p-A');
  check('uses: err: in sch:value-of/@select', uses.has('err'));
  check('uses: schema-level let named', [...(uses.get('math') || [])].join() === '$g');
  check('uses: unprefixed pattern owner = its report id', [...(uses.get('foo') || [])].join() === 'B');
  const undeclared = undeclaredSchematronPrefixes(sch).map((u) => u.prefix);
  check('undeclared: every used prefix with no sch:ns', undeclared.join() === 'err,foo,math,xs', undeclared.join());
  const declared = sch.replace('<sch:let name="g"', `<sch:ns prefix="xs" uri="${XS}"/>\n  <sch:let name="g"`);
  check('sch:ns declares', !undeclaredSchematronPrefixes(declared).some((u) => u.prefix === 'xs'));
  const onPattern = sch.replace('<sch:pattern id="p-A"', `<sch:pattern xmlns:xs="${XS}" id="p-A"`);
  check('xmlns:xs on the pattern does not declare it (as SchXslt)', undeclaredSchematronPrefixes(onPattern).some((u) => u.prefix === 'xs'));
}

// ─── 3. Generate: the Navantia rules as they are in production ─────────────
const navantia = extract.xpath3;
check('fixture: 7 Navantia XPath 3.0 rules', navantia.length === 7);
check('fixture: they use xs:', navantia.some((r) => schematronPrefixUses(r.rule_xml).has('xs')));
{
  // Production: no xmlns:xs anywhere, functions typed "as xs:…".
  const production = navantia.map((r) => ({ ...r, rule_xml: withoutXmlnsXs(r.rule_xml) }));
  check('production rules: no declaration at all', production.every((r) => !/xmlns:xs/.test(r.rule_xml)));
  const res = await generate(production);
  check('production: one sch:ns xs', count(res.xml, 'xs') === 1, nsLines(res.xml).join(' | '));
  check('production: sch:ns xs with the XML Schema URI', res.xml.includes(`<sch:ns prefix="xs" uri="${XS}"/>`));
  check('production: added = [xs]', JSON.stringify(res.addedNamespaces) === '["xs"]', JSON.stringify(res.addedNamespaces));
  check('production: no undeclared prefix warning', res.undeclaredPrefixes.length === 0);
  check('production: valid', res.valid, res.errors.join('; '));
  check('production: every used prefix declared', undeclaredSchematronPrefixes(res.xml).length === 0);
  const titleAt = res.xml.indexOf('</sch:title>');
  const nsAt = res.xml.indexOf('<sch:ns prefix="xs"');
  const firstLet = res.xml.indexOf('<sch:let');
  check('production: sch:ns right after sch:title, before the lets', titleAt < nsAt && nsAt < firstLet);
  // What the document was before: same document without the sch:ns line.
  const before = res.xml.replace(/\n\s*<sch:ns prefix="xs"[^>]*\/>/, '');
  const check2 = checkWellFormedSchematron(before, 'xslt3');
  check('without the sch:ns: checkWellFormed reports xs', check2.undeclaredPrefixes.some((u) => u.prefix === 'xs'));
  check('without the sch:ns: not valid, XPST0081 named', !check2.valid && check2.errors.some((e) => /'xs'.*XPST0081/.test(e)), check2.errors.join('; '));
}
{
  // Rules that already bring xmlns:xs (00007): one sch:ns xs, never two.
  const mixed = navantia.map((r) => (r.identifier === 'BRDP-EXT-00007' ? r : { ...r, rule_xml: withoutXmlnsXs(r.rule_xml) }));
  const res = await generate(mixed);
  check('00007 with xmlns:xs: one sch:ns xs', count(res.xml, 'xs') === 1, nsLines(res.xml).join(' | '));
  check('00007 with xmlns:xs: nothing added (declared by the rule)', res.addedNamespaces.length === 0);
  const all = await generate(navantia);
  check('all with xmlns:xs: one sch:ns xs', count(all.xml, 'xs') === 1);
}

// ─── 4. Unknown prefix, literals and comments ───────────────────────────────
const plain = (id, body, attrs = '') =>
  `<sch:pattern id="p-${id}"${attrs}><sch:rule context="topic">${body}<sch:assert id="${id}" role="error" test="exists(title)">x</sch:assert></sch:rule></sch:pattern>`;
{
  const res = await generate([
    { identifier: 'BRDP-EXT-00090', rule_xml: plain('BRDP-EXT-00090', '<sch:let name="v" value="foo:bar(.)"/>') },
    { identifier: 'BRDP-EXT-00091', rule_xml: plain('BRDP-EXT-00091', '<sch:let name="w" value="foo:baz(.)"/>') },
  ]);
  check('unknown foo: reported with both rules', JSON.stringify(res.undeclaredPrefixes) === JSON.stringify([{ prefix: 'foo', rules: ['BRDP-EXT-00090', 'BRDP-EXT-00091'] }]), JSON.stringify(res.undeclaredPrefixes));
  check('unknown foo: document generated anyway', res.xml.includes('foo:bar(.)'));
  check('unknown foo: no sch:ns for it', count(res.xml, 'foo') === 0);
  check('unknown foo: checkWellFormed error', !res.valid && res.errors.some((e) => /'foo'.*XPST0081/.test(e)), res.errors.join('; '));
}
{
  const res = await generate([
    { identifier: 'BRDP-EXT-00092', rule_xml: plain('BRDP-EXT-00092', '<sch:let name="v" value="foo:bar(.)"/>', ' xmlns:foo="urn:foo"') },
  ]);
  check('unknown foo declared by the rule: sch:ns foo', res.xml.includes('<sch:ns prefix="foo" uri="urn:foo"/>'));
  check('unknown foo declared by the rule: no warning', res.undeclaredPrefixes.length === 0 && res.valid, res.errors.join('; '));
}
{
  const rule = plain('BRDP-EXT-00093', '<!-- as xs:string, fn:head --><sch:let name="v" value="normalize-space(.) = \'xs:string\'"/>');
  const res = await generate([{ identifier: 'BRDP-EXT-00093', rule_xml: rule }]);
  check('xs: only in a literal and a comment: no sch:ns', nsLines(res.xml).length === 0, nsLines(res.xml).join(' | '));
  check('xs: only in a literal and a comment: valid', res.valid && res.undeclaredPrefixes.length === 0);
}
{
  // fn: and math: in a rule with only xmlns:xs: both added, in a fixed order.
  const rule = plain('BRDP-EXT-00094', '<sch:let name="v" value="fn:head(math:pi())"/><sch:let name="t" value="xs:string(.)"/>', ` xmlns:xs="${XS}"`);
  const res = await generate([{ identifier: 'BRDP-EXT-00094', rule_xml: rule }]);
  check('fn/math added after the rule\'s own xs', JSON.stringify(nsLines(res.xml).map((l) => /prefix="(\w+)"/.exec(l)[1])) === '["xs","fn","math"]', nsLines(res.xml).join(' | '));
  check('fn/math: added = [fn, math]', JSON.stringify(res.addedNamespaces) === '["fn","math"]');
}

// ─── 5. Curated DITA templates ──────────────────────────────────────────────
for (const [file, standard, xsCount] of [
  ['brdp-template-dita-xpath2.xlsx', 'DITA 1.3 Xpath2.0', 0],
  ['brdp-template-dita-xpath3.xlsx', 'DITA 1.3 Xpath3.0', 1],
]) {
  const rows = readPublicTemplate(file).filter((r) => r.Rule && r['Rule Status'] === 'Verified');
  const res = await generate(rows.map((r) => ({ identifier: r.ID, rule_xml: r.Rule })), standard);
  check(`${file}: ${xsCount} sch:ns xs`, count(res.xml, 'xs') === xsCount, nsLines(res.xml).join(' | '));
  check(`${file}: no other sch:ns`, nsLines(res.xml).length === xsCount);
  check(`${file}: every used prefix declared`, undeclaredSchematronPrefixes(res.xml).length === 0, JSON.stringify(undeclaredSchematronPrefixes(res.xml)));
  check(`${file}: valid`, res.valid, res.errors.join('; '));
}

// ─── 6. Rule test: informative warning in analyzeRule ───────────────────────
{
  const known = plain('BRDP-EXT-00095', '<sch:let name="f" value="function($t as element()) as xs:string { string($t) }"/><sch:let name="h" value="fn:exists(title)"/>');
  const unknown = plain('BRDP-EXT-00096', '<sch:let name="v" value="foo:bar(.)"/>');
  const declared = plain('BRDP-EXT-00097', '<sch:let name="t" value="xs:string(.)"/>', ` xmlns:xs="${XS}"`);
  check('ruleUndeclaredPrefixes: known', JSON.stringify(ruleUndeclaredPrefixes(known)) === JSON.stringify({ known: ['fn', 'xs'], unknown: [] }));
  check('ruleUndeclaredPrefixes: declared on the pattern', JSON.stringify(ruleUndeclaredPrefixes(declared)) === JSON.stringify({ known: [], unknown: [] }));
  const opts = { standard: 'DITA 1.3 Xpath3.0', parseXml };
  const a1 = analyzeRule(known, 'SCH-DITA', opts);
  const w1 = (a1.warnings || []).find((w) => w.code === 'undeclared_known_prefix');
  check('analyzeRule: known prefixes warning, still executable', a1.status === 'executable' && w1 && w1.params.prefixes === 'fn:, xs:', JSON.stringify(a1.warnings));
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  check('warning EN', formatRuleTestReason(w1, en).startsWith('The rule uses the prefixes fn:, xs: without declaring them. Generate declares them'), formatRuleTestReason(w1, en));
  check('warning ES', formatRuleTestReason(w1, es).includes('un validador real fallará si el Schematron final no los declara'), formatRuleTestReason(w1, es));
  const a2 = analyzeRule(unknown, 'SCH-DITA', opts);
  const w2 = (a2.warnings || []).find((w) => w.code === 'undeclared_prefix');
  check('analyzeRule: unknown prefix warning', w2 && w2.params.prefixes === 'foo:', JSON.stringify(a2.warnings));
  check('warning unknown ES singular', formatRuleTestReason(w2, es).startsWith('La regla usa el prefijo foo: sin declararlo'), formatRuleTestReason(w2, es));
  const a3 = analyzeRule(declared, 'SCH-DITA', opts);
  check('analyzeRule: declared prefix, no warning', !(a3.warnings || []).some((w) => /undeclared/.test(w.code)), JSON.stringify(a3.warnings));
  // The Navantia rules as in production: the warning names xs:.
  const prod = withoutXmlnsXs(navantia[0].rule_xml);
  const a4 = analyzeRule(prod, 'SCH-DITA', opts);
  check('Navantia 00001 without xmlns:xs: xs: warning', (a4.warnings || []).some((w) => w.code === 'undeclared_known_prefix' && w.params.prefixes === 'xs:'));
}

// ─── 7. S1000D generators never use this ────────────────────────────────────
for (const file of ['generateBREX.js', 'generateBREX41.js', 'generateBREX301.js', 'generateBREXSch.js', 'brexToSchematron.js']) {
  const text = fs.readFileSync(new URL(`src/api/${file}`, ROOT), 'utf8');
  check(`${file}: untouched by the prefix check`, !text.includes('xpathPrefixes'));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
