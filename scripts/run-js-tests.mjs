#!/usr/bin/env node
// npm run test:js -- every scripts/test-*.mjs, one by one.
//
// One line per file (name, result, time) and a summary at the end. Exit
// code: 0 if all pass; 1 if any fails or hangs; 2 if none failed but some
// could not run because the environment lacks something (the backend's
// Python) -- that is not an app failure, but it is not "everything checked"
// either, so the final line never says TODO OK then.
//
// A new scripts/test-*.mjs is picked up on its own: the list is read from
// the folder on every run.
//
// Options:
//   --timeout <seconds>   per file (default 180, or $JS_TEST_TIMEOUT_SECONDS).
//                         A file that runs longer is killed and reported.
//                         The slowest file takes about 12 s on the Linux
//                         dev environment; on a Windows laptop 4-5 times
//                         that (~60 s): 180 leaves a margin of 3.
//   <text> ...            only the files whose name contains one of them.
//
// Tests that read the curated Excel templates or a BREX/Schematron go
// through the backend's Python (scripts/lib/readXlsx.mjs,
// scripts/lib/extractRules.mjs). The runner finds which ones from their
// imports and checks once that the backend's Python is there; if it is
// not, those files are reported as "not run" with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describePython, findBackendPython } from './lib/backendPython.mjs';
import { duration, rule, runProcess, seconds, tail } from './lib/checkReport.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPTS);
const NEEDS_PYTHON = ['lib/readXlsx.mjs', 'lib/extractRules.mjs', 'lib/schemaGraph.mjs'].map((p) => path.join(SCRIPTS, p));

function parseArgs(argv) {
  let timeout = Number(process.env.JS_TEST_TIMEOUT_SECONDS) || 180;
  const filters = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--timeout') {
      timeout = Number(argv[i + 1]);
      i += 1;
      if (!(timeout > 0)) {
        console.error('--timeout needs a number of seconds greater than 0');
        process.exit(2);
      }
    } else filters.push(argv[i]);
  }
  return { timeoutMs: timeout * 1000, filters };
}

// Relative imports of a file (static `from '…'` and dynamic import('…')),
// resolved to absolute paths.
function relativeImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
  let m;
  while ((m = re.exec(text))) found.push(path.resolve(path.dirname(file), m[2]));
  return found;
}

// Does `file` reach one of NEEDS_PYTHON through its relative imports
// (only those inside scripts/: the app's own modules never call Python)?
function needsBackendPython(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  for (const dep of relativeImports(file)) {
    if (NEEDS_PYTHON.includes(dep)) return true;
    if (dep.startsWith(SCRIPTS + path.sep) && fs.existsSync(dep) && needsBackendPython(dep, seen)) return true;
  }
  return false;
}

const { timeoutMs, filters } = parseArgs(process.argv.slice(2));
const files = fs
  .readdirSync(SCRIPTS)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .filter((f) => !filters.length || filters.some((t) => f.includes(t)))
  .sort();

if (!files.length) {
  console.error(filters.length ? `No scripts/test-*.mjs matches: ${filters.join(', ')}` : 'No scripts/test-*.mjs found.');
  process.exit(2);
}

const pythonFiles = new Set(files.filter((f) => needsBackendPython(path.join(SCRIPTS, f))));
let pythonProblem = null;
let pythonUsed = null;
if (pythonFiles.size) {
  const found = findBackendPython({ modules: ['openpyxl', 'lxml'] });
  if (!found.python) pythonProblem = found.reason;
  else pythonUsed = describePython(found);
}

console.log(`JS tests: ${files.length} files (scripts/test-*.mjs), up to ${seconds(timeoutMs)} each`);
if (pythonUsed) console.log(`Python: ${pythonUsed} -- for the ${pythonFiles.size} files that read Excel or BREX/Schematron`);
const width = Math.max(...files.map((f) => f.length));
const results = [];
const started = Date.now();

for (const file of files) {
  if (pythonProblem && pythonFiles.has(file)) {
    results.push({ file, status: 'skipped', ms: 0 });
    console.log(`  ${file.padEnd(width)}  NOT RUN    (needs the backend's Python)`);
    continue;
  }
  const res = await runProcess(process.execPath, [path.join('scripts', file)], { cwd: ROOT, timeoutMs });
  let status = 'ok';
  if (res.timedOut) status = 'timeout';
  else if (res.code !== 0) status = 'fail';
  results.push({ file, status, ms: res.ms, output: res.output });
  const label = { ok: 'OK', fail: 'FAIL', timeout: 'TIMEOUT' }[status];
  const note = status === 'timeout' ? `  killed after ${seconds(timeoutMs)}` : '';
  console.log(`  ${file.padEnd(width)}  ${label.padEnd(9)}  ${seconds(res.ms).padStart(7)}${note}`);
}

const total = Date.now() - started;
const failed = results.filter((r) => r.status === 'fail' || r.status === 'timeout');
const skipped = results.filter((r) => r.status === 'skipped');
const passed = results.filter((r) => r.status === 'ok');

for (const r of failed) {
  console.log('');
  console.log(rule('-'));
  console.log(
    r.status === 'timeout'
      ? `${r.file}: did not finish in ${seconds(timeoutMs)} and was killed. Last lines:`
      : `${r.file}: failed. Last lines:`,
  );
  for (const line of tail(r.output, 25)) console.log(`  ${line}`);
}

console.log('');
console.log(rule());
console.log(`JS tests: ${passed.length} OK, ${failed.length} failed, ${skipped.length} not run, in ${duration(total)}`);
if (pythonUsed) console.log(`Python: ${pythonUsed}`);
if (failed.length) console.log(`  Failed: ${failed.map((r) => r.file + (r.status === 'timeout' ? ' (timeout)' : '')).join(', ')}`);
if (skipped.length) {
  console.log(`  Not run (environment, not an app failure): ${skipped.length} files need the backend's Python.`);
  console.log(`  ${pythonProblem}`);
}
if (failed.length) {
  console.log('RESULT: FAILED');
  process.exit(1);
}
if (skipped.length) {
  console.log('RESULT: INCOMPLETE (environment)');
  process.exit(2);
}
console.log('TODO OK');
