#!/usr/bin/env node
// npm run test:backend -- the backend's pytest suite, the same on Windows
// (PowerShell) and Linux.
//
// 1. Finds the backend's Python with pytest: $BACKEND_PYTHON, else
//    backend/.venv (bin/python on Linux, Scripts\python.exe on Windows),
//    else python3/python (scripts/lib/backendPython.mjs).
// 2. Checks the test database in one line (backend/scripts/check_test_db.py):
//    the database of DATABASE_URL (environment or backend/.env), reachable
//    and migrated. If not, says so and stops -- never hundreds of errors.
// 3. Runs `python -m pytest -q` in backend/, showing its output as it goes,
//    and ends with a short summary.
//
// Extra arguments go to pytest: npm run test:backend -- -k similar -x
// Exit code: pytest's (0 all passed); 2 if the environment is missing
// (no Python with pytest, database down or not migrated).
// A suite that runs longer than $BACKEND_TEST_TIMEOUT_SECONDS (default
// 1800) is killed and reported.
import path from 'node:path';
import { BACKEND_DIR, findBackendPython } from './lib/backendPython.mjs';
import { duration, rule, runProcess, tail } from './lib/checkReport.mjs';

const timeoutMs = (Number(process.env.BACKEND_TEST_TIMEOUT_SECONDS) || 1800) * 1000;
const extraArgs = process.argv.slice(2);
const started = Date.now();

function finish(lines, result, code) {
  console.log('');
  console.log(rule());
  for (const line of lines) console.log(line);
  console.log(result);
  process.exit(code);
}

const found = findBackendPython({ modules: ['pytest', 'pytest_asyncio'] });
if (!found.python) {
  finish(
    [`Backend tests: not run -- ${found.reason}`, 'Install the dev lockfile: see README, "Backend".'],
    'RESULT: INCOMPLETE (environment)',
    2,
  );
}

const db = await runProcess(found.python, [path.join('scripts', 'check_test_db.py')], { cwd: BACKEND_DIR, timeoutMs: 60_000 });
const dbLine = tail(db.output, 1)[0] || `exit ${db.code}`;
if (db.code !== 0) {
  const hint =
    db.code === 4
      ? 'Run the migrations: cd backend; alembic upgrade head (with the backend venv active).'
      : 'Start Postgres (Linux: service postgresql start; Windows/Docker: docker start brdp-postgres) or set DATABASE_URL.';
  finish([`Backend tests: not run -- ${dbLine}`, hint], 'RESULT: INCOMPLETE (environment)', 2);
}
console.log(dbLine);
console.log(`Backend tests: ${found.python} -m pytest -q ${extraArgs.join(' ')}`.trimEnd());

const res = await runProcess(found.python, ['-m', 'pytest', '-q', ...extraArgs], {
  cwd: BACKEND_DIR,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  timeoutMs,
  live: true,
});
const total = Date.now() - started;

if (res.timedOut) {
  finish([`Backend tests: killed after ${duration(timeoutMs)} (BACKEND_TEST_TIMEOUT_SECONDS).`], 'RESULT: FAILED', 1);
}

// pytest's last line: "764 passed, 3 warnings in 151.20s (0:02:31)".
const counts = tail(res.output, 15)
  .reverse()
  .find((l) => /\b\d+ (passed|failed|errors?|skipped|deselected)\b|no tests ran/.test(l));
const summary = counts ? counts.replace(/^=+\s*|\s*=+$/g, '') : `pytest exit code ${res.code}`;
const lines = [`Backend tests: ${summary} (total ${duration(total)})`];
if (res.code !== 0) {
  const failedTests = res.output
    .split(/\r?\n/)
    .filter((l) => /^(FAILED|ERROR) /.test(l))
    .map((l) => `  ${l}`);
  lines.push(...failedTests.slice(0, 20));
  if (failedTests.length > 20) lines.push(`  ... and ${failedTests.length - 20} more`);
  finish(lines, 'RESULT: FAILED', res.code || 1);
}
finish(lines, 'TODO OK', 0);
