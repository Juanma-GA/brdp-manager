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
// The structural check of the examples (every element exists in the schema,
// every child is allowed inside its parent, every attribute exists on its
// element) is validation/schemaValidation.js's checkExampleStructure.
//
// DITA (T4): the "schemas" are the topic types (topic, concept, task,
// reference, troubleshooting, map -- GET /api/schema-cards' document_schemas),
// each with its own skeleton (topic/body, task/taskbody/steps/step, …). For
// a Schematron rule, what it checks comes from its sch:rule contexts only
// (the tests speak about the context node, not about where it sits); a
// context anchored at the document root (/*, /topic) makes the example the
// whole document: the LLM writes the complete root element.
import { schemaContextUrl, supportsSchemaContext } from './ruleSchemaContext.js';
import { extractRuleXPaths, extractXPathNames } from '../validation/schemaValidation.js';

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

// The text inside the predicates ([…], nested ones included), one
// fragment per top-level predicate, joined so the name extractor never glues
// two of them together. String literals are kept (the extractor skips them).
function predicateText(expression) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const ch of expression) {
    if (quote) {
      if (depth > 0) current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (depth > 0) current += ch;
      continue;
    }
    if (ch === '[') {
      if (depth > 0) current += ch;
      depth += 1;
    } else if (ch === ']') {
      depth = Math.max(0, depth - 1);
      if (depth > 0) current += ch;
      else {
        parts.push(current);
        current = '';
      }
    } else if (depth > 0) current += ch;
  }
  return parts.join(' , ');
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

// Plantillas, Part 4: a BREX path can be a true/false condition
// (s1kd-brexcheck evaluates it as such): //updateCode and (//zoneSpec or
// //partIdent), not(//title), count(//para) > 2. Its operands are the
// location paths the condition looks at -- split on top-level and/or and
// comparisons, unwrapping parentheses and not()/boolean()/exists()/
// empty()/count(). A node path comes back unchanged. Works on text whose
// predicates and literals are already stripped.
const CONDITION_WRAPPER_RE = /^(?:not|boolean|exists|empty|count)\s*\(/;
function closesAtEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}
// Split on a top-level word operator (and/or) or comparison.
function splitTopLevelOperators(text, words) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth !== 0) continue;
    if (words) {
      const m = /^\s(and|or)\s/.exec(text.slice(i));
      const before = text.slice(0, i).trimEnd().slice(-1);
      if (m && before && !/[/@:]/.test(before)) {
        parts.push(text.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    } else {
      const m = /^(?:!=|<=|>=|=|<|>|\s(?:eq|ne|lt|le|gt|ge)\s)/.exec(text.slice(i));
      if (m) {
        parts.push(text.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts;
}
export function conditionOperands(expression) {
  const out = [];
  const visit = (raw) => {
    let e = raw.trim();
    for (;;) {
      if (e.startsWith('(') && closesAtEnd(e, 0)) {
        e = e.slice(1, -1).trim();
        continue;
      }
      const w = CONDITION_WRAPPER_RE.exec(e);
      if (w && closesAtEnd(e, w[0].length - 1)) {
        e = e.slice(w[0].length, -1).trim();
        continue;
      }
      break;
    }
    if (!e) return;
    const words = splitTopLevelOperators(e, true);
    if (words.length > 1) return words.forEach(visit);
    const sides = splitTopLevelOperators(e, false);
    if (sides.length > 1) return sides.filter((side) => /^\s*[/(.@A-Za-z]/.test(side)).forEach(visit);
    out.push(e);
  };
  visit(expression);
  return out;
}

const NAME_RE = /^[A-Za-z_][\w.-]*$/;
const AXIS_RE = /^(?:child|descendant|descendant-or-self|self|following-sibling|preceding-sibling|following|preceding|ancestor|ancestor-or-self|parent)::/;

function stepName(segment) {
  const step = segment.trim().replace(AXIS_RE, '');
  return NAME_RE.test(step) ? step : null;
}

// One alternative of a path expression → the element its last step names
// (the owner element for an attribute step), plus its literal absolute
// prefix ("/dmodule/content//thead" → ["dmodule", "content"]). Each
// alternative is also recorded on its own (out.alternatives: its element
// steps, its trailing attribute, its absolute prefix), so the placement can
// tell a rule about the data module's metadata from one about its content.
// An alternative whose steps cannot be read (a function call, a variable, a
// prefixed name, "..") is "opaque": nothing is concluded from it.
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
  let absolutePrefix = null;
  if (text.startsWith('/') && !text.startsWith('//')) {
    const prefix = [];
    for (const seg of segments.slice(1)) {
      const name = stepName(seg);
      if (!name) break;
      prefix.push(name);
    }
    if (prefix.length) {
      out.absolutePrefixes.push(prefix);
      absolutePrefix = prefix;
    }
  }
  let checked = null;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i].trim();
    if (!seg || seg === '.' || seg === '*' || /^(?:node|text|comment)\(\)$/.test(seg)) continue;
    if (seg.startsWith('@') || seg.startsWith('attribute::')) continue; // the owner is the previous step
    if (seg.includes('(') || seg.includes(':') && !AXIS_RE.test(seg)) break; // a function call, a prefixed name
    const name = stepName(seg);
    if (name) {
      out.checked.add(name);
      checked = name;
    }
    break;
  }
  const steps = [];
  let attribute = null;
  let opaque = false;
  // Descendant steps "A//B" (or descendant::B): the pairs [A, B], so the
  // prompt can give the valid nesting between them (nestingPaths).
  const descendantPairs = [];
  let previous = null;
  let descendant = false;
  segments.forEach((raw, i) => {
    const seg = raw.trim();
    if (!seg) {
      if (i > 0) descendant = true; // the empty segment of "//"
      return;
    }
    if (/^descendant(?:-or-self)?::node\(\)$/.test(seg)) {
      descendant = true;
      return;
    }
    if (seg === '.' || /^(?:node|text|comment)\(\)$/.test(seg)) return;
    if (seg === '*') {
      previous = null;
      return;
    }
    const attr = /^(?:@|attribute::)([A-Za-z_][\w.-]*)$/.exec(seg);
    if (attr) {
      if (i === segments.length - 1) attribute = attr[1];
      else opaque = true;
      previous = null;
      return;
    }
    const name = stepName(seg);
    if (name) {
      steps.push(name);
      if (previous && (descendant || /^descendant(?:-or-self)?::/.test(seg))) descendantPairs.push([previous, name]);
      previous = name;
    } else {
      opaque = true;
      previous = null;
    }
    descendant = false;
  });
  if (steps.length === 0 && !attribute) opaque = true;
  out.alternatives.push({ steps, attribute, checked, absolutePrefix, opaque, descendantPairs });
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeEntities = (text) =>
  text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (_m, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name]
  );
// The @context of every Schematron rule (sch:rule, any prefix or none).
const SCH_RULE_CONTEXT_RE = /<(?:[\w.-]+:)?rule\b[^>]*?\scontext\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function schematronContexts(ruleXml) {
  const out = [];
  for (const m of String(ruleXml || '').matchAll(SCH_RULE_CONTEXT_RE)) out.push(decodeEntities(m[1] ?? m[2]));
  return out;
}

// T4b: the expressions whose nodes the rule runs on -- its Schematron
// contexts, or its BREX paths -- whitespace collapsed, for the correction
// request about an example that touches none of them.
export function ruleMatchExpressions(ruleXml) {
  const contexts = schematronContexts(ruleXml);
  return (contexts.length ? contexts : extractRuleXPaths(ruleXml || '')).map((e) => e.replace(/\s+/g, ' ').trim());
}

// An XSLT pattern that matches only the document's root element: "/*",
// "/topic", "/*[not(parent::*)]".
function isRootContext(alternative) {
  return /^\/(?:\*|[A-Za-z_][\w.-]*)$/.test(alternative.trim());
}

// { checked: [element names], absolutePrefixes: [[names]], wholeDocument }
// wholeDocument: a Schematron context that matches the document's root
// element -- the example has to be a whole document.
// predicateNames: the element names the predicates of the rule's paths
// (BREX) or contexts (Schematron) mention -- a rule whose path selects
// content nodes but whose predicate reads the metadata
// (//*[@changeMark = '1' and ancestor::dmodule[identAndStatusSection/dmStatus[…]]])
// needs both parts written by the LLM; see classifyRuleTargets.
export function ruleTargets(ruleXml) {
  const out = { checked: new Set(), absolutePrefixes: [], alternatives: [] };
  const contexts = schematronContexts(ruleXml);
  const predicateNames = new Set();
  let wholeDocument = false;
  for (const expression of contexts.length ? contexts : extractRuleXPaths(ruleXml || '')) {
    const operands = contexts.length ? [stripPredicates(expression)] : conditionOperands(stripPredicates(expression));
    for (const alternative of operands.flatMap((operand) => splitTopLevel(operand, '|'))) {
      if (contexts.length && isRootContext(alternative)) wholeDocument = true;
      analyzeAlternative(alternative, out);
    }
    for (const name of extractXPathNames(predicateText(expression)).elements) predicateNames.add(name);
  }
  return {
    checked: [...out.checked],
    absolutePrefixes: out.absolutePrefixes,
    alternatives: out.alternatives,
    predicateNames: [...predicateNames],
    wholeDocument,
  };
}

// ─── Which schemas the examples use ─────────────────────────────────────────

// A general rule is tested on one schema: the first of these that has every
// element the rule checks (and the root of its absolute paths).
const TEST_SCHEMA_PREFERENCE = ['descript', 'proced', 'process', 'fault', 'ipd', 'schedul', 'crew', 'comrep', 'sb'];

// `elementSchemas` (DITA): { name: [topic types whose graph has it] } --
// the merged DITA cards list a single schema, so the backend answers it.
function schemasHavingAll(names, cards, documentSchemas, elementSchemas) {
  const has = (name, schema) =>
    elementSchemas && elementSchemas[name]
      ? elementSchemas[name].includes(schema)
      : (cards[name]?.variants || []).some((v) => (v.schemas || []).includes(schema));
  return documentSchemas.filter((schema) => names.every((name) => has(name, schema)));
}

// TEST_SCHEMA_PREFERENCE first (S1000D), then the order the backend lists
// them in (alphabetical for S1000D; topic, concept, task, … for DITA).
function byPreference(schemas, documentSchemas = []) {
  const rank = (s) => {
    const i = TEST_SCHEMA_PREFERENCE.indexOf(s);
    return i === -1 ? TEST_SCHEMA_PREFERENCE.length : i;
  };
  const listed = (s) => {
    const i = documentSchemas.indexOf(s);
    return i === -1 ? documentSchemas.length : i;
  };
  return [...schemas].sort((a, b) => rank(a) - rank(b) || listed(a) - listed(b) || a.localeCompare(b));
}

// { testSchema, otherSchema, groups }: the schema the rule's examples use,
// and, for a rule limited to some schemas, the schema of the "does not apply
// here" example (one that has the checked elements too, so the example can
// show them). `cards` is GET /api/schema-cards's answer for the checked
// names, the alternatives' steps and the absolute roots ({} when
// unavailable).
// groups: one schema per part of the rule, or null. A general rule whose
// alternatives look at elements that live in different schemas (S1-00120:
// //proceduralStep[…] | //levelledPara[…]) used to be tested on the only
// schema that has them all ("sb"), where examples are almost impossible to
// write. When no schema has them all, or the first that does is not the
// preferred schema of any alternative, the alternatives are grouped by
// their own preferred schema (the first, by preference, that has all their
// element steps): [{ schema, alternatives, checked }], at least two groups
// -- each tested with its own examples; the whole rule still runs on every
// example. Otherwise null, and the single schema as before.
export function chooseTestSchemas({ contextSchemas = [], documentSchemas = [], cards = {}, elementSchemas = null, targets }) {
  const known = (name) => Boolean(cards[name]) || Boolean(elementSchemas?.[name]?.length);
  const required = [...new Set([...(targets?.checked || []), ...(targets?.absolutePrefixes || []).map((p) => p[0])])]
    .filter(known);
  const order = (list) => byPreference(list, documentSchemas);
  const fitting = order(schemasHavingAll(required, cards, documentSchemas, elementSchemas));
  if (contextSchemas.length > 0) {
    const taken = new Set(contextSchemas);
    const others = fitting.filter((s) => !taken.has(s));
    const fallback = order(documentSchemas.filter((s) => !taken.has(s)));
    return { testSchema: contextSchemas[0], otherSchema: others[0] || fallback[0] || null, groups: null };
  }
  const fallback = order(documentSchemas);
  const groups = schemaGroups(targets, fitting[0] || null, { known, order, cards, documentSchemas, elementSchemas });
  if (groups) return { testSchema: groups[0].schema, otherSchema: null, groups };
  return { testSchema: fitting[0] || fallback[0] || null, otherSchema: null, groups: null };
}

function schemaGroups(targets, common, { known, order, cards, documentSchemas, elementSchemas }) {
  const bySchema = new Map();
  for (const alt of targets?.alternatives || []) {
    if (alt.opaque) continue;
    const names = [...new Set([...alt.steps, ...(alt.absolutePrefix ? [alt.absolutePrefix[0]] : [])])].filter(known);
    if (names.length === 0) continue;
    const preferred = order(schemasHavingAll(names, cards, documentSchemas, elementSchemas))[0];
    if (!preferred) continue;
    if (!bySchema.has(preferred)) bySchema.set(preferred, []);
    bySchema.get(preferred).push(alt);
  }
  if (bySchema.size < 2) return null;
  if (common && bySchema.has(common)) return null;
  return order([...bySchema.keys()]).map((schema) => {
    const alternatives = bySchema.get(schema);
    return { schema, alternatives, checked: [...new Set(alternatives.map((a) => a.checked).filter(Boolean))] };
  });
}

// The rule's targets restricted to one group's alternatives: what the
// examples of that group's schema are placed for.
export function targetsForGroup(targets, group) {
  const alternatives = group.alternatives;
  return {
    ...targets,
    checked: [...new Set(alternatives.map((a) => a.checked).filter(Boolean))],
    absolutePrefixes: alternatives.map((a) => a.absolutePrefix).filter(Boolean),
    alternatives,
  };
}

// ─── Where the content goes ─────────────────────────────────────────────────

// The shortest chain of elements that puts `to` inside `from` in this
// schema's graph -- [from, …, to] -- or null when there is none. At least
// one step: "randomList//randomList" → randomList/listItem/para/randomList.
export function nestingPath(elements, from, to) {
  if (!elements[from] || !elements[to]) return null;
  const previous = new Map();
  let frontier = [from];
  // `from` is never re-entered (a cycle back to it would make the chain
  // loop forever); from === to still works, the check is on the child.
  const seen = new Set([from]);
  while (frontier.length) {
    const next = [];
    for (const name of frontier) {
      for (const child of [...(elements[name]?.children || [])].sort()) {
        if (child === to) {
          const path = [to, name];
          for (let at = name; previous.has(at); ) {
            at = previous.get(at);
            path.push(at);
          }
          return path.reverse();
        }
        if (!seen.has(child) && elements[child]) {
          seen.add(child);
          previous.set(child, name);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return null;
}

// Pending of the test rule (Part 1): for each "A//B" of the rule whose B is
// not a direct child of A, the valid nesting in this schema. An LLM put a
// <randomList> straight inside another one (invalid) and, corrected, moved
// it out -- the reject example was no longer nested. Nothing for a pair
// with no path in the schema.
export function nestingPaths(structure, targets) {
  const elements = structure.elements;
  const out = [];
  const seen = new Set();
  for (const alternative of targets?.alternatives || []) {
    if (alternative.opaque) continue;
    for (const [ancestor, descendant] of alternative.descendantPairs || []) {
      const key = `${ancestor}//${descendant}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const path = nestingPath(elements, ancestor, descendant);
      if (path && path.length > 2) out.push({ ancestor, descendant, path });
    }
  }
  return out;
}

// Ajustes tras la pasada real de las plantillas, Part 3: the elements a
// rule checks can sit several levels below the insertion point -- in a
// data update file, update/insertObjectGroup/insertObject/partSpec. The
// prompt only listed what goes DIRECTLY inside <update>, so the LLM
// guessed the rest (0 of 3 valid examples for EXT-00019 in the real run).
// contentRoutes gives, from the schema's graph, the valid way down to each
// of them: the containers on the way with the children that lead there
// (and their own attributes), and a short card of the elements themselves.
// Only when at least one element the rule checks is not a direct child of
// the insertion point; otherwise null (the prompt does not change).
// `names`: the rule's content-side names (checked + predicates) first,
// then `extraNames` (elements its objectUse names, e.g. the ones a tool CIR
// may contain), which join the route but never trigger it.
const ROUTE_MAX_NAMES = 30;
const ROUTE_MAX_CARDS = 6;
const ROUTE_MAX_LIST = 12;
// Attributes every S1000D element has (change marking, security,
// applicability links): noise in a route, left out of it.
const GENERIC_ATTRIBUTES = new Set([
  'authorityDocument', 'authorityName', 'caveat', 'changeMark', 'changeType', 'commercialClassification',
  'securityClassification', 'reasonForUpdateRefIds', 'id', 'applicRefId', 'derivativeClassificationRefId',
  'controlAuthorityRefIds', 'crewRefCard', 'skillLevelCode',
]);
const specificAttributes = (el) =>
  (el?.attributes || []).filter((a) => !GENERIC_ATTRIBUTES.has(a) && !a.includes(':')).sort();

export function contentRoutes(structure, insertion, ruleNames, extraNames = []) {
  const elements = structure.elements;
  if (!insertion || !elements[insertion]) return null;
  const direct = new Set(elements[insertion].children || []);
  const pathOf = (name) => (name === insertion || direct.has(name) ? null : nestingPath(elements, insertion, name));
  const ruleRoutes = [...new Set(ruleNames)].filter((n) => elements[n]).map((n) => [n, pathOf(n)]);
  if (!ruleRoutes.some(([, path]) => path)) return null;
  const all = [...ruleRoutes];
  for (const n of new Set(extraNames)) {
    if (elements[n] && !all.some(([m]) => m === n)) all.push([n, pathOf(n)]);
  }
  const routed = all.filter(([, path]) => path).slice(0, ROUTE_MAX_NAMES);
  const edges = new Map();
  for (const [, path] of routed) {
    for (let i = 0; i + 1 < path.length; i += 1) {
      if (!edges.has(path[i])) edges.set(path[i], new Set());
      edges.get(path[i]).add(path[i + 1]);
    }
  }
  const targetSet = new Set(routed.map(([n]) => n));
  const steps = [...edges.entries()].map(([parent, children]) => ({
    parent,
    children: [...children].sort(),
    attributes: targetSet.has(parent) ? [] : specificAttributes(elements[parent]),
  }));
  // Cards: half from the rule's own names (what a reject example needs),
  // half from the others (what an accept example may use instead).
  const ruleRouted = routed.filter(([n]) => ruleRoutes.some(([m]) => m === n));
  const otherRouted = routed.filter(([n]) => !ruleRoutes.some(([m]) => m === n));
  const half = Math.ceil(ROUTE_MAX_CARDS / 2);
  const carded = [
    ...ruleRouted.slice(0, otherRouted.length ? half : ROUTE_MAX_CARDS),
    ...otherRouted.slice(0, ROUTE_MAX_CARDS),
  ].slice(0, ROUTE_MAX_CARDS);
  const cards = carded.map(([name]) => {
    const children = [...(elements[name].children || [])].sort();
    const attributes = specificAttributes(elements[name]);
    return {
      name,
      // each child with its own attributes: <partSpec> > partIdent(@partNumberValue …)
      children: children.slice(0, ROUTE_MAX_LIST).map((c) => ({ name: c, attributes: specificAttributes(elements[c]).slice(0, 6) })),
      childrenOmitted: Math.max(0, children.length - ROUTE_MAX_LIST),
      attributes: attributes.slice(0, ROUTE_MAX_LIST),
      attributesOmitted: Math.max(0, attributes.length - ROUTE_MAX_LIST),
    };
  });
  return { from: insertion, steps, cards };
}

// The element names the rule's objectUse / objuse text mentions (bare
// words: "Only toolSpec, toolIdent, figure … can be used"); the caller
// keeps those that are elements of the schema.
export function ruleUseNames(ruleXml) {
  const out = [];
  for (const m of String(ruleXml || '').matchAll(/<(objectUse|objuse)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    for (const w of m[2].replace(/&lt;|&gt;|&amp;/g, ' ').matchAll(/[A-Za-z][A-Za-z0-9-]*/g)) out.push(w[0]);
  }
  return [...new Set(out)];
}

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

// All the elements reachable from `starts` (the starts included).
function reachableSet(elements, starts) {
  const seen = new Set(starts.filter((n) => elements[n]));
  let frontier = [...seen];
  while (frontier.length) {
    const next = [];
    for (const name of frontier) {
      for (const child of elements[name]?.children || []) {
        if (!seen.has(child) && elements[child]) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

function treeNames(node, out = new Set()) {
  out.add(node.name);
  for (const child of node.children || []) treeNames(child, out);
  return out;
}

// Rule test on DM metadata: which part of the assembled data module each
// alternative of the rule's paths can select nodes in.
//   M  elements reachable from the identification and status section
//   T  elements of the minimal section the application writes
//   C  elements reachable from the rest of the document (its content)
// An alternative looks at the METADATA when all its element steps are in M
// and its last element is in T (so the skeleton's own node is checked: the
// dmCode of //dmCode/@infoCode) or one of its steps exists only there
// (dmIdent, dmStatus); an attribute-only alternative (//@issueType), when an
// element that carries the attribute is. It looks at the CONTENT when all
// its element steps are in C (an attribute-only one: when an element in C
// carries the attribute). An absolute path says where it goes by its second
// step. An alternative that can be neither is unreachable; an opaque one
// (steps that cannot be read) counts as content, as before. The element
// names in the predicates (targets.predicateNames) add the part they belong
// to: a predicate on dmStatus/@issueType puts the section in the LLM's hands
// even when the path selects content nodes.
// → { metadata, content, contentAlternatives, unreachable } -- unreachable:
// the names the rule looks at when EVERY alternative is unreachable (the
// examples can never contain what it checks), else null.
export function classifyRuleTargets(structure, targets) {
  const elements = structure.elements;
  const root = structure.skeleton.path[0];
  const section = structure.skeleton.metadata || null;
  // The root is an ancestor of both parts (an absolute path names it).
  const M = section ? reachableSet(elements, [section.element]).add(root) : new Set();
  const T = section ? treeNames(section.tree) : new Set();
  const C = reachableSet(elements, section ? (elements[root]?.children || []).filter((c) => c !== section.element) : [root]).add(root);
  const owners = (attribute) => Object.keys(elements).filter((n) => elements[n].attributes.includes(attribute));
  let metadata = false;
  let content = false;
  const contentAlternatives = [];
  const unreachableNames = [];
  let allUnreachable = true;
  const alternatives = targets?.alternatives || [];
  for (const alt of alternatives) {
    if (alt.opaque) {
      content = true;
      contentAlternatives.push(alt);
      allUnreachable = false;
      continue;
    }
    let inMeta;
    let inContent;
    const prefix = alt.absolutePrefix;
    if (prefix && prefix[0] !== root) {
      inMeta = false;
      inContent = false;
    } else if (alt.steps.length > 0) {
      const last = alt.steps[alt.steps.length - 1];
      const metaOnly = alt.steps.some((s) => M.has(s) && !C.has(s));
      inMeta = Boolean(section) && alt.steps.every((s) => M.has(s)) && (T.has(last) || metaOnly);
      inContent = alt.steps.every((s) => C.has(s));
      if (prefix && prefix.length > 1 && section) {
        inMeta = inMeta && prefix[1] === section.element;
        inContent = inContent && prefix[1] !== section.element;
      }
    } else {
      const carriers = owners(alt.attribute);
      inMeta = Boolean(section) && carriers.some((o) => T.has(o) || (M.has(o) && !C.has(o)));
      inContent = carriers.some((o) => C.has(o));
    }
    if (inMeta) metadata = true;
    if (inContent) {
      content = true;
      contentAlternatives.push(alt);
    }
    if (inMeta || inContent) {
      allUnreachable = false;
      continue;
    }
    const unknown = alt.steps.find((s) => !M.has(s) && !C.has(s));
    unreachableNames.push(
      unknown ? `<${unknown}>` : alt.steps.length > 0 ? alt.steps.map((s) => `<${s}>`).join('/') : `@${alt.attribute}`
    );
  }
  if (alternatives.length === 0) content = true;
  // A predicate that reads the other part: an element only the section has
  // (dmStatus, updateCode, …) makes the LLM write the section too; an
  // element only the content has (zoneSpec, …), the content.
  const predicateNames = (targets?.predicateNames || []).filter((n) => elements[n]);
  if (section && predicateNames.some((n) => M.has(n) && !C.has(n))) metadata = true;
  if (predicateNames.some((n) => C.has(n) && !M.has(n))) content = true;
  const unreachable =
    alternatives.length > 0 && allUnreachable && !metadata && !content ? [...new Set(unreachableNames)] : null;
  // A rule nothing can be said about keeps the content placement.
  if (!metadata && !content && !unreachable) content = true;
  return { metadata, content, contentAlternatives, unreachable };
}

// { path, insertion, root, allowedChildren, titled, metadata,
//   contentInsertion, unreachable } for one schema's structure (GET
// /api/schema-cards/structure) and the rule's targets. A whole-document
// example (the rule checks the root element) has an empty path and no
// insertion point: the content is the complete root element.
// titled (T4b): the elements of the path the application writes a <title>
// into (a DITA topic's mandatory title, skeleton.titled) -- none when the
// rule itself checks <title>, so a skeleton title never decides a verdict;
// for a whole document, the root when the LLM has to write that title.
// metadata (rule test on DM metadata): { element, tree, insertion } for a
// data module -- the minimal identification and status section, which the
// application writes (insertion: false) unless the rule looks at it
// (insertion: true: the LLM writes the whole section, starting from the
// minimal one); null for other documents. contentInsertion: false when the
// rule looks only at the metadata (the content is the bare skeleton).
// unreachable: see classifyRuleTargets.
// withRoutes (Part 3): give the valid way down to the checked elements
// (contentRoutes) -- asked by prepareRuleTestSetup for the S1000D schemas
// with no path to <para> (data update file, ipd, pm, dml…: structured data
// an LLM does not know by heart), never for prose (a <para> or a DITA body).
export function placeExample(structure, targets, { useNames = [], withRoutes = false } = {}) {
  const chain = structure.skeleton.path;
  const elements = structure.elements;
  const section = structure.skeleton.metadata || null;
  const checked = (targets?.checked || []).filter((name) => elements[name]);
  const skeletonTitled = checked.includes('title') ? [] : structure.skeleton.titled || [];
  if (targets?.wholeDocument || checked.includes(chain[0])) {
    return {
      path: [],
      insertion: null,
      root: chain[0],
      allowedChildren: [...(elements[chain[0]]?.children || [])],
      titled: (structure.skeleton.titled || []).includes(chain[0]) ? [chain[0]] : [],
      // The LLM writes the whole document; the prompt still gives it the
      // minimal identification and status section to start from.
      metadata: section ? { element: section.element, tree: section.tree, insertion: true } : null,
      contentInsertion: true,
      unreachable: null,
      nestings: nestingPaths(structure, targets),
    };
  }
  const classes = classifyRuleTargets(structure, targets);
  const metadata = section ? { element: section.element, tree: section.tree, insertion: classes.metadata } : null;
  // What the content placement looks at: the alternatives about the content.
  const contentChecked = [
    ...new Set(classes.contentAlternatives.map((a) => a.checked).filter((name) => name && elements[name])),
  ];
  const contentPrefixes = classes.contentAlternatives.map((a) => a.absolutePrefix).filter(Boolean);
  const whole = (insertion, path, contentInsertion) => ({
    path,
    insertion,
    root: chain[0],
    allowedChildren: [...(elements[insertion]?.children || [])],
    titled: path.filter((name) => skeletonTitled.includes(name)),
    metadata,
    contentInsertion,
    unreachable: classes.unreachable,
    nestings: nestingPaths(structure, targets),
  });
  if (!classes.content) return whole(chain[chain.length - 1], chain, false);

  // The example that complies must be able to leave out what the rule
  // checks, so the skeleton stops before the first element it checks.
  let limit = chain.length;
  for (let i = 1; i < chain.length; i += 1) {
    if (contentChecked.includes(chain[i])) {
      limit = i;
      break;
    }
  }
  // An absolute path that leaves the skeleton (/dmodule/content/…/thead)
  // keeps the insertion point on the part they share.
  for (const prefix of contentPrefixes) {
    if (prefix[0] !== chain[0]) continue;
    let common = 0;
    while (common < prefix.length && common < chain.length && prefix[common] === chain[common]) common += 1;
    if (prefix.length > common) limit = Math.min(limit, common);
  }

  let index = limit - 1;
  for (let i = limit - 1; i >= 0; i -= 1) {
    if (contentChecked.every((name) => reachable(elements, chain[i], name))) {
      index = i;
      break;
    }
  }
  const placed = whole(chain[index], chain.slice(0, index + 1), true);
  const predicateNames = (targets?.predicateNames || []).filter((n) => elements[n]);
  placed.routes = withRoutes ? contentRoutes(structure, placed.insertion, [...contentChecked, ...predicateNames], useNames) : null;
  return placed;
}

// ─── The complete fragment ──────────────────────────────────────────────────

const indentOf = (n) => '  '.repeat(n);

// The neutral text of a skeleton <title> (T4b). The examples are in
// English, like the rest of the test fragments.
export const SKELETON_TITLE_TEXT = 'Example topic';
// Marks, in skeletonNodePaths, the text of a skeleton element (the title's),
// so the panel dims it with its tags.
export const SKELETON_TEXT_SUFFIX = '/text()';

// ─── The identification and status section ─────────────────────────────────
const escXmlText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escXmlAttr = (v) => escXmlText(v).replace(/"/g, '&quot;');

// The minimal section's tree (skeleton.metadata.tree, from the backend) as
// indented XML lines, and the node paths of its elements (and of the text of
// the elements that have some) for the panel to dim. `parentPath` is the
// path of the element it goes into ("/dmodule[1]"). Same serialization as
// backend/tests/test_rule_test_skeletons.py's _serialize, which validates
// every section against the real XSD.
export function metadataXml(tree, depth = 0, parentPath = '') {
  const lines = [];
  const paths = [];
  const walk = (node, level, path) => {
    paths.push(path);
    const attrs = (node.attributes || []).map(([name, value]) => ` ${name}="${escXmlAttr(value)}"`).join('');
    const children = node.children || [];
    if (node.text != null && node.text !== '') paths.push(`${path}${SKELETON_TEXT_SUFFIX}`);
    if (children.length === 0) {
      lines.push(
        node.text != null && node.text !== ''
          ? `${indentOf(level)}<${node.name}${attrs}>${escXmlText(node.text)}</${node.name}>`
          : `${indentOf(level)}<${node.name}${attrs}/>`
      );
      return;
    }
    lines.push(`${indentOf(level)}<${node.name}${attrs}>${node.text ? escXmlText(node.text) : ''}`);
    const seen = {};
    for (const child of children) {
      seen[child.name] = (seen[child.name] || 0) + 1;
      walk(child, level + 1, `${path}/${child.name}[${seen[child.name]}]`);
    }
    lines.push(`${indentOf(level)}</${node.name}>`);
  };
  walk(tree, depth, `${parentPath}/${tree.name}[1]`);
  return { xml: lines.join('\n'), paths };
}

// { xml, skeletonNodePaths }: the skeleton path around the LLM's content.
// S1000D: the root carries xsi:noNamespaceSchemaLocation with the schema's
// URL in the project's form (flat/master), so a rule limited to that schema
// applies. DITA: no schema location (a DITA document names its DTD/shell,
// never an XSD URL), so the root gets no namespace declaration either.
// A whole-document placement (empty path) is the content alone. A titled
// path element (placement.titled) gets <title>SKELETON_TITLE_TEXT</title>
// as its first child, part of the skeleton.
// ─── The brexDmRef follows the data module's own code ───────────────────────

// The brexDmRef of the section stands for the project's own BREX, which
// follows the same decisions as every data module of the project -- so,
// when the LLM writes the section (metadata.insertion), its data module
// code is made the DM's own code with the BREX's info code (022) and item
// location (D). Without this a rule on any code attribute (S1-00342,
// //@disassyCodeVariant[string-length(.) != 2]) also sees the brexDmRef's
// code, and there is no default value that suits every rule: the example
// meant to comply was rejected for the BREX's disassyCodeVariant="A".
// 3.0.1: the <avee> of brexref/refdm is rebuilt from the <avee> of dmc.
// Text only (the rest of the section stays exactly as written); returns
// { text, changed }. Nothing is changed when either code is missing (its
// validation says so), and the caller skips it for a rule that looks at the
// brexDmRef itself (ruleLooksAtBrexReference): then what the LLM wrote
// there is the point of the example. The minimal section of the skeleton
// (backend) needs nothing: its two codes already share every value.
// infoCode="022" is kept even when the rule's list excludes it -- the real
// BREX has that code; ruleTest.js's rejectedByBrexReference then says the
// rejection comes from the brexDmRef, i.e. the rule would reject the
// project's BREX too.
const BREX_REFERENCE_CODE = {
  identAndStatusSection: { own: ['dmIdent'], brex: 'brexDmRef', code: 'dmCode', overrides: { infoCode: '022', itemLocationCode: 'D' } },
  idstatus: { own: ['dmaddres', 'dmc'], brex: 'brexref', code: 'avee', overrides: { incode: '022', itemloc: 'D' } },
};
const BREX_REFERENCE_NAMES = new Set(['brexDmRef', 'brexref']);
const SECTION_TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE_RE = /([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;

export function ruleLooksAtBrexReference(ruleXml) {
  return ruleMatchExpressions(ruleXml).some((e) => /(^|[^\w.-])(brexDmRef|brexref)(?![\w.-])/.test(e));
}

// The first element named `code` -- inside `brex` when given, else inside
// every one of `inside` and outside any brexDmRef/brexref: { start, openEnd,
// end, attrs, selfClosing } (offsets in the text), or null.
function findCodeElement(text, code, { inside = [], brex }) {
  const stack = [];
  let found = null;
  for (const m of text.matchAll(SECTION_TAG_RE)) {
    if (m[2] === undefined) continue;
    const name = m[2];
    if (m[1]) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) {
        if (found && found.depth === at && found.end === null) found.end = m.index + m[0].length;
        stack.length = at;
      }
      continue;
    }
    const wanted =
      !found && name === code && (brex ? stack.includes(brex) : !stack.some((n) => BREX_REFERENCE_NAMES.has(n)) && inside.every((n) => stack.includes(n)));
    if (wanted) {
      found = { start: m.index, openEnd: m.index + m[0].length, end: m[4] ? m.index + m[0].length : null, depth: stack.length, attrs: m[3], selfClosing: !!m[4] };
    }
    if (!m[4]) stack.push(name);
  }
  return found && found.end !== null ? found : null;
}

const attributeList = (text) => [...String(text || '').matchAll(ATTRIBUTE_RE)].map((m) => [m[1], m[2]]);

// The children of an <avee> as [[name, text]] (text as written).
const aveeChildren = (inner) => [...inner.matchAll(/<([A-Za-z_][\w.-]*)\s*>([^<]*)<\/\1\s*>/g)].map((m) => [m[1], m[2]]);

const lineIndent = (text, index) => {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(lineStart, index);
  return /^\s*$/.test(before) ? before : null;
};

export function normalizeBrexReferenceCode(sectionText, sectionElement) {
  const text = String(sectionText ?? '');
  const spec = BREX_REFERENCE_CODE[sectionElement];
  if (!spec || !text.trim()) return { text, changed: false };
  const own = findCodeElement(text, spec.code, { inside: spec.own });
  const brex = findCodeElement(text, spec.code, { brex: spec.brex });
  if (!own || !brex) return { text, changed: false };
  if (spec.code === 'dmCode') {
    const ownAttrs = attributeList(own.attrs);
    const wanted = ownAttrs.map(([name, quoted]) => [name, name in spec.overrides ? `"${spec.overrides[name]}"` : quoted]);
    for (const [name, value] of Object.entries(spec.overrides)) {
      if (!wanted.some(([n]) => n === name)) wanted.push([name, `"${value}"`]);
    }
    const unquote = (q) => q.slice(1, -1);
    const current = new Map(attributeList(brex.attrs).map(([n, q]) => [n, unquote(q)]));
    const same = current.size === wanted.length && wanted.every(([n, q]) => current.get(n) === unquote(q));
    if (same) return { text, changed: false };
    const tag = `<${spec.code} ${wanted.map(([n, q]) => `${n}=${q}`).join(' ')}${brex.selfClosing ? '/' : ''}>`;
    return { text: text.slice(0, brex.start) + tag + text.slice(brex.openEnd), changed: true };
  }
  // 3.0.1 <avee>: every child of the DM's own, the overrides as text.
  const ownInner = text.slice(own.openEnd, own.end - `</${spec.code}>`.length);
  const brexCloseStart = text.lastIndexOf('</', brex.end - 1);
  const brexInner = text.slice(brex.openEnd, brexCloseStart);
  const wanted = aveeChildren(ownInner).map(([n, v]) => [n, n in spec.overrides ? spec.overrides[n] : v]);
  if (wanted.length === 0) return { text, changed: false };
  const current = aveeChildren(brexInner);
  const same = current.length === wanted.length && wanted.every(([n, v], i) => current[i][0] === n && current[i][1] === v);
  if (same) return { text, changed: false };
  // Laid out like the <avee> it replaces: one child per line when it had
  // them, indented one level more than the <avee> itself; else in a row.
  const brexIndent = lineIndent(text, brex.start);
  const multiline = /\n/.test(brexInner) && brexIndent !== null;
  const childIndent = multiline ? `${brexIndent}  ` : '';
  const children = wanted.map(([n, v]) => `${childIndent}<${n}>${v}</${n}>`);
  const inner = multiline ? `\n${children.join('\n')}\n${brexIndent}` : children.join('');
  const openTag = brex.selfClosing ? `<${spec.code}>` : text.slice(brex.start, brex.openEnd);
  return { text: text.slice(0, brex.start) + openTag + inner + `</${spec.code}>` + text.slice(brex.end), changed: true };
}

// A data module (placement.metadata) starts with its identification and
// status section: the minimal one, part of the skeleton, or -- when the
// rule looks at it (metadata.insertion) -- the section the LLM wrote
// (`metadata`), as it wrote it. The content is left empty when the rule
// looks only at the metadata (placement.contentInsertion === false).
export function assembleExample({ standard, schema, schemaLocation, placement, content, metadata = null }) {
  const path = placement.path;
  const body = placement.contentInsertion === false ? '' : String(content ?? '').trim();
  if (path.length === 0) return { xml: String(content ?? '').trim(), skeletonNodePaths: [] };
  const withSchemaLocation = supportsSchemaContext(standard);
  const rootAttrs = withSchemaLocation ? [`xmlns:xsi="${XSI_NS}"`] : [];
  const section = placement.metadata || null;
  const sectionText = section?.insertion ? String(metadata ?? '').trim() : '';
  if (/\bxlink:/.test(body) || /\bxlink:/.test(sectionText)) rootAttrs.push(`xmlns:xlink="${XLINK_NS}"`);
  if (withSchemaLocation && schema) {
    rootAttrs.push(`xsi:noNamespaceSchemaLocation="${schemaContextUrl(standard, schema, schemaLocation)}"`);
  }
  // Whitespace only between skeleton elements (element-only content); the
  // content sits right against the insertion point's tags, so the text of a
  // <para> is exactly what the LLM wrote (string(.) value checks see no
  // added spaces). The panel re-indents for display.
  const last = path.length - 1;
  const titled = new Set(placement.titled || []);
  const title = `<title>${SKELETON_TITLE_TEXT}</title>`;
  const lines = [];
  const sectionPaths = [];
  path.forEach((name, i) => {
    const open = `${indentOf(i)}<${name}${i === 0 && rootAttrs.length ? ` ${rootAttrs.join(' ')}` : ''}>`;
    if (i === 0 && section && last > 0) {
      lines.push(open);
      if (section.insertion) {
        if (sectionText) lines.push(`${indentOf(1)}${sectionText}`);
      } else {
        const rendered = metadataXml(section.tree, 1, `/${name}[1]`);
        lines.push(rendered.xml);
        sectionPaths.push(...rendered.paths);
      }
      return;
    }
    if (i === last) {
      lines.push(`${open}${titled.has(name) ? title : ''}${body}</${name}>`);
    } else {
      lines.push(open);
      if (titled.has(name)) lines.push(`${indentOf(i + 1)}${title}`);
    }
  });
  for (let i = last - 1; i >= 0; i -= 1) lines.push(`${indentOf(i)}</${path[i]}>`);
  const skeletonNodePaths = [];
  let prefix = '';
  for (const name of path) {
    prefix += `/${name}[1]`;
    skeletonNodePaths.push(prefix);
    if (titled.has(name)) {
      // The LLM's content never holds a <title> at this level (the prompt
      // says the application writes it), so the skeleton's is title[1].
      skeletonNodePaths.push(`${prefix}/title[1]`, `${prefix}/title[1]${SKELETON_TEXT_SUFFIX}`);
    }
  }
  return { xml: lines.join('\n'), skeletonNodePaths: [...skeletonNodePaths, ...sectionPaths] };
}
