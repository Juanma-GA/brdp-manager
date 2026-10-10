// Shared bits of the check runners (run-js-tests.mjs, run-backend-tests.mjs,
// run-checks.mjs): running a child process with a timeout, durations, and
// the final summary block. Plain Node, no shell: the same on Windows
// (PowerShell/cmd) and Linux.
import { spawn } from 'node:child_process';

// Runs `command args` and resolves { code, signal, output, ms, timedOut }.
// `output` is stdout+stderr interleaved as they arrived, without colour
// codes. With `live`, the output is also copied to this process's
// stdout/stderr as it comes.
// A run longer than `timeoutMs` is killed (timedOut: true).
export function runProcess(command, args, { cwd, env, timeoutMs = 0, live = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: null, signal: null, output: String(err.message), ms: 0, timedOut: false, spawnError: err });
      return;
    }
    const onData = (stream) => (buf) => {
      chunks.push(buf);
      if (live) stream.write(buf);
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // A process that ignores the polite signal is killed for good.
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, output: String(err.message), ms: Date.now() - started, timedOut, spawnError: err });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, output: stripAnsi(Buffer.concat(chunks).toString('utf8')), ms: Date.now() - started, timedOut });
    });
  });
}

// Text without terminal colour codes, for reading a tool's output.
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

export function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// The last `n` non-empty lines of a text, for showing why something failed.
export function tail(text, n = 30) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n);
}

export function rule(char = '=') {
  return char.repeat(64);
}
