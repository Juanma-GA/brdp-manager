// Shared by the two rule test engines (Test rule): utils/ruleTestEngine.js
// (BREX, T1) and utils/ruleTestSchematron.js (Schematron, T4). Pure module
// (no React, no API), importable from plain Node.
import { xpathBalanceProblem } from '../validation/xpathBalance.js';
import fontoxpath from 'fontoxpath';

export const XPATH_LANGUAGE = fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE;

// Functions that read another file: never available in a test.
export const OTHER_FILE_RE = /\b(document|doc|doc-available|collection|unparsed-text(?:-lines|-available)?)\s*\(/;

// T4b: a literal the project's own tooling replaces AFTER Generate (e.g.
// '@@URI-CARPETA-DOSIER@@' in the DITA XPath 2.0 template): the rule as
// stored is not the rule that runs, so it cannot be tested here.
export const EXTERNAL_PLACEHOLDER_RE = /@@[^@\s'"]+@@/;

// Prefixes a rule path may use without the fragment declaring them.
export const KNOWN_NAMESPACES = {
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  xlink: 'http://www.w3.org/1999/xlink',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://www.purl.org/dc/elements/1.1/',
  xml: 'http://www.w3.org/XML/1998/namespace',
};

// Reasons are codes with parameters, never sentences (T3, Part 0): the UI
// translates them (records.ruleTest.reasons.<code>, src/utils/
// ruleTestReasons.js), and the recorded test result keeps the code so
// History and the Rule Status indicator follow the viewer's language.
export const reason = (code, params = {}) => ({ code, params });

// The reason of a rule with several parts, some of which cannot run.
export function combinedReason(notRun, totalParts) {
  if (notRun.length === 0) return null;
  if (totalParts === 1) return notRun[0].reason;
  return reason('parts', { parts: notRun });
}

export class NotExecutable extends Error {
  constructor(r) {
    super(r.code);
    this.reason = r;
  }
}

// Mejoras E, Part 2.3: an error the engine gives WHILE running the rule on
// an example (fontoxpath's dynamic errors: XPTY…, FORG…, XPDY…; never a
// static XPST/XQST error, which does not depend on the example and stays
// "not executable"). Caught as NotExecutable everywhere that only needs to
// know the rule did not run (analyzeRule, the descriptions); the two
// engines' run on a fragment tell it apart: the rule is wrong on this
// example -- the test fails, with the reason in plain words.
// An invalid regular expression or flags in the rule (FORX0001/0002) is a
// defect of the rule, not of the example.
const STATIC_ERROR_RE = /\b(?:(?:XPST|XQST)\d{4}|FORX000[12])\b/;
export class RuleRuntimeError extends NotExecutable {
  constructor(message, expression) {
    super(reason('xpath_error', { message }));
    this.runtime = engineErrorDetail(message, expression);
  }
}

// The evaluator's error for `err` while evaluating `expression`.
export function evaluationError(err, expression) {
  const message = xpathErrorMessage(err);
  if (STATIC_ERROR_RE.test(String(err?.message || ''))) {
    // Mejoras F, Part 2.3: an unbalanced ( [ or quote, in plain words.
    const balance = xpathBalanceProblem(expression);
    const e = new NotExecutable(reason('xpath_error', balance ? { message, balance } : { message }));
    e.static = true;
    return e;
  }
  return new RuleRuntimeError(message, expression);
}

// { code, message, plain: { code, params } } -- plain is what the panel
// says in words: a function given several nodes where it takes one
// (XPTY0004, real case: normalize-space(ancestor::applic/displaytext/p)
// with two <p>) names the function and the elements its argument selects;
// anything else is said with the engine's own message.
export function engineErrorDetail(message, expression = '') {
  const code = (/\b([A-Z]{4}\d{4})\b/.exec(message) || [])[1] || null;
  const many = /Multiplicity of function argument[^.]*? for ([\w:.-]+) is incorrect\. Expected "\??", but got "[+*]"/.exec(message);
  if (many) {
    const fn = many[1].replace(/^fn:/, '');
    return { code, message, plain: { code: 'engine_several_items', params: { fn, names: argumentNames(expression, fn) } } };
  }
  return { code, message, plain: { code: 'engine_other', params: {} } };
}

// The last element step of every path argument of fn(...) in the
// expression, outside string literals: "normalize-space(ancestor::applic/
// displaytext/p)" → ['p']. A call whose argument is another call or a
// variable gives nothing.
function argumentNames(expression, fn) {
  const text = String(expression || '').replace(/'[^']*'|"[^"]*"/g, (m) => ' '.repeat(m.length));
  const names = [];
  const re = new RegExp(`(?<![\\w.:-])(?:fn:)?${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');
  for (const m of text.matchAll(re)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === '(' || text[i] === '[') depth += 1;
      else if (text[i] === ')' || text[i] === ']') depth -= 1;
    }
    const arg = text.slice(start, i - 1).trim();
    if (!arg || /^[$\w.:-]+\s*\(/.test(arg) || arg.startsWith('$')) continue;
    // the last step, without its predicates
    let flat = '';
    let d = 0;
    for (const ch of arg) {
      if (ch === '[' || ch === '(') d += 1;
      if (d === 0) flat += ch;
      if (ch === ']' || ch === ')') d -= 1;
    }
    const last = flat.split('/').pop().trim().replace(/^(?:child|descendant|descendant-or-self|ancestor|ancestor-or-self|parent|self|following-sibling|preceding-sibling)::/, '');
    if (/^[A-Za-z_][\w.-]*$/.test(last) && !names.includes(last)) names.push(last);
  }
  return names;
}

export function parseXmlDocument(text) {
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
export function xpathErrorMessage(err) {
  const text = String(err?.message || err || '');
  const line = text.split('\n').find((l) => /\b[A-Z]{4}\d{4}\b/.test(l));
  return (line || text.split('\n')[0]).replace(/^Error:\s*/, '').trim();
}

export function localName(node) {
  return node.localName || String(node.nodeName).replace(/^.*:/, '');
}

// XPath-like path of a node for highlighting: /dmodule[1]/content[1]/para[2]/@x
export function nodePath(node) {
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

// The expression with its string literals emptied ('…' → ''), so a pattern
// match never looks inside a literal.
export function stripLiterals(expression) {
  return String(expression || '').replace(/'[^']*'|"[^"]*"/g, "''");
}

// Mejoras B, Part 1: the expression without its predicates ([…], nested
// ones included), string literals OUTSIDE the predicates kept -- the path
// the rule walks before filtering, to tell "no node of that kind here"
// from "nodes of that kind, none of which meets the predicate". Steps such
// as * and the axes are kept: //entry/*[@a] → //entry/*.
export function withoutPredicates(expression) {
  let out = '';
  let depth = 0;
  let quote = '';
  for (const ch of String(expression || '')) {
    if (quote) {
      if (depth === 0) out += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (depth === 0) out += ch;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}
