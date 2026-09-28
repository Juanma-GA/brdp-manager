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
  checkExampleStructure,
  chooseTestSchemas,
  placeExample,
  ruleTargets,
} from '../src/utils/ruleTestSkeleton.js';
import { analyzeRule } from '../src/utils/ruleTestEngine.js';
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
  check('analyze: unknown format', a(EMPH, 'SCH-DITA').status === 'not_executable');
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
  check('prompt: explanation from the rule XML, not the Proposal', p.includes('saying what the RULE checks, read from its XML') && p.includes('not what the Proposal says'));
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
  check('verify: DITA (not testable) → no dialog', w({}, 'SCH-DITA') === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
