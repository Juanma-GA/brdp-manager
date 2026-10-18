// Barrido final 2/2, Part 3: `<element/@attribute>` in a BRDP's text -- the
// element and the attribute are checked on their own, and the element must
// have that attribute (owners from the real schema cards, the same data
// GET /api/schema-cards/attribute serves).
// Run: node scripts/test-element-attribute-notation.mjs
import fs from 'node:fs';
import i18n from '../src/i18n/index.js';
import {
  attributesToCheckOnElements,
  checkAgainstVocabulary,
  checkElementAttributePairs,
  extractContextCandidates,
  formatSchemaIssue,
  nameIssues,
} from '../src/validation/schemaValidation.js';

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) passes++;
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `\n   ${detail}` : ''}`);
  }
}
const raw = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-4-2.json', import.meta.url)));
const vocabulary = { elements: new Set(raw.elements), attributes: new Set(raw.attributes) };
const cards = JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-4-2.json', import.meta.url))).cards;
// attribute -> Set of the elements that declare it, in any variant.
const owners = new Map();
for (const [element, variants] of Object.entries(cards)) {
  for (const v of variants) for (const a of v.attributes || []) (owners.get(a.name) || owners.set(a.name, new Set()).get(a.name)).add(element);
}
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

// The whole check, as useVocabularyCheck runs it.
function run(text, ownersMap = owners) {
  const c = extractContextCandidates(text);
  const checked = checkAgainstVocabulary(c, vocabulary);
  const pairCheck = checkElementAttributePairs(c.elementAttributePairs, vocabulary, ownersMap);
  const result = { ...checked, notOnElement: pairCheck.notOnElement, pairsUnchecked: pairCheck.unchecked };
  return { c, result, lines: nameIssues(result, 'brdp', { standard: 'S1000D 4.2' }).map((i) => formatSchemaIssue(i, en)) };
}

{
  const { c, lines } = run('Write <para/@id> on every paragraph.');
  check('<para/@id>: one pair', JSON.stringify(c.elementAttributePairs) === '[{"element":"para","attribute":"id"}]', JSON.stringify(c));
  check('<para/@id>: para is an element, id an attribute, never "<id>"', c.elements.join() === 'para' && c.attributes.join() === 'id' && c.danglingElements.length === 0);
  check('<para/@id> passes (no warning)', lines.length === 0, lines.join(' | '));
}
{
  const { lines } = run('Use <para/@noexiste>.');
  check('<para/@noexiste> warns the attribute', lines.length === 1 && /@noexiste/.test(lines[0]) && !/<noexiste>/.test(lines[0]), lines.join(' | '));
}
{
  const { lines } = run('Use <noexiste/@id>.');
  check('<noexiste/@id> warns the element', lines.length === 1 && /<noexiste>/.test(lines[0]) && !/@id/.test(lines[0]), lines.join(' | '));
}
{
  const { result, lines } = run('Use <para/@infoCode>.');
  check('<para/@infoCode>: both exist, para has no @infoCode', result.notOnElement.length === 1 && result.notFound.length === 0, JSON.stringify(result));
  check('… message EN', lines.join() === '<para> has no attribute @infoCode in the S1000D 4.2 schema.', lines.join(' | '));
  const issue = nameIssues(result, 'brdp', { standard: 'S1000D 4.2' })[0];
  check('… message ES', formatSchemaIssue(issue, es) === '<para> no tiene el atributo @infoCode en el esquema de S1000D 4.2.', formatSchemaIssue(issue, es));
  check('… infoCode is not also a camelCase finding', !result.notFound.includes('infoCode'));
}
{
  const { lines } = run('Set <dmCode/@infoCode> to 040 and < para / @id >.');
  check('<dmCode/@infoCode> passes, spaces around "/" allowed', lines.length === 0, lines.join(' | '));
}
{
  const { result, lines } = run('Use <para/@id>.', new Map([['id', null]]));
  check('owners not readable → unchecked, said so', result.pairsUnchecked.length === 1 && /Could not check/.test(lines.join()), lines.join(' | '));
}
check('only existing pairs are looked up', attributesToCheckOnElements([{ element: 'para', attribute: 'id' }, { element: 'noexiste', attribute: 'id' }, { element: 'para', attribute: 'nope' }], vocabulary).join() === 'id');
check('a URL or a plain "a/b" is not a pair', extractContextCandidates('see http://x/@y and a/@b').elementAttributePairs.length === 0);
check('a prefixed name keeps being skipped', extractContextCandidates('<xsl:template/@match>').elementAttributePairs.length === 0);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
