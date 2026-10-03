// Consolidation C1, Part 1: the message layer of the one schema-validation
// service (src/validation/schemaValidation.js). Every finding is
// { source, code, params }; formatSchemaIssue must give, in EN and ES, the
// exact text each panel produced with its own t() call before the
// consolidation. Plain Node, the real module and the real i18n.
// Run: node scripts/test-schema-validation.mjs
import i18n from '../src/i18n/index.js';
import {
  SCHEMA_ISSUE_KEYS,
  checkRuleFormat,
  formatSchemaIssue,
  ruleFormatIssues,
  nameIssues,
  schemaIssueKey,
  structureIssues,
  xpathIssues,
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
const texts = (issues, t) => issues.map((i) => formatSchemaIssue(i, t));
const result = {
  available: true,
  notFound: ['<pokemon>', '@foo'],
  wrongType: [
    { name: 'label', usedAs: 'element', actualAs: 'attribute' },
    { name: 'title', usedAs: 'attribute', actualAs: 'element' },
  ],
};
const standard = 'S1000D 4.2';

for (const lang of ['en', 'es']) {
  const t = i18n.getFixedT(lang);
  // BRDP text (RecordsPage's notice, before: three direct t() calls).
  check(`${lang} brdp`, JSON.stringify(texts(nameIssues(result, 'brdp', { standard }), t)) === JSON.stringify([
    t('records.assistant.vocabUnknownNames', { standard, names: '<pokemon>, @foo' }),
    t('records.assistant.vocabWrongTypeAsElement', { standard, name: 'label' }),
    t('records.assistant.vocabWrongTypeAsAttribute', { standard, name: 'title' }),
  ]));
  // Suggested rule (RuleSuggestionPanel, before: invalid XPaths, then names).
  check(`${lang} rule`, JSON.stringify(texts([...xpathIssues(['//<emphasis>']), ...nameIssues(result, 'rule', { standard })], t)) === JSON.stringify([
    t('records.assistant.ruleInvalidXPath', { expression: '//<emphasis>' }),
    t('records.assistant.ruleNamesNotFound', { standard, names: '<pokemon>, @foo' }),
    t('records.assistant.vocabWrongTypeAsElement', { standard, name: 'label' }),
    t('records.assistant.vocabWrongTypeAsAttribute', { standard, name: 'title' }),
  ]));
  // Ask answer.
  check(`${lang} answer`, JSON.stringify(texts(nameIssues(result, 'answer', { standard }), t)) === JSON.stringify([
    t('records.assistant.answerUnknownNames', { standard, names: '<pokemon>, @foo' }),
    t('records.assistant.answerWrongTypeAsElement', { standard, name: 'label' }),
    t('records.assistant.answerWrongTypeAsAttribute', { standard, name: 'title' }),
  ]));
  // Test rule example: wrong types in one line, then the structure.
  const structure = [
    { kind: 'notAllowed', element: 'content', parent: 'warning' },
    { kind: 'unknownAttribute', attribute: 'emphasisType', element: 'note' },
  ];
  check(`${lang} example`, JSON.stringify(texts([...nameIssues(result, 'example', { standard }), ...structureIssues(structure, { schema: 'descript' })], t)) === JSON.stringify([
    t('records.ruleTest.unknownNames', { standard, names: '<pokemon>, @foo' }),
    t('records.ruleTest.wrongTypeNames', { names: 'label, title' }),
    t('records.ruleTest.structure.notAllowed', { ...structure[0], schema: 'descript' }),
    t('records.ruleTest.structure.unknownAttribute', { ...structure[1], schema: 'descript' }),
  ]));
}

// Every key of the table resolves in both languages (no raw key shown).
for (const lang of ['en', 'es']) {
  const t = i18n.getFixedT(lang);
  for (const [source, codes] of Object.entries(SCHEMA_ISSUE_KEYS)) {
    for (const [code, key] of Object.entries(codes)) {
      check(`${lang} ${source}.${code} translated`, t(key, { standard, names: 'x', name: 'x', expression: 'x', element: 'x', parent: 'y', attribute: 'z', expected: 'w', schema: 's', format: 'f', inner: 'i', otherFormat: 'o', text: 'tx' }) !== key);
    }
  }
}

// ─── Consolidation C2, Part 0: checkRuleFormat ──────────────────────────────
// Same cases as backend/tests/test_rule_format_check.py (keep in sync).
{
  const RULE_42 =
    '<structureObjectRule id="BRDP-X-1"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>';
  const NON_CONTEXT_42 = '<nonContextRule id="BRDP-X-2"><simplePara>Follow the style guide.</simplePara></nonContextRule>';
  const CONTEXT_42 = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"><structureObjectRuleGroup>${RULE_42}</structureObjectRuleGroup></contextRules>`;
  const RULE_301 = '<objrule id="BRDP-X-3"><objpath objappl="0">//emphasis</objpath><objuse>No emphasis.</objuse></objrule>';
  const PATTERN_DITA =
    '<sch:pattern id="p1"><sch:rule context="note"><sch:assert id="a1" test="@type">Type.</sch:assert></sch:rule></sch:pattern>';
  const OK = [
    [RULE_42, 'BREX-4.2'],
    [NON_CONTEXT_42, 'BREX-4.2'],
    [CONTEXT_42, 'BREX-4.2'],
    [`${RULE_42}${CONTEXT_42}`, 'BREX-4.2'],
    [`<!-- note -->${RULE_42}`, 'BREX-4.2'],
    [RULE_42, 'BREX-4.1'],
    [RULE_301, 'BREX-3.0.1'],
    ['<!-- nonContextRule id="BRDP-X-4": follow the guide -->', 'BREX-3.0.1'],
    [`<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/descript.xsd"><structrules>${RULE_301}</structrules></contextrules>`, 'BREX-3.0.1'],
    [PATTERN_DITA, 'SCH-DITA'],
    ['<pattern><rule context="note"><assert test="@type">T</assert></rule></pattern>', 'SCH-DITA'],
    ['<sch:rule context="note"><sch:assert test="@type">T</sch:assert></sch:rule>', 'SCH-DITA'],
    ['<anything/>', 'FAKE-FORMAT'],
  ];
  for (const [xml, fmt] of OK) check(`rule format ok: ${fmt} ${xml.slice(0, 40)}`, checkRuleFormat(xml, fmt).ok, JSON.stringify(checkRuleFormat(xml, fmt)));
  check('unknown format not checked', checkRuleFormat('<anything/>', 'FAKE-FORMAT').checked === false);

  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  const BAD = [
    ['//&lt;emphasis&gt;', 'BREX-4.2', 'rule_format_missing', 'This is not a BREX 4.2 rule: structureObjectRule is missing', 'Esto no es una regla BREX 4.2: falta structureObjectRule'],
    ['', 'BREX-4.2', 'rule_format_missing', 'This is not a BREX 4.2 rule: structureObjectRule is missing'],
    ['<!-- just a comment -->', 'BREX-4.2', 'rule_format_missing', 'This is not a BREX 4.2 rule: structureObjectRule is missing'],
    [PATTERN_DITA, 'BREX-4.2', 'rule_format_other_format', '<sch:pattern> belongs to a Schematron (DITA) rule, not to a BREX 4.2 rule', '<sch:pattern> es de una regla Schematron (DITA), no de una regla BREX 4.2'],
    [`<rules>${RULE_42}${NON_CONTEXT_42}</rules>`, 'BREX-4.2', 'rule_format_wrapper', '<rules> is not allowed around the rule: write structureObjectRule directly', 'No se admite <rules> como envoltorio de la regla: escribe structureObjectRule directamente'],
    [`<structureObjectRuleGroup>${RULE_42}</structureObjectRuleGroup>`, 'BREX-4.2', 'rule_format_wrapper', '<structureObjectRuleGroup> is not allowed around the rule: write structureObjectRule directly'],
    ['<contextRules rulesContext="x.xsd"><structureObjectRuleGroup/></contextRules>', 'BREX-4.2', 'rule_format_empty_block', '<contextRules> contains no structureObjectRule'],
    ['<dmodule/>', 'BREX-4.2', 'rule_format_foreign', '<dmodule> is not part of a BREX 4.2 rule'],
    [`${RULE_42} extra words`, 'BREX-4.2', 'rule_format_text', 'Loose text outside the rule element is not allowed: “extra words”', 'No se admite texto suelto fuera del elemento de regla: «extra words»'],
    [RULE_42, 'BREX-3.0.1', 'rule_format_other_format', '<structureObjectRule> belongs to a BREX 4.x rule, not to a BREX 3.0.1 rule'],
    [RULE_301, 'BREX-4.2', 'rule_format_other_format', '<objrule> belongs to a BREX 3.0.1 rule, not to a BREX 4.2 rule'],
    [RULE_42, 'SCH-DITA', 'rule_format_other_format', '<structureObjectRule> belongs to a BREX 4.x rule, not to a Schematron (DITA) rule'],
    ['<!-- a plain comment -->', 'BREX-3.0.1', 'rule_format_missing', 'This is not a BREX 3.0.1 rule: objrule is missing'],
    ['//note', 'SCH-DITA', 'rule_format_missing', 'This is not a Schematron (DITA) rule: sch:pattern is missing'],
  ];
  for (const [xml, fmt, code, textEn, textEs] of BAD) {
    const res = checkRuleFormat(xml, fmt);
    check(`rule format bad: ${fmt} ${xml.slice(0, 40)} -> ${code}`, !res.ok && res.problem.code === code, JSON.stringify(res));
    const [issue] = ruleFormatIssues(res);
    check(`  EN text for ${code}`, issue && formatSchemaIssue(issue, en) === textEn, issue && formatSchemaIssue(issue, en));
    if (textEs) check(`  ES text for ${code}`, formatSchemaIssue(issue, es) === textEs, formatSchemaIssue(issue, es));
  }
  check('no issues when the format is right', ruleFormatIssues(checkRuleFormat(RULE_42, 'BREX-4.2')).length === 0);
  check('no issues for null', ruleFormatIssues(null).length === 0);
  // Attribute values holding ">" do not confuse the top-level scan.
  check('attribute value with > inside', checkRuleFormat('<sch:rule context="a[count(b) > 1]"><sch:assert test="x > 1">T</sch:assert></sch:rule>', 'SCH-DITA').ok);
  // Text inside the rule element is not "loose text".
  check('text inside the rule is fine', checkRuleFormat(RULE_42, 'BREX-4.2').ok);
}

check('nothing when not available', nameIssues({ available: false, notFound: [], wrongType: [] }, 'brdp').length === 0);
check('nothing for null', nameIssues(null, 'answer').length === 0);
check('unknown code shows the code', formatSchemaIssue({ source: 'brdp', code: 'mystery', params: {} }, i18n.getFixedT('en')) === 'mystery');
const keys = nameIssues(result, 'brdp', { standard }).map(schemaIssueKey);
check('React keys unique', new Set(keys).size === keys.length);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
