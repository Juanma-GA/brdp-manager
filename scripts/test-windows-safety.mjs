// Guards against what only works on Linux in the scripts (Protecciones 1c):
// the checks also run on Windows (Node + PowerShell, git with CRLF).
//
// 1. A file URL's .pathname is never used as a path: on Windows it is
//    "/C:/Users/...", which fs, path and a child process (Python opened
//    "C:\C:\Users\...") get wrong. fileURLToPath (or the URL object itself,
//    for fs) is the way. .pathname of an http URL (a request's path) is
//    fine and not flagged.
// 2. No hand-written Linux location in code: "/tmp/..." (shot() /
//    os.tmpdir()), backend/.venv/bin/... (scripts/lib/backendPython.mjs),
//    and no program Windows does not have: ps, xmllint, psql, sh/bash.
//
// The scanner is checked on its own fixtures first (the old line of
// test-generate-one-block-per-schema.mjs is flagged, the http uses are not),
// then run over every .mjs/.js under scripts/.
// Run: node scripts/test-windows-safety.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// Code without comments (line and block) and with string contents kept: a
// comment may mention "/tmp" or ps, the code may not.
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      out += source.slice(i, end < 0 ? source.length : end + 2).replace(/[^\n]/g, ' ');
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const FILE_URL_SOURCE = /import\.meta\.url|pathToFileURL\(|["'`]file:/;

// .pathname uses that come from a file URL: inline (new URL(..., import.meta.url).pathname,
// pathToFileURL(x).pathname) or through a variable assigned from one.
export function filePathnameUses(source) {
  const code = stripComments(source);
  const found = [];
  const lineOf = (index) => code.slice(0, index).split('\n').length;
  const inline = /(?:new URL\([^()]*(?:\([^()]*\)[^()]*)*\)|pathToFileURL\([^()]*\)|import\.meta\.url)\s*\.pathname\b/g;
  for (const m of code.matchAll(inline)) {
    if (m[0].startsWith('new URL(') && !FILE_URL_SOURCE.test(m[0])) continue;
    found.push(lineOf(m.index));
  }
  const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
  for (const m of code.matchAll(assigned)) {
    if (!(/new URL\(|pathToFileURL\(/.test(m[2]) && FILE_URL_SOURCE.test(m[2]))) continue;
    const use = new RegExp(`(?<![\\w$.])${m[1].replace(/\$/g, '\\$')}\\.pathname\\b`, 'g');
    for (const u of code.matchAll(use)) found.push(lineOf(u.index));
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

const LINUX_ONLY = [
  { name: 'a hand-written /tmp path (use shot() or os.tmpdir())', re: /["'`]\/tmp(?:\/|["'`])/ },
  { name: 'backend/.venv/bin (use scripts/lib/backendPython.mjs)', re: /\.venv\/bin\// },
  { name: 'the ps program (use scripts/lib/backendProcess.mjs)', re: /(?:execFileSync|execFile|spawn|spawnSync)\(\s*["'`]ps["'`]/ },
  { name: 'the xmllint program (use scripts/lib/xsdCheck.mjs)', re: /(?:execFileSync|execFile|spawn|spawnSync)\(\s*["'`]xmllint["'`]/ },
  { name: 'the psql program (use the backend Python)', re: /(?:execFileSync|execFile|spawn|spawnSync)\(\s*["'`]psql["'`]/ },
  { name: 'a shell (sh/bash) or shell: true', re: /(?:execFileSync|execFile|spawn|spawnSync)\(\s*["'`](?:sh|bash|\/bin\/sh|\/bin\/bash)["'`]|shell:\s*true|\bexecSync\(/ },
];

export function linuxOnlyUses(source) {
  const code = stripComments(source);
  const out = [];
  code.split('\n').forEach((line, i) => {
    for (const rule of LINUX_ONLY) if (rule.re.test(line)) out.push({ line: i + 1, what: rule.name });
  });
  return out;
}

// ── The scanner on its own fixtures ──────────────────────────────────────
{
  // The real line of test-generate-one-block-per-schema.mjs before 1c.
  const before = [
    'async function roundTrip(file) {',
    '  const path = new URL(`../backend/tests/fixtures/brex/${file}`, import.meta.url);',
    "  const original = fs.readFileSync(path, 'utf8');",
    "  const extracted = extractRules(path.pathname, 'BREX-4.2', 'S1000D 4.2', '4.2');",
    '}',
  ].join('\n');
  check('flags the old .pathname of test-generate-one-block-per-schema', filePathnameUses(before).join() === '4', String(filePathnameUses(before)));
  check('fileURLToPath of the same URL is fine', filePathnameUses(before.replace('extractRules(path.pathname', 'extractRules(fileURLToPath(path)')).length === 0);
  check('inline new URL(.., import.meta.url).pathname is flagged', filePathnameUses("const p = new URL('../x.json', import.meta.url).pathname;").length === 1);
  check('import.meta.url .pathname is flagged', filePathnameUses('const here = new URL(import.meta.url).pathname;').length === 1);
  check('pathToFileURL(...).pathname is flagged', filePathnameUses('spawn(py, [pathToFileURL(f).pathname]);').length === 1);
  check('a file: URL literal is flagged', filePathnameUses("const u = new URL('file:///C:/x/y.txt');\nfs.readFileSync(u.pathname);").join() === '2');
  // Legitimate: the path of an http URL.
  check('http: new URL(url).pathname is fine', filePathnameUses('const API_ROUTE = (url) => new URL(url).pathname.startsWith("/api/");').length === 0);
  check('http: a request URL variable is fine', filePathnameUses('const u = new URL(req.url, "http://localhost");\nif (u.pathname === "/api/x") {}').length === 0);
  check('a comment mentioning .pathname is fine', filePathnameUses('// never URL(import.meta.url).pathname').length === 0);
  check('"/tmp/x.png" is flagged', linuxOnlyUses('await page.screenshot({ path: "/tmp/x.png" });').length === 1);
  check('"/tmp" default is flagged', linuxOnlyUses('const SHOTS = process.env.SHOTS_DIR || "/tmp";').length === 1);
  check('.venv/bin is flagged', linuxOnlyUses('execFileSync(".venv/bin/python", args);').length === 1);
  check('ps is flagged', linuxOnlyUses('execFileSync("ps", ["-eo", "pid,args"]);').length === 1);
  check('xmllint is flagged', linuxOnlyUses('execFileSync("xmllint", ["--noout"]);').length === 1);
  check('a comment about /tmp is fine', linuxOnlyUses('// screenshots used to go to "/tmp/x.png"').length === 0);
  check('os.tmpdir() is fine', linuxOnlyUses('path.join(os.tmpdir(), "x.png")').length === 0);
}

// ── Every script ─────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'runs' || entry.name === 'report') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const self = fileURLToPath(import.meta.url);
const files = walk(SCRIPTS).filter((f) => f !== self);
check('scans the scripts', files.length > 100, String(files.length));
for (const file of files) {
  const rel = path.relative(path.dirname(SCRIPTS), file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  const lines = filePathnameUses(source);
  check(`${rel}: no file URL .pathname`, lines.length === 0, `line(s) ${lines.join(', ')}: use fileURLToPath`);
  // backendProcess.mjs is where ps is allowed: it is the Linux/macOS branch
  // next to the Windows one.
  if (rel === 'scripts/lib/backendProcess.mjs') continue;
  for (const use of linuxOnlyUses(source)) check(`${rel}:${use.line}: ${use.what}`, false);
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
