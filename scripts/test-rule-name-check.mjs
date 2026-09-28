// Suggest Rule round (docs request) -- tests for the pure pieces of Suggest
// Rule's validation and gating, importing the REAL production modules under
// plain Node (this repo has no JS test runner -- same convention as
// test-vocabulary-check.mjs):
//   - src/validation/schemaValidation.js (was utils/ruleNameCheck.js): XPath name extraction from objectPath
//     (BREX 4.x), objpath (BREX 3.0.1) and @context/@test (Schematron),
//     checked against the REAL schema vocabularies, using the REAL rules of
//     the curated Excel templates of all five standards (four formats).
//   - src/utils/proposalMarkers.js: unfilled Suggest Proposal placeholder
//     detection (mirrors backend UNFILLED_MARKER_RE -- same fixtures as
//     backend/tests/test_similar.py).
//   - src/prompts/suggestRulePrompt.js: parseSuggestRuleResponse.
//   - src/validation/schemaValidation.js (was utils/ruleXPathSyntax.js): XPath syntax of every expression of a
//     rule (schema-location encargo, Part 3) -- the encargo's edge cases and
//     EVERY real rule of the five curated templates (a false "invalid" would
//     block Accept on a correct rule).
//
//     node scripts/test-rule-name-check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { extractRuleXPaths, extractXPathNames, extractRuleNames, checkRuleNames } from '../src/validation/schemaValidation.js';
import { hasUnfilledMarkers } from '../src/utils/proposalMarkers.js';
import { parseSuggestRuleResponse } from '../src/prompts/suggestRulePrompt.js';
import { invalidRuleXPaths, isXPathSyntaxValid } from '../src/validation/schemaValidation.js';
import { ruleFormatRules } from '../src/prompts/ruleFormatRules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('OK:', msg);
  }
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function loadVocab(file) {
  const json = JSON.parse(readFileSync(join(ROOT, 'public', file), 'utf-8'));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
}
function loadTemplate(file) {
  const wb = XLSX.read(readFileSync(join(ROOT, 'public', file)));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  return new Map(rows.filter((r) => r.Rule).map((r) => [r.ID, r.Rule]));
}

const TEMPLATES = {
  'S1000D 3.0.1': ['brdp-template-3-0-1.xlsx', 'schema-vocabulary-3-0-1.json'],
  'S1000D 4.1': ['brdp-template-4-1.xlsx', 'schema-vocabulary-4-1.json'],
  'S1000D 4.2': ['brdp-template-4-2.xlsx', 'schema-vocabulary-4-2.json'],
  'DITA 1.3 Xpath2.0': ['brdp-template-dita-xpath2.xlsx', 'schema-vocabulary-dita.json'],
  'DITA 1.3 Xpath3.0': ['brdp-template-dita-xpath3.xlsx', 'schema-vocabulary-dita.json'],
};
const rules = {};
const vocabs = {};
for (const [standard, [xlsx, vocab]] of Object.entries(TEMPLATES)) {
  rules[standard] = loadTemplate(xlsx);
  vocabs[standard] = loadVocab(vocab);
}

// ---- where the XPath lives, per format (real template rules) ----

{
  const r = rules['S1000D 3.0.1'].get('BRDP-EXT-02634');
  assert(same(extractRuleXPaths(r), ['/dmodule/content//thead/colspec']), 'BREX 3.0.1: the <objpath> text is the XPath');
  const n = extractRuleNames(r);
  assert(same(n.elements, ['dmodule', 'content', 'thead', 'colspec']) && n.attributes.length === 0, `3.0.1 objpath names (got ${JSON.stringify(n)})`);
}
{
  const r = rules['S1000D 3.0.1'].get('BRDP-EXT-02635');
  const n = extractRuleNames(r);
  assert(same(n.elements, ['dmodule', 'content', 'tgroup', 'tbody']), `3.0.1 predicate with not(tbody): "not" is a function, never a name (got ${JSON.stringify(n)})`);
}
{
  const r = rules['S1000D 4.2'].get('BRDP-S1-00338');
  const n = extractRuleNames(r);
  assert(n.elements.length === 0 && same(n.attributes, ['assyCode']), `4.2 //@assyCode[matches(., '^\\d{2}$')]: only @assyCode -- no "matches", nothing from the regex literal (got ${JSON.stringify(n)})`);
}
{
  const n = extractRuleNames(rules['S1000D 4.2'].get('BRDP-S1-00133'));
  assert(same(n.elements, ['parameter']) && n.attributes.length === 0, '4.2 //parameter -> <parameter>');
}
{
  const n = extractRuleNames(rules['S1000D 4.1'].get('BRDP-EXT-00037'));
  assert(n.attributes.includes('inWork') && n.attributes.includes('issueNumber') && n.elements.includes('dmStatus'), `4.1 structureObjectRule names (got ${JSON.stringify(n)})`);
}
{
  const r = rules['DITA 1.3 Xpath2.0'].get('BRDP-EXT-00001');
  const xpaths = extractRuleXPaths(r);
  assert(xpaths.length >= 2, `Schematron: both @context and @test are read (got ${xpaths.length} expressions)`);
  const n = extractRuleNames(r);
  assert(same(n.elements, ['entry', 'row', 'table', 'tbody', 'tgroup', 'thead', 'title']), `DITA XPath 2.0 table rule: element names only (got ${JSON.stringify(n)})`);
  assert(!n.elements.some((e) => /^(colDe|colPart|cab|normalize-space|every|satisfies)$/.test(e)), 'sch:let variables, functions and quantifier keywords are never names');
}
{
  const n = extractRuleNames(rules['DITA 1.3 Xpath3.0'].get('BRDP-EXT-00004'));
  assert(same(n.elements, ['map']), `DITA XPath 3.0 rule with inline function(...) and "!": only <map> (got ${JSON.stringify(n)})`);
}

// ---- every real Verified template rule vs. its REAL vocabulary ----

for (const [standard, byId] of Object.entries(rules)) {
  for (const [id, rule] of byId) {
    const check = checkRuleNames(rule, vocabs[standard]);
    const flagged = [...check.notFound, ...check.wrongType.map((w) => w.name)];
    if (standard === 'DITA 1.3 Xpath2.0' && (id === 'BRDP-EXT-00008' || id === 'BRDP-EXT-00009')) {
      // Genuine non-DITA names: XMetal's @conref-no-resuelto marker and
      // its <ditacomponent> wrapper -- the check SHOULD say so.
      assert(check.notFound.includes('@conref-no-resuelto'), `${standard} ${id}: XMetal's @conref-no-resuelto is correctly flagged (not DITA vocabulary)`);
      continue;
    }
    assert(flagged.length === 0, `${standard} ${id}: real Verified rule -> no name warnings (got ${JSON.stringify(flagged)})`);
  }
}

// ---- warnings on a generated/pasted rule ----

{
  const rule = `<structureObjectRule id="BRDP-X"><objectPath allowedObjectFlag="0">//pokemon[@shiny]</objectPath><objectUse>x</objectUse></structureObjectRule>`;
  const check = checkRuleNames(rule, vocabs['S1000D 4.2']);
  assert(check.available && check.notFound.includes('<pokemon>') && check.notFound.includes('@shiny'), `invented element/attribute -> red "not found" (got ${JSON.stringify(check.notFound)})`);
}
{
  const rule = `<structureObjectRule id="BRDP-X"><objectPath allowedObjectFlag="0">//label</objectPath><objectUse>x</objectUse></structureObjectRule>`;
  const check = checkRuleNames(rule, vocabs['S1000D 4.2']);
  assert(check.wrongType.length === 1 && check.wrongType[0].name === 'label' && check.wrongType[0].actualAs === 'attribute', '//label in 4.2 -> wrong kind (label is an attribute)');
}
{
  const check = checkRuleNames('<objrule><objpath>//pokemon</objpath></objrule>', null);
  assert(check.available === false && check.notFound.length === 0, 'no vocabulary -> not available, never a false warning');
}
{
  const rule = `<sch:pattern id="p-X"><sch:rule context="note"><sch:assert id="X" test="count(ancestor::step) &lt; 3 and not(@pokemontype)">m</sch:assert></sch:rule></sch:pattern>`;
  const n = extractRuleNames(rule);
  assert(same(n.elements, ['note', 'step']) && same(n.attributes, ['pokemontype']), `prefixed sch: rule, escaped &lt; decoded, axis skipped (got ${JSON.stringify(n)})`);
}

// ---- XPath tokenizer edge cases ----

const cases = [
  ["@type = 'para'", [], ['type'], 'string literal never a name'],
  ['$row/entry[@colname = $colX]', ['entry'], ['colname'], 'variables skipped, path after a variable checked'],
  ['xs:string(@id) or fn:head(//x:foo)', [], ['id'], 'namespace-prefixed names ignored'],
  ['text() | node() | element(para)', ['para'], [], 'kind tests are calls, their argument name is kept'],
  ['//*[@*]', [], [], 'wildcards ignored'],
  ['attribute::frame and self::table', ['table'], ['frame'], 'attribute:: axis -> attribute, self:: -> element'],
  ['for $i in //step return $i/@id', ['step'], ['id'], '"for ... in ... return" are keywords'],
  ['if (@a) then b else c', ['b', 'c'], ['a'], '"if/then/else" are keywords'],
  ['//map/topicref', ['map', 'topicref'], [], 'a keyword-looking name in a path step is still a name ("map")'],
  ['count(x) div 2 > 1.5', ['x'], [], '"div" operator and numbers ignored'],
];
for (const [xpath, elements, attributes, label] of cases) {
  const n = extractXPathNames(xpath);
  assert(same(n.elements, elements) && same(n.attributes, attributes), `${label}: ${xpath} (got ${JSON.stringify(n)})`);
}

// ---- unfilled Proposal placeholders (mirror of the backend fixtures) ----

// Suggest Rule adjustments round: the docs request's own table first --
// same fixtures as backend/tests/test_similar.py.
for (const p of [
  'Permitted CAGE codes shall be limited to [e C1008, C1234]',
  '[e C1008, C1234]',
  '[LIST: a, b]',
  '[SHALL/SHALL NOT]',
  '[tbd]',
  'Dates shall be written in [LIST: YYYY-MM-DD, DD-MM-YYYY] format.',
  'Warnings [SHALL/SHALL NOT] include a hazard symbol.',
  'Titles shall not exceed [VALUE: e.g. 60] characters.',
  'Use the [CONVENTION: company style] naming.',
  'Values [LIST : a, b].',
  'Dates follow [ISO 8601].',
  'Codes (see [tbd]) apply.',
  'Line one.\n[VALUE: x] on line two.',
]) {
  assert(hasUnfilledMarkers(p), `placeholder detected: ${JSON.stringify(p)}`);
}
for (const p of [
  '//para[@id]',
  'table[1]',
  '[1..n]',
  "@x[.='a']",
  'Proposal with //para[@id] only.',
  'Warnings shall include a hazard symbol.',
  'Use //para[1] only.',
  "Use para[@x] and x[.='y'] and (//p)[2].",
  "Items [@type='x'] are allowed.",
  'Between [1..n] steps.',
  'Nothing in brackets: [] or [ ].',
  '',
]) {
  assert(!hasUnfilledMarkers(p), `not a placeholder: ${JSON.stringify(p)}`);
}

// ---- model response parsing ----

{
  const r = parseSuggestRuleResponse('NOT_CHECKABLE: tool calibration intervals are a workshop process');
  assert(r.notCheckable === 'tool calibration intervals are a workshop process' && r.xml === undefined, 'NOT_CHECKABLE: reason extracted, no XML');
}
{
  const r = parseSuggestRuleResponse('```xml\n<?xml version="1.0"?>\n<objrule id="X"/>\n```');
  assert(r.xml === '<objrule id="X"/>', `markdown fence and XML declaration stripped (got ${JSON.stringify(r)})`);
}
{
  const r = parseSuggestRuleResponse('```\nNOT_CHECKABLE: outside the document\n```');
  assert(r.notCheckable === 'outside the document', 'NOT_CHECKABLE inside a fence still recognized');
}

// ---- XPath syntax (schema-location encargo, Part 3) ----
{
  const brex = (path) => `<structureObjectRule id="X"><objectPath allowedObjectFlag="0">${path}</objectPath><objectUse>u</objectUse></structureObjectRule>`;
  const sch = (test) => `<sch:pattern id="p-X"><sch:rule context="note"><sch:assert id="X" test="${test}">m</sch:assert></sch:rule></sch:pattern>`;
  // The encargo's table.
  assert(same(invalidRuleXPaths(brex('//&lt;emphasis&gt;')), ['//<emphasis>']), '//&lt;emphasis&gt; -> invalid (decoded //<emphasis> reported)');
  assert(invalidRuleXPaths(brex('//para[count(x) &lt; 3]')).length === 0, '//para[count(x) &lt; 3] -> valid');
  assert(invalidRuleXPaths(brex('//@emphasisType')).length === 0, '//@emphasisType -> valid');
  assert(invalidRuleXPaths(sch('@type')).length === 0, 'Schematron test="@type" -> valid');
  assert(same(invalidRuleXPaths(sch('count(.) &lt;')), ['count(.) <']), 'test="count(.) <" -> invalid');
  // Why the name check alone never caught it: "emphasis" IS a 4.2 element.
  const n = checkRuleNames(brex('//&lt;emphasis&gt;'), vocabs['S1000D 4.2']);
  assert(n.notFound.length === 0 && n.wrongType.length === 0, 'name check on //&lt;emphasis&gt; finds nothing wrong (emphasis is a real 4.2 element) -- the syntax check is what catches it');
  // 3.0.1 objpath and a Schematron @context.
  assert(invalidRuleXPaths('<objrule id="X"><objpath objappl="0">//&lt;randlist&gt;</objpath><objuse>u</objuse></objrule>').length === 1, '3.0.1 objpath //&lt;randlist&gt; -> invalid');
  assert(invalidRuleXPaths('<sch:pattern id="p"><sch:rule context="note["><sch:report id="X" test="true()">m</sch:report></sch:rule></sch:pattern>').length === 1, 'Schematron context="note[" -> invalid');
  // Things that are normal in rule fragments are never "invalid".
  for (const expr of [
    "every $r in tgroup/tbody/row satisfies ($r/entry[1] != '')",
    "@type = ('caution','warning')",
    "matches(@id, '^[a-z]+$', 'i')",
    '$valor(.) ! normalize-space(.)',
    'function($t as element()) as xs:string { string($t) }',
    '//@xlink:href',
    'doc-available(resolve-uri(@href, base-uri(.)))',
    'count(ancestor::list) lt 3',
  ]) {
    assert(isXPathSyntaxValid(expr), `valid XPath 2.0/3.0 / rule-fragment expression: ${expr}`);
  }
  assert(!isXPathSyntaxValid('//<emphasis/>'), 'XQuery element constructor is not XPath');
  // Every real rule of the five curated templates parses.
  for (const [standard, map] of Object.entries(rules)) {
    const bad = [...map.entries()].flatMap(([id, rule]) => invalidRuleXPaths(rule).map((x) => `${id}: ${x}`));
    assert(bad.length === 0, `${standard}: every template rule's XPath is valid (${map.size} rules)${bad.length ? ' -- ' + bad.join(' | ') : ''}`);
  }
  // Prompt rule 6: bare names, correct/wrong example with acmeElement.
  for (const fmt of ['BREX-4.2', 'BREX-4.1', 'BREX-3.0.1']) {
    const text = ruleFormatRules(fmt, '');
    assert(
      /6\. Inside obj(ectPath|path), write element and attribute names bare/.test(text) && text.includes('Correct: <obj') && text.includes('//acmeElement</obj') && text.includes('Wrong:   <obj') && text.includes('//&lt;acmeElement&gt;</obj'),
      `${fmt}: rule 6 says names go bare, with a correct and a wrong acmeElement example`
    );
    assert(!text.includes('a literal < or & must be escaped as &lt; / &amp;.'), `${fmt}: old rule 6 wording gone`);
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
