// The running backend (uvicorn app.main:app) for the browser scripts that
// restart it, on Linux, macOS and Windows (Protecciones 1c: `ps` and
// backend/.venv/bin/uvicorn only exist on Linux/macOS).
//
//   uvicornPid()          -> the PID of the server process, or null
//   startUvicorn(opts)    -> starts `python -m uvicorn app.main:app` with the
//                            backend's Python, detached, output to `log`
import { execFileSync, spawn } from 'node:child_process';
import { BACKEND_DIR, backendPython, pythonEnv } from './backendPython.mjs';

const SERVER_RE = /uvicorn(\.exe)?["']?\s.*app\.main:app/;

function windowsProcesses() {
  const command =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*app.main:app*' } | " +
    'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
  if (!out) return [];
  const list = JSON.parse(out);
  return (Array.isArray(list) ? list : [list]).map((p) => ({ pid: Number(p.ProcessId), name: String(p.Name || ''), args: String(p.CommandLine || '') }));
}

function posixProcesses() {
  const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), name: m[2].split(/\s+/)[0], args: m[2] }));
}

// The server itself: a python (or uvicorn) process whose command line runs
// app.main:app -- never a shell or `ps` whose command line merely mentions
// it. On Windows a venv's uvicorn.exe launcher starts a python child: the
// python one is the server.
export function uvicornPid() {
  const procs = (process.platform === 'win32' ? windowsProcesses() : posixProcesses()).filter(
    (p) => p.pid !== process.pid && SERVER_RE.test(p.args) && /(^|[\\/])(python[\d.]*|uvicorn)(\.exe)?$/i.test(p.name)
  );
  const python = procs.find((p) => /python/i.test(p.name));
  return (python || procs[0])?.pid ?? null;
}

export function startUvicorn({ env = {}, log, port = 8000 } = {}) {
  const child = spawn(backendPython(), ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', String(port)], {
    cwd: BACKEND_DIR,
    env: pythonEnv(env),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
  });
  child.unref();
  return child;
}
