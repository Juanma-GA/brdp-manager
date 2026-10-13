// Test de reglas: condiciones sobre la sección de identificación del propio
// documento. A rule can apply only to documents whose OWN identification
// and status section has some value -- BRDP-EXT-00134 of the default S1000D
// 4.2 BREX:
//   //expression[ancestor::dmodule[descendant::commonRepository and
//     descendant::identAndStatusSection[child::dmAddress[child::dmIdent[
//     child::dmCode[attribute::infoCode="0A2"]]]]] and not(ancestor::referencedApplicGroup)]
// The examples kept the minimal section's infoCode="040", so the rule
// selected nothing in any of them and the test was always "inconclusive".
// Here: the value conditions on the section that such a rule's predicates
// make (ancestors' predicates included), resolved on the minimal section of
// the example schema; the minimal section with those values set; and the
// same values set in a section the LLM wrote, or the minimal one written by
// the application when the example brings none.
//
// What counts (generic, nothing by identifier): an equality of an attribute
// (@a = "v", attribute::a = 'v') -- or, 3.0.1, of an element's text
// (avee[incode = "0A2"]) -- in a predicate, on a path anchored at the
// document (an absolute path, the rule's own path, an ancestor:: step) that
// goes into the identification section: its element (identAndStatusSection,
// idstatus, …) or a name only that section has (dmIdent, dmc…), and that
// selects exactly ONE node of the minimal section. A negated value
// (not(@infoCode = "0A2")) and a value under an "or" are never set; nor a
// value on the node the rule itself checks (//dmIdent/dmCode[@infoCode =
// "0A2"] is the decision, not a condition for it to apply).
import { pathAlternatives, pathSteps } from '../validation/rulePathCheck.js';
import { extractRuleXPaths } from '../validation/schemaValidation.js';

// The identification and status section elements the application knows.
export const SECTION_ELEMENTS = ['identAndStatusSection', 'idstatus', 'updateIdentAndStatusSection', 'imfIdentAndStatusSection', 'cstatus'];

// ─── Reading the rule ───────────────────────────────────────────────────────

// Walks text at quote/bracket/parenthesis depth 0; `test(text, i)` gives the
// length of an operator there (0 when none). Returns the parts and the
// operators between them.
function splitTop(text, test) {
  const parts = [];
  const ops = [];
  let depth = 0;
  let quote = '';
  let start = 0;
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
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (depth !== 0) continue;
    const len = test(text, i);
    if (len > 0) {
      parts.push(text.slice(start, i));
      ops.push(text.slice(i, i + len).trim());
      start = i + len;
      i = start - 1;
    }
  }
  parts.push(text.slice(start));
  return { parts, ops };
}
const word = (w) => (text, i) => {
  const m = new RegExp(`^\\s${w}\\s`).exec(text.slice(i));
  return m && i > 0 ? m[0].length : 0;
};
const comparisonOp = (text, i) => {
  const m = /^(?:!=|<=|>=|=|<|>|\s(?:eq|ne|lt|le|gt|ge)\s)/.exec(text.slice(i));
  return m ? m[0].length : 0;
};
function closingOf(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
const LITERAL_RE = /^(?:"([^"]*)"|'([^']*)')$/;
const NUMBER_RE = /^\d+(?:\.\d+)?$/;
function literalValue(side) {
  const s = side.trim();
  const m = LITERAL_RE.exec(s);
  if (m) return m[1] !== undefined ? m[1] : m[2];
  return NUMBER_RE.test(s) ? s : null;
}

// One location path in a context ({ chain, attribute } -- chain: the steps
// from the document, [{ axis: 'child'|'descendant', name }], or null when
// the path cannot be followed from the document). Records the value
// conditions it makes (value: the equality's literal, else null) and, for
// the rule's own paths (main), the node they check.
function walkPath(text, ctx, state, { value = null, main = false } = {}) {
  const alternatives = pathAlternatives(text);
  const inOr = state.inOr || alternatives.length > 1;
  for (const alternative of alternatives) {
    const { absolute, steps } = pathSteps(alternative);
    let chain = absolute ? [] : ctx.chain ? [...ctx.chain] : null;
    let attribute = absolute ? null : ctx.attribute || null;
    steps.forEach((step, i) => {
      const axis = step.sep === '//' || step.desc ? 'descendant' : 'child';
      if (step.kind === 'self') {
        // "." keeps the node
      } else if (step.kind === 'element') {
        if (chain && !attribute) chain.push({ axis, name: step.name });
        else chain = null;
      } else if (step.kind === 'attribute') {
        if (chain && !attribute && i === steps.length - 1) attribute = step.name;
        else chain = null;
      } else if (step.kind === 'axis' && (step.axis === 'ancestor' || step.axis === 'ancestor-or-self')) {
        // An ancestor of the node (the document's root, the section): any
        // element of that name from the document.
        chain = [{ axis: 'descendant', name: step.name }];
        attribute = null;
      } else if (step.kind === 'axis' && step.axis === 'self') {
        if (chain && chain.length && chain[chain.length - 1].name !== step.name) chain = null;
      } else if (step.kind === 'other' && step.main === '*') {
        if (chain && !attribute) chain.push({ axis, name: '*' });
        else chain = null;
      } else {
        chain = null;
      }
      for (const predicate of step.predicates || []) {
        walkExpression(predicate, { chain: chain ? [...chain] : null, attribute }, { ...state, inOr, inPredicate: true });
      }
    });
    // Only in a predicate: a comparison at the top of a true/false condition
    // (//dmStatus/@issueType = "changed" and …) is the rule's own test.
    if (value !== null && chain && state.inPredicate) state.out.conditions.push({ chain, attribute, value, negated: state.negated, inOr });
    if (main && value === null) state.out.mains.push({ chain, attribute });
  }
}

function walkExpression(raw, ctx, state, main = false) {
  let e = String(raw || '').trim();
  let negated = state.negated;
  for (;;) {
    if (e.startsWith('(') && closingOf(e, 0) === e.length - 1) {
      e = e.slice(1, -1).trim();
      continue;
    }
    const w = /^(not|boolean)\s*\(/.exec(e);
    if (w && closingOf(e, w[0].length - 1) === e.length - 1) {
      if (w[1] === 'not') negated = !negated;
      e = e.slice(w[0].length, -1).trim();
      continue;
    }
    break;
  }
  if (!e) return;
  const next = { ...state, negated };
  const ors = splitTop(e, word('or'));
  if (ors.parts.length > 1) return ors.parts.forEach((part) => walkExpression(part, ctx, { ...next, inOr: true }, main));
  const ands = splitTop(e, word('and'));
  if (ands.parts.length > 1) return ands.parts.forEach((part) => walkExpression(part, ctx, next, main));
  const cmp = splitTop(e, comparisonOp);
  if (cmp.parts.length === 2) {
    const [left, right] = cmp.parts;
    const op = cmp.ops[0];
    const equal = op === '=' || op === 'eq';
    const lv = literalValue(left);
    const rv = literalValue(right);
    if (equal && rv !== null && lv === null) return walkPath(left, ctx, next, { value: rv });
    if (equal && lv !== null && rv === null) return walkPath(right, ctx, next, { value: lv });
    // Another comparison: only the predicates of its paths are read.
    for (const side of [left, right]) if (literalValue(side) === null) walkPath(side, ctx, next);
    return;
  }
  walkPath(e, ctx, next, { main });
}

// Every value condition of the rule's paths (objectPath/objpath of a BREX
// rule): { conditions: [{ chain, attribute, value, negated, inOr }], mains:
// [{ chain, attribute }] }.
export function ownSectionConditions(ruleXml) {
  const out = { conditions: [], mains: [] };
  for (const expression of extractRuleXPaths(ruleXml || '')) {
    walkExpression(expression.replace(/\s+/g, ' '), { chain: [], attribute: null }, { negated: false, inOr: false, inPredicate: false, out }, true);
  }
  return out;
}

// ─── Resolving on the minimal section ───────────────────────────────────────

// The minimal section as a document: #doc > root > section. Each node keeps
// its parent and its position among siblings of the same name.
function wrapTree(root, tree) {
  const wrap = (node, parent, index) => {
    const w = { name: node.name, node, parent, index, children: [] };
    const seen = {};
    for (const child of node.children || []) {
      seen[child.name] = (seen[child.name] || 0) + 1;
      w.children.push(wrap(child, w, seen[child.name]));
    }
    return w;
  };
  const doc = { name: '#doc', node: null, parent: null, index: 1, children: [] };
  const rootNode = { name: root, node: null, parent: doc, index: 1, children: [] };
  doc.children.push(rootNode);
  rootNode.children.push(wrap(tree, rootNode, 1));
  return doc;
}
function descendants(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}
function resolveChain(doc, chain) {
  let nodes = [doc];
  for (const step of chain) {
    const next = new Set();
    for (const n of nodes) {
      const pool = step.axis === 'descendant' ? descendants(n) : n.children;
      for (const c of pool) if (step.name === '*' || c.name === step.name) next.add(c);
    }
    nodes = [...next];
    if (nodes.length === 0) break;
  }
  return nodes;
}
const isWithin = (node, ancestor) => {
  for (let n = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
};
// [{ name, index }] from the section element down to the node.
function sectionPathOf(node) {
  const out = [];
  for (let n = node; n && n.node; n = n.parent) out.unshift({ name: n.name, index: n.index });
  return out;
}

// The names only the identification section of this schema has (from the
// structure's element graph), plus the section element itself.
function sectionOnlyNames(structure, sectionElement) {
  const elements = structure?.elements || {};
  const root = structure?.skeleton?.path?.[0];
  const names = new Set(sectionElement ? [sectionElement] : []);
  if (!root || !sectionElement || !elements[root]) return names;
  const reach = (starts) => {
    const seen = new Set();
    const stack = [...starts];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n) || !elements[n]) continue;
      seen.add(n);
      stack.push(...(elements[n].children || []));
    }
    return seen;
  };
  const inSection = reach([sectionElement]);
  const rest = reach((elements[root].children || []).filter((c) => c !== sectionElement));
  for (const n of inSection) if (!rest.has(n)) names.add(n);
  return names;
}
// The section element of a schema whose section the application does not
// build: the root's child with a known section name.
function unbuiltSectionElement(structure) {
  const elements = structure?.elements || {};
  const root = structure?.skeleton?.path?.[0];
  return SECTION_ELEMENTS.find((n) => (elements[root]?.children || []).includes(n)) || null;
}

// What the rule's own-section conditions mean for one example schema:
// { values: [{ path: [{name, index}], attribute, value, element }],
//   unavailable: [{ attribute, value, element }] }. values: one per node and
// attribute (text: attribute null), each to set in the section; unavailable:
// the ones that go into the section but cannot be set (no node of the
// minimal section, or a schema whose section the application does not
// build) -- Part 2, "not executable".
export function resolveOwnSectionValues(conditions, structure, metadata) {
  const values = [];
  const unavailable = [];
  if (!conditions?.conditions?.length) return { values, unavailable };
  const sectionElement = metadata?.element || unbuiltSectionElement(structure);
  if (!sectionElement) return { values, unavailable };
  const only = sectionOnlyNames(structure, sectionElement);
  const root = structure?.skeleton?.path?.[0];
  const doc = metadata?.tree && root ? wrapTree(root, metadata.tree) : null;
  const checkedNodes = doc
    ? conditions.mains.filter((m) => m.chain).flatMap((m) => resolveChain(doc, m.chain).map((node) => ({ node, attribute: m.attribute })))
    : [];
  const seen = new Set();
  for (const c of conditions.conditions) {
    if (c.negated || c.inOr) continue;
    if (!c.chain.some((step) => only.has(step.name))) continue;
    const element = c.chain[c.chain.length - 1].name;
    if (!doc) {
      unavailable.push({ attribute: c.attribute, value: c.value, element });
      continue;
    }
    const matches = resolveChain(doc, c.chain);
    if (matches.length === 0) {
      unavailable.push({ attribute: c.attribute, value: c.value, element });
      continue;
    }
    if (matches.length > 1) continue;
    const [node] = matches;
    // The decision itself (the node the rule checks, or one inside it), not
    // a condition for it to apply.
    // Only a checked node of the section itself: when the rule checks the
    // root (//dmodule[…]), the whole document is below it.
    const decision = checkedNodes.some(({ node: checked, attribute }) => {
      if (!checked.node || !isWithin(node, checked)) return false;
      return !(node === checked && attribute && c.attribute && attribute !== c.attribute);
    });
    if (decision) continue;
    if (node === doc || !node.node) continue;
    // A text condition only on an element without children (3.0.1 <incode>).
    if (!c.attribute && node.children.length > 0) continue;
    const key = `${sectionPathOf(node).map((s) => `${s.name}[${s.index}]`).join('/')}@${c.attribute || '#text'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The minimal section's own value there (infoCode="040"): an example
    // meant to be accepted that kept it did not choose another one.
    const original = c.attribute ? (node.node.attributes || []).find(([n]) => n === c.attribute)?.[1] ?? null : node.node.text ?? null;
    values.push({ path: sectionPathOf(node), attribute: c.attribute, value: c.value, element: node.name, original });
  }
  return { values, unavailable };
}

// The minimal section tree with the values set (a copy).
export function sectionTreeWithValues(tree, values) {
  const copy = JSON.parse(JSON.stringify(tree));
  for (const v of values || []) {
    let node = copy;
    if (node.name !== v.path[0]?.name) continue;
    for (const step of v.path.slice(1)) {
      const same = (node.children || []).filter((c) => c.name === step.name);
      node = same[step.index - 1];
      if (!node) break;
    }
    if (!node) continue;
    if (v.attribute) {
      const attrs = node.attributes || (node.attributes = []);
      const at = attrs.findIndex(([n]) => n === v.attribute);
      if (at >= 0) attrs[at] = [v.attribute, v.value];
      else attrs.push([v.attribute, v.value]);
    } else {
      node.text = v.value;
    }
  }
  return copy;
}

// How a value reads: @infoCode="0A2" on <dmCode>, or <incode>0A2</incode>.
export function sectionValueText(v) {
  return v.attribute ? `@${v.attribute}="${v.value}" on <${v.element}>` : `<${v.element}>${v.value}</${v.element}>`;
}

// ─── Setting the values in a written section ────────────────────────────────

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The element at `names` (each level: the index-th child of that name) in
// `text`: { start, openEnd, attrs, selfClosing, closeStart, end }, or null.
function locate(text, names) {
  const stack = [];
  const counts = [new Map()];
  let found = null;
  for (const m of text.matchAll(TAG_RE)) {
    if (m[2] === undefined) continue;
    const name = m[2];
    if (m[1]) {
      if (stack.length && stack[stack.length - 1].name === name) {
        const top = stack.pop();
        counts.pop();
        if (found && found.depth === stack.length && found.closeStart === null && top === found.frame) {
          found.closeStart = m.index;
          found.end = m.index + m[0].length;
          return found;
        }
      }
      continue;
    }
    const level = stack.length;
    const map = counts[level];
    map.set(name, (map.get(name) || 0) + 1);
    const frame = { name, index: map.get(name) };
    const matches =
      !found &&
      level === names.length - 1 &&
      [...stack, frame].every((f, i) => f.name === names[i].name && f.index === names[i].index);
    if (matches) {
      found = { start: m.index, openEnd: m.index + m[0].length, attrs: m[3] || '', selfClosing: !!m[4], depth: level, frame, closeStart: null, end: null };
      if (m[4]) {
        found.closeStart = found.openEnd;
        found.end = found.openEnd;
        return found;
      }
    }
    if (!m[4]) {
      stack.push(frame);
      counts.push(new Map());
    }
  }
  return null;
}
const ATTR_RE = /([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;

// Sets the values in `text` (a written section or a whole document, its
// element names from `prefix`): always when `force`, else only where the
// attribute (or the text) is missing or still has the minimal section's
// value (v.original). { text, set: [value], missing: [value] }
// -- missing: a value whose element is not in the text.
export function setSectionValuesInText(text, values, { force, prefix = [] } = {}) {
  let out = String(text ?? '');
  const set = [];
  const missing = [];
  for (const v of values || []) {
    const names = [...prefix.map((name) => ({ name, index: 1 })), ...v.path];
    const at = locate(out, names);
    if (!at) {
      missing.push(v);
      continue;
    }
    if (v.attribute) {
      const attrs = [...at.attrs.matchAll(ATTR_RE)].map((m) => [m[1], m[2]]);
      const current = attrs.find(([n]) => n === v.attribute);
      const currentValue = current ? current[1].slice(1, -1) : null;
      if (currentValue === v.value || (current && !force && currentValue !== v.original)) continue;
      const wanted = current ? attrs.map(([n, q]) => [n, n === v.attribute ? `"${escAttr(v.value)}"` : q]) : [...attrs, [v.attribute, `"${escAttr(v.value)}"`]];
      const tag = `<${v.path[v.path.length - 1].name}${wanted.map(([n, q]) => ` ${n}=${q}`).join('')}${at.selfClosing ? '/' : ''}>`;
      out = out.slice(0, at.start) + tag + out.slice(at.openEnd);
      set.push(v);
    } else {
      const inner = at.selfClosing ? '' : out.slice(at.openEnd, at.closeStart);
      if (/</.test(inner)) continue;
      if (inner.trim() === v.value || (inner.trim() && !force && inner.trim() !== v.original)) continue;
      const name = v.path[v.path.length - 1].name;
      out = at.selfClosing
        ? `${out.slice(0, at.start)}<${name}${at.attrs}>${escText(v.value)}</${name}>${out.slice(at.openEnd)}`
        : out.slice(0, at.openEnd) + escText(v.value) + out.slice(at.closeStart);
      set.push(v);
    }
  }
  return { text: out, set, missing };
}

// A whole document the LLM wrote (no insertion point): the values set in its
// section, or the minimal section (with the values) written right after the
// root's start tag when it has none. { text, set, built }.
export function setSectionValuesInDocument(text, root, sectionXml, values, { force }) {
  const doc = String(text ?? '');
  const sectionElement = values[0]?.path[0]?.name;
  if (sectionElement && locate(doc, [{ name: root, index: 1 }, { name: sectionElement, index: 1 }])) {
    const r = setSectionValuesInText(doc, values, { force, prefix: [root] });
    return { text: r.text, set: r.set, built: false };
  }
  const open = locate(doc, [{ name: root, index: 1 }]);
  if (!open || open.selfClosing) return { text: doc, set: [], built: false };
  return { text: `${doc.slice(0, open.openEnd)}\n${sectionXml}${doc.slice(open.openEnd)}`, set: [], built: true };
}

// How the examples' notes show the values, the same in both languages:
// <dmCode infoCode="0A2">, <incode>0A2</incode>.
export function sectionValuesLabel(values) {
  return (values || [])
    .map((v) => (v.attribute ? `<${v.element} ${v.attribute}="${v.value}">` : `<${v.element}>${v.value}</${v.element}>`))
    .join(', ');
}

// A placement of the rule test with the own-section values set in its
// minimal section (prepareRuleTestSetup, and the prompt snapshot):
// { placement, unavailable }. The placement is returned as it was when the
// rule asks for no value.
export function withOwnSectionValues(placement, structure, conditions) {
  const own = resolveOwnSectionValues(conditions, structure, placement.metadata);
  if (!own.values.length || !placement.metadata) return { placement, unavailable: own.unavailable };
  return {
    placement: { ...placement, metadata: { ...placement.metadata, tree: sectionTreeWithValues(placement.metadata.tree, own.values), values: own.values } },
    unavailable: own.unavailable,
  };
}
