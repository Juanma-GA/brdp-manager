// The backend's Python, for the Node scripts that need it (Excel reader,
// BREX/Schematron reader, the pytest runner). One rule everywhere:
// $BACKEND_PYTHON if set, else the backend's virtualenv (Linux/macOS
// backend/.venv/bin/python or Windows backend\.venv\Scripts\python.exe),
// else python3/python on the PATH.
//
//   pythonCandidates()                  -> paths/commands, in that order
//   findBackendPython({ modules })      -> { python } or { python: null, reason }
//
// findBackendPython checks that the interpreter really runs AND imports the
// given modules (e.g. ["openpyxl", "lxml"] for the readers, ["pytest"] for
// the tests), so "there is a python3 on the PATH without the backend's
// packages" is told apart from "the backend is set up".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKEND_DIR = fileURLToPath(new URL('../../backend/', import.meta.url));

export function pythonCandidates() {
  if (process.env.BACKEND_PYTHON) return [process.env.BACKEND_PYTHON];
  const venv = [
    path.join(BACKEND_DIR, '.venv', 'bin', 'python'),
    path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe'),
  ];
  return [...venv.filter((p) => fs.existsSync(p)), 'python3', 'python'];
}

export function findBackendPython({ modules = [] } = {}) {
  const tried = [];
  const code = modules.length ? `import ${modules.join(', ')}` : 'pass';
  for (const python of pythonCandidates()) {
    const res = spawnSync(python, ['-c', code], { cwd: BACKEND_DIR, encoding: 'utf8', timeout: 60_000 });
    if (res.error) {
      tried.push(`${python}: ${res.error.code === 'ENOENT' ? 'not found' : res.error.message}`);
      continue;
    }
    if (res.status === 0) return { python, tried };
    const last = (res.stderr || '').trim().split(/\r?\n/).pop();
    tried.push(`${python}: ${last || `exit ${res.status}`}`);
  }
  const wanted = modules.length ? ` with ${modules.join(', ')}` : '';
  return {
    python: null,
    tried,
    reason:
      `no backend Python${wanted} (tried ${tried.join('; ')}). ` +
      'Create backend/.venv and install the backend from its lockfile (README, "Backend"), or set BACKEND_PYTHON.',
  };
}
