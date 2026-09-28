// Test de reglas T4: the Schematron engine (src/utils/ruleTestSchematron.js,
// reached through ruleTestEngine.js's runRuleOnFragment / analyzeRule /
// describeRule with format SCH-DITA). Plain Node, no test runner (repo
// convention). Run: node scripts/test-rule-test-engine-sch.mjs
//
//   1. Every Verified rule of the two DITA templates (public/brdp-template-
//      dita-xpath{2,3}.xlsx): a hand-written fragment that breaks it and one
//      that complies, or its not-executable reason -- a template rule without
//      a case here fails the test.
//   2. Own cases: first rule wins in a pattern, report vs assert, roles,
//      with and without the sch: prefix, lets (pattern and rule, in order,
//      inline functions), every/some, for, value-of/name, analyze-string,
//      the not-executable reasons, phases, several patterns.
//   3. analyzeRule (static reasons, XPath 3.x warnings in an XPath 2.0
//      project) and describeRule (codes and their EN/ES text).
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import XLSX from 'xlsx';
import { analyzeRule, describeRule, runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import i18n from '../src/i18n/index.js';
import { ENGINE_REASON_CODES, formatRuleDescription, formatRuleTestReason } from '../src/utils/ruleTestReasons.js';

const FORMAT = 'SCH-DITA';
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
  } else {
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
const run = (rule, fragment) => runRuleOnFragment(rule, FORMAT, fragment, null, { parseXml });
const analyze = (rule, standard = 'DITA 1.3 Xpath3.0') => analyzeRule(rule, FORMAT, { parseXml, standard });
const describe = (rule) => describeRule(rule, FORMAT, { parseXml });

// expect(name, result, status, { reason: code, message: RegExp, ids: [...] })
function expect(name, result, status, extra = {}) {
  check(`${name}: ${status}`, result.status === status, JSON.stringify(result).slice(0, 600));
  if (extra.reason) {
    const code = result.notExecutableReason?.code;
    check(`${name}: reason ${extra.reason}`, code === extra.reason, JSON.stringify(result.notExecutableReason));
  }
  if (extra.message) {
    check(`${name}: message`, result.violations.some((v) => extra.message.test(v.message)), JSON.stringify(result.violations));
  }
  if (extra.ids) {
    const ids = result.violations.map((v) => v.ruleId).sort().join(',');
    check(`${name}: violated ${extra.ids.join(',')}`, ids === [...extra.ids].sort().join(','), ids);
  }
  if (status === 'rejected') {
    check(`${name}: node paths`, result.violations.every((v) => v.nodePaths.length > 0 && v.nodePaths.every((p) => p.startsWith('/'))), JSON.stringify(result.violations));
  }
  return result;
}

// ─── Fragments ──────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// A cell: 'text', null (no <entry> in that column), or { v, morerows }.
function table(headers, rows) {
  const head = headers.map((h, i) => `<entry colname="c${i + 1}">${esc(h)}</entry>`).join('');
  const body = rows
    .map((r) => {
      const cells = r
        .map((cell, i) => {
          if (cell === null) return '';
          if (typeof cell === 'object') return `<entry colname="c${i + 1}" morerows="${cell.morerows}">${esc(cell.v)}</entry>`;
          return `<entry colname="c${i + 1}">${esc(cell)}</entry>`;
        })
        .join('');
      return `<row>${cells}</row>`;
    })
    .join('');
  return `<table><tgroup cols="${headers.length}"><thead><row>${head}</row></thead><tbody>${body}</tbody></tgroup></table>`;
}
const topic = (body, attrs = ' xml:lang="es-ES"', prolog = '') =>
  `<topic id="t1"${attrs}><title>Mantenimiento de la bomba de achique</title>${prolog}<body>${body}</body></topic>`;
const section = (title, inner) => `<section><title>${esc(title)}</title>${inner}</section>`;

const LISTA = 'LISTA DE MATERIAL OBLIGATORIO';
const DOCTEC = 'Documento Técnico / Manual Técnico / Número de Plano';

// ─── 1. Template rules ──────────────────────────────────────────────────────
// Per template: bad (→ rejected, with the violated ids), good (→ accepted),
// notExecutable (reason code), or never (a fragment it selects but that no
// fragment can break).
const cantBad = topic(section(LISTA, table(['Part', 'Descripción', 'Cant.'], [
  ['1', 'Tornillo M6', '4'],
  [{ v: '2', morerows: 0 }, 'Arandela', { v: '8', morerows: 0 }],
  ['3', 'Tuerca', null],
])));
const cantGood = topic(section(LISTA, table(['Part', 'Descripción', 'Cant.'], [
  ['1', 'Tornillo M6', '4'],
  ['2', 'Arandela', { v: '8', morerows: 1 }],
  ['3', 'Tuerca', null],
  ['', 'Nota: consumibles a criterio del taller', ''],
])));
const colTable = (col, value, extra = []) =>
  topic(section('IDENTIFICACIÓN DE EQUIPOS', table(['Part', 'Descripción', col], [['1', 'Bomba', value], ...extra])));
const figTable = (docTec, marca, before = []) =>
  topic(section(LISTA, table(['Part', DOCTEC, 'Marca'], [...before, ['', 'Repuestos', ''], ['1', docTec, marca]])));

const COMMON = {
  'BRDP-EXT-00001': { bad: cantBad, ids: ['BRDP-EXT-00001'], good: cantGood },
  'BRDP-EXT-00002': {
    bad: colTable('NCAGE', '-.'),
    ids: ['BRDP-EXT-00002'],
    good: colTable('NCAGE', 'A1B2C', [['2', 'Filtro', '-'], ['', 'Nota', 'xx']]),
  },
  'BRDP-EXT-00003': { bad: colTable('Part Number', ''), ids: ['BRDP-EXT-00003'], good: colTable('Part Number', '-', [['2', 'Filtro', 'PN-4471']]) },
  'BRDP-EXT-00005': { bad: colTable('NOC', '123'), ids: ['BRDP-EXT-00005'], good: colTable('NOC', '1234567890123', [['2', 'Filtro', '-']]) },
  'BRDP-EXT-00006': {
    bad: figTable('Figura 9 y la 10', 'x'),
    ids: ['BRDP-EXT-00006a', 'BRDP-EXT-00006b'],
    // The row before "Repuestos" is not in the rule's context.
    good: figTable('Figura 9 Figura 10', '3 4', [['7', 'sin formato', 'x']]),
  },
  'BRDP-D1-00020': { bad: topic('<p>Texto.</p>', ''), ids: ['BRDP-D1-00020'], good: topic('<p>Texto.</p>') },
};
const TEMPLATE_CASES = {
  'dita-xpath2': {
    ...COMMON,
    'BRDP-EXT-00007': { notExecutable: 'external_document' },
    'BRDP-EXT-00008': { notExecutable: 'external_document' },
    // Its only test compares a literal ('@@URI-CARPETA-DOSIER@@') with
    // 'file:': as written it can never fail.
    'BRDP-EXT-00009': { never: topic('<note type="warning" conref-no-resuelto="comunes.dita#n/n1">No leída</note>') },
    'BRDP-D1-00065': {
      bad: topic('<p>Texto.</p>'),
      ids: ['BRDP-D1-00065'],
      good: topic('<p>Texto.</p>', ' xml:lang="es-ES"', '<prolog><copyright><copyryear year="2026"/><copyrholder>Astillero Ejemplo</copyrholder></copyright></prolog>'),
    },
  },
  'dita-xpath3': {
    ...COMMON,
    'BRDP-EXT-00004': { notExecutable: 'external_document' },
    'BRDP-EXT-00007': { notExecutable: 'external_document' },
    'BRDP-EXT-00008': { notExecutable: 'external_document' },
    'BRDP-EXT-00009': { notExecutable: 'external_document' },
    'BRDP-EXT-00006': {
      ...COMMON['BRDP-EXT-00006'],
      // sch:value-of in the message, evaluated.
      message: /Valor leído: "Figura 9 y la 10"/,
    },
  },
};

const notExecutableInTemplates = [];
const neverRejects = [];
const templateRules = {};
for (const [suffix, cases] of Object.entries(TEMPLATE_CASES)) {
  const wb = XLSX.read(fs.readFileSync(new URL(`../public/brdp-template-${suffix}.xlsx`, import.meta.url)));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).filter((r) => r['Rule Status'] === 'Verified' && r.Rule);
  templateRules[suffix] = rows;
  check(`${suffix} template: 10 Verified rules`, rows.length === 10, `got ${rows.length}`);
  check(`${suffix} template: every rule has a case`, rows.every((r) => cases[r.ID]), rows.filter((r) => !cases[r.ID]).map((r) => r.ID).join(', '));
  for (const row of rows) {
    const c = cases[row.ID];
    if (!c) continue;
    const name = `${suffix} ${row.ID}`;
    if (c.notExecutable) {
      const r = expect(`${name}, not executable`, run(row.Rule, topic('<p/>')), 'not_executable', { reason: c.notExecutable });
      const a = analyze(row.Rule);
      check(`${name}: analyzeRule knows it from the start`, a.status === 'not_executable' && a.reason?.code === c.notExecutable, JSON.stringify(a));
      notExecutableInTemplates.push(`${name}: ${formatRuleTestReason(r.notExecutableReason, i18n.getFixedT('en'))}`);
      continue;
    }
    check(`${name}: analyzeRule executable`, analyze(row.Rule).status === 'executable', JSON.stringify(analyze(row.Rule)));
    if (c.never) {
      const r = expect(`${name}, no fragment can break it`, run(row.Rule, c.never), 'accepted');
      check(`${name}: the context does select the node`, r.selectedNodePaths.length > 0, JSON.stringify(r));
      neverRejects.push(name);
      continue;
    }
    expect(`${name}, breaking fragment`, run(row.Rule, c.bad), 'rejected', { ids: c.ids, message: c.message });
    const good = expect(`${name}, complying fragment`, run(row.Rule, c.good), 'accepted');
    check(`${name}: complying fragment is selected`, good.selectedNodePaths.length > 0, JSON.stringify(good));
  }
}

// The same template rule in both dialects gives the same verdicts.
for (const id of Object.keys(COMMON)) {
  const r2 = templateRules['dita-xpath2'].find((r) => r.ID === id);
  const r3 = templateRules['dita-xpath3'].find((r) => r.ID === id);
  if (!r2 || !r3) continue;
  for (const [kind, fragment] of [['bad', COMMON[id].bad], ['good', COMMON[id].good]]) {
    check(`${id} ${kind}: XPath 2.0 and 3.0 templates agree`, run(r2.Rule, fragment).status === run(r3.Rule, fragment).status);
  }
}

// XPath 3.x syntax: a warning in an XPath 2.0 project, never in 3.0; and the
// XPath 2.0 template itself uses none.
for (const row of templateRules['dita-xpath2']) {
  const a = analyze(row.Rule, 'DITA 1.3 Xpath2.0');
  check(`xpath2 ${row.ID}: no XPath 3.x warning`, a.warnings.length === 0, JSON.stringify(a.warnings));
}
{
  const xp3 = templateRules['dita-xpath3'].find((r) => r.ID === 'BRDP-EXT-00006').Rule;
  const w = analyze(xp3, 'DITA 1.3 Xpath2.0');
  check('xpath3 EXT-00006 in an XPath 2.0 project: xpath3_syntax warning', w.warnings[0]?.code === 'xpath3_syntax', JSON.stringify(w.warnings));
  check('  names the inline function and let', /inline function/.test(w.warnings[0]?.params.features) && /let expression/.test(w.warnings[0]?.params.features), w.warnings[0]?.params.features);
  check('  names analyze-string()', /analyze-string\(\)/.test(w.warnings[0]?.params.features));
  check('  still executable', w.status === 'executable');
  check('same rule in an XPath 3.0 project: no warning', analyze(xp3, 'DITA 1.3 Xpath3.0').warnings.length === 0);
  check('  and it still runs in the XPath 2.0 project', run(xp3, COMMON['BRDP-EXT-00006'].bad).status === 'rejected');
}

// ─── 2. Own cases ───────────────────────────────────────────────────────────
const sch = (body, prefix = 'sch:') => body.replace(/<(\/?)§/g, `<$1${prefix}`);
const NOTE_TYPE = sch('<§pattern id="p-note"><§rule context="note"><§assert id="N1" role="error" test="@type">Every note must declare @type.</§assert></§rule></§pattern>');

// Edge table: context="note" + assert test="@type".
expect('note without @type', run(NOTE_TYPE, topic('<note>Drain the tank first.</note>')), 'rejected', { message: /^Every note must declare @type\.$/, ids: ['N1'] });
expect('note with @type', run(NOTE_TYPE, topic('<note type="caution">Drain the tank first.</note>')), 'accepted');
{
  const r = run(NOTE_TYPE, topic('<note>a</note><note type="tip">b</note><section><note>c</note></section>'));
  check('violation groups both bad notes', r.violations.length === 1 && r.violations[0].nodePaths.length === 2, JSON.stringify(r.violations));
  check('  node paths point at the notes', r.violations[0].nodePaths.join(' ') === '/topic[1]/body[1]/note[1] /topic[1]/body[1]/section[1]/note[1]', r.violations[0].nodePaths.join(' '));
  check('  every note is selected', r.selectedNodePaths.length === 3);
}
// Without the prefix: same verdicts.
const NOTE_TYPE_BARE = NOTE_TYPE.replace(/sch:/g, '');
expect('no prefix, note without @type', run(NOTE_TYPE_BARE, topic('<note>x</note>')), 'rejected', { ids: ['N1'] });
expect('no prefix, note with @type', run(NOTE_TYPE_BARE, topic('<note type="note">x</note>')), 'accepted');
// Another prefix bound to the ISO namespace.
expect(
  'iso: prefix bound to the Schematron namespace',
  run(NOTE_TYPE.replace(/sch:/g, 'iso:').replace('<iso:pattern ', '<iso:pattern xmlns:iso="http://purl.oclc.org/dsdl/schematron" '), topic('<note>x</note>')),
  'rejected'
);
// A whole sch:schema with a phase: the phase is ignored, every pattern runs.
{
  const rule = sch(
    '<§schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2" defaultPhase="only-a"><§phase id="only-a"><§active pattern="a"/></§phase>' +
      '<§pattern id="a"><§rule context="note"><§assert id="A" test="@type">a</§assert></§rule></§pattern>' +
      '<§pattern id="b"><§rule context="p"><§report id="B" test="contains(., \'TODO\')">b</§report></§rule></§pattern></§schema>'
  );
  expect('sch:phase ignored: both patterns run', run(rule, topic('<note>x</note><p>TODO: torque</p>')), 'rejected', { ids: ['A', 'B'] });
}

// First rule wins within a pattern; another pattern judges the node again.
{
  const rule = sch(
    '<§pattern id="p1"><§rule context="note[@type = \'warning\']"><§assert id="W" test="false()">first rule</§assert></§rule>' +
      '<§rule context="note"><§assert id="G" test="false()">second rule</§assert></§rule></§pattern>' +
      '<§pattern id="p2"><§rule context="note"><§assert id="P2" test="false()">other pattern</§assert></§rule></§pattern>'
  );
  const r = expect('first rule wins', run(rule, topic('<note type="warning">x</note>')), 'rejected', { ids: ['W', 'P2'] });
  check('  the second rule never saw the warning note', !r.violations.some((v) => v.ruleId === 'G'));
  expect('a plain note falls to the second rule', run(rule, topic('<note>x</note>')), 'rejected', { ids: ['G', 'P2'] });
}

// report vs assert.
{
  const report = sch('<§pattern><§rule context="step"><§report id="R" test="count(cmd) &gt; 1">A step has one command only.</§report></§rule></§pattern>');
  const task = (steps) => `<task id="t"><title>Replace the filter</title><taskbody><steps>${steps}</steps></taskbody></task>`;
  expect('report true → rejected', run(report, task('<step><cmd>Open the valve.</cmd><cmd>Close it.</cmd></step>')), 'rejected', { ids: ['R'] });
  expect('report false → accepted', run(report, task('<step><cmd>Open the valve.</cmd></step>')), 'accepted');
  const assert = report.replace('§', '').replace(/sch:report/g, 'sch:assert').replace('count(cmd) &gt; 1', 'count(cmd) = 1');
  expect('assert false → rejected', run(assert, task('<step><cmd>a</cmd><cmd>b</cmd></step>')), 'rejected');
  expect('assert true → accepted', run(assert, task('<step><cmd>a</cmd></step>')), 'accepted');
}

// Roles: warning/info never reject; error, fatal, none and an unknown role do.
{
  const withRole = (role) => sch(`<§pattern><§rule context="note"><§assert id="R" ${role === null ? '' : `role="${role}" `}test="@type">Declare the note type.</§assert></§rule></§pattern>`);
  const bad = topic('<note>x</note>');
  for (const role of ['warning', 'info']) {
    const r = expect(`role="${role}"`, run(withRole(role), bad), 'accepted');
    check(`  role="${role}" gives a warning`, r.warnings.length === 1 && r.warnings[0].message === 'Declare the note type.' && r.warnings[0].role === role, JSON.stringify(r.warnings));
  }
  for (const role of ['error', 'fatal', null, 'critical']) {
    const r = expect(`role=${role === null ? 'none' : `"${role}"`}`, run(withRole(role), bad), 'rejected');
    check(`  role=${role} gives no warning`, r.warnings.length === 0);
  }
}

// Variables: pattern and rule lets, in order, each seeing the previous one;
// rule lets per context node; inline functions; for, every, some.
{
  const rule = sch(
    '<§pattern id="lets"><§let name="limite" value="3"/><§let name="doble" value="$limite * 2"/>' +
      '<§rule context="steps"><§let name="n" value="count(step)"/><§let name="cuenta" value="function($s as element()) as xs:integer { count($s/cmd) }"/>' +
      '<§let name="cmds" value="for $s in step return $cuenta($s)"/>' +
      '<§assert id="L1" test="$n le $doble">Too many steps: <§value-of select="$n"/> (max <§value-of select="$doble"/>).</§assert>' +
      '<§assert id="L2" test="every $c in $cmds satisfies $c = 1">Each step needs exactly one cmd (<§value-of select="$cmds"/>).</§assert>' +
      '<§report id="L3" test="some $s in step satisfies contains(string-join($s/cmd, \' \'), \'TODO\')">Unfinished step in <§name/>.</§report>' +
      '</§rule></§pattern>'
  );
  const steps = (items) => `<task id="t"><title>Flush the cooling line</title><taskbody><steps>${items.map((c) => `<step>${c}</step>`).join('')}</steps></taskbody></task>`;
  const good = steps(['<cmd>Close valve V1.</cmd>', '<cmd>Open drain D2.</cmd>']);
  expect('lets: complying', run(rule, good), 'accepted');
  const many = steps(Array.from({ length: 7 }, (_, i) => `<cmd>Step ${i + 1}.</cmd>`));
  expect('lets: pattern lets in order', run(rule, many), 'rejected', { ids: ['L1'], message: /^Too many steps: 7 \(max 6\)\.$/ });
  expect('lets: inline function + for + every', run(rule, steps(['<cmd>a</cmd><cmd>b</cmd>', '<cmd>c</cmd>'])), 'rejected', {
    ids: ['L2'],
    message: /^Each step needs exactly one cmd \(2 1\)\.$/,
  });
  expect('lets: some + sch:name', run(rule, steps(['<cmd>TODO torque</cmd>'])), 'rejected', { ids: ['L3'], message: /^Unfinished step in steps\.$/ });
  // Rule lets are per context node: two <steps>, only the long one violates.
  const shortTask = '<task id="t2"><title>y</title><taskbody><steps><step><cmd>a</cmd></step></steps></taskbody></task>';
  const r = run(rule, `<topic id="w"><title>w</title><body/>${many.replace('<task id="t">', '<task id="t1">')}${shortTask}</topic>`);
  check('rule lets per node: only the long list violates', r.violations.length === 1 && r.violations[0].nodePaths.length === 1, JSON.stringify(r.violations));
}
// A rule-level let may use a pattern-level let evaluated against the root.
{
  const rule = sch('<§pattern><§let name="titulo" value="string(/*/title)"/><§rule context="p"><§let name="t" value="$titulo"/><§assert id="T" test="not(contains(., $t))">The paragraph repeats the title "<§value-of select="$t"/>".</§assert></§rule></§pattern>');
  expect('pattern let seen from a rule let', run(rule, topic('<p>Mantenimiento de la bomba de achique: resumen.</p>')), 'rejected', { message: /repeats the title "Mantenimiento de la bomba de achique"/ });
}
// value-of of several items joins them with a space; whitespace collapsed; entities decoded.
{
  const rule = sch('<§pattern><§rule context="ol"><§assert id="V" test="count(li) lt 2">\n   List items:\n   <§value-of select="li"/> &#8212; <§value-of select="count(li)"/>\n  </§assert></§rule></§pattern>');
  expect('value-of of several items', run(rule, topic('<ol><li>Isolate</li><li>Drain</li></ol>')), 'rejected', { message: /^List items: Isolate Drain — 2$/ });
}
// analyze-string (fontoxpath has no implementation; registered by the engine).
{
  // A let holding the result element, read through its children.
  const rule = sch('<§pattern><§rule context="p"><§let name="m" value="analyze-string(., \'[0-9]+\')"/><§assert id="AS" test="$m/*[local-name() = \'match\'] = \'25\'">x</§assert></§rule></§pattern>');
  expect('analyze-string in a let', run(rule, topic('<p>Torque 25 Nm</p>')), 'accepted');
  const count = sch('<§pattern><§rule context="p"><§assert id="AS" test="count(analyze-string(., \'[0-9]+\')/*[local-name() = \'match\']) = 2">two numbers</§assert></§rule></§pattern>');
  expect('analyze-string: two matches', run(count, topic('<p>Torque 25 Nm, then 30 Nm.</p>')), 'accepted');
  expect('analyze-string: one match', run(count, topic('<p>Torque 25 Nm.</p>')), 'rejected');
  const nonMatch = sch('<§pattern><§rule context="p"><§assert id="NM" test="string-join(analyze-string(., \'[0-9]+\')/*[local-name() = \'non-match\'], \'|\') = \'Torque | Nm\'">x</§assert></§rule></§pattern>');
  expect('analyze-string: non-match pieces', run(nonMatch, topic('<p>Torque 25 Nm</p>')), 'accepted');
  const flags = sch('<§pattern><§rule context="p"><§assert id="FL" test="exists(analyze-string(., \'figura\', \'i\')/*[local-name() = \'match\'])">x</§assert></§rule></§pattern>');
  expect('analyze-string: flags', run(flags, topic('<p>Ver Figura 9</p>')), 'accepted');
}
// Attribute and root contexts; a context with a union.
{
  const attr = sch('<§pattern><§rule context="@outputclass"><§assert id="OC" test=". = (\'fixed\', \'wide\')">Unknown outputclass <§value-of select="."/>.</§assert></§rule></§pattern>');
  const r = expect('attribute context', run(attr, topic('<p outputclass="huge">x</p>')), 'rejected', { message: /Unknown outputclass huge\./ });
  check('  node path is the attribute', r.violations[0]?.nodePaths[0] === '/topic[1]/body[1]/p[1]/@outputclass', r.violations[0]?.nodePaths[0]);
  const union = sch('<§pattern><§rule context="ul | ol"><§assert id="U" test="count(li) ge 2">A list needs two items.</§assert></§rule></§pattern>');
  expect('union context', run(union, topic('<ul><li>a</li></ul><ol><li>a</li><li>b</li></ol>')), 'rejected');
  const rootCtx = sch('<§pattern><§rule context="topic"><§assert id="RT" test="@id">x</§assert></§rule></§pattern>');
  expect('relative context matches the root element', run(rootCtx, '<topic><title>x</title></topic>'), 'rejected');
}
// Several patterns, one not executable: the others still judge.
{
  const rule =
    sch('<§pattern id="ok"><§rule context="note"><§assert id="OK" test="@type">x</§assert></§rule></§pattern>') +
    sch('<§pattern id="ext"><§rule context="map"><§assert id="EX" test="doc-available(\'x.dita\')">x</§assert></§rule></§pattern>');
  const r = expect('partial: one pattern not executable', run(rule, topic('<note>x</note>')), 'rejected', { ids: ['OK'] });
  check('  the other pattern is reported', r.notExecutableParts.length === 1 && r.notExecutableParts[0].ruleId === 'ext' && r.notExecutableParts[0].reason.code === 'external_document');
  check('  analyzeRule: partial', analyze(rule).status === 'partial');
}

// Not executable, with code and reason.
{
  const one = (test, extra = '') => sch(`<§pattern id="x"${extra}><§rule context="p"><§assert id="X" test="${test}">x</§assert></§rule></§pattern>`);
  const cases = [
    ['doc()', one("exists(doc('common.dita'))"), 'external_document', { fn: 'doc()' }],
    ['document()', one("exists(document('common.dita'))"), 'external_document', { fn: 'document()' }],
    ['collection()', one('exists(collection())'), 'external_document', { fn: 'collection()' }],
    ['unparsed-text()', one("unparsed-text('a.txt') != ''"), 'external_document', { fn: 'unparsed-text()' }],
    ['extension function', one('saxon:evaluate(.)'), 'extension_function', { name: 'saxon:evaluate' }],
    ['sch:include', sch('<§pattern id="x"><§include href="common.sch"/><§rule context="p"><§assert test="1">x</§assert></§rule></§pattern>'), 'sch_unsupported', { feature: 'sch:include' }],
    ['abstract pattern', one('@x', ' abstract="true"'), 'sch_unsupported', { feature: 'abstract pattern' }],
    ['is-a', sch('<§pattern id="x" is-a="table-pattern"><§param name="table" value="simpletable"/></§pattern>'), 'sch_unsupported', { feature: 'is-a (pattern instance)' }],
    ['sch:extends', sch('<§pattern id="x"><§rule abstract="true" id="base"><§assert test="@id">x</§assert></§rule><§rule context="p"><§extends rule="base"/></§rule></§pattern>'), 'sch_unsupported', { feature: 'sch:extends' }],
    ['missing @test', sch('<§pattern id="x"><§rule context="p"><§assert id="X">x</§assert></§rule></§pattern>'), 'sch_missing_attribute', { element: 'assert', attr: 'test' }],
    ['missing @context', sch('<§pattern id="x"><§rule><§assert id="X" test="1">x</§assert></§rule></§pattern>'), 'sch_missing_attribute', { element: 'rule', attr: 'context' }],
    ['no rule', sch('<§pattern id="x"><§let name="a" value="1"/></§pattern>'), 'no_rule_element', { element: 'rule' }],
    ['no pattern', '<p>not a rule</p>', 'no_rule_element', { element: 'pattern' }],
    ['XPath syntax error', one('count(p'), 'xpath_error', null],
    ['undeclared element prefix', one('exists(foo:bar)'), 'xpath_error', null],
    ['context not nodes', sch('<§pattern id="x"><§rule context="1"><§assert test="true()">x</§assert></§rule></§pattern>'), 'path_not_nodes', { kind: 'number' }],
    ['rule not well formed', '<sch:pattern><sch:rule context="p">', 'rule_not_well_formed', null],
  ];
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  for (const [name, rule, code, params] of cases) {
    const r = run(rule, topic('<p>x</p>'));
    check(`${name}: not_executable ${code}`, r.status === 'not_executable' && r.notExecutableReason?.code === code, JSON.stringify(r.notExecutableReason));
    if (params) check(`${name}: params`, JSON.stringify(r.notExecutableReason?.params) === JSON.stringify(params), JSON.stringify(r.notExecutableReason?.params));
    const a = analyze(rule);
    check(`${name}: analyzeRule says so up front`, a.status === 'not_executable' && a.reason?.code === code, JSON.stringify(a));
    for (const [lang, t] of [['en', en], ['es', es]]) {
      const text = formatRuleTestReason(r.notExecutableReason, t);
      check(`${name}: ${lang} text`, text && !text.includes('{{') && text !== code && !text.startsWith('records.'), text);
    }
  }
  const lit = one("contains(., 'doc(') or @id");
  check("doc( inside a literal is not a call", run(lit, topic('<p id="a">x</p>')).status === 'accepted');
  check('fn: prefix is not an extension', run(one('fn:exists(.)'), topic('<p>x</p>')).status === 'accepted');
  check('xs: constructor is not an extension', run(one("xs:integer('3') = 3"), topic('<p>x</p>')).status === 'accepted');
  check('@xml:lang works without a declaration', run(one('@xml:lang'), topic('<p xml:lang="en">x</p>')).status === 'accepted');
  // A dynamic error on the real fragment: reported, not thrown.
  const dyn = one("xs:integer(.) gt 0");
  check('dynamic error on the fragment → xpath_error', run(dyn, topic('<p>abc</p>')).notExecutableReason?.code === 'xpath_error');
  check('  but analyzeRule does not refuse it (only static errors count)', analyze(dyn).status === 'executable');
  // An abstract rule on its own never fires.
  const abstractRule = sch('<§pattern><§rule abstract="true" id="base"><§assert test="false()">never</§assert></§rule><§rule context="p"><§assert id="P" test="true()">x</§assert></§rule></§pattern>');
  expect('abstract rule without extends is skipped', run(abstractRule, topic('<p>x</p>')), 'accepted');
  check('fragment not well formed', run(NOTE_TYPE, '<topic><p>').notExecutableReason?.code === 'fragment_not_well_formed');
}
check('every engine reason code is listed', ['extension_function', 'sch_unsupported', 'sch_missing_attribute', 'xpath3_syntax'].every((c) => ENGINE_REASON_CODES.includes(c)));
for (const [lang, t] of [['en', i18n.getFixedT('en')], ['es', i18n.getFixedT('es')]]) {
  const text = formatRuleTestReason({ code: 'xpath3_syntax', params: { features: 'inline function, head()' } }, t);
  check(`xpath3_syntax ${lang} text`, text.includes('inline function, head()') && !text.includes('{{'), text);
}

// ─── 3. describeRule ────────────────────────────────────────────────────────
{
  const d = describe(NOTE_TYPE);
  check('describe: available', d.available && d.statements.length === 1 && !d.cannotReject, JSON.stringify(d));
  check('describe: assert code + params', JSON.stringify(d.statements[0].statement) === JSON.stringify({ code: 'describe_sch_assert', params: { context: 'note', test: '@type', message: 'Every note must declare @type.', warning: false } }), JSON.stringify(d.statements[0].statement));
  const en = formatRuleDescription(d, i18n.getFixedT('en')).lines[0];
  const es = formatRuleDescription(d, i18n.getFixedT('es')).lines[0];
  check('describe EN', en === 'For each note: @type must hold — message: "Every note must declare @type."', en);
  check('describe ES', es === 'Para cada note: debe cumplirse @type — mensaje: "Every note must declare @type."', es);
  const rep = describe(sch('<§pattern><§rule context="step"><§report id="R" role="warning" test="count(cmd) &gt; 1">One cmd per step.</§report></§rule></§pattern>'));
  const repEs = formatRuleDescription(rep, i18n.getFixedT('es'));
  check('describe report + warning ES', repEs.lines[0] === 'Para cada step: no debe darse count(cmd) > 1 — mensaje: "One cmd per step." (aviso: no rechaza)', repEs.lines[0]);
  check('describe: only warnings → cannot reject', rep.cannotReject === true);
  const x3 = describe(templateRules['dita-xpath3'].find((r) => r.ID === 'BRDP-EXT-00006').Rule);
  const x3en = formatRuleDescription(x3, i18n.getFixedT('en')).lines;
  check('describe EXT-00006 (3.0): variables line first', /^For each \*\[title = 'LISTA DE MATERIAL OBLIGATORIO'\] \/\/table\[.*: variables colDe, colContiene, colPart, valor, cab, part, docTec, marca, figurasHalladas, sobraEnDocTec, marcas\.$/.test(x3en[0]), x3en[0]);
  check('describe EXT-00006: two asserts', x3.statements.filter((s) => s.statement.code === 'describe_sch_assert').length === 2);
  check('describe EXT-00006: value-of shown as a placeholder', x3en.some((l) => l.includes('Valor leído: "{$docTec}"')), x3en.join('\n'));
  check('describe: whitespace collapsed outside literals', !/\s{2,}/.test(x3en[1]), x3en[1]);
  const docRule = describe(templateRules['dita-xpath3'].find((r) => r.ID === 'BRDP-EXT-00009').Rule);
  const docLines = formatRuleDescription(docRule, i18n.getFixedT('en')).lines;
  check('describe doc() rule: not-executable line first', docLines[0].startsWith('Not checked by the test engine: The rule reads another file'), docLines[0]);
  check('describe: the XPath 2.0 templates all describe', templateRules['dita-xpath2'].every((r) => describe(r.Rule).available));
  for (const suffix of Object.keys(templateRules)) {
    for (const row of templateRules[suffix]) {
      for (const lang of ['en', 'es']) {
        const lines = formatRuleDescription(describe(row.Rule), i18n.getFixedT(lang)).lines;
        check(`describe ${suffix} ${row.ID} ${lang}: no raw keys`, lines.every((l) => l && !l.includes('{{') && !l.startsWith('records.') && !l.startsWith('describe_')), lines.join('\n'));
      }
    }
  }
  const variablesOnly = describe(sch('<§pattern><§let name="a" value="1"/><§rule context="p"><§let name="b" value="$a"/><§assert test="$b = 1">x</§assert></§rule></§pattern>'));
  check('describe: pattern and rule lets listed', variablesOnly.statements[0].statement.params.names === 'a, b', JSON.stringify(variablesOnly.statements[0]));
  check('describe: not a rule → unavailable', describe('<p>x</p>').available === false);
}

console.log('\nDITA template rules not executable:');
for (const line of notExecutableInTemplates) console.log(`  - ${line}`);
console.log('DITA template rules that no fragment can break (as written):');
for (const line of neverRejects) console.log(`  - ${line}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
