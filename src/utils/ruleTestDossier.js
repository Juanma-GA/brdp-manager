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

// ─── "WHERE THE RULE LOOKS" (Test de reglas, progreso y causas, Part 1.5) ──
// The expressions of a dossier rule that navigate the dossier's files,
// quoted in the examples prompt so the AI places every value exactly where
// the rule looks for it (real case: Navantia BRDP-EXT-00004/00008, where the
// AI invented where the values went -- the Proposal does not say it).
//
// Which expressions, decided from the rule's text (never guessed):
//   - the dossier-derived set D, to a fixed point: a sch:let whose value
//     calls doc(), doc-available() or document(); one whose value names a
//     $variable of D; a function let ("function(") called from a value of D
//     (EXT-00004's $escalonPlan, applied to $tablasPlan's nodes by
//     $valoresPlan); and a rule's @context / an assert's or report's @test
//     that names a $variable of D;
//   - of those, only the ones that navigate: a "/" or "@" outside string
//     literals ($docs//entry[...], $tr/@href). One that only combines values
//     ("exists($tablasPlan) = exists($celdasProc)") says nothing about where
//     a value goes.
// In document order, at most DOSSIER_LOOK_MAX; whitespace outside string
// literals collapsed (the same criterion as _normSpace), each cut at
// DOSSIER_LOOK_MAX_CHARS with an explicit mark. Returns
// { expressions: [{ kind: 'let'|'test'|'context', name, text, cut }], omitted }.
export const DOSSIER_LOOK_MAX = 10;
export const DOSSIER_LOOK_MAX_CHARS = 700;
const SCH_NS = 'http://purl.oclc.org/dsdl/schematron';
const DOC_CALL_RE = /\b(?:doc|doc-available|document)\s*\(/;

// The text outside string literals (literals emptied: '' / "").
function outsideLiterals(text) {
  return String(text || '').replace(/"[^"]*"|'[^']*'/g, (m) => m[0] + m[0]);
}
const varRefs = (code) => new Set([...code.matchAll(/\$([\p{L}_][\p{L}\p{N}_.-]*)/gu)].map((m) => m[1]));
const varCalls = (code) => new Set([...code.matchAll(/\$([\p{L}_][\p{L}\p{N}_.-]*)\s*\(/gu)].map((m) => m[1]));

function collapseOutsideLiterals(text) {
  let out = '';
  let quote = '';
  let space = false;
  for (const ch of String(text || '')) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (/\s/.test(ch)) {
      space = out.length > 0;
      continue;
    }
    if (space) out += ' ';
    space = false;
    if (ch === "'" || ch === '"') quote = ch;
    out += ch;
  }
  return out;
}

function schElements(doc) {
  const out = [];
  const walk = (el) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      const local = n.localName || String(n.nodeName).replace(/^.*:/, '');
      const ns = n.namespaceURI;
      if (!ns || ns === SCH_NS) {
        if (local === 'let' && n.getAttribute('name')) out.push({ kind: 'let', name: n.getAttribute('name'), text: n.getAttribute('value') || '' });
        else if (local === 'rule' && n.getAttribute('context')) out.push({ kind: 'context', name: null, text: n.getAttribute('context') });
        else if ((local === 'assert' || local === 'report') && n.getAttribute('test')) {
          out.push({ kind: 'test', name: n.getAttribute('id') || null, check: local, text: n.getAttribute('test') });
        }
      }
      walk(n);
    }
  };
  walk(doc.documentElement);
  return out;
}

export function dossierLookExpressions(ruleXml, parseXml) {
  let doc;
  try {
    doc = parseXml(`<root xmlns:sch="${SCH_NS}">${String(ruleXml || '')}</root>`);
  } catch {
    return { expressions: [], omitted: 0 };
  }
  if (!doc?.documentElement) return { expressions: [], omitted: 0 };
  const items = schElements(doc).map((it) => ({ ...it, code: outsideLiterals(it.text) }));
  const lets = items.filter((it) => it.kind === 'let');
  const derived = new Set(lets.filter((l) => DOC_CALL_RE.test(l.code)).map((l) => l.name));
  for (let changed = true; changed; ) {
    changed = false;
    for (const l of lets) {
      if (derived.has(l.name)) continue;
      const usesDerived = [...varRefs(l.code)].some((v) => derived.has(v));
      const calledFromDerived =
        /^\s*function\s*\(/.test(l.code) && lets.some((o) => derived.has(o.name) && varCalls(o.code).has(l.name));
      if (usesDerived || calledFromDerived) {
        derived.add(l.name);
        changed = true;
      }
    }
  }
  const navigates = (code) => /[/@]/.test(code);
  const chosen = items.filter((it) => {
    const inD = it.kind === 'let' ? derived.has(it.name) : [...varRefs(it.code)].some((v) => derived.has(v));
    return inD && navigates(it.code);
  });
  const expressions = chosen.slice(0, DOSSIER_LOOK_MAX).map((it) => {
    const full = collapseOutsideLiterals(it.text);
    const cut = full.length > DOSSIER_LOOK_MAX_CHARS ? full.length - DOSSIER_LOOK_MAX_CHARS : 0;
    return { kind: it.kind, name: it.name, text: cut ? full.slice(0, DOSSIER_LOOK_MAX_CHARS) : full, cut };
  });
  return { expressions, omitted: Math.max(0, chosen.length - DOSSIER_LOOK_MAX) };
}
