// Corrección propuesta de reglas con defecto: when code finds a defect in a
// SAVED rule, the application prepares a correction the person accepts or
// discards -- "the AI proposes, the code checks, people decide"; here no AI
// is involved at all, and nothing is ever applied on its own.
//
// ruleDefects(ruleXml, format, ctx) → { defects, needsOtherVocabularies }
//   every defect code finds in the rule, each { key, code, params, fix }:
//   fix is the ONE mechanical fix (or null). Codes:
//     not_well_formed {error}                                  no fix
//     rule_format {problem: {code, params}}                    no fix
//     multiple_paths {count, path}                             split (ruleSplit.js)
//     duplicate_ids {ids}                                      number the ids
//     xpath_invalid {expression}                               no fix
//     name_case / name_similar {type, name, to, standard}      rename in the paths
//     name_ambiguous {type, name, candidates, standard}        no fix
//     name_other_standard {type, name, standards, standard}    no fix
//     name_unknown {type, name, standard}                      no fix
//     wrong_type {name, usedAs, actualAs, standard}            no fix
//     path {problem}            remove/insert steps, /x → //x (rulePathCheck.js), or none
//     any_ancestor {problem}    //X → ancestor::X, or none
//   A project-level defect (an id used by the rules of two BRDPs) is added
//   by the caller with projectRuleIdClashes below; it never has a fix.
//
// proposeRuleCorrection(ruleXml, format, ctx) → { defects, proposal,
//   needsOtherVocabularies }: proposal is null, or { xml, fixes, remaining }
//   -- ALL the mechanical fixes that apply, one after the other, each kept
//   only when the rule it leaves has no defect it did not have before and
//   no longer has the one it fixed (so a rename that leaves an impossible
//   path, or a fix that breaks the XPath, is never proposed: that defect
//   stays without a fix). `remaining` says what is still wrong after them.
//
// ctx: { vocabulary, otherVocabularies, graph, standard, schemaLocation,
// parseXml }. Without a vocabulary there is no name check; without a graph
// (a standard with no schema graph) no path check; otherVocabularies null =
// not loaded yet -- a name that might exist in another standard is then
// not decided (needsOtherVocabularies), the caller loads them and asks
// again. Pure module: the same code runs in the browser (the BRDP's ficha,
// the project list) and in the Node tests.
import { numberDuplicateRuleIds, splitMultiPathRules, ruleElementIds } from '../utils/ruleSplit.js';
import { parseXmlDocument } from '../utils/ruleTestCommon.js';
import { wrapRuleXmlFragment } from '../utils/ruleXmlFragment.js';
import { applyRulePathFix, checkAncestorAbsolutePaths, checkRulePaths, formatAncestorProblem, formatPathFix, formatPathProblem } from './rulePathCheck.js';
import { checkRuleFormat, checkRuleNames, formatSchemaIssue, formatStandardList, invalidRuleXPaths, similarSchemaNames, standardsWithName } from './schemaValidation.js';

const BREX_FORMATS = new Set(['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']);
const MAX_STEPS = 20;

// ─── Renaming a name inside the rule's XPath only ──────────────────────────

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.-]/;
const XPATH_KEYWORDS = new Set([
  'and', 'or', 'div', 'idiv', 'mod', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'is',
  'if', 'then', 'else', 'for', 'let', 'in', 'return', 'some', 'every', 'satisfies',
  'as', 'instance', 'of', 'treat', 'cast', 'castable', 'to', 'union', 'intersect', 'except',
]);

// The XPath text with every `from` used as `type` renamed to `to` -- read
// the same way extractXPathNames reads names (never inside a literal, a
// variable, an entity, a prefixed name, a function call or an axis name).
export function renameXPathName(xpath, from, to, type) {
  const src = String(xpath ?? '');
  let out = '';
  let i = 0;
  let prev = '';
  let attributeAxis = false;
  const peek = (j) => {
    while (j < src.length && /\s/.test(src[j])) j += 1;
    return j;
  };
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = src.indexOf(ch, i + 1);
      const end = close === -1 ? src.length : close + 1;
      out += src.slice(i, end);
      i = end;
      prev = ch;
      continue;
    }
    if (ch === '&') {
      const semi = src.indexOf(';', i);
      const end = semi === -1 ? i + 1 : semi + 1;
      const entity = src.slice(i, end);
      out += entity;
      i = end;
      prev = entity === '&lt;' ? '<' : entity === '&gt;' ? '>' : entity === '&amp;' ? '&' : ';';
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && (NAME_CHAR.test(src[j]) || src[j] === ':')) j += 1;
      out += src.slice(i, j);
      i = j;
      prev = 'v';
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE]/.test(src[j])) j += 1;
      out += src.slice(i, j);
      i = j;
      prev = '0';
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i;
      while (j < src.length && NAME_CHAR.test(src[j])) j += 1;
      while (j > i + 1 && /[.-]/.test(src[j - 1])) j -= 1;
      let name = src.slice(i, j);
      let prefixed = false;
      if (src[j] === ':' && src[j + 1] !== ':' && NAME_START.test(src[j + 1] || '')) {
        prefixed = true;
        j += 1;
        while (j < src.length && NAME_CHAR.test(src[j])) j += 1;
        name = src.slice(i, j);
      }
      const next = peek(j);
      const isAxis = src[next] === ':' && src[next + 1] === ':';
      const isCall = src[next] === '(';
      const inStep = prev === '' || '/@[(,|:'.includes(prev);
      const isOperator = XPATH_KEYWORDS.has(name) && (!inStep || src[next] === '$');
      if (isAxis) {
        attributeAxis = name === 'attribute';
        out += src.slice(i, next + 2);
        i = next + 2;
        prev = ':';
        continue;
      }
      const kind = prev === '@' || attributeAxis ? 'attribute' : 'element';
      const rename = !prefixed && !isCall && !isOperator && name === from && kind === type;
      out += rename ? to : name;
      i = j;
      attributeAxis = false;
      prev = 'n';
      continue;
    }
    if (ch !== '*') attributeAxis = false;
    out += ch;
    prev = ch;
    i += 1;
  }
  return out;
}

// The rule with the rename applied to its XPath only: objectPath / objpath
// text, and the context/test of a Schematron rule/assert/report -- never to
// objectUse or a message. → { xml, changed }
export function renameNameInRuleXml(ruleXml, from, to, type) {
  const text = String(ruleXml ?? '');
  let changed = false;
  const rename = (inner) => {
    const out = renameXPathName(inner, from, to, type);
    if (out !== inner) changed = true;
    return out;
  };
  const xml = text
    .replace(/(<(?:[\w.-]+:)?(objectPath|objpath)\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?\2\s*>)/g, (_m, open, _n, inner, close) => open + rename(inner) + close)
    .replace(/<(?:[A-Za-z_][\w.-]*:)?(?:rule|assert|report)\b[^>]*>/g, (tag) =>
      tag.replace(/(\s(?:context|test)\s*=\s*)("([^"]*)"|'([^']*)')/g, (_m, before, quoted) => before + quoted[0] + rename(quoted.slice(1, -1)) + quoted[0])
    );
  return { xml, changed };
}

// ─── Finding the defects ────────────────────────────────────────────────────

const pathKey = (p) => [p.kind, p.element, p.parent, p.attribute, p.inPredicate ? 1 : 0, p.predicate, p.alternative].join('|');

// The problem as plain data (what History and the UI need to say it again).
function pathParams(p) {
  const out = {};
  for (const k of ['kind', 'element', 'parent', 'attribute', 'parents', 'owners', 'ways', 'inPredicate', 'predicate', 'alternative', 'alternatives', 'flag', 'ruleId', 'ancestor', 'looked', 'checked', 'operand']) {
    if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  }
  return out;
}

function nameDefect(name, type, ctx, flags) {
  const { vocabulary, otherVocabularies, standard } = ctx;
  const base = { type, name, standard };
  const key = `name|${type}|${name}`;
  const { caseOnly, near } = similarSchemaNames(name, type, vocabulary);
  if (caseOnly.length === 1) return { key, code: 'name_case', params: { ...base, to: caseOnly[0] }, fix: { kind: 'rename', type, from: name, to: caseOnly[0] } };
  if (caseOnly.length > 1) return { key, code: 'name_ambiguous', params: { ...base, candidates: caseOnly }, fix: null };
  if (otherVocabularies === null || otherVocabularies === undefined) {
    flags.needsOtherVocabularies = true;
    return { key, code: 'name_unknown', params: { ...base, pending: true }, fix: null };
  }
  const standards = standardsWithName(name, type, otherVocabularies);
  if (standards.length > 0) return { key, code: 'name_other_standard', params: { ...base, standards }, fix: null };
  if (near.length === 1) return { key, code: 'name_similar', params: { ...base, to: near[0] }, fix: { kind: 'rename', type, from: name, to: near[0] } };
  if (near.length > 1) return { key, code: 'name_ambiguous', params: { ...base, candidates: near }, fix: null };
  return { key, code: 'name_unknown', params: base, fix: null };
}

export function ruleDefects(ruleXml, format, ctx = {}) {
  const xml = String(ruleXml ?? '');
  const flags = { needsOtherVocabularies: false };
  const defects = [];
  const parseXml = ctx.parseXml || parseXmlDocument;
  if (!xml.trim()) return { defects, needsOtherVocabularies: false };
  try {
    parseXml(wrapRuleXmlFragment(xml));
  } catch (err) {
    defects.push({ key: 'well_formed', code: 'not_well_formed', params: { error: String(err?.message || err) }, fix: null });
    return { defects, needsOtherVocabularies: false };
  }
  const options = { schemaLocation: ctx.schemaLocation || null, parseXml };

  const fmt = checkRuleFormat(xml, format);
  if (fmt.problem) {
    const { code, params } = fmt.problem;
    if (code === 'rule_format_multiple') {
      const split = splitMultiPathRules(xml, format);
      defects.push({
        key: 'multiple_paths',
        code: 'multiple_paths',
        params: { count: params.count, path: params.child },
        fix: split.total > 0 ? { kind: 'split', count: split.total, path: params.child } : null,
      });
    } else if (code === 'rule_format_duplicate_ids') {
      const numbered = numberDuplicateRuleIds(xml, format);
      defects.push({
        key: 'duplicate_ids',
        code: 'duplicate_ids',
        params: { ids: params.ids },
        fix: numbered.renamed.length ? { kind: 'number_ids', renamed: numbered.renamed } : null,
      });
    } else {
      defects.push({ key: `format|${code}`, code: 'rule_format', params: { problem: { code, params } }, fix: null });
    }
  }

  for (const expression of invalidRuleXPaths(xml)) {
    defects.push({ key: `xpath|${expression}`, code: 'xpath_invalid', params: { expression }, fix: null });
  }

  if (ctx.vocabulary) {
    const names = checkRuleNames(xml, ctx.vocabulary);
    for (const { name, type } of names.typedNotFound) defects.push(nameDefect(name, type, ctx, flags));
    for (const w of names.wrongType) {
      defects.push({ key: `wrong|${w.usedAs}|${w.name}`, code: 'wrong_type', params: { name: w.name, usedAs: w.usedAs, actualAs: w.actualAs, standard: ctx.standard }, fix: null });
    }
  }

  if (ctx.graph) {
    let check;
    try {
      check = checkRulePaths(xml, format, ctx.graph, options);
    } catch {
      check = null;
    }
    for (const p of check?.problems || []) {
      defects.push({ key: `path|${pathKey(p)}`, code: 'path', params: { problem: pathParams(p) }, fix: p.fix ? { kind: 'path', pathFix: p.fix } : null });
    }
  }

  if (BREX_FORMATS.has(format)) {
    let found;
    try {
      found = checkAncestorAbsolutePaths(xml, format, options);
    } catch {
      found = [];
    }
    for (const p of found) {
      defects.push({
        key: `ancestor|${p.ancestor}|${p.operand}|${p.checked}`,
        code: 'any_ancestor',
        params: { problem: pathParams({ ...p, kind: 'anyAncestor' }) },
        fix: p.fix ? { kind: 'path', pathFix: p.fix } : null,
      });
    }
  }

  // Same key twice (a name used in two rules of the fragment): once.
  const seen = new Set();
  return { defects: defects.filter((d) => (seen.has(d.key) ? false : seen.add(d.key))), needsOtherVocabularies: flags.needsOtherVocabularies };
}

// ─── Applying a fix ─────────────────────────────────────────────────────────

export function applyDefectFix(ruleXml, format, fix) {
  const xml = String(ruleXml ?? '');
  if (!fix) return { xml, changed: false };
  if (fix.kind === 'split') {
    const r = splitMultiPathRules(xml, format);
    return { xml: r.xml, changed: r.total > 0 };
  }
  if (fix.kind === 'number_ids') {
    const r = numberDuplicateRuleIds(xml, format);
    return { xml: r.xml, changed: r.renamed.length > 0 };
  }
  if (fix.kind === 'rename') return renameNameInRuleXml(xml, fix.from, fix.to, fix.type);
  if (fix.kind === 'path') return applyRulePathFix(xml, fix.pathFix);
  return { xml, changed: false };
}

// ─── The proposal ───────────────────────────────────────────────────────────

// Above this size a rule is never corrected one fix at a time: each check
// of a rule that big costs seconds (BRDP-S1-00007 of the CA BREX, 4500
// rules, 1.9 MB), so only the all-at-once attempt is made.
const ONE_BY_ONE_MAX_CHARS = 50000;

// Applies the fixes in order; → { xml, applied } (a fix that no longer
// applies to the text is left out).
function applyAll(ruleXml, format, defects) {
  let xml = ruleXml;
  const applied = [];
  for (const d of defects) {
    const after = applyDefectFix(xml, format, d.fix);
    if (!after.changed) continue;
    xml = after.xml;
    applied.push(d);
  }
  return { xml, applied };
}

// The fixes are kept only when the rule they leave no longer has their
// defects and has none it did not have before.
function acceptable(before, afterDefects, applied) {
  const keys = new Set(before.map((d) => d.key));
  return !afterDefects.some((d) => applied.some((a) => a.key === d.key) || !keys.has(d.key));
}

export function proposeRuleCorrection(ruleXml, format, ctx = {}) {
  const original = ruleDefects(ruleXml, format, ctx);
  const result = { defects: original.defects, proposal: null, needsOtherVocabularies: original.needsOtherVocabularies };
  const fixable = original.defects.filter((d) => d.fix);
  if (fixable.length === 0) return result;
  const source = String(ruleXml ?? '');

  // First every fix at once: one more check of the rule.
  const all = applyAll(source, format, fixable);
  if (all.applied.length > 0) {
    const afterDefects = ruleDefects(all.xml, format, ctx).defects;
    if (acceptable(original.defects, afterDefects, all.applied)) {
      // A fix may only become possible after another (a rename that makes
      // a path checkable): one more round on what is left.
      const more = afterDefects.filter((d) => d.fix);
      let xml = all.xml;
      let remaining = afterDefects;
      const applied = [...all.applied];
      if (more.length > 0) {
        const again = applyAll(xml, format, more);
        if (again.applied.length > 0) {
          const after2 = ruleDefects(again.xml, format, ctx).defects;
          if (acceptable(afterDefects, after2, again.applied)) {
            xml = again.xml;
            remaining = after2;
            applied.push(...again.applied);
          }
        }
      }
      result.proposal = { xml, fixes: applied, remaining };
      return result;
    }
  }
  if (source.length > ONE_BY_ONE_MAX_CHARS) return result;

  // Otherwise one at a time, each kept only when it passes on its own.
  let xml = source;
  let current = original.defects;
  const applied = [];
  const tried = new Set();
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const next = current.find((d) => d.fix && !tried.has(d.key));
    if (!next) break;
    tried.add(next.key);
    const after = applyDefectFix(xml, format, next.fix);
    if (!after.changed) continue;
    const afterDefects = ruleDefects(after.xml, format, ctx).defects;
    if (!acceptable(current, afterDefects, [next])) continue;
    xml = after.xml;
    current = afterDefects;
    applied.push(next);
  }
  if (applied.length === 0) return result;
  result.proposal = { xml, fixes: applied, remaining: current };
  return result;
}

// The fixes of a proposal as History records them: { code, params, fix }.
export function correctionRecord(proposal) {
  return {
    fixes: (proposal?.fixes || []).map((d) => ({ code: d.code, params: d.params, fix: d.fix })),
    remaining: (proposal?.remaining || []).map((d) => ({ code: d.code, params: d.params })),
  };
}

// ─── An id used by the rules of two BRDPs of the project ────────────────────

// rules: [{ brdpId, identifier, xml }] → Map(brdpId → [{ id, others: [identifiers] }])
export function projectRuleIdClashes(rules, format) {
  const owners = new Map();
  for (const rule of rules) {
    for (const id of new Set(ruleElementIds(rule.xml, format))) {
      if (!owners.has(id)) owners.set(id, []);
      owners.get(id).push(rule);
    }
  }
  const out = new Map();
  for (const [id, list] of owners) {
    if (list.length < 2) continue;
    for (const rule of list) {
      const others = list.filter((r) => r.brdpId !== rule.brdpId).map((r) => r.identifier).sort();
      if (!others.length) continue;
      if (!out.has(rule.brdpId)) out.set(rule.brdpId, []);
      out.get(rule.brdpId).push({ id, others });
    }
  }
  return out;
}

export function clashDefects(clashes) {
  return (clashes || []).map((c) => ({ key: `clash|${c.id}`, code: 'project_duplicate_id', params: { id: c.id, others: c.others }, fix: null }));
}

// ─── Text ───────────────────────────────────────────────────────────────────

const shown = (type, name) => (type === 'attribute' ? `@${name}` : `<${name}>`);

export function formatRuleDefect(defect, t, { format = null } = {}) {
  const p = defect.params || {};
  const or = t('records.rulePath.or');
  switch (defect.code) {
    case 'not_well_formed':
      return t('records.ruleCorrection.defects.notWellFormed', { error: p.error });
    case 'rule_format':
      return formatSchemaIssue({ source: 'rule', code: p.problem.code, params: p.problem.params }, t);
    case 'multiple_paths':
      return t('records.ruleCorrection.defects.multiplePaths', { count: p.count, path: p.path });
    case 'duplicate_ids':
      return t('records.ruleCorrection.defects.duplicateIds', { ids: Array.isArray(p.ids) ? p.ids.join(', ') : p.ids });
    case 'xpath_invalid':
      return t('records.ruleCorrection.defects.xpathInvalid', { expression: p.expression });
    case 'name_case':
      return t('records.ruleCorrection.defects.nameCase', { name: shown(p.type, p.name), to: shown(p.type, p.to), standard: p.standard });
    case 'name_similar':
      return t('records.ruleCorrection.defects.nameSimilar', { name: shown(p.type, p.name), to: shown(p.type, p.to), standard: p.standard });
    case 'name_ambiguous':
      return t('records.ruleCorrection.defects.nameAmbiguous', {
        name: shown(p.type, p.name),
        candidates: p.candidates.map((c) => shown(p.type, c)).join(` ${or} `),
        standard: p.standard,
      });
    case 'name_other_standard':
      return t('records.ruleCorrection.defects.nameOtherStandard', {
        name: shown(p.type, p.name),
        standard: p.standard,
        standards: formatStandardList(p.standards, t('records.assistant.listAnd')),
      });
    case 'name_unknown':
      return t('records.ruleCorrection.defects.nameUnknown', { name: shown(p.type, p.name), standard: p.standard });
    case 'wrong_type':
      return t(p.usedAs === 'element' ? 'records.ruleCorrection.defects.wrongTypeAsElement' : 'records.ruleCorrection.defects.wrongTypeAsAttribute', {
        name: p.name,
        standard: p.standard,
      });
    case 'path':
      return formatPathProblem(p.problem, t, { format });
    case 'any_ancestor':
      return formatAncestorProblem(p.problem, t);
    case 'project_duplicate_id':
      return t('records.ruleCorrection.defects.projectDuplicateId', { count: p.others.length, id: p.id, others: p.others.join(', ') });
    default:
      return defect.code;
  }
}

export function formatRuleFix(fix, t) {
  if (!fix) return '';
  if (fix.kind === 'split') return t('records.ruleCorrection.fixes.split', { count: fix.count });
  if (fix.kind === 'number_ids') return fix.renamed.map((r) => t('records.ruleCorrection.fixes.numberIds', { id: r.id, ids: r.to.join(', ') })).join(' ');
  if (fix.kind === 'rename') return t('records.ruleCorrection.fixes.rename', { from: shown(fix.type, fix.from), to: shown(fix.type, fix.to) });
  if (fix.kind === 'path') return `${formatPathFix(fix.pathFix, t)}.`;
  return '';
}
