// Rows of an .xlsx workbook, for the Node scripts -- SheetJS (xlsx) is gone
// from the project (see src/utils/excelUtils.js), so reading goes through
// backend/scripts/read_template.py, which reads exactly like the app's
// Excel import (backend/app/services/excel_io.py).
//
//   readXlsxRows(pathOrBuffer) -> [{ ID, Title, ..., Rule }, ...]
//
// One object per data row of the first sheet, keyed by the header cells,
// every value as text ("" for an empty cell). Python: $BACKEND_PYTHON if
// set, else backend's virtualenv (Linux/macOS or Windows layout), else
// python3/python on the PATH.
import { execFileSync } from 'node:child_process';
import { BACKEND_DIR as BACKEND, pythonCandidates } from './backendPython.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(BACKEND, 'scripts', 'read_template.py');

export function readXlsxRows(source) {
  const input = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  let lastError;
  for (const python of pythonCandidates()) {
    try {
      const out = execFileSync(python, [SCRIPT, '-'], { cwd: BACKEND, input, maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(out.toString('utf8'));
    } catch (err) {
      lastError = err;
      if (err.code !== 'ENOENT') break;
    }
  }
  const detail = lastError?.stderr?.toString().trim() || lastError?.message;
  throw new Error(`could not read the workbook with ${SCRIPT} (set BACKEND_PYTHON to the backend's Python): ${detail}`);
}

// A curated template of public/ by file name (e.g. "brdp-template-4-2.xlsx").
export function readPublicTemplate(file) {
  return readXlsxRows(fileURLToPath(new URL(`../../public/${file.replace(/^\//, '')}`, import.meta.url)));
}

// Rows retired from the curated 4.1/4.2 templates when they were rebuilt
// with the 10 project decisions (scripts/rule-test-fixtures/
// retired-template-rules.json): their real rules stay covered by the tests.
// `file` filters by the template they came from; each row keeps ID, Title,
// Definition, Proposal, Rule, plus file/format/standard.
export function retiredTemplateRows(file = null) {
  const doc = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../rule-test-fixtures/retired-template-rules.json', import.meta.url)), 'utf8'));
  return doc.rows.filter((r) => !file || r.file === file);
}
