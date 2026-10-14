// Test de reglas DITA (funciones XPath que faltan, Part 1): the F&O 3.1
// functions fontoxpath (3.34) does not have, so a rule that uses them runs
// in the test instead of stopping at "XPST0017". Only functions that never
// read anything outside the example: the ones that read other files are the
// dossier's (utils/ruleTestSchematron.js: doc, doc-available, document,
// uri-collection, base-uri, resolve-uri) or not executable (collection,
// unparsed-text*). Pure module (no React, no API): importable from plain
// Node. scripts/test-xpath-functions.mjs lists every F&O 3.1 function and
// fails when one gives XPST0017 without being in NOT_PROVIDED below.
//
// Two mechanisms, chosen by what fontoxpath allows:
//   1. registerCustomXPathFunction in the fn namespace (the same as
//      fn:analyze-string), for functions that take strings and whose name
//      and arity fontoxpath does not have at all: matches#3,
//      substring-before#3, substring-after#3, contains-token#2/#3,
//      normalize-unicode#1/#2, escape-html-uri#1,
//      default-collation#0, default-language#0, static-base-uri#0,
//      in-scope-prefixes#1, namespace-uri-for-prefix#2,
//      element-with-id#1/#2, parse-xml#1, nilled#1.
//   2. A rewrite of the expression before it is evaluated (prepareXPath),
//      for base-uri()/document-uri() with no argument (→ with "."), and for
//      the ones fontoxpath has but cannot run, or that take items a
//      custom function cannot receive ("Cannot pass attribute nodes to
//      custom functions"): replace#4 and tokenize#3 (fontoxpath has them
//      but throws "Using flags … is not supported" for any flags, '' too)
//      become a call to a private function; sort#1/#2/#3, for-each-pair#3
//      and apply#2 become an equivalent XPath expression whose only
//      custom part takes atomic values (sort's keys).
//
// Regular expressions with flags: one conversion for all of them
// (analyze-string, matches#3, replace#4, tokenize#3) -- xpathRegex. With
// no flags or only q/x, matches/replace/tokenize are handed back to
// fontoxpath's own functions (its XSD regex dialect), the pattern changed
// as q/x say; with i, m or s, a JavaScript RegExp built by xpathRegex.
import fontoxpath from 'fontoxpath';
import { parseXmlDocument } from './ruleTestCommon.js';

const FN_NS = 'http://www.w3.org/2005/xpath-functions';
// Private namespace of the rewritten calls (never written by a rule).
export const EXTRA_NS = 'urn:x-brdp-manager:xpath';
const LANGUAGE = fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE;
const CODEPOINT = `${FN_NS}/collation/codepoint`;
const HTML_ASCII_CI = `${FN_NS}/collation/html-ascii-case-insensitive`;

// The functions of F&O 3.1 the test cannot run, with why. Everything else
// runs (natively or from this module). See scripts/test-xpath-functions.mjs.
export const NOT_PROVIDED = {
  // read outside the example's dossier (not executable, external_document)
  'collection#0': 'reads a collection outside the example',
  'collection#1': 'reads a collection outside the example',
  'unparsed-text#1': 'reads a file outside the example',
  'unparsed-text#2': 'reads a file outside the example',
  'unparsed-text-lines#1': 'reads a file outside the example',
  'unparsed-text-lines#2': 'reads a file outside the example',
  'unparsed-text-available#1': 'reads a file outside the example',
  'unparsed-text-available#2': 'reads a file outside the example',
  'json-doc#1': 'reads a file outside the example',
  'json-doc#2': 'reads a file outside the example',
  'environment-variable#1': "reads the validator's environment",
  'available-environment-variables#0': "reads the validator's environment",
  // the validator itself, not a value (no XPath processor of a Schematron
  // validator offers them to the rule)
  'load-xquery-module#1': 'XQuery only',
  'load-xquery-module#2': 'XQuery only',
  'transform#1': 'runs another XSLT transformation',
  // formatting and conversions that depend on pictures, languages,
  // calendars or serialization options: not implemented
  'format-integer#3': "fontoxpath's format-integer#2 handles only part of the pictures ('001' gives 5)",
  'format-number#2': 'picture strings not implemented',
  'format-number#3': 'picture strings not implemented',
  'format-dateTime#2': 'picture strings not implemented',
  'format-dateTime#5': 'picture strings not implemented',
  'format-date#2': 'picture strings not implemented',
  'format-date#5': 'picture strings not implemented',
  'format-time#2': 'picture strings not implemented',
  'format-time#5': 'picture strings not implemented',
  'parse-ietf-date#1': 'not implemented',
  'adjust-dateTime-to-timezone#1': 'time zones not implemented',
  'adjust-dateTime-to-timezone#2': 'time zones not implemented',
  'adjust-date-to-timezone#1': 'time zones not implemented',
  'adjust-date-to-timezone#2': 'time zones not implemented',
  'adjust-time-to-timezone#1': 'time zones not implemented',
  'adjust-time-to-timezone#2': 'time zones not implemented',
  'resolve-QName#2': 'returns an xs:QName (a custom function cannot)',
  'nilled#0': 'needs schema validation (nilled#1 is provided)',
  'parse-xml-fragment#1': 'a document node with several roots (the DOM cannot hold it)',
  'serialize#2': 'serialization options not implemented',
  'parse-json#2': 'options not implemented',
  'json-to-xml#1': 'not implemented',
  'json-to-xml#2': 'not implemented',
  'xml-to-json#1': 'not implemented',
  'xml-to-json#2': 'not implemented',
  'collation-key#1': 'only the codepoint collation',
  'collation-key#2': 'only the codepoint collation',
};

const xpathError = (code, text) => new Error(`${code}: ${text}`);

// ─── Regular expressions ────────────────────────────────────────────────────

const VALID_FLAGS = /^[smixq]*$/;

function checkFlags(flags) {
  const f = String(flags ?? '');
  if (!VALID_FLAGS.test(f)) throw xpathError('FORX0001', `invalid regular expression flags '${f}'`);
  return f;
}

// q: every character literal (XSD regex escape).
const quoteRegex = (pattern) => String(pattern).replace(/[\\.?*+{}()[\]|^$-]/g, '\\$&');

// x: whitespace (#x9 #xA #xD #x20) removed, except inside a character class.
function stripRegexWhitespace(pattern) {
  let out = '';
  let inClass = 0;
  const p = String(pattern);
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '\\') {
      out += ch + (p[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '[') inClass += 1;
    else if (ch === ']' && inClass) inClass -= 1;
    if (!inClass && /[\t\n\r ]/.test(ch)) continue;
    out += ch;
  }
  return out;
}

// The pattern as fontoxpath's own matches/replace/tokenize take it, when
// the flags are only q and x (null when there is i, m or s).
function nativePattern(pattern, flags) {
  if (/[ims]/.test(flags)) return null;
  if (flags.includes('q')) return quoteRegex(pattern);
  if (flags.includes('x')) return stripRegexWhitespace(pattern);
  return String(pattern);
}

const NAME_START = 'A-Za-z_:\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;

// XSD/XPath regex → JavaScript source: \i \c \I \C, character class
// subtraction ([a-z-[aeiou]], with the v flag), q and x as above. Returns
// { source, v }.
function xsdToJs(pattern) {
  const p = String(pattern);
  let out = '';
  let v = false;
  let depth = 0;
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '\\') {
      const next = p[i + 1] ?? '';
      i += 1;
      if (next === 'i') out += depth ? NAME_START : `[${NAME_START}]`;
      else if (next === 'c') out += depth ? NAME_CHAR : `[${NAME_CHAR}]`;
      else if (next === 'I') out += `[^${NAME_START}]`;
      else if (next === 'C') out += `[^${NAME_CHAR}]`;
      else out += `\\${next}`;
      continue;
    }
    if (ch === '[') {
      depth += 1;
      out += ch;
      continue;
    }
    if (ch === '-' && depth && p[i + 1] === '[') {
      // [a-z-[aeiou]] → [[a-z]--[aeiou]] (v flag)
      const open = out.lastIndexOf('[');
      out = `${out.slice(0, open)}[[${out.slice(open + 1)}]--`;
      v = true;
      continue;
    }
    if (ch === ']' && depth) depth -= 1;
    out += ch;
  }
  return { source: out, v };
}

// A JavaScript RegExp for an XPath pattern and flags ('g' added). Throws
// FORX0002 when the pattern is not valid.
export function xpathRegex(pattern, flags = '') {
  const f = checkFlags(flags);
  let source;
  let v = false;
  if (f.includes('q')) source = quoteRegex(pattern).replace(/\\-/g, '-');
  else {
    const converted = xsdToJs(f.includes('x') ? stripRegexWhitespace(pattern) : pattern);
    source = converted.source;
    v = converted.v;
  }
  const js = `g${f.includes('i') ? 'i' : ''}${f.includes('m') ? 'm' : ''}${f.includes('s') ? 's' : ''}`;
  for (const extra of v ? ['v'] : ['u', '']) {
    try {
      return new RegExp(source, js + extra);
    } catch {
      // try the next dialect
    }
  }
  throw xpathError('FORX0002', `invalid regular expression '${pattern}'`);
}

function noZeroLength(re, pattern) {
  re.lastIndex = 0;
  const m = re.exec('');
  re.lastIndex = 0;
  if (m) throw xpathError('FORX0003', `the regular expression '${pattern}' matches a zero-length string`);
}

const native = (expression, variables) => fontoxpath.evaluateXPath(expression, null, null, variables, fontoxpath.evaluateXPath.ANY_TYPE, { language: LANGUAGE });

function matches3(input, pattern, flags) {
  const f = checkFlags(flags);
  const p = nativePattern(pattern, f);
  if (p !== null) return Boolean(native('matches($i, $p)', { i: input ?? '', p }));
  const re = xpathRegex(pattern, f);
  return re.test(input ?? '');
}

// XPath replacement string → the replaced text of one match.
function replacementFor(replacement, quoted) {
  const r = String(replacement);
  if (quoted) return () => r;
  const parts = [];
  for (let i = 0; i < r.length; i += 1) {
    const ch = r[i];
    if (ch === '\\') {
      const next = r[i + 1];
      if (next !== '\\' && next !== '$') throw xpathError('FORX0004', `invalid replacement string '${r}'`);
      parts.push(next);
      i += 1;
    } else if (ch === '$') {
      let j = i + 1;
      while (j < r.length && /[0-9]/.test(r[j])) j += 1;
      if (j === i + 1) throw xpathError('FORX0004', `invalid replacement string '${r}'`);
      parts.push({ digits: r.slice(i + 1, j) });
      i = j - 1;
    } else parts.push(ch);
  }
  return (groups) =>
    parts
      .map((part) => {
        if (typeof part === 'string') return part;
        // $12 is group 12 when it exists, else group 1 then "2"
        let d = part.digits;
        while (d.length > 1 && Number(d) >= groups.length) d = d.slice(0, -1);
        const n = Number(d);
        const rest = part.digits.slice(d.length);
        return (n < groups.length ? groups[n] ?? '' : '') + rest;
      })
      .join('');
}

function replace4(input, pattern, replacement, flags) {
  const f = checkFlags(flags);
  const p = nativePattern(pattern, f);
  if (p !== null && !f.includes('q')) return String(native('replace($i, $p, $r)', { i: input ?? '', p, r: replacement }));
  const re = xpathRegex(pattern, f);
  noZeroLength(re, pattern);
  const build = replacementFor(replacement, f.includes('q'));
  return String(input ?? '').replace(re, (...args) => {
    const groups = args.slice(0, args.findIndex((a) => typeof a === 'number'));
    return build(groups);
  });
}

function tokenize3(input, pattern, flags) {
  const f = checkFlags(flags);
  const text = String(input ?? '');
  if (text === '') return [];
  const p = nativePattern(pattern, f);
  if (p !== null) return native('tokenize($i, $p)', { i: text, p });
  const re = xpathRegex(pattern, f);
  noZeroLength(re, pattern);
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

// ─── Collations and string functions ────────────────────────────────────────

function collationKey(collation) {
  const c = collation === null || collation === undefined || collation === '' ? CODEPOINT : String(collation);
  if (c === CODEPOINT) return (s) => s;
  if (c === HTML_ASCII_CI) return (s) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  throw xpathError('FOCH0002', `the collation '${c}' is not supported (only the codepoint collation)`);
}

// Compares two strings by Unicode codepoint (not UTF-16 unit).
function compareCodepoints(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

function substringBefore3(s, t, collation) {
  const key = collationKey(collation);
  const a = String(s ?? '');
  const i = key(a).indexOf(key(String(t ?? '')));
  return i < 0 ? '' : a.slice(0, i);
}

function substringAfter3(s, t, collation) {
  const key = collationKey(collation);
  const a = String(s ?? '');
  const b = String(t ?? '');
  const i = key(a).indexOf(key(b));
  return i < 0 ? '' : a.slice(i + b.length);
}

function containsToken(input, token, collation) {
  const key = collationKey(collation);
  const tok = key(String(token ?? '').replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ''));
  if (!tok) return false;
  return (Array.isArray(input) ? input : [input]).some((s) =>
    String(s ?? '')
      .split(/[\t\n\r ]+/)
      .some((w) => w && key(w) === tok),
  );
}

// fn:sort's order: keys compared like `lt` on atomized values -- numbers
// as numbers, everything else as strings in the collation; a number
// against a string is XPTY0004. NaN before everything; the empty key
// first. Sequences of keys compared item by item.
function compareKeys(a, b, key) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn !== yn && !(typeof x === 'boolean' && typeof y === 'boolean')) {
      throw xpathError('XPTY0004', `sort(): cannot compare ${typeof x === 'number' ? 'a number' : 'a string'} with ${typeof y === 'number' ? 'a number' : 'a string'}`);
    }
    let d;
    if (xn) {
      if (Number.isNaN(x) || Number.isNaN(y)) d = Number.isNaN(x) === Number.isNaN(y) ? 0 : Number.isNaN(x) ? -1 : 1;
      else d = x < y ? -1 : x > y ? 1 : 0;
    } else if (typeof x === 'boolean') d = x === y ? 0 : x ? 1 : -1;
    else d = compareCodepoints(key(String(x)), key(String(y)));
    if (d) return d;
  }
  return a.length - b.length;
}

// counts: how many key values each item has; values: all of them, in
// order. → the items' positions (1-based) in sorted order, stable.
function sortOrder(counts, values, collation) {
  const key = collationKey(collation);
  const items = [];
  let at = 0;
  (counts || []).forEach((n, i) => {
    items.push({ i: i + 1, keys: (values || []).slice(at, at + Number(n)) });
    at += Number(n);
  });
  items.sort((a, b) => compareKeys(a.keys, b.keys, key));
  return items.map((it) => it.i);
}

function inScopePrefixes(el) {
  const out = new Set(['xml']);
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    for (const a of Array.from(n.attributes || [])) {
      if (a.name === 'xmlns' && a.value) out.add('');
      else if (a.name.startsWith('xmlns:')) out.add(a.name.slice(6));
    }
    if (n.prefix) out.add(n.prefix);
    else if (n.namespaceURI) out.add('');
  }
  return [...out];
}

function namespaceForPrefix(prefix, el) {
  const p = prefix ?? '';
  if (p === 'xml') return 'http://www.w3.org/XML/1998/namespace';
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const name = p ? `xmlns:${p}` : 'xmlns';
    if (n.hasAttribute?.(name)) return n.getAttribute(name) || null;
    if ((n.prefix || '') === p && n.namespaceURI) return n.namespaceURI;
  }
  return null;
}

// element-with-id: the elements of $n's document whose xml:id or id is one
// of the whitespace-separated values (no DTD: every id attribute counts).
function elementsWithId(ids, node) {
  const wanted = new Set((ids || []).flatMap((s) => String(s).split(/[\t\n\r ]+/)).filter(Boolean));
  const doc = node?.nodeType === 9 ? node : node?.ownerDocument;
  const out = [];
  const walk = (el) => {
    for (let c = el?.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const id = c.getAttribute('xml:id') || c.getAttribute('id');
      if (id && wanted.has(id)) out.push(c);
      walk(c);
    }
  };
  walk(doc);
  return out;
}

let parseXmlForExtra = parseXmlDocument;
// The XML parser of the current run (parse-xml): set by the engines.
export function setExtraParser(parseXml) {
  parseXmlForExtra = parseXml || parseXmlDocument;
}

const REGISTRATIONS = [
  ['matches', ['xs:string?', 'xs:string', 'xs:string'], 'xs:boolean', (_c, i, p, f) => matches3(i, p, f)],
  ['substring-before', ['xs:string?', 'xs:string?', 'xs:string'], 'xs:string', (_c, s, t, c) => substringBefore3(s, t, c)],
  ['substring-after', ['xs:string?', 'xs:string?', 'xs:string'], 'xs:string', (_c, s, t, c) => substringAfter3(s, t, c)],
  ['contains-token', ['xs:string*', 'xs:string'], 'xs:boolean', (_c, i, t) => containsToken(i, t, null)],
  ['contains-token', ['xs:string*', 'xs:string', 'xs:string'], 'xs:boolean', (_c, i, t, c) => containsToken(i, t, c)],
  ['normalize-unicode', ['xs:string?'], 'xs:string', (_c, s) => String(s ?? '').normalize('NFC')],
  [
    'normalize-unicode',
    ['xs:string?', 'xs:string'],
    'xs:string',
    (_c, s, form) => {
      const f = String(form ?? '').trim().toUpperCase();
      if (f === '') return String(s ?? '');
      if (!['NFC', 'NFD', 'NFKC', 'NFKD'].includes(f)) throw xpathError('FOCH0003', `normalization form '${form}' is not supported`);
      return String(s ?? '').normalize(f);
    },
  ],
  ['escape-html-uri', ['xs:string?'], 'xs:string', (_c, s) => String(s ?? '').replace(/[^\x20-\x7E]/gu, (ch) => encodeURIComponent(ch))],
  ['default-collation', [], 'xs:string', () => CODEPOINT],
  ['default-language', [], 'xs:string', () => 'en'],
  ['static-base-uri', [], 'xs:string?', () => null],
  ['in-scope-prefixes', ['element()'], 'xs:string*', (_c, el) => inScopePrefixes(el)],
  ['namespace-uri-for-prefix', ['xs:string?', 'element()'], 'xs:string?', (_c, p, el) => namespaceForPrefix(p, el)],
  ['element-with-id', ['xs:string*'], 'element()*', () => {
    throw xpathError('XPDY0002', 'element-with-id() with one argument needs the context node; give it as the second argument');
  }],
  ['element-with-id', ['xs:string*', 'node()'], 'element()*', (_c, ids, n) => elementsWithId(ids, n)],
  [
    'parse-xml',
    ['xs:string?'],
    'document-node()?',
    (_c, s) => {
      if (s === null || s === undefined) return null;
      if (!parseXmlForExtra) throw xpathError('FODC0006', 'no XML parser available');
      try {
        return parseXmlForExtra(String(s));
      } catch (err) {
        throw xpathError('FODC0006', `the string is not well-formed XML (${err.message})`);
      }
    },
  ],
  ['nilled', ['node()?'], 'xs:boolean?', (_c, n) => (n && n.nodeType === 1 ? false : null)],
];
const PRIVATE = [
  ['replace', ['xs:string?', 'xs:string', 'xs:string', 'xs:string'], 'xs:string', (_c, i, p, r, f) => replace4(i, p, r, f)],
  ['tokenize', ['xs:string?', 'xs:string', 'xs:string'], 'xs:string*', (_c, i, p, f) => tokenize3(i, p, f)],
  ['sort-order', ['xs:integer*', 'xs:anyAtomicType*', 'xs:string?'], 'xs:integer*', (_c, n, v, c) => sortOrder(n, v, c)],
];
for (const [ns, list] of [
  [FN_NS, REGISTRATIONS],
  [EXTRA_NS, PRIVATE],
]) {
  for (const [name, params, returns, fn] of list) {
    try {
      fontoxpath.registerCustomXPathFunction({ namespaceURI: ns, localName: name }, params, returns, fn);
    } catch {
      // already registered (module reloaded)
    }
  }
}

// ─── The rewrite (prepareXPath) ─────────────────────────────────────────────

// The expression with every string literal's content blanked (same length),
// so a scan never looks inside a literal.
function maskLiterals(text) {
  let out = '';
  let quote = '';
  for (const ch of text) {
    if (quote) {
      out += ch === quote ? ch : ' ';
      if (ch === quote) quote = '';
    } else {
      if (ch === "'" || ch === '"') quote = ch;
      out += ch;
    }
  }
  return out;
}

// Index of the ')' closing the '(' at `open`, and the top-level commas.
function callExtent(masked, open) {
  let depth = 0;
  const commas = [];
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return { close: i, commas };
    } else if (ch === ',' && depth === 1) commas.push(i);
  }
  return null;
}

const CALL_RE = /(?<![\w.$:\-}/@])(?:fn:)?(sort|replace|tokenize|for-each-pair|apply)\s*\(/g;
let counter = 0;
const v = (name) => `$brdp_${name}${counter}`;

function rewriteCall(name, args) {
  const n = args.length;
  if (name === 'replace' && n === 4) return `Q{${EXTRA_NS}}replace(${args.join(',')})`;
  if (name === 'tokenize' && n === 3) return `Q{${EXTRA_NS}}tokenize(${args.join(',')})`;
  if (name === 'sort' && n >= 1 && n <= 3) {
    counter += 1;
    const [s, c, k] = [v('s'), v('c'), v('k')];
    const [x, i] = [v('x'), v('i')];
    const keyOf = n === 3 ? `data(${k}(${x}))` : `data(${x})`;
    return (
      `(let ${s} := (${args[0]}), ${c} := (${n >= 2 ? args[1] : '()'})${n === 3 ? `, ${k} := (${args[2]})` : ''}` +
      ` return for ${i} in Q{${EXTRA_NS}}sort-order((for ${x} in ${s} return count(${keyOf})), (for ${x} in ${s} return ${keyOf}), ${c}) return ${s}[${i}])`
    );
  }
  if (name === 'for-each-pair' && n === 3) {
    counter += 1;
    const [a, b, f, i] = [v('a'), v('b'), v('f'), v('i')];
    return `(let ${a} := (${args[0]}), ${b} := (${args[1]}), ${f} := (${args[2]}) return for ${i} in 1 to min((count(${a}), count(${b}))) return ${f}(${a}[${i}], ${b}[${i}]))`;
  }
  if (name === 'apply' && n === 2) {
    counter += 1;
    const [f, a] = [v('f'), v('a')];
    const call = (k) => `${f}(${Array.from({ length: k }, (_, j) => `${a}(${j + 1})`).join(', ')})`;
    let body = `error(QName('${FN_NS}', 'FOAP0001'), 'apply(): the array has more members than the test supports (8)')`;
    for (let k = 8; k >= 0; k -= 1) body = `if (array:size(${a}) = ${k}) then ${call(k)} else ${body}`;
    return `(let ${f} := (${args[0]}), ${a} := (${args[1]}) return ${body})`;
  }
  return null;
}

// base-uri() and document-uri() with no argument → with "." (a custom
// function cannot see the context item), outside string literals.
function contextItemArgument(expression) {
  if (!/(?:base|document)-uri\s*\(\s*\)/.test(expression)) return expression;
  return expression
    .split(/('[^']*'|"[^"]*")/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<![\w.$:-])((?:fn:)?(?:base|document)-uri)\s*\(\s*\)/g, '$1(.)')))
    .join('');
}

// The expression ready for fontoxpath: the calls above rewritten (inside
// out); everything else byte for byte.
export function prepareXPath(expression) {
  const text = contextItemArgument(String(expression ?? ''));
  if (!/(?:sort|replace|tokenize|for-each-pair|apply)\s*\(/.test(text)) return text;
  const masked = maskLiterals(text);
  let out = '';
  let last = 0;
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(masked); m; m = CALL_RE.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const extent = callExtent(masked, open);
    if (!extent) break;
    const bounds = [open, ...extent.commas, extent.close];
    const inner = text.slice(open + 1, extent.close);
    const args = inner.trim() === '' ? [] : bounds.slice(0, -1).map((b, j) => prepareXPath(text.slice(b + 1, bounds[j + 1])));
    const rewritten = rewriteCall(m[1], args);
    out += text.slice(last, m.index) + (rewritten ?? `${text.slice(m.index, open + 1)}${args.join(',')})`);
    last = extent.close + 1;
    CALL_RE.lastIndex = last;
  }
  return out + text.slice(last);
}
