// Test de reglas sobre un dosier, Part 1: the Schematron engine reading the
// other files of a DITA dossier (doc(), doc-available(), document(),
// base-uri(), resolve-uri() in src/utils/ruleTestSchematron.js). Plain Node,
// no test runner (repo convention). Run: node scripts/test-rule-test-dossier.mjs
//
//   1. The four dossier rules of the DITA XPath 3.0 template (BRDP-EXT-00004,
//      00007, 00008, 00009, read from public/brdp-template-dita-xpath3.xlsx,
//      never copied): a hand-written dossier that breaks each one and one that
//      complies.
//   2. The functions themselves: base-uri of a node of each file, resolve-uri
//      with ../ and #fragment, doc-available outside the dossier, doc() on a
//      missing file (an engine error, never "not executable"), document().
//   3. What stays as it was: collection()/unparsed-text() not executable,
//      the XPath 2.0 template rules (@@…@@) not executable, a rule without
//      other-file reads not a dossier rule.
//   4. analyzeRule (dossier: true) and describeRule (the dossier line, EN/ES).
// The same verdicts in Chromium are checked by scripts/verify-rule-test-dossier.mjs.
import { DOMParser } from '@xmldom/xmldom';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { analyzeRule, describeRule, runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { DOSSIER_BASE_URI, dossierUri } from '../src/utils/ruleTestSchematron.js';
import i18n from '../src/i18n/index.js';
import { formatRuleDescription } from '../src/utils/ruleTestReasons.js';
import { DOSSIER_CASES, DOSSIER_MAP } from './lib/dossierFixtures.mjs';

const FORMAT = 'SCH-DITA';
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_level, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const runDossier = (rule, files, main = DOSSIER_MAP) =>
  runRuleOnFragment(rule, FORMAT, main, null, { parseXml, dossier: { mainPath: 'dosier.ditamap', files } });
const analyze = (rule, standard = 'DITA 1.3 Xpath3.0') => analyzeRule(rule, FORMAT, { parseXml, standard });
const summary = (r) => `${r.status} ${JSON.stringify(r.violations.map((v) => v.ruleId))} ${JSON.stringify(r.runtimeErrors || r.notExecutableReason || '')}`;

// ─── 1. The four rules of the template ──────────────────────────────────────
const rows = readPublicTemplate('brdp-template-dita-xpath3.xlsx');
const rule = (id) => rows.find((r) => r.ID === id)?.Rule;
for (const [id, cases] of Object.entries(DOSSIER_CASES)) {
  const r = rule(id);
  check(`${id}: read from the template`, Boolean(r));
  if (!r) continue;
  const a = analyze(r);
  check(`${id}: analyzeRule executable, dossier rule`, a.status === 'executable' && a.dossier === true, JSON.stringify(a));
  for (const c of cases) {
    const result = runDossier(r, c.files, c.main);
    check(`${id} — ${c.name}: ${c.status}`, result.status === c.status, summary(result));
    if (c.ids) {
      const ids = result.violations.map((v) => v.ruleId).sort().join(',');
      check(`${id} — ${c.name}: violated ${c.ids.join(',')}`, ids === [...c.ids].sort().join(','), ids);
    }
    if (c.message) check(`${id} — ${c.name}: message`, result.violations.some((v) => c.message.test(v.message)), JSON.stringify(result.violations));
    if (c.status === 'accepted' || c.status === 'rejected') {
      check(`${id} — ${c.name}: the ditamap is selected`, result.selectedNodePaths.includes('/map[1]'), JSON.stringify(result.selectedNodePaths));
    }
  }
}

// ─── 2. The functions ───────────────────────────────────────────────────────
const probe = (test, files = [], main = DOSSIER_MAP) =>
  runDossier(`<sch:pattern id="p"><sch:rule context="map"><sch:report id="R" test="true()"><sch:value-of select="${test}"/></sch:report></sch:rule></sch:pattern>`, files, main);
const value = (test, files, main) => {
  const r = probe(test, files, main);
  return r.status === 'rejected' ? r.violations[0].message : summary(r);
};
const FILES = [
  { path: 'fichas/precauciones.dita', xml: '<topic id="prec"><title>P</title></topic>' },
  { path: 'comunes/notas.dita', xml: '<topic id="notas"><title>N</title><body><note id="w1" type="warning">x</note></body></topic>' },
];
check('dossierUri', dossierUri('fichas/a.dita') === `${DOSSIER_BASE_URI}fichas/a.dita` && dossierUri('../x.dita', `${DOSSIER_BASE_URI}fichas/a.dita`) === `${DOSSIER_BASE_URI}x.dita`);
check('base-uri of a node of the ditamap', value('base-uri(//topicref[1])', FILES) === 'file:///dossier/dosier.ditamap', value('base-uri(//topicref[1])', FILES));
check('base-uri() with no argument (the context node)', value('base-uri()', FILES) === 'file:///dossier/dosier.ditamap', value('base-uri()', FILES));
check(
  'base-uri of a node of another file',
  value("base-uri(doc('fichas/precauciones.dita')//title)", FILES) === 'file:///dossier/fichas/precauciones.dita',
  value("base-uri(doc('fichas/precauciones.dita')//title)", FILES),
);
check(
  'resolve-uri with ../ from a node of another file',
  value("resolve-uri('../comunes/notas.dita', base-uri(doc('fichas/precauciones.dita')/*))", FILES) === 'file:///dossier/comunes/notas.dita',
);
check("resolve-uri with one argument: against the ditamap", value("resolve-uri('fichas/a.dita')", FILES) === 'file:///dossier/fichas/a.dita');
check("resolve-uri keeps a #fragment (the rule removes it)", value("resolve-uri('a.dita#t1/x', base-uri(.))", FILES) === 'file:///dossier/a.dita#t1/x');
check("resolve-uri of an absolute URI: unchanged", value("resolve-uri('http://example.com/a.dita', base-uri(.))", FILES) === 'http://example.com/a.dita');
check('doc-available: a dossier file', value("doc-available('file:///dossier/fichas/precauciones.dita')", FILES) === 'true');
check('doc-available: relative to the ditamap', value("doc-available('comunes/notas.dita')", FILES) === 'true');
check('doc-available: another folder', value("doc-available('file:///otra/fichas/precauciones.dita')", FILES) === 'false');
check('doc-available: http', value("doc-available('http://example.com/fichas/precauciones.dita')", FILES) === 'false');
check('doc-available: not in the dossier', value("doc-available('fichas/zz.dita')", FILES) === 'false');
check('doc-available: a file that does not parse', value("doc-available('roto.dita')", [{ path: 'roto.dita', xml: '<topic><title>x</topic>' }]) === 'false');
check('doc-available: the ditamap itself', value("doc-available('dosier.ditamap')", FILES) === 'true');
check('doc() reads the file', value("doc('comunes/notas.dita')//note/@id", FILES) === 'w1');
check('document() reads the file', value("document('comunes/notas.dita')//note/@type", FILES) === 'warning');
check(
  'document($u, $node) resolves against the node',
  value("document('../comunes/notas.dita', doc('fichas/precauciones.dita')/*)//note/@id", FILES) === 'w1',
);
check('the same file read twice is the same document', value("doc('comunes/notas.dita') is doc('file:///dossier/comunes/notas.dita')", FILES) === 'true');
check("root() of a node of another file is that file", value("root(doc('comunes/notas.dita')//note) is doc('comunes/notas.dita')", FILES) === 'true');
{
  // doc() without doc-available() on a missing file: an engine error on this
  // example, never "not executable".
  const r = probe("doc('fichas/zz.dita')//title", FILES);
  check('doc() on a missing file: status error', r.status === 'error', summary(r));
  check('  FODC0002 with the URI', /FODC0002/.test(r.runtimeErrors?.[0]?.message || '') && /fichas\/zz\.dita/.test(r.runtimeErrors?.[0]?.message || ''), JSON.stringify(r.runtimeErrors));
  const a = analyze(`<sch:pattern id="p"><sch:rule context="map"><sch:assert id="A" test="exists(doc('fichas/zz.dita'))">x</sch:assert></sch:rule></sch:pattern>`);
  check('  analyzeRule: executable (the file may be in another example)', a.status === 'executable' && a.dossier === true, JSON.stringify(a));
}
// No dossier given: the main document still has a URI, nothing else exists.
{
  const r = runRuleOnFragment(
    "<sch:pattern id=\"p\"><sch:rule context=\"map\"><sch:assert id=\"A\" test=\"doc-available('fichas/a.dita')\">missing</sch:assert></sch:rule></sch:pattern>",
    FORMAT,
    '<map><topicref href="fichas/a.dita"/></map>',
    null,
    { parseXml },
  );
  check('no dossier: doc-available false → the assert fails', r.status === 'rejected', summary(r));
}

// ─── 3. What stays as it was ────────────────────────────────────────────────
const one = (test) => `<sch:pattern id="x"><sch:rule context="map"><sch:assert id="X" test="${test}">x</sch:assert></sch:rule></sch:pattern>`;
for (const [name, test, fn] of [
  ['collection()', 'exists(collection())', 'collection()'],
  ['unparsed-text()', "unparsed-text('a.txt') != ''", 'unparsed-text()'],
  ['unparsed-text-available()', "unparsed-text-available('a.txt')", 'unparsed-text-available()'],
]) {
  const a = analyze(one(test));
  check(`${name}: still not executable`, a.status === 'not_executable' && a.reason?.code === 'external_document' && a.reason.params.fn === fn, JSON.stringify(a));
  const r = runDossier(one(test), FILES);
  check(`${name}: not executable on a dossier too`, r.status === 'not_executable' && r.notExecutableReason?.code === 'external_document', summary(r));
}
for (const row of readPublicTemplate('brdp-template-dita-xpath2.xlsx').filter((r) => ['BRDP-EXT-00007', 'BRDP-EXT-00008', 'BRDP-EXT-00009'].includes(r.ID))) {
  const a = analyze(row.Rule, 'DITA 1.3 Xpath2.0');
  check(`xpath2 ${row.ID} (@@…@@): still not executable`, a.status === 'not_executable' && a.reason?.code === 'external_placeholder' && !a.dossier, JSON.stringify(a));
}
{
  const plain = '<sch:pattern id="p"><sch:rule context="note"><sch:assert id="N" test="@type">x</sch:assert></sch:rule></sch:pattern>';
  check('a rule without other-file reads is not a dossier rule', analyze(plain).dossier === false && !describeRule(plain, FORMAT, { parseXml }).dossier);
  // A literal mentioning doc( does not make a dossier rule.
  const literal = `<sch:pattern id="p"><sch:rule context="note"><sch:assert id="N" test="@type != 'doc(x)'">x</sch:assert></sch:rule></sch:pattern>`;
  check('doc( inside a string literal: not a dossier rule', analyze(literal).dossier === false);
  // BREX: document() stays not executable.
  const brex = '<structureObjectRule id="b"><objectPath allowedObjectFlag="0">document(\'x.xml\')//dmodule</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const b = analyzeRule(brex, 'BREX-4.2', { parseXml });
  check('BREX with document(): still not executable', b.status === 'not_executable' && b.reason?.code === 'external_document', JSON.stringify(b));
}

// ─── 4. describeRule ────────────────────────────────────────────────────────
{
  const d = describeRule(rule('BRDP-EXT-00007'), FORMAT, { parseXml });
  check('describe: dossier line first', d.dossier === true && d.statements[0]?.statement.code === 'describe_dossier', JSON.stringify(d.statements[0]));
  const en = formatRuleDescription(d, i18n.getFixedT('en'))?.lines[0] || '';
  const es = formatRuleDescription(d, i18n.getFixedT('es'))?.lines[0] || '';
  check('describe EN', en === 'Reads other files of the dossier: the examples include the ditamap and the topics it points to.', en);
  check('describe ES', es === 'Lee otros ficheros del dosier: los ejemplos incluyen el ditamap y las fichas a las que apunta.', es);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
