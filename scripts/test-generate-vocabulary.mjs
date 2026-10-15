// Generate (Schematron DITA): the vocabulary warnings come from the app's
// own name checker (checkXPathNames / checkRuleNames in
// src/validation/schemaValidation.js) against public/schema-vocabulary-dita.json,
// on each sch:pattern of the final document and on each schema-level
// sch:let. Before, a lint built on hand-written lists of XPath functions and
// keywords reported every function or operator it did not list (623 false
// warnings for 22 names on a real 35-rule Navantia Schematron).
//
// Fixtures: scripts/rule-test-fixtures/navantia-dita3-generated-*.sch.
// The one in the repository is RECONSTRUCTED (see its header comment); the
// real document of 2026-10-15 is not here -- saved next to it with the same
// name pattern, this test checks it too.
import fs from 'node:fs';
import i18n from '../src/i18n/index.js';
import { generateSchematronDITA, checkWellFormedSchematron } from '../src/api/generateSchematronDITA.js';
import { formatSchemaIssue } from '../src/validation/schemaValidation.js';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { extractRules } from './lib/extractRules.mjs';
import { readTextFile } from './lib/textFile.mjs';

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const ROOT = new URL('../', import.meta.url);
const FIXTURES = new URL('scripts/rule-test-fixtures/', ROOT);
const summary = JSON.parse(readTextFile(new URL('public/schematron-dita-schema-summary.json', ROOT)));
const vocabJson = JSON.parse(readTextFile(new URL('public/schema-vocabulary-dita.json', ROOT)));
const vocabulary = { elements: new Set(vocabJson.elements), attributes: new Set(vocabJson.attributes) };
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

// The 22 names of the real report, each in the role it has in XPath.
const FALSE_NAMES = [
  'replace', 'lower-case', 'upper-case', 'translate', 'sort', 'uri-collection', 'subsequence',
  'iri-to-uri', 'position', 'max', 'node', 'to', 'le', 'lt', 'gt', 'is', 'intersect', 'except',
  'instance', 'of', 'role', 'othermeta',
];

function names(warnings) {
  const out = [];
  for (const { issue } of warnings) {
    if (issue.code === 'names_not_found') out.push(...issue.params.names.split(', '));
    else out.push(`${issue.code}:${issue.params.name || issue.params.names}`);
  }
  return out;
}
function lint(xml, binding = 'xslt3', standard = 'DITA 1.3 Xpath3.0') {
  return checkWellFormedSchematron(xml, binding, { vocabulary, standard }).vocabularyWarnings;
}
function doc(patterns, binding = 'xslt3') {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="${binding}">\n` +
    `<sch:title>T</sch:title>\n<sch:ns prefix="xs" uri="http://www.w3.org/2001/XMLSchema"/>\n${patterns}\n</sch:schema>\n`
  );
}
async function generate(rules, standard, extra = {}) {
  const brdps = rules.map((r, i) => ({ id: `id${i}`, identifier: r.identifier, validation: 'Validated' }));
  const approvals = new Map(rules.map((r, i) => [`id${i}`, { brdp_id: `id${i}`, status: 'approved', rule_xml: r.rule_xml }]));
  return generateSchematronDITA(brdps, { projectName: extra.projectName || 'P' }, { approvals, schemaSummary: summary, standard, vocabulary, ...extra });
}

// ── 1. The 35-rule Navantia documents ────────────────────────────────────
const generated = fs.readdirSync(FIXTURES).filter((f) => /^navantia-dita3-generated-.*\.sch$/.test(f));
check('a navantia-dita3-generated-*.sch fixture exists', generated.length > 0);
for (const file of generated) {
  const xml = readTextFile(new URL(file, FIXTURES));
  const found = names(lint(xml));
  const falseOnes = found.filter((n) => FALSE_NAMES.includes(n.replace(/^[<@]|>$/g, '')));
  check(`${file}: none of the 22 names of the real report`, falseOnes.length === 0, falseOnes.join(', '));
  if (file === 'navantia-dita3-generated-35-reconstructed.sch') {
    // The only one: <ditacomponent>, XMetal's wrapper of a conref'd
    // component, in BRDP-EXT-00008's ancestor::ditacomponent -- not DITA,
    // the same warning Suggest Rule / Paste rule give for that rule.
    const warnings = lint(xml);
    check(
      `${file}: only <ditacomponent> on BRDP-EXT-00008`,
      warnings.length === 1 && warnings[0].owner === 'BRDP-EXT-00008' && warnings[0].issue.params.names === '<ditacomponent>',
      JSON.stringify(warnings),
    );
  } else {
    console.log(`  ${file}: ${found.length ? found.join(', ') : 'no warnings'}`);
  }
}

// The reconstructed document is exactly what Generate writes for those
// 35 rules (the header comment aside): the lint never touches the output.
{
  const tpl = readPublicTemplate('brdp-template-dita-xpath3.xlsx')
    .filter((r) => r.ID.startsWith('BRDP-EXT-'))
    .map((r) => ({ identifier: r.ID, rule_xml: r.Rule }));
  const rec = extractRules(new URL('navantia-dita3-reconstructed.sch', FIXTURES), 'SCH-DITA', 'DITA 1.3 Xpath3.0')
    .candidates.filter((c) => c.rule_xml)
    .map((c) => ({ identifier: c.identifier, rule_xml: c.rule_xml }));
  const rules = [...tpl, ...rec].sort((a, b) => a.identifier.localeCompare(b.identifier));
  check('35 rules', rules.length === 35, String(rules.length));
  const out = await generate(rules, 'DITA 1.3 Xpath3.0', { projectName: 'Navantia S80 (reconstruido)' });
  const fixture = readTextFile(new URL('navantia-dita3-generated-35-reconstructed.sch', FIXTURES)).replace(/<!-- RECONSTRUCTED[\s\S]*?-->\n/, '');
  check('Generate writes the reconstructed document byte for byte', out.xml === fixture);
  check('35-rule document valid', out.valid, out.errors.join(' | '));
  const without = await generate(rules, 'DITA 1.3 Xpath3.0', { projectName: 'Navantia S80 (reconstruido)', vocabulary: null });
  check('the same document with no vocabulary at all', without.xml === out.xml);
  check('no vocabulary: said, no warnings', without.vocabularyUnavailable && without.vocabularyWarnings.length === 0, String(without.vocabularyUnavailable));
}

// ── 2. The 22 names in the role they have in XPath ───────────────────────
{
  const test = [
    "replace(lower-case(upper-case(translate(string(.), 'a', 'b'))), 'x', 'y') != ''",
    "count(sort(uri-collection('file:///x/'))) gt 0",
    "count(subsequence(*, 1, 2)) le 2",
    "iri-to-uri('a b') != ''",
    "position() lt max((1, 2)) and . is . and count(* intersect *) = count(* except p)",
    "for $i in 1 to 3 return $i",
    ". instance of element()",
    "count(node()) ge 0",
    "@role = 'x' or ancestor::topic/prolog/metadata/othermeta",
  ];
  const xml = doc(
    `<sch:pattern id="p-BRDP-EXT-00090"><sch:rule context="p">` +
      test.map((t, i) => `<sch:assert id="BRDP-EXT-00090${'abcdefghi'[i]}" test="${t.replace(/"/g, '&quot;')}">m</sch:assert>`).join('') +
      `</sch:rule></sch:pattern>`,
  );
  const warnings = lint(xml);
  check('functions and operators of the real report: no warning', warnings.length === 0, JSON.stringify(warnings));
  check('… also in an XPath 2.0 project', lint(xml.replace('xslt3', 'xslt2'), 'xslt2', 'DITA 1.3 Xpath2.0').length === 0);
}

// ── 3. Invented names, prefixed names, wrong kind ────────────────────────
{
  const xml = doc(
    `<sch:pattern id="p-BRDP-EXT-00091"><sch:rule context="//pokemon">` +
      `<sch:assert id="BRDP-EXT-00091" test="not(@noexiste) and xs:string(.) != '' and exists(fn:head(*))">m</sch:assert>` +
      `</sch:rule></sch:pattern>` +
      `<sch:pattern id="p-BRDP-EXT-00092"><sch:rule context="//href">` +
      `<sch:assert id="BRDP-EXT-00092" test="not(@topic)">m</sch:assert></sch:rule></sch:pattern>`,
  );
  const warnings = lint(xml);
  const by = (owner) => warnings.filter((w) => w.owner === owner).map((w) => w.issue);
  const nf = by('BRDP-EXT-00091');
  check('<pokemon> and @noexiste warn, by BRDP', nf.length === 1 && nf[0].code === 'names_not_found' && nf[0].params.names === '<pokemon>, @noexiste', JSON.stringify(nf));
  check('xs:string and fn:head never warn', !JSON.stringify(warnings).includes('string') && !JSON.stringify(warnings).includes('head'));
  const wt = by('BRDP-EXT-00092').map((i) => `${i.code}:${i.params.name}`).sort();
  check('wrong kind both ways', JSON.stringify(wt) === JSON.stringify(['wrong_type_as_attribute:topic', 'wrong_type_as_element:href']), JSON.stringify(wt));
  check(
    'text EN, as for a pasted rule',
    `BRDP-EXT-00091: ${formatSchemaIssue(nf[0], en)}` === 'BRDP-EXT-00091: The rule uses names not found in the DITA 1.3 Xpath3.0 schema: <pokemon>, @noexiste',
    formatSchemaIssue(nf[0], en),
  );
  check('text ES', formatSchemaIssue(nf[0], es) === 'La regla usa nombres no encontrados en el esquema de DITA 1.3 Xpath3.0: <pokemon>, @noexiste', formatSchemaIssue(nf[0], es));
  // A name inside a string literal, a comment or a $variable is never a name.
  const quiet = lint(
    doc(`<sch:pattern id="p-q"><!-- //pokemon --><sch:rule context="p"><sch:let name="pokemon" value="'//pokemon'"/>` +
      `<sch:assert id="BRDP-EXT-00093" test="$pokemon = '' and . => string-length() > 0">m</sch:assert></sch:rule></sch:pattern>`),
  );
  check('literal, comment, $variable, "=>" and ">" never warn', quiet.length === 0, JSON.stringify(quiet));
  // Every check of a pattern owns its warnings, as before.
  const two = lint(doc(`<sch:pattern id="p-x"><sch:rule context="pokemon"><sch:assert id="A1" test="true()">m</sch:assert><sch:report id="A2" test="false()">m</sch:report></sch:rule></sch:pattern>`));
  check('owner: the pattern\'s check ids', two.length === 1 && two[0].owner === 'A1, A2', JSON.stringify(two));
  const noIds = lint(doc(`<sch:pattern id="p-y"><sch:rule context="pokemon"><sch:assert test="true()">m</sch:assert></sch:rule></sch:pattern>`));
  check('owner: the pattern @id without check ids', noIds.length === 1 && noIds[0].owner === 'p-y', JSON.stringify(noIds));
}

// Generate knows the BRDP of each pattern: that is the owner, whatever ids
// the rule's asserts have (the real nav_dtm_xpath3_import.xlsx has three
// BRDPs with the same copied rule and the same assert ids).
{
  const rule = `<sch:pattern id="p-X"><sch:rule context="//pokemon"><sch:assert id="X1" test="true()">m</sch:assert></sch:rule></sch:pattern>`;
  const out = await generate([{ identifier: 'BRDP-EXT-00097', rule_xml: rule }, { identifier: 'BRDP-EXT-00098', rule_xml: `<!-- <sch:pattern> in a comment --><pattern id="p-Y"><rule context="p"><assert id="Y1" test="true()">m</assert></rule></pattern>${rule}` }], 'DITA 1.3 Xpath3.0');
  check('Generate: owner = the BRDP of each pattern', JSON.stringify(out.vocabularyWarnings.map((w) => w.owner)) === JSON.stringify(['BRDP-EXT-00097', 'BRDP-EXT-00098']), JSON.stringify(out.vocabularyWarnings));
}

// ── 4. A name in a sch:let hoisted to the schema ─────────────────────────
for (const [standard, binding] of [['DITA 1.3 Xpath3.0', 'xslt3'], ['DITA 1.3 Xpath2.0', 'xslt2']]) {
  const rule = (id) =>
    `<sch:pattern id="p-${id}"><sch:let name="raros" value="//pokemon"/><sch:rule context="p">` +
    `<sch:assert id="${id}" test="empty($raros)">m</sch:assert></sch:rule></sch:pattern>`;
  const out = await generate([{ identifier: 'BRDP-EXT-00094', rule_xml: rule('BRDP-EXT-00094') }, { identifier: 'BRDP-EXT-00095', rule_xml: rule('BRDP-EXT-00095') }], standard);
  check(`${binding}: the let is at schema level`, (out.xml.match(/name="raros"/g) || []).length === 1);
  check(
    `${binding}: warning attributed to shared:raros, once`,
    out.vocabularyWarnings.length === 1 && out.vocabularyWarnings[0].owner === 'shared:raros' && out.vocabularyWarnings[0].issue.params.names === '<pokemon>',
    JSON.stringify(out.vocabularyWarnings),
  );
}

// ── 5. XMetal's ditamap second pass ──────────────────────────────────────
{
  const warnings = lint(
    doc(`<sch:pattern id="p-BRDP-EXT-00096"><sch:rule context="dosier/ficha[mapa]">` +
      `<sch:assert id="BRDP-EXT-00096" test="exists(mapa/@href)">m</sch:assert></sch:rule></sch:pattern>`),
  );
  const codes = warnings.map((w) => w.issue.code);
  check('dosier/ficha/mapa: not found, plus the XMetal line', JSON.stringify(codes) === JSON.stringify(['names_not_found', 'xmetal_ambito_mapa']), JSON.stringify(warnings));
  check('exists() is a function, never a name', !JSON.stringify(warnings).includes('exists'));
  const xm = warnings.find((w) => w.issue.code === 'xmetal_ambito_mapa').issue;
  check('XMetal line EN', formatSchemaIssue(xm, en).startsWith('<dosier>, <ficha>, <mapa>: names of XMetal'), formatSchemaIssue(xm, en));
  check('XMetal line ES', formatSchemaIssue(xm, es).startsWith('<dosier>, <ficha>, <mapa>: nombres del mecanismo'), formatSchemaIssue(xm, es));
}

// ── 6. The DITA templates ────────────────────────────────────────────────
// Only XMetal's own names (<ditacomponent>, @conref-no-resuelto), the same
// ones Suggest Rule reports for those rules (scripts/test-rule-name-check.mjs).
for (const [file, standard, expected] of [
  ['brdp-template-dita-xpath2.xlsx', 'DITA 1.3 Xpath2.0', ['BRDP-EXT-00008: <ditacomponent>, @conref-no-resuelto', 'BRDP-EXT-00009: @conref-no-resuelto']],
  ['brdp-template-dita-xpath3.xlsx', 'DITA 1.3 Xpath3.0', ['BRDP-EXT-00008: <ditacomponent>']],
]) {
  const rules = readPublicTemplate(file).filter((r) => r.Rule).map((r) => ({ identifier: r.ID, rule_xml: r.Rule }));
  const out = await generate(rules, standard);
  const got = out.vocabularyWarnings.map((w) => `${w.owner}: ${w.issue.params.names}`);
  check(`${file}: only XMetal's own names`, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
}

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
