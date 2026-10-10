// The network-free part of scripts/run-project-rule-tests.mjs
// (scripts/lib/projectRuleTests.mjs): options, project, which rules, which
// are skipped, which go to Draft, the run folder and the report; and the
// pure pieces the script shares with the panel (ruleTestRequestBody,
// generationOutcome, buildRequestBody).
// Run: node scripts/test-project-rule-tests.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReport,
  errorGoesToDraft,
  errorKind,
  findProject,
  folderSlug,
  formatDuration,
  latestEntries,
  loadResults,
  matchesOnly,
  parseArgs,
  planRules,
  progressLine,
  removeLeftoverTmp,
  RENAME_RETRY_DELAYS_MS,
  runDir,
  savedDirectLine,
  saveFailedLine,
  shouldRevoke,
  skipReason,
  writeFileAtomic,
} from './lib/projectRuleTests.mjs';
import { ruleTestRequestBody } from '../src/api/ruleTestRequest.js';
import { answerContent, buildRequestBody } from '../src/api/llmRequest.js';
import { generationOutcome, notExecutableRecord } from '../src/utils/ruleTestOutcome.js';
import { ruleXmlHash } from '../src/utils/ruleHash.js';

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── Options ──
eq('only project', parseArgs(['--project', 'P']), { project: 'P', all: false, only: [], limit: null, parallel: 1, lang: 'es' });
eq('all options', parseArgs(['--project', 'P', '--all', '--only', 'EXT-00041, EXT-00107', '--limit', '5', '--parallel', '2', '--lang', 'en']), {
  project: 'P',
  all: true,
  only: ['EXT-00041', 'EXT-00107'],
  limit: 5,
  parallel: 2,
  lang: 'en',
});
check('project required', /--project/.test(parseArgs(['--all']).error || ''));
check('parallel at most 2', /--parallel/.test(parseArgs(['--project', 'P', '--parallel', '3']).error || ''));
check('limit whole number', /--limit/.test(parseArgs(['--project', 'P', '--limit', '0']).error || ''));
check('unknown option', /unknown option/.test(parseArgs(['--project', 'P', '--force']).error || ''));
check('value missing', /needs a value/.test(parseArgs(['--project']).error || ''));

// ── Project: exact name only; otherwise the similar ones ──
const projects = [
  { name: 'Official Default CMP ATA - 1000BR 4.2' },
  { name: 'Official Default CMP ATA - 1000BR 4.1' },
  { name: 'Lufthansa Technik AG - CMM' },
  { name: 'Demo Project (S1000D 4.2)' },
];
check('exact match', findProject(projects, 'Official Default CMP ATA - 1000BR 4.2').project?.name === 'Official Default CMP ATA - 1000BR 4.2');
const partial = findProject(projects, 'Official Default');
check('partial name: no project', !partial.project);
eq('partial name: similar listed', partial.similar, ['Official Default CMP ATA - 1000BR 4.1', 'Official Default CMP ATA - 1000BR 4.2']);
eq('case and accents only differ: similar, never chosen', findProject(projects, 'demo project (s1000d 4.2)').similar, ['Demo Project (S1000D 4.2)']);
eq('nothing similar', findProject(projects, 'zzz').similar, []);

// ── Which rules ──
check('--only short form', matchesOnly('BRDP-EXT-00041', ['EXT-00041']));
check('--only full form', matchesOnly('BRDP-EXT-00041', ['brdp-ext-00041']));
check('--only no partial number', !matchesOnly('BRDP-EXT-000410', ['EXT-00041']));
const brdps = [
  { id: 'b3', identifier: 'BRDP-EXT-00107' },
  { id: 'b1', identifier: 'BRDP-EXT-00041' },
  { id: 'b2', identifier: 'BRDP-EXT-0009' },
  { id: 'b4', identifier: 'BRDP-S1-00001' },
  { id: 'b5', identifier: 'BRDP-EXT-00200' },
];
const approvals = [
  { brdp_id: 'b1', status: 'approved', rule_xml: '<x/>' },
  { brdp_id: 'b2', status: 'pending_review', rule_xml: '<y/>' },
  { brdp_id: 'b3', status: 'approved', rule_xml: '<z/>' },
  { brdp_id: 'b4', status: 'pending_review', rule_xml: '   ' },
  { brdp_id: 'gone', status: 'approved', rule_xml: '<trash/>' },
];
const plan = planRules(brdps, approvals);
eq('ordered by ID, numbers as numbers', plan.queue.map((q) => q.brdp.identifier), ['BRDP-EXT-0009', 'BRDP-EXT-00041', 'BRDP-EXT-00107']);
eq('BRDPs without a saved rule counted apart (empty rule and no row)', plan.withoutRule, 2);
check('a rule of a BRDP in the Trash is never tested', !plan.queue.some((q) => q.brdp.id === 'gone'));
const onlyPlan = planRules(brdps, approvals, { only: ['EXT-00041', 'EXT-99999'] });
eq('--only filters', onlyPlan.queue.map((q) => q.brdp.identifier), ['BRDP-EXT-00041']);
eq('--only without a match is reported', onlyPlan.unmatchedOnly, ['EXT-99999']);

// ── Skipped: last test passed on the SAME rule ──
eq('passed and up to date → skipped', skipReason({ last_test_result: 'passed', last_test_up_to_date: true }), 'passed');
eq('rule edited after it passed → tested', skipReason({ last_test_result: 'passed', last_test_up_to_date: false }), null);
eq('failed → tested again (relaunch)', skipReason({ last_test_result: 'failed', last_test_up_to_date: true }), null);
eq('never tested → tested', skipReason({ last_test_result: null, last_test_up_to_date: null }), null);
eq('--all tests a passed one', skipReason({ last_test_result: 'passed', last_test_up_to_date: true }, { all: true }), null);

// ── Draft: a Verified rule that does not pass ──
for (const r of ['failed', 'review', 'inconclusive', 'not_executable', 'error']) {
  check(`Verified ${r} → Draft`, shouldRevoke(r, 'approved'));
  check(`Draft ${r} → stays Draft`, !shouldRevoke(r, 'pending_review'));
  check(`To Do ${r} → untouched`, !shouldRevoke(r, null));
}
check('Verified passed → stays Verified', !shouldRevoke('passed', 'approved'));
check('Verified schema_covered → stays Verified', !shouldRevoke('schema_covered', 'approved'));
check('Draft that passes → never promoted (nothing to revoke)', !shouldRevoke('passed', 'pending_review'));
check('a record object is read too', shouldRevoke({ result: 'review' }, 'approved') && !shouldRevoke({ result: 'passed' }, 'approved'));
check('no result → nothing', !shouldRevoke(null, 'approved') && !shouldRevoke('skipped', 'approved'));
// Which errors count against the rule (Draft, no test recorded).
check('AI timeout → Draft', errorGoesToDraft('POST /api/llm-proxy -> 504: {"code":"llm_timeout","seconds":2}'));
check('unusable AI answer → Draft', errorGoesToDraft('The answer is not valid JSON: Unexpected token'));
check('answer cut by length → Draft', errorGoesToDraft('the AI answer was cut by its length limit'));
check('Proposal check not made → Draft', errorGoesToDraft('the Proposal check could not be made: timeout'));
check('another endpoint of the backend → not the rule', !errorGoesToDraft('GET /api/schema-cards/structure?standard=x -> 500: {}'));
check('backend not reachable → not the rule', !errorGoesToDraft('fetch failed'));
eq('timeout recognised', errorKind('POST /api/llm-proxy -> 504: {"code":"llm_timeout","seconds":2}'), 'timeout');
eq('other errors as they are', errorKind('bad JSON'), 'bad JSON');

// ── What is recorded: the same function as the panel ──
eq('not executable at all: the analysis is the record', notExecutableRecord({ status: 'not_executable', reason: { code: 'external_document', params: { fn: 'collection' } } }), {
  result: 'not_executable',
  reason: { code: 'external_document', params: { fn: 'collection' } },
});
eq('executable: no record from the analysis', notExecutableRecord({ status: 'executable' }), null);
eq('an error records nothing', generationOutcome({ status: 'error', error: 'x' }, {}).record, null);
eq('a replaced generation records nothing', generationOutcome(null, {}).record, null);
eq('impossible path → review', generationOutcome({ status: 'path_review', reason: { code: 'test_impossible_path', params: {} } }, {}).record, {
  result: 'review',
  reason: { code: 'test_impossible_path', params: {} },
});
eq('late not executable', generationOutcome({ status: 'not_executable', reason: { code: 'unreachable_target', params: {} } }, {}).record.result, 'not_executable');

// ── The request bodies the panel sends ──
const passedRecord = { result: 'passed', reason: null, passedTest: { proposal: 'P', examples: [] } };
eq('test body (passed keeps its examples, never keep_previous)', ruleTestRequestBody('<r/>', passedRecord), {
  result: 'passed',
  reason: null,
  rule_hash: ruleXmlHash('<r/>'),
  passed_test: { proposal: 'P', examples: [] },
});
check('failed body has no passed_test', !('passed_test' in ruleTestRequestBody('<r/>', { result: 'failed', reason: { code: 'test_incorrect', params: {} }, passedTest: {} })));
eq('chat body (OpenAI-like)', buildRequestBody('mistral', [{ role: 'user', content: 'u' }], 'S', 0.5, 16000), {
  max_tokens: 16000,
  temperature: 0.5,
  messages: [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'u' },
  ],
});
eq('chat body (Anthropic)', buildRequestBody('Anthropic', [{ role: 'user', content: 'u' }], 'S', 0), { max_tokens: 4000, temperature: 0, system: 'S', messages: [{ role: 'user', content: 'u' }] });
eq('answer text', [answerContent('mistral', { choices: [{ message: { content: 'a' } }] }), answerContent('Anthropic', { content: [{ text: 'b' }] })], ['a', 'b']);

// ── Progress line ──
eq('duration', [formatDuration(12000), formatDuration(72000), formatDuration(3720000)], ['12 s', '1 min 12 s', '1 h 2 min']);
eq('progress line of a failed Verified rule', progressLine(37, 461, { identifier: 'BRDP-EXT-00041', result: 'failed', moved_to_draft: true, duration_ms: 72000 }), '[37/461] BRDP-EXT-00041 FALLA → Draft (1 min 12 s)');
eq('progress line of an error', progressLine(2, 9, { identifier: 'BRDP-X', result: 'error', error_kind: 'timeout', duration_ms: 3000 }), '[2/9] BRDP-X ERROR: TIMEOUT (3 s)');
eq('progress line of a skipped rule', progressLine(3, 9, { identifier: 'BRDP-X', result: 'skipped' }), '[3/9] BRDP-X SALTADA');
eq(
  'progress line of an error moved to Draft',
  progressLine(4, 9, { identifier: 'BRDP-X', result: 'error', error_kind: 'timeout', moved_to_draft: true, no_test_recorded: true, duration_ms: 3000 }),
  '[4/9] BRDP-X ERROR: TIMEOUT → Draft (sin prueba registrada) (3 s)'
);
eq('progress line of a review moved to Draft', progressLine(5, 9, { identifier: 'BRDP-X', result: 'review', moved_to_draft: true, duration_ms: 1000 }), '[5/9] BRDP-X REVISAR → Draft (1 s)');
check('revoke that failed is said', /a mano/.test(progressLine(1, 1, { identifier: 'X', result: 'failed', revoke_failed: 'HTTP 503', duration_ms: 1 })));

// ── Folder (Windows-valid name, same project and day → same folder) ──
eq('slug', folderSlug('Official Default CMP ATA - 1000BR 4.2'), 'Official-Default-CMP-ATA-1000BR-4.2');
eq('slug drops characters Windows refuses', folderSlug('A/B: C*? "D" <E>|F.'), 'A-B-C-D-E-F');
const day = new Date(2026, 9, 9, 23, 59);
check('same day → same folder', runDir('base', 'P', day) === runDir('base', 'P', new Date(2026, 9, 9, 0, 1)));
check('another day → another folder', runDir('base', 'P', day) !== runDir('base', 'P', new Date(2026, 9, 10)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-rule-tests-'));
eq('written', writeFileAtomic(path.join(tmp, 'resultados.json'), JSON.stringify({ entries: [1] })), { ok: true });
eq('written and read back', loadResults(tmp), { entries: [1] });
check('no temporary file left', !fs.existsSync(path.join(tmp, 'resultados.json.tmp')));
eq('a folder without results', loadResults(path.join(tmp, 'none')), null);
fs.writeFileSync(path.join(tmp, 'resultados.json.tmp'), 'half');
fs.writeFileSync(path.join(tmp, 'informe.md.tmp'), 'half');
eq('a .tmp left by an earlier pass is removed', removeLeftoverTmp(tmp), ['resultados.json.tmp', 'informe.md.tmp']);
check('...and is gone', !fs.existsSync(path.join(tmp, 'resultados.json.tmp')) && !fs.existsSync(path.join(tmp, 'informe.md.tmp')));
fs.rmSync(tmp, { recursive: true, force: true });

// ── Saving with the file locked (Windows), simulated: no real Windows needed ──
const lockError = (code) => Object.assign(new Error(`${code}: operation not permitted, rename 'resultados.json.tmp' -> 'resultados.json'`), { code });
// A fake fs: files in a Map; renameSync / writeFileSync to the destination
// fail as told.
function fakeFs({ renameFails = 0, renameCode = 'EPERM', directFails = false } = {}) {
  const files = new Map();
  let renames = 0;
  return {
    files,
    get renames() {
      return renames;
    },
    existsSync: (f) => files.has(f),
    unlinkSync: (f) => files.delete(f),
    writeFileSync: (f, text) => {
      if (directFails && !f.endsWith('.tmp')) throw lockError('EBUSY');
      files.set(f, text);
    },
    renameSync: (from, to) => {
      renames += 1;
      if (renames <= renameFails) throw lockError(renameCode);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}
const waits = [];
const sleep = (ms) => waits.push(ms);
const F = 'run/resultados.json';
{
  const f = fakeFs({ renameFails: 2 });
  waits.length = 0;
  eq('rename fails twice, then works → saved, no warning', writeFileAtomic(F, 'ALL', { fsImpl: f, sleep }), { ok: true });
  eq('...the file is complete', f.files.get(F), 'ALL');
  eq('...two growing waits', waits, [100, 150]);
  check('...no .tmp left', !f.files.has(`${F}.tmp`));
}
for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  const f = fakeFs({ renameFails: Infinity, renameCode: code });
  waits.length = 0;
  const res = writeFileAtomic(F, 'ALL', { fsImpl: f, sleep });
  check(`${code}: rename always fails, direct write works → saved directly`, res.ok && res.direct && res.renameError === code, JSON.stringify(res));
  eq(`${code}: ...10 retries, 100 ms to 2 s`, waits, RENAME_RETRY_DELAYS_MS);
  eq(`${code}: ...11 attempts in all`, f.renames, 11);
  eq(`${code}: ...the file is complete`, f.files.get(F), 'ALL');
  check(`${code}: ...no .tmp left`, !f.files.has(`${F}.tmp`));
}
eq('the waits grow from 100 ms to about 2 s', [RENAME_RETRY_DELAYS_MS[0], RENAME_RETRY_DELAYS_MS.at(-1), RENAME_RETRY_DELAYS_MS.length], [100, 2000, 10]);
{
  const f = fakeFs({ renameFails: Infinity, directFails: true });
  waits.length = 0;
  let res;
  let threw = false;
  try {
    res = writeFileAtomic(F, 'ALL', { fsImpl: f, sleep });
  } catch {
    threw = true;
  }
  check('everything fails → never thrown', !threw);
  check('...the failure is returned', res && res.ok === false && res.code === 'EBUSY', JSON.stringify(res));
  check('...no .tmp left after the failure', !f.files.has(`${F}.tmp`));
  check('...the destination is not touched', !f.files.has(F));
}
{
  const f = fakeFs({ renameFails: 1, renameCode: 'ENOSPC' });
  waits.length = 0;
  const res = writeFileAtomic(F, 'ALL', { fsImpl: f, sleep });
  check('another error than a lock: no waiting, written directly', res.ok && res.direct && waits.length === 0, JSON.stringify(res));
}
{
  // The lock goes away: the first save fails, the next one fixes the file.
  const f = fakeFs({ renameFails: Infinity, directFails: true });
  check('locked: first save fails', !writeFileAtomic(F, 'v1', { fsImpl: f, sleep: () => {} }).ok);
  const unlocked = { ...f, writeFileSync: (file, text) => f.files.set(file, text), renameSync: (from, to) => (f.files.set(to, f.files.get(from)), f.files.delete(from)) };
  eq('lock gone: next save works', writeFileAtomic(F, 'v1 v2', { fsImpl: unlocked, sleep: () => {} }), { ok: true });
  eq('...the file is complete', f.files.get(F), 'v1 v2');
}
eq(
  'the line said when a save fails',
  saveFailedLine('C:/x/resultados.json', 'EPERM'),
  'No se pudo guardar resultados.json (EPERM): cierra el fichero si lo tienes abierto; se reintenta tras la siguiente regla.'
);
check('...in English too', /^Could not save informe\.md \(EBUSY\): close the file/.test(saveFailedLine('informe.md', 'EBUSY', 'en')));
check('the line said when saved directly', /resultados\.json guardado directamente: .*\(EPERM\)/.test(savedDirectLine('resultados.json', 'EPERM')));

// ── Report ──
const entries = [
  { identifier: 'BRDP-EXT-00002', run: 'r1', result: 'passed', status_after: 'pending_review', lint: [] },
  { identifier: 'BRDP-EXT-00001', run: 'r1', result: 'failed', moved_to_draft: true, status_after: 'pending_review', reason_text: 'La regla aceptó un ejemplo que debía rechazar.', lint: [{ kind: 'cannot reject', detail: 'flag 2 without values', known: false }] },
  { identifier: 'BRDP-EXT-00003', run: 'r1', result: 'not_executable', status_after: 'approved', reason_text: 'Usa collection()', lint: [{ kind: 'not executable', detail: 'collection()', known: true }] },
  { identifier: 'BRDP-EXT-00004', run: 'r1', result: 'error', error: 'timeout', status_after: 'approved', lint: [] },
  { identifier: 'BRDP-EXT-00005', run: 'r1', result: 'passed', status_after: 'approved', lint: [] },
  { identifier: 'BRDP-EXT-00006', run: 'r1', result: 'failed', moved_to_draft: false, revoke_failed: 'HTTP 503', status_after: 'approved', reason_text: 'falla', lint: [] },
  // second pass, same day: skipped ones keep the earlier real result
  { identifier: 'BRDP-EXT-00005', run: 'r2', result: 'skipped', status_after: 'approved' },
  { identifier: 'BRDP-EXT-00004', run: 'r2', result: 'passed', status_after: 'approved', lint: [] },
];
entries.push(
  { identifier: 'BRDP-EXT-00007', run: 'r1', result: 'failed', moved_to_draft: false, revoke_failed: 'HTTP 503', status_after: 'approved', lint: [] },
  { identifier: 'BRDP-EXT-00007', run: 'r2', result: 'failed', moved_to_draft: true, status_after: 'pending_review', lint: [] },
  { identifier: 'BRDP-EXT-00008', run: 'r1', result: 'failed', moved_to_draft: true, status_after: 'pending_review', lint: [] },
  { identifier: 'BRDP-EXT-00008', run: 'r2', result: 'failed', status_after: 'pending_review', lint: [] },
  { identifier: 'BRDP-EXT-00009', run: 'r2', result: 'skipped', status_after: 'pending_review' },
  // Verified rules that do not pass: all to Draft
  { identifier: 'BRDP-EXT-00010', run: 'r2', result: 'review', moved_to_draft: true, status_after: 'pending_review', reason_text: 'Revisar: la Propuesta', lint: [] },
  { identifier: 'BRDP-EXT-00011', run: 'r2', result: 'inconclusive', moved_to_draft: true, status_after: 'pending_review', reason_text: 'nada seleccionado', lint: [] },
  { identifier: 'BRDP-EXT-00012', run: 'r2', result: 'not_executable', moved_to_draft: true, status_after: 'pending_review', reason_text: 'Usa doc()', lint: [] },
  { identifier: 'BRDP-EXT-00013', run: 'r2', result: 'error', error: 'POST /api/llm-proxy -> 504', moved_to_draft: true, no_test_recorded: true, status_after: 'pending_review', lint: [] },
  { identifier: 'BRDP-EXT-00014', run: 'r2', result: 'error', error: 'GET /api/x -> 500', draft_skipped: 'backend_error', status_after: 'approved', lint: [] }
);
const latest = latestEntries(entries);
const of = (id) => latest.find((e) => e.identifier === id);
check('a failed revoke done by a later pass is no longer to do by hand', of('BRDP-EXT-00007').moved_to_draft && !of('BRDP-EXT-00007').revoke_failed);
check('moved to Draft by an earlier pass of the folder stays so', of('BRDP-EXT-00008').moved_to_draft === true);
eq('skipped never hides the earlier real result', latest.find((e) => e.identifier === 'BRDP-EXT-00005').result, 'passed');
eq('a later real result replaces the earlier one', latest.find((e) => e.identifier === 'BRDP-EXT-00004').result, 'passed');
eq('one line per rule, by ID', latest.map((e) => e.identifier), ['BRDP-EXT-00001', 'BRDP-EXT-00002', 'BRDP-EXT-00003', 'BRDP-EXT-00004', 'BRDP-EXT-00005', 'BRDP-EXT-00006', 'BRDP-EXT-00007', 'BRDP-EXT-00008', 'BRDP-EXT-00009', 'BRDP-EXT-00010', 'BRDP-EXT-00011', 'BRDP-EXT-00012', 'BRDP-EXT-00013', 'BRDP-EXT-00014']);
const report = buildReport({ project: { name: 'P', standard: 'S1000D 4.2', format: 'BREX-4.2' }, without_rule: 3, runs: [{ started_at: 'a', finished_at: 'b', user: 'u@x', options: {} }], entries });
const section = (title) => report.split('## ').find((s) => s.startsWith(title)) || '';
check('totals: pasa 3, never to Draft', /\| pasa \| 3 \| — \|/.test(report), report);
check('totals: falla 4, 3 to Draft', /\| falla \| 4 \| 3 \|/.test(report));
check('totals: revisar 1 to Draft', /\| revisar \| 1 \| 1 \|/.test(report));
check('totals: no concluyente 1 to Draft', /\| no concluyente \| 1 \| 1 \|/.test(report));
check('totals: no ejecutable 2, 1 to Draft', /\| no ejecutable \| 2 \| 1 \|/.test(report));
check('totals: error 2, 1 to Draft', /\| error \| 2 \| 1 \|/.test(report));
check('totals: 7 moved to Draft in all', /\| total pasadas a Draft \| \| 7 \|/.test(report));
check('the Draft criterion is said', /Una regla Verified pasa a Draft con cualquier resultado que no sea «pasa»/.test(report));
check('BRDPs without a saved rule', /sin regla guardada \(no se prueban\): 3/.test(report));
const notPassing = section('Reglas que no pasan');
check('failing table first', report.indexOf('## Reglas que no pasan') < report.indexOf('## Pasan pero siguen en Draft'));
check('failed rule with reason and lint', /BRDP-EXT-00001 \| falla \| → Draft \| La regla aceptó.* \| cannot reject: flag 2 without values \|/.test(notPassing), notPassing);
check('known lint finding marked', /\(conocido\) not executable: collection\(\)/.test(notPassing));
check('review → Draft in the table', /BRDP-EXT-00010 \| revisar \| → Draft \| Revisar/.test(notPassing));
check('inconclusive → Draft in the table', /BRDP-EXT-00011 \| no concluyente \| → Draft \|/.test(notPassing));
check('not executable → Draft in the table', /BRDP-EXT-00012 \| no ejecutable \| → Draft \|/.test(notPassing));
check('error → Draft without a recorded test, and why', /BRDP-EXT-00013 \| error \| → Draft \(sin prueba registrada\) \| POST \/api\/llm-proxy -> 504 \|/.test(notPassing), notPassing);
check('backend error → not to Draft, and why', /BRDP-EXT-00014 \| error \| no: error del backend, no de la regla \|/.test(notPassing));
check('revoke failed: to do by hand', /BRDP-EXT-00006 \| falla \| NO: HTTP 503 \(hazlo a mano\)/.test(notPassing));
check('passing rules are not in the failing table', !/BRDP-EXT-00002/.test(notPassing) && !/BRDP-EXT-00004/.test(notPassing));
check('passes but still Draft', /- BRDP-EXT-00002/.test(section('Pasan pero siguen en Draft')) && !/BRDP-EXT-00005/.test(section('Pasan pero siguen en Draft')));
check('a skipped Draft rule (it had passed) is in "passes but still Draft"', /- BRDP-EXT-00009 \(saltada: ya había pasado\)/.test(section('Pasan pero siguen en Draft')));
check('passing list', /BRDP-EXT-00005 — Verified/.test(section('Pasan (')));
check('English report', /## Rules that do not pass/.test(buildReport({ project: { name: 'P', standard: 's', format: 'f' }, runs: [], entries }, { lang: 'en' })));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
