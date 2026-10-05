// Rule test engine, Schematron (Test de reglas T4): runs an ISO Schematron
// rule, as stored in rule_approvals.rule_xml for a DITA project (format
// SCH-DITA: one or several <sch:pattern>, with or without the sch: prefix),
// on a short XML fragment. Same interface as the BREX engine (reached
// through utils/ruleTestEngine.js's runRuleOnFragment / analyzeRule /
// describeRule), same result shapes; the verdict is computed here, never by
// an LLM. Pure module (no React, no API): importable from plain Node.
//
// ─── Semantics (origin in brackets) ─────────────────────────────────────────
// Sources: [ISO] ISO/IEC 19757-3 (Schematron), 2016 edition, and its
// reference XSLT implementation (the "skeleton"), which is what oXygen/Saxon
// run; [GEN] what the app itself writes and checks: src/api/
// generateSchematronDITA.js (STRICT RULES of the prompt, KNOWN_ROLES and
// checkWellFormedSchematron, finalizeSchematronDocument's sch:schema
// wrapper) and src/prompts/ruleFormatRules.js (SCH-DITA rules); [TPL] the
// Verified rules of public/brdp-template-dita-xpath{2,3}.xlsx.
//
// | Topic                    | Behaviour                                                            | Origin |
// |--------------------------|----------------------------------------------------------------------|--------|
// | Elements                 | pattern, rule, let, assert, report, value-of, name, ns, with the     | ISO, TPL |
// |                          | sch: prefix, another prefix bound to the ISO namespace, or no prefix |        |
// |                          | (the XPath 2.0 template writes <pattern>/<rule>/<let> bare)          |        |
// | Rule context             | an XSLT pattern. A node matches when it is in the result of          | ISO (approx.) |
// |                          | //(context) evaluated from the document node (with the pattern's     |        |
// |                          | variables in scope). Exact for the patterns the app and templates    |        |
// |                          | use (a/b, a[pred], //a, /*, a | b, @x); not modelled: key()/id()     |        |
// |                          | patterns and XSLT 3.0 pattern-only syntax (e.g. ".[pred]")          |        |
// | One rule per node        | within a pattern, every node is judged by the FIRST rule (document   | ISO    |
// |                          | order of the rules) whose context it matches; later rules skip it    |        |
// | Abstract rule            | never fires by itself (used only through sch:extends)                | ISO    |
// | Variables (sch:let)      | evaluated in order, each seeing the previous ones. Pattern (and      | ISO    |
// |                          | schema) lets: once, with the document node as context; rule lets:    |        |
// |                          | for every context node, with that node as context. Values may be     | TPL    |
// |                          | inline functions (XPath 3.0 template): the lets are evaluated as one |        |
// |                          | XPath "let … return" chain, so functions are ordinary values          |        |
// | assert                   | a violation when @test is false (effective boolean value)            | ISO    |
// | report                   | a violation when @test is true                                       | ISO    |
// | @role                    | error, fatal, absent (or any other value) → a violation that rejects;| GEN (KNOWN_ROLES, |
// |                          | warning, info → a warning shown on the example, never a rejection    | prompt rule 11) |
// | Message                  | the assert/report text, with sch:value-of evaluated (XSLT 2.0         | ISO    |
// |                          | value-of: the items' string values joined by a space) and sch:name   |        |
// |                          | (name of @path, default the context node); other inline elements     |        |
// |                          | (emph, dir, span) give their text. Whitespace collapsed               |        |
// | XPath version            | fontoxpath runs XPath 3.1, a superset of 2.0 and 3.0, so both        | GEN (queryBinding |
// |                          | dialects run. In an XPath 2.0 project, 3.x-only syntax is a warning   | xslt2/xslt3) |
// |                          | of analyzeRule (xpath3_syntax), never a refusal                      |        |
// | fn:analyze-string        | not in fontoxpath: registered here (same result element, match /     | TPL (EXT-00006 |
// |                          | non-match children; no fn:group, JavaScript regex dialect)           | xpath3) |
// | sch:phase                | ignored: every pattern runs (a validator with no phase selected)     | ISO    |
// | Not executable           | doc()/document()/collection()/doc-available()/unparsed-text*()       | —      |
// |                          | (external_document); a prefixed function outside fn/xs/math/map/     |        |
// |                          | array (extension_function); sch:include, abstract patterns (is-a),   |        |
// |                          | sch:extends (sch_unsupported); a missing @context/@test/@value       |        |
// |                          | (sch_missing_attribute); an XPath error (xpath_error); a literal      |        |
// |                          | '@@…@@' replaced by the project's tooling after Generate             |        |
// |                          | (external_placeholder, T4b)                                           |        |
//
// A "part" is a pattern (ruleId = its @id, or "pattern N"): each runs or
// not independently, as in the BREX engine. A violation's ruleId is the
// assert/report @id when it has one.
import fontoxpath from 'fontoxpath';
import { wrapRuleXmlFragment } from './ruleXmlFragment.js';
import {
  EXTERNAL_PLACEHOLDER_RE,
  KNOWN_NAMESPACES,
  NotExecutable,
  OTHER_FILE_RE,
  XPATH_LANGUAGE,
  combinedReason,
  localName,
  nodePath,
  parseXmlDocument,
  reason,
  stripLiterals,
  xpathErrorMessage,
} from './ruleTestCommon.js';

export const SCHEMATRON_FORMATS = ['SCH-DITA'];

const SCH_NS = 'http://purl.oclc.org/dsdl/schematron';
const FN_NS = 'http://www.w3.org/2005/xpath-functions';
// Always bound, whatever the rule declares (the fragment wrapper gives any
// undeclared prefix a dummy URI; these must stay the real ones).
const BUILTIN_PREFIXES = {
  xs: 'http://www.w3.org/2001/XMLSchema',
  fn: FN_NS,
  math: 'http://www.w3.org/2005/xpath-functions/math',
  map: 'http://www.w3.org/2005/xpath-functions/map',
  array: 'http://www.w3.org/2005/xpath-functions/array',
  xml: 'http://www.w3.org/XML/1998/namespace',
};
const WARNING_ROLES = new Set(['warning', 'info']);
const DUMMY_NS_PREFIX = 'urn:x-wellformed-check:';
const ROOT_VAR = '__sch_root';

const REASON = {
  otherFile: (fn) => reason('external_document', { fn }),
  placeholder: (placeholder) => reason('external_placeholder', { placeholder }),
  extension: (name) => reason('extension_function', { name }),
  unsupported: (feature) => reason('sch_unsupported', { feature }),
  missing: (element, attr) => reason('sch_missing_attribute', { element, attr }),
  noRule: (element) => reason('no_rule_element', { element }),
  xpath: (message) => reason('xpath_error', { message }),
  notNodes: (kind) => reason('path_not_nodes', { kind }),
  fragmentXml: (message) => reason('fragment_not_well_formed', { message }),
  ruleXml: (message) => reason('rule_not_well_formed', { message }),
};

// ─── fn:analyze-string ──────────────────────────────────────────────────────
// fontoxpath does not implement it; the XPath 3.0 template uses it
// (EX-00006). Returns <fn:analyze-string-result> with <fn:match> /
// <fn:non-match> children, parsed with the parser of the current run.
let activeParseXml = parseXmlDocument;
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function analyzeString(input, pattern, flags = '') {
  const text = input ?? '';
  const source = flags.includes('x') ? String(pattern).replace(/\s+/g, '') : String(pattern);
  const jsFlags = `g${flags.includes('i') ? 'i' : ''}${flags.includes('m') ? 'm' : ''}${flags.includes('s') ? 's' : ''}`;
  let re;
  try {
    re = new RegExp(source, `${jsFlags}u`);
  } catch {
    re = new RegExp(source, jsFlags);
  }
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') throw new Error('FORX0003: the regular expression matches a zero-length string');
    if (m.index > last) out += `<non-match>${escXml(text.slice(last, m.index))}</non-match>`;
    out += `<match>${escXml(m[0])}</match>`;
    last = m.index + m[0].length;
  }
  if (last < text.length) out += `<non-match>${escXml(text.slice(last))}</non-match>`;
  return activeParseXml(`<analyze-string-result xmlns="${FN_NS}">${out}</analyze-string-result>`).documentElement;
}

for (const [params, fn] of [
  [['xs:string?', 'xs:string'], (_c, input, pattern) => analyzeString(input, pattern)],
  [['xs:string?', 'xs:string', 'xs:string'], (_c, input, pattern, flags) => analyzeString(input, pattern, flags)],
]) {
  try {
    fontoxpath.registerCustomXPathFunction({ namespaceURI: FN_NS, localName: 'analyze-string' }, params, 'element()', fn);
  } catch {
    // already registered (module reloaded)
  }
}

// ─── Reading the rule ───────────────────────────────────────────────────────

function isSch(node, name) {
  return node.nodeType === 1 && localName(node) === name && (!node.prefix || node.prefix === 'sch' || node.namespaceURI === SCH_NS);
}

function children(el) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}

const attrOrNull = (el, name) => (el.hasAttribute(name) ? el.getAttribute(name) : null);

function parseLet(el) {
  return { name: el.getAttribute('name') || '', value: attrOrNull(el, 'value') };
}

function parseRule(el) {
  const rule = { context: attrOrNull(el, 'context'), abstract: el.getAttribute('abstract') === 'true', lets: [], checks: [], unsupported: null };
  for (const c of children(el)) {
    if (isSch(c, 'let')) rule.lets.push(parseLet(c));
    else if (isSch(c, 'assert') || isSch(c, 'report')) {
      rule.checks.push({
        kind: localName(c),
        id: c.getAttribute('id') || null,
        role: (c.getAttribute('role') || '').trim() || null,
        test: attrOrNull(c, 'test'),
        element: c,
      });
    } else if (isSch(c, 'extends')) rule.unsupported = rule.unsupported || 'sch:extends';
    else if (isSch(c, 'include')) rule.unsupported = rule.unsupported || 'sch:include';
  }
  return rule;
}

function parsePattern(el, index) {
  const id = el.getAttribute('id') || null;
  const pattern = { id, ruleId: id || `pattern ${index + 1}`, lets: [], rules: [], unsupported: null };
  if (el.getAttribute('abstract') === 'true') pattern.unsupported = 'abstract pattern';
  else if (el.hasAttribute('is-a')) pattern.unsupported = 'is-a (pattern instance)';
  for (const c of children(el)) {
    if (isSch(c, 'let')) pattern.lets.push(parseLet(c));
    else if (isSch(c, 'rule')) pattern.rules.push(parseRule(c));
    else if (isSch(c, 'include')) pattern.unsupported = pattern.unsupported || 'sch:include';
  }
  return pattern;
}

// { patterns, globalLets, namespaces, globalUnsupported }. Bare <rule>
// elements outside any pattern count as one implicit pattern.
function parseSchematron(root) {
  const patterns = [];
  const globalLets = [];
  const namespaces = {};
  let globalUnsupported = null;
  const looseRules = [];
  const collectNs = (el) => {
    for (const a of Array.from(el.attributes || [])) {
      if (a.name.startsWith('xmlns:') && !String(a.value).startsWith(DUMMY_NS_PREFIX)) namespaces[a.name.slice(6)] = a.value;
    }
    for (const c of children(el)) collectNs(c);
  };
  const walk = (el) => {
    for (const c of children(el)) {
      if (isSch(c, 'pattern')) patterns.push(parsePattern(c, patterns.length));
      else if (isSch(c, 'rule')) looseRules.push(parseRule(c));
      else if (isSch(c, 'let')) globalLets.push(parseLet(c));
      else if (isSch(c, 'ns')) {
        if (c.getAttribute('prefix')) namespaces[c.getAttribute('prefix')] = c.getAttribute('uri') || '';
      } else if (isSch(c, 'include')) globalUnsupported = globalUnsupported || 'sch:include';
      else if (isSch(c, 'schema')) walk(c);
      // sch:phase, sch:title, sch:p, sch:diagnostics: ignored
    }
  };
  collectNs(root);
  walk(root);
  if (looseRules.length) patterns.push({ id: null, ruleId: `pattern ${patterns.length + 1}`, lets: [], rules: looseRules, unsupported: null });
  return { patterns, globalLets, namespaces, globalUnsupported };
}

// Every XPath expression of a pattern, for the static checks.
function patternExpressions(pattern, globalLets) {
  const out = [];
  for (const l of [...globalLets, ...pattern.lets]) if (l.value) out.push(l.value);
  for (const rule of pattern.rules) {
    if (rule.context) out.push(rule.context);
    for (const l of rule.lets) if (l.value) out.push(l.value);
    for (const check of rule.checks) {
      if (check.test) out.push(check.test);
      const walk = (el) => {
        for (const c of children(el)) {
          if (isSch(c, 'value-of') && c.getAttribute('select')) out.push(c.getAttribute('select'));
          else if (isSch(c, 'name') && c.getAttribute('path')) out.push(c.getAttribute('path'));
          else walk(c);
        }
      };
      walk(check.element);
    }
  }
  return out;
}

// A prefixed function call whose prefix is not a standard one.
const PREFIXED_CALL_RE = /(?<![\w.$:-])([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)\s*\(/g;
function extensionFunction(expression) {
  for (const m of stripLiterals(expression).matchAll(PREFIXED_CALL_RE)) {
    if (!BUILTIN_PREFIXES[m[1]] || m[1] === 'xml') return `${m[1]}:${m[2]}`;
  }
  return null;
}

// Throws NotExecutable for what is known without any fragment.
function staticChecks(pattern, globalLets, globalUnsupported) {
  if (globalUnsupported) throw new NotExecutable(REASON.unsupported(globalUnsupported));
  if (pattern.unsupported) throw new NotExecutable(REASON.unsupported(pattern.unsupported));
  const rules = pattern.rules.filter((r) => !r.abstract);
  if (rules.length === 0) throw new NotExecutable(REASON.noRule('rule'));
  for (const rule of pattern.rules) {
    if (rule.unsupported) throw new NotExecutable(REASON.unsupported(rule.unsupported));
    if (!rule.abstract && !(rule.context || '').trim()) throw new NotExecutable(REASON.missing('rule', 'context'));
    for (const check of rule.checks) if (!(check.test || '').trim()) throw new NotExecutable(REASON.missing(check.kind, 'test'));
    for (const l of rule.lets) if (l.value === null) throw new NotExecutable(REASON.missing('let', 'value'));
  }
  for (const l of [...globalLets, ...pattern.lets]) if (l.value === null) throw new NotExecutable(REASON.missing('let', 'value'));
  const expressions = patternExpressions(pattern, globalLets);
  for (const e of expressions) {
    const other = OTHER_FILE_RE.exec(stripLiterals(e));
    if (other) throw new NotExecutable(REASON.otherFile(`${other[1]}()`));
  }
  for (const e of expressions) {
    const placeholder = EXTERNAL_PLACEHOLDER_RE.exec(e);
    if (placeholder) throw new NotExecutable(REASON.placeholder(placeholder[0]));
  }
  for (const e of expressions) {
    const ext = extensionFunction(e);
    if (ext) throw new NotExecutable(REASON.extension(ext));
  }
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

const letBinding = (l) => `$${l.name} := (${l.value})`;

// Evaluated with the document node as context: the pattern's lets, then body.
function documentExpr(patternLets, body) {
  if (patternLets.length === 0) return body;
  return `let ${patternLets.map(letBinding).join(', ')} return (${body})`;
}

// Evaluated with a context node: the pattern's lets (context: the document
// node, reached through root(.)), then the rule's lets (context: the node),
// then body.
function nodeExpr(patternLets, ruleLets, body) {
  if (patternLets.length === 0 && ruleLets.length === 0) return body;
  const bindings = [];
  if (patternLets.length) {
    bindings.push(`$${ROOT_VAR} := root(.)`);
    for (const l of patternLets) bindings.push(`$${l.name} := $${ROOT_VAR} ! (${l.value})`);
  }
  for (const l of ruleLets) bindings.push(letBinding(l));
  return `let ${bindings.join(', ')} return (${body})`;
}

function makeEvaluator(doc, ruleNamespaces) {
  const declared = {};
  for (const a of Array.from(doc.documentElement.attributes || [])) {
    if (a.name.startsWith('xmlns:')) declared[a.name.slice(6)] = a.value;
  }
  const options = {
    language: XPATH_LANGUAGE,
    namespaceResolver: (prefix) =>
      prefix ? BUILTIN_PREFIXES[prefix] ?? ruleNamespaces[prefix] ?? declared[prefix] ?? KNOWN_NAMESPACES[prefix] ?? null : null,
  };
  const { evaluateXPath } = fontoxpath;
  return (expression, contextNode, kind) => {
    try {
      if (kind === 'boolean') return fontoxpath.evaluateXPathToBoolean(expression, contextNode, null, null, options);
      if (kind === 'string') return fontoxpath.evaluateXPathToString(expression, contextNode, null, null, options);
      const items = evaluateXPath(expression, contextNode, null, null, evaluateXPath.ALL_RESULTS_TYPE, options);
      const nonNode = items.find((item) => item === null || typeof item !== 'object' || typeof item.nodeType !== 'number');
      if (nonNode !== undefined) {
        throw new NotExecutable(REASON.notNodes(typeof nonNode === 'boolean' ? 'boolean' : typeof nonNode === 'number' ? 'number' : 'value'));
      }
      return items;
    } catch (err) {
      if (err instanceof NotExecutable) throw err;
      const e = new NotExecutable(REASON.xpath(xpathErrorMessage(err)));
      e.static = /\b(?:XPST|XQST)\d{4}\b/.test(String(err?.message || ''));
      throw e;
    }
  };
}

const collapse = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// The assert/report message. evaluate: null → static text for describeRule,
// where value-of shows as {select} and name as {name()}.
function messageOf(element, evaluateIn) {
  const parts = [];
  const walk = (el) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 4) parts.push(n.data);
      else if (n.nodeType !== 1) continue;
      else if (isSch(n, 'value-of')) {
        const select = n.getAttribute('select') || '.';
        parts.push(evaluateIn ? evaluateIn(`string-join((${select}) ! string(.), ' ')`) : `{${collapseXPath(select)}}`);
      } else if (isSch(n, 'name')) {
        const path = n.getAttribute('path') || '.';
        parts.push(evaluateIn ? evaluateIn(`name(${path})`) : `{name(${path === '.' ? '' : collapseXPath(path)})}`);
      } else walk(n);
    }
  };
  walk(element);
  return collapse(parts.join(''));
}

function runPattern(pattern, globalLets, doc, evaluate) {
  const lets = [...globalLets, ...pattern.lets];
  const fired = new Set();
  const selected = [];
  const violations = new Map();
  const warnings = new Map();
  for (const rule of pattern.rules) {
    if (rule.abstract) continue;
    const nodes = evaluate(documentExpr(lets, `//(${rule.context})`), doc, 'nodes');
    for (const node of nodes) {
      if (fired.has(node)) continue; // an earlier rule of this pattern already judged it
      fired.add(node);
      selected.push(node);
      rule.checks.forEach((check, index) => {
        const holds = evaluate(nodeExpr(lets, rule.lets, `boolean(${check.test})`), node, 'boolean');
        if (check.kind === 'assert' ? holds : !holds) return;
        const message = messageOf(check.element, (body) => evaluate(nodeExpr(lets, rule.lets, body), node, 'string'));
        const bucket = WARNING_ROLES.has(check.role) ? warnings : violations;
        const key = `${pattern.rules.indexOf(rule)}:${index}\u0000${message}`;
        if (!bucket.has(key)) bucket.set(key, { ruleId: check.id || pattern.ruleId, message, role: check.role, nodePaths: [] });
        const entry = bucket.get(key);
        const path = nodePath(node);
        if (!entry.nodePaths.includes(path)) entry.nodePaths.push(path);
      });
    }
  }
  return { selectedNodePaths: selected.map(nodePath), violations: [...violations.values()], warnings: [...warnings.values()] };
}

function notExecutable(r) {
  return { status: 'not_executable', violations: [], warnings: [], selectedNodePaths: [], notExecutableReason: r, notExecutableParts: [], outOfScopeSchemas: [] };
}

function parseRuleDoc(ruleXml, parseXml) {
  return parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
}

export function runSchematronOnFragment(ruleXml, fragmentXml, options = {}) {
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
    ruleDoc = parseRuleDoc(ruleXml, parseXml);
  } catch (err) {
    return notExecutable(REASON.ruleXml(err.message));
  }
  const { patterns, globalLets, namespaces, globalUnsupported } = parseSchematron(ruleDoc.documentElement);
  if (!patterns.length) return notExecutable(REASON.noRule('pattern'));

  activeParseXml = parseXml;
  const evaluate = makeEvaluator(doc, namespaces);
  const violations = [];
  const warnings = [];
  const selected = [];
  const notRun = [];
  let ran = 0;
  for (const pattern of patterns) {
    try {
      staticChecks(pattern, globalLets, globalUnsupported);
      const result = runPattern(pattern, globalLets, doc, evaluate);
      ran += 1;
      selected.push(...result.selectedNodePaths);
      violations.push(...result.violations);
      warnings.push(...result.warnings);
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
      notRun.push({ ruleId: pattern.ruleId, reason: err.reason });
    }
  }
  return {
    status: ran === 0 ? 'not_executable' : violations.length ? 'rejected' : 'accepted',
    violations,
    warnings,
    selectedNodePaths: [...new Set(selected)],
    notExecutableReason: combinedReason(notRun, patterns.length),
    notExecutableParts: notRun,
    outOfScopeSchemas: [],
  };
}

// ─── XPath 3.x syntax in an XPath 2.0 project ───────────────────────────────
// Heuristic (outside string literals), for a warning only: the rule runs
// either way.
const XPATH3_SYNTAX = [
  [/\bfunction\s*\(/, 'inline function'],
  [/(?:^|[^\w.$-])let\s+\$/, 'let expression'],
  [/!(?!=)/, 'simple map operator (!)'],
  [/=>/, 'arrow operator (=>)'],
  [/\|\|/, 'string concatenation (||)'],
  [/\b(?:map|array)\s*\{/, 'map/array constructor'],
  [/\$[A-Za-z_][\w.-]*\s*\(/, 'dynamic function call'],
];
const XPATH3_FUNCTIONS = [
  'head', 'tail', 'for-each', 'filter', 'fold-left', 'fold-right', 'for-each-pair', 'has-children', 'innermost',
  'outermost', 'path', 'sort', 'apply', 'parse-json', 'json-doc', 'serialize', 'contains-token', 'analyze-string',
];
const XPATH3_FUNCTION_RE = new RegExp(`(?<![\\w.$:-])(?:fn:)?(${XPATH3_FUNCTIONS.join('|')})\\s*\\(`, 'g');

function xpath3Features(expression) {
  const text = stripLiterals(expression);
  const found = [];
  for (const [re, label] of XPATH3_SYNTAX) if (re.test(text)) found.push(label);
  for (const m of text.matchAll(XPATH3_FUNCTION_RE)) {
    const label = `${m[1]}()`;
    if (!found.includes(label)) found.push(label);
  }
  return found;
}

// ─── analyzeRule ────────────────────────────────────────────────────────────
// What is known without a fragment: the static checks above, and every
// expression compiled once (a context run on an empty document; the tests,
// lets and messages on its root element). Only static XPath errors (XPST/
// XQST) count here -- a dynamic error on an empty document says nothing
// about a real one. options.standard: "DITA 1.3 Xpath2.0" → XPath 3.x
// syntax is reported in `warnings` (xpath3_syntax {features}).
export function analyzeSchematron(ruleXml, options = {}) {
  const parseXml = options.parseXml || parseXmlDocument;
  const none = (r) => ({ status: 'not_executable', reason: r, parts: [], total: 0, warnings: [] });
  let ruleDoc;
  try {
    ruleDoc = parseRuleDoc(ruleXml, parseXml);
  } catch (err) {
    return none(REASON.ruleXml(err.message));
  }
  const { patterns, globalLets, namespaces, globalUnsupported } = parseSchematron(ruleDoc.documentElement);
  if (!patterns.length) return none(REASON.noRule('pattern'));

  activeParseXml = parseXml;
  const doc = parseXml('<topic/>');
  const evaluate = makeEvaluator(doc, namespaces);
  const staticOnly = (fn) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof NotExecutable && (err.static || err.reason.code === 'path_not_nodes')) throw err;
      if (!(err instanceof NotExecutable)) throw err;
    }
  };
  const notRun = [];
  const features = new Set();
  for (const pattern of patterns) {
    for (const e of patternExpressions(pattern, globalLets)) for (const f of xpath3Features(e)) features.add(f);
    try {
      staticChecks(pattern, globalLets, globalUnsupported);
      const lets = [...globalLets, ...pattern.lets];
      for (const rule of pattern.rules.filter((r) => !r.abstract)) {
        staticOnly(() => evaluate(documentExpr(lets, `//(${rule.context})`), doc, 'nodes'));
        for (const check of rule.checks) {
          staticOnly(() => evaluate(nodeExpr(lets, rule.lets, `boolean(${check.test})`), doc.documentElement, 'boolean'));
          staticOnly(() => messageOf(check.element, (body) => evaluate(nodeExpr(lets, rule.lets, body), doc.documentElement, 'string')));
        }
      }
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
      notRun.push({ ruleId: pattern.ruleId, reason: err.reason });
    }
  }
  const warnings = [];
  if (options.standard === 'DITA 1.3 Xpath2.0' && features.size) {
    warnings.push(reason('xpath3_syntax', { features: [...features].join(', ') }));
  }
  return {
    status: notRun.length === 0 ? 'executable' : notRun.length === patterns.length ? 'not_executable' : 'partial',
    reason: combinedReason(notRun, patterns.length),
    parts: notRun,
    total: patterns.length,
    warnings,
  };
}

// ─── describeRule ───────────────────────────────────────────────────────────
// The rule as it is written, never translated into prose (an XPath test has
// no faithful natural-language reading): one statement per assert/report,
// after the rule's variables, all codes with parameters:
//   describe_sch_variables {context, names}
//   describe_sch_assert {context, test, message, warning}  "must hold"
//   describe_sch_report {context, test, message, warning}  "must not occur"
//   describe_not_executable {reason}                       a pattern the engine cannot run
// warning: role warning/info (never rejects). constant (T4b): the test does
// not depend on the document at all (it evaluates with no context node),
// and an assert that always holds / a report that never occurs can never
// reject. cannotReject: the executable patterns have no assert/report that
// can reject (none at all, only warnings, or only constant checks); a rule
// with no executable pattern is described as not executable instead.

// Whitespace collapsed outside string literals (the template contexts carry
// long runs of spaces from the spreadsheet cells).
function collapseXPath(expression) {
  let out = '';
  let quote = '';
  let space = false;
  for (const ch of String(expression || '')) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (space && out) out += ' ';
      space = false;
      quote = ch;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      space = true;
      continue;
    }
    if (space && out) out += ' ';
    space = false;
    out += ch;
  }
  return out;
}

export function describeSchematron(ruleXml, options = {}) {
  const parseXml = options.parseXml || parseXmlDocument;
  let ruleDoc;
  try {
    ruleDoc = parseRuleDoc(ruleXml, parseXml);
  } catch {
    return { available: false };
  }
  const { patterns, globalLets, namespaces, globalUnsupported } = parseSchematron(ruleDoc.documentElement);
  if (!patterns.length) return { available: false };
  const statements = [];
  let rejecting = false;
  let executable = 0;
  for (const pattern of patterns) {
    let runs = true;
    try {
      staticChecks(pattern, globalLets, globalUnsupported);
      executable += 1;
    } catch (err) {
      if (!(err instanceof NotExecutable)) throw err;
      runs = false;
      statements.push({ ruleIds: [pattern.ruleId], statement: { code: 'describe_not_executable', params: { reason: err.reason } }, schemas: [] });
    }
    const lets = [...globalLets, ...pattern.lets];
    const patternLets = lets.map((l) => l.name);
    for (const rule of pattern.rules.filter((r) => !r.abstract)) {
      const context = collapseXPath(rule.context);
      const names = [...patternLets, ...rule.lets.map((l) => l.name)];
      if (names.length) {
        statements.push({ ruleIds: [pattern.ruleId], statement: { code: 'describe_sch_variables', params: { context, names: names.join(', ') } }, schemas: [] });
      }
      for (const check of rule.checks) {
        const warning = WARNING_ROLES.has(check.role);
        const constant = runs && constantCheck(check, lets, rule.lets, namespaces);
        if (runs && !warning && !constant) rejecting = true;
        statements.push({
          ruleIds: [check.id || pattern.ruleId],
          statement: {
            code: check.kind === 'assert' ? 'describe_sch_assert' : 'describe_sch_report',
            params: { context, test: collapseXPath(check.test), message: messageOf(check.element, null), warning, constant },
          },
          schemas: [],
        });
      }
    }
  }
  return { available: true, statements, cannotReject: executable > 0 && !rejecting };
}

// T4b: true when the check can never reject -- its test evaluates with no
// context node at all (so it does not look at the document) to "holds" for
// an assert or "does not occur" for a report. Any error (the test, or one of
// its lets, reads the context) means it depends on the document: false.
function constantCheck(check, patternLets, ruleLets, namespaces) {
  try {
    const value = fontoxpath.evaluateXPathToBoolean(nodeExpr(patternLets, ruleLets, `boolean(${check.test})`), null, null, null, {
      language: XPATH_LANGUAGE,
      namespaceResolver: (prefix) => (prefix ? BUILTIN_PREFIXES[prefix] ?? namespaces[prefix] ?? KNOWN_NAMESPACES[prefix] ?? null : null),
    });
    return check.kind === 'assert' ? value === true : value === false;
  } catch {
    return false;
  }
}
