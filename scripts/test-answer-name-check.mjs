// "Ask: comprobar los nombres de la respuesta" -- plain Node test, no runner
// (same convention as the other scripts/test-*.mjs). Imports the REAL
// module (src/utils/answerNameCheck.js) and the REAL schema vocabularies
// (public/schema-vocabulary-*.json).
//
// "Aviso de nombres sin heurísticas" round: no sentence interpretation any
// more -- names the BRDP's own notice already reports are left out, every
// other name is checked as written.
//
//   node scripts/test-answer-name-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerNameCheckHasWarnings, checkAnswerNames, extractAnswerNames } from '../src/utils/answerNameCheck.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) passes += 1;
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function vocab(file) {
  const json = JSON.parse(fs.readFileSync(path.join(root, 'public', file), 'utf8'));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
}
const v301 = vocab('schema-vocabulary-3-0-1.json');
const v42 = vocab('schema-vocabulary-4-2.json');
const vDita = vocab('schema-vocabulary-dita.json');

// The BRDP of ask-concept-without-facts-3-0-1: its own notice reports @ncage.
const ncageBrdp = { notFound: ['@ncage'], wrongType: [] };

// Premises, confirmed against the real vocabularies.
check('3.0.1 has no <identAndStatusSection>', !v301.elements.has('identAndStatusSection'));
check('3.0.1 has <idstatus>', v301.elements.has('idstatus'));
check('3.0.1 has no @ncage', !v301.attributes.has('ncage') && !v301.elements.has('ncage'));
check('4.2 has <identAndStatusSection>', v42.elements.has('identAndStatusSection'));

// 1. The three correct answers of ask-concept-without-facts-3-0-1 in the
//    real run against Mistral (shape as reported: @ncage in bold with "does
//    not exist", and "does not contain ... including @ncage"; the user
//    reported them, their full text is not in this repository). None warns.
const correctRealRun = [
  'The attribute **@ncage** does not exist in the S1000D 3.0.1 schema, so I cannot confirm which element holds the NCAGE code. Look up the NCAGE concept in the S1000D 3.0.1 specification.',
  'The SCHEMA FACTS for S1000D 3.0.1 do not contain any element or attribute for the NCAGE code, including @ncage, which this BRDP mentions. I cannot confirm the name in this standard\'s schema; please check the S1000D 3.0.1 specification for where the NCAGE code is recorded.',
  'I cannot confirm the element or attribute name for the NCAGE code in the S1000D 3.0.1 schema. Note that `@ncage` is not a valid attribute there — look up "NCAGE" in the S1000D 3.0.1 specification.',
];
for (const text of correctRealRun) {
  const r = checkAnswerNames(text, v301, ncageBrdp);
  check(`correct answer, no warning: ${text.slice(0, 60)}`, !answerNameCheckHasWarnings(r), JSON.stringify(r));
}

// 2. The original wrong answer: warns <identAndStatusSection>; @ncage is
//    left out (the BRDP's notice already reports it).
const wrong = 'ncage es un atributo del elemento `<identAndStatusSection>`, que agrupa los datos de identificación y estado del módulo de datos.';
let r = checkAnswerNames(wrong, v301, ncageBrdp);
check('original wrong answer: warns <identAndStatusSection> only', eq(r.notFound, ['<identAndStatusSection>']) && r.wrongType.length === 0, JSON.stringify(r));
r = checkAnswerNames('El atributo `@ncage` va dentro de <identAndStatusSection>.', v301, ncageBrdp);
check('@ncage marked up in the answer: still left out', eq(r.notFound, ['<identAndStatusSection>']), JSON.stringify(r));
// Without the BRDP's list, a marked-up @ncage is checked like any name.
r = checkAnswerNames('El atributo `@ncage` va dentro de <idstatus>.', v301, null);
check('no BRDP list: marked-up @ncage warns', eq(r.notFound, ['@ncage']), JSON.stringify(r));
// Bare, unmarked words are never names (no bare matching any more).
r = checkAnswerNames('ncage es un atributo del código NCAGE.', v301, null);
check('bare "ncage" without markup: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));

// 3. No sentence interpretation: a 4.x name in 3.0.1 warns even when the
//    sentence advises against it (the warning text is neutral).
r = checkAnswerNames('Use `<idstatus>` instead of `<identAndStatusSection>`.', v301, ncageBrdp);
check('"instead of" is not interpreted: <identAndStatusSection> warns', eq(r.notFound, ['<identAndStatusSection>']), JSON.stringify(r));

// 4. A correct answer with valid names only; the same element in 4.2.
r = checkAnswerNames('En S1000D 3.0.1 los datos de identificación van en `<idstatus>`, dentro de `<dmodule>`.', v301, ncageBrdp);
check('valid 3.0.1 names: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));
r = checkAnswerNames(wrong, v42, null);
check('4.2: <identAndStatusSection> exists, no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));

// 5. Wrong kind, and the BRDP's own wrongType names left out.
r = checkAnswerNames('Usa el elemento `<label>` para la etiqueta.', v42, null);
check('<label> as element (4.2 attribute only): wrongType', eq(r.wrongType, [{ name: 'label', usedAs: 'element', actualAs: 'attribute' }]) && r.notFound.length === 0, JSON.stringify(r));
r = checkAnswerNames('Usa el elemento `<label>` para la etiqueta.', v42, { notFound: [], wrongType: [{ name: 'label', usedAs: 'element', actualAs: 'attribute' }] });
check('<label> already in the BRDP notice as wrongType: left out', !answerNameCheckHasWarnings(r), JSON.stringify(r));
r = checkAnswerNames('`<pokemon>` puede ir dentro de `<para>`.', v42, { notFound: ['<pokemon>'], wrongType: [] });
check('<pokemon> already in the BRDP notice: left out', !answerNameCheckHasWarnings(r), JSON.stringify(r));

// 6. Names in code: only with an element/attribute word next to them.
check('`ncage` next to "atributo": attribute', eq(extractAnswerNames('el atributo `ncage` del módulo').attributes, ['ncage']));
check('`ncage` then "attribute": attribute', eq(extractAnswerNames('the `ncage` attribute').attributes, ['ncage']));
check('`em01` (a value) is not a name', eq(extractAnswerNames('usa el valor `em01`'), { elements: [], attributes: [], camelCase: [] }));

// 7. camelCase in prose: the existing extractor's rule.
r = checkAnswerNames('En 3.0.1 se usa identAndStatusSection para esto.', v301, null);
check('camelCase 4.x name in 3.0.1: warned bare', eq(r.notFound, ['identAndStatusSection']), JSON.stringify(r));

// 8. Prefixed names are never schema vocabulary.
r = checkAnswerNames('Usa `@xlink:href` o `<xsl:template>` para ello.', v42, null);
check('prefixed names skipped', !answerNameCheckHasWarnings(r), JSON.stringify(r));

// 9. Code blocks in the answer are checked too (an XML example).
r = checkAnswerNames('Ejemplo:\n\n```xml\n<idstatus>\n  <ncage>1234A</ncage>\n</idstatus>\n```', v301, null);
check('XML example with <ncage>: warned', eq(r.notFound, ['<ncage>']), JSON.stringify(r));

// 10. DITA and no vocabulary.
r = checkAnswerNames('`<note>` admite el atributo `@type`.', vDita, null);
check('DITA valid names: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));
r = checkAnswerNames('`<pokemon>` va aquí.', null, null);
check('no vocabulary: not available, no warning', r.available === false && !answerNameCheckHasWarnings(r));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
