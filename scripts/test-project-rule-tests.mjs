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
  runDir,
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

// ── Draft: only a failed Verified rule ──
check('Verified that fails → Draft', shouldRevoke({ result: 'failed' }, 'approved'));
check('Draft that fails → stays', !shouldRevoke({ result: 'failed' }, 'pending_review'));
check('Verified not executable → stays', !shouldRevoke({ result: 'not_executable' }, 'approved'));
check('Verified review → stays', !shouldRevoke({ result: 'review' }, 'approved'));
check('Verified inconclusive → stays', !shouldRevoke({ result: 'inconclusive' }, 'approved'));
check('Draft that passes → never promoted (nothing to revoke)', !shouldRevoke({ result: 'passed' }, 'pending_review'));
check('error (no record) → nothing', !shouldRevoke(null, 'approved'));
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
check('revoke that failed is said', /a mano/.test(progressLine(1, 1, { identifier: 'X', result: 'failed', revoke_failed: 'HTTP 503', duration_ms: 1 })));

// ── Folder (Windows-valid name, same project and day → same folder) ──
eq('slug', folderSlug('Official Default CMP ATA - 1000BR 4.2'), 'Official-Default-CMP-ATA-1000BR-4.2');
eq('slug drops characters Windows refuses', folderSlug('A/B: C*? "D" <E>|F.'), 'A-B-C-D-E-F');
const day = new Date(2026, 9, 9, 23, 59);
check('same day → same folder', runDir('base', 'P', day) === runDir('base', 'P', new Date(2026, 9, 9, 0, 1)));
check('another day → another folder', runDir('base', 'P', day) !== runDir('base', 'P', new Date(2026, 9, 10)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-rule-tests-'));
writeFileAtomic(path.join(tmp, 'resultados.json'), JSON.stringify({ entries: [1] }));
eq('written and read back', loadResults(tmp), { entries: [1] });
check('no temporary file left', !fs.existsSync(path.join(tmp, 'resultados.json.tmp')));
eq('a folder without results', loadResults(path.join(tmp, 'none')), null);
fs.rmSync(tmp, { recursive: true, force: true });

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
  { identifier: 'BRDP-EXT-00009', run: 'r2', result: 'skipped', status_after: 'pending_review' }
);
const latest = latestEntries(entries);
const of = (id) => latest.find((e) => e.identifier === id);
check('a failed revoke done by a later pass is no longer to do by hand', of('BRDP-EXT-00007').moved_to_draft && !of('BRDP-EXT-00007').revoke_failed);
check('moved to Draft by an earlier pass of the folder stays so', of('BRDP-EXT-00008').moved_to_draft === true);
eq('skipped never hides the earlier real result', latest.find((e) => e.identifier === 'BRDP-EXT-00005').result, 'passed');
eq('a later real result replaces the earlier one', latest.find((e) => e.identifier === 'BRDP-EXT-00004').result, 'passed');
eq('one line per rule, by ID', latest.map((e) => e.identifier), ['BRDP-EXT-00001', 'BRDP-EXT-00002', 'BRDP-EXT-00003', 'BRDP-EXT-00004', 'BRDP-EXT-00005', 'BRDP-EXT-00006', 'BRDP-EXT-00007', 'BRDP-EXT-00008', 'BRDP-EXT-00009']);
const report = buildReport({ project: { name: 'P', standard: 'S1000D 4.2', format: 'BREX-4.2' }, without_rule: 3, runs: [{ started_at: 'a', finished_at: 'b', user: 'u@x', options: {} }], entries });
const section = (title) => report.split('## ').find((s) => s.startsWith(title)) || '';
check('totals: pasa 3', /\| pasa \| 3 \|/.test(report), report);
check('totals: falla 4', /\| falla \| 4 \|/.test(report));
check('totals: moved to Draft 3', /\| pasadas a Draft \| 3 \|/.test(report));
check('BRDPs without a saved rule', /sin regla guardada \(no se prueban\): 3/.test(report));
const notPassing = section('Reglas que no pasan');
check('failing table first', report.indexOf('## Reglas que no pasan') < report.indexOf('## Pasan pero siguen en Draft'));
check('failed rule with reason and lint', /BRDP-EXT-00001 \| falla \| sí \| La regla aceptó.* \| cannot reject: flag 2 without values \|/.test(notPassing), notPassing);
check('known lint finding marked', /\(conocido\) not executable: collection\(\)/.test(notPassing));
check('revoke failed: to do by hand', /BRDP-EXT-00006 \| falla \| NO: HTTP 503 \(hazlo a mano\)/.test(notPassing));
check('passing rules are not in the failing table', !/BRDP-EXT-00002/.test(notPassing) && !/BRDP-EXT-00004/.test(notPassing));
check('passes but still Draft', /- BRDP-EXT-00002/.test(section('Pasan pero siguen en Draft')) && !/BRDP-EXT-00005/.test(section('Pasan pero siguen en Draft')));
check('a skipped Draft rule (it had passed) is in "passes but still Draft"', /- BRDP-EXT-00009 \(saltada: ya había pasado\)/.test(section('Pasan pero siguen en Draft')));
check('passing list', /BRDP-EXT-00005 — Verified/.test(section('Pasan (')));
check('English report', /## Rules that do not pass/.test(buildReport({ project: { name: 'P', standard: 's', format: 'f' }, runs: [], entries }, { lang: 'en' })));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
