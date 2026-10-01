// "Sugerencias para erratas y nombres de otro estándar": near names and
// names of another standard for marked names that do not exist, and the
// list cut after a marked name in extractPhraseCandidates. Plain Node, the
// real module, the real vocabularies of public/ and the real i18n.
// Run: node scripts/test-name-fix-hints.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import i18n from '../src/i18n/index.js';
import {
  VOCABULARY_FILE_LABELS,
  checkAgainstVocabulary,
  checkRuleNames,
  extractContextCandidates,
  formatSchemaIssue,
  formatStandardList,
  nameFixHints,
  nameFixSuggestions,
  nameIssues,
  renameMarkedName,
  resolvePhraseCandidates,
  similarSchemaNames,
  standardsWithName,
  textNeedsOtherVocabularies,
} from '../src/validation/schemaValidation.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const keyOf = (file) => file.replace(/^schema-vocabulary-|\.json$/g, '');
const load = (file) => {
  const j = JSON.parse(fs.readFileSync(`${PUBLIC}${file}`, 'utf8'));
  return { elements: new Set(j.elements), attributes: new Set(j.attributes) };
};
const V = Object.fromEntries(VOCABULARY_FILE_LABELS.map(([file]) => [keyOf(file), load(file)]));
const others = (own) => VOCABULARY_FILE_LABELS.filter(([f]) => keyOf(f) !== own).map(([f, label]) => ({ label, vocabulary: V[keyOf(f)] }));
const hintsFor = (file, text) => {
  const checked = checkAgainstVocabulary(extractContextCandidates(text), V[file]);
  return nameFixHints(checked.typedNotFound, V[file], others(file)).hints;
};

// ── Similar names: thresholds, capitals, ties ────────────────────────────
check('<emphasys> -> emphasis', eq(hintsFor('4-2', 'Do not use <emphasys>.'), [
  { name: 'emphasys', type: 'element', similar: ['emphasis'], otherStandards: [] },
]));
check('@emphasistype -> @emphasisType (capitals only)', eq(hintsFor('4-2', 'Use @emphasistype.'), [
  { name: 'emphasistype', type: 'attribute', similar: ['emphasisType'], otherStandards: [] },
]));
check('<levelledpara> -> levelledPara', eq(hintsFor('4-2', '<levelledpara>'), [
  { name: 'levelledpara', type: 'element', similar: ['levelledPara'], otherStandards: [] },
]));
check('capitals-only match hides near names', eq(similarSchemaNames('dmref', 'element', V['4-2']).caseOnly, ['dmRef'])
  && hintsFor('4-2', '<dmref>')[0].similar.length === 1);
check('<pokemon> -> nothing', eq(hintsFor('4-2', '<pokemon>'), []));
check('<ab> -> nothing in 4.2, 4.1, 3.0.1, DITA', ['4-2', '4-1', '3-0-1', 'dita'].every((f) => hintsFor(f, '<ab>').length === 0));
check('transposition counts as one edit (tabel -> table)', eq(similarSchemaNames('tabel', 'element', V['4-2']).near, ['table']));
check('5-letter name: distance 2 not suggested', similarSchemaNames('tblxx', 'element', V['4-2']).near.length === 0);
check('6+ letters: distance 2 suggested', similarSchemaNames('emphasx', 'element', V['4-2']).near.includes('emphasis'));
check('same kind only: element name not taken from attributes',
  !similarSchemaNames('emphasistyp', 'element', V['4-2']).near.includes('emphasisType'));
const synthetic = { elements: new Set(['abcd1', 'abcd2', 'abcd3', 'abcd4', 'abcdxy']), attributes: new Set() };
check('more than 3 tied at the nearest distance -> none', eq(similarSchemaNames('abcd', 'element', synthetic).near, []));
const synthetic3 = { elements: new Set(['abcd1', 'abcd2', 'abcd3', 'abcdxyz']), attributes: new Set() };
check('3 tied -> all 3, sorted', eq(similarSchemaNames('abcd', 'element', synthetic3).near, ['abcd1', 'abcd2', 'abcd3']));
const syntheticOrder = { elements: new Set(['abcdefgh', 'abcdefxy', 'abcdefgz']), attributes: new Set() };
check('nearest first', eq(similarSchemaNames('abcdefg', 'element', syntheticOrder).near, ['abcdefgh', 'abcdefgz', 'abcdefxy']));
check('no vocabulary -> nothing', eq(similarSchemaNames('table', 'element', null), { caseOnly: [], near: [] }));

// ── Only marked names ───────────────────────────────────────────────────
check('loose "the element emphasys" -> no typedNotFound',
  checkAgainstVocabulary(extractContextCandidates('the element emphasys'), V['4-2']).typedNotFound.length === 0);
check('loose word -> no chip', nameFixSuggestions('the element emphasys and emphasys', V['4-2'], others('4-2')).length === 0);
check('camelCase loose word never gets a hint',
  checkAgainstVocabulary(extractContextCandidates('use levelledParx here'), V['4-2']).typedNotFound.length === 0);
check('<emphasisType> (exists as attribute) -> wrong type, no hint', (() => {
  const c = checkAgainstVocabulary(extractContextCandidates('<emphasisType>'), V['4-2']);
  return c.typedNotFound.length === 0 && c.wrongType.length === 1;
})());
check('half-typed <emphasys -> hint', eq(hintsFor('4-2', 'Title above the <emphasys').map((h) => h.similar), [['emphasis']]));

// ── Other standards ─────────────────────────────────────────────────────
check('<levelledPara> in 3.0.1 -> S1000D 4.1 and 4.2', eq(hintsFor('3-0-1', '<levelledPara>'), [
  { name: 'levelledPara', type: 'element', similar: [], otherStandards: ['S1000D 4.1', 'S1000D 4.2'] },
]));
check('<para> in DITA -> S1000D (not a typo of param/part)', eq(hintsFor('dita', '<para>'), [
  { name: 'para', type: 'element', similar: [], otherStandards: ['S1000D 3.0.1', 'S1000D 4.1', 'S1000D 4.2'] },
]));
check('standardsWithName is exact and same kind',
  eq(standardsWithName('levelledPara', 'element', others('3-0-1')), ['S1000D 4.1', 'S1000D 4.2'])
  && standardsWithName('levelledpara', 'element', others('3-0-1')).length === 0
  && standardsWithName('levelledPara', 'attribute', others('3-0-1')).length === 0);
check('other vocabularies not loaded -> only capitals, flagged as needed', (() => {
  const c = checkAgainstVocabulary(extractContextCandidates('<levelledPara> and @emphasistype'), V['3-0-1']);
  const r = nameFixHints(c.typedNotFound, V['3-0-1'], null);
  return r.needsOtherVocabularies && r.hints.length === 0;
})());
check('capitals-only answered without the other vocabularies', (() => {
  const c = checkAgainstVocabulary(extractContextCandidates('@emphasistype'), V['4-2']);
  const r = nameFixHints(c.typedNotFound, V['4-2'], null);
  return !r.needsOtherVocabularies && r.hints.length === 1;
})());
check('textNeedsOtherVocabularies: only for a name with no capitals match',
  textNeedsOtherVocabularies('<emphasys>', V['4-2'])
  && !textNeedsOtherVocabularies('@emphasistype and <table>', V['4-2'])
  && !textNeedsOtherVocabularies('the element emphasys', V['4-2'])
  && !textNeedsOtherVocabularies('', V['4-2']));
check('other-standard name never gets a chip', nameFixSuggestions('<levelledPara>', V['3-0-1'], others('3-0-1')).length === 0);

// ── Rules: names of the XPath ───────────────────────────────────────────
const rule = '<structureObjectRule id="r1"><objectPath allowedObjectFlag="0">//para/emphasys[@emphasistype]</objectPath><objectUse>x</objectUse></structureObjectRule>';
const ruleCheck = checkRuleNames(rule, V['4-2']);
check('rule names give typedNotFound', eq(ruleCheck.typedNotFound, [
  { name: 'emphasys', type: 'element' },
  { name: 'emphasistype', type: 'attribute' },
]));
check('rule hints', eq(nameFixHints(ruleCheck.typedNotFound, V['4-2'], others('4-2')).hints.map((h) => h.similar), [['emphasis'], ['emphasisType']]));

// ── Fix in one click ────────────────────────────────────────────────────
check('chips for a field', eq(nameFixSuggestions('Do not use <emphasys> or @emphasistype.', V['4-2'], others('4-2')), [
  { from: 'emphasys', name: 'emphasis', type: 'element' },
  { from: 'emphasistype', name: 'emphasisType', type: 'attribute' },
]));
check('renameMarkedName: every marked form, loose words untouched',
  renameMarkedName('Use <emphasys> and </emphasys>, <emphasys attr="x">, emphasys stays, emphasys>', 'emphasys', 'emphasis', 'element')
    === 'Use <emphasis> and </emphasis>, <emphasis attr="x">, emphasys stays, emphasis>');
check('renameMarkedName: half-typed <emphasys', renameMarkedName('Title above the <emphasys', 'emphasys', 'emphasis', 'element') === 'Title above the <emphasis');
check('renameMarkedName: attribute, prefix of another name untouched',
  renameMarkedName('@emphasistype and @emphasistypeX emphasistype', 'emphasistype', 'emphasisType', 'attribute')
    === '@emphasisType and @emphasistypeX emphasistype');
check('after the fix the name exists',
  checkAgainstVocabulary(extractContextCandidates(renameMarkedName('Do not use <emphasys>.', 'emphasys', 'emphasis', 'element')), V['4-2']).notFound.length === 0);

// ── Messages EN / ES ────────────────────────────────────────────────────
check('formatStandardList', formatStandardList(['S1000D 4.1', 'S1000D 4.2'], 'y') === 'S1000D 4.1 y 4.2'
  && formatStandardList(['S1000D 3.0.1', 'S1000D 4.1', 'S1000D 4.2'], 'and') === 'S1000D 3.0.1, 4.1 and 4.2'
  && formatStandardList(['S1000D 4.2', 'DITA 1.3'], 'y') === 'S1000D 4.2 y DITA 1.3'
  && formatStandardList(['DITA 1.3'], 'y') === 'DITA 1.3');
const messages = (file, standard, text, source, lang) => {
  const checked = checkAgainstVocabulary(extractContextCandidates(text), V[file]);
  const hints = nameFixHints(checked.typedNotFound, V[file], others(file)).hints;
  const t = i18n.getFixedT(lang);
  return nameIssues(checked, source, { standard, hints }).map((i) => formatSchemaIssue(i, t));
};
const en301 = messages('3-0-1', 'S1000D 3.0.1', '<levelledPara>', 'brdp', 'en');
check('EN: red line stays, then the other-standard line', en301.length === 2
  && en301[0].includes('<levelledPara>')
  && en301[1] === '<levelledPara> does not exist in S1000D 3.0.1; it exists in S1000D 4.1 and 4.2.', JSON.stringify(en301));
const es301 = messages('3-0-1', 'S1000D 3.0.1', '<levelledPara>', 'brdp', 'es');
check('ES other standard', es301[1] === '<levelledPara> no existe en S1000D 3.0.1; existe en S1000D 4.1 y 4.2.', JSON.stringify(es301));
const esDita = messages('dita', 'DITA 1.3 Xpath2.0', '<para>', 'brdp', 'es');
check('ES DITA', esDita[1] === '<para> no existe en DITA 1.3; existe en S1000D 3.0.1, 4.1 y 4.2.', JSON.stringify(esDita));
const enTypo = messages('4-2', 'S1000D 4.2', '<emphasys> and @emphasistype', 'brdp', 'en');
check('EN did you mean', enTypo.includes('<emphasys> does not exist; did you mean <emphasis>?')
  && enTypo.includes('@emphasistype does not exist; did you mean @emphasisType?'), JSON.stringify(enTypo));
const esTypo = messages('4-2', 'S1000D 4.2', '<emphasys>', 'brdp', 'es');
check('ES did you mean', esTypo[1] === '<emphasys> no existe; ¿quisiste decir <emphasis>?', JSON.stringify(esTypo));
const several = formatSchemaIssue(
  { source: 'rule', code: 'name_did_you_mean', params: { name: '<abcd>', suggestions: ['<abcd1>', '<abcd2>', '<abcd3>'] } },
  i18n.getFixedT('es'),
);
check('several suggestions joined with "o"', several === '<abcd> no existe; ¿quisiste decir <abcd1>, <abcd2> o <abcd3>?', several);
check('rule source uses the same lines', messages('4-2', 'S1000D 4.2', '<emphasys>', 'rule', 'en')[1] === '<emphasys> does not exist; did you mean <emphasis>?');
check('no hints -> unchanged issues', eq(nameIssues({ available: true, notFound: ['<x>'], wrongType: [] }, 'brdp', { standard: 'S1000D 4.2' }).length, 1));

// ── Part 3: list cut after a marked name ────────────────────────────────
const s65 = extractContextCandidates('Use of the element <copyright> and source of copyright information');
check('S1-00065 title: no phrase candidate (no <source>)', eq(s65.phraseCandidates, []), JSON.stringify(s65.phraseCandidates));
check('S1-00065 title: no chip', resolvePhraseCandidates(s65.phraseCandidates, V['4-2']).length === 0
  && nameFixSuggestions('Use of the element <copyright> and source of copyright information', V['4-2'], others('4-2')).length === 0);
check('marked @attribute ends the list', eq(extractContextCandidates('the attribute @id or title must be set').phraseCandidates, []));
check('unmarked list still works: cl, pl and ip', eq(
  extractContextCandidates('the elements cl, pl and ip').phraseCandidates.map((c) => c.name),
  ['cl', 'pl', 'ip'],
));
check('unmarked list after "atributo de tipo" still works', eq(
  extractContextCandidates('lA ETIQUETA <table> no lleva atributo de tipo cl, pl y de tipo ip si es de valor 23').phraseCandidates.map((c) => c.name),
  ['cl', 'pl', 'ip'],
));
check('unmarked first item, then marked second still captures the first', eq(
  extractContextCandidates('the elements table and <title>').phraseCandidates.map((c) => c.name),
  ['table'],
));

// ── Names with a namespace prefix are never checked ──────────────────────
{
  const v301 = V['3-0-1'];
  const ext02772 = 'The @xsi:noNamespaceSchemaLocation of each DM shall be one of the S1000D 3.0.1 schemas. Check @xsi:noNamespaceSchemaLocation on <dmodule>.';
  const c = extractContextCandidates(ext02772);
  check('prefix: @xsi:noNamespaceSchemaLocation not extracted', !c.attributes.includes('xsi') && !c.camelCase.includes('noNamespaceSchemaLocation'), JSON.stringify(c));
  const r = checkAgainstVocabulary(c, v301);
  check('prefix: BRDP-EXT-02772 text has no warning', r.notFound.length === 0 && r.wrongType.length === 0, JSON.stringify(r));
  const others42 = checkAgainstVocabulary(extractContextCandidates('Use @xlink:href, <xsl:template match="x"> and </xsl:template>; also <sch:rule and xsl:value-of>.'), V['4-2']);
  check('prefix: @xlink:href, <xsl:template>, half-typed prefixed names: no warning', others42.notFound.length === 0, JSON.stringify(others42));
  check('prefix: no chips for prefixed names', hintsFor('4-2', 'Use @xlink:href and <xsl:template>.').length === 0);
  const bare = checkAgainstVocabulary(extractContextCandidates('Only @xsi is set.'), v301);
  check('no prefix: @xsi alone still warns', eq(bare.notFound, ['@xsi']), JSON.stringify(bare));
  const local = checkAgainstVocabulary(extractContextCandidates('The noNamespaceSchemaLocation attribute is set.'), v301);
  check('no prefix: noNamespaceSchemaLocation alone still warns', local.notFound.some((n) => n.includes('noNamespaceSchemaLocation')), JSON.stringify(local));
  const mixed = 'The @xsi:noNamespaceSchemaLocation is checked; <emphasys> is not allowed.';
  const mixedCheck = checkAgainstVocabulary(extractContextCandidates(mixed), V['4-2']);
  check('prefix + typo: only <emphasys> warns', eq(mixedCheck.notFound, ['<emphasys>']), JSON.stringify(mixedCheck));
  const mixedHints = hintsFor('4-2', mixed);
  check('prefix + typo: Did you mean <emphasis>', mixedHints.length === 1 && JSON.stringify(mixedHints).includes('emphasis'), JSON.stringify(mixedHints));
  check('prefix: URLs are not prefixed names', eq(extractContextCandidates('See http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd and <para>').elements, ['para']));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
