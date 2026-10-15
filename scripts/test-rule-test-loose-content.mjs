// Test de reglas DITA: contenido suelto en el cuerpo de las fichas del dosier.
// Navantia BRDP-EXT-00014 (figures cited) and BRDP-EXT-00015 (tables cited),
// reconstructed in scripts/rule-test-fixtures/
// navantia-dita3-cited-figures-tables.sch; the sheets as Mistral wrote them
// (<task><taskbody><p/><table/><fig/></taskbody></task>). Real DITA and
// S1000D 4.2 structures (scripts/rule-test-fixtures/structures.json); no
// network.
//
//     node scripts/test-rule-test-loose-content.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { exampleProblems, ruleSelectionSignature, ruleTestVerdict, validateExample } from '../src/utils/ruleTest.js';
import { DITA_TITLE_ELEMENTS, looseContainerFor, wrapLooseContent } from '../src/utils/schemaPlacement.js';
import { buildRuleTestReviewPrompt, mismatchedExamples } from '../src/prompts/ruleTestReviewPrompt.js';
import { exampleAdjustmentNotes } from '../src/utils/exampleAdjustments.js';
import { dossierSheetShapes } from '../src/utils/ruleTestDossier.js';
import { severalUncovered } from '../src/validation/ruleRepetition.js';
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
const vocabOf = (file) => {
  const v = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(v.elements), attributes: new Set(v.attributes) };
};
const vocabDita = vocabOf('schema-vocabulary-dita.json');
const vocab42 = vocabOf('schema-vocabulary-4-2.json');
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'];
const st = (t) => STRUCTURES[`DITA 1.3 Xpath2.0|${t}`];
const structures = Object.fromEntries(TYPES.map((t) => [t, st(t)]));
const related = Object.values(structures);
const FORMAT = 'SCH-DITA';
const STANDARD = 'DITA 1.3 Xpath3.0';
const SCH = readTextFile(new URL('./rule-test-fixtures/navantia-dita3-cited-figures-tables.sch', import.meta.url));
const rule = (id) =>
  SCH.match(new RegExp(`<sch:pattern id="p-${id}"[\\s\\S]*?</sch:pattern>`))[0].replace('<sch:pattern', '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

// ─── 1. wrapLooseContent with the real structures ───────────────────────────
const task = st('task');
const wrap = (text, structure = task, opts = {}) => wrapLooseContent(text, structure, null, { related, ...opts });
{
  const r = wrap('<task id="t"><title>R</title><taskbody>\n  <p>See <xref href="#t/f1"/>.</p>\n  <table id="t1"><tgroup cols="1"><tbody><row><entry>a</entry></row></tbody></tgroup></table>\n  <fig id="f1"><title>F</title><image href="a.png"/></fig>\n</taskbody></task>');
  check('p/table/fig in taskbody → one <context> around the three', r.wrapped.length === 1 && r.wrapped[0].container === 'context' && r.wrapped[0].parent === 'taskbody' && r.wrapped[0].elements.join() === 'p,table,fig', JSON.stringify(r.wrapped));
  check('the wrapped elements keep their text byte for byte', r.text.includes('<context><p>See <xref href="#t/f1"/>.</p>\n  <table id="t1">') && r.text.includes('<image href="a.png"/></fig></context>\n</taskbody>'), r.text);
}
{
  const r = wrap('<task id="t"><title>R</title><taskbody><p>x</p><steps><step><cmd>Do</cmd></step></steps></taskbody></task>');
  check('<steps> present, <p> before it → a new <context> before <steps>', r.text === '<task id="t"><title>R</title><taskbody><context><p>x</p></context><steps><step><cmd>Do</cmd></step></steps></taskbody></task>', r.text);
}
{
  const r = wrap('<task id="t"><title>R</title><taskbody><steps><step><cmd>Do</cmd></step></steps><p>x</p></taskbody></task>');
  check('<p> after <steps> → <result> (the closest after it)', r.wrapped[0]?.container === 'result' && r.text.includes('</steps><result><p>x</p></result>'), r.text);
}
{
  const r = wrap('<task id="t"><title>R</title><taskbody><context><p>a</p></context><p>x</p><steps><step><cmd>Do</cmd></step></steps></taskbody></task>');
  check('an existing <context> right before → the run goes into it', r.wrapped[0]?.reused === true && r.text.includes('<context><p>a</p><p>x</p></context><steps>'), r.text);
}
{
  const ok = '<topic id="t"><title>R</title><body><p>x</p><fig id="f"><title>F</title></fig><table id="t1"/></body></topic>';
  const r = wrap(ok, st('topic'));
  check('topic/body with correct content → unchanged', r.text === ok && r.wrapped.length === 0);
}
{
  const r = wrap('<task id="t"><title>R</title><taskbody><topicref href="x"/></taskbody></task>');
  check('an element no container of taskbody takes → unchanged', r.wrapped.length === 0 && r.text.includes('<taskbody><topicref href="x"/></taskbody>'));
}
{
  // A synthetic schema: <body> takes <box> (required @kind without a value)
  // and <plain>; both admit <p>.
  const syn = {
    elements: { root: { children: ['body'] }, body: { children: ['box', 'plain'] }, box: { children: ['p'] }, plain: { children: ['p'] }, p: { children: [] } },
    models: {
      root: { order: ['body'], required: [], attributes: [], max: {} },
      body: { order: ['box', 'plain'], required: [], attributes: [], max: {} },
      box: { order: ['p'], required: [], attributes: [['kind', null]], max: {} },
      plain: { order: ['p'], required: [], attributes: [], max: {} },
      p: { order: [], required: [], attributes: [], max: {} },
    },
  };
  const r = wrapLooseContent('<root><body><p>x</p></body></root>', syn, null);
  check('a container with a required attribute without a value is never used', r.wrapped[0]?.container === 'plain', JSON.stringify(r.wrapped));
  const noPlain = { ...syn, elements: { ...syn.elements, body: { children: ['box'] } }, models: { ...syn.models, body: { ...syn.models.body, order: ['box'] } } };
  check('…and with only that one, nothing is done', wrapLooseContent('<root><body><p>x</p></body></root>', noPlain, null).wrapped.length === 0);
}
{
  const r = wrap('<task id="t"><title>R</title><taskbody><p>x</p></taskbody></task>', task, { keeps: () => false });
  check('keeps refuses → unchanged', r.wrapped.length === 0 && r.text.includes('<taskbody><p>x</p></taskbody>'));
}
{
  // Contenedor por tipo: the most general one, never the first in the order.
  const pick = (t, names) => looseContainerFor(st(t), st(t).skeleton.path[1], names, related);
  check('looseContainerFor: task → context (not prereq)', pick('task', ['p', 'fig', 'table']) === 'context');
  check('looseContainerFor: reference → section (not refsyn/example)', pick('reference', ['fig']) === 'section');
}

// ─── 2. Part 1: how each sheet is built, in the prompt ──────────────────────
{
  const shapes = dossierSheetShapes(structures, ['fig', 'xref', 'topicref']);
  const by = Object.fromEntries(shapes.lines.map((l) => [l.type, l]));
  check('topic: content directly in topic/body', by.topic?.direct === true && by.topic.container === 'body');
  check('task: content in task/taskbody/context, main flow to <cmd>', by.task?.direct === false && by.task.container === 'context' && by.task.deep?.join('/') === 'task/taskbody/steps/step/cmd', JSON.stringify(by.task));
  check('concept: conbody', by.concept?.container === 'conbody' && by.concept.direct);
  check('reference: refbody/section for figures', by.reference?.container === 'section' && !by.reference.direct, JSON.stringify(by.reference));
  check('no element own to a type → default sheet is <topic> with <body>', shapes.ownTypes.length === 0 && shapes.base?.root === 'topic' && shapes.base.body === 'body');
  check('a rule on <step>/<cmd> → the task type is needed (no default line)', dossierSheetShapes(structures, ['step', 'cmd']).ownTypes.includes('task'));
}

// ─── 3. EXT-00014 / 00015 end to end: no correction round ──────────────────
const MAP = '<map><title>Dosier</title><topicref href="topics/removal.dita"/></map>';
// As Mistral wrote them: p, table and fig straight in <taskbody>.
const sheet = (cited, kind) => {
  const xref = cited ? `<p>See <xref href="#removal/${kind === 'fig' ? 'f1' : 't1'}"/>.</p>` : '<p>Remove the pump.</p>';
  const table = '<table id="t1"><tgroup cols="1"><tbody><row><entry>Pump P-1</entry></row></tbody></tgroup></table>';
  const fig = '<fig id="f1"><title>Pump</title></fig>';
  return `<task id="removal"><title>Removal</title><taskbody>${xref}${kind === 'table' ? table : `${table}${fig}`}</taskbody></task>`;
};
const answerFor = (kind) => JSON.stringify({
  examples: [
    { label: 'cited', expected: 'accept', schema: 'map', content: MAP, files: [{ path: 'topics/removal.dita', content: sheet(true, kind) }] },
    { label: 'not cited', expected: 'reject', schema: 'map', content: MAP, files: [{ path: 'topics/removal.dita', content: sheet(false, kind) }] },
  ],
});
const fetchSchemaCards = async (_s, names) => ({ cards: {}, document_schemas: TYPES, element_schemas: Object.fromEntries(names.map((n) => [n, TYPES.filter((t) => st(t)?.elements[n])])) });
const fetchStructure = async (_s, t) => (st(t) ? { available: true, ...st(t) } : { available: false });
async function run(ruleXml, answer, id) {
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml, format: FORMAT, standard: STANDARD, schemaLocation: 'flat',
    brdp: { identifier: id, title: 'Figuras y tablas citadas', definition: 'Decidir si toda figura o tabla de una ficha se cita.', proposal: 'Toda figura y toda tabla de una ficha se cita en el texto.' },
    vocabulary: vocabDita, parseXml,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      return typeof answer === 'function' ? answer(asked.length) : answer;
    },
    fetchSchemaCards, fetchStructure,
  });
  return { result, asked };
}
for (const [id, kind, label] of [['BRDP-EXT-00014', 'fig', 'figure'], ['BRDP-EXT-00015', 'table', 'table']]) {
  const r = rule(id);
  check(`${id}: an executable dossier rule`, analyzeRule(r, FORMAT, { parseXml }).dossier === true);
  const { result, asked } = await run(r, answerFor(kind), id);
  const prompt = asked[0].systemPrompt;
  check(`${id}: prompt says how a task sheet is built`, prompt.includes('- <task>: its content goes in task/taskbody/context') && prompt.includes('never directly in <taskbody>') && prompt.includes('its main flow: task/taskbody/steps/step/cmd'), prompt.split('SHEETS:')[1]?.slice(0, 700));
  check(`${id}: prompt says <topic> with <body> by default`, prompt.includes('Write each sheet as <topic> with <body> unless the rule needs another type.'));
  check(`${id}: one LLM call, no correction round`, result.status === "ready" && asked.length === 1 && (result.correction?.attempted || 0) === 0, JSON.stringify([result.status, asked.length, result.correction, result.error, result.reason]));
  const files = result.examples.map((e) => e.files?.[0]);
  check(`${id}: each sheet wrapped in <context> with its note`, files.every((f) => f?.wrapped?.[0]?.container === 'context' && f.content.includes('<taskbody><context>')), JSON.stringify(files.map((f) => f?.wrapped)));
  check(`${id}: both examples run`, result.runs.every((x) => ['accepted', 'rejected'].includes(x.result?.status)), result.runs.map((x) => x.result?.status).join());
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(r, FORMAT, { parseXml }));
  check(`${id}: verdict Correct`, verdict.kind === 'correct', JSON.stringify(verdict));
  check(`${id}: the rejection names the ${label}`, new RegExp(`La ${kind === 'fig' ? 'figura f1' : 'tabla t1'} no se cita`).test(result.runs[1].result.violations?.[0]?.message || ''), result.runs[1].result.violations?.[0]?.message);
}

// ─── 4. A rule that depends on the direct parent: never wrapped ─────────────
{
  const direct = '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron" id="p-X"><sch:let name="yo" value="base-uri()"/><sch:let name="m" value="doc-available(resolve-uri(\'../dossier.ditamap\', $yo))"/><sch:rule context="taskbody/p"><sch:assert id="X" role="error" test="false()">Un párrafo suelto en taskbody.</sch:assert></sch:rule></sch:pattern>';
  const ans = JSON.stringify({ examples: [
    { label: 'loose', expected: 'reject', schema: 'map', content: MAP, files: [{ path: 'topics/removal.dita', content: '<task id="removal"><title>R</title><taskbody><p>x</p></taskbody></task>' }] },
    { label: 'fine', expected: 'accept', schema: 'map', content: MAP, files: [{ path: 'topics/removal.dita', content: '<task id="removal"><title>R</title><taskbody><context><p>x</p></context></taskbody></task>' }] },
  ] });
  const { result } = await run(direct, ans, 'X');
  const f = result.examples[0].files?.[0];
  const ruleObj = { ruleXml: direct, format: FORMAT };
  const dossierOf = (content) => ({ mainPath: 'dossier.ditamap', files: [{ path: 'topics/removal.dita', xml: content }] });
  const before = ruleSelectionSignature(ruleObj, MAP, 'map', { parseXml, dossier: dossierOf('<task id="removal"><title>R</title><taskbody><p>x</p></taskbody></task>') });
  const after = ruleSelectionSignature(ruleObj, MAP, 'map', { parseXml, dossier: dossierOf('<task id="removal"><title>R</title><taskbody><context><p>x</p></context></taskbody></task>') });
  check('taskbody/p: the rule runs on both (signatures exist) and they differ', before !== null && after !== null && before !== after, JSON.stringify([before, after]));
  check('taskbody/p: wrapping would change what the rule selects → not wrapped', f && !f.wrapped && f.content.includes('<taskbody><p>x</p></taskbody>'), JSON.stringify(f?.wrapped));
}

// ─── 5. S1000D (BREX): never wrapped ────────────────────────────────────────
{
  const S42 = 'S1000D 4.2';
  const s42 = (sc) => STRUCTURES[`${S42}|${sc}`];
  const EMPH = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>Do not use emphasis.</objectUse></structureObjectRule>';
  // <randomList> straight in <listItem>: <para> would take it (the same
  // pattern), and there are two ways down (no relocation).
  const loose = (inner) => `<randomList><listItem><randomList><listItem><para>${inner}</para></listItem></randomList></listItem></randomList>`;
  check('S1000D: the pattern applies (wrapLooseContent alone would wrap it in <para>)', wrapLooseContent(loose('x'), s42('descript'), 'para').wrapped[0]?.container === 'para');
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: EMPH, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-X', title: 'Emphasis', definition: 'Decide whether emphasis is used.', proposal: 'Emphasis is not used.' },
    vocabulary: vocab42, parseXml,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      return JSON.stringify({ examples: [
        { label: 'plain', expected: 'accept', schema: 'descript', content: loose('Plain text.') },
        { label: 'emphasis', expected: 'reject', schema: 'descript', content: loose('An <emphasis>important</emphasis> word.') },
      ] });
    },
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript'] }),
    fetchStructure: async (_s, sc) => (s42(sc) ? { available: true, ...s42(sc) } : { available: false }),
  });
  check('S1000D: nothing wrapped', result.examples.every((e) => !e.wrapped) && result.examples.every((e) => e.content.includes('<listItem><randomList>')), JSON.stringify(result.examples.map((e) => e.wrapped)));
  check('S1000D: the loose content goes to the correction round as today', asked.length === 2 && asked[1].messages.at(-1).content.includes('<randomList> is not allowed inside <listItem>'), asked[1]?.messages.at(-1).content.slice(0, 300));
}

// ─── 6. Part 3: no coverage note with no example run ────────────────────────
{
  const several = [{ element: 'entry', parent: 'row' }];
  const ex = [{ xml: '<x/>' }];
  check('0 examples run → no "no example has more than one" note', severalUncovered(several, ex, [{ result: { status: 'not_executable' } }], parseXml).length === 0);
  check('0 runs at all → no note', severalUncovered(several, ex, [{}], parseXml).length === 0);
  check('1 example run without two <entry> → the note', severalUncovered(several, [{ xml: '<row><entry/></row>' }], [{ result: { status: 'accepted' } }], parseXml).join() === 'entry');
  check('a dossier file with two <entry> counts', severalUncovered(several, [{ xml: '<map/>', files: [{ xml: '<row><entry/><entry/></row>' }] }], [{ result: { status: 'accepted' } }], parseXml).length === 0);
}

// ─── 7. A loose title is never wrapped (BRDP-EXT-00015) ─────────────────────
{
  const TABLE = '<table id="t1"><tgroup cols="1"><tbody><row><entry>Pump P-1</entry></row></tbody></tgroup></table>';
  const titled = `<task id="t"><title>R</title><taskbody><title>Tabla 1</title>${TABLE}</taskbody></task>`;
  const r = wrap(titled);
  check('<title> + <table> loose in <taskbody> → not wrapped', r.wrapped.length === 0 && r.text === titled, r.text);
  const v = validateExample(titled, vocabDita, parseXml, task, { titleHints: true });
  const lines = exampleProblems(v, { standard: STANDARD, schema: 'task' });
  check('…the structure problem carries the hint', lines.includes('<title> is not allowed inside <taskbody>. If this <title> belongs to the <table> that follows, write it as the first child of that <table>.'), lines.join('\n'));
  check('…and <table> keeps its own problem', lines.includes('<table> is not allowed inside <taskbody>'), lines.join('\n'));
  const noHints = exampleProblems(validateExample(titled, vocabDita, parseXml, task), { standard: STANDARD, schema: 'task' });
  check('without titleHints (BREX) no hint', !noHints.some((l) => l.includes('belongs to the')), noHints.join('\n'));
  const owned = `<task id="t"><title>R</title><taskbody><title>Tabla 1</title><table id="t1"><title>T</title><tgroup cols="1"><tbody><row><entry>a</entry></row></tbody></tgroup></table></taskbody></task>`;
  const ownedLines = exampleProblems(validateExample(owned, vocabDita, parseXml, task, { titleHints: true }), { standard: STANDARD, schema: 'task' });
  check('a <table> with its own <title> → no hint', !ownedLines.some((l) => l.includes('belongs to the')), ownedLines.join('\n'));
  for (const kind of ['fig', 'section']) {
    const next = kind === 'fig' ? '<fig id="f1"><image href="a.png"/></fig>' : '<section><p>x</p></section>';
    const doc = `<topic id="t"><title>R</title><body><title>Uno</title>${next}</body></topic>`;
    const ls = exampleProblems(validateExample(doc, vocabDita, parseXml, st('topic'), { titleHints: true }), { standard: STANDARD, schema: 'topic' });
    check(`<title> before an untitled <${kind}> → hint names <${kind}>`, ls.some((l) => l.endsWith(`write it as the first child of that <${kind}>.`)), ls.join('\n'));
  }
  const p = wrap('<task id="t"><title>R</title><taskbody><p>See.</p><fig id="f1"><title>F</title></fig></taskbody></task>');
  check('<p> + <fig> loose → still one <context>', p.wrapped.length === 1 && p.wrapped[0].container === 'context', JSON.stringify(p.wrapped));
  const titleP = '<task id="t"><title>R</title><taskbody><title>Uno</title><p>x</p></taskbody></task>';
  check('<title> + <p> loose → not wrapped (the run is not split)', wrap(titleP).wrapped.length === 0 && wrap(titleP).text === titleP);
  const alone = '<task id="t"><title>R</title><taskbody><title>Uno</title></taskbody></task>';
  check('<title> alone, loose → not wrapped', wrap(alone).wrapped.length === 0 && wrap(alone).text === alone);
  const sd = '<task id="t"><title>R</title><taskbody><shortdesc>Short.</shortdesc></taskbody></task>';
  check('<shortdesc> loose → not wrapped', wrap(sd).wrapped.length === 0 && wrap(sd).text === sd);
  // A structure where a container would take every title element: without
  // DITA_TITLE_ELEMENTS each of them would be wrapped.
  const syn = {
    elements: { root: { children: ['body'], attributes: [] }, body: { children: ['box'], attributes: [] }, box: { children: ['title', 'navtitle', 'searchtitle', 'shortdesc', 'p'], attributes: [] }, title: { children: [], attributes: [] }, navtitle: { children: [], attributes: [] }, searchtitle: { children: [], attributes: [] }, shortdesc: { children: [], attributes: [] }, p: { children: [], attributes: [] } },
    models: { body: { order: ['box'], required: [], attributes: [] }, box: { order: ['title', 'navtitle', 'searchtitle', 'shortdesc', 'p'], required: [], attributes: [] } },
  };
  check('synthetic: <p> alone is wrapped in <box>', wrapLooseContent('<root><body><p>x</p></body></root>', syn, null).wrapped[0]?.container === 'box');
  for (const name of DITA_TITLE_ELEMENTS) {
    check(`synthetic: <${name}> is never wrapped`, wrapLooseContent(`<root><body><${name}>x</${name}><p>y</p></body></root>`, syn, null).wrapped.length === 0);
  }
  check('DITA_TITLE_ELEMENTS: title, navtitle, searchtitle, shortdesc', [...DITA_TITLE_ELEMENTS].join() === 'title,navtitle,searchtitle,shortdesc');
}

// ─── 8. EXT-00015 end to end: a loose <title> before the <table> ─────────────
{
  const id = 'BRDP-EXT-00015';
  const TABLE = (title) => `<table id="t1">${title}<tgroup cols="1"><tbody><row><entry><p>Pump P-1</p></entry></row></tbody></tgroup></table>`;
  const sheetWith = (cited, loose) =>
    `<task id="removal"><title>Removal</title><taskbody><context>${cited ? '<p>See <xref href="#removal/t1"/>.</p>' : '<p>Remove the pump.</p>'}</context>${loose ? `<title>Tabla 1</title>${TABLE('')}` : ''}</taskbody></task>`;
  const fixed = (cited) => `<task id="removal"><title>Removal</title><taskbody><context>${cited ? '<p>See <xref href="#removal/t1"/>.</p>' : '<p>Remove the pump.</p>'}${TABLE('<title>Tabla 1</title>')}</context></taskbody></task>`;
  const answer = (sheet) => JSON.stringify({
    examples: [
      { label: 'cited', expected: 'accept', schema: 'map', content: MAP, files: [{ path: 'topics/removal.dita', content: sheet(true) }] },
      { label: 'not cited', expected: 'reject', schema: 'map', content: MAP, files: [{ path: 'topics/removal.dita', content: sheet(false) }] },
    ],
  });
  const { result, asked } = await run(rule(id), (n) => (n === 1 ? answer((c) => sheetWith(c, true)) : answer(fixed)), id);
  const first = asked[1]?.messages.at(-1).content || '';
  check(`${id}: one correction round`, asked.length === 2 && result.correction?.attempted === 2, JSON.stringify([asked.length, result.correction]));
  check(`${id}: the correction carries the loose-title hint`, first.includes('<title> is not allowed inside <taskbody>. If this <title> belongs to the <table> that follows, write it as the first child of that <table>.'), first.slice(0, 900));
  check(`${id}: …never with the plain-text hint for that title`, !/<title> is not allowed inside <taskbody>[^\n]*use plain text/.test(first), first.slice(0, 900));
  check(`${id}: after the correction every example is valid`, result.examples.every((e) => e.validation?.runnable !== false) && result.runs.every((x) => ['accepted', 'rejected'].includes(x.result?.status)), result.runs.map((x) => x.result?.status).join());
  check(`${id}: no <example> made by the app`, result.examples.every((e) => !(e.files?.[0]?.wrapped || []).some((w) => w.container === 'example')), JSON.stringify(result.examples.map((e) => e.files?.[0]?.wrapped)));
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(rule(id), FORMAT, { parseXml }));
  check(`${id}: verdict Correct`, verdict.kind === 'correct', JSON.stringify(verdict));
}

// ─── 9. The review prompt knows what the application adjusted ──────────────
{
  const base = { brdp: { identifier: 'BRDP-EXT-00015', title: 'T', definition: 'D', proposal: 'P' }, standard: STANDARD, format: FORMAT, ruleXml: rule('BRDP-EXT-00015'), ruleDescription: '- x' };
  const ex = { label: 'cited', expected: 'accept', xml: MAP, files: [{ path: 'topics/removal.dita', wrapped: [{ parent: 'taskbody', container: 'example', elements: ['title', 'table'] }] }] };
  const runs = [{ matches: false, result: { status: 'rejected' } }];
  const notes = exampleAdjustmentNotes(ex, en);
  check('notes: the panel\'s text, prefixed with the file', notes.length === 1 && notes[0] === 'topics/removal.dita: Adjusted by the app: <title> and <table> were put in <example> (they do not go directly in <taskbody>).', JSON.stringify(notes));
  const withNotes = buildRuleTestReviewPrompt({ ...base, mismatches: mismatchedExamples([ex], runs, { notes: (e) => exampleAdjustmentNotes(e, en) }) });
  check('review prompt: the example carries its note', withNotes.includes(`The application changed this example:\n- ${notes[0]}\n${MAP}`), withNotes.split('did not match:')[1]);
  check('review prompt: the fixed line', withNotes.includes('If the application changed an example, consider whether that change, not the rule, explains the mismatch; if so, the cause is "example".'));
  const plain = { label: 'cited', expected: 'accept', xml: MAP };
  const before = buildRuleTestReviewPrompt({ ...base, mismatches: mismatchedExamples([plain], runs) });
  const after = buildRuleTestReviewPrompt({ ...base, mismatches: mismatchedExamples([plain], runs, { notes: (e) => exampleAdjustmentNotes(e, en) }) });
  check('review prompt with no adjustments: byte-identical', before === after && !after.includes('The application changed') && !after.includes('If the application changed'));
  const many = { label: 'x', expected: 'accept', xml: '<x/>', colspecsAdded: 2, relocated: [{ element: 'a', path: ['b', 'c', 'a'] }], topicTitleSet: 'T', sectionValuesSet: [{ element: 'dmCode', attribute: 'infoCode', value: '0A2' }], requiredAttributesAdded: [{ element: 'note', attributes: ['type'] }], valuesReplaced: [{ element: 'note', attribute: 'type', from: 'x', to: 'note' }], morerowsLowered: [2], spannedEntriesRemoved: [3], emptyRowsRemoved: [4], colsRaised: [{ from: 1, to: 2 }], textRemoved: ['pmCode'] };
  const all = exampleAdjustmentNotes(many, en);
  check('every kind of adjustment gives a note', all.length === 11 && all.every((n) => /^(Adjusted|Corrected) by the app/.test(n)), JSON.stringify(all, null, 1));
}

// ─── 10. Texts ──────────────────────────────────────────────────────────────
check('note ES', es('records.ruleTest.wrappedLoose', { count: 2, elements: '<p> y <table>', container: '<context>', parent: '<taskbody>' }) === 'Ajustado por la app: <p> y <table> se metieron en <context> (no van directamente en <taskbody>).');
check('note ES singular', es('records.ruleTest.wrappedLoose', { count: 1, elements: '<p>', container: '<context>', parent: '<taskbody>' }) === 'Ajustado por la app: <p> se metió en <context> (no va directamente en <taskbody>).');
check('note EN', en('records.ruleTest.wrappedLoose', { count: 2, elements: '<p> and <table>', container: '<context>', parent: '<taskbody>' }) === 'Adjusted by the app: <p> and <table> were put in <context> (they do not go directly in <taskbody>).');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
