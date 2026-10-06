// The prompt snapshot gives the same prompts when its fixtures are checked
// out with CRLF (Windows, git with core.autocrlf) -- Protecciones 1c.
//
// Copies what scripts/check-prompt-snapshot.mjs reads (the script, the
// snapshot cases and expected prompts, scripts/lib, the rule-test fixtures
// and the free-text fixtures) to a temporary folder with EVERY text file
// converted to CRLF -- worse than a real checkout, where .gitattributes keeps
// the fixtures LF --, links src/ and node_modules/ (a junction on Windows,
// no admin rights needed), and runs the check there: every prompt must be
// byte-identical to expected-prompts.json.
// Run: node scripts/test-snapshot-crlf.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPTS);
const TEXT = /\.(mjs|js|json|md|txt|xml)$/;

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function copyAsCrlf(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyAsCrlf(path.join(from, name), path.join(to, name));
    return;
  }
  if (!TEXT.test(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const text = fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(to, text);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-crlf-'));
try {
  for (const rel of [
    'check-prompt-snapshot.mjs',
    'prompt-snapshot',
    'lib',
    'rule-test-fixtures',
    path.join('prompt-eval', 'fixtures', 'text-extract'),
  ]) {
    copyAsCrlf(path.join(SCRIPTS, rel), path.join(tmp, 'scripts', rel));
  }
  fs.symlinkSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), 'junction');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');

  const guide = fs.readFileSync(path.join(tmp, 'scripts', 'prompt-eval', 'fixtures', 'text-extract', 'guia-estilo-dita-es.md'), 'utf8');
  check('the copied fixtures really have CRLF', guide.includes('\r\n') && !/[^\r]\n/.test(guide));

  let out;
  let code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(tmp, 'scripts', 'check-prompt-snapshot.mjs')], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const m = /(\d+)\/(\d+) prompt\(s\) byte-identical/.exec(out);
  check('check-prompt-snapshot passes with CRLF fixtures', code === 0 && m && m[1] === m[2], out.trim().split(/\r?\n/).slice(-6).join(' | '));
  if (m) console.log(`with CRLF fixtures: ${m[1]}/${m[2]} prompts byte-identical`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
