// Consolidation C1, Part 1: the message layer of the one schema-validation
// service (src/validation/schemaValidation.js). Every finding is
// { source, code, params }; formatSchemaIssue must give, in EN and ES, the
// exact text each panel produced with its own t() call before the
// consolidation. Plain Node, the real module and the real i18n.
// Run: node scripts/test-schema-validation.mjs
import i18n from '../src/i18n/index.js';
import {
  SCHEMA_ISSUE_KEYS,
  formatSchemaIssue,
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
      check(`${lang} ${source}.${code} translated`, t(key, { standard, names: 'x', name: 'x', expression: 'x', element: 'x', parent: 'y', attribute: 'z', expected: 'w', schema: 's' }) !== key);
    }
  }
}
check('nothing when not available', nameIssues({ available: false, notFound: [], wrongType: [] }, 'brdp').length === 0);
check('nothing for null', nameIssues(null, 'answer').length === 0);
check('unknown code shows the code', formatSchemaIssue({ source: 'brdp', code: 'mystery', params: {} }, i18n.getFixedT('en')) === 'mystery');
const keys = nameIssues(result, 'brdp', { standard }).map(schemaIssueKey);
check('React keys unique', new Set(keys).size === keys.length);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
