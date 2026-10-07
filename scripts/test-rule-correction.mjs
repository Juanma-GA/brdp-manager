// Corrección propuesta de reglas con defecto: src/validation/ruleCorrection.js
// on the real S1000D 3.0.1 vocabulary and schema graph. Plain Node.
//
// The five real cases of the encargo (S1000D 3.0.1, a project of 2819 rules):
//   BRDP-EXT-02816 and BRDP-EXT-02815: the texts of scripts/test-mejoras-d.mjs
//     (Juanma's rules A and B); 02816 as the encargo says it is stored,
//     WITHOUT <deflist> (//figure//legend/def[…]).
//   BRDP-EXT-02656 (@cheksum), BRDP-EXT-02814 (same id XML-R-2826 as 02815)
//     and BRDP-EXT-02773 (<schemaRef>/<schemaInfo>): their full texts are
//     not in this repository; they are written here with exactly the defect
//     the encargo describes (the name, the id), on paths of the 3.0.1 schema.
//
//   node scripts/test-rule-correction.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import {
  applyDefectFix,
  clashDefects,
  correctionRecord,
  formatRuleDefect,
  formatRuleFix,
  projectRuleIdClashes,
  proposeRuleCorrection,
  renameXPathName,
  ruleDefects,
} from '../src/validation/ruleCorrection.js';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { schemaGraph } from './lib/schemaGraph.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
const parseXml = (text) => {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0]);
  return doc;
};
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const others301 = [
  { label: 'S1000D 4.1', vocabulary: vocabOf('schema-vocabulary-4-1.json') },
  { label: 'S1000D 4.2', vocabulary: vocabOf('schema-vocabulary-4-2.json') },
  { label: 'DITA 1.3', vocabulary: vocabOf('schema-vocabulary-dita.json') },
];
const S301 = 'S1000D 3.0.1';
const ctx301 = { vocabulary: vocabOf('schema-vocabulary-3-0-1.json'), otherVocabularies: others301, graph: schemaGraph(S301), standard: S301, parseXml };
const F = 'BREX-3.0.1';
const objrule = (id, path, use = 'x') => `<objrule id="${id}"><objpath objappl="0">${path}</objpath><objuse>${use}</objuse></objrule>`;
const codes = (r) => r.defects.map((d) => d.code + (d.fix ? '*' : '')).sort();

const RULE_02816 = '<objrule id="XML-R-2828"><objpath objappl="0">//figure//legend/def[not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)]</objpath><objuse>Prohibir &lt;def&gt; que no coincida con ningun @title de los elementos de tipo &lt;hotspot&gt; de su &lt;figure&gt;</objuse></objrule>';
const RULE_02815 = '<objrule id="XML-R-2826"><objpath objappl="0">//figure//legend/deflist/term[not(. = //figure//graphic//hotspot/@apsname)]</objpath><objuse>Prohibir &lt;term&gt; que no coincida con algun atributo @apsname de los elementos de tipo &lt;hotspot&gt; de su &lt;figure&gt;</objuse></objrule>';
const RULE_02656 = objrule('XML-R-2656', '//cb[not(@cheksum)]', 'Obligatorio @checksum en &lt;cb&gt;');
const RULE_02814 = objrule('XML-R-2826', '//figure//legend/deflist/term[not(normalize-space(.))]');
const RULE_02773 = objrule('XML-R-2773', '//schemaRef[not(schemaInfo)]');

// ─── The five real cases ────────────────────────────────────────────────────
{
  const r = proposeRuleCorrection(RULE_02816, F, ctx301);
  check('02816: one path defect with a fix', JSON.stringify(codes(r)) === '["path*"]', JSON.stringify(codes(r)));
  check('02816: proposal adds <deflist>', r.proposal?.xml === RULE_02816.replace('legend/def[', 'legend/deflist/def['), r.proposal?.xml);
  check('02816: nothing left', r.proposal?.remaining.length === 0);
  check('02816: objuse untouched', r.proposal?.xml.includes('Prohibir &lt;def&gt;'));
  check('02816: reason EN', formatRuleDefect(r.defects[0], en, { format: F }) === 'The path cannot exist: <def> does not go inside <legend>; it goes inside <deflist>.', formatRuleDefect(r.defects[0], en, { format: F }));
  check('02816: fix EN/ES', formatRuleFix(r.defects[0].fix, en) === 'Add <deflist> to the path.' && formatRuleFix(r.defects[0].fix, es) === 'Añadir <deflist> a la ruta.', formatRuleFix(r.defects[0].fix, es));
}
{
  const r = proposeRuleCorrection(RULE_02815, F, ctx301);
  check('02815: any_ancestor with a fix', JSON.stringify(codes(r)) === '["any_ancestor*"]', JSON.stringify(codes(r)));
  check('02815: ancestor::figure in the predicate only', r.proposal?.xml.includes('[not(. = ancestor::figure//graphic//hotspot/@apsname)]') && r.proposal.xml.startsWith('<objrule id="XML-R-2826"><objpath objappl="0">//figure//legend'), r.proposal?.xml);
}
{
  const r = proposeRuleCorrection(RULE_02656, F, ctx301);
  check('02656: @cheksum, one similar name', JSON.stringify(codes(r)) === '["name_similar*"]', JSON.stringify(codes(r)));
  check('02656: proposal @checksum, objuse untouched', r.proposal?.xml === RULE_02656.replace('@cheksum)', '@checksum)'), r.proposal?.xml);
  check('02656: text ES', formatRuleDefect(r.defects[0], es) === '@cheksum no existe en S1000D 3.0.1; el único nombre parecido es @checksum.', formatRuleDefect(r.defects[0], es));
}
{
  const clashes = projectRuleIdClashes(
    [
      { brdpId: 'a', identifier: 'BRDP-EXT-02815', xml: RULE_02815 },
      { brdpId: 'b', identifier: 'BRDP-EXT-02814', xml: RULE_02814 },
      { brdpId: 'c', identifier: 'BRDP-EXT-02816', xml: RULE_02816 },
    ],
    F
  );
  check('02814/02815: the shared id on both, never on 02816', clashes.get('a')?.[0].others[0] === 'BRDP-EXT-02814' && clashes.get('b')?.[0].others[0] === 'BRDP-EXT-02815' && !clashes.has('c'));
  const defects = clashDefects(clashes.get('b'));
  check('02814: shared id has no fix', defects.length === 1 && defects[0].fix === null && defects[0].params.id === 'XML-R-2826');
  check('02814: text EN', formatRuleDefect(defects[0], en).startsWith('The id XML-R-2826 is also used by the rule of BRDP-EXT-02815'), formatRuleDefect(defects[0], en));
  const own = proposeRuleCorrection(RULE_02814, F, ctx301);
  check('02814: the rule itself is fine (the defect is the project\'s)', own.defects.length === 0 && own.proposal === null, JSON.stringify(codes(own)));
}
{
  const r = proposeRuleCorrection(RULE_02773, F, ctx301);
  check('02773: two names, no similar one, no fix', JSON.stringify(codes(r)) === '["name_unknown","name_unknown"]' && r.proposal === null, JSON.stringify(codes(r)));
  check('02773: text EN', r.defects.some((d) => formatRuleDefect(d, en) === '<schemaRef> does not exist in the S1000D 3.0.1 schema, and there is no similar name.'));
}

// ─── Edge cases of the encargo ──────────────────────────────────────────────
{
  // Two mechanical defects -> one proposal with both fixes and both reasons.
  const rule = objrule('R1', '//figure//legend/def[not(. = //figure//graphic//hotspot/@title)]');
  const r = proposeRuleCorrection(rule, F, ctx301);
  check('two defects: one proposal with both', r.proposal?.fixes.length === 2 && r.proposal.xml.includes('legend/deflist/def[not(. = ancestor::figure//graphic//hotspot/@title)]'), r.proposal?.xml);
  const record = correctionRecord(r.proposal);
  check('two defects: History record has both, codes only', record.fixes.length === 2 && record.fixes.every((f) => /^[a-z_]+$/.test(f.code)) && JSON.parse(JSON.stringify(record)).fixes.length === 2);
}
{
  // A fixable and an unfixable defect -> the fixable one, and what is left.
  const rule = objrule('R2', '//figure//legend/def[not(schemaRef)]');
  const r = proposeRuleCorrection(rule, F, ctx301);
  check('fixable + unfixable: proposal with the fixable', r.proposal?.xml.includes('legend/deflist/def[not(schemaRef)]'), r.proposal?.xml);
  check('fixable + unfixable: what is left is said', r.proposal?.remaining.some((d) => d.code === 'name_unknown' && d.params.name === 'schemaRef'));
}
{
  // A name with two similar names -> no fix, both candidates.
  const vocab = { elements: new Set(['dmodule', 'para', 'parts', 'party']), attributes: new Set() };
  const r = proposeRuleCorrection(objrule('R3', '//parte'), F, { ...ctx301, vocabulary: vocab, graph: null });
  check('two similar names: no fix', r.proposal === null && r.defects[0].code === 'name_ambiguous', JSON.stringify(codes(r)));
  check('two similar names: both candidates said', formatRuleDefect(r.defects[0], en) === '<parte> does not exist in S1000D 3.0.1; similar names: <parts> or <party> -- there is no telling which one was meant.', formatRuleDefect(r.defects[0], en));
}
{
  // A name of another edition -> no fix, which edition.
  const r = proposeRuleCorrection(objrule('R4', '//dmAddress'), F, ctx301);
  check('other edition: no fix', r.proposal === null && r.defects[0].code === 'name_other_standard', JSON.stringify(codes(r)));
  check('other edition: EN text', formatRuleDefect(r.defects[0], en) === '<dmAddress> does not exist in S1000D 3.0.1; it exists in S1000D 4.1 and 4.2.', formatRuleDefect(r.defects[0], en));
  check('other edition: ES text', formatRuleDefect(r.defects[0], es) === '<dmAddress> no existe en S1000D 3.0.1; existe en S1000D 4.1 y 4.2.', formatRuleDefect(r.defects[0], es));
  // Not decided before the other vocabularies are there.
  const pending = proposeRuleCorrection(objrule('R4', '//dmAddress'), F, { ...ctx301, otherVocabularies: null });
  check('other edition: not decided before the vocabularies load', pending.needsOtherVocabularies && pending.proposal === null);
}
{
  // A correction that fails the checks -> not proposed, stays without fix:
  // @cheksum → @checksum on <hotspot>, which has no @checksum.
  const rule = objrule('R5', '//hotspot[not(@cheksum)]');
  const r = proposeRuleCorrection(rule, F, ctx301);
  check('failing correction: not proposed', r.proposal === null, r.proposal?.xml);
  check('failing correction: the defect stays', r.defects.some((d) => d.code === 'name_similar' && d.params.name === 'cheksum'));
}
{
  // Standard without a schema graph (S1000D 5.0-like): only the defects
  // that need no graph.
  const r = proposeRuleCorrection(RULE_02816, F, { ...ctx301, graph: null });
  check('no graph: no path defect', !r.defects.some((d) => d.code === 'path'));
  const r2 = proposeRuleCorrection(RULE_02656, F, { ...ctx301, graph: null });
  check('no graph: names still checked', r2.proposal?.xml.includes('@checksum'));
}
{
  // Clean rule: nothing.
  const r = proposeRuleCorrection(objrule('R6', '//figure//legend/deflist/def'), F, ctx301);
  check('clean rule: no defect', r.defects.length === 0 && r.proposal === null, JSON.stringify(codes(r)));
}
{
  // Split and numbered ids, within one rule.
  const two = '<objrule id="R7"><objpath objappl="0">//randlist</objpath><objuse>a</objuse><objpath objappl="0">//seqlist</objpath><objuse>b</objuse></objrule>';
  const r = proposeRuleCorrection(two, F, ctx301);
  check('two objpath: split proposed', r.proposal?.fixes[0].code === 'multiple_paths' && (r.proposal.xml.match(/<objrule /g) || []).length === 2, r.proposal?.xml);
  const dup = `${objrule('R8', '//randlist')}${objrule('R8', '//seqlist')}`;
  const d = proposeRuleCorrection(dup, F, ctx301);
  check('same id twice in one rule: numbered', d.proposal?.xml.includes('id="R8-1"') && d.proposal.xml.includes('id="R8-2"'), d.proposal?.xml);
  check('split text EN', formatRuleFix(r.proposal.fixes[0].fix, en) === 'Split into 2 rules (one per path).', formatRuleFix(r.proposal.fixes[0].fix, en));
}
{
  // Impossible root: /techstd -> //techstd (real 3.0.1 case of Mejoras C).
  const r = proposeRuleCorrection(objrule('R9', '/techstd[not(authex) or not(notes)]'), F, ctx301);
  check('impossible root: //techstd proposed', r.proposal?.xml.includes('//techstd[not(authex) or not(notes)]'), r.proposal?.xml);
}
{
  // Schematron DITA: names and paths only (no any-ancestor, no split).
  const vocabDita = vocabOf('schema-vocabulary-dita.json');
  const ctxDita = { vocabulary: vocabDita, otherVocabularies: [], graph: schemaGraph('DITA 1.3 Xpath2.0'), standard: 'DITA 1.3 Xpath2.0', parseXml };
  const sch = '<sch:pattern id="p1"><sch:rule context="note"><sch:assert test="@outputclas" id="a1">x</sch:assert></sch:rule></sch:pattern>';
  const r = proposeRuleCorrection(sch, 'SCH-DITA', ctxDita);
  check('DITA: @outputclas -> @outputclass in test', r.proposal?.xml === sch.replace('@outputclas"', '@outputclass"'), r.proposal?.xml);
  const anc = '<sch:pattern id="p2"><sch:rule context="fig//dl/dlentry/dt[not(. = //fig//image/@href)]"><sch:assert test="false()" id="a2">x</sch:assert></sch:rule></sch:pattern>';
  check('DITA: no any-ancestor check', !ruleDefects(anc, 'SCH-DITA', ctxDita).defects.some((d) => d.code === 'any_ancestor'));
}

// ─── Renaming inside XPath only ─────────────────────────────────────────────
check('rename: attribute, not in a literal', renameXPathName("//cb[@cheksum = 'cheksum']", 'cheksum', 'checksum', 'attribute') === "//cb[@checksum = 'cheksum']");
check('rename: element, not as attribute', renameXPathName('//para[@para]/para', 'para', 'p', 'element') === '//p[@para]/p');
check('rename: never a function, a variable, a prefixed name', renameXPathName('count(x:count)[$count]', 'count', 'c', 'element') === 'count(x:count)[$count]');
check('rename: attribute:: axis', renameXPathName('//a/attribute::cheksum', 'cheksum', 'checksum', 'attribute') === '//a/attribute::checksum');
check('rename: entities kept', renameXPathName('//a[count(b) &lt; 2]', 'b', 'c', 'element') === '//a[count(c) &lt; 2]');
check('applyDefectFix: unknown fix leaves the text', applyDefectFix('<x/>', F, { kind: 'nope' }).changed === false);

// ─── The curated templates: no defect where there is none ───────────────────
for (const [file, standard, format, vocabFile] of [
  ['brdp-template-3-0-1.xlsx', 'S1000D 3.0.1', 'BREX-3.0.1', 'schema-vocabulary-3-0-1.json'],
  ['brdp-template-4-1.xlsx', 'S1000D 4.1', 'BREX-4.1', 'schema-vocabulary-4-1.json'],
  ['brdp-template-4-2.xlsx', 'S1000D 4.2', 'BREX-4.2', 'schema-vocabulary-4-2.json'],
]) {
  const ctx = { vocabulary: vocabOf(vocabFile), otherVocabularies: others301, graph: schemaGraph(standard), standard, parseXml };
  const rows = readPublicTemplate(file).filter((row) => row.Rule);
  const flagged = rows.map((row) => [row.ID, proposeRuleCorrection(row.Rule, format, ctx)]).filter(([, r]) => r.defects.length > 0);
  check(`${file}: no defect in its ${rows.length} rules`, flagged.length === 0, flagged.map(([id, r]) => `${id}: ${r.defects.map((d) => formatRuleDefect(d, en)).join(' | ')}`).join('\n     '));
}

// ─── Every text key exists in EN and ES ─────────────────────────────────────
const all = [
  ...proposeRuleCorrection(RULE_02773, F, ctx301).defects,
  ...proposeRuleCorrection(objrule('R4', '//dmAddress'), F, ctx301).defects,
  ...proposeRuleCorrection(RULE_02816, F, ctx301).defects,
];
for (const t of [en, es]) {
  for (const d of all) {
    const text = formatRuleDefect(d, t, { format: F });
    check(`text ${d.code}: no raw key`, !/records\.|\{\{/.test(text), text);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
