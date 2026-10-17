// Namespace prefixes the XPath of a Schematron uses, and the ones it
// declares. Pure and string-based (no DOMParser), so the same code runs in
// the browser, in Generate and in plain Node tests.
//
// What a real Schematron compiler reads: only <sch:ns prefix uri> declares a
// prefix for the XPath of the rules. An xmlns:xs on a sch:pattern does not
// (checked with SchXslt 1.9.5 + Saxon-HE 9.9: XPST0081 "Namespace prefix
// 'math' has not been declared" with xmlns:math on the pattern, fine with
// <sch:ns prefix="math">). SchXslt happens to declare xs itself, other
// compilers (the ISO skeleton) do not, so xs counts like any other.

// The prefixes of XPath's own namespaces, and their URIs. Generate declares
// one that a rule uses without declaring (sch:ns); the URI is fixed by the
// specifications, so there is nothing to guess.
export const XPATH_STANDARD_NAMESPACES = {
  xs: 'http://www.w3.org/2001/XMLSchema',
  fn: 'http://www.w3.org/2005/xpath-functions',
  math: 'http://www.w3.org/2005/xpath-functions/math',
  map: 'http://www.w3.org/2005/xpath-functions/map',
  array: 'http://www.w3.org/2005/xpath-functions/array',
  err: 'http://www.w3.org/2005/xqt-errors',
};
export const XPATH_STANDARD_PREFIXES = Object.keys(XPATH_STANDARD_NAMESPACES);

// Bound in every XML document, never declared.
const ALWAYS_BOUND = new Set(['xml', 'xmlns']);

// Schematron attributes whose value is an XPath expression.
const XPATH_ATTRIBUTES = new Set(['test', 'context', 'value', 'select', 'path', 'subject']);

const ATTR_LIST = String.raw`(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*`;
const ATTR_RE_G = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const START_TAG_RE_G = new RegExp(`<([A-Za-z_][\\w:.-]*)(${ATTR_LIST})\\s*/?>`, 'g');
const PATTERN_RE_G = new RegExp(`<(?:[\\w.-]+:)?pattern\\b(${ATTR_LIST})\\s*(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?pattern\\s*>)`, 'g');
const NS_RE_G = new RegExp(`<(?:[\\w.-]+:)?ns\\b(${ATTR_LIST})\\s*/?>`, 'g');
const PREFIX_RE_G = /(?<![\p{L}\p{N}_.\-:])([\p{L}_][\p{L}\p{N}_.-]*):(?=[\p{L}_*])/gu;

function attributes(attrs) {
  const out = [];
  for (const m of String(attrs || '').matchAll(ATTR_RE_G)) out.push([m[1], m[2] ?? m[3]]);
  return out;
}

function attribute(attrs, name) {
  const found = attributes(attrs).find(([n]) => n === name);
  return found ? found[1] : null;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// The expression without what never holds a prefix: XPath comments (: … :)
// (they nest), string literals ('it''s', "say ""x""") and the URI of an
// EQName Q{…}.
function codeOnly(expression) {
  const s = String(expression || '');
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (s.startsWith('(:', i)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (s.startsWith(':)', i)) {
        depth -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === ch) {
          if (s[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += ' ';
      i = j;
      continue;
    }
    if (ch === 'Q' && s[i + 1] === '{') {
      const end = s.indexOf('}', i + 2);
      if (end !== -1) {
        out += ' ';
        i = end;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// The prefixes one XPath expression uses (as written in an attribute: its
// entities are decoded first). "prefix:name", "prefix:*", "@prefix:name",
// "$prefix:name" and a type such as "as xs:string" all count; an axis
// (child::x), ":=" and the local part of a name never do.
export function xpathPrefixes(expression) {
  const found = new Set();
  for (const m of codeOnly(decodeEntities(expression)).matchAll(PREFIX_RE_G)) {
    if (!ALWAYS_BOUND.has(m[1])) found.add(m[1]);
  }
  return found;
}

function withoutComments(xml) {
  return String(xml || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
}

function usesInTags(text, owner, out) {
  for (const tag of text.matchAll(START_TAG_RE_G)) {
    for (const [name, value] of attributes(tag[2])) {
      if (!XPATH_ATTRIBUTES.has(name.replace(/^.*:/, ''))) continue;
      for (const prefix of xpathPrefixes(value)) {
        if (!out.has(prefix)) out.set(prefix, new Set());
        if (owner) out.get(prefix).add(owner);
      }
    }
  }
}

// prefix -> Set of where it is used: the id of its sch:pattern (else its
// first sch:assert/report id), or "$name" for a let outside any pattern.
// XML comments and CDATA never count.
export function schematronPrefixUses(xml) {
  const text = withoutComments(xml);
  const out = new Map();
  let rest = text;
  for (const pm of text.matchAll(PATTERN_RE_G)) {
    const body = pm[2] || '';
    const checkId = /<(?:[\w.-]+:)?(?:assert|report)\b[^>]*?\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(body);
    const owner = attribute(pm[1], 'id') || (checkId ? checkId[1] ?? checkId[2] : '') || 'pattern';
    usesInTags(pm[0], owner, out);
    rest = rest.replace(pm[0], ' ');
  }
  for (const tag of rest.matchAll(START_TAG_RE_G)) {
    const name = attribute(tag[2], 'name');
    usesInTags(tag[0], /(?:^|:)let$/.test(tag[1]) && name ? `$${name}` : 'schema', out);
  }
  return out;
}

// prefix -> URI of every xmlns:prefix declared in the text (any element,
// outside comments), first one kept.
export function xmlnsDeclarations(xml) {
  const out = new Map();
  for (const tag of withoutComments(xml).matchAll(START_TAG_RE_G)) {
    for (const [name, value] of attributes(tag[2])) {
      const m = /^xmlns:(.+)$/.exec(name);
      if (m && !ALWAYS_BOUND.has(m[1]) && !out.has(m[1])) out.set(m[1], value);
    }
  }
  return out;
}

// prefix -> URI of the <sch:ns> declarations of a Schematron document.
export function schNsDeclarations(xml) {
  const out = new Map();
  for (const m of withoutComments(xml).matchAll(NS_RE_G)) {
    const prefix = attribute(m[1], 'prefix');
    if (prefix && !out.has(prefix)) out.set(prefix, attribute(m[1], 'uri') || '');
  }
  return out;
}

// [{prefix, owners}] for the prefixes the XPath of a Schematron uses with
// no <sch:ns> for them -- what a compiler refuses (XPST0081).
export function undeclaredSchematronPrefixes(xml) {
  const declared = schNsDeclarations(xml);
  return [...schematronPrefixUses(xml)]
    .filter(([prefix]) => !declared.has(prefix))
    .map(([prefix, owners]) => ({ prefix, owners: [...owners] }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

// The prefixes one rule uses with no declaration of its own (no xmlns:x
// anywhere in it, no sch:ns in it), split into XPath's own ones (Generate
// declares them) and the rest.
export function ruleUndeclaredPrefixes(ruleXml) {
  const declared = new Set([...xmlnsDeclarations(ruleXml).keys(), ...schNsDeclarations(ruleXml).keys()]);
  const missing = [...schematronPrefixUses(ruleXml).keys()].filter((p) => !declared.has(p)).sort();
  return {
    known: missing.filter((p) => XPATH_STANDARD_PREFIXES.includes(p)),
    unknown: missing.filter((p) => !XPATH_STANDARD_PREFIXES.includes(p)),
  };
}
