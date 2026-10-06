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
//       notExecutableReason: { code, params } | null,   // see REASON below
//       notExecutableParts: [{ ruleId, reason: { code, params } }],
//       outOfScopeSchemas: [...],        // context blocks skipped: other schema
//       conditions: [{ ruleId, holds, flag, path }] } // parts whose path is a
//                                        // true/false condition (see the table)
//
// A rule with several parts (a group, context blocks, a nonContextRule next
// to a structureObjectRule) runs every part it can: status comes from the
// parts that ran, and notExecutableReason/notExecutableParts report the parts
// that could not run. status is 'not_executable' only when no part ran --
// except when every part sits in a context block of ANOTHER schema: the rule
// does not apply to that fragment, so it is 'accepted' (T2), with
// outOfScopeSchemas naming those schemas.
// Reasons are { code, params } (T3); the UI translates them.
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
// |                                | Both bounds numbers: number(.) between them (a non-numeric value | REF (as |
// |                                | is outside). Both text: string comparison. Mixed: Generate       | changed in |
// |                                | compares as text and writes a warning comment; the test gives    | T2) |
// |                                | no verdict (not executable)                                      |        |
// | pattern (4.x only)             | XPath/XSD regex, anchored like an XSD pattern facet:             | REF (as |
// |                                | matches(string(.), '^(pattern)$')                                | changed in T2) |
// | valueTailoring                 | ignored (it says whether projects may tailor the values, not how | REF    |
// |                                | to check them)                                                   |        |
// | Context blocks                 | as s1kd-brexcheck (//contextRules[not(@rulesContext) or          | s1kd-brexcheck, |
// |                                | @rulesContext=$schema]): a block WITHOUT the attribute is        | XSD, TPL, |
// |                                | general; rules in contextRules@rulesContext / contextrules@      | REF (xsi) |
// |                                | context apply only when the fragment's schema equals             |        |
// |                                | schemaNameFromContext() of the URL (flat, master or the project's|        |
// |                                | pattern). An EMPTY attribute (rulesContext="") is NOT general: it|        |
// |                                | equals no schema, so its rules apply nowhere -- not executable,  |        |
// |                                | reason empty_schema_context (Generate never writes one: it puts  |        |
// |                                | such rules in the general block, without the attribute).         |        |
// |                                | Fragment schema: the fragmentSchema argument, else the root's    |        |
// |                                | xsi:noNamespaceSchemaLocation (what REF tests). A fragment of    |        |
// |                                | another schema, with no part left to run: accepted (the rule    | REF (its |
// |                                | does not apply there)                                            | not(xsi=…) or) |
// | nonContextRule (4.x element,   | nothing to execute → not executable                             | XSD42/41, GEN |
// | 3.0.1 comment)                 |                                                                  |        |
//
// | Boolean path (s1kd-brexcheck) | a path that returns true/false instead of nodes (EXT-00019's    | s1kd-brexcheck |
// |                                | //updateCode[…] and (//zoneSpec or …)) is a condition on the     | is_invalid() |
// |                                | whole document: flag 0 / objappl 0 rejects when it is true,      |        |
// |                                | flag 1 / objappl 1 when it is false, flag 2 / no objappl never   |        |
// |                                | (values are ignored, as there). No node is selected: the result  |        |
// |                                | carries conditions: [{ruleId, holds, flag}] instead             |        |
//
// Value checks (single/range/pattern) are not reimplemented here: the engine
// evaluates the very XPath expression brexToSchematron.js writes into the
// Schematron (_valueCheckXPath), so a value the test accepts is a value the
// generated Schematron accepts. No curated template uses range or pattern.
//
// Beyond the table, a path is not executable when (reasons below): it reads
// another file (document()/doc()/collection()/doc-available()/unparsed-text*);
// it returns a number or a string (a true/false result is a condition, see
// the table); or it is a node path every alternative of which ("a | b") is
// anchored only at absolute roots (/dmodule/…, predicates included) that
// are not the fragment's root element — it could never select anything
// there, and "accepted" would be a verdict nobody computed. One alternative
// that can look at the document is enough (the others select nothing), and
// a condition is never refused for this: /ddn on a <dmodule> is false, as in
// s1kd-brexcheck.
// A path starting with "(" ("(/a | /b)/c") is a location path for both
// (REF treated it as a no-op until T2).
//
// Test de reglas T4: Schematron (SCH-DITA) goes through the same three entry
// points -- runRuleOnFragment, analyzeRule, describeRule -- with the same
// result shapes; its semantics (a table like the one above, with its
// origin) and implementation live in utils/ruleTestSchematron.js. Every
// result also carries `warnings` (T4): Schematron assert/report with
// role="warning"/"info" that fired (they never reject), [] for BREX.
import fontoxpath from 'fontoxpath';
import { _isContextPattern, _normSpace, _splitTopLevel, _valueCheckXPath } from '../api/brexToSchematron.js';
import { schemaNameFromContext } from './ruleSchemaContext.js';
import { wrapRuleXmlFragment } from './ruleXmlFragment.js';
import {
  KNOWN_NAMESPACES,
  NotExecutable,
  OTHER_FILE_RE,
  EXTERNAL_PLACEHOLDER_RE,
  XPATH_LANGUAGE,
  combinedReason,
  localName,
  nodePath,
  parseXmlDocument,
  reason,
  stripLiterals,
  withoutPredicates,
  xpathErrorMessage,
} from './ruleTestCommon.js';
import { analyzeSchematron, describeSchematron, runSchematronOnFragment, schematronAcceptanceDetails, schematronRuleParts, SCHEMATRON_FORMATS } from './ruleTestSchematron.js';
import { checkRuleFormat, extractXPathNames } from '../validation/schemaValidation.js';

export { nodePath, parseXmlDocument };

export const RULE_TEST_FORMATS = ['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1', ...SCHEMATRON_FORMATS];

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

const REASON = {
  otherFile: (fn) => reason('external_document', { fn }),
  placeholder: (placeholder) => reason('external_placeholder', { placeholder }),
  nonContext: () => reason('non_context_rule'),
  mandatory: () => reason('mandatory_whole_document'),
  xpath: (message) => reason('xpath_error', { message }),
  valueForm: (form) => reason('unsupported_value_form', { form }),
  format: (format) => reason('unsupported_format', { format: format || '(none)' }),
  fragmentXml: (message) => reason('fragment_not_well_formed', { message }),
  ruleXml: (message) => reason('rule_not_well_formed', { message }),
  noRule: (element) => reason('no_rule_element', { element }),
  emptyPath: (element) => reason('empty_path', { element }),
  badFlag: (attr, value, allowed) => reason('invalid_flag', { attr, value, allowed: allowed.join(', ') }),
  // kind: 'boolean' | 'number' | 'value'
  notNodes: (kind) => reason('path_not_nodes', { kind }),
  absoluteRoot: (name, root) => reason('absolute_root', { name, root }),
  schemaUnknown: (schema) => reason('schema_unknown', { schema }),
  emptyContext: (element, attr) => reason('empty_schema_context', { element, attr }),
  missingValue: (element, attr) => reason('missing_value', { element, attr }),
  badRange: (text) => reason('bad_range', { text }),
  mixedRange: (from, to) => reason('mixed_range', { from, to }),
};

function childElements(el, name) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === name) out.push(n);
  return out;
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

// The top-level alternatives of a path ("a | b" → ["a", "b"]), outside
// literals, brackets and parentheses; a pair of parentheses around the
// whole expression is looked through ("(//a | //b)").
function topLevelAlternatives(expression) {
  let text = expression.trim();
  const wrapped = () => {
    if (!text.startsWith('(') || !text.endsWith(')')) return false;
    let depth = 0;
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      if (ch === ')') { depth -= 1; if (depth === 0 && i < text.length - 1) return false; }
    }
    return true;
  };
  while (wrapped()) text = text.slice(1, -1).trim();
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === '|' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.length > 1 ? parts.flatMap(topLevelAlternatives) : parts;
}

// The first foreign root name when EVERY alternative of a node path is
// anchored only at roots other than `rootName` (each absolute path in it,
// predicates included, starts at another root); null when at least one
// alternative can look at this document.
function foreignRootAlternatives(expression, rootName) {
  let first = null;
  for (const alternative of topLevelAlternatives(expression)) {
    const names = absoluteRootNames(alternative);
    if (!names.length || names.some((n) => n === rootName)) return null;
    first = first || names[0];
  }
  return first;
}

function textOf(el) {
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

// One matcher per value element: node → boolean. The check itself is the
// XPath expression brexToSchematron.js writes into the Schematron
// (_valueCheckXPath), evaluated with fontoxpath on the node, so the test and
// Generate judge a value the same way. Only the attribute shapes are checked
// here first. Throws NotExecutable.
function buildValueMatcher(valueEl, spec, evaluate) {
  const is301 = spec.value === 'objval';
  const form = (is301 ? valueEl.getAttribute('valtype') : valueEl.getAttribute('valueForm')) || 'single';
  const attr = (name) => valueEl.getAttribute(name);
  // hasAttribute, not getAttribute() === null: some DOMs (xmldom) return
  // "" for a missing attribute.
  const missing = (name) => !valueEl.hasAttribute(name);
  if (form === 'single') {
    if (is301 && attr('val2')) throw new NotExecutable(REASON.valueForm('single with val2'));
    if (missing(is301 ? 'val1' : 'valueAllowed')) {
      throw new NotExecutable(REASON.missingValue(spec.value, is301 ? 'val1' : 'valueAllowed'));
    }
  } else if (form === 'range') {
    if (is301) {
      if (missing('val1') || missing('val2')) throw new NotExecutable(REASON.badRange(`${attr('val1') ?? ''}~${attr('val2') ?? ''}`));
    } else {
      const text = attr('valueAllowed') ?? '';
      const parts = text.split('~');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new NotExecutable(REASON.badRange(text));
    }
  } else if (form === 'pattern' && !is301) {
    if (missing('valueAllowed')) throw new NotExecutable(REASON.missingValue(spec.value, 'valueAllowed'));
  } else {
    throw new NotExecutable(REASON.valueForm(form));
  }
  const check = _valueCheckXPath(valueEl);
  if (check.mixedRange) throw new NotExecutable(REASON.mixedRange(check.from, check.to));
  return (node) => evaluate(`boolean(${check.expr})`, node, null, 'boolean');
}

// The checks that need no fragment: a path to run, no other file, a valid
// flag. Shared by runPart and analyzeRule. Throws NotExecutable.
// Mejoras A, Part 3: a rule element with more than one path or use is not
// a rule of its format (the BREX XSDs allow one of each); nothing is run on
// it -- never only its first path.
function multipleChildren(part, spec) {
  for (const child of [spec.path, spec.use]) {
    const count = childElements(part.element, child).length;
    if (count > 1) return reason('rule_format', { problem: 'rule_format_multiple', element: spec.rule, child, count });
  }
  return null;
}

// The rule element's children in order, one group per path: [{ path, use,
// values }] -- a valid rule has one group; ruleStructure keeps every path
// of an invalid one (Compare must not show only the first).
export function pathGroups(element, spec) {
  const groups = [];
  for (let n = element.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    if (n.nodeName === spec.path) groups.push({ path: n, use: null, values: [] });
    else if (n.nodeName === spec.use && groups.length) groups[groups.length - 1].use = n;
    else if (n.nodeName === spec.value && groups.length) groups[groups.length - 1].values.push(n);
  }
  return groups;
}

function partBasics(part, spec) {
  const multiple = multipleChildren(part, spec);
  if (multiple) throw new NotExecutable(multiple);
  const pathEl = childElements(part.element, spec.path)[0];
  const expression = pathEl ? String(pathEl.textContent || '').trim() : '';
  if (!expression) throw new NotExecutable(REASON.emptyPath(spec.path));
  const otherFile = OTHER_FILE_RE.exec(expression.replace(/'[^']*'|"[^"]*"/g, "''"));
  if (otherFile) throw new NotExecutable(REASON.otherFile(`${otherFile[1]}()`));
  const placeholder = EXTERNAL_PLACEHOLDER_RE.exec(expression);
  if (placeholder) throw new NotExecutable(REASON.placeholder(placeholder[0]));

  const rawFlag = pathEl.getAttribute(spec.flagAttr);
  const flag = rawFlag === null || rawFlag === '' ? spec.defaultFlag : rawFlag.trim();
  if (flag !== null && !spec.flags.includes(flag)) throw new NotExecutable(REASON.badFlag(spec.flagAttr, flag, spec.flags));
  return { expression, flag };
}

function runPart(part, spec, doc, evaluate) {
  const { expression, flag } = partBasics(part, spec);
  const matchers = childElements(part.element, spec.value).map((v) => buildValueMatcher(v, spec, evaluate));
  const hasValues = matchers.length > 0;
  const root = doc.documentElement;
  const evaluated = evaluate(expression, doc, null, 'path');
  // A node path none of whose alternatives can look at this document (each
  // one anchored at another root: /dmodule/content//thead on a <table>,
  // //qty[/dmodule/content/proced] on a <proced>) never selects anything
  // here, and "accepted" would be a verdict nobody worked out. One
  // alternative that can is enough: the others simply select nothing
  // (/pm/… | //dmStatus/… on a <dmodule>). A condition is never refused for
  // this: /ddn on a <dmodule> is false, as in s1kd-brexcheck.
  if (evaluated.condition === undefined) {
    const foreign = foreignRootAlternatives(expression, localName(root));
    if (foreign) throw new NotExecutable(REASON.absoluteRoot(foreign, root.nodeName));
  }
  if (flag === '1' && !WHOLE_DOCUMENT_ROOTS.has(localName(root))) throw new NotExecutable(REASON.mandatory());

  const message = () => textOf(childElements(part.element, spec.use)[0]);
  if (evaluated.condition !== undefined) {
    // s1kd-brexcheck: flag 0 rejects when true, flag 1 when false, flag 2
    // (or no objappl) never; values do not apply to a condition.
    const holds = evaluated.condition;
    const violated = (flag === '0' && holds) || (flag === '1' && !holds);
    return {
      selectedNodePaths: [],
      condition: { ruleId: part.ruleId, holds, flag, path: expression },
      violation: violated ? { ruleId: part.ruleId, message: message(), nodePaths: [], condition: true } : null,
    };
  }
  const selected = evaluated.nodes;
  const matches = (node) => matchers.some((m) => m(node));

  let offending = [];
  if (flag === '0') {
    offending = hasValues ? selected.filter(matches) : selected;
  } else if (flag === '1') {
    const split = _splitTopLevel(expression);
    if (split && _isContextPattern(split.parent)) {
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
      ? { ruleId: part.ruleId, message: message(), nodePaths: [...new Set(offending.map(nodePath))] }
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
      const items = evaluateXPath(expression, contextNode, null, variables, evaluateXPath.ALL_RESULTS_TYPE, options);
      // A path that is a condition (s1kd-brexcheck evaluates it as such).
      if (kind === 'path' && items.length === 1 && typeof items[0] === 'boolean') return { condition: items[0] };
      const nonNode = items.find((item) => item === null || typeof item !== 'object' || typeof item.nodeType !== 'number');
      if (nonNode !== undefined) throw new NotExecutable(REASON.notNodes(typeof nonNode === 'boolean' ? 'boolean' : typeof nonNode === 'number' ? 'number' : 'value'));
      return kind === 'path' ? { nodes: items } : items;
    } catch (err) {
      if (err instanceof NotExecutable) throw err;
      throw new NotExecutable(REASON.xpath(xpathErrorMessage(err)));
    }
  };
}

// The rule parts, in document order: every rule element (with the schema of
// its context block, if any) and every nonContextRule (4.x element, 3.0.1
// comment). A part inside a context block whose scope attribute is present
// but empty carries emptyContext: true -- s1kd-brexcheck never applies it
// (see the table: rulesContext="" equals no schema).
function collectParts(ruleRoot, spec, schemaLocation = null) {
  const parts = [];
  const walk = (node, schema, emptyContext) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 8 && !spec.nonContext && /^\s*nonContextRule\b/.test(n.data)) {
        const id = /id="([^"]*)"/.exec(n.data);
        parts.push({ kind: 'nonContext', ruleId: id ? id[1] : null, emptyContext });
      }
      if (n.nodeType !== 1) continue;
      if (n.nodeName === spec.rule) {
        const ref = childElements(n, 'brDecisionRef')[0];
        parts.push({ kind: 'rule', element: n, schema, emptyContext, ruleId: n.getAttribute('id') || ref?.getAttribute('brDecisionIdentNumber') || null });
      } else if (spec.nonContext && n.nodeName === spec.nonContext) {
        parts.push({ kind: 'nonContext', ruleId: n.getAttribute('id') || null, emptyContext });
      } else if (n.nodeName === spec.context) {
        // hasAttribute, not getAttribute: xmldom gives "" for a missing one.
        const url = (n.getAttribute(spec.contextAttr) || '').trim();
        if (url) walk(n, schemaNameFromContext(url, schemaLocation), false);
        else if (n.hasAttribute(spec.contextAttr)) walk(n, null, true);
        else walk(n, schema, emptyContext);
      } else {
        walk(n, schema, emptyContext);
      }
    }
  };
  walk(ruleRoot, null, false);
  parts.forEach((p, i) => { if (!p.ruleId) p.ruleId = `rule ${i + 1}`; });
  return parts;
}

function notExecutable(r) {
  return { status: 'not_executable', violations: [], warnings: [], selectedNodePaths: [], notExecutableReason: r, notExecutableParts: [], outOfScopeSchemas: [], conditions: [] };
}

export function runRuleOnFragment(ruleXml, format, fragmentXml, fragmentSchema = null, options = {}) {
  if (SCHEMATRON_FORMATS.includes(format)) return runSchematronOnFragment(ruleXml, fragmentXml, options);
  const spec = FORMATS[format];
  if (!spec) return notExecutable(REASON.format(format));
  const parseXml = options.parseXml || parseXmlDocument;

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

  const parts = collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null);
  if (!parts.length) return notExecutable(REASON.noRule(spec.rule));

  const xsi = doc.documentElement.getAttributeNS
    ? doc.documentElement.getAttributeNS(KNOWN_NAMESPACES.xsi, 'noNamespaceSchemaLocation')
    : null;
  const schema = fragmentSchema || (xsi ? schemaNameFromContext(xsi, options.schemaLocation || null) : null);
  const evaluate = makeEvaluator(doc);

  const violations = [];
  const selected = [];
  const notRun = [];
  const outOfScope = [];
  const conditions = [];
  let ran = 0;
  for (const part of parts) {
    try {
      if (part.emptyContext) throw new NotExecutable(REASON.emptyContext(spec.context, spec.contextAttr));
      if (part.kind === 'nonContext') throw new NotExecutable(REASON.nonContext());
      if (part.schema && !schema) throw new NotExecutable(REASON.schemaUnknown(part.schema));
      if (part.schema && part.schema !== schema) { outOfScope.push(part.schema); continue; }
      const result = runPart(part, spec, doc, evaluate);
      ran += 1;
      selected.push(...result.selectedNodePaths);
      if (result.condition) conditions.push(result.condition);
      if (result.violation) violations.push(result.violation);
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
      notRun.push({ ruleId: part.ruleId, reason: err.reason });
    }
  }

  // Every part is scoped to other schemas: the rule does not apply to this
  // fragment, which is exactly what a BREX validator says -- accepted, with
  // outOfScopeSchemas telling why (T2: "an example of another schema shows
  // the rule does not apply there").
  const notApplicable = ran === 0 && notRun.length === 0;
  const notExecutableReason = combinedReason(notRun, parts.length);
  return {
    status: notApplicable ? 'accepted' : ran === 0 ? 'not_executable' : violations.length ? 'rejected' : 'accepted',
    violations,
    warnings: [],
    selectedNodePaths: [...new Set(selected)],
    notExecutableReason,
    notExecutableParts: notRun,
    outOfScopeSchemas: [...new Set(outOfScope)],
    conditions,
  };
}

// T2b: what can be known about a rule without any fragment -- before the
// examples are even written, so the panel can show from the start why a
// rule cannot be tested. Every per-part check that does not depend on the
// fragment: format, well-formed rule, a rule element, nonContextRule, an
// empty path, another file (document()…), the flag, the value checks, and
// the path itself, evaluated once on an empty document of its own root
// (an XPath error, or an expression that returns a boolean/number instead
// of nodes). Not reported: mandatory-node rules (the examples are whole
// documents now) and schema scoping (the examples carry their schema).
//
//   analyzeRule(ruleXml, format, options) →
//     { status: 'executable' | 'partial' | 'not_executable',
//       reason: { code, params } | null,   // as notExecutableReason
//       parts: [{ ruleId, reason }],       // the parts that cannot run
//       total,                             // number of parts
//       warnings: [{ code, params }] }     // T4: runs anyway (Schematron
//                                          // XPath 3.x syntax in an XPath
//                                          // 2.0 project); [] for BREX
// options.standard (T4) is the project's standard.
export function analyzeRule(ruleXml, format, options = {}) {
  const none = (r) => ({ status: 'not_executable', reason: r, parts: [], total: 0, warnings: [] });
  const formatProblem = ruleFormatReason(ruleXml, format, options.parseXml || parseXmlDocument);
  if (formatProblem) return none(formatProblem);
  if (SCHEMATRON_FORMATS.includes(format)) return analyzeSchematron(ruleXml, options);
  const spec = FORMATS[format];
  if (!spec) return none(REASON.format(format));
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch (err) {
    return none(REASON.ruleXml(err.message));
  }
  const parts = collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null);
  if (!parts.length) return none(REASON.noRule(spec.rule));

  const notRun = [];
  for (const part of parts) {
    try {
      if (part.emptyContext) throw new NotExecutable(REASON.emptyContext(spec.context, spec.contextAttr));
      if (part.kind === 'nonContext') throw new NotExecutable(REASON.nonContext());
      const { expression } = partBasics(part, spec);
      const root = absoluteRootNames(expression)[0] || 'dmodule';
      const doc = parseXml(`<${root}/>`);
      const evaluate = makeEvaluator(doc);
      for (const v of childElements(part.element, spec.value)) buildValueMatcher(v, spec, evaluate);
      evaluate(expression, doc, null, 'path');
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
      notRun.push({ ruleId: part.ruleId, reason: err.reason });
    }
  }
  const notExecutableReason = combinedReason(notRun, parts.length);
  return {
    status: notRun.length === 0 ? 'executable' : notRun.length === parts.length ? 'not_executable' : 'partial',
    reason: notExecutableReason,
    parts: notRun,
    total: parts.length,
    warnings: [],
  };
}

// C3, Part 1d: stored XML that is not a rule of its format (an old
// "Paste rule" of just //&lt;emphasis&gt;, accepted before the format
// check existed) is never tested: analyzeRule -- which the panel, the
// recorded result and the Verify dialog all start from -- says
// rule_format {problem, ...params} up front, with
// checkRuleFormat's problem code (rule_format_missing, …) and parameters --
// the same check that now refuses it on save. Only well-formed XML is
// checked here; malformed XML keeps its own reason (rule_not_well_formed).
function ruleFormatReason(ruleXml, format, parseXml) {
  try {
    parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return null;
  }
  const result = checkRuleFormat(ruleXml, format);
  // Mejoras B, Part 4.3: repeated ids make the BREX invalid, but each rule
  // still runs -- a stored rule with them is tested as before.
  if (!result.ok && result.problem.code === 'rule_format_duplicate_ids') return null;
  return result.ok ? null : reason('rule_format', { problem: result.problem.code, ...result.problem.params });
}

// ─── describeRule (Test de reglas T3b, Part 1) ─────────────────────────────
// What a rule checks, read from its XML with the semantics table above --
// never from the Proposal and never by an LLM. The Test rule panel shows it
// in place of an explanation written by the LLM (which described the rule it
// was asked to test the Proposal against, not always the rule itself), and
// "Review with the assistant" sends it to the LLM as the ground truth of
// what the rule does. Statements are codes with parameters, translated like
// the not-executable reasons (utils/ruleTestReasons.js's
// formatRuleDescription, records.ruleTest.describe.*):
//   describe_forbidden {target, path}                  flag 0, no values
//   describe_document_must_contain {root, target, path}  flag 0, /R[not(//x)] on a
//                                                      document root (Mejoras C)
//   describe_document_must_not_contain {root, target, path}  /R[//x], flag 0
//   describe_forbidden_existence {target, path, joiner, conditions}  flag 0, a
//                                                      predicate of existence tests
//                                                      joined by and/or (Mejoras C)
//   describe_forbidden_values {target, values, path}   flag 0 with values
//   describe_forbidden_nesting {target, name, op, amount, mode, level, path}
//   describe_forbidden_ancestors / _children {target, name, op, amount, path}
//   describe_forbidden_length {target, op, amount, path}
//                                                      flag 0, a threshold on the last
//                                                      step (pathThreshold, Mejoras A)
//   describe_mandatory {parent, target, path}          flag 1, <parent>/<step>
//   describe_mandatory_values {parent, target, values, path}
//   describe_mandatory_somewhere {target, path}        flag 1, not divisible
//   describe_mandatory_somewhere_values {target, values, path}
//   describe_restricted_values {target, values, path}  flag 2 (or no objappl) with values
//   describe_allowed {target, path}                    flag 2 (or no objappl), no values:
//                                                      rejects nothing
//   describe_condition_forbidden {path, names}         a true/false path, flag 0 /
//                                                      objappl 0: rejects when true
//   describe_condition_required {path, names}          flag 1 / objappl 1: rejects when false
//   describe_condition_informative {path, names}       flag 2 / no objappl: never rejects
//   describe_non_context {}                            nonContextRule
//   describe_not_executable {reason}                   a part the engine cannot run
// `target` is the node the path points at ("<emphasis>", "@emphasisType"),
// or null when the path does not end in a plain name (then the text names
// the path itself). values: [{form:'single', value} | {form:'range', from,
// to} | {form:'pattern', pattern} | {form, unsupported:true}].
//
//   describeRule(ruleXml, format, options) →
//     { available: false } (unknown format / unparsable rule)
//     | { available: true,
//         statements: [{ ruleIds: [...], statement: {code, params}, schemas: [...] }],
//         cannotReject }   // no part can ever reject anything
// Identical statements that only differ by their context block (the copies
// {id}-{schema} of a rule limited to several schemas) are merged into one
// with all their schemas.

// The top-level "/" positions of a path, outside brackets and quotes.
function lastTopLevelStep(expression) {
  let depth = 0;
  let quote = '';
  let last = -1;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === '|' && depth === 0) return null; // alternatives: no single target
    else if (ch === '/' && depth === 0) last = i;
  }
  return expression.slice(last + 1).trim();
}

// "<name>" / "@name" for a path's last step, or null.
function pathTarget(expression) {
  const step = lastTopLevelStep(String(expression || '').trim());
  if (!step) return null;
  const bare = step.replace(/\[[\s\S]*$/, '').trim();
  const attr = /^(?:@|attribute::)((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)$/.exec(bare);
  if (attr) return `@${attr[1]}`;
  const el = /^(?:child::|descendant::|descendant-or-self::)?((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)$/.exec(bare);
  return el ? `<${el[1]}>` : null;
}

function describeValues(part, spec, valueElements = null) {
  const is301 = spec.value === 'objval';
  return (valueElements || childElements(part.element, spec.value)).map((v) => {
    const form = (is301 ? v.getAttribute('valtype') : v.getAttribute('valueForm')) || 'single';
    const attr = (name) => (v.hasAttribute(name) ? v.getAttribute(name) : '');
    if (form === 'single') return { form, value: is301 ? attr('val1') : attr('valueAllowed') };
    if (form === 'range') {
      if (is301) return { form, from: attr('val1'), to: attr('val2') };
      const [from = '', to = ''] = attr('valueAllowed').split('~');
      return { form, from, to };
    }
    if (form === 'pattern' && !is301) return { form, pattern: attr('valueAllowed') };
    return { form, unsupported: true };
  });
}

// Whether a part's path is a condition (true/false) or a node path, by
// evaluating it once on an empty document of its own root -- the same probe
// analyzeRule uses. Throws NotExecutable (an XPath error, a number…).
function isConditionPath(expression, parseXml) {
  const root = absoluteRootNames(expression)[0] || 'dmodule';
  const doc = parseXml(`<${root}/>`);
  return makeEvaluator(doc)(expression, doc, null, 'path').condition !== undefined;
}

// The names a condition mentions (elements as <x>, attributes as @x).
function conditionNames(path) {
  const { elements, attributes } = extractXPathNames(path);
  return [...[...elements].map((n) => `<${n}>`), ...[...attributes].map((n) => `@${n}`)];
}

function describePart(part, spec, parseXml) {
  if (part.emptyContext) return { code: 'describe_not_executable', params: { reason: REASON.emptyContext(spec.context, spec.contextAttr) } };
  if (part.kind === 'nonContext') return { code: 'describe_non_context', params: {} };
  let basics;
  let condition;
  try {
    basics = partBasics(part, spec);
    condition = isConditionPath(basics.expression, parseXml);
  } catch (err) {
    if (!(err instanceof NotExecutable)) throw err;
    return { code: 'describe_not_executable', params: { reason: err.reason } };
  }
  const { expression: path, flag } = basics;
  if (condition) {
    const params = { path, names: conditionNames(path) };
    if (flag === '0') return { code: 'describe_condition_forbidden', params };
    if (flag === '1') return { code: 'describe_condition_required', params };
    return { code: 'describe_condition_informative', params };
  }
  const target = pathTarget(path);
  const values = describeValues(part, spec);
  const withValues = values.length > 0;
  if (flag === '0') {
    if (withValues) return { code: 'describe_forbidden_values', params: { target, values, path } };
    return (
      thresholdStatement(target, path, pathThreshold(path)) ||
      intermediateNestingStatement(target, path) ||
      documentMustContainStatement(path) ||
      existencePredicateStatement(target, path) ||
      attributePredicateStatement(path) || { code: 'describe_forbidden', params: { target, path } }
    );
  }
  if (flag === '1') {
    const split = _splitTopLevel(path);
    if (split && _isContextPattern(split.parent)) {
      const parent = pathTarget(split.parent) || split.parent;
      return withValues
        ? { code: 'describe_mandatory_values', params: { parent, target: pathTarget(split.step) || target, values, path } }
        : { code: 'describe_mandatory', params: { parent, target: pathTarget(split.step) || target, path } };
    }
    return withValues
      ? { code: 'describe_mandatory_somewhere_values', params: { target, values, path } }
      : { code: 'describe_mandatory_somewhere', params: { target, path } };
  }
  // flag 2, or 3.0.1 without objappl: only the values are checked.
  return withValues
    ? { code: 'describe_restricted_values', params: { target, values, path } }
    : { code: 'describe_allowed', params: { target, path } };
}

// Mejoras A, Part 4: a threshold on the LAST step of a single path, alone
// in its predicate -- count(ancestor::E) / count(ancestor-or-self::E) /
// count(H) / string-length(.) compared with a number. BRDP-S1-00186,
// //proceduralStep[count(ancestor::proceduralStep)>5], flag 0: the
// description said only "<proceduralStep> must not appear", hiding that it
// rejects from the 7th level, not the 6th. → { kind: 'nesting' | 'ancestors'
// | 'children' | 'length', name, op, n, … } or null (anything else is
// described as before).
const THRESHOLD_OPS = { '>': 'gt', '>=': 'ge', '<': 'lt', '<=': 'le', '=': 'eq', '!=': 'ne', gt: 'gt', ge: 'ge', lt: 'lt', le: 'le', eq: 'eq', ne: 'ne' };
const FLIP = { gt: 'lt', ge: 'le', lt: 'gt', le: 'ge', eq: 'eq', ne: 'ne' };
const THRESHOLD_LHS = String.raw`count\(\s*(?:(ancestor-or-self|ancestor)::([A-Za-z_][\w.-]*)|(?:child::)?([A-Za-z_][\w.-]*))\s*\)|string-length\(\s*\.?\s*\)`;
const THRESHOLD_OP = String.raw`(>=|<=|!=|=|>|<|\b(?:gt|ge|lt|le|eq|ne)\b)`;
const THRESHOLD_LEFT_RE = new RegExp(`^(${THRESHOLD_LHS})\\s*${THRESHOLD_OP}\\s*(\\d+)$`);
const THRESHOLD_RIGHT_RE = new RegExp(`^(\\d+)\\s*${THRESHOLD_OP}\\s*(${THRESHOLD_LHS})$`);

function stepPredicateTexts(step) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = -1;
  for (let i = 0; i < step.length; i += 1) {
    const ch = step[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '[') { if (depth === 0) start = i + 1; depth += 1; }
    else if (ch === ']') { depth -= 1; if (depth === 0) out.push(step.slice(start, i).trim()); }
  }
  return out;
}

export function pathThreshold(path) {
  const step = lastTopLevelStep(String(path || '').trim());
  if (!step) return null;
  return stepThreshold(step);
}

// The threshold of one step ("proceduralStep[count(ancestor::proceduralStep)>5]"),
// or null: a single predicate comparing a count / string-length with a
// number. The nesting level is the step's own element's.
function stepThreshold(step) {
  const preds = stepPredicateTexts(step);
  if (preds.length !== 1) return null;
  const pred = preds[0].replace(/\s+/g, ' ');
  let lhs;
  let op;
  let n;
  const left = THRESHOLD_LEFT_RE.exec(pred);
  const right = left ? null : THRESHOLD_RIGHT_RE.exec(pred);
  if (left) {
    lhs = left[1];
    op = THRESHOLD_OPS[left[5]];
    n = Number(left[6]);
  } else if (right) {
    lhs = right[3];
    op = FLIP[THRESHOLD_OPS[right[2]]];
    n = Number(right[1]);
  } else {
    return null;
  }
  const own = (pathTarget(step) || '').replace(/^<|>$/g, '');
  const m = /^count\(\s*(?:(ancestor-or-self|ancestor)::([A-Za-z_][\w.-]*)|(?:child::)?([A-Za-z_][\w.-]*))\s*\)$/.exec(lhs);
  if (!m) return { kind: 'length', op, n };
  if (m[3]) return { kind: 'children', name: m[3], op, n };
  const [, axis, name] = m;
  if (name !== own) return { kind: 'ancestors', name, op, n }; // ancestor-or-self of another element = its ancestors
  // Nesting level L of the element (1 = outermost): count(ancestor::E) =
  // L - 1, count(ancestor-or-self::E) = L. As "E above it": L - 1.
  const above = axis === 'ancestor' ? n : n - 1;
  if (above < 0) return null;
  // Levels where the condition holds (L >= 1).
  const firstLevel = above + 1; // the level with exactly `above` above it
  let mode;
  let level;
  if (op === 'gt') { mode = 'from'; level = firstLevel + 1; }
  else if (op === 'ge') { mode = 'from'; level = firstLevel; }
  else if (op === 'eq') { mode = 'exactly'; level = firstLevel; }
  else if (op === 'ne') { mode = 'except'; level = firstLevel; }
  else if (op === 'lt') { if (firstLevel - 1 < 1) return null; mode = 'upto'; level = firstLevel - 1; }
  else { mode = 'upto'; level = firstLevel; }
  if (mode === 'from' && level <= 1) return null; // every level: as before
  return { kind: 'nesting', name, op, n: above, mode, level };
}

// The top-level steps of a single path ("//a[x]/b" → ["a[x]", "b"]), or null
// when the path has alternatives or no step.
function topLevelSteps(expression) {
  const text = String(expression || '').trim();
  const steps = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === '|' && depth === 0) return null;
    else if (ch === '/' && depth === 0) { steps.push(text.slice(start, i)); start = i + 1; }
  }
  steps.push(text.slice(start));
  const out = steps.map((st) => st.trim()).filter(Boolean);
  return out.length ? out : null;
}

// Mejoras B, Part 4.1: the one threshold of a path on any step --
// //proceduralStep[count(ancestor::proceduralStep)=4]/title → { …threshold,
// stepName: 'proceduralStep', last: false, target: '<title>' }. null with
// alternatives, with no threshold, or with more than one step (or one step
// with more than one predicate) that has one.
export function pathThresholdAnyStep(path) {
  const steps = topLevelSteps(path);
  if (!steps) return null;
  const found = [];
  steps.forEach((step, i) => {
    if (stepPredicateTexts(step).length === 0) return;
    const threshold = stepThreshold(step);
    found.push({ i, threshold, step });
  });
  if (found.length !== 1 || !found[0].threshold) return null;
  const { i, threshold, step } = found[0];
  const stepName = (pathTarget(step) || '').replace(/^<|>$/g, '');
  return { ...threshold, stepName, last: i === steps.length - 1, target: pathTarget(path) };
}

// Mejoras B, Part 4.1 a: a nesting threshold on an earlier step --
// //proceduralStep[count(ancestor::proceduralStep)=4]/title → "<title> must
// not appear in a <proceduralStep> at level 5". Only one threshold in one
// step (pathThresholdAnyStep); other kinds stay as before.
function intermediateNestingStatement(target, path) {
  if (!target) return null;
  const th = pathThresholdAnyStep(path);
  if (!th || th.last || th.kind !== 'nesting') return null;
  return { code: 'describe_forbidden_in_nesting', params: { target, path, name: `<${th.name}>`, mode: th.mode, level: th.level } };
}

// Mejoras B, Part 4.1 b: a single attribute predicate on the last step --
// //entry[@applicRefId] → "<entry> with @applicRefId must not appear";
// [not(@a)], [@a = 'v'], [@a != 'v']; a * step names "any child element of
// <entry>".
function attributePredicateStatement(path) {
  const step = lastTopLevelStep(String(path || '').trim());
  if (!step) return null;
  const preds = stepPredicateTexts(step);
  if (preds.length !== 1) return null;
  const attr = attributePredicate(preds[0]);
  if (!attr) return null;
  const bare = step.replace(/\[[\s\S]*$/, '').trim().replace(/^child::/, '');
  let target = null;
  let childOf = null;
  if (bare === '*') {
    const steps = topLevelSteps(withoutPredicates(path)) || [];
    const parent = steps.length > 1 ? steps[steps.length - 2].replace(/^(?:child|descendant|descendant-or-self)::/, '') : null;
    if (!parent || !/^[A-Za-z_][\w.:-]*$/.test(parent)) return null;
    childOf = `<${parent}>`;
  } else {
    target = pathTarget(path);
    if (!target || target.startsWith('@')) return null;
  }
  return { code: 'describe_forbidden_attr', params: { target, childOf, path, attr: `@${attr.attr}`, kind: attr.kind, value: attr.value ?? '' } };
}

// Mejoras C, Part 3: predicates that only ask whether a node is there.
// Splits a predicate on its top-level "and"/"or" (one kind only, never
// both) → { joiner, terms } | null.
function splitTopLevelLogic(predicate) {
  const text = String(predicate || '').trim();
  const terms = [];
  let joiner = null;
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && /\s/.test(ch)) {
      const m = /^\s+(and|or)\s+/.exec(text.slice(i));
      if (m) {
        if (joiner && joiner !== m[1]) return null;
        joiner = m[1];
        terms.push(text.slice(start, i).trim());
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  terms.push(text.slice(start).trim());
  if (terms.some((x) => !x)) return null;
  return { joiner: joiner || 'and', terms };
}

const NAME_RE = String.raw`[A-Za-z_][\w.-]*`;

// One existence term: x / child::x (child), .//x / descendant::x (inside),
// //x (anywhere in the document), @a / attribute::a, each optionally in
// not(…) → { negated, kind: 'child'|'inside'|'document'|'attribute', name } | null.
function existenceTerm(term) {
  let t = String(term || '').replace(/\s+/g, ' ').trim();
  let negated = false;
  const not = /^not\(\s*([\s\S]*?)\s*\)$/.exec(t);
  if (not) {
    negated = true;
    t = not[1].trim();
  }
  let m = new RegExp(`^(?:@|attribute::)(${NAME_RE})$`).exec(t);
  if (m) return { negated, kind: 'attribute', name: m[1] };
  m = new RegExp(`^(?:child::)?(${NAME_RE})$`).exec(t);
  if (m && !['and', 'or', 'not'].includes(m[1])) return { negated, kind: 'child', name: m[1] };
  m = new RegExp(`^(?:\\.//|\\./descendant::|descendant::)(${NAME_RE})$`).exec(t);
  if (m) return { negated, kind: 'inside', name: m[1] };
  m = new RegExp(`^//(${NAME_RE})$`).exec(t);
  if (m) return { negated, kind: 'document', name: m[1] };
  return null;
}

// The only step of the path and its single predicate, when the path is
// /R[…] or //R[…] → { name, absolute, predicate } | null.
function singleStepWithPredicate(path) {
  const steps = topLevelSteps(String(path || '').trim());
  if (!steps || steps.length !== 1) return null;
  const preds = stepPredicateTexts(steps[0]);
  if (preds.length !== 1) return null;
  const bare = steps[0].replace(/\[[\s\S]*$/, '').trim();
  if (!new RegExp(`^${NAME_RE}$`).test(bare)) return null;
  return { name: bare, predicate: preds[0] };
}

// /dmodule[not(//actref)] (or [not(.//actref)]) with flag 0, on a document
// root: "Every document must contain at least one <actref>"; without the
// not(), "No document may contain <actref>".
function documentMustContainStatement(path) {
  const single = singleStepWithPredicate(path);
  if (!single || !WHOLE_DOCUMENT_ROOTS.has(single.name)) return null;
  const term = existenceTerm(single.predicate);
  if (!term || (term.kind !== 'document' && term.kind !== 'inside')) return null;
  const params = { root: `<${single.name}>`, target: `<${term.name}>`, path };
  return { code: term.negated ? 'describe_document_must_contain' : 'describe_document_must_not_contain', params };
}

// //techstd[not(authex) or not(notes)] with flag 0 → "<techstd> without
// <authex> or without <notes> must not appear". Every term must be an
// existence test (x, not(x), .//x, @a…), joined by "and" or by "or". A
// single attribute term stays with attributePredicateStatement; //x (the
// whole document) only on a document root, handled above.
function existencePredicateStatement(target, path) {
  if (!target || target.startsWith('@')) return null;
  const step = lastTopLevelStep(String(path || '').trim());
  if (!step) return null;
  const preds = stepPredicateTexts(step);
  if (preds.length !== 1) return null;
  const split = splitTopLevelLogic(preds[0]);
  if (!split) return null;
  const terms = split.terms.map(existenceTerm);
  if (terms.some((x) => !x || x.kind === 'document')) return null;
  if (terms.length === 1 && terms[0].kind === 'attribute') return null;
  return {
    code: 'describe_forbidden_existence',
    params: {
      target,
      path,
      joiner: split.joiner,
      conditions: terms.map((x) => ({ negated: x.negated, kind: x.kind, name: x.kind === 'attribute' ? `@${x.name}` : `<${x.name}>` })),
    },
  };
}

function thresholdStatement(target, path, threshold) {
  if (!threshold || !target) return null;
  const base = { target, path, op: threshold.op, amount: threshold.n };
  if (threshold.kind === 'nesting') return { code: 'describe_forbidden_nesting', params: { ...base, name: `<${threshold.name}>`, mode: threshold.mode, level: threshold.level } };
  if (threshold.kind === 'ancestors') return { code: 'describe_forbidden_ancestors', params: { ...base, name: `<${threshold.name}>` } };
  if (threshold.kind === 'children') return { code: 'describe_forbidden_children', params: { ...base, name: `<${threshold.name}>` } };
  return { code: 'describe_forbidden_length', params: base };
}

const CAN_REJECT = new Set([
  'describe_forbidden_in_nesting', 'describe_forbidden_attr', 'describe_document_must_contain', 'describe_document_must_not_contain', 'describe_forbidden_existence',
  'describe_forbidden_nesting', 'describe_forbidden_ancestors', 'describe_forbidden_children', 'describe_forbidden_length',
  'describe_condition_forbidden', 'describe_condition_required',
  'describe_forbidden', 'describe_forbidden_values', 'describe_mandatory', 'describe_mandatory_values',
  'describe_mandatory_somewhere', 'describe_mandatory_somewhere_values', 'describe_restricted_values',
]);

export function describeRule(ruleXml, format, options = {}) {
  if (SCHEMATRON_FORMATS.includes(format)) return describeSchematron(ruleXml, options);
  const spec = FORMATS[format];
  if (!spec) return { available: false };
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return { available: false };
  }
  const statements = [];
  for (const part of collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null)) {
    const statement = describePart(part, spec, parseXml);
    const key = JSON.stringify(statement);
    const same = statements.find((s) => s.key === key && (s.schemas.length > 0) === Boolean(part.schema));
    if (same) {
      same.ruleIds.push(part.ruleId);
      if (part.schema && !same.schemas.includes(part.schema)) same.schemas.push(part.schema);
    } else {
      statements.push({ key, ruleIds: [part.ruleId], statement, schemas: part.schema ? [part.schema] : [] });
    }
  }
  const codes = statements.map((s) => s.statement.code);
  return {
    available: true,
    statements: statements.map(({ key: _key, ...s }) => s),
    cannotReject: (codes.includes('describe_allowed') || codes.includes('describe_condition_informative')) && !codes.some((c) => CAN_REJECT.has(c)),
  };
}

// Plantillas, Part 4: the parts of a BREX rule whose path is a true/false
// condition (s1kd-brexcheck's boolean objectPath) -- for the examples
// prompt (the condition each example meets or avoids) and the correction
// round. [] for Schematron, unknown formats and unparsable rules.
//   ruleConditions(ruleXml, format, options) →
//     [{ ruleId, path, flag, names: ['<x>', '@y'], schema }]
export function ruleConditions(ruleXml, format, options = {}) {
  const spec = FORMATS[format];
  if (!spec) return [];
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return [];
  }
  const out = [];
  for (const part of collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null)) {
    if (part.kind !== 'rule' || part.emptyContext) continue;
    try {
      const { expression, flag } = partBasics(part, spec);
      if (isConditionPath(expression, parseXml)) out.push({ ruleId: part.ruleId, path: expression, flag, names: conditionNames(expression), schema: part.schema });
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
    }
  }
  return out;
}

// ─── Why an example was accepted (Mejoras B, Parts 1 and 3) ────────────────
// The parts of a rule and their paths without predicates, for the
// correction round (which must never push an example toward the rule):
//   rulePathParts(ruleXml, format, options) →
//     [{ ruleId, path, stripped, flag, schema, condition }]
// Schematron: one entry per context, flag null.
export function rulePathParts(ruleXml, format, options = {}) {
  if (SCHEMATRON_FORMATS.includes(format)) return schematronRuleParts(ruleXml, options);
  const spec = FORMATS[format];
  if (!spec) return [];
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return [];
  }
  const out = [];
  for (const part of collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null)) {
    if (part.kind !== 'rule' || part.emptyContext) continue;
    try {
      const { expression, flag } = partBasics(part, spec);
      const path = expression.replace(/\s+/g, ' ').trim();
      out.push({
        ruleId: part.ruleId,
        path,
        stripped: withoutPredicates(path),
        flag,
        schema: part.schema,
        condition: isConditionPath(expression, parseXml),
      });
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
    }
  }
  return out;
}

// A single predicate on an attribute: [@a], [not(@a)], [@a = 'v'],
// [@a != 'v'] (also eq / ne, either side) → { kind: 'has' | 'lacks' |
// 'equals' | 'notEquals', attr, value? } or null.
export function attributePredicate(predicate) {
  const p = String(predicate || '').replace(/\s+/g, ' ').trim();
  const name = String.raw`(?:@|attribute::)((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)`;
  let m = new RegExp(`^${name}$`).exec(p);
  if (m) return { kind: 'has', attr: m[1] };
  m = new RegExp(`^not\\(\\s*${name}\\s*\\)$`).exec(p);
  if (m) return { kind: 'lacks', attr: m[1] };
  m = new RegExp(`^${name}\\s*(=|!=|eq|ne)\\s*(['"])([^'"]*)\\3$`).exec(p);
  if (m) return { kind: m[2] === '=' || m[2] === 'eq' ? 'equals' : 'notEquals', attr: m[1], value: m[4] };
  m = new RegExp(`^(['"])([^'"]*)\\1\\s*(=|!=|eq|ne)\\s*${name}$`).exec(p);
  if (m) return { kind: m[3] === '=' || m[3] === 'eq' ? 'equals' : 'notEquals', attr: m[4], value: m[2] };
  return null;
}

// The names of the steps of a predicate-free path: "//entry/*" → ['entry', '*'].
function strippedStepNames(stripped) {
  return String(stripped)
    .split('/')
    .map((s) => s.trim().replace(/^(?:child|descendant|descendant-or-self|self)::/, ''))
    .filter(Boolean);
}

// What the example has instead, for a node path that selected nothing
// although nodes of its kind are there (case b): one line of the cause.
function predicateCause(alternative, stripped, nodes, evaluate) {
  const step = lastTopLevelStep(alternative) || alternative;
  const predicates = stepPredicateTexts(step);
  const names = strippedStepNames(stripped);
  const last = names[names.length - 1] || '';
  const isAttr = /^@|^attribute::/.test(last);
  let target;
  let childOf = null;
  if (last === '*' && names.length > 1 && /^[A-Za-z_][\w.:-]*$/.test(names[names.length - 2])) {
    target = `<${names[names.length - 2]}>`;
    childOf = target;
  } else if (isAttr) target = `@${last.replace(/^@|^attribute::/, '')}`;
  else if (/^[A-Za-z_][\w.:-]*$/.test(last)) target = `<${last}>`;
  else target = null;
  const amount = nodes.length;
  if (predicates.length === 0) {
    // the predicates are on earlier steps: name the whole path
    return { code: 'cause_predicate_path', params: { amount, target: target || stripped, path: alternative } };
  }
  if (predicates.length === 1 && target) {
    const attr = attributePredicate(predicates[0]);
    if (attr) {
      const code = { has: 'cause_attr_has', lacks: 'cause_attr_lacks', equals: 'cause_attr_equals', notEquals: 'cause_attr_not_equals' }[attr.kind];
      return { code, params: { count: amount, amount, target, childOf, attr: `@${attr.attr}`, value: attr.value ?? '' } };
    }
  }
  const params = { amount, target: target || stripped, predicate: predicates.map((p) => `[${p.replace(/\s+/g, ' ')}]`).join(''), childOf };
  const threshold = pathThreshold(alternative);
  if (threshold?.kind === 'nesting' && evaluate) {
    let deepest = 0;
    for (const node of nodes) {
      try {
        deepest = Math.max(deepest, evaluate(`count(ancestor-or-self::${threshold.name})`, node, null, 'number'));
      } catch {
        deepest = 0;
        break;
      }
    }
    if (deepest > 0) return { code: 'cause_predicate_nesting', params: { ...params, deepest, mode: threshold.mode, level: threshold.level } };
  }
  return { code: 'cause_predicate', params };
}

// For an example the rule ACCEPTED: per rule part in scope, why. Never
// changes a verdict; the panel says it (Part 3), and case 'predicate' keeps
// a reject example out of the correction round (Part 1):
//   [{ ruleId, flag, path, stripped, case, cause: { code, params } | null }]
// case: 'missing'   -- no node of the path's kind (without predicates)
//       'predicate' -- nodes of that kind, none meets the predicates (b)
//       'unsafe'    -- the path without predicates could not be evaluated
//       'mandatory_present' | 'mandatory_absent_parent' | 'mandatory_somewhere'
//       'values_allowed' | 'values_not_prohibited' | 'allowed' | 'condition'
export function acceptanceDetails(ruleXml, format, fragmentXml, fragmentSchema = null, options = {}) {
  if (SCHEMATRON_FORMATS.includes(format)) {
    return schematronAcceptanceDetails(ruleXml, fragmentXml, options).map((d) => ({ ...d, cause: schematronCause(d) }));
  }
  const spec = FORMATS[format];
  if (!spec) return [];
  const parseXml = options.parseXml || parseXmlDocument;
  let doc;
  let ruleDoc;
  try {
    doc = parseXml(String(fragmentXml || ''));
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
    if (!doc?.documentElement) return [];
  } catch {
    return [];
  }
  const xsi = doc.documentElement.getAttributeNS
    ? doc.documentElement.getAttributeNS(KNOWN_NAMESPACES.xsi, 'noNamespaceSchemaLocation')
    : null;
  const schema = fragmentSchema || (xsi ? schemaNameFromContext(xsi, options.schemaLocation || null) : null);
  const evaluate = makeEvaluator(doc);
  const evalNumber = (expression, node) => Number(fontoxpath.evaluateXPathToNumber(expression, node, null, null, { language: XPATH_LANGUAGE }));
  const out = [];
  for (const part of collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null)) {
    if (part.kind !== 'rule' || part.emptyContext) continue;
    if (part.schema && part.schema !== schema) continue;
    try {
      const { expression, flag } = partBasics(part, spec);
      const path = expression.replace(/\s+/g, ' ').trim();
      const stripped = withoutPredicates(path);
      const base = { ruleId: part.ruleId, flag, path, stripped };
      const evaluated = evaluate(expression, doc, null, 'path');
      if (evaluated.condition !== undefined) {
        // Remates B, Part 1: the names the condition looks at (those
        // describeRule gives) and which of them the example contains. A
        // rejecting condition (flag 0 / 1) that the example names but does
        // not meet is case b: the example shows the decision, the rule does
        // not cover it -- never sent to the correction round.
        const entry = { ...base, case: 'condition', holds: evaluated.condition, cause: null };
        if (flag === '0' || flag === '1') {
          const { names, present } = conditionNamesIn(expression, doc);
          entry.names = names;
          entry.presentNames = present;
          if (present.length) entry.cause = { code: 'cause_condition', params: { names: present, path, truth: evaluated.condition ? 'true' : 'false' } };
        }
        out.push(entry);
        continue;
      }
      const nodes = evaluated.nodes;
      const valueEls = childElements(part.element, spec.value);
      const matchers = valueEls.map((v) => buildValueMatcher(v, spec, evaluate));
      const values = (list) => [...new Set(list.map((n) => String(n.nodeType === 2 ? n.value : n.textContent || '').trim()))];
      if (flag === '1') {
        const split = _splitTopLevel(expression);
        if (split && _isContextPattern(split.parent)) {
          const parents = evaluate(split.parent, doc, null, 'nodes');
          const parentName = pathTarget(withoutPredicates(split.parent)) || withoutPredicates(split.parent);
          const child = pathTarget(`x/${withoutPredicates(split.step)}`) || withoutPredicates(split.step);
          if (parents.length === 0) out.push({ ...base, case: 'mandatory_absent_parent', cause: { code: 'cause_missing', params: { target: parentName } } });
          else out.push({ ...base, case: 'mandatory_present', cause: { code: matchers.length ? 'cause_mandatory_present_values' : 'cause_mandatory_present', params: { parent: parentName, child } } });
        } else {
          out.push({ ...base, case: 'mandatory_somewhere', cause: { code: 'cause_mandatory_somewhere', params: { target: pathTarget(stripped) || stripped } } });
        }
        continue;
      }
      if (nodes.length > 0) {
        if (matchers.length && flag !== '0') out.push({ ...base, case: 'values_allowed', cause: { code: 'cause_values_allowed', params: { count: values(nodes).length, values: values(nodes).map((v) => `«${v}»`).join(', ') } } });
        else if (matchers.length && flag === '0') out.push({ ...base, case: 'values_not_prohibited', cause: { code: 'cause_values_not_prohibited', params: { count: values(nodes).length, values: values(nodes).map((v) => `«${v}»`).join(', ') } } });
        else out.push({ ...base, case: 'allowed', cause: null });
        continue;
      }
      // Nothing selected: case a (no node of that kind) or b (nodes of
      // that kind, none meets the predicates), alternative by alternative.
      if (/\$/.test(stripLiterals(stripped))) {
        out.push({ ...base, case: 'unsafe', cause: null });
        continue;
      }
      let found = null;
      let unsafe = false;
      for (const alternative of topLevelAlternatives(expression)) {
        const alt = alternative.replace(/\s+/g, ' ').trim();
        const altStripped = withoutPredicates(alt);
        if (altStripped === alt) continue;
        try {
          const r = evaluate(altStripped, doc, null, 'path');
          if (r.nodes?.length) {
            found = { alt, altStripped, nodes: r.nodes };
            break;
          }
        } catch {
          unsafe = true;
        }
      }
      if (found) {
        const evalForCause = (e, node, _v, kind) => (kind === 'number' ? evalNumber(e, node) : evaluate(e, node, null, kind));
        out.push({ ...base, case: 'predicate', amount: found.nodes.length, cause: predicateCause(found.alt, found.altStripped, found.nodes, evalForCause) });
      } else if (unsafe) {
        out.push({ ...base, case: 'unsafe', cause: null });
      } else {
        out.push({ ...base, case: 'missing', cause: { code: 'cause_missing', params: { target: pathTarget(stripped) || stripped } } });
      }
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
    }
  }
  return out;
}

// The element and attribute names a condition looks at ('<x>', '@y', in
// the order describeRule gives them) and those the document contains
// (by local name, anywhere).
function conditionNamesIn(expression, doc) {
  const { elements, attributes } = extractXPathNames(expression);
  const localOf = (n) => String(n).replace(/^.*:/, '');
  const docElements = new Set();
  const docAttributes = new Set();
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    docElements.add(el.localName || localOf(el.nodeName));
    const attrs = el.attributes || [];
    for (let j = 0; j < attrs.length; j++) docAttributes.add(attrs[j].localName || localOf(attrs[j].name));
  }
  const names = [];
  const present = [];
  for (const e of elements) {
    names.push(`<${e}>`);
    if (docElements.has(localOf(e))) present.push(`<${e}>`);
  }
  for (const a of attributes) {
    names.push(`@${a}`);
    if (docAttributes.has(localOf(a))) present.push(`@${a}`);
  }
  return { names, present };
}

function schematronCause(d) {
  if (d.case === 'missing') return { code: 'cause_missing', params: { target: d.target || d.stripped } };
  if (d.case === 'predicate') return { code: 'cause_sch_context', params: { amount: d.amount, target: d.target || d.stripped, context: d.path } };
  return null;
}

// Mejoras B, Part 2: the thresholds of a rule's prohibitions (flag 0 /
// objappl 0 without values, a node path -- the parts describeRule explains
// with a threshold), for the comparison with the Proposal's numbers:
//   ruleThresholds(ruleXml, format, options) → [{ ruleId, path, …threshold }]
export function ruleThresholds(ruleXml, format, options = {}) {
  const spec = FORMATS[format];
  if (!spec) return [];
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return [];
  }
  const out = [];
  for (const part of collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null)) {
    if (part.kind !== 'rule' || part.emptyContext) continue;
    try {
      const { expression, flag } = partBasics(part, spec);
      if (flag !== '0' || childElements(part.element, spec.value).length) continue;
      if (isConditionPath(expression, parseXml)) continue;
      const threshold = pathThresholdAnyStep(expression.replace(/\s+/g, ' ').trim());
      if (threshold) out.push({ ruleId: part.ruleId, path: expression.replace(/\s+/g, ' ').trim(), ...threshold });
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
    }
  }
  return out;
}

// "Comparar dos BRDP lado a lado": the structure of a rule, for the
// structural summary of the side-by-side view (computed by code, never by
// the LLM). BREX: one entry per rule part -- its path, flag (the attribute,
// or the format's default) and values; a nonContextRule has kind
// 'nonContext'. Schematron: one entry per assert/report, with its context
// and test (describeSchematron's own reading).
//   ruleStructure(ruleXml, format, options) →
//     { available: false }
//   | { available: true, family: 'brex4'|'brex301'|'sch',
//       parts: [{ ruleId, kind, schema, path, flag, values: ['055', '1~10', 'pattern: em0[1-5]'] }] }
//   | { available: true, family: 'sch', checks: [{ ruleId, kind: 'assert'|'report', context, test, message }] }
export function ruleFormatFamily(format) {
  if (format === 'BREX-4.2' || format === 'BREX-4.1') return 'brex4';
  if (format === 'BREX-3.0.1') return 'brex301';
  if (SCHEMATRON_FORMATS.includes(format)) return 'sch';
  return null;
}

function valueToken(v) {
  if (v.form === 'single') return v.value;
  if (v.form === 'range') return `${v.from}~${v.to}`;
  if (v.form === 'pattern') return `pattern: ${v.pattern}`;
  return `${v.form}?`;
}

export function ruleStructure(ruleXml, format, options = {}) {
  const family = ruleFormatFamily(format);
  if (!family) return { available: false };
  if (family === 'sch') {
    const described = describeSchematron(ruleXml, options);
    if (!described.available) return { available: false };
    const checks = described.statements
      .filter((s) => s.statement.code === 'describe_sch_assert' || s.statement.code === 'describe_sch_report')
      .map((s) => ({
        ruleId: s.ruleIds[0],
        kind: s.statement.code === 'describe_sch_assert' ? 'assert' : 'report',
        context: s.statement.params.context,
        test: s.statement.params.test,
        message: s.statement.params.message,
      }));
    return { available: true, family, checks };
  }
  const spec = FORMATS[format];
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return { available: false };
  }
  const parts = collectParts(ruleDoc.documentElement, spec, options.schemaLocation || null).flatMap((part) => {
    if (part.kind === 'nonContext') return [{ ruleId: part.ruleId, kind: 'nonContext', schema: part.schema || null, path: '', flag: null, values: [] }];
    // One structural part per path (Mejoras A, Part 3): a rule element
    // with two objectPath shows both, each with the values after it.
    const groups = pathGroups(part.element, spec);
    const one = (group, i) => {
      const pathEl = group?.path || null;
      const rawFlag = pathEl ? pathEl.getAttribute(spec.flagAttr) : null;
      return {
        ruleId: groups.length > 1 ? `${part.ruleId} (${spec.path} ${i + 1})` : part.ruleId,
        kind: 'rule',
        schema: part.schema || null,
        path: pathEl ? _normSpace(pathEl.textContent || '') : '',
        flag: rawFlag === null || rawFlag === '' ? spec.defaultFlag : rawFlag.trim(),
        values: describeValues(part, spec, group ? group.values : []).map(valueToken),
      };
    };
    return groups.length ? groups.map(one) : [one(null, 0)];
  });
  return { available: true, family, parts };
}
