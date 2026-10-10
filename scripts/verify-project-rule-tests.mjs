// scripts/run-project-rule-tests.mjs against the real backend and the
// Mistral simulators -- the cases of the request "Script para probar todas
// las reglas de un proyecto". Needs postgres, vite (5173) and the simulators
// (mock-mistral-chat-server.mjs on 8902, mock-mistral-embed-server.mjs on
// 8901). It restarts the backend itself (by its exact PID) to force an AI
// timeout and the AI's daily limit, and leaves it with the normal settings.
//
// A seeded project with:
//   01 Verified that passes      02 Verified that fails (→ Draft)
//   03 Draft that fails          04 Draft that passes (stays Draft)
//   05 Verified not executable (document(), → Draft)
//   06 Verified, for the forced timeout (→ Draft with no test recorded)
//   07 tested from the PANEL first (to compare what is recorded)
//   08 no saved rule             09/10 Verified that fail, with the revoke
//                                     request failing twice / once
//   11 Verified "review" (→ Draft)   12 Verified "inconclusive" (→ Draft)
//   13 Verified "already covered by the schema" (stays Verified)
//   14 Verified that fails on the first attempt (the simulator swaps the
//      examples once) and passes on repeat (stays Verified, the pass recorded)
// A Verified rule that does not pass is tested twice (repeat before Draft):
// 02, 09, 10, 11, 12 fail twice (Draft, the second attempt recorded), 06
// times out twice (Draft, no test).
// Checks the runs, then what is recorded (through the API, i.e. Postgres):
// result, examples, History with the login user, the same as the panel's
// test of 07; every Verified rule that does not pass moved to Draft, with
// "verified → draft" in History and rule_xml intact. The project is deleted
// at the end.
//
// Run: node scripts/verify-project-rule-tests.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startUvicorn, uvicornPid } from './lib/backendProcess.mjs';
import { BACKEND_DIR, backendPython, pythonEnv } from './lib/backendPython.mjs';
import { runDir } from './lib/projectRuleTests.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'http://localhost:5173';
const API = 'http://localhost:8000';
const CHAT = 'http://localhost:8902';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ADMIN_EMAIL = process.env.PROMPT_EVAL_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.PROMPT_EVAL_PASSWORD || 'AdminTest123!';
const MOCKS = {
  MISTRAL_ENDPOINT: process.env.MISTRAL_ENDPOINT || 'http://localhost:8902',
  MISTRAL_EMBED_ENDPOINT: process.env.MISTRAL_EMBED_ENDPOINT || 'http://localhost:8901',
};
const FORMAT = 'BREX-4.2';

let failures = 0;
function assert(cond, msg, detail = '') {
  if (!cond) {
    failures += 1;
    console.error('FAIL:', msg, detail);
  } else console.log('OK:', msg);
}

async function waitBackend(up, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await fetch(`${API}/docs`).then((r) => r.ok).catch(() => false);
    if (ok === up) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not come ${up ? 'up' : 'down'}`);
}
async function restartBackend(extraEnv = {}) {
  const pid = uvicornPid();
  if (pid) {
    process.kill(pid, 'SIGTERM');
    await waitBackend(false);
  }
  const log = fs.openSync(path.join(os.tmpdir(), 'uvicorn-project-rule-tests.log'), 'a');
  startUvicorn({ env: { ...MOCKS, ...extraEnv }, log });
  await waitBackend(true);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).access_token;
}

// The script under test, as a child process; resolves { code, out }.
// onLine(line, child) sees each output line (Ctrl+C test).
function runScript(args, { env = {}, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, 'run-project-rule-tests.mjs'), ...args], {
      env: { ...process.env, PROMPT_EVAL_EMAIL: ADMIN_EMAIL, PROMPT_EVAL_PASSWORD: ADMIN_PASSWORD, ...env },
    });
    let out = '';
    let buffer = '';
    const take = (data) => {
      out += data;
      buffer += data;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) onLine?.(line, child);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => resolve({ code, out }));
  });
}

// A proxy in front of the backend whose answer to a revoke request can be
// made to fail (a network failure between recording and revoking).
// It can also cut the connection of the next cut.count requests whose path
// matches cut.pattern (a keep-alive connection closed by uvicorn: "fetch
// failed").
function revokeProxy() {
  const state = { failRevokes: 0, cut: { pattern: null, count: 0 }, cuts: 0 };
  const server = http.createServer((req, res) => {
    if (state.cut.count > 0 && state.cut.pattern?.test(req.url)) {
      state.cut.count -= 1;
      state.cuts += 1;
      req.socket.destroy();
      return;
    }
    if (/\/revoke$/.test(req.url) && state.failRevokes > 0) {
      state.failRevokes -= 1;
      req.resume();
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"detail":"simulated network failure"}');
      return;
    }
    const upstream = http.request(`${API}${req.url}`, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, url: `http://localhost:${server.address().port}` })));
}

const rule = (id, objectPath, flag = '0') =>
  `<structureObjectRule id="${id}">\n  <objectPath allowedObjectFlag="${flag}">${objectPath}</objectPath>\n  <objectUse>Rule ${id}.</objectUse>\n</structureObjectRule>`;

async function main() {
  await restartBackend();
  let token = await login();
  // Node reuses a keep-alive connection uvicorn may have closed ("other
  // side closed"): that socket error alone is retried once.
  const api = async (p, init = {}) => {
    const send = () => fetch(`${API}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    try {
      return await send();
    } catch (err) {
      if (err?.cause?.code !== 'UND_ERR_SOCKET') throw err;
      return send();
    }
  };
  const json = async (p, init) => {
    const r = await api(p, init);
    if (!r.ok) throw new Error(`${init?.method || 'GET'} ${p}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  const me = await json('/api/auth/me');
  const suffix = Math.random().toString(36).slice(2, 8);
  const projectName = `Rule batch test ${suffix}`;
  const project = await json('/api/projects', { method: 'POST', body: JSON.stringify({ name: projectName, standard: 'S1000D 4.2' }) });
  const ids = {};
  const rules = {};
  async function seed(identifier, objectPath, flag, status, proposal = 'The element <emphasis> shall not be used.') {
    const brdp = await json(`/api/projects/${project.id}/brdps`, {
      method: 'POST',
      body: JSON.stringify({ identifier, title: `Emphasis ${identifier}`, definition: 'Decide how emphasis is used.', proposal, validation: 'Validated' }),
    });
    ids[identifier] = brdp.id;
    if (!objectPath) return;
    rules[identifier] = rule(identifier, objectPath, flag);
    await json(`/api/projects/${project.id}/brdps/${brdp.id}/approvals/${FORMAT}`, { method: 'PUT', body: JSON.stringify({ rule_xml: rules[identifier], source: 'manual', status }) });
  }
  await seed('BRDP-RB-01', '//emphasis', '0', 'approved');
  await seed('BRDP-RB-02', '//emphasis', '2', 'approved');
  await seed('BRDP-RB-03', '//emphasis', '2', 'pending_review');
  await seed('BRDP-RB-04', '//emphasis', '0', 'pending_review');
  await seed('BRDP-RB-05', "document('common.xml')//emphasis", '0', 'approved');
  await seed('BRDP-RB-06', '//emphasis', '0', 'approved');
  await seed('BRDP-RB-07', '//emphasis', '0', 'pending_review');
  await seed('BRDP-RB-08', null);
  await seed('BRDP-RB-09', '//emphasis', '2', 'approved');
  await seed('BRDP-RB-10', '//emphasis', '2', 'approved');
  // The simulator's Proposal check answers "no" with MISMATCH (→ review);
  // ALLINVALID gives examples that are never valid (→ inconclusive).
  await seed('BRDP-RB-11', '//emphasis', '0', 'approved', 'MISMATCH The element <emphasis> shall not be used.');
  await seed('BRDP-RB-12', '//emphasis', '0', 'approved', 'ALLINVALID The element <emphasis> shall not be used.');
  await seed('BRDP-RB-13', '/dmodule[not(identAndStatusSection)]', '0', 'approved', 'Every data module shall have its <identAndStatusSection>.');
  await seed('BRDP-RB-14', '//emphasis', '0', 'approved');
  const approval = (id) => json(`/api/projects/${project.id}/brdps/${ids[id]}/approvals/${FORMAT}`);
  const history = (id) => json(`/api/projects/${project.id}/brdps/${ids[id]}/history`);
  const reportDir = runDir(path.join(SCRIPTS, 'rule-test-runs'), projectName);
  fs.rmSync(reportDir, { recursive: true, force: true });
  let viewerSeeded = false;
  const proxy = await revokeProxy();

  try {
    // ── Cannot start: partial name, backend down, no editor role ──
    let r = await runScript(['--project', `Rule batch test`]);
    assert(r.code === 2 && r.out.includes(projectName) && /Nothing was tested/.test(r.out), 'partial name: similar projects listed, exit 2', r.out);
    assert(!fs.existsSync(reportDir), 'partial name: nothing tested, no report');
    r = await runScript(['--project', projectName], { env: { PROMPT_EVAL_API_URL: 'http://localhost:8999' } });
    assert(r.code === 2 && /Cannot reach the backend/.test(r.out), 'backend down: clear message, exit 2', r.out);
    const viewer = JSON.parse(execFileSync(backendPython(), ['scripts/seed_compare_verification.py'], { cwd: BACKEND_DIR, env: pythonEnv() }).toString('utf8').trim().split('\n').pop());
    viewerSeeded = true;
    await json(`/api/users/${viewer.viewer_id}/project-roles`, { method: 'PUT', body: JSON.stringify({ project_id: project.id, role: 'viewer' }) });
    r = await runScript(['--project', projectName], { env: { PROMPT_EVAL_EMAIL: viewer.viewer_email, PROMPT_EVAL_PASSWORD: viewer.viewer_password } });
    assert(r.code === 2 && /viewer role/.test(r.out) && /editor role/.test(r.out), 'viewer: needs the editor role, exit 2', r.out);
    assert(!fs.existsSync(reportDir), 'no role: nothing tested');

    // ── 07 tested from the panel (what the script must record the same way) ──
    const browser = await chromium.launch({ headless: true, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
    await page.goto(BASE_URL);
    await page.fill('#login-email', ADMIN_EMAIL);
    await page.fill('#login-password', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('table', { timeout: 10000 });
    await page.goto(`${BASE_URL}/projects/${project.id}/records`);
    await page.waitForSelector('tbody tr', { timeout: 20000 });
    await page.fill('input[placeholder="Search by ID or Title…"], input[placeholder="Buscar por ID o título…"]', 'BRDP-RB-07');
    await page.locator('tbody tr', { hasText: 'BRDP-RB-07' }).first().click();
    await page.getByRole('button', { name: /^(Test rule|Probar regla)$/ }).click();
    await page.getByTestId('rule-test-verdict').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-test-indicator"]')?.dataset.state === 'passed', null, { timeout: 15000 });
    await browser.close();
    const panel07 = await approval('BRDP-RB-07');
    assert(panel07.last_test_result === 'passed', 'panel: 07 passed and recorded');

    // ── Forced AI timeout: error, nothing recorded, next rule goes on ──
    await restartBackend({ LLM_REQUEST_TIMEOUT_SECONDS: '2' });
    token = await login();
    await fetch(`${CHAT}/slow-next?ms=5000&count=20`, { method: 'POST' });
    r = await runScript(['--project', projectName, '--only', 'RB-06,RB-05']);
    await fetch(`${CHAT}/reset`, { method: 'POST' });
    assert(r.code === 0, 'timeout run ends normally', r.out);
    assert(/\[2\/2\] BRDP-RB-06 ERROR: TIMEOUT, ERROR: TIMEOUT al repetir → Draft \(sin prueba registrada\)/.test(r.out), 'progress: timeout twice → «… al repetir → Draft (sin prueba registrada)»', r.out);
    assert(/\[1\/2\] BRDP-RB-05 NO EJECUTABLE → Draft/.test(r.out) && !/BRDP-RB-05 NO EJECUTABLE,/.test(r.out), 'not executable: no repeat', r.out);
    assert(/\[1\/2\] BRDP-RB-05 NO EJECUTABLE → Draft/.test(r.out), 'not executable (document()) recorded without the AI, → Draft', r.out);
    const a06 = await approval('BRDP-RB-06');
    assert(a06.last_test_result === null && a06.status === 'pending_review' && a06.rule_xml === rules['BRDP-RB-06'], 'timeout: no test recorded, Verified → Draft, rule_xml intact');
    const h06 = await history('BRDP-RB-06');
    assert(!h06.some((h) => h.field_name === 'rule_test'), 'timeout: no test entry in History');
    assert(h06.filter((h) => h.field_name === 'rule_status' && h.old_value === 'verified' && h.new_value === 'draft' && h.user_email === me.email).length === 1, 'timeout: History «verified → draft» with the login user');
    const a05 = await approval('BRDP-RB-05');
    assert(a05.last_test_result === 'not_executable' && a05.status === 'pending_review', 'not executable: recorded, then Verified → Draft');
    assert((await history('BRDP-RB-05')).some((h) => h.field_name === 'rule_status' && h.old_value === 'verified' && h.new_value === 'draft'), 'not executable: History «verified → draft»');
    const timeoutReport = fs.readFileSync(path.join(reportDir, 'informe.md'), 'utf8');
    assert(/\| BRDP-RB-06 \| error, error al repetir \| → Draft \(sin prueba registrada\) \| .*504/.test(timeoutReport), 'report: the timeout went to Draft with no test recorded, and why', timeoutReport);

    // ── Review, inconclusive → Draft; "already covered by the schema" stays ──
    await restartBackend();
    token = await login();
    r = await runScript(['--project', projectName, '--only', 'RB-11,RB-12,RB-13']);
    assert(r.code === 0, 'review/inconclusive/covered run ends', r.out);
    assert(/BRDP-RB-11 REVISAR, REVISAR al repetir → Draft/.test(r.out) && /BRDP-RB-12 NO CONCLUYENTE, NO CONCLUYENTE al repetir → Draft/.test(r.out), 'progress: review and inconclusive, repeated, → Draft', r.out);
    assert(/BRDP-RB-13 PASA \(EL ESQUEMA YA LO INCLUYE\) \(/.test(r.out), 'progress: already covered by the schema, no Draft', r.out);
    for (const [id, result] of [
      ['BRDP-RB-11', 'review'],
      ['BRDP-RB-12', 'inconclusive'],
    ]) {
      const a = await approval(id);
      const h = await history(id);
      assert(a.last_test_result === result && a.status === 'pending_review' && a.rule_xml === rules[id], `${id}: ${result} recorded, Verified → Draft, rule_xml intact`, JSON.stringify({ r: a.last_test_result, s: a.status }));
      assert(h.filter((e) => e.field_name === 'rule_test').length === 1 && h.filter((e) => e.field_name === 'rule_status' && e.old_value === 'verified' && e.new_value === 'draft' && e.user_email === me.email).length === 1, `${id}: History test + «verified → draft»`);
    }
    const a13 = await approval('BRDP-RB-13');
    assert(a13.last_test_result === 'schema_covered' && a13.status === 'approved', 'already covered by the schema: recorded, stays Verified', JSON.stringify({ r: a13.last_test_result, s: a13.status }));
    assert(!(await history('BRDP-RB-13')).some((h) => h.field_name === 'rule_status' && h.new_value === 'draft'), 'already covered by the schema: no «verified → draft» in History');
    const reviewReport = fs.readFileSync(path.join(reportDir, 'informe.md'), 'utf8');
    assert(/\| revisar \| 1 \| 1 \|/.test(reviewReport) && /\| no concluyente \| 1 \| 1 \|/.test(reviewReport) && /\| no ejecutable \| 1 \| 1 \|/.test(reviewReport) && /\| error \| 1 \| 1 \|/.test(reviewReport), 'report totals: how many went to Draft per result', reviewReport);

    // ── Network failure between recording and revoking ──
    await restartBackend();
    token = await login();
    proxy.state.failRevokes = 2;
    r = await runScript(['--project', projectName, '--only', 'RB-09'], { env: { PROMPT_EVAL_API_URL: proxy.url } });
    const a09 = await approval('BRDP-RB-09');
    assert(a09.last_test_result === 'failed' && a09.status === 'approved', 'revoke fails twice: recorded, still Verified');
    assert(/BRDP-RB-09 FALLA, FALLA al repetir \(NO se pudo pasar a Draft: hazlo a mano\)/.test(r.out) && /by hand \(the request failed twice\): BRDP-RB-09/.test(r.out), 'revoke fails twice: said in the progress and the summary', r.out);
    assert(/\| BRDP-RB-09 \| falla, falla al repetir \| NO: HTTP 503/.test(fs.readFileSync(path.join(reportDir, 'informe.md'), 'utf8')), 'report: the revoke to do by hand');
    proxy.state.failRevokes = 1;
    r = await runScript(['--project', projectName, '--only', 'RB-10'], { env: { PROMPT_EVAL_API_URL: proxy.url } });
    assert(/BRDP-RB-10 FALLA, FALLA al repetir → Draft/.test(r.out) && (await approval('BRDP-RB-10')).status === 'pending_review', 'revoke fails once: retried, moved to Draft', r.out);

    // ── Fails, then passes on repeat: the pass recorded, stays Verified ──
    await fetch(`${CHAT}/invert-next`, { method: 'POST' });
    r = await runScript(['--project', projectName, '--only', 'RB-14']);
    assert(r.code === 0 && /BRDP-RB-14 FALLA, PASA al repetir \(/.test(r.out) && !/BRDP-RB-14 .*→ Draft/.test(r.out), 'progress: «BRDP-RB-14 FALLA, PASA al repetir», no Draft', r.out);
    const a14 = await approval('BRDP-RB-14');
    const h14 = await history('BRDP-RB-14');
    assert(a14.status === 'approved' && a14.last_test_result === 'passed' && a14.last_test_up_to_date === true && a14.rule_xml === rules['BRDP-RB-14'], '14: the pass on repeat recorded, stays Verified, rule_xml intact', JSON.stringify({ s: a14.status, r: a14.last_test_result }));
    assert(h14.filter((h) => h.field_name === 'rule_test').length === 1 && !h14.some((h) => h.field_name === 'rule_status' && h.new_value === 'draft'), '14: one test in History (the failed first attempt is not recorded), no «verified → draft»');
    const e14 = JSON.parse(fs.readFileSync(path.join(reportDir, 'resultados.json'), 'utf8')).entries.filter((e) => e.identifier === 'BRDP-RB-14').at(-1);
    assert(e14.result === 'passed' && e14.attempts?.map((a) => `${a.result}:${a.recorded}`).join(',') === 'failed:false,passed:true', '14: resultados.json keeps both attempts', JSON.stringify(e14.attempts?.map((a) => [a.result, a.recorded])));
    assert(/- BRDP-RB-14 — Verified \(falla, pasa al repetir\)/.test(fs.readFileSync(path.join(reportDir, 'informe.md'), 'utf8')), 'report: «falla, pasa al repetir» in the passing list');

    // ── A connection cut once (recording the test): retried, recorded once ──
    const TEST_POST = /\/approvals\/[^/]+\/test$/;
    proxy.state.cut = { pattern: TEST_POST, count: 1 };
    r = await runScript(['--project', projectName, '--only', 'RB-13'], { env: { PROMPT_EVAL_API_URL: proxy.url } });
    assert(proxy.state.cuts === 1 && /connection cut .*retrying once/.test(r.out) && /BRDP-RB-13 PASA/.test(r.out), 'cut once: retried, the rule tested normally', r.out);
    assert((await history('BRDP-RB-13')).filter((h) => h.field_name === 'rule_test').length === 2, 'cut once: recorded (one more test in History)');
    // Cut twice (the retry too): a backend error, the rule untouched.
    const before14 = await approval('BRDP-RB-14');
    proxy.state.cut = { pattern: TEST_POST, count: 2 };
    await fetch(`${CHAT}/invert-next`, { method: 'POST' });
    r = await runScript(['--project', projectName, '--only', 'RB-14', '--all', '--no-retry'], { env: { PROMPT_EVAL_API_URL: proxy.url } });
    assert(proxy.state.cut.count === 0, 'cut twice: the request and its one retry were cut');
    proxy.state.cut = { pattern: null, count: 0 };
    const after14 = await approval('BRDP-RB-14');
    assert(/BRDP-RB-14 ERROR: FETCH FAILED/.test(r.out) && after14.status === 'approved' && after14.last_test_at === before14.last_test_at, 'cut twice: a backend error, nothing recorded, stays Verified (no Draft); --no-retry: one attempt', r.out);

    // ── AI daily limit midway: stops cleanly, relaunch goes on ──
    const usage = (await json('/api/admin/llm-usage?days=1')).rows.filter((row) => row.user_id === me.id);
    const counted = usage.filter((row) => row.kind === 'chat' && row.result !== 'rate_limited').reduce((s, row) => s + row.calls, 0);
    // 01 passes with 2 calls (examples, Proposal check); 02 fails its first
    // attempt with 2 more and hits the limit on the repeat: it is untouched.
    await restartBackend({ LLM_CALLS_PER_DAY: String(counted + 4) });
    token = await login();
    r = await runScript(['--project', projectName, '--only', 'RB-01,RB-02,RB-03,RB-04']);
    assert(r.code === 3 && /STOPPED/.test(r.out) && /not tested/.test(r.out) && /run the same command again/.test(r.out), 'daily limit: stops cleanly, says how many remain and how to go on', r.out);
    assert((await approval('BRDP-RB-01')).last_test_result === 'passed', 'daily limit: what was done stays recorded (01 passed)');
    const stoppedJson = JSON.parse(fs.readFileSync(path.join(reportDir, 'resultados.json'), 'utf8'));
    assert(stoppedJson.pending.length >= 2 && stoppedJson.runs.at(-1).stopped, 'daily limit: report lists the rules not tested and the stop', JSON.stringify(stoppedJson.pending));
    const notRecorded = [];
    for (const id of stoppedJson.pending) if ((await approval(id)).last_test_result === null) notRecorded.push(id);
    assert(notRecorded.length === stoppedJson.pending.length, 'daily limit: the rule cut by the limit recorded nothing', JSON.stringify(notRecorded));
    const a02stopped = await approval('BRDP-RB-02');
    assert(stoppedJson.pending.includes('BRDP-RB-02') && a02stopped.status === 'approved' && a02stopped.last_test_result === null, 'daily limit on the repeat: 02 untouched (still Verified, nothing recorded)', JSON.stringify({ p: stoppedJson.pending, s: a02stopped.status, r: a02stopped.last_test_result }));

    // ── Relaunch with the normal limits: goes on, passed ones skipped ──
    await restartBackend();
    token = await login();
    r = await runScript(['--project', projectName]);
    assert(r.code === 0, 'relaunch ends', r.out);
    assert(/BRDP-RB-01 SALTADA/.test(r.out) && /BRDP-RB-07 SALTADA/.test(r.out), 'relaunch: passed on the same rule are skipped (also the panel one)', r.out);
    assert(/BRDP-RB-02 FALLA, FALLA al repetir → Draft/.test(r.out), 'Verified that fails twice → Draft', r.out);
    assert(/BRDP-RB-03 FALLA \(/.test(r.out) && !/BRDP-RB-03 FALLA →/.test(r.out), 'Draft that fails: state untouched', r.out);
    assert(/BRDP-RB-04 PASA/.test(r.out) && /BRDP-RB-06 PASA/.test(r.out), 'Draft and Verified that pass', r.out);
    assert(!/BRDP-RB-08/.test(r.out) && /1 BRDP\(s\) without a saved rule/.test(r.out), 'BRDP without a rule: not in the loop, counted apart', r.out);

    // What is recorded, against the panel's test of 07.
    const a02 = await approval('BRDP-RB-02');
    assert(a02.status === 'pending_review' && a02.rule_xml === rules['BRDP-RB-02'], '02: Draft, rule_xml intact');
    const h02 = await history('BRDP-RB-02');
    const test02 = h02.filter((h) => h.field_name === 'rule_test');
    const revoke02 = h02.filter((h) => h.field_name === 'rule_status' && h.old_value === 'verified' && h.new_value === 'draft');
    assert(test02.length === 1 && revoke02.length === 1 && test02[0].user_email === me.email && revoke02[0].user_email === me.email, '02: two History entries (test + verified → draft) with the login user');
    assert(a02.last_test_result === 'failed', '02 fails twice: the second attempt recorded (failed)');
    const e02 = JSON.parse(fs.readFileSync(path.join(reportDir, 'resultados.json'), 'utf8')).entries.filter((e) => e.identifier === 'BRDP-RB-02').at(-1);
    assert(e02.attempts?.length === 2 && e02.attempts[0].recorded === false && e02.attempts[1].recorded === true && e02.attempts.every((a) => a.result === 'failed' && a.examples?.length > 0), '02: resultados.json keeps both attempts, only the second recorded', JSON.stringify(e02.attempts?.map((a) => [a.result, a.recorded])));
    const a03 = await approval('BRDP-RB-03');
    assert(a03.status === 'pending_review' && a03.last_test_result === 'failed', '03: Draft that fails, recorded, state untouched');
    const a04 = await approval('BRDP-RB-04');
    assert(a04.status === 'pending_review' && a04.last_test_result === 'passed', '04: passes, stays Draft (never promoted)');
    const a07 = await approval('BRDP-RB-07');
    const shape = (a) => ({
      result: a.last_test_result,
      reason: a.last_test_reason,
      up_to_date: a.last_test_up_to_date,
      category: a.test_category,
      edited: a.last_test_edited_examples,
      passed_keys: Object.keys(a.last_passed_test || {}).sort(),
      example_keys: [...new Set((a.last_passed_test?.examples || []).flatMap((e) => Object.keys(e)))].sort(),
      examples: (a.last_passed_test?.examples || []).length > 0,
    });
    assert(JSON.stringify(shape(a04)) === JSON.stringify(shape(a07)), 'script test (04) recorded like the panel test (07)', `${JSON.stringify(shape(a04))}\n${JSON.stringify(shape(a07))}`);
    const h04 = (await history('BRDP-RB-04')).find((h) => h.field_name === 'rule_test');
    const h07 = (await history('BRDP-RB-07')).find((h) => h.field_name === 'rule_test');
    assert(h04 && h07 && h04.user_email === h07.user_email && JSON.stringify(Object.keys(JSON.parse(h04.new_value)).sort()) === JSON.stringify(Object.keys(JSON.parse(h07.new_value)).sort()), 'History entry the same as the panel’s (user, value shape)');
    assert(a07.last_test_at === panel07.last_test_at, 'the panel’s passed test of 07 was skipped, not replaced');

    // ── The report: one folder for the day, appended. 10, 11, 12 were Draft
    // already in the relaunch (one attempt); 02 and 09 were still Verified
    // (two attempts). ──
    const report = fs.readFileSync(path.join(reportDir, 'informe.md'), 'utf8');
    const results = JSON.parse(fs.readFileSync(path.join(reportDir, 'resultados.json'), 'utf8'));
    assert(results.runs.length === 9, 'same project and day: one folder, nine passes appended', String(results.runs.length));
    assert(/\| BRDP-RB-02 \| falla, falla al repetir \| → Draft \|/.test(report) && /\| BRDP-RB-03 \| falla \| — \|/.test(report), 'report: failing table with Draft column', report);
    assert(/\| BRDP-RB-09 \| falla, falla al repetir \| → Draft \|/.test(report) && /\| BRDP-RB-10 \| falla \| → Draft \|/.test(report), 'report: moved to Draft by an earlier pass of the folder, or by a later one after a failed revoke', report);
    assert(/\| BRDP-RB-05 \| no ejecutable \| → Draft \|/.test(report) && /\| BRDP-RB-11 \| revisar \| → Draft \|/.test(report) && /\| BRDP-RB-12 \| no concluyente \| → Draft \|/.test(report), 'report: not executable, review, inconclusive → Draft', report);
    assert(/## Pasan pero siguen en Draft \(3\)\n\n- BRDP-RB-04\n- BRDP-RB-06\n- BRDP-RB-07 \(saltada: ya había pasado\)/.test(report), 'report: passes but still Draft (04, 06 after its timeout, 07)', report);
    assert(/- BRDP-RB-13 — Verified \(pasa \(el esquema ya lo incluye\)\)/.test(report), 'report: already covered by the schema stays Verified', report);
    assert(results.entries.some((e) => e.identifier === 'BRDP-RB-04' && e.examples?.length > 0 && e.reason_text === ''), 'resultados.json keeps the examples');
    fs.copyFileSync(path.join(reportDir, 'informe.md'), path.join(os.tmpdir(), 'project-rule-tests-informe.md'));

    // ── Relaunch after finishing: failed ones tested again, passed skipped ──
    r = await runScript(['--project', projectName]);
    assert(/BRDP-RB-02 FALLA \(/.test(r.out) && /BRDP-RB-03 FALLA/.test(r.out) && /BRDP-RB-04 SALTADA/.test(r.out), 'relaunch: failed ones (now Draft) re-tested, passed skipped', r.out);
    assert((await history('BRDP-RB-02')).filter((h) => h.field_name === 'rule_status' && h.new_value === 'draft').length === 1, 'a Draft that fails again is not revoked again');

    // ── A rule edited after it passed is tested again; Ctrl+C keeps what is done ──
    await json(`/api/projects/${project.id}/brdps/${ids['BRDP-RB-04']}/approvals/${FORMAT}`, {
      method: 'PUT',
      body: JSON.stringify({ rule_xml: rules['BRDP-RB-04'].replace('Rule BRDP-RB-04.', 'Rule BRDP-RB-04, edited.'), source: 'manual', status: 'pending_review' }),
    });
    let interrupted = false;
    await fetch(`${CHAT}/slow-next?ms=1500&count=40`, { method: 'POST' });
    r = await runScript(['--project', projectName], {
      onLine: (line, child) => {
        if (!interrupted && /^\[\d+\/\d+\] BRDP-RB-0[1-3]/.test(line)) {
          interrupted = true;
          child.kill('SIGINT');
        }
      },
    });
    await fetch(`${CHAT}/reset`, { method: 'POST' });
    assert(interrupted && r.code === 130 && /Stopping after the rule/.test(r.out), 'Ctrl+C: stops after the rule in progress, exit 130', r.out);
    const afterCtrlC = JSON.parse(fs.readFileSync(path.join(reportDir, 'resultados.json'), 'utf8'));
    assert(afterCtrlC.runs.at(-1).stopped === 'Ctrl+C' && afterCtrlC.pending.length > 0, 'Ctrl+C: the report keeps what is done and lists the rest');
    r = await runScript(['--project', projectName, '--only', 'RB-04']);
    assert(/BRDP-RB-04 PASA/.test(r.out), 'rule edited after it passed: tested again, not skipped', r.out);

    // ── The report cannot be saved (a directory in its place stands for a
    // file Windows keeps locked): the pass goes on, says so, exits 3; a .tmp
    // left by an earlier pass is removed; once the lock is gone the next
    // pass writes the report again, complete. ──
    const informe = path.join(reportDir, 'informe.md');
    fs.rmSync(informe, { force: true });
    fs.mkdirSync(informe);
    fs.writeFileSync(path.join(reportDir, 'resultados.json.tmp'), 'half a file');
    r = await runScript(['--project', projectName, '--only', 'RB-01,RB-13']);
    assert(/Removed resultados\.json\.tmp left by an earlier pass/.test(r.out) && !fs.existsSync(path.join(reportDir, 'resultados.json.tmp')), 'a leftover .tmp is removed at the start', r.out);
    assert(/No se pudo guardar informe\.md \(EISDIR\): cierra el fichero si lo tienes abierto; se reintenta tras la siguiente regla\./.test(r.out), 'save fails: one line, the pass goes on', r.out);
    assert(/BRDP-RB-13 PASA/.test(r.out) && !/\n\s+at /.test(r.out), 'save fails: the next rule is tested, no trace', r.out);
    assert(r.code === 3 && /THE REPORT IS NOT UP TO DATE: the last save of informe\.md failed/.test(r.out), 'last save failed: said clearly, exit 3', r.out);
    assert(!fs.existsSync(`${informe}.tmp`), 'no informe.md.tmp left after the failure');
    assert(JSON.parse(fs.readFileSync(path.join(reportDir, 'resultados.json'), 'utf8')).runs.length >= 8, 'resultados.json still saved');
    fs.rmSync(informe, { recursive: true, force: true });
    r = await runScript(['--project', projectName, '--only', 'RB-01']);
    assert(r.code === 0 && fs.statSync(informe).isFile() && /## Totales/.test(fs.readFileSync(informe, 'utf8')) && /BRDP-RB-13/.test(fs.readFileSync(informe, 'utf8')), 'lock gone: the next save writes the report again, complete', r.out);

  } finally {
    proxy.server.close();
    await fetch(`${CHAT}/reset`, { method: 'POST' }).catch(() => {});
    if (uvicornPid() === null) await restartBackend();
    token = await login().catch(() => token);
    await api(`/api/projects/${project.id}?permanent=true`, { method: 'DELETE' });
    if (viewerSeeded) execFileSync(backendPython(), ['scripts/seed_compare_verification.py', 'cleanup'], { cwd: BACKEND_DIR, env: pythonEnv() });
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
  console.log(`\n${failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
