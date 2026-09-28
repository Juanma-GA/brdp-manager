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
//       outOfScopeSchemas: [...] }       // context blocks skipped: other schema
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
// | Context blocks                 | rules in contextRules@rulesContext / contextrules@context apply  | XSD, TPL, |
// |                                | only when the fragment's schema equals schemaNameFromContext()   | REF (xsi) |
// |                                | of the URL (flat or master); an empty attribute = general.       |        |
// |                                | Fragment schema: the fragmentSchema argument, else the root's    |        |
// |                                | xsi:noNamespaceSchemaLocation (what REF tests). A fragment of    |        |
// |                                | another schema, with no part left to run: accepted (the rule    | REF (its |
// |                                | does not apply there)                                            | not(xsi=…) or) |
// | nonContextRule (4.x element,   | nothing to execute → not executable                             | XSD42/41, GEN |
// | 3.0.1 comment)                 |                                                                  |        |
//
// Value checks (single/range/pattern) are not reimplemented here: the engine
// evaluates the very XPath expression brexToSchematron.js writes into the
// Schematron (_valueCheckXPath), so a value the test accepts is a value the
// generated Schematron accepts. No curated template uses range or pattern.
//
// Beyond the table, a path is not executable when (reasons below): it reads
// another file (document()/doc()/collection()/doc-available()/unparsed-text*);
// it is not a node path (EXT-00019 in the 4.1 template is a boolean
// expression; REF turns such rules into no-ops); or it starts at an absolute
// root (/dmodule/…) that is not the fragment's root element — it could never
// select anything there, and "accepted" would be a verdict nobody computed.
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
import { _isContextPattern, _splitTopLevel, _valueCheckXPath } from '../api/brexToSchematron.js';
import { schemaNameFromContext } from './ruleSchemaContext.js';
import { wrapRuleXmlFragment } from './ruleXmlFragment.js';
import {
  KNOWN_NAMESPACES,
  NotExecutable,
  OTHER_FILE_RE,
  XPATH_LANGUAGE,
  combinedReason,
  localName,
  nodePath,
  parseXmlDocument,
  reason,
  xpathErrorMessage,
} from './ruleTestCommon.js';
import { analyzeSchematron, describeSchematron, runSchematronOnFragment, SCHEMATRON_FORMATS } from './ruleTestSchematron.js';

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
function partBasics(part, spec) {
  const pathEl = childElements(part.element, spec.path)[0];
  const expression = pathEl ? String(pathEl.textContent || '').trim() : '';
  if (!expression) throw new NotExecutable(REASON.emptyPath(spec.path));
  const otherFile = OTHER_FILE_RE.exec(expression.replace(/'[^']*'|"[^"]*"/g, "''"));
  if (otherFile) throw new NotExecutable(REASON.otherFile(`${otherFile[1]}()`));

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
  for (const name of absoluteRootNames(expression)) {
    if (name !== localName(root)) throw new NotExecutable(REASON.absoluteRoot(name, root.nodeName));
  }
  if (flag === '1' && !WHOLE_DOCUMENT_ROOTS.has(localName(root))) throw new NotExecutable(REASON.mandatory());

  const selected = evaluate(expression, doc, null, 'nodes');
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
      const items = evaluateXPath(expression, contextNode, null, variables, evaluateXPath.ALL_RESULTS_TYPE, options);
      const nonNode = items.find((item) => item === null || typeof item !== 'object' || typeof item.nodeType !== 'number');
      if (nonNode !== undefined) throw new NotExecutable(REASON.notNodes(typeof nonNode === 'boolean' ? 'boolean' : typeof nonNode === 'number' ? 'number' : 'value'));
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

function notExecutable(r) {
  return { status: 'not_executable', violations: [], warnings: [], selectedNodePaths: [], notExecutableReason: r, notExecutableParts: [], outOfScopeSchemas: [] };
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
      if (part.kind === 'nonContext') throw new NotExecutable(REASON.nonContext());
      if (part.schema && !schema) throw new NotExecutable(REASON.schemaUnknown(part.schema));
      if (part.schema && part.schema !== schema) { outOfScope.push(part.schema); continue; }
      const result = runPart(part, spec, doc, evaluate);
      ran += 1;
      selected.push(...result.selectedNodePaths);
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
  if (SCHEMATRON_FORMATS.includes(format)) return analyzeSchematron(ruleXml, options);
  const none = (r) => ({ status: 'not_executable', reason: r, parts: [], total: 0, warnings: [] });
  const spec = FORMATS[format];
  if (!spec) return none(REASON.format(format));
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch (err) {
    return none(REASON.ruleXml(err.message));
  }
  const parts = collectParts(ruleDoc.documentElement, spec);
  if (!parts.length) return none(REASON.noRule(spec.rule));

  const notRun = [];
  for (const part of parts) {
    try {
      if (part.kind === 'nonContext') throw new NotExecutable(REASON.nonContext());
      const { expression } = partBasics(part, spec);
      const root = absoluteRootNames(expression)[0] || 'dmodule';
      const doc = parseXml(`<${root}/>`);
      const evaluate = makeEvaluator(doc);
      for (const v of childElements(part.element, spec.value)) buildValueMatcher(v, spec, evaluate);
      evaluate(expression, doc, null, 'nodes');
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
//   describe_forbidden_values {target, values, path}   flag 0 with values
//   describe_mandatory {parent, target, path}          flag 1, <parent>/<step>
//   describe_mandatory_values {parent, target, values, path}
//   describe_mandatory_somewhere {target, path}        flag 1, not divisible
//   describe_mandatory_somewhere_values {target, values, path}
//   describe_restricted_values {target, values, path}  flag 2 (or no objappl) with values
//   describe_allowed {target, path}                    flag 2 (or no objappl), no values:
//                                                      rejects nothing
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

function describeValues(part, spec) {
  const is301 = spec.value === 'objval';
  return childElements(part.element, spec.value).map((v) => {
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

function describePart(part, spec) {
  if (part.kind === 'nonContext') return { code: 'describe_non_context', params: {} };
  let basics;
  try {
    basics = partBasics(part, spec);
  } catch (err) {
    if (!(err instanceof NotExecutable)) throw err;
    return { code: 'describe_not_executable', params: { reason: err.reason } };
  }
  const { expression: path, flag } = basics;
  const target = pathTarget(path);
  const values = describeValues(part, spec);
  const withValues = values.length > 0;
  if (flag === '0') {
    return withValues
      ? { code: 'describe_forbidden_values', params: { target, values, path } }
      : { code: 'describe_forbidden', params: { target, path } };
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

const CAN_REJECT = new Set([
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
  for (const part of collectParts(ruleDoc.documentElement, spec)) {
    const statement = describePart(part, spec);
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
    cannotReject: codes.includes('describe_allowed') && !codes.some((c) => CAN_REJECT.has(c)),
  };
}
