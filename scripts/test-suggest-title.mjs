// Tests for Suggest Title (src/prompts/suggestTitlePrompt.js and the name
// check it shares with the other suggestions): how the AI's answer is read
// before it is offered, and what the prompt carries. Plain Node, the real
// modules. Run: node scripts/test-suggest-title.mjs
import i18n from '../src/i18n/index.js';
import { buildSuggestTitlePrompt, readSuggestedTitle, sameTitle, SUGGESTED_TITLE_MAX_CHARS } from '../src/prompts/suggestTitlePrompt.js';
import { checkAgainstVocabulary, extractContextCandidates, formatSchemaIssue, nameIssues } from '../src/validation/schemaValidation.js';
import { readTextFile } from './lib/textFile.mjs';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`);
  }
}

// ── Reading the answer ──────────────────────────────────────────────────
check('one line kept', readSuggestedTitle('Definir el orden de los elementos hijos de <avee>'), { title: 'Definir el orden de los elementos hijos de <avee>' });
check('surrounding spaces and final full stop removed', readSuggestedTitle('  Decide whether <randomList> is allowed inside <step>.  \n'), { title: 'Decide whether <randomList> is allowed inside <step>' });
check('quotes around the whole answer removed', readSuggestedTitle('"Formato permitido para @assyCode"'), { title: 'Formato permitido para @assyCode' });
check('guillemets removed', readSuggestedTitle('«Decidir si se usa <randomList>»'), { title: 'Decidir si se usa <randomList>' });
check('a "Title:" label removed', readSuggestedTitle('Title: Decide on the attribute @frame for the element <table>'), { title: 'Decide on the attribute @frame for the element <table>' });
check('a code fence removed', readSuggestedTitle('```\nDecidir si se usa <randomList>\n```'), { title: 'Decidir si se usa <randomList>' });
check('several lines are not offered', readSuggestedTitle('Definir el orden de los hijos de <avee>\nEste título describe la decisión.').problem, 'multiline');
check('empty answer', readSuggestedTitle('   ').problem, 'empty');
check('too long', readSuggestedTitle('x'.repeat(SUGGESTED_TITLE_MAX_CHARS + 1)).problem, 'too_long');
check('the reference prefix stays (nothing strips it)', readSuggestedTitle('(SOPTE BREX 3.9.5.2.1.9-2.2) Decidir sobre el atributo @frame para el elemento <table>').title,
  '(SOPTE BREX 3.9.5.2.1.9-2.2) Decidir sobre el atributo @frame para el elemento <table>');

// ── Same Title: "already follows the criterion" ─────────────────────────
check('same title', sameTitle('Decidir si se usa <randomList>', 'Decidir si se usa <randomList>'), true);
check('same title, spaces differ', sameTitle('Decidir  si se usa <randomList> ', 'Decidir si se usa <randomList>'), true);
check('different title', sameTitle('Decidir si se usa <randomList>', 'Prohibir randomList'), false);

// ── Name check (same as the other suggestions) ──────────────────────────
const raw301 = JSON.parse(readTextFile(new URL('../public/schema-vocabulary-3-0-1.json', import.meta.url)));
const vocab301 = { elements: new Set(raw301.elements), attributes: new Set(raw301.attributes) };
const issuesOf = (title) => nameIssues(checkAgainstVocabulary(extractContextCandidates(title), vocab301), 'title', { standard: 'S1000D 3.0.1' });
check('<avee> exists in 3.0.1: no issue', issuesOf('Definir el orden de los elementos hijos de <avee>'), []);
const pokemon = issuesOf('Decidir sobre el atributo @apsname para el elemento <pokemon>');
check('<pokemon> does not exist: one issue', pokemon.map((i) => i.code), ['names_not_found']);
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
check('issue text EN', formatSchemaIssue(pokemon[0], en), 'The suggested Title uses names not found in the S1000D 3.0.1 schema: <pokemon>');
check('issue text ES', formatSchemaIssue(pokemon[0], es), 'El Título sugerido usa nombres no encontrados en el esquema de S1000D 3.0.1: <pokemon>');
const wrong = issuesOf('Decidir sobre el elemento <apsname>');
check('<apsname> is an attribute: wrong type', wrong.map((i) => i.code), ['wrong_type_as_element']);

// ── Prompt ──────────────────────────────────────────────────────────────
const brdp = {
  identifier: 'BRDP-EXT-02610',
  title: 'Prohibir avee con orden de hijos incorrecto',
  definition: 'Orden de los hijos de avee.',
  proposal: '',
};
const rule = '<objrule id="R1"><objpath objappl="0">//avee</objpath></objrule>';
const prompt = buildSuggestTitlePrompt(brdp, 'S1000D 3.0.1', {
  similar: [{ identifier: 'BRDP-EXT-1', title: 'Decidir si se usa <randomList>', source_type: 'records', source_project: 'P' }],
  ruleXml: rule,
});
check('prompt: current title quoted for the language', prompt.includes('("Prohibir avee con orden de hijos incorrecto")'), true);
check('prompt: the rule is given', prompt.includes(`Rule:\n${rule}`), true);
check('prompt: NAMES mentions the rule', prompt.includes('appear in the BRDP itself (Title, Definition, Proposal) or its Rule.'), true);
check('prompt: other titles as style only', prompt.includes('[BRDP-EXT-1 | Records: P] Decidir si se usa <randomList>'), true);
check('prompt: keep the reference prefix', prompt.includes('keep it exactly as it is, at the'), true);
check('prompt: empty Proposal said', prompt.includes('Proposal: empty'), true);
const noRule = buildSuggestTitlePrompt(brdp, 'S1000D 3.0.1');
check('prompt without rule: no Rule line', /\nRule:\n/.test(noRule), false);
check('prompt without references: no titles block', noRule.includes('TITLES OF OTHER DECISION POINTS'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
