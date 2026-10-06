// The candidates of a BREX / Schematron file read by the AI Extract code
// (backend/app/services/rule_extract.py), for the Node tests of the round
// trip original → AI Extract → Generate. Goes through
// backend/scripts/extract_rules_json.py, with the same Python lookup as
// readXlsx.mjs ($BACKEND_PYTHON, then backend's virtualenv, then
// python3/python).
//
//   extractRules(file, format, standard, issue) ->
//     { file_warnings, candidates: [{ identifier, rule_xml, rule_count,
//       noncontext_count, warnings }] }
import { execFileSync } from 'node:child_process';
import { BACKEND_DIR as BACKEND, pythonCandidates, pythonEnv } from './backendPython.mjs';
import { toPath } from './textFile.mjs';
import path from 'node:path';

const SCRIPT = path.join(BACKEND, 'scripts', 'extract_rules_json.py');

export function extractRules(file, format, standard, issue = null) {
  // `file`: a path or a file: URL (never URL.pathname, "/C:/..." on Windows).
  const args = [SCRIPT, path.resolve(toPath(file)), format, standard, ...(issue ? [issue] : [])];
  let lastError;
  for (const python of pythonCandidates()) {
    try {
      const out = execFileSync(python, args, { cwd: BACKEND, env: pythonEnv(), maxBuffer: 256 * 1024 * 1024 });
      return JSON.parse(out.toString('utf8'));
    } catch (err) {
      lastError = err;
      if (err.code !== 'ENOENT') break;
    }
  }
  const detail = lastError?.stderr?.toString().trim() || lastError?.message;
  throw new Error(`could not read ${file} with ${SCRIPT} (set BACKEND_PYTHON to the backend's Python): ${detail}`);
}
