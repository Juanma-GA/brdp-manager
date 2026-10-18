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
  // Mejoras B, Part 4.3: the copy in the context block has its own id
  // (a rule id is xs:ID; wrapRuleInSchemaContexts writes {id}-{schema}).
  const CONTEXT_42 = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"><structureObjectRuleGroup>${RULE_42.replace('BRDP-X-1', 'BRDP-X-1-proced')}</structureObjectRuleGroup></contextRules>`;
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

// ─── Mejoras A, Part 3: one objectPath / objectUse per rule element ─────────
{
  const { checkRuleFormat: crf } = await import('../src/validation/schemaValidation.js');
  const { splitMultiPathRules, multiplePathOrUse, splitApprovedRulesMultiPath } = await import('../src/utils/ruleSplit.js');
  const { analyzeRule } = await import('../src/utils/ruleTestEngine.js');
  const { formatRuleTestReason } = await import('../src/utils/ruleTestReasons.js');
  const { lintRule } = await import('./lib/ruleLint.mjs');
  const { DOMParser } = await import('@xmldom/xmldom');
  const parseXml = (text) => new DOMParser().parseFromString(text, 'text/xml');
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  const R186 = `<structureObjectRule id="BRDP-S1-00186" brSeverityLevel="brsl01">
  <brDecisionRef brDecisionIdentNumber="BRDP-S1-00186"/>
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) &gt; 4]</objectPath>
  <objectUse>There will be a maximum of five levels.</objectUse>
  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) = 4]/title</objectPath>
  <objectUse>The fifth level must not have a title.</objectUse>
</structureObjectRule>`;
  const f = crf(R186, 'BREX-4.2');
  check('two objectPath: format error rule_format_multiple', !f.ok && f.problem.code === 'rule_format_multiple' && f.problem.params.count === 2 && f.problem.params.child === 'objectPath', JSON.stringify(f.problem));
  const issue = ruleFormatIssues(f)[0];
  check('two objectPath: text EN', formatSchemaIssue(issue, en) === 'A <structureObjectRule> can only have one <objectPath>; this one has 2', formatSchemaIssue(issue, en));
  check('two objectPath: text ES', formatSchemaIssue(issue, es) === 'Una <structureObjectRule> solo puede tener un <objectPath>; esta tiene 2', formatSchemaIssue(issue, es));
  const oneUse = '<structureObjectRule><objectPath allowedObjectFlag="0">//a</objectPath><objectPath allowedObjectFlag="0">//b</objectPath><objectUse>u</objectUse></structureObjectRule>';
  check('two objectPath, one objectUse: format error', crf(oneUse, 'BREX-4.2').problem?.code === 'rule_format_multiple');
  check('two objectUse: format error on objectUse', crf('<structureObjectRule><objectPath allowedObjectFlag="0">//a</objectPath><objectUse>u</objectUse><objectUse>v</objectUse></structureObjectRule>', 'BREX-4.2').problem?.params.child === 'objectUse');
  check('one objectPath: fine', crf('<structureObjectRule><objectPath allowedObjectFlag="0">//a</objectPath><objectUse>u</objectUse></structureObjectRule>', 'BREX-4.2').ok);
  check('Schematron with several asserts: fine', crf('<sch:pattern xmlns:sch="x"><sch:rule context="note"><sch:assert test="@type">a</sch:assert><sch:assert test="p">b</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA').ok);

  // The mechanical split.
  const split = splitMultiPathRules(R186, 'BREX-4.2');
  check('split: 2 rules', split.total === 2 && (split.xml.match(/<structureObjectRule\b/g) || []).length === 2, split.xml);
  check('split: ids {id}-1, {id}-2', /id="BRDP-S1-00186-1"/.test(split.xml) && /id="BRDP-S1-00186-2"/.test(split.xml));
  check('split: brSeverityLevel and brDecisionRef kept in both', (split.xml.match(/brSeverityLevel="brsl01"/g) || []).length === 2 && (split.xml.match(/brDecisionIdentNumber="BRDP-S1-00186"/g) || []).length === 2);
  check('split: each objectUse with its path', /&gt; 4\]<\/objectPath>\s*<objectUse>There will be a maximum of five levels\.<\/objectUse>\s*<\/structureObjectRule>/.test(split.xml) && /\/title<\/objectPath>\s*<objectUse>The fifth level must not have a title\.<\/objectUse>/.test(split.xml));
  check('split: valid format after', crf(split.xml, 'BREX-4.2').ok && multiplePathOrUse(split.xml, 'BREX-4.2') === null);
  const withValues = '<structureObjectRule id="R"><objectPath allowedObjectFlag="2">//@a</objectPath><objectUse>u</objectUse><objectValue valueForm="single" valueAllowed="x"/><objectPath allowedObjectFlag="2">//@b</objectPath><objectUse>v</objectUse><objectValue valueForm="single" valueAllowed="y"/><objectValue valueForm="single" valueAllowed="z"/></structureObjectRule>';
  const sv = splitMultiPathRules(withValues, 'BREX-4.2').xml;
  check('split: each objectValue stays with its path', /\/\/@a<\/objectPath><objectUse>u<\/objectUse><objectValue valueForm="single" valueAllowed="x"\/><\/structureObjectRule>/.test(sv) && /\/\/@b<\/objectPath><objectUse>v<\/objectUse><objectValue valueForm="single" valueAllowed="y"\/><objectValue valueForm="single" valueAllowed="z"\/><\/structureObjectRule>/.test(sv), sv);
  check('split: two paths and one use is not mechanical', splitMultiPathRules(oneUse, 'BREX-4.2').total === 0);
  const clash = `${R186}\n<structureObjectRule id="BRDP-S1-00186-1"><objectPath allowedObjectFlag="0">//c</objectPath><objectUse>w</objectUse></structureObjectRule>`;
  const sc = splitMultiPathRules(clash, 'BREX-4.2').xml;
  const ids = [...sc.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  check('split: ids never clash with others in the response', new Set(ids).size === ids.length && ids.includes('BRDP-S1-00186-2') && ids.includes('BRDP-S1-00186-3'), JSON.stringify(ids));
  const r301 = '<objrule id="R1"><objpath objappl="0">//a</objpath><objuse>u</objuse><objval valtype="single" val1="x"/><objpath objappl="0">//b</objpath><objuse>v</objuse></objrule>';
  const s301 = splitMultiPathRules(r301, 'BREX-3.0.1');
  check('3.0.1: two objpath split into two objrule', s301.total === 2 && crf(s301.xml, 'BREX-3.0.1').ok && /id="R1-1"[\s\S]*val1="x"[\s\S]*id="R1-2"/.test(s301.xml), s301.xml);
  check('3.0.1: two objpath is a format error', crf(r301, 'BREX-3.0.1').problem?.code === 'rule_format_multiple');
  const inBlock = `<contextRules rulesContext="x.xsd"><structureObjectRuleGroup>${R186}</structureObjectRuleGroup></contextRules>`;
  const sb = splitMultiPathRules(inBlock, 'BREX-4.2');
  check('split inside a context block', sb.total === 2 && crf(sb.xml, 'BREX-4.2').ok && sb.xml.startsWith('<contextRules rulesContext="x.xsd"><structureObjectRuleGroup>'));
  check('split: Schematron untouched', splitMultiPathRules('<sch:pattern/>', 'SCH-DITA').total === 0);

  // Mejoras B, Part 4.3: duplicate rule ids (xs:ID).
  const dupIds = '<structureObjectRule id="R"><objectPath allowedObjectFlag="0">//a</objectPath><objectUse>u</objectUse></structureObjectRule>\n<structureObjectRule id="R"><objectPath allowedObjectFlag="0">//b</objectPath><objectUse>v</objectUse></structureObjectRule>';
  const fd = crf(dupIds, 'BREX-4.2');
  check('duplicate ids: format error', fd.problem?.code === 'rule_format_duplicate_ids' && fd.problem.params.ids === 'R', JSON.stringify(fd));
  check('duplicate ids: text EN/ES', formatSchemaIssue(ruleFormatIssues(fd)[0], en) === 'Several <structureObjectRule> have the same id (R); each rule needs its own id' && formatSchemaIssue(ruleFormatIssues(fd)[0], es) === 'Varias <structureObjectRule> tienen el mismo id (R); cada regla necesita su propio id');
  check('duplicate ids 3.0.1', crf('<objrule id="R"><objpath objappl="0">//a</objpath><objuse>u</objuse></objrule><objrule id="R"><objpath objappl="0">//b</objpath><objuse>v</objuse></objrule>', 'BREX-3.0.1').problem?.code === 'rule_format_duplicate_ids');
  check('duplicate ids: two objectPath come first', crf(`${R186}${R186}`, 'BREX-4.2').problem?.code === 'rule_format_multiple');
  const { numberDuplicateRuleIds, numberApprovedRulesDuplicateIds } = await import('../src/utils/ruleSplit.js');
  const nd = numberDuplicateRuleIds(dupIds, 'BREX-4.2');
  check('number ids: R-1, R-2 and valid', /id="R-1"[\s\S]*id="R-2"/.test(nd.xml) && crf(nd.xml, 'BREX-4.2').ok && JSON.stringify(nd.renamed) === '[{"id":"R","to":["R-1","R-2"]}]', JSON.stringify(nd));
  const used = `${dupIds}<structureObjectRule id="R-1"><objectPath allowedObjectFlag="0">//c</objectPath><objectUse>w</objectUse></structureObjectRule>`;
  const nu = numberDuplicateRuleIds(used, 'BREX-4.2');
  check('number ids: next free when {id}-n is used', JSON.stringify(nu.renamed[0].to) === '["R-2","R-3"]' && crf(nu.xml, 'BREX-4.2').ok, JSON.stringify(nu.renamed));
  check('number ids: single rule unchanged', numberDuplicateRuleIds('<structureObjectRule id="R"><objectPath>//a</objectPath><objectUse>u</objectUse></structureObjectRule>', 'BREX-4.2').renamed.length === 0);
  // split first, then number: two objectPath in two rules with the same id
  const both = `${R186}\n${R186}`;
  const bothFixed = numberDuplicateRuleIds(splitMultiPathRules(both, 'BREX-4.2').xml, 'BREX-4.2').xml;
  check('split then number: 4 rules, all ids different, valid', (bothFixed.match(/<structureObjectRule\b/g) || []).length === 4 && new Set([...bothFixed.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).size === 4 && crf(bothFixed, 'BREX-4.2').ok, bothFixed);
  const gd = numberApprovedRulesDuplicateIds([{ identifier: 'A', xml: dupIds }, { identifier: 'B', xml: '<structureObjectRule id="Z"><objectPath>//a</objectPath><objectUse>u</objectUse></structureObjectRule>' }, { identifier: 'C', xml: '<structureObjectRule id="Z"><objectPath>//b</objectPath><objectUse>u</objectUse></structureObjectRule>' }], 'BREX-4.2');
  check('Generate: within a BRDP numbered, across BRDPs reported', JSON.stringify(gd.duplicateIds) === '{"numbered":[{"identifier":"A","ids":["R"]}],"clashes":[{"id":"Z","identifiers":["B","C"]}]}', JSON.stringify(gd.duplicateIds));
  check('analyzeRule: duplicate ids still executable', analyzeRule(dupIds, 'BREX-4.2', { parseXml }).status === 'executable');

  // The rule test and the lint never read only the first path.
  const a = analyzeRule(R186, 'BREX-4.2', { parseXml });
  check('analyzeRule: not executable with the format reason', a.status === 'not_executable' && a.reason.code === 'rule_format' && a.reason.params.problem === 'rule_format_multiple', JSON.stringify(a.reason));
  check('analyzeRule: reason text EN', formatRuleTestReason(a.reason, en).includes('A <structureObjectRule> can only have one <objectPath>; this one has 2'), formatRuleTestReason(a.reason, en));
  const lint = lintRule(R186, 'BREX-4.2');
  check('lint: "more than one objectPath in a rule"', lint.some((x) => x.kind === 'more than one objectPath in a rule'), JSON.stringify(lint));
  check('lint: never "not a rule of the format" for it', !lint.some((x) => x.kind === 'not a rule of the format'));
  const lintDepth = lintRule('<structureObjectRule id="R"><objectPath allowedObjectFlag="0">//a</objectPath><objectUse>u</objectUse><objectPath allowedObjectFlag="0">//b[count(ancestor::*) &gt; 3]</objectPath><objectUse>v</objectUse></structureObjectRule>', 'BREX-4.2');
  check('lint: reads the second path too (count(ancestor::*))', lintDepth.some((x) => x.kind === 'count(ancestor::*) as depth'), JSON.stringify(lintDepth));

  // Generate: the output is split, a rule that cannot be split is reported.
  const g = splitApprovedRulesMultiPath([{ identifier: 'BRDP-S1-00186', xml: R186 }, { identifier: 'BRDP-X', xml: oneUse }], 'BREX-4.2');
  check('Generate: split reported', JSON.stringify(g.multiPath.split) === '[{"identifier":"BRDP-S1-00186","count":2}]');
  check('Generate: not mechanical reported as invalid', g.multiPath.invalid.length === 1 && g.multiPath.invalid[0].identifier === 'BRDP-X' && g.multiPath.invalid[0].count === 2);
  check('Generate: texts EN/ES', en('generate.multiPathSplit', { count: 1 }).startsWith('1 rule with more than one objectPath was split') && es('generate.multiPathInvalid', { count: 2 }).startsWith('2 reglas tienen más de un objectPath'));
  check('Suggest/Paste note: texts EN/ES', en('records.assistant.ruleSplit', { count: 2, path: 'objectPath' }) === 'The app split the rule into 2 rules (one per <objectPath>).' && es('records.assistant.ruleSplit', { count: 2, path: 'objectPath' }) === 'La app ha partido la regla en 2 reglas (una por <objectPath>).');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
