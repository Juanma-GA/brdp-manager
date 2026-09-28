// "Ask: comprobar los nombres de la respuesta" -- plain Node test, no runner
// (same convention as the other scripts/test-*.mjs). Imports the REAL
// module (src/utils/answerNameCheck.js) and the REAL schema vocabularies
// (public/schema-vocabulary-*.json).
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

// Premises of the real report, confirmed against the real vocabularies.
check('3.0.1 has no <identAndStatusSection>', !v301.elements.has('identAndStatusSection'));
check('3.0.1 has <idstatus>', v301.elements.has('idstatus'));
check('3.0.1 has no @ncage', !v301.attributes.has('ncage') && !v301.elements.has('ncage'));
check('4.2 has <identAndStatusSection>', v42.elements.has('identAndStatusSection'));

// 1. The real answer (S1000D 3.0.1, BRDP with @ncage, prompt listed @ncage
//    as nonexistent).
const real = 'ncage es un atributo del elemento `<identAndStatusSection>`, que agrupa los datos de identificación y estado del módulo de datos.';
let r = checkAnswerNames(real, v301, ['@ncage']);
check('real answer: warns <identAndStatusSection> and @ncage', eq(r.notFound, ['<identAndStatusSection>', '@ncage']), JSON.stringify(r));
check('real answer: has warnings', answerNameCheckHasWarnings(r));
// Without the prompt's list, a bare "ncage" is not a name (no evidence).
r = checkAnswerNames(real, v301, []);
check('real answer without prompt list: only <identAndStatusSection>', eq(r.notFound, ['<identAndStatusSection>']), JSON.stringify(r));
// The same answer, marked up.
r = checkAnswerNames('El atributo `@ncage` va dentro de <identAndStatusSection>.', v301, ['@ncage']);
check('marked-up variant: both', eq(r.notFound, ['<identAndStatusSection>', '@ncage']), JSON.stringify(r));

// 2. Correct answers: no warning.
const correct = [
  'No puedo confirmar el nombre del elemento o atributo para el código NCAGE en el esquema de S1000D 3.0.1. Te sugiero buscar "NCAGE" en la especificación S1000D 3.0.1. Ten en cuenta que `@ncage` no existe en este esquema.',
  'I cannot confirm which element holds the NCAGE code in the S1000D 3.0.1 schema; look the concept up in the specification. The @ncage attribute does not exist in 3.0.1.',
  'En S1000D 3.0.1 los datos de identificación van en `<idstatus>`; no uses `<identAndStatusSection>`, que es de 4.x.',
  'Use `<idstatus>` instead of `<identAndStatusSection>`.',
  'El atributo `@frame` de `<table>` admite los valores `all`, `top` y `none`.',
];
for (const text of correct) {
  r = checkAnswerNames(text, text.includes('frame') ? v42 : v301, ['@ncage']);
  check(`correct answer, no warning: ${text.slice(0, 50)}`, !answerNameCheckHasWarnings(r), JSON.stringify(r));
}

// 3. The same element in 4.2 exists: no warning.
r = checkAnswerNames('El código NCAGE se registra en el elemento `<identAndStatusSection>`.', v42, []);
check('4.2 <identAndStatusSection>: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));

// 4. The prompt's nonexistent names: only warned when presented as real.
r = checkAnswerNames('`<pokemon>` no existe en el esquema de S1000D 4.2.', v42, ['<pokemon>']);
check('<pokemon> denied: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));
r = checkAnswerNames('**<pokemon>** is not a valid element in S1000D 4.2.', v42, ['<pokemon>']);
check('<pokemon> "is not a valid" in bold: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));
r = checkAnswerNames('Sí, `<pokemon>` puede ir dentro de `<para>`.', v42, ['<pokemon>']);
check('<pokemon> presented as valid: warning', eq(r.notFound, ['<pokemon>']), JSON.stringify(r));
r = checkAnswerNames('pokemon es un elemento válido dentro de para.', v42, ['<pokemon>']);
check('bare pokemon (prompt list) presented as valid: warning', eq(r.notFound, ['<pokemon>']), JSON.stringify(r));
// Mixed: denied once, then presented as real -> warned.
r = checkAnswerNames('`@ncage` no existe en 3.0.1. Aun así, ncage es un atributo de `<idstatus>`.', v301, ['@ncage']);
check('denied then asserted: warning', eq(r.notFound, ['@ncage']), JSON.stringify(r));
// Other capitalisation is the concept, not the name.
r = checkAnswerNames('El código NCAGE identifica a la empresa responsable.', v301, ['@ncage']);
check('NCAGE concept: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));

// 5. Wrong kind.
r = checkAnswerNames('Usa el elemento `<label>` para la etiqueta.', v42, []);
check('<label> as element (4.2 attribute only): wrongType', eq(r.wrongType, [{ name: 'label', usedAs: 'element', actualAs: 'attribute' }]) && r.notFound.length === 0, JSON.stringify(r));

// 6. Names in code: only with an element/attribute word next to them.
check('`ncage` next to "atributo": attribute', eq(extractAnswerNames('el atributo `ncage` del módulo').attributes, ['ncage']));
check('`ncage` then "attribute": attribute', eq(extractAnswerNames('the `ncage` attribute').attributes, ['ncage']));
check('`em01` (a value) is not a name', eq(extractAnswerNames('usa el valor `em01`'), { elements: [], attributes: [], camelCase: [] }));
r = checkAnswerNames('El atributo `ncage` va en `<idstatus>`.', v301, []);
check('code name with kind word: warned', eq(r.notFound, ['@ncage']), JSON.stringify(r));

// 7. camelCase in prose: the existing extractor's rule.
r = checkAnswerNames('En 3.0.1 se usa identAndStatusSection para esto.', v301, []);
check('camelCase 4.x name in 3.0.1: warned bare', eq(r.notFound, ['identAndStatusSection']), JSON.stringify(r));

// 8. Prefixed names are never schema vocabulary.
r = checkAnswerNames('Usa `@xlink:href` o `<xsl:template>` para ello.', v42, []);
check('prefixed names skipped', !answerNameCheckHasWarnings(r), JSON.stringify(r));

// 9. Code blocks in the answer are checked too (an XML example).
r = checkAnswerNames('Ejemplo:\n\n```xml\n<idstatus>\n  <ncage>1234A</ncage>\n</idstatus>\n```', v301, ['@ncage']);
check('XML example with <ncage>: warned (as element) and not also as the bare prompt name', eq(r.notFound, ['<ncage>']), JSON.stringify(r));

// 10. DITA and no vocabulary.
r = checkAnswerNames('`<note>` admite el atributo `@type`.', vDita, []);
check('DITA valid names: no warning', !answerNameCheckHasWarnings(r), JSON.stringify(r));
r = checkAnswerNames('`<pokemon>` va aquí.', null, ['<pokemon>']);
check('no vocabulary: not available, no warning', r.available === false && !answerNameCheckHasWarnings(r));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
