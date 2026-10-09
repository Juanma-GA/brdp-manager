// Test de reglas sobre un dosier (Part 2): the examples of a DITA rule that
// reads other files (doc(), doc-available(), document() -- analyzeRule's
// `dossier`, utils/ruleTestSchematron.js). Each example is a DOSSIER: the
// ditamap the rule runs on (the example's "content", a whole document, as
// for any rule on the root) and up to DOSSIER_MAX_FILES more files, each a
// relative path and a complete DITA document. Pure (no React, no API):
// importable from plain Node.
//
// - materializeDossierFiles: every file gets the same automatic fixes as a
//   document example (colspecs, morerows, an element moved down its only
//   valid way) and the structure of its own type, read from its root
//   element (topic, concept, task, reference, troubleshooting, map).
// - dossierProblems: what makes the dossier itself unusable (too many
//   files, a path outside the folder, the same path twice, an unknown root)
//   -- the example is not run and goes to the correction round, naming the
//   file.
// - dossierReferenceWarnings: an @href or @conref to a path that is not in
//   the dossier. A warning, never an error: the rule decides what a missing
//   file means (doc-available() is false for it).
import { DOSSIER_BASE_URI, DOSSIER_MAX_FILES, dossierUri } from './ruleTestSchematron.js';
import { addMissingCalsColspecs, fixCalsRowSpans, removeSpannedCalsEntries } from '../validation/schemaValidation.js';
import { relocateMisplacedElements } from './schemaPlacement.js';

export { DOSSIER_MAX_FILES };
// The ditamap's path inside the dossier folder (the main document).
export const DOSSIER_MAIN_PATH = 'dossier.ditamap';
export const DOSSIER_MAX_FILE_LINES = 30;
// The DITA types a dossier file can be (its root element).
export const DOSSIER_FILE_TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'];

export function normalizeDossierPath(path) {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

function rootName(xml, parseXml) {
  try {
    const doc = parseXml(String(xml || ''));
    const root = doc?.documentElement;
    return root ? root.localName || String(root.nodeName).replace(/^.*:/, '') : null;
  } catch {
    return null;
  }
}

// { [type]: structure } for the DITA types the dossier files can be.
export async function loadDossierStructures(standard, fetchStructure) {
  const out = {};
  for (const type of DOSSIER_FILE_TYPES) {
    try {
      const structure = await fetchStructure(standard, type);
      if (structure?.available !== false) out[type] = structure;
    } catch {
      // that type's files are checked against the vocabulary only
    }
  }
  return out;
}

// files: [{ path, content }] as the LLM wrote them →
// [{ path, content, xml, schema, root, structure, colspecsAdded, colsRaised,
//    morerowsLowered, emptyRowsRemoved, spannedEntriesRemoved, relocated }]
export function materializeDossierFiles(files, structures, parseXml) {
  return (files || []).map((file) => {
    const withColspecs = addMissingCalsColspecs(file.content, parseXml);
    const rowSpans = fixCalsRowSpans(withColspecs.content, parseXml);
    const { content: fixed, removedRows } = removeSpannedCalsEntries(rowSpans.content, parseXml);
    const root = rootName(fixed, parseXml);
    const schema = root && DOSSIER_FILE_TYPES.includes(root) ? root : null;
    const structure = schema ? structures?.[schema] || null : null;
    let content = fixed;
    let relocated = [];
    if (structure?.models) {
      const moved = relocateMisplacedElements(content, structure, null);
      if (moved.moved.length) {
        content = moved.text;
        relocated = moved.moved;
      }
    }
    return {
      path: normalizeDossierPath(file.path),
      content,
      xml: content,
      schema,
      root,
      structure,
      colspecsAdded: withColspecs.added,
      colsRaised: withColspecs.colsRaised,
      morerowsLowered: rowSpans.morerowsLowered,
      emptyRowsRemoved: rowSpans.emptyRowsRemoved,
      spannedEntriesRemoved: removedRows,
      ...(relocated.length ? { relocated } : {}),
    };
  });
}

// What the engine needs: { mainPath, files: [{ path, xml }] }.
export function dossierForEngine(example) {
  if (!Array.isArray(example?.files)) return null;
  return { mainPath: example.mainPath || DOSSIER_MAIN_PATH, files: example.files.map((f) => ({ path: f.path, xml: f.xml ?? f.content ?? '' })) };
}

// [{ code, params }] -- see the header. `files` are materialized files.
export function dossierProblems(files, mainPath = DOSSIER_MAIN_PATH) {
  const problems = [];
  if (files.length > DOSSIER_MAX_FILES) problems.push({ code: 'dossier_too_many_files', params: { count: files.length, max: DOSSIER_MAX_FILES } });
  const seen = new Set([dossierUri(mainPath)]);
  for (const f of files) {
    const uri = f.path ? dossierUri(f.path) : null;
    if (!f.path || !uri || !uri.startsWith(DOSSIER_BASE_URI) || /^[a-z][a-z0-9+.-]*:/i.test(f.path) || f.path.startsWith('/')) {
      problems.push({ code: 'dossier_bad_path', params: { path: f.path || '' } });
      continue;
    }
    if (seen.has(uri)) problems.push({ code: 'dossier_duplicate_path', params: { path: f.path } });
    seen.add(uri);
    if (f.root && !f.schema) problems.push({ code: 'dossier_unknown_root', params: { path: f.path, root: f.root, types: DOSSIER_FILE_TYPES.join(', ') } });
  }
  return problems;
}

// The English sentence (the correction round).
export function dossierProblemText(problem) {
  const p = problem.params || {};
  switch (problem.code) {
    case 'dossier_too_many_files':
      return `the dossier has ${p.count} files besides the ditamap; write at most ${p.max}`;
    case 'dossier_bad_path':
      return `file path "${p.path}" is not a relative path inside the dossier folder (for example "topics/safety.dita")`;
    case 'dossier_duplicate_path':
      return `file path "${p.path}" is used twice (or is the ditamap's own path)`;
    case 'dossier_unknown_root':
      return `file "${p.path}": <${p.root}> is not the root of a DITA document type the test knows (${p.types})`;
    default:
      return problem.code;
  }
}

const SKIP_REFERENCE_RE = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

// Every @href / @conref (and @conkeyref is left alone: it goes through a
// key, not a path) of the ditamap and the files whose target file is not in
// the dossier: [{ file, attr, value }]. scope="external", absolute URIs
// (http:, file:, mailto:) and same-file references (#…) are skipped -- the
// rule skips them too.
export function dossierReferenceWarnings(mainXml, files, parseXml, mainPath = DOSSIER_MAIN_PATH) {
  const docs = [{ path: mainPath, xml: mainXml }, ...files.map((f) => ({ path: f.path, xml: f.xml ?? f.content }))];
  const present = new Set(docs.map((d) => dossierUri(d.path)).filter(Boolean));
  const warnings = [];
  for (const d of docs) {
    let doc;
    try {
      doc = parseXml(String(d.xml || ''));
    } catch {
      continue;
    }
    const base = dossierUri(d.path);
    if (!base || !doc?.documentElement) continue;
    const walk = (el) => {
      for (const attr of ['href', 'conref']) {
        if (!el.hasAttribute(attr)) continue;
        const value = el.getAttribute(attr);
        if (!value || SKIP_REFERENCE_RE.test(value) || el.getAttribute('scope') === 'external') continue;
        const target = dossierUri(value.split('#')[0], base);
        if (target && !present.has(target)) warnings.push({ file: d.path, attr, value });
      }
      for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) walk(c);
    };
    walk(doc.documentElement);
  }
  return warnings;
}

export function dossierWarningText(w) {
  return `file "${w.file}": @${w.attr}="${w.value}" points to a file that is not in the dossier`;
}
