// Test rule (T2b): examples built on a real skeleton. Pure module (no React,
// no API) so scripts/ can test it in plain Node.
//
// The LLM no longer writes whole documents. GET /api/schema-cards/structure
// gives, per schema, a skeleton derived from the schema cards
// (backend/app/services/rule_test_skeletons.py: root → … → insertion point,
// normally <para>) plus the schema's complete element graph. Here:
// - ruleTargets: which elements the rule checks (the last step of each of its
//   paths), and the literal start of its absolute paths;
// - chooseTestSchemas: the schema(s) the examples use;
// - placeExample: where in the skeleton the LLM's content goes -- the
//   skeleton's insertion point, or a shallower element of it when the rule
//   checks something that cannot sit inside <para> (a <proceduralStep>, a
//   <table>) or an element of the skeleton itself (the example that
//   complies must be able to leave it out);
// - assembleExample: the complete fragment (skeleton + content) that is run
//   and shown, with xsi:noNamespaceSchemaLocation in the project's form;
// - checkExampleStructure: every element exists in the schema, every child
//   is allowed inside its parent, every attribute exists on its element.
import { schemaContextUrl, supportsSchemaContext } from './ruleSchemaContext.js';
import { extractRuleXPaths } from './ruleNameCheck.js';

const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// ─── What the rule checks ───────────────────────────────────────────────────

// Removes predicates ([…]) and string literals, keeping the rest in place.
function stripPredicates(expression) {
  let out = '';
  let depth = 0;
  let quote = '';
  for (const ch of expression) {
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

// Splits on `sep` at parenthesis depth 0.
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(current);
      current = '';
      i += sep.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const NAME_RE = /^[A-Za-z_][\w.-]*$/;
const AXIS_RE = /^(?:child|descendant|descendant-or-self|self|following-sibling|preceding-sibling|following|preceding|ancestor|ancestor-or-self|parent)::/;

function stepName(segment) {
  const step = segment.trim().replace(AXIS_RE, '');
  return NAME_RE.test(step) ? step : null;
}

// One alternative of a path expression → the element its last step names
// (the owner element for an attribute step), plus its literal absolute
// prefix ("/dmodule/content//thead" → ["dmodule", "content"]).
function analyzeAlternative(alternative, out) {
  const text = alternative.trim();
  if (!text) return;
  if (text.startsWith('(') && text.endsWith(')')) {
    // "(//a | //b)" as a whole
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      if (text[i] === ')') depth -= 1;
      if (depth === 0 && i < text.length - 1) closesAtEnd = false;
    }
    if (closesAtEnd) {
      for (const alt of splitTopLevel(text.slice(1, -1), '|')) analyzeAlternative(alt, out);
      return;
    }
  }
  const segments = splitTopLevel(text, '/');
  if (text.startsWith('/') && !text.startsWith('//')) {
    const prefix = [];
    for (const seg of segments.slice(1)) {
      const name = stepName(seg);
      if (!name) break;
      prefix.push(name);
    }
    if (prefix.length) out.absolutePrefixes.push(prefix);
  }
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i].trim();
    if (!seg || seg === '.' || seg === '*' || /^(?:node|text|comment)\(\)$/.test(seg)) continue;
    if (seg.startsWith('@') || seg.startsWith('attribute::')) continue; // the owner is the previous step
    if (seg.includes('(') || seg.includes(':') && !AXIS_RE.test(seg)) break; // a function call, a prefixed name
    const name = stepName(seg);
    if (name) out.checked.add(name);
    break;
  }
}

// { checked: [element names], absolutePrefixes: [[names]] }
export function ruleTargets(ruleXml) {
  const out = { checked: new Set(), absolutePrefixes: [] };
  for (const expression of extractRuleXPaths(ruleXml || '')) {
    for (const alternative of splitTopLevel(stripPredicates(expression), '|')) analyzeAlternative(alternative, out);
  }
  return { checked: [...out.checked], absolutePrefixes: out.absolutePrefixes };
}

// ─── Which schemas the examples use ─────────────────────────────────────────

// A general rule is tested on one schema: the first of these that has every
// element the rule checks (and the root of its absolute paths).
const TEST_SCHEMA_PREFERENCE = ['descript', 'proced', 'process', 'fault', 'ipd', 'schedul', 'crew', 'comrep', 'sb'];

function schemasHavingAll(names, cards, documentSchemas) {
  return documentSchemas.filter((schema) =>
    names.every((name) => (cards[name]?.variants || []).some((v) => (v.schemas || []).includes(schema)))
  );
}

function byPreference(schemas) {
  const rank = (s) => {
    const i = TEST_SCHEMA_PREFERENCE.indexOf(s);
    return i === -1 ? TEST_SCHEMA_PREFERENCE.length : i;
  };
  return [...schemas].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// { testSchema, otherSchema }: the schema the rule's examples use, and, for a
// rule limited to some schemas, the schema of the "does not apply here"
// example (one that has the checked elements too, so the example can show
// them). `cards` is GET /api/schema-cards's answer for the checked names and
// absolute roots ({} when unavailable).
export function chooseTestSchemas({ contextSchemas = [], documentSchemas = [], cards = {}, targets }) {
  const required = [...new Set([...(targets?.checked || []), ...(targets?.absolutePrefixes || []).map((p) => p[0])])]
    .filter((name) => cards[name]);
  const fitting = byPreference(schemasHavingAll(required, cards, documentSchemas));
  if (contextSchemas.length > 0) {
    const taken = new Set(contextSchemas);
    const others = fitting.filter((s) => !taken.has(s));
    const fallback = byPreference(documentSchemas.filter((s) => !taken.has(s)));
    return { testSchema: contextSchemas[0], otherSchema: others[0] || fallback[0] || null };
  }
  const fallback = byPreference(documentSchemas);
  return { testSchema: fitting[0] || fallback[0] || null, otherSchema: null };
}

// ─── Where the content goes ─────────────────────────────────────────────────

function reachable(elements, from, target, maxDepth = 8) {
  const seen = new Set([from]);
  let frontier = [from];
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const name of frontier) {
      for (const child of elements[name]?.children || []) {
        if (child === target) return true;
        if (!seen.has(child) && elements[child]) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return false;
}

// { path, insertion, allowedChildren } for one schema's structure
// (GET /api/schema-cards/structure) and the rule's targets.
export function placeExample(structure, targets) {
  const chain = structure.skeleton.path;
  const elements = structure.elements;
  const checked = (targets?.checked || []).filter((name) => elements[name]);

  // The example that complies must be able to leave out what the rule
  // checks, so the skeleton stops before the first element it checks.
  let limit = chain.length;
  for (let i = 1; i < chain.length; i += 1) {
    if (checked.includes(chain[i])) {
      limit = i;
      break;
    }
  }
  // An absolute path that leaves the skeleton (/dmodule/identAndStatusSection/…)
  // keeps the insertion point on the part they share.
  for (const prefix of targets?.absolutePrefixes || []) {
    if (prefix[0] !== chain[0]) continue;
    let common = 0;
    while (common < prefix.length && common < chain.length && prefix[common] === chain[common]) common += 1;
    if (prefix.length > common) limit = Math.min(limit, common);
  }

  let index = limit - 1;
  for (let i = limit - 1; i >= 0; i -= 1) {
    if (checked.every((name) => reachable(elements, chain[i], name))) {
      index = i;
      break;
    }
  }
  const insertion = chain[index];
  return { path: chain.slice(0, index + 1), insertion, allowedChildren: [...(elements[insertion]?.children || [])] };
}

// ─── The complete fragment ──────────────────────────────────────────────────

const indentOf = (n) => '  '.repeat(n);

// { xml, skeletonNodePaths }: the skeleton path around the LLM's content.
// The root carries xsi:noNamespaceSchemaLocation with the schema's URL in the
// project's form (flat/master), so a rule limited to that schema applies.
export function assembleExample({ standard, schema, schemaLocation, placement, content }) {
  const path = placement.path;
  const body = String(content ?? '').trim();
  const rootAttrs = [`xmlns:xsi="${XSI_NS}"`];
  if (/\bxlink:/.test(body)) rootAttrs.push(`xmlns:xlink="${XLINK_NS}"`);
  if (supportsSchemaContext(standard) && schema) {
    rootAttrs.push(`xsi:noNamespaceSchemaLocation="${schemaContextUrl(standard, schema, schemaLocation)}"`);
  }
  // Whitespace only between skeleton elements (element-only content); the
  // content sits right against the insertion point's tags, so the text of a
  // <para> is exactly what the LLM wrote (string(.) value checks see no
  // added spaces). The panel re-indents for display.
  const last = path.length - 1;
  const lines = [];
  path.forEach((name, i) => {
    const open = `${indentOf(i)}<${name}${i === 0 ? ` ${rootAttrs.join(' ')}` : ''}>`;
    lines.push(i === last ? `${open}${body}</${name}>` : open);
  });
  for (let i = last - 1; i >= 0; i -= 1) lines.push(`${indentOf(i)}</${path[i]}>`);
  const skeletonNodePaths = [];
  let prefix = '';
  for (const name of path) {
    prefix += `/${name}[1]`;
    skeletonNodePaths.push(prefix);
  }
  return { xml: lines.join('\n'), skeletonNodePaths };
}

// ─── Structural check ───────────────────────────────────────────────────────

// [{ kind: 'unknownElement', element } | { kind: 'notAllowed', element, parent }
//  | { kind: 'unknownAttribute', attribute, element } | { kind: 'wrongRoot', element, expected }]
// against one schema's structure. Prefixed attributes other than xlink:* and
// namespace declarations are not schema vocabulary and are left out.
export function checkExampleStructure(doc, structure) {
  const elements = structure.elements;
  const problems = [];
  const seen = new Set();
  const add = (problem) => {
    const key = JSON.stringify(problem);
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(problem);
    }
  };
  const root = doc.documentElement;
  if (structure.skeleton && root.nodeName !== structure.skeleton.root) {
    add({ kind: 'wrongRoot', element: root.nodeName, expected: structure.skeleton.root });
  }
  const walk = (el, parentName) => {
    const name = el.nodeName;
    const known = Boolean(elements[name]);
    if (!known) add({ kind: 'unknownElement', element: name });
    else if (parentName && elements[parentName] && !elements[parentName].children.includes(name)) {
      add({ kind: 'notAllowed', element: name, parent: parentName });
    }
    if (known) {
      for (const a of Array.from(el.attributes || [])) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:') || a.name.startsWith('xsi:')) continue;
        if (a.name.includes(':') && !a.name.startsWith('xlink:')) continue;
        const local = a.name.replace(/^xlink:/, '');
        if (!elements[name].attributes.includes(local)) add({ kind: 'unknownAttribute', attribute: a.name, element: name });
      }
    }
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) walk(n, name);
  };
  walk(root, null);
  return problems;
}

// English, for the correction request sent back to the LLM (the panel
// translates the same problems through i18n).
export function formatStructureProblem(problem, schema) {
  switch (problem.kind) {
    case 'unknownElement':
      return `<${problem.element}> does not exist in the ${schema} schema`;
    case 'notAllowed':
      return `<${problem.element}> is not allowed inside <${problem.parent}>`;
    case 'unknownAttribute':
      return `@${problem.attribute} does not exist on <${problem.element}>`;
    case 'wrongRoot':
      return `the root element is <${problem.element}>, not <${problem.expected}>`;
    default:
      return String(problem.kind);
  }
}
