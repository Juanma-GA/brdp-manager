// Consolidation C1, Part 2: Ask's deterministic answers to structural
// questions (src/utils/structuralAnswer.js) -- detection (phrases that must
// match and phrases that must not, in Spanish and English) and the answers
// built from the REAL full schema cards and attribute owners
// (scripts/rule-test-fixtures/structural-answers.json, dumped by
// backend/scripts/dump_structural_answer_fixture.py) with the real
// vocabularies. Plain Node, no server.
// Run: node scripts/test-structural-answer.mjs
import fs from 'node:fs';
import { answerStructuralQuestion, detectStructuralQuestion } from '../src/utils/structuralAnswer.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
const vocabOf = (file) => {
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const V42 = vocabOf('schema-vocabulary-4-2.json');
const V301 = vocabOf('schema-vocabulary-3-0-1.json');
const VDITA = vocabOf('schema-vocabulary-dita.json');
const FIX = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structural-answers.json', import.meta.url)));

let calls = [];
const io = (standard) => ({
  fetchCards: async (std, names, opts) => {
    calls.push(['cards', names.join(','), opts?.full]);
    const all = FIX.cards[std] || {};
    return { available: true, cards: Object.fromEntries(names.filter((n) => all[n]).map((n) => [n, all[n]])) };
  },
  fetchAttribute: async (std, name) => {
    calls.push(['attribute', name]);
    return { available: true, owners: FIX.attributes[std]?.[name] || [] };
  },
  fetchRelation: async (std, parent, child) => {
    calls.push(['relation', `${parent}/${child}`]);
    const data = FIX.relations[std]?.[`${parent}/${child}`];
    if (!data) throw new Error(`no fixture for ${std} ${parent}/${child}`);
    return data;
  },
  standard,
});
async function answer(question, standard, vocabulary) {
  calls = [];
  const r = await answerStructuralQuestion({ question, vocabulary, ...io(standard) });
  return r;
}
const det = (q, v = V42) => detectStructuralQuestion(q, v);

// ─── Detection: phrases that must match ─────────────────────────────────────
const MATCH = [
  ['¿Qué puede contener <identAndStatusSection>?', 'children', 'es', 'identAndStatusSection'],
  ['¿Qué hijos tiene <para>?', 'children', 'es', 'para'],
  ['¿Qué contiene <pokemon>?', 'children', 'es', 'pokemon'],
  ['Hijos de <table>', 'children', 'es', 'table'],
  ['What can <identAndStatusSection> contain?', 'children', 'en', 'identAndStatusSection'],
  ['What does <table> contain?', 'children', 'en', 'table'],
  ['Children of <para>?', 'children', 'en', 'para'],
  ['What can go inside <table>?', 'children', 'en', 'table'],
  ['¿Dónde puede ir <para>?', 'parents', 'es', 'para'],
  ['¿Dentro de qué puede ir <table>?', 'parents', 'es', 'table'],
  ['¿En qué elementos puede aparecer <emphasis>?', 'parents', 'es', 'emphasis'],
  ['Where can <para> go?', 'parents', 'en', 'para'],
  ['Where can <para> be used?', 'parents', 'en', 'para'],
  ['What can contain <para>?', 'parents', 'en', 'para'],
  ['Parents of <table>', 'parents', 'en', 'table'],
  ['What are the children of <table>?', 'children', 'en', 'table'],
  ['¿Cuáles son los hijos de <table>?', 'children', 'es', 'table'],
  ['What attributes does <table> admit?', 'attributes', 'en', 'table'],
  ['Which attributes does <para> have?', 'attributes', 'en', 'para'],
  ['¿Qué atributos admite <table>?', 'attributes', 'es', 'table'],
  ['¿Qué valores admite @emphasisType?', 'values', 'es', 'emphasisType'],
  ['What values does @frame take?', 'values', 'en', 'frame'],
  ['Allowed values of @frame', 'values', 'en', 'frame'],
  // A bare word that exists in the vocabulary (and is not an ordinary word).
  ['What can identAndStatusSection contain?', 'children', 'en', 'identAndStatusSection'],
  ['¿Qué puede contener el elemento table?', 'children', 'es', 'table'],
  ['Where can table go?', 'parents', 'en', 'table'],
];
for (const [q, kind, lang, name] of MATCH) {
  const d = det(q);
  check(`matches: ${q}`, d && d.kind === kind && d.lang === lang && d.name === name, JSON.stringify(d));
}
check('DITA: ¿Qué puede contener <step>?', det('¿Qué puede contener <step>?', VDITA)?.name === 'step');
check('values with owner element', JSON.stringify(det('¿Qué valores admite @frame en <table>?')) === JSON.stringify({ kind: 'values', lang: 'es', name: 'frame', usedAs: 'attribute', owner: 'table' }));

// ─── Detection: phrases that must NOT match (they go to the LLM) ────────────
const NO_MATCH = [
  '¿Por qué se decidió no usar <emphasis>?',
  'Why can <para> contain <footnote>?',
  '¿Qué significa este punto de decisión?',
  'What is this decision point about?',
  '¿Qué diferencia hay entre <para> y <table>?',
  'What can this BRDP contain?',
  '¿Dónde está definido esto en la especificación?',
  'Should <emphasis> be used here?',
  '¿Deberíamos usar <table>?',
  'What does the Proposal say?',
  'Where can I find the chapter?',
  '¿Qué contiene esta regla?',
  // A bare vocabulary word next to other content words names nothing.
  'where do the identification data go?',
  'Where can the warning text go?',
  // Two kinds at once: not answered by half.
  'What attributes does <table> allow, and what are its children?',
  '¿Qué atributos tiene <table> y cuáles son sus hijos?',
];
for (const q of NO_MATCH) check(`goes to the LLM: ${q}`, det(q) === null, JSON.stringify(det(q)));
check('no vocabulary: never deterministic', detectStructuralQuestion('¿Qué puede contener <para>?', null) === null);

// ─── Answers ────────────────────────────────────────────────────────────────
{
  // The real failure: children, never the parents.
  const r = await answer('¿Qué puede contener <identAndStatusSection>?', 'S1000D 4.2', V42);
  check('identAndStatusSection: deterministic', Boolean(r?.text), JSON.stringify(r));
  check('identAndStatusSection: full card requested', calls.length === 1 && calls[0][0] === 'cards' && calls[0][2] === true, JSON.stringify(calls));
  check('identAndStatusSection: children by schema groups', r.text.includes('Sus hijos dependen del esquema') && r.text.includes('`<dmAddress>`') && r.text.includes('`<dmStatus>`') && r.text.includes('`<commentAddress>`'), r.text);
  check('identAndStatusSection: 26 schemas', r.text.includes('está definido en 26 esquemas'), r.text);
  const parents = FIX.cards['S1000D 4.2'].identAndStatusSection.parents;
  check('identAndStatusSection: never the parents', parents.every((p) => !r.text.includes(`\`<${p}>\``)), `${parents} / ${r.text}`);
  const en = await answer('What can <identAndStatusSection> contain?', 'S1000D 4.2', V42);
  check('identAndStatusSection EN', en.text.includes('Its children depend on the schema') && en.text.includes('`<dmAddress>`'), en.text);
}
{
  const r = await answer('Where can <para> go?', 'S1000D 4.2', V42);
  const parents = FIX.cards['S1000D 4.2'].para.parents;
  check('para parents: 43, complete', parents.length === 43 && r.text.startsWith('`<para>` can go inside 43 elements:') && parents.every((p) => r.text.includes(`\`<${p}>\``)), r.text);
  check('para parents: grouped by letter (long list)', /\n {2}- \*\*[A-Z]\*\*: /.test(r.text), r.text);
  check('para parents: in English', !/puede/.test(r.text));
}
{
  const r = await answer('¿Qué valores admite @emphasisType?', 'S1000D 4.2', V42);
  check('emphasisType values', r.text === '`@emphasisType` admite estos valores: em01–em99 (en `<emphasis>`).', r.text);
  check('emphasisType: attribute owners requested', calls.length === 1 && calls[0][0] === 'attribute', JSON.stringify(calls));
  const en = await answer('What values does @frame take?', 'S1000D 4.2', V42);
  check('frame values EN', en.text === '`@frame` takes these values: top, bottom, topbot, all, sides, none (on `<table>`).', en.text);
  const owned = await answer('¿Qué valores admite @emphasisType en <table>?', 'S1000D 4.2', V42);
  check('attribute not on the named element', owned.text === '`<table>` no tiene el atributo `@emphasisType`.', owned.text);
}
{
  const r = await answer('¿Qué contiene <pokemon>?', 'S1000D 4.2', V42);
  check('pokemon: does not exist, no fetch', r.text === '`<pokemon>` no existe en el esquema S1000D 4.2.' && calls.length === 0, `${r.text} ${JSON.stringify(calls)}`);
  const at = await answer('What values does @pokemon take?', 'S1000D 4.2', V42);
  check('@pokemon: does not exist (EN)', at.text === '`@pokemon` does not exist in the S1000D 4.2 schema.', at.text);
  const wt = await answer('¿Qué valores admite <table>?', 'S1000D 4.2', V42);
  check('table is an element, not an attribute', wt.text === '**table** es un elemento, no un atributo (`<table>`).', wt.text);
  const wt2 = await answer('What can @frame contain?', 'S1000D 4.2', V42);
  check('frame is an attribute, not an element', wt2.text === '**frame** is an attribute, not an element (`@frame`).', wt2.text);
}
{
  const r = await answer('What attributes does <table> admit?', 'S1000D 4.2', V42);
  check('table attributes', r.text.includes('`@frame` — values: top, bottom, topbot, all, sides, none'), r.text);
  const p = await answer('¿Qué atributos admite <para>?', 'S1000D 4.2', V42);
  check('para attributes: common to all 28 schemas, ranges kept', p.text.includes('está definido en 28 esquemas') && p.text.includes('En todos los esquemas:') && p.text.includes('cv01–cv99'), p.text);
  const c = await answer('¿Qué puede contener <para>?', 'S1000D 4.2', V42);
  check('para children: common + additional by schema', c.text.includes('En todos los esquemas puede contener:') && /- Además, en [^:\n]*crew[^:\n]*: [^\n]*`<footnote>`/.test(c.text) && /- Además[^\n]*\n- Además/.test(c.text), c.text);
  const old = await answer('¿Qué atributos admite <para>?', 'S1000D 3.0.1', V301);
  check('3.0.1 para attributes: its own names', old.text.includes('`@caveat`') && !old.text.includes('securityClassification'), old.text);
}
{
  const r = await answer('¿Qué puede contener <step>?', 'DITA 1.3 Xpath2.0', VDITA);
  check('DITA step children', r.text.startsWith('`<step>` puede contener 12 elementos hijos:') && r.text.includes('`<cmd>`') && r.text.includes('`<substeps>`'), r.text);
  const v = await answer('What values does @type take on <note>?', 'DITA 1.3 Xpath2.0', VDITA);
  check('DITA note @type values', v.text.startsWith('`@type` takes these values: attention, caution') && v.text.includes('(on `<note>`)'), v.text);
}
check('open question: not structural', (await answer('¿Por qué se decidió no usar <emphasis>?', 'S1000D 4.2', V42)) === null && calls.length === 0);

// ─── C2, Part 3: relation (yes/no) and attribute owners ─────────────────────
{
  const REL = [
    ['¿<para> puede contener <table>?', V42, 'es', 'para', 'table'],
    ['¿se puede usar <emphasis> dentro de <title>?', V42, 'es', 'title', 'emphasis'],
    ['¿Se puede usar <emphasis> en <title>?', V42, 'es', 'title', 'emphasis'],
    ['can <table> appear inside <para>?', V42, 'en', 'para', 'table'],
    ['Can <para> contain <table>?', V42, 'en', 'para', 'table'],
    ['Is <table> allowed in <para>?', V42, 'en', 'para', 'table'],
    // Reversed order: the parent is the name after "dentro de".
    ['¿<table> puede ir dentro de <para>?', V42, 'es', 'para', 'table'],
    ['¿Puede <para> ir dentro de <table>?', V42, 'es', 'table', 'para'],
    ['¿<para> admite <table>?', V42, 'es', 'para', 'table'],
    ['¿<p> puede contener <table>?', VDITA, 'es', 'p', 'table'],
  ];
  for (const [q, v, lang, parent, child] of REL) {
    const d = det(q, v);
    check(`relation: ${q}`, JSON.stringify(d) === JSON.stringify({ kind: 'relation', lang, parent, child }), JSON.stringify(d));
  }
  const REL_NO = [
    '¿<para> puede contener <pokemon>?', // one name does not exist
    '¿<para> puede contener <table> si es un procedimiento?', // condition
    'Can <para> contain <table> when it is a warning?',
    '¿Qué diferencia hay entre <para> y <table>?',
    'Why can <para> contain <footnote>?',
    '¿<para> puede contener @frame?', // an attribute, not an element
  ];
  for (const q of REL_NO) check(`relation goes to the LLM: ${q}`, det(q) === null, JSON.stringify(det(q)));

  const OWN = [
    ['¿Qué elementos tienen @emphasisType?', V42, 'es', 'emphasisType'],
    ['which elements allow @changeMark?', V42, 'en', 'changeMark'],
    ['¿Cuáles elementos llevan @frame?', V42, 'es', 'frame'],
    ['which elements have @outputclass?', VDITA, 'en', 'outputclass'],
    ['¿Qué elementos tienen @pokemon?', V42, 'es', 'pokemon'],
  ];
  for (const [q, v, lang, name] of OWN) {
    const d = det(q, v);
    check(`attributeOwners: ${q}`, d?.kind === 'attributeOwners' && d.lang === lang && d.name === name, JSON.stringify(d));
  }
  check('attributeOwners: an element name goes to the LLM', det('¿Qué elementos tienen <table>?') === null, JSON.stringify(det('¿Qué elementos tienen <table>?')));
}
{
  // Direct in every schema.
  let r = await answer('¿se puede usar <emphasis> dentro de <title>?', 'S1000D 4.2', V42);
  check('title/emphasis: yes in all 28', r.text === 'Sí: `<title>` puede contener `<emphasis>` como hijo directo en todos los esquemas en los que existe `<title>` (28).', r.text);
  check('relation: one relation request, no card', calls.length === 1 && calls[0][0] === 'relation', JSON.stringify(calls));
  // Mixed.
  r = await answer('¿<para> puede contener <footnote>?', 'S1000D 4.2', V42);
  check('para/footnote: mixed yes', r.text.startsWith('Sí, en 22 de los 28 esquemas en los que existe `<para>`: appliccrossreftable, brdoc,'), r.text);
  check('para/footnote: the no schemas', r.text.includes('No en: comrep, fault, frontmatter, ipd, schedul, update.'), r.text);
  // Never.
  r = await answer('can <table> appear inside <para>?', 'S1000D 4.2', V42);
  check('para/table: no, in no schema (EN)', r.text === 'No, in no schema of the project: `<para>` cannot contain `<table>`, neither directly nor through other elements.', r.text);
  // Only through intermediates: "not directly", the chain and the direct children.
  r = await answer('¿<para> puede contener <listItem>?', 'S1000D 4.2', V42);
  check('para/listItem: not directly, with the chain', r.text.startsWith('No directamente: `<listItem>` no es un hijo directo de `<para>` en ningún esquema; solo puede llegar a través de otros elementos, por ejemplo `<para>` → `<randomList>` → `<listItem>`. Los hijos directos de `<para>` son estos:'), r.text);
  check('para/listItem: lists the direct children', r.text.includes('`<randomList>`') && r.text.includes('En todos los esquemas puede contener:'), r.text);
  check('para/listItem: card requested only for this case', calls.map((c) => c[0]).join(',') === 'relation,cards', JSON.stringify(calls));
  r = await answer('¿<table> puede contener <para>?', 'S1000D 4.2', V42);
  check('table/para: not directly', r.text.startsWith('No directamente:') && / → `<para>`\./.test(r.text), r.text);
  // DITA works the same.
  r = await answer('¿<p> puede contener <table>?', 'DITA 1.3 Xpath2.0', VDITA);
  check('DITA p/table: yes, no schema breakdown', r.text === 'Sí: `<p>` puede contener `<table>` como hijo directo.', r.text);
  r = await answer('Can <p> contain <li>?', 'DITA 1.3 Xpath2.0', VDITA);
  check('DITA p/li: not directly via <ol>', r.text.startsWith('Not directly:') && r.text.includes('`<p>` → `<ol>` → `<li>`'), r.text);
  r = await answer('Can <title> contain <table>?', 'DITA 1.3 Xpath2.0', VDITA);
  check('DITA title/table: never', r.text.startsWith('No, in no schema of the project'), r.text);

  // Attribute owners.
  r = await answer('¿Qué elementos tienen @emphasisType?', 'S1000D 4.2', V42);
  check('emphasisType owners', r.text === '`@emphasisType` se usa en un elemento, igual en los 28 esquemas en los que aparece: `<emphasis>`', r.text);
  check('owners: attribute endpoint', calls.length === 1 && calls[0][0] === 'attribute', JSON.stringify(calls));
  r = await answer('which elements allow @changeMark?', 'S1000D 4.2', V42);
  check('changeMark: by schema with a common block', r.text.startsWith('`@changeMark` is used on 672 elements; which ones depends on the schema (it appears in 28 schemas).') && r.text.includes('In all those schemas: '), r.text.slice(0, 300));
  check('changeMark: long lists cut with "+N more"', /\+\d+ more/.test(r.text) && r.text.split('\n').every((line) => (line.match(/`<[^>]+>`/g) || []).length <= 20), '');
  r = await answer('¿Qué elementos tienen @changeMark?', 'S1000D 4.2', V42);
  check('changeMark ES: "+N más"', /\+\d+ más/.test(r.text), '');
  r = await answer('¿Qué elementos tienen @pokemon?', 'S1000D 4.2', V42);
  check('owners: nonexistent attribute', r.text === '`@pokemon` no existe en ningún esquema del proyecto.' && calls.length === 0, r.text);
  r = await answer('which elements have @outputclass?', 'DITA 1.3 Xpath2.0', VDITA);
  check('DITA outputclass: one list, cut', r.text.startsWith('`@outputclass` is used on 364 elements: ') && r.text.endsWith('+344 more'), r.text.slice(0, 200));
  r = await answer('Where can @frame go?', 'S1000D 4.2', V42);
  check('where can @frame go: same owners answer', r.text.startsWith('`@frame` is used on one element, the same in the 13 schemas where it appears: `<table>`'), r.text);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
