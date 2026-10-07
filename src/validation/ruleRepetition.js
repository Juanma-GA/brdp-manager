// Mejoras G, Part 1: how many times an element can appear, read from the
// schema (the content models' "max", generate_content_models.py), and what
// a rule's paths make of it.
//
//   ruleChildPairs        the parent/child pairs the rule names (its paths
//                         and its conditions) -- Part 1.4 says "at most one
//                         <evaluate> inside <applic>" for the pairs whose
//                         maximum is 1;
//   textFunctionWarnings  a text function (normalize-space, string, concat…)
//                         over a path that can give several nodes -- Part
//                         1.5: with more than one, XPath 2.0 stops with an
//                         error and XPath 1.0 looks only at the first;
//   repeatingComparisons  a condition that compares with such a path (with
//                         or without a function, or binds it in some/every/
//                         for) -- Part 1.6 asks for examples with several.
//
// "Can give several" (pathInfo): some step can repeat in its parent (its
// maximum there is above 1, or unbounded), or a // (descendant::) step's
// element can appear more than once in the document -- it cannot when it
// has a single possible parent, where it appears at most once, and so on up
// to the root (//dmaddres). An ancestor:: step repeats when the element can
// be inside itself. Never counted: [1], [last()] or any number on the step,
// ".", an attribute of the node itself, a $variable (some/every/for), and a
// step this reader does not follow (*, node(), another function) -- the
// conservative answer there is "no warning".
//
// Pure module. The schema is given as "views" (one per schema of the
// rule's scope): from the standard's graph (GET /api/schema-cards/graph,
// for the warnings) or from one schema's structure (the test's
// placements). A child the data gives no maximum for is unbounded.
import { rulePathParts } from '../utils/ruleTestEngine.js';
import { localName, parseXmlDocument } from '../utils/ruleTestCommon.js';
import { wrapRuleXmlFragment } from '../utils/ruleXmlFragment.js';
import {
  conditionalParts,
  graphIndex,
  graphNode,
  matchingClose,
  parentsMap,
  pathAlternatives,
  pathSteps,
  quantifiedParts,
  reachableSet,
  splitWhere,
} from './rulePathCheck.js';

export const TEXT_FUNCTIONS = new Set([
  'normalize-space',
  'string',
  'string-length',
  'concat',
  'contains',
  'starts-with',
  'ends-with',
  'substring',
  'substring-before',
  'substring-after',
  'translate',
  'matches',
  'replace',
  'tokenize',
  'upper-case',
  'lower-case',
  'number',
]);

const BREX_FORMATS = new Set(['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']);
const SCHEMATRON_FORMATS = new Set(['SCH-DITA']);
const POSITIONAL_RE = /^\s*(?:\d+|last\(\s*\))\s*$/;
const CALL_RE = /^((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)\s*\(/;
const QUANTIFIED_RE = /^(some|every|for|let)\s+\$/;

// ─── Views of the schema ────────────────────────────────────────────────────

// One view per schema of the scope: { roots, children(name) → Set | null,
// max(parent, child) → 0 (not a child) | n | Infinity, parents(name) → Set,
// reach(name) → Set of what can be below it }.
export function viewsFromGraph(graph, schemas = null) {
  const index = graphIndex(graph);
  if (!index) return [];
  const scope = (schemas || []).filter((s) => index.bySchema.has(s));
  return (scope.length ? scope : index.schemas).map((s) => ({
    roots: index.roots.get(s) || [],
    children: (name) => graphNode(index, s, name)?.children || null,
    max: (parent, child) => {
      const n = graphNode(index, s, parent);
      if (!n?.children.has(child)) return 0;
      const m = n.max?.get(child);
      return Number.isInteger(m) ? m : Infinity;
    },
    parents: (name) => parentsMap(index, s).get(name) || new Set(),
    reach: (name) => reachableSet(index, s, name),
  }));
}

export function viewFromStructure(structure) {
  const elements = structure?.elements || {};
  const models = structure?.models || {};
  const parentsOf = new Map();
  for (const [name, entry] of Object.entries(elements)) {
    for (const c of entry.children || []) {
      if (!parentsOf.has(c)) parentsOf.set(c, new Set());
      parentsOf.get(c).add(name);
    }
  }
  const reachCache = new Map();
  return {
    roots: structure?.skeleton?.root ? [structure.skeleton.root] : [],
    children: (name) => (elements[name] ? new Set(elements[name].children || []) : null),
    max: (parent, child) => {
      if (!(elements[parent]?.children || []).includes(child)) return 0;
      const m = models[parent]?.max?.[child];
      return Number.isInteger(m) ? m : Infinity;
    },
    parents: (name) => parentsOf.get(name) || new Set(),
    reach: (name) => {
      if (reachCache.has(name)) return reachCache.get(name);
      const seen = new Set();
      const frontier = [...(elements[name]?.children || [])];
      while (frontier.length) {
        const n = frontier.pop();
        if (seen.has(n)) continue;
        seen.add(n);
        for (const c of elements[n]?.children || []) if (!seen.has(c)) frontier.push(c);
      }
      reachCache.set(name, seen);
      return seen;
    },
  };
}

// The most <child> elements one <parent> can hold, over the views (0 when
// it is never its child, Infinity when unbounded).
export function maxChildren(views, parent, child) {
  return views.reduce((most, v) => Math.max(most, v.max(parent, child)), 0);
}

// Whether <child> can appear more than once in one parent (any parent when
// `parent` is unknown).
function mayRepeatChild(views, parent, child) {
  if (parent) return views.some((v) => v.max(parent, child) > 1);
  return views.some((v) => [...v.parents(child)].some((p) => v.max(p, child) > 1));
}

function inDocument(view) {
  const out = new Set(view.roots);
  for (const r of view.roots) for (const n of view.reach(r)) out.add(n);
  return out;
}

// <name> appears at most once in any document of the view: the root, or a
// single possible parent where it appears at most once, itself at most once.
function onceIn(view, name, docSet, seen) {
  if (view.roots.includes(name)) return true;
  if (!docSet.has(name)) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const parents = [...view.parents(name)].filter((p) => docSet.has(p));
  if (parents.length !== 1) return false;
  if (view.max(parents[0], name) !== 1) return false;
  return onceIn(view, parents[0], docSet, seen);
}

export function occursAtMostOnce(views, name) {
  return views.every((v) => onceIn(v, name, inDocument(v), new Set()));
}

// ─── Reading the expressions ────────────────────────────────────────────────

// The rule's expressions with the element each one is read from:
// [{ ruleId, expression, context, schema }]. BREX: each part's path (read
// from the document). Schematron: each rule's context, and its assert /
// report tests and let values, read from the context's element.
export function ruleExpressions(ruleXml, format, options = {}) {
  if (BREX_FORMATS.has(format)) {
    return rulePathParts(ruleXml, format, options).map((p) => ({ ruleId: p.ruleId, expression: p.path, context: null, schema: p.schema || null }));
  }
  if (!SCHEMATRON_FORMATS.has(format)) return [];
  const parseXml = options.parseXml || parseXmlDocument;
  let doc;
  try {
    doc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return [];
  }
  const out = [];
  const walk = (el, pattern) => {
    const name = localName(el);
    const ruleId = name === 'pattern' ? el.getAttribute('id') || pattern : pattern;
    if (name === 'rule' && el.getAttribute('context')) {
      const context = el.getAttribute('context');
      out.push({ ruleId, expression: context, context: null, schema: null });
      const last = lastElementOf(context);
      const inner = (n) => {
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          const ln = localName(c);
          if ((ln === 'assert' || ln === 'report') && c.getAttribute('test')) out.push({ ruleId, expression: c.getAttribute('test'), context: last, schema: null });
          if (ln === 'let' && c.getAttribute('value')) out.push({ ruleId, expression: c.getAttribute('value'), context: last, schema: null });
          inner(c);
        }
      };
      inner(el);
      return;
    }
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) walk(c, ruleId);
  };
  walk(doc.documentElement, null);
  return out;
}

// The element a single path ends on, or null.
function lastElementOf(path) {
  const alternatives = pathAlternatives(String(path || ''));
  if (alternatives.length !== 1) return null;
  const { steps } = pathSteps(alternatives[0]);
  const last = steps[steps.length - 1];
  return last && (last.kind === 'element' || last.kind === 'axis') ? last.name : null;
}

function unwrap(text) {
  let e = String(text || '').trim();
  while (e.startsWith('(') && matchingClose(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
}

const andOr = (text, i) => {
  const m = /^\s(?:and|or)\s/.exec(text.slice(i));
  return m && i > 0 ? m[0].length : 0;
};
const comparisonOp = (text, i) => {
  const m = /^(?:!=|<=|>=|=|<|>|\s(?:eq|ne|lt|le|gt|ge)\s)/.exec(text.slice(i));
  return m ? m[0].length : 0;
};
const comma = (t, i) => (t[i] === ',' ? 1 : 0);

// A function call that is the whole expression: { name (no prefix), args }.
function wholeCall(e) {
  const m = CALL_RE.exec(e);
  if (!m || /^(?:node|text|comment)$/.test(m[1])) return null;
  const open = e.indexOf('(');
  if (matchingClose(e, open) !== e.length - 1) return null;
  const inner = e.slice(open + 1, -1);
  return { name: m[1].replace(/^fn:/, ''), args: inner.trim() ? splitWhere(inner, comma).map((a) => a.trim()) : [] };
}

// How many nodes a path can give, read from <context>:
// { path: true, several, repeating (the last element that can repeat),
//   node ('<p>' | '@issno', what the path gives) } -- { path: false } for
// something that is not a location path.
export function pathInfo(text, context, views) {
  const e = unwrap(text);
  if (!e || /^['"\d$]/.test(e) || e === '.') return { path: false };
  if (/^\(.*\)\s*\[\s*(?:\d+|last\(\s*\))\s*\]$/s.test(e)) return { path: true, several: false, repeating: null, node: null };
  if (wholeCall(e) || QUANTIFIED_RE.test(e) || /^if\s*\(/.test(e)) return { path: false };
  const alternatives = pathAlternatives(e);
  if (alternatives.length === 0) return { path: false };
  let several = alternatives.length > 1;
  let repeating = null;
  let repeatingParent = null;
  let node = null;
  for (const alt of alternatives) {
    const { absolute, steps } = pathSteps(alt);
    let cur = absolute ? null : context;
    let known = true;
    steps.forEach((step, i) => {
      if (!known) return;
      const positional = step.predicates.some((p) => POSITIONAL_RE.test(p));
      if (step.kind === 'self') {
        node = cur ? `<${cur}>` : node;
        return;
      }
      if (step.kind === 'attribute') {
        if (step.sep === '//') several = true;
        node = `@${step.name}`;
        return;
      }
      if (step.kind === 'axis') {
        let rep = false;
        if (step.axis === 'ancestor' || step.axis === 'ancestor-or-self') rep = views.some((v) => v.reach(step.name).has(step.name));
        else if (step.axis !== 'parent' && step.axis !== 'self') rep = true;
        if (rep && !positional) {
          several = true;
          repeating = step.name;
          repeatingParent = null;
        }
        cur = step.name;
        node = `<${step.name}>`;
        return;
      }
      if (step.kind === 'element') {
        let rep;
        if (i === 0 && absolute && step.sep === '/') rep = false;
        else if (step.sep === '//' || step.desc) rep = !occursAtMostOnce(views, step.name);
        else rep = mayRepeatChild(views, cur, step.name);
        if (rep && !positional) {
          several = true;
          repeating = step.name;
          // a child step repeats inside its parent; a // step anywhere
          repeatingParent = step.sep === '//' || step.desc ? null : cur;
        }
        cur = step.name;
        node = `<${step.name}>`;
        return;
      }
      // *, node(), text(), a function step: not followed
      if (/^text\(\s*\)$/.test(step.main)) return;
      known = false;
    });
    if (!known) return { path: true, several: false, repeating: null, node: null };
  }
  return { path: true, several, repeating, repeatingParent, node };
}

// Walks an expression read from <context>: calls onText(fn, arg, info) for
// a text function over a path, onCompare(side, info) for each side of a
// comparison and for the bindings of some/every/for, and visits the
// predicates of every path with their step's element.
function visit(expression, context, views, hooks, inQuantified = false) {
  const e = unwrap(expression);
  if (!e) return;
  const words = splitWhere(e, andOr);
  if (words.length > 1) return words.forEach((w) => visit(w, context, views, hooks, inQuantified));
  const sides = splitWhere(e, comparisonOp);
  if (sides.length > 1) {
    for (const side of sides) {
      const s = unwrap(side);
      const call = wholeCall(s);
      const target = call && TEXT_FUNCTIONS.has(call.name) && call.args.length > 0 ? call.args[0] : s;
      const info = pathInfo(target, context, views);
      if (info.path && info.several) hooks.onCompare?.(target, info);
    }
    return sides.forEach((s) => visit(s, context, views, hooks, inQuantified));
  }
  if (QUANTIFIED_RE.test(e)) {
    for (const part of quantifiedParts(e)) {
      const info = pathInfo(part, context, views);
      if (info.path && info.several) hooks.onCompare?.(part, info);
      visit(part, context, views, hooks, true);
    }
    return;
  }
  if (/^if\s*\(/.test(e)) return conditionalParts(e).forEach((p) => visit(p, context, views, hooks, inQuantified));
  const call = wholeCall(e);
  if (call) {
    if (TEXT_FUNCTIONS.has(call.name) && !inQuantified) {
      for (const arg of call.args) {
        const info = pathInfo(arg, context, views);
        if (info.path && info.several) hooks.onText?.(call.name, arg, info);
      }
    }
    return call.args.forEach((a) => visit(a, context, views, hooks, inQuantified));
  }
  if (/^['"\d$]/.test(e) || e === '.') return;
  for (const alt of pathAlternatives(e)) {
    const { absolute, steps } = pathSteps(alt);
    let cur = absolute ? null : context;
    for (const step of steps) {
      if (step.kind === 'element' || step.kind === 'axis') cur = step.name;
      else if (step.kind !== 'self' && step.kind !== 'attribute') cur = null;
      hooks.onStep?.(step, cur);
      for (const pred of step.predicates) {
        if (POSITIONAL_RE.test(pred)) continue;
        visit(pred, cur, views, hooks, inQuantified);
      }
    }
  }
}

// ─── Part 1.5: text functions over paths that can give several nodes ──────

// [{ ruleId, fn, argument, node, repeating }] -- one per function and
// argument.
export function textFunctionWarnings(ruleXml, format, graph, options = {}) {
  const out = [];
  for (const item of ruleExpressions(ruleXml, format, options)) {
    const views = viewsFromGraph(graph, item.schema ? [item.schema] : null);
    if (views.length === 0) return [];
    visit(item.expression, item.context, views, {
      onText: (fn, argument, info) => {
        const arg = argument.replace(/\s+/g, ' ').trim();
        if (!out.some((w) => w.fn === fn && w.argument === arg)) {
          out.push({ ruleId: item.ruleId, fn, argument: arg, node: info.node, repeating: info.repeating });
        }
      },
    });
  }
  return out;
}

// The warning in the language of `t` (records.ruleTest.repetition.*).
export function formatTextFunctionWarning(w, t) {
  const name = w.repeating || (w.node || '').replace(/^[<@]|>$/g, '') || 'x';
  return t('records.ruleTest.repetition.textFunction', {
    fn: w.fn,
    argument: w.argument,
    element: w.repeating ? `<${w.repeating}>` : w.node || w.argument,
    var: name.charAt(0).toLowerCase(),
  });
}

// ─── Part 1.6: comparisons with such paths ─────────────────────────────────

// [{ path, element, parent }] -- the element that can repeat (and the
// parent it repeats in, for a child step), once per element.
export function repeatingComparisons(ruleXml, format, views, options = {}) {
  if (!views || views.length === 0) return [];
  const out = [];
  for (const item of ruleExpressions(ruleXml, format, options)) {
    visit(item.expression, item.context, views, {
      onCompare: (path, info) => {
        const element = info.repeating || (info.node?.startsWith('<') ? info.node.slice(1, -1) : null);
        if (element && !out.some((r) => r.element === element)) out.push({ path: path.replace(/\s+/g, ' ').trim(), element, parent: info.repeatingParent || null });
      },
    });
  }
  return out;
}

// Whether a document carries two or more <element>: inside one <parent>
// when the element repeats there (a child step -- two <p> in one
// <displaytext>), else anywhere in the document (a // step: two <refdm>).
export function documentCarriesSeveral(doc, element, parent = null) {
  if (!doc?.documentElement) return false;
  const all = doc.getElementsByTagName(element);
  if (all.length < 2) return false;
  if (!parent) return true;
  const byParent = new Map();
  for (let i = 0; i < all.length; i += 1) {
    const p = all[i].parentNode;
    if (p?.nodeName !== parent) continue;
    byParent.set(p, (byParent.get(p) || 0) + 1);
  }
  return [...byParent.values()].some((n) => n >= 2);
}

// ─── Part 1.4: parent/child pairs the rule names ───────────────────────────

// [{ parent, child }] -- a / step (or a predicate's first step, read from
// its element), in the order they appear.
export function ruleChildPairs(ruleXml, format, options = {}) {
  const out = [];
  for (const item of ruleExpressions(ruleXml, format, options)) {
    const add = (parent, child) => {
      if (parent && child && !out.some((p) => p.parent === parent && p.child === child)) out.push({ parent, child });
    };
    const walkPath = (expression, context) => {
      const e = unwrap(expression);
      if (!e) return;
      for (const part of splitWhere(e, andOr)) {
        for (const side of splitWhere(unwrap(part), comparisonOp)) {
          const s = unwrap(side);
          if (QUANTIFIED_RE.test(s)) {
            quantifiedParts(s).forEach((p) => walkPath(p, context));
            continue;
          }
          const call = wholeCall(s);
          if (call) {
            call.args.forEach((a) => walkPath(a, context));
            continue;
          }
          if (/^['"\d$]/.test(s) || s === '.' || /^if\s*\(/.test(s)) continue;
          for (const alt of pathAlternatives(s)) {
            const { absolute, steps } = pathSteps(alt);
            let cur = absolute ? null : context;
            steps.forEach((step, i) => {
              if (step.kind === 'element') {
                const child = !(i === 0 && absolute) && step.sep !== '//' && !step.desc;
                if (child) add(cur, step.name);
                cur = step.name;
              } else if (step.kind === 'axis') cur = step.name;
              else if (step.kind !== 'self' && step.kind !== 'attribute') cur = null;
              for (const pred of step.predicates) if (!POSITIONAL_RE.test(pred)) walkPath(pred, cur);
            });
          }
        }
      }
    };
    walkPath(item.expression, item.context);
  }
  return out;
}

// The pairs with a maximum of 1 in the views: [{ parent, child }].
export function singleChildPairs(ruleXml, format, views, options = {}) {
  if (!views || views.length === 0) return [];
  return ruleChildPairs(ruleXml, format, options).filter((p) => maxChildren(views, p.parent, p.child) === 1);
}

// Part 1.6, in the panel: the requested elements (several, from
// repeatingComparisons) that no executed example carries two or more of --
// "No example has more than one <p>: the test does not cover that case."
// An example counts when the rule ran on it (its run has a result).
export function severalUncovered(several, examples, runs, parseXml = parseXmlDocument) {
  if (!several || several.length === 0) return [];
  const docs = [];
  (examples || []).forEach((ex, i) => {
    const result = runs?.[i]?.result;
    if (!result || (result.status !== 'accepted' && result.status !== 'rejected')) return;
    try {
      docs.push(parseXml(String(ex.xml || '')));
    } catch {
      // not readable: does not count
    }
  });
  return several.filter((s) => !docs.some((doc) => documentCarriesSeveral(doc, s.element, s.parent))).map((s) => s.element);
}

// ─── Mejoras G, Part 2.1: what a "*[@a]" step reaches ──────────────────────
// A rule whose checked step is * with an attribute condition (*[@a],
// *[@a='v'], one "and" operand among others) reaches every element that can
// go there -- a child of the step before (a descendant with //), any
// element of the document without one -- and has that attribute.
// BRDP-EXT-02656 //reqconds/reqcblst//*[@checksum] reaches <cb>, <cblst>
// and <cbsublst>; the Proposal named only <cb> and <cbsublst>.
// → [{ ruleId, path, attribute, elements: [names, sorted] }] (BREX only;
// DITA has a single merged schema whose reach says little).
export const REACH_LISTED = 8;
const ATTR_OPERAND_RE = /^(?:@|attribute::)([A-Za-z_][\w.-]*)(?:\s*(?:=|!=|eq|ne)\s*(?:'[^']*'|"[^"]*"))?$/;

export function starReach(ruleXml, format, graph, options = {}) {
  if (!BREX_FORMATS.has(format)) return [];
  const index = graphIndex(graph);
  if (!index) return [];
  const out = [];
  for (const part of rulePathParts(ruleXml, format, options)) {
    if (part.condition) continue;
    const scope = part.schema && index.bySchema.has(part.schema) ? [part.schema] : index.schemas;
    for (const alt of pathAlternatives(part.path)) {
      const { steps } = pathSteps(alt);
      const last = steps[steps.length - 1];
      if (!last || !(last.main === '*' || last.main === 'child::*' || last.main === 'descendant::*')) continue;
      const operands = last.predicates.flatMap((p) => splitWhere(unwrap(p), (t, i) => {
        const m = /^\s+and\s+/.exec(t.slice(i));
        return m && i > 0 ? m[0].length : 0;
      }).map((o) => unwrap(o)));
      const attribute = operands.map((o) => ATTR_OPERAND_RE.exec(o.replace(/\s+/g, ' ').trim())).find(Boolean)?.[1];
      if (!attribute) continue;
      const before = steps[steps.length - 2];
      const descendant = last.sep === '//' || last.main === 'descendant::*';
      const names = new Set();
      for (const s of scope) {
        let candidates;
        if (before?.kind === 'element') {
          candidates = descendant ? reachableSet(index, s, before.name) : graphNode(index, s, before.name)?.children || new Set();
        } else if (!before) {
          // //*[@a] or /*[@a]: every element of the documents (the roots for /*)
          const roots = index.roots.get(s) || [];
          candidates = descendant ? new Set([...roots, ...roots.flatMap((r) => [...reachableSet(index, s, r)])]) : new Set(roots);
        } else {
          candidates = null;
        }
        if (!candidates) continue;
        for (const c of candidates) if (graphNode(index, s, c)?.attrs.has(attribute)) names.add(c);
      }
      if (names.size === 0) continue;
      out.push({ ruleId: part.ruleId, path: part.path, attribute, elements: [...names].sort() });
    }
  }
  return out;
}

// The marked element names of a text (<x>, </x>, <x attr>).
function markedElements(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/<\/?([A-Za-z_][\w.-]*)\b/g)) out.add(m[1]);
  return out;
}

// The reached elements a Proposal that names marked elements does not
// mention -- only for lists of REACH_LISTED or fewer.
export function reachBeyondProposal(reach, proposal) {
  const named = markedElements(proposal);
  if (named.size === 0) return [];
  const out = [];
  for (const r of reach || []) {
    if (r.elements.length > REACH_LISTED) continue;
    for (const e of r.elements) if (!named.has(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

// "<cb>, <cblst> and <cbsublst>" in the interface language.
export function listElementNames(names, language) {
  return new Intl.ListFormat(language, { type: 'conjunction' }).format(names.map((n) => `<${n}>`));
}
