// Test de reglas DITA: reglas que solo avisan, y fichas del dosier válidas.
// Navantia BRDP-EXT-00012 / 00013 (role="warning" assert, context
// row[…][ancestor::*[normalize-space(title) = 'LISTA DE …']]; reconstructed
// in scripts/rule-test-fixtures/navantia-dita3-reconstructed.sch with the
// real shape). Real DITA task/map structures (scripts/rule-test-fixtures/
// structures.json); no network.
//
//     node scripts/test-rule-test-warning-dossier.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { generateRuleTestExamples } from '../src/utils/ruleTestRun.js';
import { analyzeRule, describeRule } from '../src/utils/ruleTestEngine.js';
import { ruleTestVerdict } from '../src/utils/ruleTest.js';
import { formatRuleDescription } from '../src/utils/ruleTestReasons.js';
import { lintRuleFindings } from '../src/utils/ruleLint.js';
import { ancestorTitleConditions, dossierTitleRequirements, dossierTopicTitles, setRootTitleText } from '../src/utils/topicTitleValue.js';
import { buildRuleProposalCheckPrompt } from '../src/prompts/ruleProposalCheckPrompt.js';
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
const vj = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-dita.json', import.meta.url)));
const vocab = { elements: new Set(vj.elements), attributes: new Set(vj.attributes) };
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'];
const st = (t) => STRUCTURES[`DITA 1.3 Xpath2.0|${t}`];
const structures = Object.fromEntries(TYPES.map((t) => [t, st(t)]));
const FORMAT = 'SCH-DITA';
const STANDARD = 'DITA 1.3 Xpath3.0';
const SCH = readTextFile(new URL('./rule-test-fixtures/navantia-dita3-reconstructed.sch', import.meta.url));
const navRule = (id) =>
  SCH.match(new RegExp(`<sch:pattern id="p-${id}"[\\s\\S]*?</sch:pattern>`))[0].replace('<sch:pattern', '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"');
const BRDP = { identifier: 'BRDP-EXT-00012', title: 'Material que sobra', definition: 'd', proposal: 'Se da aviso cuando un material de la lista no se nombra en ningún paso.' };
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

// ─── 1. Warning rules: analysis, description, lint, Proposal check ─────────
for (const [id, title] of [['BRDP-EXT-00012', 'LISTA DE MATERIAL OBLIGATORIO'], ['BRDP-EXT-00013', 'LISTA DE HERRAMIENTAS ESPECIALES']]) {
  const rule = navRule(id);
  check(`${id}: every assert role="warning"`, [...rule.matchAll(/<sch:assert\b[^>]*>/g)].every((m) => /role="warning"/.test(m[0])));
  check(`${id}: context with an ancestor title`, rule.includes(`ancestor::*[normalize-space(title) = '${title}']`) || rule.includes(`ancestor::*[normalize-space(title) = &apos;${title}&apos;]`));
  const a = analyzeRule(rule, FORMAT, { parseXml });
  check(`${id}: executable dossier warning rule`, a.status === 'executable' && a.dossier === true && a.warningRule === true && JSON.stringify(a.warningRoles) === '["warning"]', JSON.stringify(a));
  const d = describeRule(rule, FORMAT, { parseXml });
  check(`${id}: describe — a warning rule, never "cannot reject"`, d.warningOnly === true && d.cannotReject === false, JSON.stringify({ w: d.warningOnly, c: d.cannotReject }));
  const lines = formatRuleDescription(d, en);
  check(`${id}: describe EN line`, lines.warningOnly === 'This rule only warns (role=warning): it does not reject documents; the test checks when it warns.', lines.warningOnly);
  check(`${id}: describe ES line`, formatRuleDescription(d, es).warningOnly === 'Esta regla solo avisa (role=warning): no rechaza documentos; la prueba comprueba cuándo avisa.');
  const lint = lintRuleFindings(rule, FORMAT, { parseXml }).map((f) => f.code);
  check(`${id}: lint — no "cannot reject" nor "must not but allowed"`, !lint.includes('cannot_reject') && !lint.includes('must_not_allowed'), JSON.stringify(lint));
  const prompt = buildRuleProposalCheckPrompt({ brdp: BRDP, standard: STANDARD, format: FORMAT, ruleXml: rule, ruleDescription: 'x', warningRule: true });
  check(`${id}: Proposal check prompt says the rule only warns`, prompt.includes('THE RULE ONLY WARNS') && prompt.includes('"yes"'), prompt.slice(-600));
}
{
  const noWarn = buildRuleProposalCheckPrompt({ brdp: BRDP, standard: STANDARD, format: FORMAT, ruleXml: navRule('BRDP-EXT-00017'), ruleDescription: 'x' });
  check('a rule with role="error": no warning block in the Proposal check', !noWarn.includes('THE RULE ONLY WARNS'));
  const a17 = analyzeRule(navRule('BRDP-EXT-00017'), FORMAT, { parseXml });
  check('EXT-00017 (role="error"): not a warning rule', !a17.warningRule);
  const info = navRule('BRDP-EXT-00012').replace('role="warning"', 'role="info"');
  check('role="info": the same as warning', analyzeRule(info, FORMAT, { parseXml }).warningRule === true && describeRule(info, FORMAT, { parseXml }).warningOnly === true);
  const mixed = navRule('BRDP-EXT-00012').replace('</sch:rule>', '<sch:assert id="E" role="error" test="entry">An entry.</sch:assert></sch:rule>');
  check('error + warning: not a warning rule (unchanged)', !analyzeRule(mixed, FORMAT, { parseXml }).warningRule && !describeRule(mixed, FORMAT, { parseXml }).warningOnly);
}

// ─── 2. Where the title can go in each file type ────────────────────────────
{
  const conds = ancestorTitleConditions(navRule('BRDP-EXT-00012'));
  check('ancestor title condition read', conds.length === 1 && conds[0].holder === '*' && conds[0].checked === 'row' && conds[0].value === 'LISTA DE MATERIAL OBLIGATORIO', JSON.stringify(conds));
  check('a negated ancestor title: not read', ancestorTitleConditions(navRule('BRDP-EXT-00012').replace("[ancestor::*[normalize-space(title) = 'LISTA DE MATERIAL OBLIGATORIO']]", "[not(ancestor::*[normalize-space(title) = 'X'])]")).length === 0);
  const req = dossierTitleRequirements(navRule('BRDP-EXT-00012'), structures);
  const task = req.ways.find((w) => w.type === 'task');
  check('task: the topic itself or an element of taskbody that takes a title', task?.topic === true && task.inside.every((p) => p[0] === 'task' && p[1] === 'taskbody'), JSON.stringify(task));
  check('task: never a <sectiondiv> (it takes no <title>)', req.ways.every((w) => w.inside.every((p) => !p.includes('sectiondiv'))));
  check('topic: body/section', req.ways.find((w) => w.type === 'topic')?.inside.some((p) => p.join('/') === 'topic/body/section'), JSON.stringify(req.ways.find((w) => w.type === 'topic')));
  check('map is not a file type for the title', !req.ways.some((w) => w.type === 'map'));
  check('the app writes the topic title only where nothing else can carry it', JSON.stringify(dossierTopicTitles(req)) === '{}', JSON.stringify(dossierTopicTitles(req)));
  check('dossierTopicTitles: topic-only types', JSON.stringify(dossierTopicTitles({ value: 'X', ways: [{ type: 'task', topic: true, inside: [] }, { type: 'topic', topic: true, inside: [['topic', 'body', 'section']] }] })) === '{"task":"X"}');
  check('no title condition → null', dossierTitleRequirements(navRule('BRDP-EXT-00017'), structures) === null);
  check('setRootTitleText: replaces the root title', setRootTitleText('<task id="t"><title>Old</title><taskbody/></task>', 'A & B') === '<task id="t"><title>A &amp; B</title><taskbody/></task>');
  check('setRootTitleText: writes it when missing', setRootTitleText('<task id="t"><taskbody/></task>', 'X') === '<task id="t"><title>X</title><taskbody/></task>');
  check('setRootTitleText: same title → unchanged', setRootTitleText('<task id="t"><title> X </title></task>', 'X') === '<task id="t"><title> X </title></task>');
}

// ─── 3. EXT-00012 / 00013 end to end ────────────────────────────────────────
const MAP = '<map><title>Dosier</title><topicref href="fichas/ft-001.dita"/></map>';
const row = (a, b = '') => `<row><entry>${a}</entry><entry>${b}</entry></row>`;
const table = (title, rows) => `<title>${title}</title><table><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><tbody>${rows}</tbody></tgroup></table>`;
const steps = (cmds) => `<steps>${cmds.map((c) => `<step><cmd>${c}</cmd></step>`).join('')}</steps>`;
// The real failure: <sectiondiv><title>… directly in <taskbody>.
const sheetBad = (title, rows, cmds) => `<task id="ft-001"><title>Desmontaje de la bomba</title><taskbody><sectiondiv>${table(title, rows)}</sectiondiv>${steps(cmds)}</taskbody></task>`;
const sheetGood = (title, rows, cmds) => `<task id="ft-001"><title>Desmontaje de la bomba</title><taskbody>${steps(cmds)}<example>${table(title, rows)}</example></taskbody></task>`;
const answer = (sheet, title, item) => JSON.stringify({
  examples: [
    { label: 'nombrado', expected: 'accept', schema: 'map', content: MAP, files: [{ path: 'fichas/ft-001.dita', content: sheet(title, row(item), [`Sustituir ${item}.`]) }] },
    { label: 'exento', expected: 'accept', schema: 'map', content: MAP, files: [{ path: 'fichas/ft-001.dita', content: sheet(title, row('Grasa G-3', 'Exento'), ['Desmontar la tapa.']) }] },
    { label: 'sobra', expected: 'reject', schema: 'map', content: MAP, files: [{ path: 'fichas/ft-001.dita', content: sheet(title, row(item) + row('Arandela A-4'), [`Sustituir ${item}.`]) }] },
  ],
});
const fetchSchemaCards = async (_s, names) => ({ cards: {}, document_schemas: TYPES, element_schemas: Object.fromEntries(names.map((n) => [n, TYPES.filter((t) => st(t)?.elements[n])])) });
const fetchStructure = async (_s, t) => (st(t) ? { available: true, ...st(t) } : { available: false });
async function run(id, title, item, first, fix) {
  const asked = [];
  let n = 0;
  const result = await generateRuleTestExamples({
    ruleXml: navRule(id), format: FORMAT, standard: STANDARD, schemaLocation: 'flat',
    brdp: { identifier: id, title: 'Lo que sobra en la lista', definition: 'Decidir si se avisa de lo que la lista nombra y ningún paso usa.', proposal: 'Se da aviso cuando algo de la lista no se nombra en ningún paso, salvo que esté exento.' },
    vocabulary: vocab, parseXml,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      n += 1;
      return answer(n === 1 ? first : fix, title, item);
    },
    fetchSchemaCards, fetchStructure,
  });
  return { result, asked };
}
for (const [id, title, item] of [['BRDP-EXT-00012', 'LISTA DE MATERIAL OBLIGATORIO', 'Junta tórica J-12'], ['BRDP-EXT-00013', 'LISTA DE HERRAMIENTAS ESPECIALES', 'Llave dinamométrica L-7']]) {
  // a) the LLM writes valid sheets at once
  {
    const { result, asked } = await run(id, title, item, sheetGood, sheetGood);
    const prompt = asked[0].systemPrompt;
    check(`${id}: prompt says the rule only warns`, prompt.includes('THE RULE ONLY WARNS'));
    check(`${id}: prompt lists where the title goes in a task file`, /- in a task file: the <task> itself \(its own <title>, its first child\)/.test(prompt) && prompt.includes('task/taskbody/'), prompt.split('THE RULE DEPENDS ON A TITLE')[1]?.slice(0, 600));
    check(`${id}: valid at once, no correction`, result.status === 'ready' && (result.correction?.attempted || 0) === 0, JSON.stringify(result.correction));
    check(`${id}: a warning rule run`, result.warningRule === true);
    const outcome = result.runs.map((r) => r.result.status).join(',');
    check(`${id}: named and exempt → no warning, leftover → warns`, outcome === 'accepted,accepted,rejected', outcome);
    const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(navRule(id), FORMAT, { parseXml }));
    check(`${id}: verdict Correct`, verdict.kind === 'correct', JSON.stringify(verdict));
    check(`${id}: the warning names the leftover`, /«Arandela A-4»/.test(result.runs[2].result.violations[0]?.message || ''));
  }
  // b) the real failure: <sectiondiv><title> in <taskbody>, fixed by the correction
  {
    const { result, asked } = await run(id, title, item, sheetBad, sheetGood);
    check(`${id}: <sectiondiv> in <taskbody> → one correction round`, asked.length === 2 && result.correction?.attempted === 3 && result.correction?.fixed === 3, JSON.stringify(result.correction));
    const correction = asked[1].messages.at(-1).content;
    // Contenido suelto: the loose <sectiondiv> is put in a container of
    // <taskbody> by the application (no more "<sectiondiv> is not allowed
    // inside <taskbody>"); what is left is its <title>, which no container fixes.
    check(`${id}: the loose <sectiondiv> is not sent to the correction`, !correction.includes('<sectiondiv> is not allowed inside <taskbody>'), correction.slice(0, 400));
    check(`${id}: correction names the file and the problem left (the title)`, correction.includes('file "fichas/ft-001.dita": <title> is not allowed inside <sectiondiv>'), correction.slice(0, 400));
    check(`${id}: correction carries the card of <sectiondiv>`, /card of <sectiondiv> in the task schema: allowed children:/.test(correction));
    check(`${id}: correction says where the title can go`, correction.includes(`The title the rule looks for ("${title}") goes on the file's own <task>`) && correction.includes('task/taskbody/'));
    check(`${id}: after the correction, Correct`, ruleTestVerdict(result.examples, result.runs, analyzeRule(navRule(id), FORMAT, { parseXml })).kind === 'correct');
  }
  // c) the correction does not help: the message still says schema and reason
  {
    const { result } = await run(id, title, item, sheetBad, sheetBad);
    const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(navRule(id), FORMAT, { parseXml }));
    const f = result.examples[0].files?.[0];
    check(`${id}: the loose <sectiondiv> wrapped by the app in a container of <taskbody>`, f?.wrapped?.[0]?.parent === 'taskbody' && f.wrapped[0].elements.join() === 'sectiondiv' && f.content.includes(`<taskbody><${f.wrapped[0].container}><sectiondiv>`), JSON.stringify(f?.wrapped));
    check(`${id}: still invalid → no_runnable names the schema and the reason`, verdict.kind === 'no_runnable' && verdict.bySchema?.[0]?.schema === 'map' && /sectiondiv/.test(JSON.stringify(verdict.bySchema)), JSON.stringify(verdict));
  }
}

// ─── 4. Texts EN/ES ─────────────────────────────────────────────────────────
{
  check('outcomes EN', en('records.ruleTest.warningOutcomes.reject') === 'warns' && en('records.ruleTest.warningOutcomes.accepted') === 'did not warn');
  check('outcomes ES', es('records.ruleTest.warningOutcomes.reject') === 'avisa' && es('records.ruleTest.warningOutcomes.rejected') === 'avisó' && es('records.ruleTest.warningOutcomes.accept') === 'no avisa');
  check('warning message ES', es('records.ruleTest.warningMessage', { message: 'x' }) === 'Aviso de la regla: x');
  for (const k of ['rulePermissive', 'ruleStrict', 'ruleBoth', 'checkPermissive', 'checkStrict', 'checkBoth']) {
    const e = en(`records.ruleTest.causeWarning.${k}`);
    const s = es(`records.ruleTest.causeWarning.${k}`);
    check(`causeWarning.${k} EN/ES`, e && s && !e.includes('records.') && !s.includes('records.') && e !== s);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
