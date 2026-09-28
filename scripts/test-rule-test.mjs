// Tests for Test rule (T2, T2b) -- plain Node, the real modules:
// src/prompts/ruleTestExamplesPrompt.js (prompt, response parsing,
// correction request), src/utils/ruleTestSkeleton.js (targets, schema
// choice, placement, assembly, structural check), src/utils/ruleTest.js
// (materialize, validation, runs, verdict, display) and analyzeRule of
// src/utils/ruleTestEngine.js. The schema structures are the real ones the
// backend serves (scripts/rule-test-fixtures/structures.json, dumped by
// backend/scripts/dump_rule_test_structures.py).
// Run: node scripts/test-rule-test.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import {
  buildRuleTestExamplesPrompt,
  buildCopyableTestPrompt,
  buildRuleTestCorrectionMessage,
  parseRuleTestResponse,
  ruleDependsOnTitle,
  RULE_TEST_USER_MESSAGE,
} from '../src/prompts/ruleTestExamplesPrompt.js';
import {
  displayText,
  exampleProblems,
  materializeExample,
  runExample,
  ruleTestVerdict,
  validateExample,
  xmlDisplayLines,
} from '../src/utils/ruleTest.js';
import {
  assembleExample,
  chooseTestSchemas,
  placeExample,
  ruleTargets,
} from '../src/utils/ruleTestSkeleton.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
import { checkExampleStructure, formatStructureProblem } from '../src/validation/schemaValidation.js';
import { exampleFailures, generateRuleTestExamples, missesRuleProblem } from '../src/utils/ruleTestRun.js';
import { ruleMatchExpressions, SKELETON_TITLE_TEXT } from '../src/utils/ruleTestSkeleton.js';
import XLSX from 'xlsx';
import { wrapRuleInSchemaContexts } from '../src/utils/ruleSchemaContext.js';
import { RULE_TEST_TEMPERATURE } from '../src/prompts/shared.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
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
  const json = JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url)));
  return { elements: new Set(json.elements), attributes: new Set(json.attributes) };
};
const vocabulary = vocabOf('schema-vocabulary-4-2.json');
const vocabulary301 = vocabOf('schema-vocabulary-3-0-1.json');
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (standard, schema) => STRUCTURES[`${standard}|${schema}`];

// A setup as useRuleTest builds it, from the real structures.
function setupFor(standard, ruleXml, schemas, schemaLocation = 'flat') {
  const targets = ruleTargets(ruleXml);
  const placements = {};
  for (const schema of schemas) {
    const structure = structureOf(standard, schema);
    placements[schema] = { structure, placement: placeExample(structure, targets) };
  }
  return { standard, schemaLocation, placements };
}
function testRun(ruleXml, examples, setup, { format = 'BREX-4.2', vocab = vocabulary } = {}) {
  const materialized = examples.map((ex) => materializeExample(ex, setup));
  const runs = materialized.map((ex) => runExample(ruleXml, format, ex, { vocabulary: vocab, parseXml }));
  return { materialized, runs, verdict: ruleTestVerdict(materialized, runs, analyzeRule(ruleXml, format, { parseXml })) };
}

const brdp = {
  identifier: 'BRDP-TEST-001',
  title: 'Use of the element <emphasis>',
  definition: 'Decide whether <emphasis> may be used.',
  proposal: 'El elemento <emphasis> no se utiliza.',
};
const EMPH = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>Do not use emphasis.</objectUse></structureObjectRule>';
const ETYPE = '<structureObjectRule id="BRDP-S1-00070"><objectPath allowedObjectFlag="2">//emphasis/@emphasisType</objectPath><objectUse>Only em01 and em02 are allowed.</objectUse><objectValue valueForm="single" valueAllowed="em01"/><objectValue valueForm="single" valueAllowed="em02"/></structureObjectRule>';

// ─── Skeletons (the real fixture) ───────────────────────────────────────────
{
  for (const [key, s] of Object.entries(STRUCTURES)) {
    const path = s.skeleton.path;
    const ok = path.every((name, i) => i === 0 || s.elements[path[i - 1]].children.includes(name));
    check(`skeleton ${key}: every link is a real parent/child pair`, ok, path.join('/'));
  }
  check('skeleton 4.2 proced', structureOf('S1000D 4.2', 'proced').skeleton.path.join('/') === 'dmodule/content/procedure/mainProcedure/proceduralStep/para');
  check('skeleton 4.2 descript', structureOf('S1000D 4.2', 'descript').skeleton.path.join('/') === 'dmodule/content/description/levelledPara/para');
  check('skeleton 3.0.1 proced (not 4.x names)', structureOf('S1000D 3.0.1', 'proced').skeleton.path.join('/') === 'dmodule/content/proced/mainfunc/step1/para');
  check('skeleton 3.0.1 descript', structureOf('S1000D 3.0.1', 'descript').skeleton.path.join('/') === 'dmodule/content/descript/para0/para');
  check('skeleton 4.2 ipd: no <para> chain, insertion at the body', structureOf('S1000D 4.2', 'ipd').skeleton.insertion === 'illustratedPartsCatalog');
}

// ─── What the rule checks ───────────────────────────────────────────────────
{
  const t = (path) => ruleTargets(`<structureObjectRule><objectPath>${path}</objectPath></structureObjectRule>`);
  check('targets: //emphasis', JSON.stringify(t('//emphasis').checked) === '["emphasis"]');
  check('targets: attribute → owner element', JSON.stringify(t('//emphasis/@emphasisType').checked) === '["emphasis"]');
  check('targets: predicate ignored', JSON.stringify(t('//proceduralStep[not(title)]').checked) === '["proceduralStep"]');
  check('targets: attribute with no owner → nothing', t('//@assyCode').checked.length === 0);
  const abs = t('/dmodule/content//thead');
  check('targets: absolute prefix', JSON.stringify(abs.absolutePrefixes) === '[["dmodule","content"]]' && abs.checked[0] === 'thead', JSON.stringify(abs));
  check('targets: union in parentheses', JSON.stringify(t('(/dmodule/content/procedure | /dmodule/content/description)/levelledPara').checked) === '["levelledPara"]');
  check('targets: escaped < in a predicate', JSON.stringify(t('//para[count(x) &lt; 3]').checked) === '["para"]');
}

// ─── Schema choice and placement ────────────────────────────────────────────
{
  // cards: which of the fixture's 4.2 schemas have each name (the same
  // information GET /api/schema-cards gives through variants[].schemas).
  const schemas42 = ['descript', 'proced', 'ipd'];
  const cardsFor = (names) =>
    Object.fromEntries(names.map((n) => [n, { variants: [{ schemas: schemas42.filter((s) => structureOf('S1000D 4.2', s).elements[n]) }] }]));
  const choose = (rule, contextSchemas = []) => {
    const targets = ruleTargets(rule);
    return chooseTestSchemas({ contextSchemas, documentSchemas: schemas42, cards: cardsFor([...targets.checked, 'dmodule']), targets });
  };
  check('schema choice: //emphasis → descript', choose(EMPH).testSchema === 'descript');
  check('schema choice: //proceduralStep → proced', choose('<structureObjectRule><objectPath>//proceduralStep</objectPath></structureObjectRule>').testSchema === 'proced');
  const scoped = choose(EMPH, ['proced']);
  check('schema choice: limited to proced → proced + descript', scoped.testSchema === 'proced' && scoped.otherSchema === 'descript', JSON.stringify(scoped));

  const place = (schema, rule) => placeExample(structureOf('S1000D 4.2', schema), ruleTargets(rule)).path.join('/');
  check('placement: //emphasis in proced → inside <para>', place('proced', EMPH) === 'dmodule/content/procedure/mainProcedure/proceduralStep/para');
  check('placement: //proceduralStep → inside <mainProcedure> (the accept example can leave it out)', place('proced', '<structureObjectRule><objectPath>//proceduralStep</objectPath></structureObjectRule>') === 'dmodule/content/procedure/mainProcedure');
  check('placement: //thead → inside <levelledPara> (a table cannot sit in <para>)', place('descript', '<structureObjectRule><objectPath>/dmodule/content//thead</objectPath></structureObjectRule>') === 'dmodule/content/description/levelledPara');
  check('placement: /dmodule/identAndStatusSection/… → inside <dmodule>', place('descript', '<structureObjectRule><objectPath>/dmodule/identAndStatusSection/dmAddress/dmIdent/dmCode/@modelIdentCode</objectPath></structureObjectRule>') === 'dmodule');
  const p = placeExample(structureOf('S1000D 4.2', 'proced'), ruleTargets(EMPH));
  check('placement: allowed children of <para> listed', p.allowedChildren.includes('emphasis') && !p.allowedChildren.includes('warning'));
}

// ─── Assembly ───────────────────────────────────────────────────────────────
{
  const structure = structureOf('S1000D 3.0.1', 'descript');
  const placement = placeExample(structure, ruleTargets(EMPH));
  const master = assembleExample({ standard: 'S1000D 3.0.1', schema: 'descript', schemaLocation: 'master', placement, content: 'Torque the <emphasis>bolt</emphasis>.' });
  check('assembly: xsi:noNamespaceSchemaLocation in the project form (master)', master.xml.includes('xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/descriptSchema.xsd"'), master.xml);
  const flat = assembleExample({ standard: 'S1000D 4.2', schema: 'proced', schemaLocation: 'flat', placement: placeExample(structureOf('S1000D 4.2', 'proced'), ruleTargets(EMPH)), content: 'Remove the panel.' });
  check('assembly: flat URL', flat.xml.includes('S1000D_4-2/xml_schema_flat/proced.xsd'));
  check('assembly: well-formed and rooted at <dmodule>', parseXml(flat.xml).documentElement.nodeName === 'dmodule');
  check('assembly: the insertion point holds exactly the content (no added whitespace for string(.) checks)', parseXml(flat.xml).getElementsByTagName('para')[0].textContent === 'Remove the panel.');
  check('assembly: skeleton node paths', flat.skeletonNodePaths.at(-1) === '/dmodule[1]/content[1]/procedure[1]/mainProcedure[1]/proceduralStep[1]/para[1]', JSON.stringify(flat.skeletonNodePaths));
  check('assembly: xlink declared only when used', !flat.xml.includes('xmlns:xlink') && assembleExample({ standard: 'S1000D 4.2', schema: 'proced', placement: placeExample(structureOf('S1000D 4.2', 'proced'), ruleTargets(EMPH)), content: '<dmRef xlink:href="x"/>' }).xml.includes('xmlns:xlink'));
}

// ─── Structural check (the cases of the first real run) ─────────────────────
{
  const proced = structureOf('S1000D 4.2', 'proced');
  const problems = (xml) => checkExampleStructure(parseXml(xml), proced);
  const warn = problems('<dmodule><content><procedure><mainProcedure><proceduralStep><warning><content>Hot</content></warning></proceduralStep></mainProcedure></procedure></content></dmodule>');
  check('structure: <content> is not allowed inside <warning>', warn.some((p) => p.kind === 'notAllowed' && p.element === 'content' && p.parent === 'warning'), JSON.stringify(warn));
  const note = problems('<dmodule><content><procedure><mainProcedure><proceduralStep><note emphasisType="em01"><notePara>x</notePara></note></proceduralStep></mainProcedure></procedure></content></dmodule>');
  check('structure: @emphasisType does not exist on <note>', note.some((p) => p.kind === 'unknownAttribute' && p.attribute === 'emphasisType' && p.element === 'note'), JSON.stringify(note));
  const step = problems('<dmodule><content><procedure><step><para>x</para></step></procedure></content></dmodule>');
  check('structure: <step> does not exist in proced', step.some((p) => p.kind === 'unknownElement' && p.element === 'step'), JSON.stringify(step));
  const good = problems('<dmodule><content><procedure><mainProcedure><proceduralStep><para>Apply <emphasis emphasisType="em01">sealant</emphasis>.</para></proceduralStep></mainProcedure></procedure></content></dmodule>');
  check('structure: a correct procedural step → no problem', good.length === 0, JSON.stringify(good));
  const xlink = problems('<dmodule xmlns:xlink="http://www.w3.org/1999/xlink"><content><procedure><mainProcedure><proceduralStep><para><dmRef xlink:href="x"><dmRefIdent/></dmRef></para></proceduralStep></mainProcedure></procedure></content></dmodule>');
  check('structure: xlink:href checked by local name (declared on dmRef)', xlink.length === 0, JSON.stringify(xlink));

  // The same through materialize + validate, and in English for the correction.
  const setup = setupFor('S1000D 4.2', EMPH, ['proced']);
  const ex = materializeExample({ label: 'bad', expected: 'accept', schema: 'proced', content: '<warning><content>Hot</content></warning>' }, setup);
  const v = validateExample(ex.xml, vocabulary, parseXml, ex.structure);
  check('validate: structural problems make the example not runnable', !v.runnable && v.structure.length >= 2, JSON.stringify(v.structure));
  const english = exampleProblems(v, { standard: 'S1000D 4.2', schema: 'proced' });
  check('problems in English: warning inside para', english.includes('<warning> is not allowed inside <para>'), JSON.stringify(english));
  check('problems in English: content inside warning', english.includes('<content> is not allowed inside <warning>'), JSON.stringify(english));
  const unknown = validateExample(materializeExample({ label: 'x', expected: 'accept', schema: 'proced', content: '<step>x</step>' }, setup).xml, vocabulary, parseXml, setup.placements.proced.structure);
  check('validate: an unknown name is reported once (vocabulary), not again as "does not exist in proced"', unknown.names.notFound.includes('<step>') && !unknown.structure.some((p) => p.element === 'step'), JSON.stringify(unknown));
  const offered = materializeExample({ label: 'x', expected: 'accept', schema: 'fault', content: 'x' }, setup);
  const run = runExample(EMPH, 'BREX-4.2', offered, { vocabulary, parseXml });
  check('an example of a schema that was not offered is not run', run.result === null && run.validation.unknownSchema === 'fault');
}

// ─── analyzeRule ────────────────────────────────────────────────────────────
{
  const a = (xml, format = 'BREX-4.2') => analyzeRule(xml, format, { parseXml });
  check('analyze: //emphasis executable', a(EMPH).status === 'executable');
  const doc = a("<structureObjectRule><objectPath allowedObjectFlag=\"0\">document('other.xml')//emphasis</objectPath></structureObjectRule>");
  check('analyze: document() → not executable, with the reason', doc.status === 'not_executable' && doc.reason?.code === 'external_document' && doc.reason.params.fn === 'document()', JSON.stringify(doc));
  check('analyze: only nonContextRule → not executable', a('<nonContextRule id="x"><simplePara>Text</simplePara></nonContextRule>').status === 'not_executable');
  const partial = a(`<nonContextRule id="n1"><simplePara>Text</simplePara></nonContextRule>${EMPH}`);
  check('analyze: nonContextRule next to a rule → partial, says which part', partial.status === 'partial' && partial.reason?.code === 'parts' && partial.parts[0]?.ruleId === 'n1' && partial.parts[0].reason.code === 'non_context_rule', JSON.stringify(partial));
  const bool = a('<structureObjectRule><objectPath allowedObjectFlag="2">//updateCode[@x] and (//zoneSpec or //zone)</objectPath></structureObjectRule>');
  check('analyze: a boolean objectPath is not a path', bool.status === 'not_executable' && bool.reason?.code === 'path_not_nodes' && bool.reason.params.kind === 'boolean', JSON.stringify(bool));
  check('analyze: unknown format', a(EMPH, 'XSD-1.1').status === 'not_executable');
  check('analyze: XPath syntax error', a('<structureObjectRule><objectPath>//&lt;emphasis&gt;</objectPath></structureObjectRule>').reason?.code === 'xpath_error');
  check('analyze: mandatory-node rule is executable (examples are whole documents)', a('<objrule><objpath objappl="1">//dmodule/content</objpath></objrule>', 'BREX-3.0.1').status === 'executable');
  check('analyze: absolute path to another root is still executable (the schema choice follows the root)', a('<structureObjectRule><objectPath allowedObjectFlag="0">/pm/content//dmRef</objectPath></structureObjectRule>').status === 'executable');
}

// ─── Prompt ─────────────────────────────────────────────────────────────────
{
  const setup = setupFor('S1000D 4.2', EMPH, ['descript']);
  const placements = [{ schema: 'descript', role: 'rule', ...setup.placements.descript.placement }];
  const p = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: EMPH, placements });
  check('prompt: contains the rule verbatim', p.includes(EMPH));
  check('prompt: no explanation asked (describeRule gives it, T3b)', !p.includes('"explanation"'));
  check('prompt: proposalMismatch field, marked as an indication', p.includes('"proposalMismatch": null when the rule implements') && p.includes('It is only an indication'));
  check('prompt: the application builds the document; only the content', p.includes('Write\nONLY that content'));
  check('prompt: insertion point with the skeleton path', p.includes('your content goes directly inside <para>, at\n  dmodule/content/description/levelledPara/para.'), p);
  check('prompt: allowed children of the insertion point', /Allowed directly inside <para> in this schema: .*emphasis/.test(p));
  check('prompt: no text in references/containers', p.includes('Never put text directly inside an element that only references or groups') && p.includes('<dmRef>'));
  check('prompt: general rule → the chosen schema', p.includes('every example uses the "descript" schema'));
  check('prompt: output uses content', p.includes('"content": "…"') && !p.includes('"xml": "…"'));
  check('prompt: user message', buildCopyableTestPrompt(p) === `${p}\n\n${RULE_TEST_USER_MESSAGE}`);
  check('temperature constant', RULE_TEST_TEMPERATURE === 0.5);

  const proced = wrapRuleInSchemaContexts(ETYPE, 'BREX-4.2', 'S1000D 4.2', ['proced']);
  const s2 = setupFor('S1000D 4.2', proced, ['proced', 'descript']);
  const pc = buildRuleTestExamplesPrompt({
    brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: proced, contextSchemas: ['proced'],
    placements: [{ schema: 'proced', role: 'rule', ...s2.placements.proced.placement }, { schema: 'descript', role: 'other', ...s2.placements.descript.placement }],
  });
  check('prompt: context rule → proced placement', pc.includes('schema "proced": your content goes directly inside <para>, at\n  dmodule/content/procedure/mainProcedure/proceduralStep/para.'), pc);
  check('prompt: context rule → third example of descript, expected accept', pc.includes('Add a third example of the descript schema ("schema": "descript",\n"expected": "accept")'), pc);

  const facts = [{ name: 'emphasis', entry: { variants: [{ schemas: ['descript'], attributes: [{ name: 'emphasisType', required: false, enum: ['em01', 'em02'] }], children: [], resolved: true }], parents: ['para'] } }];
  const pf = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: EMPH, placements, schemaFacts: facts });
  check('prompt: schema facts block', pf.includes('SCHEMA FACTS') && pf.includes('<emphasis>'));
  check('prompt: without facts, never invent a name', p.includes('never invent a name') && !p.includes('SCHEMA FACTS'));

  const msg = buildRuleTestCorrectionMessage([{ index: 1, label: 'Hot surface', problems: ['<content> is not allowed inside <warning>', '@emphasisType does not exist on <warning>'] }]);
  check('correction message: lists each problem of each example', msg.includes('Example 2 ("Hot surface"):\n- <content> is not allowed inside <warning>\n- @emphasisType does not exist on <warning>'), msg);
  check('correction message: same order, change only the content', msg.includes('the same examples in') && msg.includes('change only the\n"content"'), msg);
}

// ─── Response parsing ───────────────────────────────────────────────────────
{
  const good = '{"explanation":"Prohíbe <emphasis>.","proposalMismatch":null,"examples":[{"label":"ok","expected":"accept","schema":"descript","content":"a"},{"label":"bad","expected":"reject","schema":"descript","content":"<emphasis>a</emphasis>"}]}';
  const r = parseRuleTestResponse(good);
  check('parse: valid JSON with content', r.ok && r.examples.length === 2 && r.examples[1].content === '<emphasis>a</emphasis>' && r.proposalMismatch === null, JSON.stringify(r));
  check('parse: proposalMismatch text kept', parseRuleTestResponse(good.replace('"proposalMismatch":null', '"proposalMismatch":"No implementa la Proposal."')).proposalMismatch === 'No implementa la Proposal.');
  check('parse: fenced JSON', parseRuleTestResponse('```json\n' + good + '\n```').ok);
  const broken = parseRuleTestResponse('{"explanation": "x", "examples": [ {"label": "a", ');
  check('parse: broken JSON → error', !broken.ok && /not valid JSON/.test(broken.error), JSON.stringify(broken));
  check('parse: missing content', /has no "content"/.test(parseRuleTestResponse('{"explanation":"x","examples":[{"expected":"accept"}]}').error || ''));
  check('parse: old "xml" field still read as content', parseRuleTestResponse('{"explanation":"x","examples":[{"expected":"accept","xml":"<a/>"}]}').examples[0].content === '<a/>');
}

// ─── Edge cases of the encargo ──────────────────────────────────────────────
{
  // @emphasisType em01/em02 limited to proced
  const rule = wrapRuleInSchemaContexts(ETYPE, 'BREX-4.2', 'S1000D 4.2', ['proced']);
  const setup = setupFor('S1000D 4.2', rule, ['proced', 'descript']);
  const examples = [
    { label: 'em01 in a step', expected: 'accept', schema: 'proced', content: 'Apply <emphasis emphasisType="em01">sealant</emphasis> to the joint.' },
    { label: 'em03 in a step', expected: 'reject', schema: 'proced', content: 'Apply <emphasis emphasisType="em03">sealant</emphasis> to the joint.' },
    { label: 'em03 in a description', expected: 'accept', schema: 'descript', content: 'The <emphasis emphasisType="em03">seal</emphasis> is grey.' },
  ];
  const { materialized, runs, verdict } = testRun(rule, examples, setup);
  check('proced-only: examples built on proceduralStep/para/emphasis', materialized[0].xml.includes('<proceduralStep>') && materialized[0].xml.includes('<para>'));
  check('proced-only: em03 rejected with the rule message', runs[1].result?.status === 'rejected' && runs[1].result.violations[0].message === 'Only em01 and em02 are allowed.', JSON.stringify(runs[1]));
  check('proced-only: descript example accepted ("does not apply")', runs[2].result?.status === 'accepted' && runs[2].result.outOfScopeSchemas[0] === 'proced', JSON.stringify(runs[2].result));
  check('proced-only: verdict correct', verdict.kind === 'correct', JSON.stringify(verdict));
  // Display: skeleton dimmed, content highlighted, the attribute selected.
  const lines = xmlDisplayLines(materialized[1].xml, runs[1].result.selectedNodePaths, parseXml, materialized[1].skeletonNodePaths);
  const segs = lines.flatMap((l) => l.segments);
  check('display: skeleton tags marked', segs.some((s) => s.skeleton && s.text === '<proceduralStep') && segs.every((s) => !s.text.startsWith('<emphasis') || !s.skeleton));
  check('display: only the attribute highlighted', JSON.stringify(segs.filter((s) => s.highlight).map((s) => s.text)) === JSON.stringify(['emphasisType="em03"']));
  const text = displayText(lines);
  check('display: copied text keeps its indentation', text.split('\n')[5].startsWith('          <para>') && text.split('\n')[0].startsWith('<dmodule'), text);
}
{
  // //emphasis flag 0, general, 4.2: works as before, now on a real skeleton
  const setup = setupFor('S1000D 4.2', EMPH, ['descript']);
  const { materialized, runs, verdict } = testRun(EMPH, [
    { label: 'plain', expected: 'accept', schema: null, content: 'Remove the access panel.' },
    { label: 'emphasised', expected: 'reject', schema: null, content: 'Do <emphasis>not</emphasis> touch the fan.' },
  ], setup);
  check('//emphasis: schema filled in with the only offered one', materialized[0].schema === 'descript');
  check('//emphasis: <emphasis> selected inside the real skeleton', runs[1].result.selectedNodePaths[0] === '/dmodule[1]/content[1]/description[1]/levelledPara[1]/para[1]/emphasis[1]', JSON.stringify(runs[1].result));
  check('//emphasis: verdict correct', verdict.kind === 'correct', JSON.stringify(verdict));
}
{
  // 3.0.1: its own skeletons, not 4.x ones
  const rule = '<objrule><objpath objappl="0">//emphasis</objpath><objuse>No emphasis.</objuse></objrule>';
  const setup = setupFor('S1000D 3.0.1', rule, ['descript']);
  const { materialized, verdict } = testRun(rule, [
    { label: 'plain', expected: 'accept', schema: null, content: 'The pump is on the left.' },
    { label: 'emphasised', expected: 'reject', schema: null, content: 'The <emphasis>pump</emphasis> is on the left.' },
  ], setup, { format: 'BREX-3.0.1', vocab: vocabulary301 });
  check('3.0.1: skeleton para0/para, no levelledPara', materialized[0].xml.includes('<para0>') && !materialized[0].xml.includes('levelledPara'));
  check('3.0.1: verdict correct', verdict.kind === 'correct', JSON.stringify(verdict));
}
{
  // document(): the reason comes from analyzeRule, whatever the examples
  const rule = "<structureObjectRule><objectPath allowedObjectFlag=\"0\">document('other.xml')//emphasis</objectPath></structureObjectRule>";
  const setup = setupFor('S1000D 4.2', rule, ['descript']);
  const { runs, verdict } = testRun(rule, [
    { label: 'a', expected: 'accept', schema: null, content: 'a' },
    { label: 'b', expected: 'reject', schema: null, content: '<emphasis>b</emphasis>' },
  ], setup);
  check('document(): verdict not executable with the reason', verdict.kind === 'not_executable' && verdict.reason?.code === 'external_document', JSON.stringify(verdict));
  check('document(): examples still validated and kept', runs.every((r) => r.validation.wellFormed));
  const noneRunnable = ruleTestVerdict([{ expected: 'accept' }], [{ validation: { runnable: false }, result: null, matches: null }], analyzeRule(rule, 'BREX-4.2', { parseXml }));
  check('document(): the reason shows even when no example could run', noneRunnable.kind === 'not_executable', JSON.stringify(noneRunnable));
}
{
  // Inconclusive / incorrect / no runnable, on real skeletons
  const setup = setupFor('S1000D 4.2', EMPH, ['descript']);
  const inc = testRun(EMPH, [
    { label: 'a', expected: 'accept', schema: null, content: 'a' },
    { label: 'b', expected: 'reject', schema: null, content: 'b' },
  ], setup);
  check('inconclusive: nothing selected', inc.verdict.kind === 'inconclusive' && inc.verdict.why === 'nothing_selected', JSON.stringify(inc.verdict));
  const paraRule = '<structureObjectRule><objectPath allowedObjectFlag="0">//para</objectPath></structureObjectRule>';
  const strict = testRun(paraRule, [
    { label: 'a', expected: 'accept', schema: null, content: '<para>a</para>' },
    { label: 'b', expected: 'reject', schema: null, content: '<para>b</para>' },
  ], setupFor('S1000D 4.2', paraRule, ['descript']));
  check('placement for //para: inside <levelledPara>', strict.materialized[0].insertion === 'levelledPara');
  check('incorrect: the rule rejected an example meant to comply (strict)', strict.verdict.kind === 'incorrect' && strict.verdict.strict, JSON.stringify(strict.verdict));
  const bad = testRun(EMPH, [
    { label: 'a', expected: 'accept', schema: null, content: 'a<pokemon/>' },
    { label: 'b', expected: 'reject', schema: null, content: '<emphasis>b' },
  ], setup);
  check('invalid examples: not run, verdict no_runnable', bad.runs.every((r) => r.result === null) && bad.verdict.kind === 'no_runnable', JSON.stringify(bad.verdict));
  check('display: malformed XML → null', xmlDisplayLines('<para><emphasis>b</para>', [], parseXml) === null);
}

// ─── T3: what is recorded, the indicator state and the Verify warning ──────
{
  const { verdictToTestRecord } = await import('../src/utils/ruleTestReasons.js');
  const { ruleTestStatus, verifyWarning } = await import('../src/utils/ruleTestStatus.js');
  const { ruleXmlHash } = await import('../src/utils/ruleHash.js');
  const { createHash } = await import('node:crypto');

  check('record: correct → passed, no reason', JSON.stringify(verdictToTestRecord({ kind: 'correct' })) === '{"result":"passed","reason":null}');
  check('record: incorrect → failed with direction',
    JSON.stringify(verdictToTestRecord({ kind: 'incorrect', permissive: true, strict: false })) ===
      '{"result":"failed","reason":{"code":"test_incorrect","params":{"permissive":true,"strict":false}}}');
  check('record: nothing selected → inconclusive', verdictToTestRecord({ kind: 'inconclusive', why: 'nothing_selected' }).reason.code === 'test_nothing_selected');
  check('record: missing expectation → inconclusive', verdictToTestRecord({ kind: 'inconclusive', why: 'missing_expectation' }).reason.code === 'test_missing_expectation');
  check('record: no runnable example → inconclusive', JSON.stringify(verdictToTestRecord({ kind: 'no_runnable' })) === '{"result":"inconclusive","reason":{"code":"test_no_runnable","params":{}}}');
  const docReason = { code: 'external_document', params: { fn: 'document()' } };
  check('record: not executable keeps the engine reason', JSON.stringify(verdictToTestRecord({ kind: 'not_executable', reason: docReason })) === JSON.stringify({ result: 'not_executable', reason: docReason }));
  check('record: no verdict → nothing', verdictToTestRecord(null) === null);

  for (const text of ['', EMPH, 'ñ <x a="é"/> 😀', 'x'.repeat(1000)]) {
    check(`hash = backend's SHA-256 (${text.length} chars)`, ruleXmlHash(text) === createHash('sha256').update(text, 'utf8').digest('hex'));
  }

  const approval = (fields) => ({ rule_xml: EMPH, status: 'pending_review', last_test_result: null, last_test_reason: null, last_test_at: null, last_test_up_to_date: null, ...fields });
  const at = '2026-09-28T10:00:00Z';
  check('status: never tested', ruleTestStatus(approval({})).kind === 'not_tested');
  check('status: passed', ruleTestStatus(approval({ last_test_result: 'passed', last_test_at: at, last_test_up_to_date: true })).kind === 'passed');
  check('status: outdated wins over the result', ruleTestStatus(approval({ last_test_result: 'passed', last_test_at: at, last_test_up_to_date: false })).kind === 'outdated');
  check('status: failed keeps its reason', ruleTestStatus(approval({ last_test_result: 'failed', last_test_reason: { code: 'test_incorrect', params: { permissive: true } }, last_test_up_to_date: true })).reason.code === 'test_incorrect');

  const w = (fields, format = 'BREX-4.2', xml = EMPH) => verifyWarning(approval({ rule_xml: xml, ...fields }), format, { parseXml });
  check('verify: passed and up to date → no dialog', w({ last_test_result: 'passed', last_test_up_to_date: true }) === null);
  check('verify: never tested → not_tested, Test now', JSON.stringify(w({})) === '{"kind":"not_tested","reason":null,"canTestNow":true}');
  check('verify: outdated → outdated, Test now', w({ last_test_result: 'passed', last_test_up_to_date: false }).kind === 'outdated');
  const failedW = w({ last_test_result: 'failed', last_test_reason: { code: 'test_incorrect', params: { permissive: true, strict: false } }, last_test_up_to_date: true });
  check('verify: failed → reason + Test now', failedW.kind === 'failed' && failedW.reason.code === 'test_incorrect' && failedW.canTestNow);
  check('verify: inconclusive → Test now', w({ last_test_result: 'inconclusive', last_test_reason: { code: 'test_nothing_selected', params: {} }, last_test_up_to_date: true }).kind === 'inconclusive');
  const neW = w({ last_test_result: 'not_executable', last_test_reason: docReason, last_test_up_to_date: true });
  check('verify: recorded not executable → no Test now', neW.kind === 'not_executable' && !neW.canTestNow && neW.reason.code === 'external_document');
  const docRule = "<structureObjectRule><objectPath allowedObjectFlag=\"0\">document('other.xml')//emphasis</objectPath></structureObjectRule>";
  const untestedDoc = w({}, 'BREX-4.2', docRule);
  check('verify: never tested but not executable → explained, no Test now', untestedDoc.kind === 'not_executable' && !untestedDoc.canTestNow && untestedDoc.reason.code === 'external_document', JSON.stringify(untestedDoc));
  check('verify: unknown format (not testable) → no dialog', w({}, 'XSD-1.1') === null);
}

// ─── T4: DITA Schematron on topic-type skeletons ────────────────────────────
{
  const DITA = 'DITA 1.3 Xpath2.0';
  const vocabDita = vocabOf('schema-vocabulary-dita.json');
  const TYPES = ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'];
  // What the backend answers in element_schemas: the types whose graph has
  // each name (the fixture has the topic, task and map graphs).
  const elementSchemasFor = (names) =>
    Object.fromEntries(names.map((n) => [n, ['topic', 'task', 'map'].filter((t) => structureOf(DITA, t).elements[n])]));
  const NOTE = '<sch:pattern id="p-note"><sch:rule context="note"><sch:assert id="N1" role="error" test="@type">Every note must declare @type.</sch:assert></sch:rule></sch:pattern>';
  const NOTE_WRONG = NOTE.replace('test="@type"', 'test="not(@type)"');
  const STEP = '<pattern><rule context="step"><assert id="S1" test="count(cmd) = 1">One command per step.</assert></rule></pattern>';
  const ROOT_LANG = '<sch:pattern><sch:rule context="/*[not(parent::*)]"><sch:assert id="L" test="@xml:lang">Declare xml:lang.</sch:assert></sch:rule></sch:pattern>';
  const SHORTDESC = '<sch:pattern><sch:rule context="shortdesc"><sch:assert id="SD" test="string-length(.) le 80">Short description too long.</sch:assert></sch:rule></sch:pattern>';

  check('T4 targets: Schematron → contexts only', JSON.stringify(ruleTargets(STEP)) === JSON.stringify({ checked: ['step'], absolutePrefixes: [], wholeDocument: false }), JSON.stringify(ruleTargets(STEP)));
  check('T4 targets: note', ruleTargets(NOTE).checked.join() === 'note');
  check('T4 targets: root context → whole document', ruleTargets(ROOT_LANG).wholeDocument === true);
  check('T4 targets: entities decoded in the context', ruleTargets('<rule context="p[. = &apos;x&apos;]"><assert test="1">x</assert></rule>').checked.join() === 'p');

  const choose = (rule) => {
    const targets = ruleTargets(rule);
    return chooseTestSchemas({ documentSchemas: TYPES, cards: {}, elementSchemas: elementSchemasFor(targets.checked), targets }).testSchema;
  };
  check('T4 type: note → topic', choose(NOTE) === 'topic');
  check('T4 type: step → task', choose(STEP) === 'task');
  check('T4 type: cmd → task', choose('<rule context="cmd"><assert test="1">x</assert></rule>') === 'task');
  check('T4 type: topicref → map', choose('<rule context="topicref"><assert test="@href">x</assert></rule>') === 'map');
  check('T4 type: whole document → topic', choose(ROOT_LANG) === 'topic');

  const place = (rule, type) => placeExample(structureOf(DITA, type), ruleTargets(rule));
  check('T4 placement: note in topic/body', place(NOTE, 'topic').path.join('/') === 'topic/body');
  check('T4 placement: step → inside steps', place(STEP, 'task').path.join('/') === 'task/taskbody/steps');
  check('T4 placement: cmd → inside step', place('<rule context="cmd"><assert test="1">x</assert></rule>', 'task').path.join('/') === 'task/taskbody/steps/step');
  check('T4 placement: shortdesc → up a level, inside topic', place(SHORTDESC, 'topic').path.join('/') === 'topic', place(SHORTDESC, 'topic').path.join('/'));
  check('T4 placement: prolog → inside topic', place('<rule context="prolog"><assert test="copyright">x</assert></rule>', 'topic').insertion === 'topic');
  const whole = place(ROOT_LANG, 'topic');
  check('T4 placement: whole document', whole.path.length === 0 && whole.insertion === null && whole.root === 'topic' && whole.allowedChildren.includes('body'));

  const a = assembleExample({ standard: DITA, schema: 'topic', placement: place(NOTE, 'topic'), content: '<note type="caution">Close the valve.</note>' });
  check('T4 assembly: DITA root has no xsi', a.xml.startsWith('<topic>') && !a.xml.includes('xsi'), a.xml);
  check('T4 assembly: whole document is the content', assembleExample({ standard: DITA, schema: 'topic', placement: whole, content: ' <topic id="t"/> ' }).xml === '<topic id="t"/>');

  const structure = structureOf(DITA, 'topic');
  const problems = (xml) => checkExampleStructure(parseXml(xml), structure).map((p) => formatStructureProblem(p, 'topic'));
  check('T4 structure: valid topic', problems('<topic id="t"><title>x</title><body><note type="tip"><p>x</p></note></body></topic>').length === 0);
  check('T4 structure: <cmd> is not in a topic', problems('<topic><body><cmd>x</cmd></body></topic>').includes('<cmd> does not exist in the topic schema'), problems('<topic><body><cmd>x</cmd></body></topic>').join());
  check('T4 structure: <title> not inside <p>', problems('<topic><body><p><title>x</title></p></body></topic>').includes('<title> is not allowed inside <p>'));
  check('T4 structure: @frame not on <note>', problems('<topic><body><note frame="all">x</note></body></topic>').includes('@frame does not exist on <note>'));
  check('T4 structure: xml:lang never flagged', problems('<topic xml:lang="en"><body/></topic>').length === 0);

  const setupNote = setupFor(DITA, NOTE, ['topic']);
  const examples = [
    { label: 'typed note', expected: 'accept', schema: 'topic', content: '<note type="caution"><p>Isolate the bilge pump before removal.</p></note>' },
    { label: 'untyped note', expected: 'reject', schema: 'topic', content: '<note><p>Isolate the bilge pump before removal.</p></note>' },
  ];
  const good = testRun(NOTE, examples, setupNote, { format: 'SCH-DITA', vocab: vocabDita });
  check('T4 run: note rule correct', good.verdict.kind === 'correct', JSON.stringify(good.verdict));
  check('T4 run: rejected example carries the rule message', good.runs[1].result.violations[0].message === 'Every note must declare @type.');
  check('T4 run: highlighted node path', good.runs[1].result.violations[0].nodePaths[0] === '/topic[1]/body[1]/note[1]');
  const wrong = testRun(NOTE_WRONG, examples, setupFor(DITA, NOTE_WRONG, ['topic']), { format: 'SCH-DITA', vocab: vocabDita });
  check('T4 run: inverted assert → incorrect in both directions', wrong.verdict.kind === 'incorrect' && wrong.verdict.permissive && wrong.verdict.strict, JSON.stringify(wrong.verdict));

  const stepRun = testRun(STEP, [
    { label: 'one cmd', expected: 'accept', schema: 'task', content: '<step><cmd>Remove the four bolts.</cmd></step>' },
    { label: 'two cmds', expected: 'reject', schema: 'task', content: '<step><cmd>Remove the bolts.</cmd><cmd>Lift the cover.</cmd></step>' },
  ], setupFor(DITA, STEP, ['task']), { format: 'SCH-DITA', vocab: vocabDita });
  check('T4 run: step rule on the task skeleton', stepRun.verdict.kind === 'correct' && stepRun.materialized[0].xml.startsWith('<task>'), JSON.stringify(stepRun.verdict));

  const lang = testRun(ROOT_LANG, [
    { label: 'with lang', expected: 'accept', schema: 'topic', content: '<topic id="t" xml:lang="en-GB"><title>Bilge pump</title><body><p>Check the seals.</p></body></topic>' },
    { label: 'without lang', expected: 'reject', schema: 'topic', content: '<topic id="t"><title>Bilge pump</title><body><p>Check the seals.</p></body></topic>' },
  ], setupFor(DITA, ROOT_LANG, ['topic']), { format: 'SCH-DITA', vocab: vocabDita });
  check('T4 run: whole-document rule', lang.verdict.kind === 'correct' && lang.materialized[1].skeletonNodePaths.length === 0, JSON.stringify(lang.verdict));

  const warnRule = NOTE.replace('role="error"', 'role="warning"');
  const warnRun = testRun(warnRule, examples, setupFor(DITA, warnRule, ['topic']), { format: 'SCH-DITA', vocab: vocabDita });
  check('T4 run: role="warning" never rejects', warnRun.runs[1].result.status === 'accepted' && warnRun.runs[1].result.warnings.length === 1);
  check('  so the reject example is not met', warnRun.verdict.kind === 'incorrect');

  const prompt = buildRuleTestExamplesPrompt({
    brdp: { identifier: 'BRDP-D1-00001', title: 'Note types', definition: 'Notes declare their type.', proposal: 'Every note declares @type.' },
    standard: DITA,
    format: 'SCH-DITA',
    ruleXml: NOTE,
    placements: [{ schema: 'topic', role: 'rule', ...setupNote.placements.topic.placement }],
  });
  check('T4 prompt: topic type wording', prompt.includes('Every example is a DITA topic ("schema": "topic").') && prompt.includes('- topic type "topic": your content goes directly inside <body>, at\n  topic/body.'), prompt);
  check('T4 prompt: ship or aircraft content', prompt.includes('a ship or aircraft maintenance manual'));
  check('T4 prompt: no S1000D reference elements', !prompt.includes('dmRef'));
  const wholePrompt = buildRuleTestExamplesPrompt({
    brdp: { identifier: 'BRDP-D1-00020', title: 'Language', definition: 'x', proposal: 'Declare xml:lang on the root.' },
    standard: DITA,
    format: 'SCH-DITA',
    ruleXml: ROOT_LANG,
    placements: [{ schema: 'topic', role: 'rule', ...whole }],
  });
  check('T4 prompt: whole document', wholePrompt.includes('your "content" is the whole DITA 1.3 Xpath2.0 document') && wholePrompt.includes('the complete\n  <topic> root element') && !wholePrompt.includes('never the document root'), wholePrompt);
  const { verifyWarning } = await import('../src/utils/ruleTestStatus.js');
  const approval = (fields) => ({ status: 'pending_review', last_test_result: null, last_test_reason: null, last_test_at: null, last_test_up_to_date: null, ...fields });
  check('T4 verify: DITA rule never tested → dialog with Test now', verifyWarning(approval({ rule_xml: NOTE }), 'SCH-DITA', { parseXml }).kind === 'not_tested');
  const docDita = '<sch:pattern><sch:rule context="map"><sch:assert test="doc-available(\'a.dita\')">x</sch:assert></sch:rule></sch:pattern>';
  const docW = verifyWarning(approval({ rule_xml: docDita }), 'SCH-DITA', { parseXml });
  check('T4 verify: doc() on the ditamap → not executable, explained', docW.kind === 'not_executable' && !docW.canTestNow && docW.reason.code === 'external_document', JSON.stringify(docW));
}

// ─── T4b: examples the rule never runs on, DITA topic titles ────────────────
{
  const DITA = 'DITA 1.3 Xpath2.0';
  const vocabDita = vocabOf('schema-vocabulary-dita.json');
  const NOTE = '<sch:pattern id="p-note"><sch:rule context="note"><sch:assert id="N1" role="error" test="@type">Every note must declare @type.</sch:assert></sch:rule></sch:pattern>';
  const topic = structureOf(DITA, 'topic');

  // Part 2: the topic's mandatory <title> in the skeleton.
  check('T4b skeleton: topic titled', JSON.stringify(topic.skeleton.titled) === '["topic"]', JSON.stringify(topic.skeleton));
  check('T4b skeleton: task titled', JSON.stringify(structureOf(DITA, 'task').skeleton.titled) === '["task"]');
  check('T4b skeleton: map not titled', structureOf(DITA, 'map').skeleton.titled.length === 0);
  check('T4b skeleton: S1000D never titled', (structureOf('S1000D 4.2', 'descript').skeleton.titled || []).length === 0);
  check('T4b skeleton: <title> allowed inside <topic> (DITA cards)', topic.elements.topic.children.includes('title') && topic.elements.title !== undefined);
  const notePlacement = placeExample(topic, ruleTargets(NOTE));
  check('T4b placement: titled path elements', JSON.stringify(notePlacement.titled) === '["topic"]', JSON.stringify(notePlacement));
  const titleRule = '<sch:pattern><sch:rule context="topic/title"><sch:assert id="T" test="string-length(.) le 60">Title too long.</sch:assert></sch:rule></sch:pattern>';
  check('T4b placement: a rule on <title> gets no skeleton title', placeExample(topic, ruleTargets(titleRule)).titled.length === 0);
  const whole = placeExample(topic, ruleTargets('<sch:pattern><sch:rule context="/*"><sch:assert id="L" test="@xml:lang">x</sch:assert></sch:rule></sch:pattern>'));
  check('T4b placement: whole document → the LLM writes the root title', JSON.stringify(whole.titled) === '["topic"]');
  const assembled = assembleExample({ standard: DITA, schema: 'topic', placement: notePlacement, content: '<note type="tip"><p>Close the valve.</p></note>' });
  check('T4b assembly: title first in the topic', assembled.xml === `<topic>\n  <title>${SKELETON_TITLE_TEXT}</title>\n  <body><note type="tip"><p>Close the valve.</p></note></body>\n</topic>`, assembled.xml);
  check('T4b assembly: title is skeleton', assembled.skeletonNodePaths.includes('/topic[1]/title[1]') && assembled.skeletonNodePaths.includes('/topic[1]/title[1]/text()'));
  const shortdescPlacement = placeExample(topic, ruleTargets('<sch:pattern><sch:rule context="shortdesc"><sch:assert id="SD" test="1">x</sch:assert></sch:rule></sch:pattern>'));
  const inline = assembleExample({ standard: DITA, schema: 'topic', placement: shortdescPlacement, content: '<shortdesc>Short.</shortdesc>' });
  check('T4b assembly: title inline before the content at the insertion point', inline.xml === `<topic><title>${SKELETON_TITLE_TEXT}</title><shortdesc>Short.</shortdesc></topic>`, inline.xml);
  check('T4b assembly: the assembled topic passes the structural check', checkExampleStructure(parseXml(assembled.xml), topic).length === 0);
  const lines = xmlDisplayLines(assembled.xml, [], parseXml, assembled.skeletonNodePaths);
  const titleLine = lines.find((l) => l.segments.some((sg) => sg.text === SKELETON_TITLE_TEXT));
  check('T4b display: skeleton title text dimmed', titleLine && titleLine.segments.every((sg) => sg.skeleton), JSON.stringify(titleLine));
  const paraLines = xmlDisplayLines('<topic><body><p>Mine</p></body></topic>', [], parseXml, ['/topic[1]', '/topic[1]/body[1]']);
  check('T4b display: content text never dimmed', paraLines.find((l) => l.segments.some((sg) => sg.text === 'Mine')).segments.find((sg) => sg.text === 'Mine').skeleton === false);

  // Part 1: a reject example the rule never runs on.
  const setupNote = setupFor(DITA, NOTE, ['topic']);
  const exNoNote = [
    { label: 'note with type', expected: 'accept', schema: 'topic', content: '<note type="tip"><p>Close the valve.</p></note>' },
    { label: 'no note at all', expected: 'reject', schema: 'topic', content: '<p>Close the valve.</p>' },
  ];
  const miss = testRun(NOTE, exNoNote, setupNote, { format: 'SCH-DITA', vocab: vocabDita });
  const problem = missesRuleProblem(exNoNote[1], miss.runs[1], NOTE);
  check('T4b misses: message', problem === 'This example must contain a node matched by: `note`. Nothing in it matches, so the rule never runs.', problem);
  check('T4b misses: accept example never flagged', missesRuleProblem(exNoNote[0], miss.runs[0], NOTE) === null);
  const failures = exampleFailures(exNoNote, miss.materialized, miss.runs, { ruleXml: NOTE, standard: DITA });
  check('T4b failures: only the reject example', failures.length === 1 && failures[0].index === 1 && failures[0].problems[0] === problem, JSON.stringify(failures));
  const EMPH = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const brexMiss = testRun(EMPH, [{ label: 'r', expected: 'reject', schema: 'descript', content: 'No emphasis here.' }], setupFor('S1000D 4.2', EMPH, ['descript']));
  check('T4b misses: BREX path', missesRuleProblem({ expected: 'reject' }, brexMiss.runs[0], EMPH) === 'This example must contain a node matched by: `//emphasis`. Nothing in it matches, so the rule never runs.');
  const docRule = '<structureObjectRule><objectPath allowedObjectFlag="0">document("x.xml")//a</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const docRun = testRun(docRule, [{ label: 'r', expected: 'reject', schema: 'descript', content: 'x' }], setupFor('S1000D 4.2', docRule, ['descript']));
  check('T4b misses: a not-executable run is never sent back', missesRuleProblem({ expected: 'reject' }, docRun.runs[0], docRule) === null);
  check('T4b match expressions: Schematron contexts, whitespace collapsed', JSON.stringify(ruleMatchExpressions('<rule context="a\n   //b"><assert test="1">x</assert></rule>')) === '["a //b"]');

  check('T4b title-dependent: *[title = …]', ruleDependsOnTitle(["*[title = ('A')]//table"]));
  check('T4b title-dependent: section[title]', ruleDependsOnTitle(['section[normalize-space(title) = "x"]/p']));
  check('T4b title-dependent: never @title, $title or a title step', !ruleDependsOnTitle(['p[@title]', 'p[$title = 1]', 'topic/title', 'fig[x:title]']));

  // The real template rule BRDP-EXT-00001 (DITA XPath 3.0): the title goes
  // on the table in the first answer, in a titled <section> after the
  // correction round.
  const wb = XLSX.read(fs.readFileSync(new URL('../public/brdp-template-dita-xpath3.xlsx', import.meta.url)));
  const ext1 = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).find((r) => r.ID === 'BRDP-EXT-00001');
  const DITA3 = 'DITA 1.3 Xpath3.0';
  check('T4b EXT-00001: target is the row', ruleTargets(ext1.Rule).checked.join() === 'row', JSON.stringify(ruleTargets(ext1.Rule)));
  const table = (title, cant) =>
    `<table>${title ? `<title>${title}</title>` : ''}<tgroup cols="3"><colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/><thead><row><entry colname="c1">Part</entry><entry colname="c2">Descripción</entry><entry colname="c3">Cant.</entry></row></thead><tbody><row><entry colname="c1">P-100</entry><entry colname="c2">Seal</entry>${cant ? `<entry colname="c3">${cant}</entry>` : ''}</row></tbody></tgroup></table>`;
  const onTable = (cant) => table('LISTA DE MATERIAL OBLIGATORIO', cant);
  const inSection = (cant) => `<section><title>LISTA DE MATERIAL OBLIGATORIO</title>${table('', cant)}</section>`;
  const first = JSON.stringify({ proposalMismatch: null, examples: [
    { label: 'quantity given', expected: 'accept', schema: 'topic', content: onTable('2') },
    { label: 'quantity missing', expected: 'reject', schema: 'topic', content: onTable('') },
  ] });
  const second = JSON.stringify({ proposalMismatch: null, examples: [
    { label: 'quantity given', expected: 'accept', schema: 'topic', content: inSection('2') },
    { label: 'quantity missing', expected: 'reject', schema: 'topic', content: inSection('') },
  ] });
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: ext1.Rule,
    format: 'SCH-DITA',
    standard: DITA3,
    schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00001', title: ext1.Title || '', definition: ext1.Definition || '', proposal: ext1.Proposal || '' },
    vocabulary: vocabDita,
    parseXml,
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      return asked.length === 1 ? first : second;
    },
    fetchSchemaCards: async (_std, names) => ({ cards: {}, document_schemas: ['topic', 'concept', 'task', 'reference', 'troubleshooting', 'map'], element_schemas: Object.fromEntries(names.map((n) => [n, ['topic', 'task', 'map'].filter((t) => structureOf(DITA, t).elements[n])])) }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
  });
  check('T4b EXT-00001: prompt says the rule depends on a title', asked[0].systemPrompt.includes('THE RULE DEPENDS ON A TITLE'));
  check('T4b EXT-00001: prompt never quotes a real title as the example', asked[0].systemPrompt.includes('<section><title>Parts list</title><table>…</table></section>'));
  check('T4b EXT-00001: one correction round asked', asked.length === 2 && asked[1].messages.at(-1).content.includes('This example must contain a node matched by: `*[title = ('), asked[1]?.messages.at(-1).content);
  check('T4b EXT-00001: correction names only the reject example', asked[1].messages.at(-1).content.includes('Example 2 ("quantity missing")') && !asked[1].messages.at(-1).content.includes('Example 1 '));
  check('T4b EXT-00001: fixed', result.status === 'ready' && result.correction.attempted === 1 && result.correction.fixed === 1, JSON.stringify(result.correction));
  check('T4b EXT-00001: reject example now in a titled section', result.examples[1].content.startsWith('<section><title>LISTA DE MATERIAL OBLIGATORIO</title><table>'));
  check('T4b EXT-00001: reject example rejected', result.runs[1].result.status === 'rejected' && result.runs[1].result.selectedNodePaths.length > 0, JSON.stringify(result.runs[1].result));
  check('T4b EXT-00001: topic title in the assembled document', result.examples[1].xml.startsWith(`<topic>\n  <title>${SKELETON_TITLE_TEXT}</title>`), result.examples[1].xml);
  const verdict = ruleTestVerdict(result.examples, result.runs, analyzeRule(ext1.Rule, 'SCH-DITA', { parseXml }));
  check('T4b EXT-00001: verdict correct', verdict.kind === 'correct', JSON.stringify(verdict));

  // Still nothing selected after the round → inconclusive, as before.
  const stubborn = await generateRuleTestExamples({
    ruleXml: ext1.Rule, format: 'SCH-DITA', standard: DITA3, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00001', title: '', definition: '', proposal: '' },
    vocabulary: vocabDita, parseXml,
    ask: async () => first,
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['topic'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
  });
  const stubbornVerdict = ruleTestVerdict(stubborn.examples, stubborn.runs, analyzeRule(ext1.Rule, 'SCH-DITA', { parseXml }));
  check('T4b EXT-00001: still nothing → 0 of 1 fixed, inconclusive', stubborn.correction.fixed === 0 && stubbornVerdict.kind === 'inconclusive', JSON.stringify({ c: stubborn.correction, v: stubbornVerdict }));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
