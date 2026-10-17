// Test de reglas DITA: un topic anidado dentro del cuerpo se sube a su sitio.
// With the REAL structures (scripts/rule-test-fixtures/structures.json, with
// the shells' nesting) and the RECONSTRUCTED rule BRDP-EXT-00016
// (rule-test-fixtures/navantia-dita3-nested-steps-ext-00016.sch -- the real
// $pasosDosier text is not in the repo): liftNestedTopics, the structural
// check, the correction hint, the notes, and EXT-00016 end to end.
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { exampleProblems, materializeExample, nestedTopicHint, ruleTestVerdict, validateExample } from '../src/utils/ruleTest.js';
import { liftNestedTopics } from '../src/utils/schemaPlacement.js';
import { checkExampleStructure } from '../src/validation/schemaValidation.js';
import { exampleAdjustmentNotes } from '../src/utils/exampleAdjustments.js';
import { readTextFile } from './lib/textFile.mjs';
import i18n from '../src/i18n/index.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}
function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const vocabDita = (() => {
  const v = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-dita.json', import.meta.url)));
  return { elements: new Set(v.elements), attributes: new Set(v.attributes) };
})();
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'];
const st = (t) => STRUCTURES[`DITA 1.3 Xpath2.0|${t}`];
const concept = st('concept');
const task = st('task');
const topic = st('topic');
const FORMAT = 'SCH-DITA';
const STANDARD = 'DITA 1.3 Xpath3.0';
const SCH = readTextFile(new URL('./rule-test-fixtures/navantia-dita3-nested-steps-ext-00016.sch', import.meta.url));
const RULE = SCH.match(/<sch:pattern id="p-BRDP-EXT-00016"[\s\S]*?<\/sch:pattern>/)[0].replace('<sch:pattern', '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const order = (text, names) => names.map((n) => text.indexOf(n));
const ascending = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));
const problemsOf = (text, structure) => checkExampleStructure(parseXml(text), structure);

// ─── 0. The structures say what the shells say ──────────────────────────────
check('concept nests concept, after <conbody>', JSON.stringify(concept.nesting) === '{"concept":{"body":"conbody","nested":["concept"]}}', JSON.stringify(concept.nesting));
check('task nests task, after <taskbody>', task.nesting?.task?.body === 'taskbody' && task.nesting.task.nested.join() === 'task');
check('troubleshooting nests task (its shell), not itself', st('troubleshooting').nesting?.troubleshooting?.nested.join() === 'task');
check('map: no nesting', Object.keys(st('map').nesting || {}).length === 0);
check('S1000D: no nesting', Object.keys(STRUCTURES['S1000D 4.2|descript'].nesting || {}).length === 0);
check('structural check: <concept> after <conbody> is valid', problemsOf('<concept id="a"><title>A</title><conbody><p>x</p></conbody><concept id="b"><title>B</title><conbody><p>y</p></conbody></concept></concept>', concept).length === 0);
{
  const p = problemsOf('<concept id="a"><title>A</title><conbody><p>x</p><concept id="b"><title>B</title><conbody><p>y</p></conbody></concept></conbody></concept>', concept);
  check('structural check: <concept> inside <conbody> is not allowed', p.some((x) => x.kind === 'notAllowed' && x.element === 'concept' && x.parent === 'conbody'), JSON.stringify(p));
}

// ─── 1. liftNestedTopics with the real structures ───────────────────────────
const step = (id, inner = '') => `<concept id="${id}" outputclass="numbered"><title>${id}</title><conbody><p>${id}</p>${inner}</conbody></concept>`;
{
  const text = `<concept id="a"><title>A</title><conbody><p>Intro</p>${step('s1')}</conbody></concept>`;
  const r = liftNestedTopics(text, concept);
  check('concept in conbody → moved after <conbody>', r.lifted.length === 1 && r.text.includes('</conbody><concept id="s1"') && problemsOf(r.text, concept).length === 0, r.text);
  check('…its text and attributes untouched', r.text.includes(step('s1')));
  check('…the note data', JSON.stringify(r.lifted) === '[{"element":"concept","body":"conbody","parent":"concept"}]');
}
{
  const text = `<concept id="a"><title>A</title><conbody><p>Intro</p>${step('s1')}<p>Between</p>${step('s2')}</conbody></concept>`;
  const r = liftNestedTopics(text, concept);
  check('two concepts in conbody → both moved, in their order', r.lifted.length === 2 && ascending(order(r.text, ['</conbody>', 'id="s1"', 'id="s2"'])) && r.text.includes('<conbody><p>Intro</p><p>Between</p></conbody>'), r.text);
}
{
  const text = `<concept id="a"><title>A</title><conbody><p>Intro</p>${step('s1')}${step('s2', step('s21') + step('s22'))}</conbody></concept>`;
  const r = liftNestedTopics(text, concept);
  check('a nested concept inside a nested concept inside conbody → both levels right', r.lifted.length === 4 && problemsOf(r.text, concept).length === 0, r.text);
  const doc = parseXml(r.text);
  const kids = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 1).map((n) => n.getAttribute('id') || n.nodeName);
  const s2 = Array.from(doc.getElementsByTagName('concept')).find((c) => c.getAttribute('id') === 's2');
  check('…root: title, conbody, s1, s2', kids(doc.documentElement).join() === 'title,conbody,s1,s2', kids(doc.documentElement).join());
  check('…s2: title, conbody, s21, s22', kids(s2).join() === 'title,conbody,s21,s22', kids(s2).join());
}
{
  const text = `<concept id="a"><title>A</title><conbody><p>Intro</p>${step('s1')}</conbody><related-links><link href="x.dita"/></related-links></concept>`;
  const r = liftNestedTopics(text, concept);
  check('with <related-links> → after it', r.lifted.length === 1 && r.text.includes('</related-links><concept id="s1"') && problemsOf(r.text, concept).length === 0, r.text);
}
{
  const text = `<concept id="a"><title>A</title><conbody>${step('s2')}</conbody>${step('s1')}</concept>`;
  const r = liftNestedTopics(text, concept);
  check('after the nested topics already there', r.lifted.length === 1 && ascending(order(r.text, ['id="s1"', 'id="s2"'])), r.text);
}
{
  const text = '<task id="t"><title>T</title><taskbody><steps><step><cmd>Do</cmd></step></steps><task id="sub"><title>Sub</title><taskbody><steps><step><cmd>x</cmd></step></steps></taskbody></task></taskbody></task>';
  const r = liftNestedTopics(text, task);
  check('task inside taskbody → after taskbody', r.lifted.length === 1 && r.text.endsWith('</taskbody><task id="sub"><title>Sub</title><taskbody><steps><step><cmd>x</cmd></step></steps></taskbody></task></task>') && problemsOf(r.text, task).length === 0, r.text);
}
{
  const text = '<concept id="a"><title>A</title><conbody><p>x</p><table><tgroup cols="1"><tbody><row><entry>y</entry></row></tbody></tgroup></table></conbody></concept>';
  check('<p> and <table> in conbody → unchanged', liftNestedTopics(text, concept).text === text);
}
{
  const text = `<concept id="a"><title>A</title><conbody><p>x</p></conbody>${step('s1')}</concept>`;
  const r = liftNestedTopics(text, concept);
  check('a topic already in its place → unchanged', r.lifted.length === 0 && r.text === text);
}
{
  // The parent would not stay valid: a <title> after <conbody> already.
  const text = `<concept id="a"><title>A</title><conbody>${step('s1')}</conbody><title>B</title></concept>`;
  const r = liftNestedTopics(text, concept);
  check('the parent would not stay valid → not moved', r.lifted.length === 0 && r.text === text, r.text);
  const v = validateExample(text, vocabDita, parseXml, concept, { titleHints: true });
  const lines = exampleProblems(v, { standard: STANDARD, schema: 'concept', structure: concept });
  check('…the correction says where a nested topic goes', lines.some((l) => l.includes('<concept> is not allowed inside <conbody>') && l.endsWith('A nested <concept> goes directly inside its parent <concept>, after <conbody>, never inside it.')), lines.join('\n'));
}
{
  // The content of a concept example goes inside the skeleton's <conbody>:
  // a top-level concept's parent is the skeleton.
  const text = `<p>x</p>${step('s1')}`;
  check('a top-level topic whose parent is the skeleton → never moved', liftNestedTopics(text, concept).text === text);
  check('nestedTopicHint for the skeleton case', nestedTopicHint({ kind: 'notAllowed', element: 'concept', parent: 'conbody' }, concept) === 'A nested <concept> goes directly inside its parent <concept>, after <conbody>, never inside it.');
  check('nestedTopicHint: <p> → none', nestedTopicHint({ kind: 'notAllowed', element: 'p', parent: 'conbody' }, concept) === null);
  check('nestedTopicHint: S1000D → none', nestedTopicHint({ kind: 'notAllowed', element: 'para', parent: 'levelledPara' }, STRUCTURES['S1000D 4.2|descript']) === null);
}
{
  const text = '<topic id="a"><title>A</title><body><p>x</p><topic id="b"><title>B</title><body><p>y</p></body></topic></body></topic>';
  const r = liftNestedTopics(text, topic);
  check('topic inside body → after body', r.lifted.length === 1 && r.text.includes('</body><topic id="b">'), r.text);
}

// ─── 2. Notes ────────────────────────────────────────────────────────────────
{
  const ex = { nestedLifted: [{ element: 'concept', body: 'conbody', parent: 'concept' }] };
  check('note EN', exampleAdjustmentNotes(ex, en)[0] === 'Adjusted by the app: <concept> was moved out of <conbody>, as a nested topic of <concept>.', exampleAdjustmentNotes(ex, en)[0]);
  check('note ES', exampleAdjustmentNotes(ex, es)[0] === 'Ajustado por la app: <concept> se movió fuera de <conbody>, como topic anidado de <concept>.', exampleAdjustmentNotes(ex, es)[0]);
  const file = { files: [{ path: 'fichas/ft-001.dita', nestedLifted: ex.nestedLifted }] };
  check('note of a dossier file names it', exampleAdjustmentNotes(file, en)[0].startsWith('fichas/ft-001.dita: Adjusted by the app: <concept> was moved out of <conbody>'));
}

// ─── 3. EXT-00016 end to end (reconstructed rule) ───────────────────────────
const MAP = '<map><title>Dosier</title><topicref href="fichas/ft-001.dita"/></map>';
// As Mistral wrote it: the steps inside <conbody>.
const sheet = (cited) =>
  `<concept id="ft-001"><title>Desmontaje de la bomba</title><conbody><p>Antes de desmontar, véase el paso ${cited}.</p>` +
  '<concept id="p1" outputclass="numbered"><title>Preparar</title><conbody><p>Cerrar la válvula.</p></conbody></concept>' +
  '<concept id="p2" outputclass="numbered"><title>Desmontar</title><conbody><p>Retirar la tapa.</p>' +
  '<concept id="p21" outputclass="numbered"><title>Aflojar</title><conbody><p>Aflojar los tornillos.</p></conbody></concept>' +
  '<concept id="p22" outputclass="numbered"><title>Retirar</title><conbody><p>Retirar la bomba.</p></conbody></concept>' +
  '</conbody></concept></conbody></concept>';
const ANSWER = JSON.stringify({
  examples: [
    { label: 'paso 2.1 citado y existente', expected: 'accept', schema: 'map', content: MAP, files: [{ path: 'fichas/ft-001.dita', content: sheet('2.1') }] },
    { label: 'paso 2.3 citado, no existe', expected: 'reject', schema: 'map', content: MAP, files: [{ path: 'fichas/ft-001.dita', content: sheet('2.3') }] },
  ],
});
const fetchSchemaCards = async (_s, names) => ({ cards: {}, document_schemas: TYPES, element_schemas: Object.fromEntries(names.map((n) => [n, TYPES.filter((t) => st(t)?.elements[n])])) });
const fetchStructure = async (_s, t) => (st(t) ? { available: true, ...st(t) } : { available: false });
const BRDP = { identifier: 'BRDP-EXT-00016', title: 'Pasos citados', definition: 'Decidir si un paso citado en una ficha debe existir en el dosier.', proposal: 'Todo paso citado en una ficha existe en el dosier.' };
const asked = [];
const result = await generateRuleTestExamples({
  ruleXml: RULE, format: FORMAT, standard: STANDARD, schemaLocation: 'flat', brdp: BRDP, vocabulary: vocabDita, parseXml,
  ask: async (messages, systemPrompt) => {
    asked.push({ messages, systemPrompt });
    return ANSWER;
  },
  fetchSchemaCards, fetchStructure,
});
check('EXT-00016: an executable dossier rule', analyzeRule(RULE, FORMAT, { parseXml }).dossier === true);
check('EXT-00016: one LLM call, no correction round', result.status === 'ready' && asked.length === 1 && (result.correction?.attempted || 0) === 0, JSON.stringify([result.status, asked.length, result.correction, result.error]));
const files = (result.examples || []).map((e) => e.files?.[0]);
check('EXT-00016: the steps moved in both sheets (two levels: 4 moves)', files.every((f) => f?.nestedLifted?.length === 4), JSON.stringify(files.map((f) => f?.nestedLifted)));
check('EXT-00016: each sheet valid', (result.runs || []).every((r) => r.validation.runnable), JSON.stringify(result.runs?.map((r) => r.validation.files?.map((f) => f.validation.structure))));
check('EXT-00016: 2.1 cited and existing → accepted', result.runs?.[0]?.result?.status === 'accepted', result.runs?.[0]?.result?.status);
check('EXT-00016: 2.3 → rejected, with the rule\'s message', result.runs?.[1]?.result?.status === 'rejected' && /El paso 2\.3 citado no existe/.test(result.runs[1].result.violations?.[0]?.message || ''), JSON.stringify(result.runs?.[1]?.result?.violations));
const verdict = result.examples ? ruleTestVerdict(result.examples, result.runs, analyzeRule(RULE, FORMAT, { parseXml })) : null;
check('EXT-00016: verdict Correct', verdict?.kind === 'correct', JSON.stringify(verdict));
{
  // Without the move the sheets are not valid: the case that failed.
  const unlifted = (result.examples || []).map((e) => e.files?.[0]).every((f) => f && !f.content.includes('<conbody><p>Antes de desmontar, véase el paso 2.1.</p><concept'));
  check('EXT-00016: the stored sheet is the lifted one', unlifted);
}
{
  // Never for a rule that is not SCH-DITA: the same example and setup with
  // another format.
  const setup = { ...result.setup, rule: { ...result.setup.rule, format: 'BREX-4.2' } };
  const ex = { label: 'x', expected: 'reject', schema: 'map', content: MAP, files: [{ path: 'fichas/ft-001.dita', content: sheet('2.1') }] };
  const m = materializeExample(ex, setup, parseXml);
  check('not SCH-DITA → nothing moved', !m.files?.[0]?.nestedLifted && m.files?.[0]?.content.includes('<p>Antes de desmontar, véase el paso 2.1.</p><concept'), JSON.stringify(m.files?.[0]?.nestedLifted));
}

// ─── 4. Subir topics anidados aunque cambie el resultado de la regla ────────
// A generic rule whose result depends on the root's FIRST-LEVEL nested
// topics (reconstructed, no client identifiers): inside <conbody> the rule
// does not see them, so the lift changes its result -- and is done anyway
// (the position inside the body is not valid for the schema).
const FIRST_LEVEL = '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p-FIRSTLEVEL"><sch:rule context="/concept"><sch:assert id="FIRSTLEVEL-1" role="error" test="count(concept[@outputclass = \'numbered\']) le 3">A procedure has at most 3 first-level steps.</sch:assert></sch:rule></sch:pattern>';
const steps = (n) => Array.from({ length: n }, (_, i) => step(`s${i + 1}`)).join('');
const procedure = (n) => `<concept id="proc"><title>Pump removal</title><conbody><p>Intro.</p>${steps(n)}</conbody></concept>`;
const run = async (rule, answer, brdp) => {
  const calls = [];
  const r = await generateRuleTestExamples({
    ruleXml: rule, format: FORMAT, standard: STANDARD, schemaLocation: 'flat', brdp, vocabulary: vocabDita, parseXml,
    ask: async (messages, systemPrompt) => {
      calls.push({ messages, systemPrompt });
      return answer;
    },
    fetchSchemaCards, fetchStructure,
  });
  return { r, calls, verdict: r.examples ? ruleTestVerdict(r.examples, r.runs, analyzeRule(rule, FORMAT, { parseXml })) : null };
};
const STEPS_BRDP = { identifier: 'BRDP-EXT-00900', title: 'Number of steps', definition: 'Decide how many first-level steps a procedure may have.', proposal: 'A procedure has at most three first-level steps.' };
{
  const answer = JSON.stringify({ examples: [
    { label: 'three steps', expected: 'accept', schema: 'concept', content: procedure(3) },
    { label: 'four steps', expected: 'reject', schema: 'concept', content: procedure(4) },
  ] });
  const { r, calls, verdict } = await run(FIRST_LEVEL, answer, STEPS_BRDP);
  check('first-level steps: one LLM call, no correction round', r.status === 'ready' && calls.length === 1 && !r.correction?.attempted, JSON.stringify([r.status, calls.length, r.correction]));
  check('first-level steps: the concepts moved in both examples (also the one whose result changes)', r.examples?.[0]?.nestedLifted?.length === 3 && r.examples?.[1]?.nestedLifted?.length === 4, JSON.stringify(r.examples?.map((e) => e.nestedLifted?.length)));
  check('first-level steps: both valid and run', (r.runs || []).every((x) => x.validation.runnable), JSON.stringify(r.runs?.map((x) => x.validation.structure)));
  check('first-level steps: 3 accepted, 4 rejected with the rule\'s message', r.runs?.[0]?.result?.status === 'accepted' && r.runs?.[1]?.result?.status === 'rejected' && /at most 3 first-level steps/.test(r.runs[1].result.violations?.[0]?.message || ''), JSON.stringify(r.runs?.map((x) => x.result?.status)));
  check('first-level steps: verdict Correct', verdict?.kind === 'correct', JSON.stringify(verdict));
  // The same rule on the content BEFORE the lift: no first-level step is
  // seen (the result the old check kept), on the lifted one four.
  const before = parseXml(procedure(4));
  const after = parseXml(r.examples[1].content);
  check('…the lift changes what the rule sees (0 → 4 first-level steps)', before.documentElement.getElementsByTagName('conbody')[0].getElementsByTagName('concept').length === 4 && Array.from(after.documentElement.childNodes).filter((n) => n.nodeName === 'concept').length === 4);
}
{
  // The parent would not stay valid (a <title> after <conbody>): not moved,
  // the correction round as today -- the simulator never corrects.
  const bad = (n) => `<concept id="proc"><title>Pump removal</title><conbody><p>Intro.</p>${steps(n)}</conbody><title>Again</title></concept>`;
  const answer = JSON.stringify({ examples: [
    { label: 'three steps', expected: 'accept', schema: 'concept', content: bad(3) },
    { label: 'four steps', expected: 'reject', schema: 'concept', content: bad(4) },
  ] });
  const { r, calls } = await run(FIRST_LEVEL, answer, STEPS_BRDP);
  check('parent left invalid → not moved, correction round', !r.examples?.some((e) => e.nestedLifted) && calls.length === 2 && r.correction?.attempted === 2 && r.correction?.fixed === 0, JSON.stringify([calls.length, r.correction?.attempted, r.correction?.fixed]));
}
{
  // A dossier sheet: the rule reads the first-level steps of each sheet.
  const DOSSIER_RULE = '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p-FIRSTLEVEL-DOSSIER"><sch:let name="fichas" value="for $t in /map//topicref[@href] return (let $u := resolve-uri($t/@href, base-uri($t)) return if (doc-available($u)) then doc($u) else ())"/><sch:rule context="/map"><sch:assert id="FIRSTLEVEL-2" role="error" test="every $f in $fichas satisfies count($f/concept/concept[@outputclass = \'numbered\']) le 3">A sheet has at most 3 first-level steps.</sch:assert></sch:rule></sch:pattern>';
  const sheetMap = '<map><title>Dossier</title><topicref href="fichas/ft-001.dita"/></map>';
  const answer = JSON.stringify({ examples: [
    { label: 'three steps', expected: 'accept', schema: 'map', content: sheetMap, files: [{ path: 'fichas/ft-001.dita', content: procedure(3) }] },
    { label: 'four steps', expected: 'reject', schema: 'map', content: sheetMap, files: [{ path: 'fichas/ft-001.dita', content: procedure(4) }] },
  ] });
  const { r, calls, verdict } = await run(DOSSIER_RULE, answer, STEPS_BRDP);
  check('dossier: an executable dossier rule', analyzeRule(DOSSIER_RULE, FORMAT, { parseXml }).dossier === true);
  check('dossier: one LLM call, no correction round', r.status === 'ready' && calls.length === 1 && !r.correction?.attempted, JSON.stringify([r.status, calls.length, r.correction]));
  check('dossier: the sheet\'s concepts moved in both examples', r.examples?.[0]?.files?.[0]?.nestedLifted?.length === 3 && r.examples?.[1]?.files?.[0]?.nestedLifted?.length === 4, JSON.stringify(r.examples?.map((e) => e.files?.[0]?.nestedLifted?.length)));
  check('dossier: 3 accepted, 4 rejected', r.runs?.[0]?.result?.status === 'accepted' && r.runs?.[1]?.result?.status === 'rejected', JSON.stringify(r.runs?.map((x) => x.result?.status)));
  check('dossier: verdict Correct', verdict?.kind === 'correct', JSON.stringify(verdict));
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
