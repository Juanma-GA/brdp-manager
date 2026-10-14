// Test de reglas DITA, funciones XPath que faltan (Part 1). Run with:
//   node scripts/test-xpath-functions.mjs
//
// 1. Inventory: every function of XPath and XQuery Functions and Operators
//    3.1 (F&O 3.1), with every arity, called the way the rule test calls
//    it (prepareXPath + fontoxpath, after the engines' registrations). The
//    ones that still give XPST0017 must be exactly NOT_PROVIDED of
//    src/utils/xpathExtraFunctions.js -- so a function fontoxpath lacks
//    never slips through unnoticed, and NOT_PROVIDED never lists one that
//    now runs.
// 2. The edge cases of the request, with the results Saxon-HE 9.9.1 gives
//    for the same expressions (run by hand with net.sf.saxon.Query; Saxon is
//    not part of the repo).
import fontoxpath from 'fontoxpath';
import { DOMParser } from '@xmldom/xmldom';
import { NOT_PROVIDED, prepareXPath, setExtraParser } from '../src/utils/xpathExtraFunctions.js';
import '../src/utils/ruleTestSchematron.js'; // dossier functions, analyze-string
import { XPATH_LANGUAGE } from '../src/utils/ruleTestCommon.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const parseXml = (t) => new DOMParser().parseFromString(t, 'text/xml');
setExtraParser(parseXml);
const options = { language: XPATH_LANGUAGE };
const evaluate = (expression, node = null) =>
  fontoxpath.evaluateXPath(prepareXPath(expression), node, null, null, fontoxpath.evaluateXPath.ANY_TYPE, options);
const errorOf = (expression, node = null) => {
  try {
    evaluate(expression, node);
    return null;
  } catch (err) {
    return String(err.message);
  }
};

// ─── 1. Inventory of F&O 3.1 ────────────────────────────────────────────────
// https://www.w3.org/TR/xpath-functions-31/ -- the fn: namespace, every
// signature (name: arities).
const FO31 = {
  'node-name': [0, 1], nilled: [0, 1], string: [0, 1], data: [0, 1], 'base-uri': [0, 1], 'document-uri': [0, 1],
  error: [0, 1, 2, 3], trace: [1, 2],
  abs: [1], ceiling: [1], floor: [1], round: [1, 2], 'round-half-to-even': [1, 2], number: [0, 1],
  'format-integer': [2, 3], 'format-number': [2, 3],
  'codepoints-to-string': [1], 'string-to-codepoints': [1], compare: [2, 3], 'codepoint-equal': [2],
  concat: [2, 3], 'string-join': [1, 2], substring: [2, 3], 'string-length': [0, 1], 'normalize-space': [0, 1],
  'normalize-unicode': [1, 2], 'upper-case': [1], 'lower-case': [1], translate: [3],
  contains: [2, 3], 'starts-with': [2, 3], 'ends-with': [2, 3], 'substring-before': [2, 3], 'substring-after': [2, 3],
  matches: [2, 3], replace: [3, 4], tokenize: [1, 2, 3], 'analyze-string': [2, 3], 'contains-token': [2, 3],
  'resolve-uri': [1, 2], 'encode-for-uri': [1], 'iri-to-uri': [1], 'escape-html-uri': [1],
  true: [0], false: [0], boolean: [1], not: [1],
  'years-from-duration': [1], 'months-from-duration': [1], 'days-from-duration': [1], 'hours-from-duration': [1], 'minutes-from-duration': [1], 'seconds-from-duration': [1],
  dateTime: [2], 'year-from-dateTime': [1], 'month-from-dateTime': [1], 'day-from-dateTime': [1], 'hours-from-dateTime': [1], 'minutes-from-dateTime': [1], 'seconds-from-dateTime': [1], 'timezone-from-dateTime': [1],
  'year-from-date': [1], 'month-from-date': [1], 'day-from-date': [1], 'timezone-from-date': [1],
  'hours-from-time': [1], 'minutes-from-time': [1], 'seconds-from-time': [1], 'timezone-from-time': [1],
  'adjust-dateTime-to-timezone': [1, 2], 'adjust-date-to-timezone': [1, 2], 'adjust-time-to-timezone': [1, 2],
  'format-dateTime': [2, 5], 'format-date': [2, 5], 'format-time': [2, 5], 'parse-ietf-date': [1],
  'resolve-QName': [2], QName: [2], 'prefix-from-QName': [1], 'local-name-from-QName': [1], 'namespace-uri-from-QName': [1], 'namespace-uri-for-prefix': [2], 'in-scope-prefixes': [1],
  name: [0, 1], 'local-name': [0, 1], 'namespace-uri': [0, 1], lang: [1, 2], root: [0, 1], path: [0, 1], 'has-children': [0, 1], innermost: [1], outermost: [1],
  'index-of': [2, 3], empty: [1], exists: [1], 'distinct-values': [1, 2], 'insert-before': [3], remove: [2], head: [1], tail: [1], reverse: [1], subsequence: [2, 3], unordered: [1],
  'zero-or-one': [1], 'one-or-more': [1], 'exactly-one': [1], 'deep-equal': [2, 3], count: [1], avg: [1], max: [1, 2], min: [1, 2], sum: [1, 2],
  id: [1, 2], 'element-with-id': [1, 2], idref: [1, 2], 'generate-id': [0, 1], doc: [1], 'doc-available': [1], collection: [0, 1], 'uri-collection': [0, 1],
  'unparsed-text': [1, 2], 'unparsed-text-lines': [1, 2], 'unparsed-text-available': [1, 2], 'environment-variable': [1], 'available-environment-variables': [0],
  'parse-xml': [1], 'parse-xml-fragment': [1], serialize: [1, 2],
  position: [0], last: [0], 'current-dateTime': [0], 'current-date': [0], 'current-time': [0], 'implicit-timezone': [0], 'default-collation': [0], 'default-language': [0], 'static-base-uri': [0],
  'function-lookup': [2], 'function-name': [1], 'function-arity': [1],
  'for-each': [2], filter: [2], 'fold-left': [3], 'fold-right': [3], 'for-each-pair': [3], sort: [1, 2, 3], apply: [2],
  'load-xquery-module': [1, 2], transform: [1], 'random-number-generator': [0, 1],
  'parse-json': [1, 2], 'json-doc': [1, 2], 'json-to-xml': [1, 2], 'xml-to-json': [1, 2],
  'collation-key': [1, 2],
};
const doc = parseXml('<r a="z"><x a="b"/><x a="m"/></r>');
const missing = [];
for (const [name, arities] of Object.entries(FO31)) {
  for (const arity of arities) {
    const message = errorOf(`fn:${name}(${Array(arity).fill('()').join(', ')})`, doc);
    if (message && /XPST0017/.test(message)) missing.push(`${name}#${arity}`);
  }
}
const expected = Object.keys(NOT_PROVIDED).sort();
const unexpected = missing.filter((m) => !NOT_PROVIDED[m]);
const nowRunning = expected.filter((m) => !missing.includes(m));
check('every F&O 3.1 function that gives XPST0017 is listed in NOT_PROVIDED', unexpected.length === 0, unexpected.join(', '));
check('NOT_PROVIDED lists no function that runs', nowRunning.length === 0, nowRunning.join(', '));
check('NOT_PROVIDED: every entry has a reason', Object.values(NOT_PROVIDED).every((r) => typeof r === 'string' && r.length > 5));
for (const name of ['sort#1', 'sort#2', 'sort#3', 'matches#3', 'replace#4', 'tokenize#3', 'uri-collection#0', 'uri-collection#1']) {
  check(`${name} is provided`, !missing.includes(name));
}
check('collection() is still not provided', missing.includes('collection#1'));
check('unparsed-text() is still not provided', missing.includes('unparsed-text#1'));

// ─── 2. Edge cases (Saxon-HE 9.9.1 results) ─────────────────────────────────
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [
  ["sort(('b','a','c'))", ['a', 'b', 'c']],
  ['sort((3, 1, 2))', [1, 2, 3]],
  ["sort(('B','a','C'), 'http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive')", ['a', 'B', 'C']],
  ["sort(('b','a','c'), (), function($s) { -string-length($s) })", ['b', 'a', 'c']],
  ['sort(//@a) ! string()', ['b', 'm', 'z']],
  ['sort(//x, (), function($e) { string($e/@a) }) ! string(@a)', ['b', 'm']],
  ["sort(sort(('b','a')))", ['a', 'b']],
  ['sort(())', []],
  ["matches('ABC', 'abc', 'i')", true],
  ["matches('ABC', 'abc')", false],
  ["matches('a.b', '.', 'q')", true],
  ["matches('xyz', '.', 'q')", false],
  ["matches('abc', 'a b c', 'x')", true],
  ["matches('abc', 'a b c')", false],
  ["matches('a&#10;b', '^b$', 'm')", true],
  ["matches('a&#10;b', 'a.b', 's')", true],
  ["matches('a&#10;b', 'a.b')", false],
  ["matches('Nota: algo', '^(nota|aviso)\\s*:', 'i')", true],
  ["matches('file:///csdb/dossier/', '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')", true],
  // [^:]+ also takes slashes: with three slashes, one level is enough;
  // with Java's single slash (file:/x/) it is not.
  ["matches('file:///csdb/', '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')", true],
  ["matches('file:/csdb/', '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')", false],
  ["matches('file:/csdb/dossier/', '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')", true],
  ["matches('MAPA.DITAMAP', '\\.ditamap$', 'i')", true],
  ["replace('ABC', 'b', 'X', 'i')", 'AXC'],
  ["replace('a.b', '.', 'X', 'q')", 'aXb'],
  ["replace('abc', '(a)(b)', '$2$1', 'i')", 'bac'],
  ["replace('abc', 'b', '\\$', '')", 'a$c'],
  ["replace('abc', 'b', 'X', '')", 'aXc'],
  ["tokenize('aXbxc', 'x', 'i')", ['a', 'b', 'c']],
  ["tokenize('a b', '\\s', '')", ['a', 'b']],
  ["tokenize('', 'x', 'i')", []],
  ["substring-before('ABC', 'b', 'http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive')", 'A'],
  ["contains-token(('a b', 'c'), 'b')", true],
  ["string-length(normalize-unicode('é', 'NFD'))", 2],
  ['for-each-pair((1, 2), (3, 4), function($a, $b) { $a + $b })', [4, 6]],
  ["apply(concat#3, ['a', 'b', 'c'])", 'abc'],
  ["parse-xml('<a/>')/a ! name()", 'a'],
];
for (const [expression, want] of cases) {
  let got;
  try {
    got = evaluate(expression.replace(/&#10;/g, "' || codepoints-to-string(10) || '"), doc);
  } catch (err) {
    got = `ERROR ${err.message.split('\n')[0]}`;
  }
  check(`${expression} → ${JSON.stringify(want)}`, same(got, want), JSON.stringify(got));
}
// Errors the rule makes (Saxon gives the same codes).
for (const [expression, code] of [
  ["matches('x', 'x', 'z')", 'FORX0001'],
  ["replace('abc', 'x*', 'Y', 'i')", 'FORX0003'],
  ["sort(('b','a'), 'http://example.com/collation')", 'FOCH0002'],
  ["sort((10, 'a'))", 'XPTY0004'],
]) {
  check(`${expression} → ${code}`, new RegExp(code).test(errorOf(expression, doc) || ''), errorOf(expression, doc));
}

// prepareXPath: only the calls it handles change; literals and everything
// else stay byte for byte.
check('prepareXPath: nothing to change', prepareXPath("//para[matches(., 'x', 'i')]") === "//para[matches(., 'x', 'i')]");
check('prepareXPath: a call name inside a literal is not touched', prepareXPath("concat('sort(', 'replace(a,b,c,d)')") === "concat('sort(', 'replace(a,b,c,d)')");
check('prepareXPath: array:sort and Q{…}sort are not touched', prepareXPath('array:sort([2, 1])') === 'array:sort([2, 1])');
check('prepareXPath: replace#3 and tokenize#2 left to fontoxpath', prepareXPath("replace(., 'a', 'b')") === "replace(., 'a', 'b')" && prepareXPath("tokenize(., ',')") === "tokenize(., ',')");
check("prepareXPath: replace#4 rewritten", /Q\{urn:x-brdp-manager:xpath\}replace\(/.test(prepareXPath("replace(., 'a', 'b', 'i')")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
