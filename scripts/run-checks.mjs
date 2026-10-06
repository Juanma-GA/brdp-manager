#!/usr/bin/env node
// npm run check      -- lint, build, JS tests, prompt snapshot, template lint
// npm run check:all  -- the same plus the backend tests
//
// The steps run one after another and stop at the first failure (the rest
// are listed as "not run"). Each step's own output is kept quiet while it
// passes; when one fails, its last lines are shown. The run ends with a
// one-screen summary -- every step with its result, a short detail and its
// time -- and, if everything passed, the line "TODO OK".
//
// Plain Node, no shell syntax: the same command on Windows (PowerShell) and
// Linux. Exit code: 0 all passed; otherwise the failing step's (2 = the
// environment is missing something: backend Python, test database).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { duration, rule, runProcess, seconds, tail } from './lib/checkReport.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const all = process.argv.includes('--all');
const node = process.execPath;

const steps = [
  {
    name: 'lint',
    args: [path.join('node_modules', 'eslint', 'bin', 'eslint.js'), '.'],
    detail: (out) => {
      const m = out.match(/(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
      return m ? `${m[2]} errors, ${m[3]} warnings` : '0 errors, 0 warnings';
    },
    // The errors only, each under its file: the warnings would push them
    // off the screen.
    failureLines: (out) => {
      const lines = [];
      let file = null;
      for (const line of out.split(/\r?\n/)) {
        if (/^\S.*\.(m?js|jsx|ts|tsx)$/.test(line.trim()) && !/^\s/.test(line)) file = line.trim();
        else if (/^\s+\d+:\d+\s+error\s/.test(line)) {
          if (file) lines.push(file);
          file = null;
          lines.push(line);
        } else if (/problems? \(/.test(line)) lines.push(line.trim());
      }
      return lines;
    },
  },
  {
    name: 'build',
    args: [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    detail: (out) => (out.match(/built in [\d.]+\s*m?s/) || [''])[0],
  },
  {
    name: 'test:js',
    args: [path.join('scripts', 'run-js-tests.mjs')],
    detail: (out) => (out.match(/JS tests: \d+ OK.*$/m) || [''])[0].replace(/^JS tests: /, ''),
  },
  {
    name: 'check:prompts',
    args: [path.join('scripts', 'check-prompt-snapshot.mjs')],
    detail: (out) => tail(out, 1)[0] || '',
  },
  {
    name: 'lint:templates',
    args: [path.join('scripts', 'lint-curated-templates.mjs')],
    detail: (out) => (out.match(/\d+ finding\(s\)\./) || [''])[0],
  },
];
if (all) {
  steps.push({
    name: 'test:backend',
    args: [path.join('scripts', 'run-backend-tests.mjs')],
    detail: (out) => (out.match(/^Backend tests: .*$/gm) || ['']).pop().replace(/^Backend tests: /, ''),
  });
}

const command = all ? 'check:all' : 'check';
console.log(`npm run ${command}: ${steps.map((s) => s.name).join(', ')}`);
const started = Date.now();
const results = [];
let failed = null;

for (const step of steps) {
  if (failed) {
    results.push({ step, status: 'not run' });
    continue;
  }
  process.stdout.write(`  ${step.name} ... `);
  const res = await runProcess(node, step.args, { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
  const status = res.code === 0 ? 'OK' : res.code === 2 && /INCOMPLETE \(environment\)/.test(res.output) ? 'NOT RUN (environment)' : 'FAIL';
  let detail;
  try {
    detail = step.detail(res.output) || '';
  } catch {
    detail = '';
  }
  console.log(`${status} (${seconds(res.ms)})`);
  results.push({ step, status, ms: res.ms, detail, res });
  if (status !== 'OK') failed = results[results.length - 1];
}

if (failed) {
  console.log('');
  console.log(rule('-'));
  const lines = failed.step.failureLines?.(failed.res.output) || [];
  console.log(lines.length ? `${failed.step.name}: errors` : `${failed.step.name}: last lines of its output`);
  for (const line of (lines.length ? lines : tail(failed.res.output, 40)).slice(-40)) console.log(`  ${line}`);
}

const total = Date.now() - started;
const width = Math.max(...steps.map((s) => s.name.length));
console.log('');
console.log(rule());
console.log(`npm run ${command} -- summary`);
for (const r of results) {
  const time = r.ms === undefined ? '' : seconds(r.ms).padStart(8);
  const detail = r.detail ? `  ${r.detail}` : '';
  console.log(`  ${r.step.name.padEnd(width)}  ${r.status.padEnd(9)}${time}${detail}`);
}
console.log(`  total: ${duration(total)}`);
if (failed) {
  console.log(`RESULT: FAILED at ${failed.step.name}`);
  process.exit(failed.res.code || 1);
}
console.log('TODO OK');
