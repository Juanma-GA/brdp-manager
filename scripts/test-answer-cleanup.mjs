// Tests for src/utils/answerCleanup.js (Barrido final 1/2, Part 3): the
// internal name of the schema cards block never reaches the user. Plain
// Node, the real module. Run: node scripts/test-answer-cleanup.mjs
import { answerLanguage, cleanInternalNames } from '../src/utils/answerCleanup.js';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (actual === expected) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`);
  }
}

// The two real patterns (ask-open-question-no-disclaimer, Mistral, c8e8fac).
check('real 1: "según los **SCHEMA FACTS**:"',
  cleanInternalNames('El elemento <para> puede contener, según los **SCHEMA FACTS**:\n- <emphasis>\n- <randomList>'),
  'El elemento <para> puede contener, según las fichas del esquema:\n- <emphasis>\n- <randomList>');
check('real 2: "la tarjeta de esquema proporcionada (SCHEMA FACTS)"',
  cleanInternalNames('Según la tarjeta de esquema proporcionada (SCHEMA FACTS), <warning> va dentro de <proceduralStep>.'),
  'Según la tarjeta de esquema proporcionada, <warning> va dentro de <proceduralStep>.');

// Spanish forms.
check('es: "de los SCHEMA FACTS" → "de las fichas del esquema"', cleanInternalNames('Es la lista de los SCHEMA FACTS para este elemento.'), 'Es la lista de las fichas del esquema para este elemento.');
check('es: "en los SCHEMA FACTS" → "en las fichas del esquema"', cleanInternalNames('No aparece en los SCHEMA FACTS de este proyecto.'), 'No aparece en las fichas del esquema de este proyecto.');
check('es: "del SCHEMA FACTS" → "del esquema"', cleanInternalNames('Es un dato del SCHEMA FACTS.'), 'Es un dato del esquema.');
check('es: "el SCHEMA FACTS" → "el esquema"', cleanInternalNames('Como indica el SCHEMA FACTS, es opcional.'), 'Como indica el esquema, es opcional.');
check('es: "del bloque SCHEMA FACTS"', cleanInternalNames('Los datos del bloque SCHEMA FACTS indican que puede ir dentro de <para>.'), 'Los datos del esquema indican que puede ir dentro de <para>.');
check('es: name alone, mid-sentence', cleanInternalNames('Según SCHEMA FACTS, el atributo es opcional.'), 'Según el esquema, el atributo es opcional.');
check('es: name alone at the start', cleanInternalNames('SCHEMA FACTS indica que el atributo es opcional.'), 'El esquema indica que el atributo es opcional.');
check('es: italics, "Los" capitalised, plural verb still agrees', cleanInternalNames('Los *SCHEMA FACTS* lo confirman: va dentro de <para>.'), 'Las fichas del esquema lo confirman: va dentro de <para>.');
check('es: parenthesis with bold', cleanInternalNames('la ficha (**SCHEMA FACTS**) lo confirma'), 'la ficha lo confirma');
// English forms.
check('en: "according to the SCHEMA FACTS block"', cleanInternalNames('According to the SCHEMA FACTS block, <para> can contain <emphasis>.'), 'According to the schema, <para> can contain <emphasis>.');
check('en: name alone at the start', cleanInternalNames('SCHEMA FACTS lists 43 parents of the element.'), 'The schema lists 43 parents of the element.');
check('en: bold, mid-sentence', cleanInternalNames('As shown in **SCHEMA FACTS**, the attribute is optional.'), 'As shown in the schema, the attribute is optional.');
check('en: parenthesis', cleanInternalNames('The schema card (SCHEMA FACTS) shows it.'), 'The schema card shows it.');

// Never touched.
check('no internal name: unchanged', cleanInternalNames('El elemento <para> puede ir dentro de <levelledPara>.'), 'El elemento <para> puede ir dentro de <levelledPara>.');
check('inline code: unchanged', cleanInternalNames('El bloque se llama `SCHEMA FACTS` en el prompt.'), 'El bloque se llama `SCHEMA FACTS` en el prompt.');
check('fenced code block: unchanged, the prose after it cleaned',
  cleanInternalNames('```\nSCHEMA FACTS — extracted from\n```\nVer los SCHEMA FACTS.'),
  '```\nSCHEMA FACTS — extracted from\n```\nVer las fichas del esquema.');
check('quotation: unchanged', cleanInternalNames('Preguntas por "SCHEMA FACTS"; según los SCHEMA FACTS, sí.'), 'Preguntas por "SCHEMA FACTS"; según las fichas del esquema, sí.');
check('typographic quotation: unchanged', cleanInternalNames('La frase “según los SCHEMA FACTS” no se toca.'), 'La frase “según los SCHEMA FACTS” no se toca.');
check('blockquote line: unchanged', cleanInternalNames('> ¿Qué son los SCHEMA FACTS?\nNo es un término del estándar.'), '> ¿Qué son los SCHEMA FACTS?\nNo es un término del estándar.');
check('the user asked with that name: nothing touched', cleanInternalNames('Los SCHEMA FACTS son el bloque de fichas.', { userText: '¿Qué son los schema facts?' }), 'Los SCHEMA FACTS son el bloque de fichas.');
check('ellipsis and other spacing kept as written', cleanInternalNames('Según el SCHEMA FACTS ... y más.'), 'Según el esquema ... y más.');
check('null / empty', cleanInternalNames(null), '');

check('language: Spanish', answerLanguage('Según los SCHEMA FACTS, el elemento puede ir dentro de otro.'), 'es');
check('language: English', answerLanguage('According to SCHEMA FACTS, the element can go inside another.'), 'en');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
