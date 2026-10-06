#!/usr/bin/env node
// npm run test:db:create -- creates the database the backend tests use, or
// brings it up to date (backend/scripts/create_test_db.py does the work:
// TEST_DATABASE_URL, or the app's DATABASE_URL with "_test"; create if
// missing, pgvector, migrations). The same on Windows (PowerShell, Postgres
// in Docker) and Linux. Exit code: the script's (0 ready; 2 the role lacks a
// privilege -- the output has the SQL for an administrator; 3 the server is
// not reachable; 1 anything else), or 2 when there is no backend Python.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BACKEND_DIR, findBackendPython } from './lib/backendPython.mjs';

const found = findBackendPython({ modules: ['asyncpg', 'alembic', 'dotenv'] });
if (!found.python) {
  console.log(`test:db:create: not run -- ${found.reason}`);
  process.exit(2);
}
const res = spawnSync(found.python, [path.join('scripts', 'create_test_db.py')], {
  cwd: BACKEND_DIR,
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  windowsHide: true,
});
if (res.error) {
  console.log(`test:db:create: could not start ${found.python}: ${res.error.message}`);
  process.exit(2);
}
process.exit(res.status ?? 1);
