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
//   5. Part 2: generation (the prompt, the files materialized and checked by
//      their own type, the correction round naming the file, a reference to
//      a missing file only a warning), "Run again" on one file, and the
//      saved passed test with its files, re-run without the LLM.
// The same verdicts in Chromium are checked by scripts/verify-rule-test-dossier.mjs.
import { DOMParser } from '@xmldom/xmldom';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { analyzeRule, describeRule, runRuleOnFragment } from '../src/utils/ruleTestEngine.js';
import { DOSSIER_BASE_URI, dossierUri } from '../src/utils/ruleTestSchematron.js';
import i18n from '../src/i18n/index.js';
import { formatRuleDescription } from '../src/utils/ruleTestReasons.js';
import { DOSSIER_CASES, DOSSIER_MAP } from './lib/dossierFixtures.mjs';
import fs from 'node:fs';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { editExample, ruleTestVerdict, exampleProblems } from '../src/utils/ruleTest.js';
import { passedTestPayload, runSavedTest, savedPassedTest } from '../src/utils/ruleTestSaved.js';
import { buildRuleTestCorrectionMessage, parseRuleTestResponse } from '../src/prompts/ruleTestExamplesPrompt.js';
import { DOSSIER_LOOK_MAX_CHARS, dossierLookExpressions, dossierProblemText } from '../src/utils/ruleTestDossier.js';

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

// ─── 5. Part 2: generation, panel data, saved test ─────────────────────────
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const vocab0 = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-dita.json', import.meta.url)));
const VOCAB = { elements: new Set(vocab0.elements), attributes: new Set(vocab0.attributes) };
const fetchStructure = async (_std, schema) => {
  const s = STRUCTURES[`DITA 1.3 Xpath2.0|${schema}`];
  return s ? { available: true, ...s } : { available: false };
};
const fetchSchemaCards = async (_std, names) => ({
  cards: {},
  document_schemas: ['topic', 'task', 'map'],
  element_schemas: Object.fromEntries(names.map((n) => [n, n === 'map' || n === 'topicref' ? ['map'] : ['topic', 'task']])),
});
const brdpOf = (id) => {
  const r = rows.find((x) => x.ID === id);
  return { identifier: r.ID, title: r.Title, definition: r.Definition, proposal: r.Proposal };
};
const PREC_TASK = '<task id="prec"><title>PRECAUCIONES DE SEGURIDAD</title><taskbody><steps><step><cmd>No fumar.</cmd></step></steps></taskbody></task>';
const procTask = (info) => `<task id="proc"><title>PROCEDIMIENTO</title><taskbody><steps><step><cmd>Abrir.</cmd><info>${info}</info></step></steps></taskbody></task>`;
const MAP2 = (hrefs) => `<map><title>Dosier</title>${hrefs.map((h) => `<topicref href="${h}"/>`).join('')}</map>`;
async function generate(id, answers) {
  const asked = [];
  let prompt = null;
  const result = await generateRuleTestExamples({
    ruleXml: rule(id),
    format: FORMAT,
    standard: 'DITA 1.3 Xpath3.0',
    schemaLocation: 'flat',
    brdp: brdpOf(id),
    vocabulary: VOCAB,
    parseXml,
    ask: async (messages) => {
      asked.push(messages);
      return JSON.stringify(answers[Math.min(asked.length - 1, answers.length - 1)]);
    },
    onPrompt: (p) => {
      prompt = p;
    },
    fetchSchemaCards,
    fetchStructure,
    fetchSchemaAttribute: async () => ({ owners: [] }),
  });
  return { result, asked, prompt };
}
{
  const good = { examples: [
    { label: 'with the safety topic', expected: 'accept', schema: 'map', content: MAP2(['topics/prec.dita', 'topics/proc.dita']), files: [{ path: 'topics/prec.dita', content: PREC_TASK }, { path: './topics/proc.dita', content: procTask('<p>x</p>') }] },
    { label: 'without it', expected: 'reject', schema: 'map', content: MAP2(['topics/proc.dita', 'topics/missing.dita']), files: [{ path: 'topics/proc.dita', content: procTask('<p>x</p>') }] },
  ] };
  const { result, asked, prompt } = await generate('BRDP-EXT-00007', [good]);
  check('EXT-00007: one LLM call, ready', result.status === 'ready' && asked.length === 1, JSON.stringify(result.error || ''));
  check('prompt: the dossier block', /each example is a DOSSIER/.test(prompt) && /"files": at most 4 more files/.test(prompt) && /at most\s+30 lines each/.test(prompt) && /not only in the ditamap/.test(prompt), prompt);
  check('prompt: output with files', prompt.includes('"files": [{"path": "topics/….dita"'), prompt.slice(-400));
  check('prompt: no "lists above" (there are none)', !/the rule's own names and the lists above/.test(prompt));
  const [a] = result.examples;
  check('materialized: main path and files', a.mainPath === 'dossier.ditamap' && a.files.length === 2 && a.files[1].path === 'topics/proc.dita', JSON.stringify(a.files.map((f) => f.path)));
  check('materialized: each file has its type and structure', a.files.every((f) => f.schema === 'task' && f.structure), JSON.stringify(a.files.map((f) => f.schema)));
  check('runs: accept accepted, reject rejected', result.runs[0].result?.status === 'accepted' && result.runs[1].result?.status === 'rejected', JSON.stringify(result.runs.map((r) => r.result?.status)));
  check('verdict correct', ruleTestVerdict(result.examples, result.runs, null).kind === 'correct');
  check('reference to a file not in the dossier: a warning, the example still runs', result.runs[1].validation.runnable && JSON.stringify(result.runs[1].validation.referenceWarnings) === '[{"file":"dossier.ditamap","attr":"href","value":"topics/missing.dita"}]', JSON.stringify(result.runs[1].validation));
  check('no warning for the complete dossier', result.runs[0].validation.referenceWarnings.length === 0);

  // "Run again" on one file: the safety topic loses its title → rejected.
  const files = a.files.map((f) => ({ path: f.path, content: f.content }));
  files[0] = { ...files[0], content: PREC_TASK.replace('PRECAUCIONES DE SEGURIDAD', 'OTRA COSA') };
  const edited = editExample(a, a.content, undefined, result.setup, parseXml, files);
  check('edit one file: marked edited', edited.editedByUser === true && edited.files[0].content.includes('OTRA COSA'));
  const { runExample } = await import('../src/utils/ruleTest.js');
  const rerun = runExample(rule('BRDP-EXT-00007'), FORMAT, edited, { vocabulary: VOCAB, parseXml });
  check('edit one file: run again → rejected', rerun.result?.status === 'rejected', JSON.stringify(rerun.result?.status));
  const back = editExample(edited, a.content, undefined, result.setup, parseXml, a.files.map((f) => ({ path: f.path, content: f.content })));
  check('back to the generated files: no mark', back.editedByUser === false);

  // Saved passed test with its files, re-run without the LLM.
  const payload = passedTestPayload(result.examples, result.runs, brdpOf('BRDP-EXT-00007').proposal);
  check('saved payload: files and main path', payload.examples[0].main_path === 'dossier.ditamap' && payload.examples[0].files.length === 2 && payload.examples[0].files[0].xml.includes('PRECAUCIONES'), JSON.stringify(payload.examples[0]).slice(0, 300));
  const saved = savedPassedTest({ last_passed_test: { ...payload, at: '2026-10-09T10:00:00Z', rule_xml: rule('BRDP-EXT-00007'), rule_hash: 'x' }, rule_xml: rule('BRDP-EXT-00007') });
  check('saved test read back with its files', saved.examples[0].files?.length === 2 && saved.examples[0].mainPath === 'dossier.ditamap');
  const rerunSaved = runSavedTest(saved, rule('BRDP-EXT-00007'), FORMAT, { parseXml });
  check('saved dossier re-run: correct, nothing changed', rerunSaved.verdict.kind === 'correct' && rerunSaved.changed.length === 0, JSON.stringify(rerunSaved.verdict));
  check('saved dossier re-run: records the files again', rerunSaved.record.passedTest?.examples[0].files?.length === 2);
}
{
  // Correction round: an invalid file (a <cmd> straight inside <taskbody>)
  // and an unknown root; the problems name the file.
  const bad = { examples: [
    { label: 'conref to the common notes', expected: 'accept', schema: 'map', content: MAP2(['topics/prec.dita', 'topics/proc.dita']), files: [
      { path: 'topics/prec.dita', content: '<task id="prec"><title>PRECAUCIONES DE SEGURIDAD</title><taskbody><cmd>No fumar.</cmd></taskbody></task>' },
      { path: 'topics/proc.dita', content: procTask('<note conref="../common/notes.dita#notes/w1"/>') },
      { path: 'common/notes.dita', content: '<notes id="notes"><note id="w1" type="warning">No fumar.</note></notes>' },
    ] },
    { label: 'warning not in the safety topic', expected: 'reject', schema: 'map', content: MAP2(['topics/prec.dita', 'topics/proc.dita']), files: [{ path: 'topics/prec.dita', content: PREC_TASK }, { path: 'topics/proc.dita', content: procTask('<note type="warning">Usar guantes.</note>') }] },
  ] };
  const fixed = { examples: [
    { ...bad.examples[0], files: [
      { path: 'topics/prec.dita', content: PREC_TASK },
      { path: 'topics/proc.dita', content: procTask('<note conref="../common/notes.dita#notes/w1"/>') },
      { path: 'common/notes.dita', content: '<topic id="notes"><title>Notas</title><body><note id="w1" type="warning">No fumar.</note></body></topic>' },
    ] },
    bad.examples[1],
  ] };
  const { result, asked } = await generate('BRDP-EXT-00008', [bad, fixed]);
  check('EXT-00008: a correction round', asked.length === 2 && result.correction?.attempted === 1 && result.correction?.fixed === 1, JSON.stringify(result.correction));
  const lines = result.correction.problems[0].problems;
  check('correction names the file of a structure problem', lines.some((l) => l.startsWith('file "topics/prec.dita": ') && /<cmd> is not allowed inside <taskbody>/.test(l)), JSON.stringify(lines));
  check('correction names the file with an unknown root', lines.some((l) => /file "common\/notes\.dita": <notes> is not the root/.test(l)), JSON.stringify(lines));
  const msg = asked[1][2].content;
  check('correction message: change "content" and "files"', msg.includes('change only the\n"content" and "files" of the examples listed'), msg);
  check('after correction: verdict correct (conref to another file read)', ruleTestVerdict(result.examples, result.runs, null).kind === 'correct', JSON.stringify(result.runs.map((r) => [r.result?.status, r.validation.runnable])));
}
{
  // Parse and limits.
  const p = parseRuleTestResponse(JSON.stringify({ examples: [{ label: 'x', expected: 'accept', content: '<map/>', files: 'nope' }] }), { dossier: true });
  check('parse: files that are not a list → error', !p.ok && /"files" that is not a list/.test(p.error));
  const q = parseRuleTestResponse(JSON.stringify({ examples: [{ label: 'x', expected: 'accept', content: '<map/>', files: [{ path: 'a.dita' }] }] }), { dossier: true });
  check('parse: a file without content → error', !q.ok && /file 1/.test(q.error));
  const plain = parseRuleTestResponse(JSON.stringify({ examples: [{ label: 'x', expected: 'accept', content: '<p/>', files: [{ path: 'a', content: 'b' }] }] }));
  check('parse without dossier: files ignored', plain.ok && plain.examples[0].files === undefined);
  check('correction message without dossier: unchanged', buildRuleTestCorrectionMessage([{ index: 0, label: 'x', problems: ['p'] }]).includes('"content" (and "metadata", if it has one)'));
  check('dossier problem texts', dossierProblemText({ code: 'dossier_too_many_files', params: { count: 5, max: 4 } }) === 'the dossier has 5 files besides the ditamap; write at most 4'
    && /is not a relative path/.test(dossierProblemText({ code: 'dossier_bad_path', params: { path: '/etc/x' } })));
  const five = Array.from({ length: 5 }, (_, i) => ({ path: `t${i}.dita`, content: '<topic id="t"><title>T</title></topic>' }));
  const gen = await generate('BRDP-EXT-00007', [{ examples: [{ label: 'five', expected: 'accept', schema: 'map', content: MAP2(['t0.dita']), files: five }, { label: 'none', expected: 'reject', schema: 'map', content: MAP2([]), files: [] }] }]);
  const r0 = gen.result.runs[0];
  check('5 files: not run, the dossier problem', !r0.validation.runnable && r0.validation.dossierProblems.some((x) => x.code === 'dossier_too_many_files'), JSON.stringify(r0.validation.dossierProblems));
  check('5 files: in the correction lines', exampleProblems(r0.validation, { standard: 'DITA 1.3 Xpath3.0', schema: 'map' }).some((l) => /5 files besides the ditamap/.test(l)));
  for (const [path, code] of [['/abs.dita', 'dossier_bad_path'], ['http://x/a.dita', 'dossier_bad_path'], ['../out.dita', 'dossier_bad_path'], ['dossier.ditamap', 'dossier_duplicate_path']]) {
    const g = await generate('BRDP-EXT-00007', [{ examples: [{ label: 'p', expected: 'accept', schema: 'map', content: MAP2([]), files: [{ path, content: PREC_TASK }] }, { label: 'n', expected: 'reject', schema: 'map', content: MAP2([]), files: [] }] }]);
    check(`path "${path}" → ${code}`, g.result.runs[0].validation.dossierProblems.some((x) => x.code === code), JSON.stringify(g.result.runs[0].validation.dossierProblems));
  }
}
{
  // A DITA rule without other-file reads: the prompt has no dossier block.
  const plainRule = '<sch:pattern id="p"><sch:rule context="note"><sch:assert id="N" test="@type">x</sch:assert></sch:rule></sch:pattern>';
  let prompt = null;
  await generateRuleTestExamples({
    ruleXml: plainRule, format: FORMAT, standard: 'DITA 1.3 Xpath3.0', schemaLocation: 'flat', brdp: { identifier: 'X', title: '', definition: '', proposal: '' },
    vocabulary: VOCAB, parseXml, ask: async () => '{"examples":[{"label":"a","expected":"accept","schema":"topic","content":"<note type=\\"note\\">x</note>"}]}',
    onPrompt: (p) => { prompt = p; }, fetchSchemaCards, fetchStructure, fetchSchemaAttribute: async () => ({ owners: [] }),
  });
  check('rule without other-file reads: no dossier block', prompt && !/DOSSIER/.test(prompt) && !/"files"/.test(prompt), prompt?.slice(0, 200));
}

// ─── 6. "WHERE THE RULE LOOKS" (progreso y causas, Part 1.5) ───────────────
{
  const names = (id) => dossierLookExpressions(rule(id), parseXml).expressions.map((e) => e.name);
  const n4 = names('BRDP-EXT-00004');
  check('EXT-00004: tablasPlan, celdasProc, escalonPlan, escalonProc', ['tablasPlan', 'celdasProc', 'escalonPlan', 'escalonProc'].every((n) => n4.includes(n)), JSON.stringify(n4));
  check('EXT-00004: values only combined (valoresPlan, the asserts) are not quoted', !n4.includes('valoresPlan') && !n4.includes('BRDP-EXT-00004a'), JSON.stringify(n4));
  check('EXT-00004: $clave (the ditamap only, not derived) is not quoted', !n4.includes('clave'), JSON.stringify(n4));
  const n8 = names('BRDP-EXT-00008');
  check('EXT-00008: pasosPrec and notas', n8.includes('pasosPrec') && n8.includes('notas'), JSON.stringify(n8));
  const all8 = dossierLookExpressions(rule('BRDP-EXT-00008'), parseXml).expressions;
  check('EXT-00008: in document order', all8.map((e) => e.name).join(',') === 'docFicha,nodoConref,esAdvertencia,conrefRoto,docs,docPrec,pasosPrec,notas', all8.map((e) => e.name).join(','));
  check('quoted verbatim, whitespace outside literals collapsed', all8.find((e) => e.name === 'pasosPrec').text === '$docPrec//cmd ! normalize-space(.)');
  check('a literal keeps its spaces', /'PRECAUCIONES DE SEGURIDAD'/.test(all8.find((e) => e.name === 'notas').text));
  // More than 10, and one too long: the first 10 in order, the cut said.
  const many = Array.from({ length: 13 }, (_, i) => `<sch:let name="v${i}" value="doc('a${i}.dita')//title"/>`).join('');
  const long = `<sch:let name="big" value="doc('b.dita')//${'p/'.repeat(500)}title"/>`;
  const look = dossierLookExpressions(`<sch:pattern id="p"><sch:rule context="map">${long}${many}<sch:assert id="A" test="true()">x</sch:assert></sch:rule></sch:pattern>`, parseXml);
  check('more than 10: the first 10 in document order', look.expressions.length === 10 && look.expressions[0].name === 'big' && look.expressions[9].name === 'v8' && look.omitted === 4, JSON.stringify(look.expressions.map((e) => e.name)) + look.omitted);
  check('the longest is cut with its count', look.expressions[0].cut > 0 && look.expressions[0].text.length === DOSSIER_LOOK_MAX_CHARS);
  const { buildRuleTestExamplesPrompt } = await import('../src/prompts/ruleTestExamplesPrompt.js');
  const p = buildRuleTestExamplesPrompt({ brdp: brdpOf('BRDP-EXT-00004'), standard: 'DITA 1.3 Xpath3.0', format: FORMAT, ruleXml: rule('BRDP-EXT-00004'), contextSchemas: [], placements: [{ schema: 'map', role: 'rule' }], schemaFacts: [], dossier: { mainPath: 'dossier.ditamap', maxFiles: 4, maxLines: 30, types: ['topic', 'map'], look } });
  check('prompt: the omitted count is said', /\(4 more expressions of the rule navigate the files; only the first 10, in the rule's order, are shown\.\)/.test(p));
  check('prompt: the cut mark', /… \[cut: \d+ more characters\]/.test(p));
  const p4 = buildRuleTestExamplesPrompt({ brdp: brdpOf('BRDP-EXT-00004'), standard: 'DITA 1.3 Xpath3.0', format: FORMAT, ruleXml: rule('BRDP-EXT-00004'), contextSchemas: [], placements: [{ schema: 'map', role: 'rule' }], schemaFacts: [], dossier: { mainPath: 'dossier.ditamap', maxFiles: 4, maxLines: 30, types: ['topic', 'map'], look: dossierLookExpressions(rule('BRDP-EXT-00004'), parseXml) } });
  check('prompt: WHERE THE RULE LOOKS with $tablasPlan', /WHERE THE RULE LOOKS[\s\S]*must place every value exactly where these expressions look for it \(same\nelements and nesting\); the Proposal may not say it\.\n- \$docFicha := function/.test(p4) && p4.includes('- $tablasPlan := $docs//*[normalize-space(title) = '), p4.split('WHERE THE RULE LOOKS')[1]?.slice(0, 400));
  check('a non-dossier rule has no expressions', dossierLookExpressions('<sch:pattern id="p"><sch:rule context="note"><sch:assert id="N" test="@type">x</sch:assert></sch:rule></sch:pattern>', parseXml).expressions.length === 0);
}
{
  // Generation passes the block through (EXT-00008).
  const answer = { examples: [{ label: 'a', expected: 'accept', schema: 'map', content: MAP2(['topics/prec.dita']), files: [{ path: 'topics/prec.dita', content: PREC_TASK }] }, { label: 'b', expected: 'reject', schema: 'map', content: MAP2(['topics/prec.dita']), files: [{ path: 'topics/prec.dita', content: PREC_TASK }] }] };
  const { prompt } = await generate('BRDP-EXT-00008', [answer]);
  check('generation: the prompt quotes $pasosPrec and $notas', prompt.includes('- $pasosPrec := $docPrec//cmd ! normalize-space(.)') && prompt.includes('- $notas := $docs//note['), prompt.split('WHERE THE RULE LOOKS')[1]?.slice(0, 300));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
