// Barrido final 2/2, Parts 1-2: src/utils/ruleLint.js -- each problem once
// per rule, the duplicate-value check, and the warnings the Test rule panel
// and the suggested rule show (EN/ES).
// Run: node scripts/test-rule-lint.mjs
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { formatLintFinding, lintRuleFindings, lintWarnings } from '../src/utils/ruleLint.js';
import { lintRule } from './lib/ruleLint.mjs';

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) passes++;
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `\n   ${detail}` : ''}`);
  }
}
function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0]);
  return doc;
}
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const sor = (path, flag, { use = 'x', extra = '', id = '' } = {}) =>
  `<structureObjectRule${id ? ` id="${id}"` : ''}><objectPath allowedObjectFlag="${flag}">${path}</objectPath><objectUse>${use}</objectUse>${extra}</structureObjectRule>`;
const ov = (v, form = 'single') => `<objectValue valueForm="${form}" valueAllowed="${v}"/>`;
const codes = (findings) => findings.filter((f) => !f.known).map((f) => f.code).sort();

// ── Once per rule ──────────────────────────────────────────────────────
const thrice = ['assyCode', 'subSystemCode', 'subSubSystemCode']
  .map((n) => sor(`//@${n}[matches(., '^\\d{2}$')]`, '1', { id: `R-${n}` }))
  .join('');
const f3 = lintRuleFindings(thrice, 'BREX-4.2', { parseXml });
const flag1 = f3.filter((f) => f.code === 'flag1_value_predicate');
check('same problem in three places → one finding', flag1.length === 1, JSON.stringify(f3));
check('… with 3 occurrences and 3 items', flag1[0]?.occurrences === 3 && flag1[0]?.items.length === 3);
const d3 = formatLintFinding(flag1[0], en).detail;
check('… the detail names every place', ['R-assyCode', 'R-subSystemCode', 'R-subSubSystemCode'].every((id) => d3.includes(id)), d3);
const script3 = lintRule(thrice, 'BREX-4.2').filter((f) => f.kind === 'flag 1 with a value predicate');
check('script: one row, occurrences 3', script3.length === 1 && script3[0].occurrences === 3);

const depth = sor('//proceduralStep[count(ancestor::*) &gt; 5]/title | //levelledPara[count(ancestor::*) &gt; 5]/title', '0');
const dd = lintRuleFindings(depth, 'BREX-4.2', { parseXml }).filter((f) => f.code === 'ancestor_depth');
check('count(ancestor::*) twice in one rule → one finding', dd.length === 1);

// ── Duplicate allowed values ───────────────────────────────────────────
const dup = sor('//@emphasisType', '2', { id: 'R-DUP', extra: ov('em01') + ov('em02') + ov('em01') });
const fd = lintRuleFindings(dup, 'BREX-4.2', { parseXml });
check('"em01" twice → duplicate_values', codes(fd).includes('duplicate_values'), JSON.stringify(codes(fd)));
const dupDetail = formatLintFinding(fd.find((f) => f.code === 'duplicate_values'), en).detail;
check('… detail', dupDetail === 'R-DUP: listed more than once: em01 (2 times)', dupDetail);
check('no duplicate when every value differs', !codes(lintRuleFindings(sor('//@emphasisType', '2', { extra: ov('em01') + ov('em02') }), 'BREX-4.2', { parseXml })).includes('duplicate_values'));
check(
  'same text as single and as pattern is not a duplicate',
  !codes(lintRuleFindings(sor('//@emphasisType', '2', { extra: ov('em01') + ov('em01', 'pattern') }), 'BREX-4.2', { parseXml })).includes('duplicate_values'),
);
check(
  'duplicates in two rules of one stored rule → one finding, two items',
  (() => {
    const two = sor('//@a', '2', { id: 'A', extra: ov('x') + ov('x') }) + sor('//@b', '2', { id: 'B', extra: ov('y') + ov('y') });
    const f = lintRuleFindings(two, 'BREX-4.2', { parseXml }).find((x) => x.code === 'duplicate_values');
    return f?.items.length === 2 && f.occurrences === 2;
  })(),
);
const v301 = `<objrule id="R301"><objpath objappl="1">//@emph</objpath><objuse>x</objuse><objval valtype="single" val1="em01"/><objval valtype="single" val1="em01"/></objrule>`;
check('3.0.1 objval twice → duplicate_values', codes(lintRuleFindings(v301, 'BREX-3.0.1', { parseXml })).includes('duplicate_values'));
const sch = `<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"><sch:rule context="note"><sch:assert test="@type = ('caution', 'note', 'caution')">Bad type.</sch:assert></sch:rule></sch:pattern>`;
const fs = lintRuleFindings(sch, 'SCH-DITA', { parseXml }).find((f) => f.code === 'duplicate_values');
check('Schematron ("caution" twice in a sequence) → duplicate_values', Boolean(fs));
check('… detail quotes the sequence', /caution \(2 times\)/.test(formatLintFinding(fs, en).detail) && !/note \(/.test(formatLintFinding(fs, en).detail));

// ── Warnings shown while working the rule (Part 2) ─────────────────────
const mustNot = sor('//emphasis', '2', { use: 'Emphasis must not be used.', id: 'R-MN' });
const panel = lintWarnings(mustNot, 'BREX-4.2', 'panel', en, { parseXml }).map((w) => w.code);
const suggestion = lintWarnings(mustNot, 'BREX-4.2', 'suggestion', en, { parseXml }).map((w) => w.code);
check('panel: "must not" but allowed, never "cannot reject" (the panel already says it)', panel.join() === 'must_not_allowed', panel.join());
check('suggestion: cannot reject + "must not" but allowed', suggestion.sort().join() === 'cannot_reject,must_not_allowed', suggestion.join());
const wEs = lintWarnings(dup, 'BREX-4.2', 'panel', es, { parseXml })[0];
check('ES title and detail', wEs?.title === 'El mismo valor permitido aparece más de una vez' && wEs.detail === 'R-DUP: aparece más de una vez: em01 (2 veces)', JSON.stringify(wEs));
const wEn = lintWarnings(dup, 'BREX-4.2', 'panel', en, { parseXml })[0];
check('EN title', wEn?.title === 'The same allowed value is listed more than once');
check('a correct rule has no warning', lintWarnings(sor('//emphasis', '0', { use: 'Emphasis must not be used.' }), 'BREX-4.2', 'suggestion', en, { parseXml }).length === 0);
check('known reasons never warn (document())', lintWarnings(sor("//dmRef[not(document('x.xml'))]", '0'), 'BREX-4.2', 'suggestion', en, { parseXml }).length === 0);
check('an informative rule never warns', lintWarnings(sor('//acronym', '2', { use: 'Acronyms are allowed.' }), 'BREX-4.2', 'suggestion', en, { parseXml }).length === 0);
check('broken XML never throws', Array.isArray(lintWarnings('<structureObjectRule>', 'BREX-4.2', 'suggestion', en, { parseXml })));
for (const lng of ['en', 'es']) {
  const t = i18n.getFixedT(lng);
  for (const code of ['cannot_reject', 'must_not_allowed', 'flag1_value_predicate', 'ancestor_depth', 'duplicate_values']) {
    const key = `records.ruleLint.titles.${code}`;
    check(`${lng}: ${key}`, t(key) !== key);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
