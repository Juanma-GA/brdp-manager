// Rule test engine (Test rule, T1 of 4): runs an S1000D BREX rule, as stored
// in rule_approvals.rule_xml, on a short XML fragment and says whether the
// fragment complies. The verdict is always computed here, deterministically,
// never by an LLM. Pure module (no React, no API): importable from plain Node
// like src/prompts/, so scripts/test-rule-test-engine.mjs runs the real code.
//
//   runRuleOnFragment(ruleXml, format, fragmentXml, fragmentSchema, options) →
//     { status: 'accepted' | 'rejected' | 'not_executable',
//       violations: [{ ruleId, message, nodePaths }],
//       selectedNodePaths: [...],        // every node each executed path selected
//       notExecutableReason: string | null,
//       notExecutableParts: [{ ruleId, reason }] }
//
// A rule with several parts (a group, context blocks, a nonContextRule next
// to a structureObjectRule) runs every part it can: status comes from the
// parts that ran, and notExecutableReason/notExecutableParts report the parts
// that could not run. status is 'not_executable' only when no part ran.
// Reasons are short English sentences; the UI (T2) translates them.
//
// options.parseXml(text) → Document may be injected (it must throw on
// malformed XML); by default the global DOMParser is used (browser).
//
// ─── Semantics (checked against the real sources; origin in brackets) ──────
// Sources: [XSD42]/[XSD41] sources/S4.2/brex4.2.xsd, sources/S4.1/brex4.1.xsd;
// [XSD301] sources/S3.0.1/brex.xsd; [REF] src/api/brexToSchematron.js, the
// port of Docuneering's s1000d-brex-to-schematron.xsl that Generate uses for
// its Schematron output; [TPL] the Verified rules of the curated templates
// public/brdp-template-{4-2,4-1,3-0-1}.xlsx; [GEN] the generators' prompts
// (generateBREX*.js, src/prompts/ruleFormatRules.js, brex-schema-summary-*.json).
//
// | Topic                          | Behaviour                                                        | Origin |
// |--------------------------------|------------------------------------------------------------------|--------|
// | Rule element                   | 4.x structureObjectRule (objectPath, objectUse, objectValue*);  | XSD42/41 |
// |                                | 3.0.1 objrule (objpath, objuse, objval*)                         | XSD301 |
// | Flag, 4.x                      | allowedObjectFlag 0/1/2, default 2 when absent                   | XSD42/41 |
// | Flag, 3.0.1                    | objappl 0/1 only (type [01]), no default; absent = value check   | XSD301, REF, GEN |
// |                                | only (the same as 4.x flag 2)                                    |        |
// | Flag 0, no values              | every selected node is a violation                               | REF    |
// | Flag 0 + values                | every selected node whose value matches a listed value is a      | REF    |
// |                                | violation (the listed values are the forbidden ones)             |        |
// | Flag 1                         | only on a whole document (root dmodule, pm, dml, ddn, comment,   | encargo |
// |                                | dataUpdateFile, scormContentPackage, icnMetadataFile — the roots | schema cards |
// |                                | of the S1000D schemas); otherwise not executable                 |        |
// | Flag 1, path splits into       | for every node of <parent>, <step> (relative to it) must select  | REF    |
// | <parent>/<step> (safe pattern) | a node — with values, a node with an allowed value               |        |
// | Flag 1, path does not split    | the whole path must select a node (with values: one with an      | REF    |
// |                                | allowed value)                                                   |        |
// | Flag 2 (4.x) / no objappl      | without values never a violation; with values every selected     | XSD, REF |
// | (3.0.1)                        | node must match at least one listed value                        |        |
// | Node value                     | XPath string(.): the attribute value, or the element's text      | REF    |
// |                                | (all descendant text)                                            |        |
// | single                         | exact string equality, no whitespace normalisation               | REF    |
// |                                | 4.x valueAllowed; 3.0.1 val1. valueForm/valtype absent = single  | REF, GEN |
// | 3.0.1 single with val2         | not executable: REF reads val2 as a "conditional path", which    | XSD301 has no meaning |
// |                                | the XSD (xs:string) does not confirm                             |        |
// | range                          | 4.x valueAllowed "from~to" (one "~"); 3.0.1 val1..val2.          | REF    |
// |                                | Both bounds numbers: numeric comparison, a non-numeric value is  | deviation from REF, |
// |                                | outside. Both text: string comparison as REF. Mixed: not         | see note |
// |                                | executable                                                       |        |
// | pattern (4.x only)             | XPath/XSD regex (fontoxpath matches()). Anchoring is not         | REF (dialect); |
// |                                | confirmed (REF: unanchored, XSD patterns: anchored): the value   | anchoring unconfirmed |
// |                                | is tested both ways; if they disagree, that part is not          |        |
// |                                | executable                                                       |        |
// | valueTailoring                 | ignored (it says whether projects may tailor the values, not how | REF    |
// |                                | to check them)                                                   |        |
// | Context blocks                 | rules in contextRules@rulesContext / contextrules@context apply  | XSD, TPL, |
// |                                | only when the fragment's schema equals schemaNameFromContext()   | REF (xsi) |
// |                                | of the URL (flat or master); an empty attribute = general.       |        |
// |                                | Fragment schema: the fragmentSchema argument, else the root's    |        |
// |                                | xsi:noNamespaceSchemaLocation (what REF tests)                   |        |
// | nonContextRule (4.x element,   | nothing to execute → not executable                             | XSD42/41, GEN |
// | 3.0.1 comment)                 |                                                                  |        |
//
// Note on range: REF compares with `string(.) ge 'from' and string(.) le
// 'to'`, which misjudges numbers of different widths ("5" is not in "1~10"
// as strings). The engine compares numbers as numbers; for equal widths both
// agree. No curated template uses range or pattern.
//
// Beyond the table, a path is not executable when (reasons below): it reads
// another file (document()/doc()/collection()/doc-available()/unparsed-text*);
// it is not a node path (EXT-00019 in the 4.1 template is a boolean
// expression; REF turns such rules into no-ops); or it starts at an absolute
// root (/dmodule/…) that is not the fragment's root element — it could never
// select anything there, and "accepted" would be a verdict nobody computed.
// REF also treats a path that does not start with "/" (e.g. "(/a | /b)/c")
// as a no-op; the engine judges it by what it selects.
import fontoxpath from 'fontoxpath';
import { _isSafePattern, _splitTopLevel } from '../api/brexToSchematron.js';
import { schemaNameFromContext } from './ruleSchemaContext.js';
import { wrapRuleXmlFragment } from './ruleXmlFragment.js';

const FORMATS = {
  'BREX-4.2': {
    rule: 'structureObjectRule', path: 'objectPath', use: 'objectUse', value: 'objectValue',
    flagAttr: 'allowedObjectFlag', flags: ['0', '1', '2'], defaultFlag: '2',
    context: 'contextRules', contextAttr: 'rulesContext', nonContext: 'nonContextRule',
  },
  'BREX-3.0.1': {
    rule: 'objrule', path: 'objpath', use: 'objuse', value: 'objval',
    flagAttr: 'objappl', flags: ['0', '1'], defaultFlag: null,
    context: 'contextrules', contextAttr: 'context', nonContext: null,
  },
};
FORMATS['BREX-4.1'] = FORMATS['BREX-4.2'];

// Root elements of the S1000D schemas (the elements without parents in
// backend/schema_cards/*.json, minus xlink's arc/locator/resource and xcf's
// webcgm, which are not documents).
const WHOLE_DOCUMENT_ROOTS = new Set([
  'dmodule', 'pm', 'dml', 'ddn', 'comment', 'dataUpdateFile', 'scormContentPackage', 'icnMetadataFile',
]);

// Prefixes a rule path may use without the fragment declaring them.
const KNOWN_NAMESPACES = {
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  xlink: 'http://www.w3.org/1999/xlink',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://www.purl.org/dc/elements/1.1/',
};

const XPATH_LANGUAGE = fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE;
const OTHER_FILE_RE = /\b(?:document|doc|doc-available|collection|unparsed-text(?:-lines|-available)?)\s*\(/;
const REASON = {
  otherFile: 'The rule reads another file (document()), which is not available in a test fragment.',
  nonContext: 'This rule has no XPath to execute (nonContextRule).',
  mandatory: 'A mandatory-node rule can only be judged on a whole data module.',
  xpath: (message) => `XPath error: ${message}`,
  valueForm: (form) => `Value check '${form}' is not supported by the test engine.`,
  format: (format) => `Rule format '${format || '(none)'}' is not supported by the test engine; only S1000D BREX 4.2, 4.1 and 3.0.1 rules can be tested.`,
  fragmentXml: (message) => `The test fragment is not well-formed XML: ${message}`,
  ruleXml: (message) => `The rule is not well-formed XML: ${message}`,
  noRule: (element) => `The rule contains no <${element}> to execute.`,
  emptyPath: (element) => `The rule's <${element}> is empty.`,
  badFlag: (attr, value, allowed) => `${attr}="${value}" is not a valid value (only ${allowed.join(', ')}).`,
  notNodes: (kind) => `The rule's path does not select nodes (it returns ${kind}), so there is nothing to judge.`,
  absoluteRoot: (name, root) => `The rule's path starts at /${name}, but this fragment's root element is <${root}>; it can only be judged on a fragment whose root is <${name}>.`,
  schemaUnknown: (schema) => `This rule applies only to the ${schema} schema, and the fragment's schema is not known.`,
  otherSchema: (schemas, schema) => `This rule applies only to the ${schemas.join(', ')} schema${schemas.length > 1 ? 's' : ''}; this fragment belongs to the ${schema} schema.`,
  missingValue: (element, attr) => `An <${element}> has no ${attr} to compare with.`,
  badRange: (text) => `Range '${text}' is not in the form from~to.`,
  mixedRange: (from, to) => `Range '${from}~${to}' mixes a number and text; the comparison is not confirmed.`,
  pattern: (pattern, value) => `Pattern '${pattern}' matches only part of the value '${value}'; whether a pattern must match the whole value is not confirmed.`,
};

class NotExecutable extends Error {}

function defaultParseXml(text) {
  if (typeof DOMParser === 'undefined') throw new Error('No XML parser available.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    // Chromium wraps the message: "This page contains the following errors:…Below is a rendering…"
    const text = (error.textContent || 'parse error')
      .replace(/^[\s\S]*?following errors:\s*/, '')
      .replace(/Below is a rendering[\s\S]*$/, '');
    throw new Error(text.trim().split('\n')[0]);
  }
  return doc;
}

// fontoxpath error messages can start with the expression and a caret line;
// keep the line with the error code.
function xpathErrorMessage(err) {
  const text = String(err?.message || err || '');
  const line = text.split('\n').find((l) => /\b[A-Z]{4}\d{4}\b/.test(l));
  return (line || text.split('\n')[0]).replace(/^Error:\s*/, '').trim();
}

function childElements(el, name) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === name) out.push(n);
  return out;
}

function localName(node) {
  return node.localName || String(node.nodeName).replace(/^.*:/, '');
}

// XPath-like path of a node for highlighting: /dmodule[1]/content[1]/para[2]/@x
function nodePath(node) {
  if (!node) return '';
  if (node.nodeType === 2) return `${nodePath(node.ownerElement)}/@${node.nodeName}`;
  if (node.nodeType === 9) return '/';
  const parent = node.parentNode;
  const prefix = parent && parent.nodeType === 1 ? nodePath(parent) : '';
  if (node.nodeType === 1) {
    let index = 1;
    for (let s = node.previousSibling; s; s = s.previousSibling) if (s.nodeType === 1 && s.nodeName === node.nodeName) index += 1;
    return `${prefix}/${node.nodeName}[${index}]`;
  }
  let index = 1;
  for (let s = node.previousSibling; s; s = s.previousSibling) if (s.nodeType === node.nodeType) index += 1;
  const test = node.nodeType === 8 ? 'comment()' : node.nodeType === 7 ? 'processing-instruction()' : 'text()';
  return `${prefix}/${test}[${index}]`;
}

// Names of the absolute location paths in an expression ("/dmodule/…" →
// "dmodule"), outside string literals. A "/" is absolute when nothing that
// ends an operand precedes it (a name, "]", ")", "*", "."), or when the word
// before it is an operator keyword.
const OPERATOR_WORDS = new Set([
  'and', 'or', 'div', 'mod', 'idiv', 'return', 'then', 'else', 'in', 'satisfies', 'eq', 'ne', 'lt', 'le',
  'gt', 'ge', 'to', 'union', 'intersect', 'except', 'is',
]);
function absoluteRootNames(expression) {
  const names = [];
  let quote = '';
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch !== '/') continue;
    if (expression[i + 1] === '/') { i += 1; continue; }
    let j = i - 1;
    while (j >= 0 && /\s/.test(expression[j])) j -= 1;
    const prev = j >= 0 ? expression[j] : '';
    if (/[\w.\-*\])}]/.test(prev)) {
      if (!/[A-Za-z]/.test(prev)) continue;
      let k = j;
      while (k >= 0 && /[\w.-]/.test(expression[k])) k -= 1;
      if (!OPERATOR_WORDS.has(expression.slice(k + 1, j + 1))) continue;
    }
    const m = /^\s*((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)(?!\s*(?:::|\())/.exec(expression.slice(i + 1));
    if (m) names.push(m[1].replace(/^.*:/, ''));
  }
  return names;
}

function textOf(el) {
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

// One matcher per value element: node value → boolean. Throws NotExecutable.
function buildValueMatcher(valueEl, spec, evaluate) {
  const is301 = spec.value === 'objval';
  const form = (is301 ? valueEl.getAttribute('valtype') : valueEl.getAttribute('valueForm')) || 'single';
  const attr = (name) => valueEl.getAttribute(name);
  if (form === 'single') {
    if (is301 && attr('val2')) throw new NotExecutable(REASON.valueForm('single with val2'));
    const expected = is301 ? attr('val1') : attr('valueAllowed');
    if (expected === null) throw new NotExecutable(REASON.missingValue(spec.value, is301 ? 'val1' : 'valueAllowed'));
    return (value) => value === expected;
  }
  if (form === 'range') {
    let from;
    let to;
    if (is301) {
      from = attr('val1');
      to = attr('val2');
      if (from === null || to === null) throw new NotExecutable(REASON.badRange(`${from ?? ''}~${to ?? ''}`));
    } else {
      const text = attr('valueAllowed') ?? '';
      const parts = text.split('~');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new NotExecutable(REASON.badRange(text));
      [from, to] = parts;
    }
    const isNumber = (v) => v.trim() !== '' && Number.isFinite(Number(v));
    if (isNumber(from) && isNumber(to)) {
      return (value) => isNumber(value) && Number(value) >= Number(from) && Number(value) <= Number(to);
    }
    if (isNumber(from) !== isNumber(to)) throw new NotExecutable(REASON.mixedRange(from, to));
    return (value) => value >= from && value <= to;
  }
  if (form === 'pattern' && !is301) {
    const pattern = attr('valueAllowed');
    if (pattern === null) throw new NotExecutable(REASON.missingValue(spec.value, 'valueAllowed'));
    return (value) => {
      const partial = evaluate('matches($v, $p)', null, { v: value, p: pattern }, 'boolean');
      const whole = evaluate('matches($v, $p)', null, { v: value, p: `^(${pattern})$` }, 'boolean');
      if (partial !== whole) throw new NotExecutable(REASON.pattern(pattern, value));
      return whole;
    };
  }
  throw new NotExecutable(REASON.valueForm(form));
}

function runPart(part, spec, doc, evaluate) {
  const pathEl = childElements(part.element, spec.path)[0];
  const expression = pathEl ? String(pathEl.textContent || '').trim() : '';
  if (!expression) throw new NotExecutable(REASON.emptyPath(spec.path));
  if (OTHER_FILE_RE.test(expression.replace(/'[^']*'|"[^"]*"/g, "''"))) throw new NotExecutable(REASON.otherFile);

  const rawFlag = pathEl.getAttribute(spec.flagAttr);
  const flag = rawFlag === null || rawFlag === '' ? spec.defaultFlag : rawFlag.trim();
  if (flag !== null && !spec.flags.includes(flag)) throw new NotExecutable(REASON.badFlag(spec.flagAttr, flag, spec.flags));

  const matchers = childElements(part.element, spec.value).map((v) => buildValueMatcher(v, spec, evaluate));
  const hasValues = matchers.length > 0;
  const root = doc.documentElement;
  for (const name of absoluteRootNames(expression)) {
    if (name !== localName(root)) throw new NotExecutable(REASON.absoluteRoot(name, root.nodeName));
  }
  if (flag === '1' && !WHOLE_DOCUMENT_ROOTS.has(localName(root))) throw new NotExecutable(REASON.mandatory);

  const selected = evaluate(expression, doc, null, 'nodes');
  const valueOf = (node) => evaluate('string(.)', node, null, 'string');
  const matches = (node) => {
    const value = valueOf(node);
    return matchers.some((m) => m(value));
  };

  let offending = [];
  if (flag === '0') {
    offending = hasValues ? selected.filter(matches) : selected;
  } else if (flag === '1') {
    const split = _splitTopLevel(expression);
    if (split && _isSafePattern(split.parent)) {
      for (const parentNode of evaluate(split.parent, doc, null, 'nodes')) {
        const found = evaluate(split.step, parentNode, null, 'nodes');
        const ok = hasValues ? found.some(matches) : found.length > 0;
        if (!ok) offending.push(...(found.length ? found : [parentNode]));
      }
    } else {
      const ok = hasValues ? selected.some(matches) : selected.length > 0;
      if (!ok) offending = selected.length ? selected : [root];
    }
  } else if (hasValues) {
    offending = selected.filter((node) => !matches(node));
  }
  return {
    selectedNodePaths: selected.map(nodePath),
    violation: offending.length
      ? { ruleId: part.ruleId, message: textOf(childElements(part.element, spec.use)[0]), nodePaths: [...new Set(offending.map(nodePath))] }
      : null,
  };
}

function makeEvaluator(doc) {
  const declared = {};
  const root = doc.documentElement;
  for (const a of Array.from(root.attributes || [])) {
    if (a.name.startsWith('xmlns:')) declared[a.name.slice(6)] = a.value;
  }
  const options = {
    language: XPATH_LANGUAGE,
    namespaceResolver: (prefix) => (prefix ? declared[prefix] ?? KNOWN_NAMESPACES[prefix] ?? null : null),
  };
  const { evaluateXPath } = fontoxpath;
  return (expression, contextNode, variables, kind) => {
    try {
      if (kind === 'boolean') return fontoxpath.evaluateXPathToBoolean(expression, contextNode, null, variables, options);
      if (kind === 'string') return fontoxpath.evaluateXPathToString(expression, contextNode, null, variables, options);
      const items = evaluateXPath(expression, contextNode, null, variables, evaluateXPath.ALL_RESULTS_TYPE, options);
      const nonNode = items.find((item) => item === null || typeof item !== 'object' || typeof item.nodeType !== 'number');
      if (nonNode !== undefined) throw new NotExecutable(REASON.notNodes(typeof nonNode === 'boolean' ? 'a boolean' : typeof nonNode === 'number' ? 'a number' : 'a value'));
      return items;
    } catch (err) {
      if (err instanceof NotExecutable) throw err;
      throw new NotExecutable(REASON.xpath(xpathErrorMessage(err)));
    }
  };
}

// The rule parts, in document order: every rule element (with the schema of
// its context block, if any) and every nonContextRule (4.x element, 3.0.1
// comment).
function collectParts(ruleRoot, spec) {
  const parts = [];
  const walk = (node, schema) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 8 && !spec.nonContext && /^\s*nonContextRule\b/.test(n.data)) {
        const id = /id="([^"]*)"/.exec(n.data);
        parts.push({ kind: 'nonContext', ruleId: id ? id[1] : null });
      }
      if (n.nodeType !== 1) continue;
      if (n.nodeName === spec.rule) {
        const ref = childElements(n, 'brDecisionRef')[0];
        parts.push({ kind: 'rule', element: n, schema, ruleId: n.getAttribute('id') || ref?.getAttribute('brDecisionIdentNumber') || null });
      } else if (spec.nonContext && n.nodeName === spec.nonContext) {
        parts.push({ kind: 'nonContext', ruleId: n.getAttribute('id') || null });
      } else if (n.nodeName === spec.context) {
        const url = (n.getAttribute(spec.contextAttr) || '').trim();
        walk(n, url ? schemaNameFromContext(url) : schema);
      } else {
        walk(n, schema);
      }
    }
  };
  walk(ruleRoot, null);
  parts.forEach((p, i) => { if (!p.ruleId) p.ruleId = `rule ${i + 1}`; });
  return parts;
}

function notExecutable(reason) {
  return { status: 'not_executable', violations: [], selectedNodePaths: [], notExecutableReason: reason, notExecutableParts: [] };
}

export function runRuleOnFragment(ruleXml, format, fragmentXml, fragmentSchema = null, options = {}) {
  const spec = FORMATS[format];
  if (!spec) return notExecutable(REASON.format(format));
  const parseXml = options.parseXml || defaultParseXml;

  let doc;
  try {
    doc = parseXml(String(fragmentXml || ''));
    if (!doc?.documentElement) throw new Error('no root element');
  } catch (err) {
    return notExecutable(REASON.fragmentXml(err.message));
  }
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch (err) {
    return notExecutable(REASON.ruleXml(err.message));
  }

  const parts = collectParts(ruleDoc.documentElement, spec);
  if (!parts.length) return notExecutable(REASON.noRule(spec.rule));

  const xsi = doc.documentElement.getAttributeNS
    ? doc.documentElement.getAttributeNS(KNOWN_NAMESPACES.xsi, 'noNamespaceSchemaLocation')
    : null;
  const schema = fragmentSchema || (xsi ? schemaNameFromContext(xsi) : null);
  const evaluate = makeEvaluator(doc);

  const violations = [];
  const selected = [];
  const notRun = [];
  const outOfScope = [];
  let ran = 0;
  for (const part of parts) {
    try {
      if (part.kind === 'nonContext') throw new NotExecutable(REASON.nonContext);
      if (part.schema && !schema) throw new NotExecutable(REASON.schemaUnknown(part.schema));
      if (part.schema && part.schema !== schema) { outOfScope.push(part.schema); continue; }
      const result = runPart(part, spec, doc, evaluate);
      ran += 1;
      selected.push(...result.selectedNodePaths);
      if (result.violation) violations.push(result.violation);
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
      notRun.push({ ruleId: part.ruleId, reason: err.message });
    }
  }

  if (!ran && !notRun.length) {
    notRun.push({ ruleId: parts[0].ruleId, reason: REASON.otherSchema([...new Set(outOfScope)], schema) });
  }
  const reason = notRun.length === 0
    ? null
    : parts.length === 1
      ? notRun[0].reason
      : notRun.map((p) => `${p.ruleId}: ${p.reason}`).join(' ');
  return {
    status: ran === 0 ? 'not_executable' : violations.length ? 'rejected' : 'accepted',
    violations,
    selectedNodePaths: [...new Set(selected)],
    notExecutableReason: reason,
    notExecutableParts: notRun,
  };
}
