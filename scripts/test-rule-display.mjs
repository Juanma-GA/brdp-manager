// Formatted rule view (Test de reglas, progreso y causas, Part 2.3): the
// formatting never changes a rule's meaning. Plain Node, no test runner.
// Over every rule of the curated templates (the four Navantia dossier rules
// of the DITA XPath 3.0 template among them) and every rule of
// scripts/prompt-eval/cases.json:
//   - every formatted XPath expression, its lines rejoined without the
//     indentation, parses (isXPathSyntaxValid) whenever the source does;
//   - it equals the source with whitespace outside literals collapsed
//     (_normSpace, the app's own criterion);
//   - a literal with two spaces keeps two spaces.
// Plus the view itself: sch:let as "$name := value", short rules on one
// line, repeated xmlns once, comments kept, entities as characters,
// malformed → not formatted.
// Run: node scripts/test-rule-display.mjs
import { DOMParser } from '@xmldom/xmldom';
import fs from 'node:fs';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { formatRuleForDisplay, formatXPath, joinXPathLines, collapseOutsideLiterals, ruleXPathExpressions } from '../src/utils/ruleDisplay.js';
import { isXPathSyntaxValid } from '../src/validation/schemaValidation.js';
import { _normSpace } from '../src/api/brexToSchematron.js';
import { STANDARD_TO_RULE_FORMAT } from '../src/constants/ruleFormats.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, m) => messages.push(m) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(String(messages[0]));
  return doc;
}
const opts = { parseXml };
const lineText = (l) => l.tokens.map((t) => t.text).join('');

// ─── The rules ──────────────────────────────────────────────────────────────
const TEMPLATES = {
  'brdp-template-3-0-1.xlsx': 'BREX-3.0.1',
  'brdp-template-4-1.xlsx': 'BREX-4.1',
  'brdp-template-4-2.xlsx': 'BREX-4.2',
  'brdp-template-dita-xpath2.xlsx': 'SCH-DITA',
  'brdp-template-dita-xpath3.xlsx': 'SCH-DITA',
};
const rules = [];
for (const [file, format] of Object.entries(TEMPLATES)) {
  for (const row of readPublicTemplate(file)) if (row.Rule) rules.push({ name: `${file} ${row.ID}`, xml: row.Rule, format });
}
const cases = JSON.parse(fs.readFileSync(new URL('./prompt-eval/cases.json', import.meta.url), 'utf8'));
for (const c of Array.isArray(cases) ? cases : cases.cases) {
  if (typeof c.rule === 'string' && STANDARD_TO_RULE_FORMAT[c.standard]) rules.push({ name: `cases.json ${c.id}`, xml: c.rule, format: STANDARD_TO_RULE_FORMAT[c.standard] });
}
const navantia = rules.filter((r) => r.name.startsWith('brdp-template-dita-xpath3.xlsx') && ['BRDP-EXT-00004', 'BRDP-EXT-00007', 'BRDP-EXT-00008', 'BRDP-EXT-00009'].some((id) => r.name.endsWith(id)));
check('the four Navantia dossier rules are among them', navantia.length === 4, navantia.map((r) => r.name).join(', '));
check('cases.json rules are among them', rules.filter((r) => r.name.startsWith('cases.json')).length > 20, String(rules.length));

let expressions = 0;
let split = 0;
for (const r of rules) {
  const view = formatRuleForDisplay(r.xml, r.format, opts);
  check(`${r.name}: formatted`, view.ok, view.reason);
  for (const expr of ruleXPathExpressions(r.xml, r.format, opts)) {
    expressions += 1;
    const lines = formatXPath(collapseOutsideLiterals(expr));
    if (lines.length > 1) split += 1;
    const joined = joinXPathLines(lines);
    check(`${r.name}: rejoined equals the source collapsed (_normSpace)`, joined === _normSpace(expr), `${joined}\n  vs ${_normSpace(expr)}`);
    if (isXPathSyntaxValid(expr)) check(`${r.name}: rejoined still parses`, isXPathSyntaxValid(joined), joined);
  }
}
check('some expressions were split', split > 5, `${split} of ${expressions}`);
console.log(`(${rules.length} rules, ${expressions} expressions, ${split} split over several lines)`);

// ─── Edge cases ─────────────────────────────────────────────────────────────
{
  const expr = "contains(., '  two  spaces  ') and   normalize-space(.)  != ''";
  const joined = joinXPathLines(formatXPath(collapseOutsideLiterals(expr)));
  check('a literal with two spaces keeps two spaces', joined.includes("'  two  spaces  '") && joined === "contains(., '  two  spaces  ') and normalize-space(.) != ''", joined);
}
{
  const view = formatRuleForDisplay('<sch:pattern id="p"><sch:rule context="note"><sch:assert id="A" test="@type != \'&lt;b&gt;\'">x</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA', opts);
  const text = view.lines.map(lineText).join('\n');
  check('&lt; inside a literal shows as <', text.includes("@type != '<b>'"), text);
}
{
  const view = formatRuleForDisplay('<structureObjectRule id="r"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>', 'BREX-4.2', opts);
  const text = view.lines.map(lineText);
  check('a short BREX rule: each element on one line, the path not split', text.includes('<objectPath allowedObjectFlag="0">//emphasis</objectPath>') && view.lines[1].indent === 1 && text.length === 4, JSON.stringify(text));
  check('  path tokens typed', view.lines[1].tokens.some((t) => t.type === 'element' && t.text === 'emphasis'));
}
{
  const view = formatRuleForDisplay('<sch:pattern id="p"><sch:rule context="map"><sch:let name="n" value="count(//topicref)"/><sch:assert id="A" test="$n &gt; 0">x</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA', opts);
  const text = view.lines.map(lineText);
  check('sch:let as "$name := value"', text.includes('$n := count(//topicref)'), JSON.stringify(text));
  check('  $n is a variable token', view.lines.find((l) => lineText(l).startsWith('$n'))?.tokens[0].type === 'variable');
}
{
  const view = formatRuleForDisplay('<structureObjectRule id="r"><objectPath>//a</structureObjectRule>', 'BREX-4.2', opts);
  check('malformed: not formatted (shown as saved)', view.ok === false);
}
{
  const ext8 = navantia.find((r) => r.name.endsWith('BRDP-EXT-00008'));
  const view = formatRuleForDisplay(ext8.xml, 'SCH-DITA', opts);
  check('EXT-00008: xmlns:xs declared on every function → once, at the top', view.sharedNamespaces.length === 1 && view.sharedNamespaces[0].prefix === 'xs');
  const text = view.lines.map(lineText).join('\n');
  check('  and hidden in the elements', !text.includes('xmlns:xs'), text.slice(0, 300));
  check('  $pasosPrec and $notas shown as let', text.includes('$pasosPrec := $docPrec//cmd ! normalize-space(.)') && /\$notas := \$docs\/\/note\[/.test(text));
  const ext4 = formatRuleForDisplay(navantia.find((r) => r.name.endsWith('BRDP-EXT-00004')).xml, 'SCH-DITA', opts);
  const t4 = ext4.lines.map(lineText);
  check('EXT-00004: comments kept, references shown as characters', t4.some((l) => l.includes('<!-- Localización de la celda de la planificación')), t4.filter((l) => l.includes('<!--')).join('\n'));
  check('EXT-00004: a function split, its body indented, "}" under "$name"', (() => {
    const i = ext4.lines.findIndex((l) => lineText(l).startsWith('$escalonProc := function('));
    const close = ext4.lines.slice(i + 1).find((l) => lineText(l) === '}');
    return i >= 0 && ext4.lines[i + 1].indent === ext4.lines[i].indent + 1 && close?.indent === ext4.lines[i].indent;
  })(), t4.join('\n'));
  check('EXT-00004: then/else on their own lines', t4.some((l) => l.trim() === 'then $clave') && t4.some((l) => l.trim() === 'else normalize-space($celda)'));
  check('EXT-00004: a single-line rule element context="map" not split', t4.includes('<sch:rule context="map">'));
}
{
  const xpath = 'every $p in $a[. != \'\'], $q in $b satisfies $p = $q and some $x in $c satisfies $x';
  const lines = formatXPath(xpath);
  check('every/satisfies split, binding comma one level in', lines.length >= 3 && lineText(lines[1]).startsWith('$q in') && lines[1].indent === 1, JSON.stringify(lines.map((l) => [l.indent, lineText(l)])));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
