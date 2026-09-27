// Suggest Rule validation (docs request, Suggest Rule round, Part 4):
// deterministic, only ever WARNS, never blocks. Pulls the element and
// attribute names a rule's XPath expressions actually reference and checks
// them against the standard's real schema vocabulary (the same
// public/schema-vocabulary-*.json the BRDP text check uses), so an invented
// element in a generated -- or hand-pasted -- rule is flagged before it is
// saved as Draft.
//
// Where the XPath lives, per format:
//   BREX 4.2/4.1 -> <objectPath> text      BREX 3.0.1 -> <objpath> text
//   Schematron   -> @context and @test (sch:rule / sch:assert / sch:report,
//                   with or without the sch: prefix)
//
// Pure string processing (no DOMParser) so it runs the same under plain
// Node for scripts/test-rule-name-check.mjs.
import { checkAgainstVocabulary } from './vocabularyCheck.js';

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(lt|gt|amp|quot|apos);/g, (_, name) => XML_ENTITIES[name]);
}

const TEXT_PATH_RE = /<(objectPath|objpath)\b[^>]*>([\s\S]*?)<\/\1>/g;
const SCH_ATTR_RE = /<(?:[A-Za-z_][\w.-]*:)?(?:rule|assert|report)\b([^>]*)>/g;
const CONTEXT_TEST_ATTR_RE = /\s(context|test)\s*=\s*("([^"]*)"|'([^']*)')/g;

// Every XPath expression in a rule fragment, entity-decoded.
export function extractRuleXPaths(ruleXml) {
  const source = ruleXml || '';
  const out = [];
  let m;
  TEXT_PATH_RE.lastIndex = 0;
  while ((m = TEXT_PATH_RE.exec(source))) out.push(decodeEntities(m[2].trim()));
  SCH_ATTR_RE.lastIndex = 0;
  while ((m = SCH_ATTR_RE.exec(source))) {
    let a;
    CONTEXT_TEST_ATTR_RE.lastIndex = 0;
    while ((a = CONTEXT_TEST_ATTR_RE.exec(m[1]))) {
      out.push(decodeEntities(a[3] !== undefined ? a[3] : a[4]));
    }
  }
  return out.filter(Boolean);
}

// XPath 2.0/3.0 operator/keyword words. Only treated as operators when they
// are NOT in a path-step position (see extractXPathNames) -- "//map" is
// DITA's real <map> element, "a map b" never happens.
const XPATH_KEYWORDS = new Set([
  'and', 'or', 'div', 'idiv', 'mod', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'is',
  'if', 'then', 'else', 'for', 'let', 'in', 'return', 'some', 'every', 'satisfies',
  'as', 'instance', 'of', 'treat', 'cast', 'castable', 'to', 'union', 'intersect', 'except',
]);

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.-]/;

// Element/attribute names referenced by ONE XPath expression. Ignored:
// string literals, variables ($x), function calls and kind tests (a name
// followed by "("), axes (name followed by "::"), wildcards, numbers,
// operator keywords, and any namespace-prefixed name (xs:string, fn:head,
// sch:..., xlink:href) -- the vocabulary is unprefixed local names, and a
// prefixed token is far more often a type or function than a schema name,
// so checking it would only produce false red warnings.
export function extractXPathNames(xpath) {
  const src = xpath || '';
  const elements = new Set();
  const attributes = new Set();
  let i = 0;
  let prevSignificant = ''; // last non-space character consumed
  let pendingAttributeAxis = false;

  const peekNonSpace = (from) => {
    let j = from;
    while (j < src.length && /\s/.test(src[j])) j++;
    return j;
  };

  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = src.indexOf(ch, i + 1);
      i = close === -1 ? src.length : close + 1;
      prevSignificant = ch;
      continue;
    }
    if (ch === '$') {
      i++;
      while (i < src.length && (NAME_CHAR.test(src[i]) || src[i] === ':')) i++;
      prevSignificant = 'v';
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      i++;
      while (i < src.length && /[0-9.eE]/.test(src[i])) i++;
      prevSignificant = '0';
      continue;
    }
    if (NAME_START.test(ch)) {
      const start = i;
      while (i < src.length && NAME_CHAR.test(src[i])) i++;
      let name = src.slice(start, i);
      // A trailing "." or "-" is never part of a name here ("a -1", "x.").
      while (/[.-]$/.test(name)) {
        name = name.slice(0, -1);
        i--;
      }
      let prefixed = false;
      if (src[i] === ':' && src[i + 1] !== ':' && NAME_START.test(src[i + 1] || '')) {
        prefixed = true;
        i++;
        while (i < src.length && NAME_CHAR.test(src[i])) i++;
      }
      const next = peekNonSpace(i);
      const isAxis = src[next] === ':' && src[next + 1] === ':';
      const isCall = src[next] === '(';
      const afterAt = prevSignificant === '@';
      const inStepPosition = prevSignificant === '' || '/@[(,|:'.includes(prevSignificant);
      // "for $x in", "some $r in", "let $v :=" -- a keyword binding a
      // variable is always an operator, even at the start of the path.
      const isOperator = XPATH_KEYWORDS.has(name) && (!inStepPosition || src[next] === '$');

      if (isAxis) {
        pendingAttributeAxis = name === 'attribute';
        i = next + 2;
        prevSignificant = ':';
        continue;
      }
      if (!prefixed && !isCall && !isOperator) {
        if (afterAt || pendingAttributeAxis) attributes.add(name);
        else elements.add(name);
      }
      pendingAttributeAxis = false;
      prevSignificant = 'n';
      continue;
    }
    // Any other punctuation: operators, brackets, "/", "@", "*", "|", ",".
    if (ch !== '*') pendingAttributeAxis = false;
    prevSignificant = ch;
    i++;
  }
  return { elements: [...elements], attributes: [...attributes] };
}

// All names referenced by a whole rule fragment.
export function extractRuleNames(ruleXml) {
  const elements = new Set();
  const attributes = new Set();
  for (const xpath of extractRuleXPaths(ruleXml)) {
    const names = extractXPathNames(xpath);
    names.elements.forEach((n) => elements.add(n));
    names.attributes.forEach((n) => attributes.add(n));
  }
  return { elements: [...elements].sort(), attributes: [...attributes].sort() };
}

// Same result shape as checkAgainstVocabulary ({available, notFound,
// wrongType}), so the UI renders it with the exact same red warning.
export function checkRuleNames(ruleXml, vocabulary) {
  const { elements, attributes } = extractRuleNames(ruleXml);
  return checkAgainstVocabulary({ elements, attributes, camelCase: [] }, vocabulary);
}
