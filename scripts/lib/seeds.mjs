// Data a browser script needs, seeded by the script itself and removed when
// it ends (Regresión antes del despliegue): a verify-*.mjs gives the same
// result the first time and the tenth, in a fresh database or in one full
// of earlier runs, and leaves nothing behind that changes another script.
//
//   runSeed('seed_x.py', [args])        -> runs it now, returns its stdout
//   seedForThisRun('seed_x.py')         -> runs it now and runs
//                                          `seed_x.py cleanup` when the process
//                                          exits -- also on process.exit() and
//                                          on an uncaught error
//
// Every test-only seed in backend/scripts supports "cleanup". The real
// S1000D catalogs (seed_extract_catalog_42.py, import_brdp_catalog.py) are
// reference data of the development environment: seeded with runSeed (it
// only adds what is missing) and left in place.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BACKEND_DIR, backendPython, pythonEnv } from './backendPython.mjs';

export function runSeed(script, args = []) {
  try {
    return execFileSync(backendPython(), [path.join('scripts', script), ...args], {
      cwd: BACKEND_DIR,
      env: pythonEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`backend/scripts/${script} ${args.join(' ')} failed: ${String(err.stderr || err.message || '').trim().slice(-600)}`, { cause: err });
  }
}

const registered = new Set();

export function seedForThisRun(script, args = []) {
  const out = runSeed(script, args);
  if (!registered.has(script)) {
    registered.add(script);
    // 'exit' handlers run synchronously: execFileSync is fine here.
    process.once('exit', () => {
      try {
        runSeed(script, ['cleanup']);
      } catch (err) {
        console.error(`cleanup failed: ${err.message}`);
      }
    });
  }
  return out;
}

// A script that switches the account to another language (the language
// selector saves it on the account, AACF 3) gives it back the one it had
// when the process exits, however it ends: otherwise the next script of a
// batch runs in Spanish and looks for English texts.
export function keepAccountLanguage(email) {
  const previous = runSeed('account_language.py', [email]).trim();
  process.once('exit', () => {
    try {
      runSeed('account_language.py', [email, previous]);
    } catch (err) {
      console.error(`could not restore the language of ${email}: ${err.message}`);
    }
  });
  return previous;
}
