// Mejoras C, Part 1: a rule whose path cannot exist in the standard.
//
// Real cases (S1000D 3.0.1):
//   …/prelreqs/reqpers/perscat/trade  -- <trade> is a child of <reqpers>,
//     sibling of the EMPTY <perscat>: perscat/trade never exists, the rule
//     never selects anything, and the examples could only be invalid;
//   /techstd[not(authex) or not(notes)] -- <techstd> is never a document's
//     root (it lives in dmodule/idstatus/status).
// What the schema knows is checked here, by code, before any LLM call:
// for every alternative of every path of the rule,
//   a/b    <b> is a child <a> allows in SOME schema of the rule's scope
//          (its context schemas; without a context, any schema of the
//          standard) -- one schema where the pair exists is enough;
//   a//b   <b> is reachable from <a> (descendant:: too);
//   a/@x   <a> has @x;
//   /x     <x> is the root of some schema of the scope;
// and the same inside predicates that are simple child paths
// ([not(authex)], [b/c], [.//x]). A step with "*", a prefix, another axis
// or a function is not checked (nor the pair after it); a path that ends in
// text() or a function has its last step unchecked by construction. A name
// the standard does not have is left to the name check (never repeated
// here); a name that does not exist in the scope's schemas is left to the
// per-schema coverage warning.
//
// Pure module: the graph (GET /api/schema-cards/graph, or the same data
// from backend/scripts/schema_graph_json.py in Node) is passed in. Without
// a graph there is no check and no warning.
//
// Each problem: { kind: 'child' | 'descendant' | 'attribute' | 'root',
//   element, parent, attribute, parents, owners, ways, inPredicate,
//   predicate, alternative, alternatives, ruleId, path, flag, fix }
// fix (only when there is exactly ONE mechanical fix, never applied on its
// own -- a button the person clicks):
//   { kind: 'descendant_root', from: '/techstd', to: '//techstd' }
//   { kind: 'remove_steps', from: 'reqpers/perscat/trade', to: 'reqpers/trade', removed: ['perscat'] }
import { rulePathParts } from '../utils/ruleTestEngine.js';

const NAME = '[A-Za-z_][\\w.-]*';
const NAME_RE = new RegExp(`^${NAME}$`);
const CHILD_STEP_RE = new RegExp(`^(?:child::)?(${NAME})$`);
const DESC_STEP_RE = new RegExp(`^descendant(?:-or-self)?::(${NAME})$`);
const ATTR_STEP_RE = new RegExp(`^(?:@|attribute::)(${NAME})$`);
const WRAPPER_RE = /^(?:not|boolean|exists|empty|count)\s*\(/;
const MAX_LISTED = 5;
const MAX_WAYS = 3;

// ─── The graph ──────────────────────────────────────────────────────────────

const INDEXES = new WeakMap();

// { schemas, roots: Map(schema → [names]), bySchema: Map(schema → Map(name → { children: Set, attrs: Set })),
//   elementsAnywhere: Set, attributesAnywhere: Set } -- built once per graph.
export function graphIndex(graph) {
  if (!graph || !graph.available || !graph.elements) return null;
  if (INDEXES.has(graph)) return INDEXES.get(graph);
  const bySchema = new Map();
  const elementsAnywhere = new Set();
  const attributesAnywhere = new Set();
  for (const [name, variants] of Object.entries(graph.elements)) {
    elementsAnywhere.add(name);
    for (const [schemas, children, attrs] of variants) {
      for (const a of attrs) attributesAnywhere.add(a);
      for (const schema of schemas) {
        if (!bySchema.has(schema)) bySchema.set(schema, new Map());
        bySchema.get(schema).set(name, { children: new Set(children), attrs: new Set(attrs) });
      }
    }
  }
  const index = {
    schemas: graph.schemas || [...bySchema.keys()],
    roots: new Map(Object.entries(graph.roots || {})),
    bySchema,
    elementsAnywhere,
    attributesAnywhere,
    reach: new Map(),
    parentsBySchema: new Map(),
    // DITA: a nested topic or map type is shell-dependent -- never judged.
    uncheckedChildren: new Set(graph.unchecked_children || []),
  };
  INDEXES.set(graph, index);
  return index;
}

function scopeOf(index, schema) {
  return schema && index.bySchema.has(schema) ? [schema] : index.schemas;
}

const node = (index, schema, name) => index.bySchema.get(schema)?.get(name);
const existsIn = (index, scope, name) => scope.some((s) => Boolean(node(index, s, name)));
const childOk = (index, scope, a, b) => scope.some((s) => node(index, s, a)?.children.has(b) && Boolean(node(index, s, b)));
const attrOk = (index, scope, a, x) => scope.some((s) => node(index, s, a)?.attrs.has(x));

function reachableSet(index, schema, from) {
  const key = `${schema}\u0000${from}`;
  if (index.reach.has(key)) return index.reach.get(key);
  const seen = new Set();
  const frontier = [...(node(index, schema, from)?.children || [])];
  while (frontier.length) {
    const n = frontier.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of node(index, schema, n)?.children || []) if (!seen.has(c)) frontier.push(c);
  }
  index.reach.set(key, seen);
  return seen;
}
const reachableOk = (index, scope, a, b) => scope.some((s) => node(index, s, a) && reachableSet(index, s, a).has(b));

function parentsMap(index, schema) {
  if (index.parentsBySchema.has(schema)) return index.parentsBySchema.get(schema);
  const out = new Map();
  for (const [name, entry] of index.bySchema.get(schema) || []) {
    for (const c of entry.children) {
      if (!out.has(c)) out.set(c, new Set());
      out.get(c).add(name);
    }
  }
  index.parentsBySchema.set(schema, out);
  return out;
}

// The elements <name> can be a direct child of, in the scope.
export function parentsOf(index, scope, name) {
  const out = new Set();
  for (const s of scope) for (const p of parentsMap(index, s).get(name) || []) if (node(index, s, name)) out.add(p);
  return [...out].sort();
}

function ownersOf(index, scope, attribute) {
  const out = new Set();
  for (const s of scope) for (const [name, entry] of index.bySchema.get(s) || []) if (entry.attrs.has(attribute)) out.add(name);
  return [...out].sort();
}

const isRoot = (index, scope, name) => scope.some((s) => (index.roots.get(s) || []).includes(name));

// The chains from a document root down to <name>'s parent, shortest first:
// ["dmodule/idstatus/status"].
function waysFromRoot(index, scope, name) {
  const ways = new Set();
  for (const s of scope) {
    if (!node(index, s, name)) continue;
    for (const root of index.roots.get(s) || []) {
      const previous = new Map([[root, null]]);
      let frontier = [root];
      let found = null;
      while (frontier.length && !found) {
        const next = [];
        for (const n of frontier) {
          for (const c of node(index, s, n)?.children || []) {
            if (previous.has(c)) continue;
            previous.set(c, n);
            if (c === name) {
              found = c;
              break;
            }
            next.push(c);
          }
          if (found) break;
        }
        frontier = next;
      }
      if (found) {
        const chain = [];
        for (let n = previous.get(found); n; n = previous.get(n)) chain.unshift(n);
        ways.add(chain.join('/'));
      }
    }
  }
  return [...ways].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, MAX_WAYS);
}

// ─── Reading the paths ──────────────────────────────────────────────────────

// Calls visit(i, ch, depth) for every character outside string literals,
// with the ()/[] depth BEFORE the character.
function scan(text, visit) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (visit(i, ch, depth) === false) return;
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
  }
}

function matchingClose(text, open) {
  let found = -1;
  scan(text, (i, ch, depth) => {
    if (i <= open) return true;
    if ((ch === ')' || ch === ']') && depth === 1) {
      found = i;
      return false;
    }
    return true;
  });
  return found;
}

function splitWhere(text, test) {
  const parts = [];
  let start = 0;
  scan(text, (i, ch, depth) => {
    if (depth !== 0) return true;
    const len = test(text, i);
    if (len > 0) {
      parts.push(text.slice(start, i));
      start = i + len;
    }
    return true;
  });
  parts.push(text.slice(start));
  return parts;
}

const wordOperator = (text, i) => {
  const m = /^\s(?:and|or)\s/.exec(text.slice(i));
  return m && i > 0 ? m[0].length : 0;
};
const comparison = (text, i) => {
  const m = /^(?:!=|<=|>=|=|<|>|\s(?:eq|ne|lt|le|gt|ge)\s)/.exec(text.slice(i));
  return m ? m[0].length : 0;
};
const unionBar = (text, i) => (text[i] === '|' ? 1 : /^\sunion\s/.test(text.slice(i)) ? 7 : 0);

// The location paths an expression is made of: a plain path, or the
// operands of a condition (and/or, comparisons, not()/count()/…).
export function pathOperands(expression) {
  const out = [];
  const visit = (raw) => {
    let e = raw.trim();
    for (;;) {
      if (e.startsWith('(') && matchingClose(e, 0) === e.length - 1) {
        e = e.slice(1, -1).trim();
        continue;
      }
      const w = WRAPPER_RE.exec(e);
      if (w && matchingClose(e, w[0].length - 1) === e.length - 1) {
        e = e.slice(w[0].length, -1).trim();
        continue;
      }
      break;
    }
    if (!e) return;
    const words = splitWhere(e, wordOperator);
    if (words.length > 1) return words.forEach(visit);
    const sides = splitWhere(e, comparison);
    if (sides.length > 1) return sides.forEach(visit);
    if (/^['"\d]/.test(e) || e === '.' || /^\$/.test(e)) return;
    // another function call: nothing is concluded from its arguments
    if (/^[A-Za-z_][\w.:-]*\s*\(/.test(e) && !/^(?:node|text|comment)\(\)/.test(e)) return;
    out.push(e);
  };
  visit(String(expression || ''));
  return out;
}

// A path's alternatives: top-level "|", and a parenthesised union followed
// by more steps -- (/a/b | /a/c)/d/e → /a/b/d/e, /a/c/d/e.
export function pathAlternatives(path) {
  const out = [];
  for (const raw of splitWhere(path, unionBar)) {
    const alt = raw.trim();
    if (!alt) continue;
    if (alt.startsWith('(')) {
      const close = matchingClose(alt, 0);
      if (close === -1) continue;
      const inner = alt.slice(1, close);
      const rest = alt.slice(close + 1).trim();
      if (!rest) out.push(...pathAlternatives(inner));
      else if (rest.startsWith('/')) for (const a of pathAlternatives(inner)) out.push(...pathAlternatives(a + rest));
      else if (rest.startsWith('[')) out.push(...pathAlternatives(inner)); // a positional predicate on the group
      continue;
    }
    out.push(alt);
  }
  return out;
}

// [{ sep: null | '/' | '//', main, predicates: [text], kind, name, desc }]
export function pathSteps(alternative) {
  const text = alternative.trim();
  const steps = [];
  let current = '';
  let sep = null;
  let i = 0;
  const push = () => {
    steps.push(readStep(sep, current.trim()));
    current = '';
  };
  let quote = '';
  let depth = 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && ch === '/') {
      if (current.trim() || steps.length > 0) push();
      if (text[i + 1] === '/') {
        sep = '//';
        i += 1;
      } else sep = '/';
      continue;
    }
    current += ch;
  }
  if (current.trim()) push();
  return { absolute: text.startsWith('/'), steps };
}

function readStep(sep, raw) {
  let main = '';
  const predicates = [];
  let depth = 0;
  let quote = '';
  let pred = '';
  for (const ch of raw) {
    if (quote) {
      if (depth > 0) pred += ch;
      else main += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (depth > 0) pred += ch;
      else main += ch;
      continue;
    }
    if (ch === '[') {
      if (depth > 0) pred += ch;
      depth += 1;
      continue;
    }
    if (ch === ']') {
      depth -= 1;
      if (depth > 0) pred += ch;
      else {
        predicates.push(pred);
        pred = '';
      }
      continue;
    }
    if (depth > 0) pred += ch;
    else main += ch;
  }
  main = main.trim();
  let m;
  if (main === '.') return { sep, main, predicates, kind: 'self' };
  if ((m = CHILD_STEP_RE.exec(main))) return { sep, main, predicates, kind: 'element', name: m[1], desc: false };
  if ((m = DESC_STEP_RE.exec(main))) return { sep, main, predicates, kind: 'element', name: m[1], desc: true };
  if ((m = ATTR_STEP_RE.exec(main))) return { sep, main, predicates, kind: 'attribute', name: m[1] };
  return { sep, main, predicates, kind: 'other' };
}

// ─── The check ──────────────────────────────────────────────────────────────

// Problems of one alternative. `start`: the element a predicate path starts
// from (null for a rule's own path).
function checkAlternative(index, scope, alternative, { start = null, inPredicate = false, predicate = null } = {}) {
  const problems = [];
  const { absolute, steps } = pathSteps(alternative);
  let prev = start;
  let mainFailed = false;
  steps.forEach((step, i) => {
    if (mainFailed) return;
    if (step.kind === 'self') return; // "." keeps the current element (the predicate's start)
    if (step.kind === 'other') {
      prev = null;
      return;
    }
    if (step.kind === 'attribute') {
      const known = index.attributesAnywhere.has(step.name) && prev && existsIn(index, scope, prev);
      if (known && step.sep !== '//' && !attrOk(index, scope, prev, step.name)) {
        problems.push({ kind: 'attribute', element: prev, attribute: step.name, owners: ownersOf(index, scope, step.name), inPredicate, predicate });
        mainFailed = true;
      }
      prev = null;
      return;
    }
    // element
    const name = step.name;
    const inScope = existsIn(index, scope, name);
    if (i === 0 && absolute && step.sep === '/' && !inPredicate) {
      if (inScope && !isRoot(index, scope, name)) {
        problems.push({ kind: 'root', element: name, ways: waysFromRoot(index, scope, name), inPredicate, predicate });
        mainFailed = true;
      }
    } else if (prev && inScope && existsIn(index, scope, prev) && !index.uncheckedChildren.has(name)) {
      const desc = step.sep === '//' || step.desc;
      const ok = desc ? reachableOk(index, scope, prev, name) : childOk(index, scope, prev, name);
      if (!ok) {
        const problem = { kind: desc ? 'descendant' : 'child', element: name, parent: prev, parents: parentsOf(index, scope, name), inPredicate, predicate };
        if (!desc) problem.fix = removeStepsFix(steps, i, problem.parents);
        problems.push(problem);
        mainFailed = true;
        return;
      }
    }
    prev = inScope ? name : null;
    // simple child paths in the step's predicates
    if (inScope) {
      for (const pred of step.predicates) {
        for (const operand of pathOperands(pred)) {
          if (operand.startsWith('/')) continue; // anchored elsewhere: the name check covers it
          for (const alt of pathAlternatives(operand)) {
            problems.push(...checkAlternative(index, scope, alt, { start: name, inPredicate: true, predicate: pred.replace(/\s+/g, ' ').trim() }));
          }
        }
      }
    }
  });
  return problems;
}

// "Remove <perscat> from the path": the impossible child has ONE possible
// parent in the scope, and that parent is already earlier on the path,
// joined to it by plain child steps without predicates (perscat/trade after
// reqpers). Otherwise null -- several fixes, or none, give no button.
function removeStepsFix(steps, i, parents) {
  if (parents.length !== 1) return null;
  const parent = parents[0];
  for (let j = i - 1; j >= 0; j -= 1) {
    const s = steps[j];
    if (s.kind !== 'element') return null;
    if (s.name === parent) {
      if (s.predicates.length > 0) return null;
      const between = steps.slice(j + 1, i);
      if (between.length === 0) return null;
      if (steps.slice(j + 1, i + 1).some((x) => x.sep !== '/' || x.desc)) return null;
      if (between.some((x) => x.predicates.length > 0)) return null;
      const from = [parent, ...between.map((x) => x.name), steps[i].name].join('/');
      return { kind: 'remove_steps', from, to: `${parent}/${steps[i].name}`, removed: between.map((x) => x.name) };
    }
  }
  return null;
}

// checkRulePaths(ruleXml, format, graph, { schemaLocation, parseXml }) →
//   { available, problems, parts: [{ ruleId, path, flag, condition, alternatives, impossible }],
//     allImpossible }
// allImpossible: every node path of the rule (conditions aside) has only
// impossible alternatives -- the rule can never select anything, and the
// test says so before any LLM call.
export function checkRulePaths(ruleXml, format, graph, options = {}) {
  const index = graphIndex(graph);
  if (!index) return { available: false, problems: [], parts: [], allImpossible: false };
  const problems = [];
  const parts = [];
  for (const part of rulePathParts(ruleXml, format, options)) {
    const scope = scopeOf(index, part.schema);
    const operands = part.condition ? pathOperands(part.path) : [part.path];
    const alternatives = operands.flatMap((op) => pathAlternatives(op));
    let impossible = 0;
    for (const alternative of alternatives) {
      const found = checkAlternative(index, scope, alternative);
      if (found.some((p) => !p.inPredicate)) impossible += 1;
      for (const p of found) {
        const problem = {
          ...p,
          ruleId: part.ruleId,
          path: part.path,
          flag: part.flag,
          alternative: alternative.replace(/\s+/g, ' ').trim(),
          alternatives: alternatives.length,
          ...(p.kind === 'root' && !p.inPredicate && existsIn(index, scope, p.element)
            ? { fix: { kind: 'descendant_root', from: `/${p.element}`, to: `//${p.element}` } }
            : {}),
        };
        const same = problems.find((q) => samePathProblem(q, problem));
        if (same) same.inAlternatives.push(problem.alternative);
        else problems.push({ ...problem, inAlternatives: [problem.alternative] });
      }
    }
    // A problem every alternative shares (in the common continuation of
    // (/a | /b)/c/d) is said once, without naming an alternative.
    for (const p of problems) if (p.ruleId === part.ruleId && p.path === part.path && p.inAlternatives.length === alternatives.length) p.alternatives = 1;
    parts.push({ ruleId: part.ruleId, path: part.path, flag: part.flag, condition: part.condition, alternatives: alternatives.length, impossible });
  }
  const nodeParts = parts.filter((p) => !p.condition && p.alternatives > 0);
  const allImpossible = nodeParts.length > 0 && nodeParts.every((p) => p.impossible === p.alternatives);
  return { available: true, problems, parts, allImpossible };
}

function samePathProblem(a, b) {
  return a.kind === b.kind && a.element === b.element && a.parent === b.parent && a.attribute === b.attribute && a.ruleId === b.ruleId && a.path === b.path && a.inPredicate === b.inPredicate && a.predicate === b.predicate;
}

// ─── "any <figure>" instead of "its <figure>" (Mejoras D, Part 2) ──────────
//
// BRDP-EXT-02815 (3.0.1): //figure//legend/deflist/term[not(. =
// //figure//graphic//hotspot/@apsname)]. Inside the predicate, //figure is
// EVERY <figure> of the document, not the one that contains the <term>: in
// a document with two figures, a <term> that only matches a hotspot of the
// OTHER figure is accepted. The decision said "de su <figure>"
// (ancestor::figure). Warned when, inside a predicate of a step, an
// absolute path (/ or //) goes through an element X that is a step of the
// main path BEFORE that step (an ancestor of the checked node) and is not
// the document's root. BREX only (3.0.1 and 4.x); needs no schema graph.
// Never an error: it blocks nothing and changes no verdict.
// → [{ kind: 'anyAncestor', ancestor, looked, checked, operand, predicate,
//      ruleId, path, fix }]
// fix, only for the simple form -- the absolute path starts with //X (X
// with or without its own predicate): { kind: 'ancestor_axis', from:
// '//figure//graphic//hotspot/@apsname', to:
// 'ancestor::figure//graphic//hotspot/@apsname' }.
const DOCUMENT_ROOTS = new Set(['dmodule', 'pm', 'dml', 'ddn', 'comment', 'dataUpdateFile', 'scormContentPackage', 'icnMetadataFile', 'update']);
const BREX_FORMATS = new Set(['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']);

export function checkAncestorAbsolutePaths(ruleXml, format, options = {}) {
  if (!BREX_FORMATS.has(format)) return [];
  const out = [];
  for (const part of rulePathParts(ruleXml, format, options)) {
    const operands = part.condition ? pathOperands(part.path) : [part.path];
    for (const alternative of operands.flatMap((op) => pathAlternatives(op))) {
      const { absolute, steps } = pathSteps(alternative);
      steps.forEach((step, i) => {
        if (step.kind !== 'element' || step.predicates.length === 0) return;
        const before = steps.slice(0, i).filter((s) => s.kind === 'element');
        const rootName = absolute && steps[0]?.sep === '/' && steps[0].kind === 'element' ? steps[0].name : null;
        const ancestors = new Set(before.map((s) => s.name).filter((n) => n !== rootName && !DOCUMENT_ROOTS.has(n)));
        if (ancestors.size === 0) return;
        for (const pred of step.predicates) {
          for (const operand of pathOperands(pred)) {
            if (!operand.startsWith('/')) continue;
            for (const absPath of pathAlternatives(operand)) {
              const inner = pathSteps(absPath).steps;
              const through = inner.find((s) => s.kind === 'element' && ancestors.has(s.name) && s.name !== step.name);
              if (!through) continue;
              const elements = inner.filter((s) => s.kind === 'element');
              const looked = elements.length ? elements[elements.length - 1].name : through.name;
              const first = inner[0];
              const simple = first && first === through && first.sep === '//' && first.kind === 'element';
              const text = absPath.replace(/\s+/g, ' ').trim();
              const problem = {
                kind: 'anyAncestor',
                ancestor: through.name,
                looked,
                checked: step.name,
                operand: text,
                predicate: pred.replace(/\s+/g, ' ').trim(),
                ruleId: part.ruleId,
                path: part.path,
                fix: simple ? { kind: 'ancestor_axis', from: text, to: `ancestor::${text.slice(2)}` } : null,
              };
              if (!out.some((q) => q.ruleId === problem.ruleId && q.path === problem.path && q.operand === problem.operand && q.ancestor === problem.ancestor)) out.push(problem);
            }
          }
        }
      });
    }
  }
  return out;
}

export function formatAncestorProblem(p, t) {
  const key = p.looked === p.ancestor ? 'records.rulePath.anyAncestorSelf' : 'records.rulePath.anyAncestor';
  return t(key, { ancestor: p.ancestor, looked: p.looked, checked: p.checked });
}

// ─── Fixes (a button, never on their own) ───────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text of the rule with the fix applied inside its paths only
// (objectPath / objpath, Schematron @context) -- never in objectUse or a
// message. → { xml, changed }
export function applyRulePathFix(ruleXml, fix) {
  const text = String(ruleXml || '');
  if (!fix) return { xml: text, changed: false };
  let pattern;
  let replacement;
  if (fix.kind === 'descendant_root') {
    // /techstd not preceded by a name, "/", ":" or "*"; not followed by a name char
    pattern = new RegExp(`(?<![\\w./:*\\]\\-])${escapeRe(fix.from)}(?![\\w.:-])`, 'g');
    replacement = fix.to;
  } else if (fix.kind === 'remove_steps') {
    const names = fix.from.split('/');
    pattern = new RegExp(`(?<![\\w.:-])${names.map(escapeRe).join('\\s*/\\s*')}(?![\\w.:-])`, 'g');
    replacement = fix.to;
  } else if (fix.kind === 'ancestor_axis') {
    return applyAncestorAxisFix(text, fix);
  } else return { xml: text, changed: false };
  let changed = false;
  const rewrite = (inner) =>
    inner.replace(pattern, () => {
      changed = true;
      return replacement;
    });
  const out = text
    .replace(/(<(?:[\w.-]+:)?(objectPath|objpath)\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?\2\s*>)/g, (_m, open, _n, inner, close) => open + rewrite(inner) + close)
    .replace(/(<(?:[\w.-]+:)?rule\b[^>]*?\scontext\s*=\s*)("[^"]*"|'[^']*')/g, (_m, before, value) => before + value[0] + rewrite(value.slice(1, -1)) + value[0]);
  return { xml: out, changed };
}

// Mejoras D, Part 2.3: //X… → ancestor::X… inside the predicates of the
// rule's paths only (never the main path's own //X, never objectUse). The
// operand is matched with any whitespace and with <, >, & escaped or not.
function applyAncestorAxisFix(text, fix) {
  const pieces = fix.from.split('');
  const source = pieces
    .map((ch, i) => {
      if (i === 0) return escapeRe(ch);
      if (/\s/.test(ch)) return '\\s+';
      if (ch === '<') return '(?:<|&lt;)';
      if (ch === '>') return '(?:>|&gt;)';
      if (ch === '&') return '(?:&|&amp;)';
      if (ch === '/' || ch === '[' || ch === ']' || ch === '(' || ch === ')' || ch === '=') return `\\s*${escapeRe(ch)}\\s*`;
      return escapeRe(ch);
    })
    .join('');
  const pattern = new RegExp(`(?<![\\w.:/-])${source}(?![\\w.:-])`, 'g');
  let changed = false;
  const rewrite = (inner) => {
    // the bracket depth at each position, outside string literals
    const depth = [];
    let d = 0;
    let quote = '';
    for (let i = 0; i < inner.length; i += 1) {
      depth.push(d);
      const ch = inner[i];
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '[') d += 1;
      else if (ch === ']') d -= 1;
    }
    return inner.replace(pattern, (match, offset) => {
      if (!(depth[offset] > 0)) return match;
      changed = true;
      return `ancestor::${match.replace(/^\/\s*\/\s*/, '')}`; // the match starts at the operand's first "/"
    });
  };
  const out = text.replace(/(<(?:[\w.-]+:)?(objectPath|objpath)\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?\2\s*>)/g, (_m, open, _n, inner, close) => open + rewrite(inner) + close);
  return { xml: out, changed };
}

// ─── Text ───────────────────────────────────────────────────────────────────

const list = (names, t, mark) => {
  const shown = names.slice(0, MAX_LISTED).map(mark);
  const more = names.length - shown.length;
  if (more > 0) shown.push(t('records.rulePath.more', { count: more }));
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} ${t('records.rulePath.or')} ${shown[shown.length - 1]}`;
};

// One problem in the language of `t`.
export function formatPathProblem(p, t, { format = null } = {}) {
  const el = (n) => `<${n}>`;
  let detail;
  if (p.kind === 'root') {
    detail = p.ways?.length
      ? t('records.rulePath.root', { element: p.element, ways: p.ways.join(` ${t('records.rulePath.or')} `) })
      : t('records.rulePath.rootNoWay', { element: p.element });
  } else if (p.kind === 'attribute') {
    detail = t(p.owners?.length ? 'records.rulePath.attribute' : 'records.rulePath.attributeNoOwner', {
      element: p.element,
      attribute: p.attribute,
      owners: list(p.owners || [], t, el),
    });
  } else {
    detail = t(
      p.parents?.length
        ? p.kind === 'child' ? 'records.rulePath.child' : 'records.rulePath.descendant'
        : p.kind === 'child' ? 'records.rulePath.childNoParent' : 'records.rulePath.descendantNoParent',
      { element: p.element, parent: p.parent, parents: list(p.parents || [], t, el) }
    );
  }
  let text = p.inPredicate
    ? t('records.rulePath.inPredicate', { predicate: p.predicate, detail })
    : p.kind === 'root'
      ? detail
      : t('records.rulePath.cannotExist', { detail });
  if (p.alternatives > 1) text = t('records.rulePath.inAlternative', { alternative: p.alternative, text });
  if (p.flag === '1' && !p.inPredicate) {
    const attr = format === 'BREX-3.0.1' ? 'objappl' : 'allowedObjectFlag';
    text += ' ' + (p.kind === 'root' || !p.parent
      ? t('records.rulePath.flag1Root', { attr })
      : t('records.rulePath.flag1', { attr, parent: p.parent }));
  }
  return text;
}

export function formatPathFix(fix, t) {
  if (!fix) return '';
  if (fix.kind === 'ancestor_axis') return t('records.rulePath.fixAncestorAxis', { from: fix.from, to: fix.to });
  if (fix.kind === 'descendant_root') return t('records.rulePath.fixDescendantRoot', { from: fix.from, to: fix.to });
  return t('records.rulePath.fixRemoveSteps', { count: fix.removed.length, removed: fix.removed.map((n) => `<${n}>`).join(', ') });
}

// The names of every step a rule's paths use, NAME_RE-valid only -- for
// callers that want to know whether a graph is worth loading.
export function isPathName(name) {
  return NAME_RE.test(name);
}
