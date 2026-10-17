// The backend's Python, for the Node scripts that need it (Excel reader,
// BREX/Schematron reader, the pytest runner). One rule everywhere:
// $BACKEND_PYTHON if set, else the backend's virtualenv (Linux/macOS
// backend/.venv/bin/python or Windows backend\.venv\Scripts\python.exe),
// else python3/python on the PATH.
//
//   pythonCandidates()                  -> paths/commands, in that order
//   backendPython()                     -> the first candidate (no check)
//   findBackendPython({ modules })      -> { python, executable, kind } or
//                                          { python: null, reason }
//   describePython(found)               -> "<full path> (<kind>)", for the
//                                          summaries: the backend's
//                                          virtualenv, BACKEND_PYTHON, or a
//                                          system Python on the PATH
//   pythonEnv(extra)                    -> process.env for a Python child:
//                                          UTF-8 output on Windows too
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

export function backendPython() {
  return pythonCandidates()[0];
}

// A Python child writes in the console's code page on Windows (cp1252) when
// its output is a pipe: an accent or "→" would come out wrong or fail.
// PYTHONIOENCODING makes it UTF-8, which is what every caller decodes.
export function pythonEnv(extra = {}) {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extra };
}

// Which Python it is, told apart in the summaries: a system python3/python
// that happens to have the packages is not the backend's virtualenv.
export function pythonKind(python, executable = python) {
  const venv = path.join(BACKEND_DIR, '.venv') + path.sep;
  const inVenv = [python, executable].some((p) => path.isAbsolute(p) && path.resolve(p).startsWith(venv));
  const fromEnv = Boolean(process.env.BACKEND_PYTHON) && python === process.env.BACKEND_PYTHON;
  if (inVenv) return fromEnv ? 'backend virtualenv, from BACKEND_PYTHON' : 'backend virtualenv';
  return fromEnv ? 'BACKEND_PYTHON, not backend/.venv' : 'system Python on the PATH, not backend/.venv';
}

export function describePython(found) {
  return `${found.executable || found.python} (${found.kind || pythonKind(found.python, found.executable)})`;
}

export function findBackendPython({ modules = [] } = {}) {
  const tried = [];
  // The imports, then the interpreter's full path (for "python3" too).
  const code = `${modules.length ? `import ${modules.join(', ')}\n` : ''}import sys\nprint(sys.executable)`;
  for (const python of pythonCandidates()) {
    const res = spawnSync(python, ['-c', code], { cwd: BACKEND_DIR, encoding: 'utf8', env: pythonEnv(), timeout: 60_000 });
    if (res.error) {
      tried.push(`${python}: ${res.error.code === 'ENOENT' ? 'not found' : res.error.message}`);
      continue;
    }
    if (res.status === 0) {
      const executable = (res.stdout || '').trim().split(/\r?\n/).pop() || python;
      return { python, executable, kind: pythonKind(python, executable), tried };
    }
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
