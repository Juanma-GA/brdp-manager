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
  editExample,
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
  nestingPath,
  placeExample,
  ruleTargets,
} from '../src/utils/ruleTestSkeleton.js';
import { analyzeRule, describeRule, ruleConditions } from '../src/utils/ruleTestEngine.js';
import { addMissingCalsColspecs, checkCalsColspecs, checkCalsTableSpans, checkExampleStructure, fixCalsRowSpans, extractRuleNames, formatSchemaIssue, formatStructureProblem, removeSpannedCalsEntries, structureIssues } from '../src/validation/schemaValidation.js';
import i18n from '../src/i18n/index.js';
import { exampleFailures, generateRuleTestExamples, keepMatchedNodeProblem, missesRuleProblem, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { TABLE_MODEL_HINT } from '../src/utils/ruleTest.js';
import { calsTableModel, ruleLooksAtTables } from '../src/utils/ruleTestSkeleton.js';
import { contentRoutes, metadataXml, normalizeBrexReferenceCode, ruleLooksAtBrexReference, ruleMatchExpressions, ruleUseNames, SKELETON_TITLE_TEXT } from '../src/utils/ruleTestSkeleton.js';
import { formatRuleDescription, formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { readPublicTemplate, retiredTemplateRows } from './lib/readXlsx.mjs';
import { wrapRuleInSchemaContexts } from '../src/utils/ruleSchemaContext.js';
import { RULE_TEST_TEMPERATURE } from '../src/prompts/shared.js';

let passed = 0;
let failed = 0;

// The approvals these tests build stand for what the server sends, and the
// indicator's kind is the server's test_category (AACF 2, Part 2: decided
// by backend services/rule_test_category.py, pinned by
// backend/tests/test_aacf2_verified_breakdown.py). This fixture fills it in
// from the fields the tests set, the way the server would for them.
const withCategory = (a) =>
  a && !('test_category' in a)
    ? { ...a, test_category: !a.last_test_result ? 'not_tested' : a.last_test_up_to_date === false ? 'outdated' : a.last_test_result }
    : a;
async function importRuleTestStatus() {
  const m = await import('../src/utils/ruleTestStatus.js');
  return {
    ...m,
    ruleTestStatus: (a) => m.ruleTestStatus(withCategory(a)),
    verifyWarning: (a, ...rest) => m.verifyWarning(withCategory(a), ...rest),
    passedTestToReplaceAt: (a, ...rest) => m.passedTestToReplaceAt(withCategory(a), ...rest),
  };
}

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
  return { standard, schemaLocation, placements, keepBrexReference: ruleLooksAtBrexReference(ruleXml) };
}
function testRun(ruleXml, examples, setup, { format = 'BREX-4.2', vocab = vocabulary } = {}) {
  const materialized = examples.map((ex) => materializeExample(ex, setup, parseXml));
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
  {
    // Rule test on DM metadata: an absolute path into the identification and
    // status section makes that section the insertion point (the LLM writes
    // it whole); the content is left alone.
    const meta = placeExample(structureOf('S1000D 4.2', 'descript'), ruleTargets('<structureObjectRule><objectPath>/dmodule/identAndStatusSection/dmAddress/dmIdent/dmCode/@modelIdentCode</objectPath></structureObjectRule>'));
    check('placement: /dmodule/identAndStatusSection/… → the metadata section, no content', meta.metadata?.insertion === true && meta.metadata.element === 'identAndStatusSection' && meta.contentInsertion === false && meta.unreachable === null, JSON.stringify({ ...meta, metadata: meta.metadata && { ...meta.metadata, tree: '…' } }));
  }
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
  check('assembly: skeleton node paths', flat.skeletonNodePaths.includes('/dmodule[1]/content[1]/procedure[1]/mainProcedure[1]/proceduralStep[1]/para[1]'), JSON.stringify(flat.skeletonNodePaths));
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
  // Plantillas, Part 4: a boolean objectPath is a condition (s1kd-brexcheck).
  check('analyze: a boolean objectPath is executable (a condition)', bool.status === 'executable', JSON.stringify(bool));
  const num = a('<structureObjectRule><objectPath allowedObjectFlag="0">count(//zoneSpec)</objectPath></structureObjectRule>');
  check('analyze: a number is not a path', num.status === 'not_executable' && num.reason?.code === 'path_not_nodes' && num.reason.params.kind === 'number', JSON.stringify(num));
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
  // Barrido final 1/2: the Proposal is checked by its own call; the
  // examples prompt no longer asks for proposalMismatch.
  check('prompt: no proposalMismatch any more', !p.includes('proposalMismatch') && p.includes('{"examples": [{"label"'));
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
  check('parse: valid JSON with content', r.ok && r.examples.length === 2 && r.examples[1].content === '<emphasis>a</emphasis>' && !('proposalMismatch' in r), JSON.stringify(r));
  check('parse: an old proposalMismatch is ignored', parseRuleTestResponse(good.replace('"proposalMismatch":null', '"proposalMismatch":"No implementa la Proposal."')).ok);
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
  check('display: copied text keeps its indentation', text.split('\n').some((l) => l.startsWith('          <para>')) && text.split('\n')[0].startsWith('<dmodule') && text.split('\n')[1] === '  <identAndStatusSection>', text);
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
  const { ruleTestStatus, verifyWarning } = await importRuleTestStatus();
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

  const stepTargets = ruleTargets(STEP);
  check('T4 targets: Schematron → contexts only', JSON.stringify({ ...stepTargets, alternatives: undefined }) === JSON.stringify({ checked: ['step'], absolutePrefixes: [], predicateNames: [], rootPredicates: [], wholeDocument: false }) && stepTargets.alternatives.length === 1, JSON.stringify(stepTargets));
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
  const { verifyWarning } = await importRuleTestStatus();
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
  const ext1 = readPublicTemplate('brdp-template-dita-xpath3.xlsx').find((r) => r.ID === 'BRDP-EXT-00001');
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
  // C3, Part 1c: EXT-00001 checks cell values, so the accept example (title
  // on the table, so the rule selects nothing in it either) goes back too.
  check('T4b EXT-00001: correction names the reject example (misses)', asked[1].messages.at(-1).content.includes('Example 2 ("quantity missing")'));
  check('C3 1c EXT-00001: accept example without a selected node sent back too', asked[1].messages.at(-1).content.includes('Example 1 ("quantity given"):\n- The rule checks values, so at least one example meant to be accepted must contain a node matched by: `*[title = ('), asked[1].messages.at(-1).content);
  check('T4b EXT-00001: fixed', result.status === 'ready' && result.correction.attempted === 2 && result.correction.fixed === 2, JSON.stringify(result.correction));
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

  // Respuestas cortadas por el límite de tokens: a cut answer is said as
  // such, never "not valid JSON" -- in the generation and in the correction
  // round.
  const { truncatedAnswerError, isTruncatedAnswer, LLM_TRUNCATED } = await import('../src/api/llmTruncation.js');
  const { RULE_TEST_MAX_TOKENS } = await import('../src/prompts/shared.js');
  const base = {
    ruleXml: ext1.Rule, format: 'SCH-DITA', standard: DITA3, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00001', title: '', definition: '', proposal: '' },
    vocabulary: vocabDita, parseXml,
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['topic'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
  };
  const cut = await generateRuleTestExamples({ ...base, ask: async () => { throw truncatedAnswerError(); } });
  check('truncated: a cut answer → error flagged truncated, not a bad JSON', cut.status === 'error' && cut.truncated === true && !cut.badResponse, JSON.stringify(cut).slice(0, 200));
  let calls = 0;
  const cutCorrection = await generateRuleTestExamples({ ...base, ask: async () => { calls += 1; if (calls === 1) return first; throw truncatedAnswerError(); } });
  check('truncated: a cut correction → the examples are kept, the correction says it was cut', cutCorrection.status === 'ready' && cutCorrection.correction.truncated === true && cutCorrection.examples.length === 2);
  const broken = await generateRuleTestExamples({ ...base, ask: async () => first.slice(0, 200) });
  check('truncated: a really broken answer (not flagged cut by the provider) stays "not valid JSON"', broken.status === 'error' && broken.badResponse === true && !broken.truncated);
  check('truncated: provider signals', isTruncatedAnswer('Mistral', { choices: [{ finish_reason: 'length' }] }) && isTruncatedAnswer('Custom', { choices: [{ finish_reason: 'model_length' }] })
    && isTruncatedAnswer('Anthropic', { stop_reason: 'max_tokens' }) && !isTruncatedAnswer('Mistral', { choices: [{ finish_reason: 'stop' }] }) && !isTruncatedAnswer('Anthropic', { stop_reason: 'end_turn' }));
  check('truncated: error code', truncatedAnswerError().code === LLM_TRUNCATED);
  check('truncated: the rule test asks for more than the default 4000 tokens', RULE_TEST_MAX_TOKENS >= 16000);
  const enT = i18n.getFixedT('en');
  const esT = i18n.getFixedT('es');
  check('truncated: texts EN/ES', esT('records.ruleTest.truncated').startsWith('La respuesta de la IA se cortó por su longitud') && enT('records.ruleTest.truncated').startsWith("The AI's answer was cut off by its length")
    && esT('records.ruleTest.correctionTruncated').includes('se cortó por su longitud'));
}

// ─── C3, Part 1: a correction round with useful information ────────────────
{
  const S42 = 'S1000D 4.2';
  const DITA_STD = 'DITA 1.3 Xpath2.0';
  const proced = structureOf(S42, 'proced');
  const descript = structureOf(S42, 'descript');
  const wrap = (inner) => `<dmodule><content><procedure><mainProcedure><proceduralStep><para>${inner}</para></proceduralStep></mainProcedure></procedure></content></dmodule>`;

  // 1a. The real case: <quantity quantityValue="25" unitOfMeasure="N·m">.
  const q1 = validateExample(wrap('Torque to <quantity quantityValue="25" unitOfMeasure="N·m"/>.'), vocabulary, parseXml, proced);
  const p1 = exampleProblems(q1, { standard: S42, schema: 'proced' });
  check('C3 1a: @quantityValue is really an element', p1.includes('@quantityValue is not an attribute (it is the element <quantityValue>)'), p1.join('\n'));
  check('C3 1a: card of <quantity> sent', p1.includes('card of <quantity> in the proced schema: allowed children: quantityGroup; attributes: @changeMark, @changeType, @quantityType, @quantityTypeSpecifics, @reasonForUpdateRefIds'), p1.join('\n'));
  check('C3 1a: card of <quantityValue> (the element @quantityValue really is)', p1.some((l) => l.startsWith('card of <quantityValue> in the proced schema: allowed children: none; attributes: @quantityUnitOfMeasure')), p1.join('\n'));
  // The first "correction" of the real run.
  const q2 = validateExample(wrap('Torque to <quantity><quantityValue>25</quantityValue></quantity>.'), vocabulary, parseXml, proced);
  const p2 = exampleProblems(q2, { standard: S42, schema: 'proced' });
  check('C3 1a: <quantityValue> not allowed inside <quantity>', p2.includes('<quantityValue> is not allowed inside <quantity>'), p2.join('\n'));
  check('C3 1a: card of the parent <quantity> names quantityGroup', p2.some((l) => l.startsWith('card of <quantity> in the proced schema: allowed children: quantityGroup;')), p2.join('\n'));
  check('C3 1a: one card per element, never repeated', p2.filter((l) => l.startsWith('card of <quantity>')).length === 1);
  // An element with more than 20 children: the card is cut with "+N more".
  const paraChildren = descript.elements.para.children;
  check('C3 1a: fixture <para> has more than 20 children', paraChildren.length > 20, String(paraChildren.length));
  const big = validateExample('<dmodule><content><description><levelledPara><para>Text <levelledPara><para>x</para></levelledPara></para></levelledPara></description></content></dmodule>', vocabulary, parseXml, descript);
  const pBig = exampleProblems(big, { standard: S42, schema: 'descript' });
  const cardLine = pBig.find((l) => l.startsWith('card of <para> in the descript schema'));
  check('C3 1a: card of <para> for a child not allowed in it', Boolean(cardLine), pBig.join('\n'));
  const childrenPart = (cardLine || '').split('; attributes:')[0].replace(/^.*allowed children: /, '');
  check('C3 1a: >20 children cut to 20 with "+N more"', childrenPart.split(', ').length === 21 && childrenPart.endsWith(`+${paraChildren.length - 20} more`), childrenPart);
  // No problem about an element → no card.
  const clean = validateExample(wrap('Torque to 25 N·m.'), vocabulary, parseXml, proced);
  check('C3 1a: valid example has no cards', clean.runnable && clean.cards.length === 0);

  // 1b. CALS tables: an entry in a column spanned by morerows.
  const tbl = (rows, { colspecs = '', cols = 3 } = {}) =>
    `<dmodule><content><description><levelledPara><table><tgroup cols="${cols}">${colspecs}<tbody>${rows}</tbody></tgroup></table></levelledPara></description></content></dmodule>`;
  const specs = '<colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>';
  const byName = validateExample(
    tbl('<row><entry colname="c1" morerows="1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row><entry colname="c1">X</entry><entry colname="c2">D</entry><entry colname="c3">E</entry></row>', { colspecs: specs }),
    vocabulary, parseXml, descript
  );
  const pByName = exampleProblems(byName, { standard: S42, schema: 'descript' });
  check('C3 1b: overlap by @colname', pByName.includes('row 2: column c1 is already spanned by the entry above (morerows); remove this entry'), pByName.join('\n'));
  check('C3 1b: overlap makes the example not runnable', !byName.runnable);
  const byPosition = validateExample(
    tbl('<row><entry morerows="1">A</entry><entry>B</entry><entry>C</entry></row><row><entry>X</entry><entry>D</entry><entry>E</entry></row>', { cols: 3 }),
    vocabulary, parseXml, descript
  );
  const pByPos = exampleProblems(byPosition, { standard: S42, schema: 'descript' });
  check('C3 1b: table without colname → overlap detected by position', pByPos.includes('row 2: column c1 is already spanned by the entry above (morerows); remove this entry'), pByPos.join('\n'));
  const middle = validateExample(
    tbl('<row><entry>A</entry><entry morerows="2">B</entry><entry>C</entry></row><row><entry>D</entry><entry>E</entry></row><row><entry>F</entry><entry>G</entry><entry>H</entry></row>', { cols: 3 }),
    vocabulary, parseXml, descript
  );
  const pMid = exampleProblems(middle, { standard: S42, schema: 'descript' });
  check('C3 1b: a correct row below the span is fine; the extra entry of row 3 is caught', pMid.length === 1 && pMid[0] === 'row 3: column c2 is already spanned by the entry above (morerows); remove this entry', pMid.join('\n'));
  const correct = validateExample(
    tbl('<row><entry colname="c1" morerows="1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row><entry colname="c2">D</entry><entry colname="c3">E</entry></row>', { colspecs: specs }),
    vocabulary, parseXml, descript
  );
  check('C3 1b: a correct morerows table has no problem', correct.runnable && correct.structure.length === 0, JSON.stringify(correct.structure));
  let past;
  try {
    past = validateExample(tbl('<row><entry morerows="3">A</entry><entry>B</entry><entry>C</entry></row><row><entry>D</entry><entry>E</entry></row>'), vocabulary, parseXml, descript);
  } catch (err) {
    past = { crashed: err.message };
  }
  const pPast = past.crashed ? [] : exampleProblems(past, { standard: S42, schema: 'descript' });
  check('C3 1b: morerows past the last row → its own problem, no crash', !past.crashed && pPast.includes('row 1: morerows spans past the last row (column c1)'), past.crashed || pPast.join('\n'));
  check('C3 1b: morerows past the end is not also an overlap', !pPast.some((l) => l.includes('already spanned')), pPast.join('\n'));
  // DITA: same model.
  const topicStructure = structureOf(DITA_STD, 'topic');
  const ditaTable = validateExample(
    `<topic id="t"><title>T</title><body><table><tgroup cols="2"><tbody><row><entry morerows="1">A</entry><entry>B</entry></row><row><entry>C</entry><entry>D</entry></row></tbody></tgroup></table></body></topic>`,
    vocabOf('schema-vocabulary-dita.json'), parseXml, topicStructure
  );
  const pDita = exampleProblems(ditaTable, { standard: DITA_STD, schema: 'topic' });
  check('C3 1b: DITA table overlap by position', pDita.includes('row 2: column c1 is already spanned by the entry above (morerows); remove this entry'), pDita.join('\n'));

  // 1c. A value rule needs an accept example with a node it selects.
  const setup = setupFor(S42, ETYPE, ['descript']);
  const noEmph = (label) => ({ label, expected: 'accept', schema: 'descript', content: 'Plain text.' });
  const withBad = { label: 'em05', expected: 'reject', schema: 'descript', content: '<emphasis emphasisType="em05">x</emphasis>' };
  const valueRun = testRun(ETYPE, [noEmph('plain'), withBad], setup);
  const valueFailures = exampleFailures([noEmph('plain'), withBad], valueRun.materialized, valueRun.runs, { ruleXml: ETYPE, standard: S42, format: 'BREX-4.2', parseXml });
  check('C3 1c: value rule, accept example without the node → correction round', valueFailures.length === 1 && valueFailures[0].index === 0 && valueFailures[0].problems[0].startsWith('The rule checks values, so at least one example meant to be accepted must contain a node matched by: `//emphasis/@emphasisType`'), JSON.stringify(valueFailures));
  const goodAccept = { label: 'em01', expected: 'accept', schema: 'descript', content: '<emphasis emphasisType="em01">x</emphasis>' };
  const valueRun2 = testRun(ETYPE, [noEmph('plain'), goodAccept, withBad], setup);
  check('C3 1c: one accept example with the node is enough', exampleFailures([noEmph('plain'), goodAccept, withBad], valueRun2.materialized, valueRun2.runs, { ruleXml: ETYPE, standard: S42, format: 'BREX-4.2', parseXml }).length === 0);
  // A prohibition (flag 0): the correct accept example has no such node.
  const emphSetup = setupFor(S42, EMPH, ['descript']);
  const prohibition = [noEmph('no emphasis'), { label: 'emphasis', expected: 'reject', schema: 'descript', content: '<emphasis>x</emphasis>' }];
  const prohibitionRun = testRun(EMPH, prohibition, emphSetup);
  check('C3 1c: prohibition (flag 0), accept without the node → no correction round', exampleFailures(prohibition, prohibitionRun.materialized, prohibitionRun.runs, { ruleXml: EMPH, standard: S42, format: 'BREX-4.2', parseXml }).length === 0);
  check('C3 1c: prohibition verdict correct', ruleTestVerdict(prohibition, prohibitionRun.runs).kind === 'correct');
  const OBJAPPL0 = '<objrule><objpath objappl="0">//randlist</objpath><objuse>No random lists.</objuse></objrule>';
  const { ruleRestrictsValues } = await import('../src/utils/ruleTestRun.js');
  check('C3 1c: objappl="0" is a prohibition', !ruleRestrictsValues(OBJAPPL0, 'BREX-3.0.1', parseXml));
  check('C3 1c: objectValue → restricts values', ruleRestrictsValues(ETYPE, 'BREX-4.2', parseXml));
  check('C3 1c: flag 2 without values restricts nothing', !ruleRestrictsValues('<structureObjectRule><objectPath allowedObjectFlag="2">//emphasis</objectPath><objectUse>x</objectUse></structureObjectRule>', 'BREX-4.2', parseXml));
  check('C3 1c: 3.0.1 objval without objappl → restricts values', ruleRestrictsValues('<objrule><objpath>//@emph</objpath><objuse>x</objuse><objval valtype="single" val1="em01"/></objrule>', 'BREX-3.0.1', parseXml));
  check('C3 1c: flag 0 with values is still a prohibition', !ruleRestrictsValues('<structureObjectRule><objectPath allowedObjectFlag="0">//@emphasisType</objectPath><objectUse>x</objectUse><objectValue valueForm="single" valueAllowed="em05"/></structureObjectRule>', 'BREX-4.2', parseXml));
  check('C3 1c: Schematron value test', ruleRestrictsValues('<sch:pattern><sch:rule context="note"><sch:assert test="@type = (\'caution\', \'note\')">x</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA', parseXml));
  check('C3 1c: Schematron prohibition is not a value rule', !ruleRestrictsValues('<sch:pattern><sch:rule context="note"><sch:report test="true()">x</sch:report></sch:rule></sch:pattern>', 'SCH-DITA', parseXml));
  check('C3 1c: Schematron existence test is not a value rule', !ruleRestrictsValues('<sch:pattern><sch:rule context="note"><sch:assert test="@type">x</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA', parseXml));
  check('C3 1c: a literal "=" inside a string is not a comparison', !ruleRestrictsValues('<sch:pattern><sch:rule context="note"><sch:assert test="contains-token(@class, \'a=b\') or @type">x</sch:assert></sch:rule></sch:pattern>', 'SCH-DITA', parseXml));
  // An example of another schema (the rule does not apply there) never counts.
  const PROC_ONLY = wrapRuleInSchemaContexts(ETYPE, 'BREX-4.2', 'S1000D 4.2', ['proced']);
  const ctxSetup = setupFor(S42, PROC_ONLY, ['proced', 'descript']);
  const ctxExamples = [
    { label: 'descript, no rule', expected: 'accept', schema: 'descript', content: '<emphasis emphasisType="em05">x</emphasis>' },
    { label: 'proced plain', expected: 'accept', schema: 'proced', content: 'Plain.' },
    { label: 'proced em05', expected: 'reject', schema: 'proced', content: '<emphasis emphasisType="em05">x</emphasis>' },
  ];
  const ctxRun = testRun(PROC_ONLY, ctxExamples, ctxSetup);
  const ctxFailures = exampleFailures(ctxExamples, ctxRun.materialized, ctxRun.runs, { ruleXml: PROC_ONLY, standard: S42, format: 'BREX-4.2', parseXml });
  check('C3 1c: the other-schema example is ignored; the in-scope accept example is sent', ctxFailures.length === 1 && ctxFailures[0].index === 1, JSON.stringify(ctxFailures.map((f) => f.index)));

  // 1d. An old stored non-rule is not executable, with the format reason.
  const old = analyzeRule('//&lt;emphasis&gt;', 'BREX-4.2', { parseXml });
  check('C3 1d: //&lt;emphasis&gt; → not executable, rule_format', old.status === 'not_executable' && old.reason.code === 'rule_format' && old.reason.params.problem === 'rule_format_missing', JSON.stringify(old));
  check('C3 1d: verdict not executable from the analysis', ruleTestVerdict([], [], old).kind === 'not_executable');
  check('C3 1d: wrapper <rules> → rule_format_wrapper', analyzeRule(`<rules>${EMPH}</rules>`, 'BREX-4.2', { parseXml }).reason?.params.problem === 'rule_format_wrapper');
  check('C3 1d: a real rule is still executable', analyzeRule(EMPH, 'BREX-4.2', { parseXml }).status === 'executable');
  check('C3 1d: malformed XML keeps its own reason', analyzeRule('<structureObjectRule>', 'BREX-4.2', { parseXml }).reason?.code === 'rule_not_well_formed');
}

// ─── C3b: overlapping cells fixed by the app; plain text in the correction ─
{
  const S42 = 'S1000D 4.2';
  const descript = structureOf(S42, 'descript');
  const specs = '<colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>';
  const tbl = (rows, head = specs) => `<table><tgroup cols="3">${head}<tbody>${rows}</tbody></tgroup></table>`;

  // By @colname: row 2's c1 cell sits under row 1's morerows.
  const byName = tbl('<row><entry colname="c1" morerows="1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row><entry colname="c1">X</entry><entry colname="c2">D</entry><entry colname="c3">E</entry></row>');
  const fixedName = removeSpannedCalsEntries(byName, parseXml);
  check('C3b: by @colname → the spanned cell is removed', fixedName.content === tbl('<row><entry colname="c1" morerows="1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row><entry colname="c2">D</entry><entry colname="c3">E</entry></row>'), fixedName.content);
  check('C3b: reports row 2', JSON.stringify(fixedName.removedRows) === '[2]', JSON.stringify(fixedName.removedRows));
  // By position (no colname): the extra first cell of row 2.
  const byPos = tbl('<row><entry morerows="1">A</entry><entry>B</entry><entry>C</entry></row><row><entry>X</entry><entry>D</entry><entry>E</entry></row>', '');
  const fixedPos = removeSpannedCalsEntries(byPos, parseXml);
  check('C3b: by position → the extra cell goes', fixedPos.content === tbl('<row><entry morerows="1">A</entry><entry>B</entry><entry>C</entry></row><row><entry>D</entry><entry>E</entry></row>', ''), fixedPos.content);
  // A morerows="2" in the middle column with two extra cells below.
  const two = tbl('<row><entry>A</entry><entry morerows="2">B</entry><entry>C</entry></row><row><entry>D</entry><entry>Y</entry><entry>E</entry></row><row><entry>F</entry><entry>Z</entry><entry>H</entry></row>', '');
  const fixedTwo = removeSpannedCalsEntries(two, parseXml);
  check('C3b: two rows, one cell each → rows [2, 3]', JSON.stringify(fixedTwo.removedRows) === '[2,3]' && !fixedTwo.content.includes('>Y<') && !fixedTwo.content.includes('>Z<'), JSON.stringify(fixedTwo));
  // Indented content: the removed cell's own line goes with it.
  const indented = `<table>\n  <tgroup cols="2">\n    <tbody>\n      <row>\n        <entry morerows="1">A</entry>\n        <entry>B</entry>\n      </row>\n      <row>\n        <entry>X</entry>\n        <entry>C</entry>\n      </row>\n    </tbody>\n  </tgroup>\n</table>`;
  const fixedIndented = removeSpannedCalsEntries(indented, parseXml);
  check('C3b: indented → no blank line left', fixedIndented.content === indented.replace('\n        <entry>X</entry>', ''), fixedIndented.content);
  // Nothing to fix / not the app's to fix / not parseable.
  const correct = tbl('<row><entry colname="c1" morerows="1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row><entry colname="c2">D</entry><entry colname="c3">E</entry></row>');
  check('C3b: a correct table is left byte for byte', removeSpannedCalsEntries(correct, parseXml).content === correct && removeSpannedCalsEntries(correct, parseXml).removedRows.length === 0);
  const past = tbl('<row><entry morerows="3">A</entry><entry>B</entry><entry>C</entry></row><row><entry>D</entry><entry>E</entry></row>', '');
  check('C3b: morerows past the end is left to the LLM', removeSpannedCalsEntries(past, parseXml).content === past);
  check('C3b: malformed content returned unchanged', removeSpannedCalsEntries('<table><tgroup>', parseXml).content === '<table><tgroup>');
  const prefixed = `<para>See <dmRef xlink:href="x"/></para>${byName}`;
  check('C3b: a prefixed attribute elsewhere does not stop the fix', removeSpannedCalsEntries(prefixed, parseXml).removedRows.length === 1);
  const nested = tbl('<row><entry morerows="1">A</entry><entry>B</entry></row><row><entry>X<table><tgroup cols="1"><tbody><row><entry>in</entry></row></tbody></tgroup></table></entry><entry>C</entry></row>', '').replace('cols="3"', 'cols="2"');
  const fixedNested = removeSpannedCalsEntries(nested, parseXml);
  check('C3b: a removed cell takes its nested table with it', fixedNested.removedRows.join() === '2' && !fixedNested.content.includes('>in<') && fixedNested.content.includes('<entry>C</entry>'), JSON.stringify(fixedNested));

  // Through materializeExample: the example carries the fix and the rows.
  const TBL = '<structureObjectRule><objectPath allowedObjectFlag="0">//thead</objectPath><objectUse>No table headings.</objectUse></structureObjectRule>';
  const setup = setupFor(S42, TBL, ['descript']);
  const run = testRun(TBL, [{ label: 'table', expected: 'accept', schema: 'descript', content: `<para>Values:</para>${byName}` }], setup);
  check('C3b: materialized example is fixed and says so', JSON.stringify(run.materialized[0].spannedEntriesRemoved) === '[2]' && !run.materialized[0].content.includes('>X<'), JSON.stringify(run.materialized[0].spannedEntriesRemoved));
  check('C3b: fixed example is valid (no spannedEntry problem)', run.runs[0].validation.runnable && run.runs[0].validation.structure.length === 0, JSON.stringify(run.runs[0].validation.structure));
  check('C3b: fixed example rejects nothing (no thead)', run.runs[0].result?.status === 'accepted', JSON.stringify(run.runs[0].result?.status));
  check('C3b: a clean example says nothing', JSON.stringify(testRun(TBL, [{ label: 'p', expected: 'accept', schema: 'descript', content: '<para>x</para>' }], setup).materialized[0].spannedEntriesRemoved) === '[]');
  check('C3b: descript structure is the real one', Boolean(descript.elements.table));

  // The real titled-context case (297df74, run 1, examples 3 and 4): valid
  // examples whose only problem is a spanned cell → no correction round.
  const ext1 = readPublicTemplate('brdp-template-dita-xpath3.xlsx').find((r) => r.ID === 'BRDP-EXT-00001');
  const DITA = 'DITA 1.3 Xpath2.0';
  const vocabDita = vocabOf('schema-vocabulary-dita.json');
  const section = (cant) =>
    `<section><title>LISTA DE MATERIAL OBLIGATORIO</title><table><tgroup cols="3"><colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/><thead><row><entry colname="c1">Part</entry><entry colname="c2">Descripción</entry><entry colname="c3">Cant.</entry></row></thead><tbody><row><entry colname="c1" morerows="1">P-100</entry><entry colname="c2">Seal</entry>${cant ? `<entry colname="c3">${cant}</entry>` : ''}</row><row><entry colname="c1">P-100</entry><entry colname="c2">Gasket</entry>${cant ? `<entry colname="c3">${cant}</entry>` : ''}</row></tbody></tgroup></table></section>`;
  const answer = JSON.stringify({ proposalMismatch: null, examples: [
    { label: 'quantity given', expected: 'accept', schema: 'topic', content: section('2') },
    { label: 'quantity missing', expected: 'reject', schema: 'topic', content: section('') },
  ] });
  const asked = [];
  const result = await generateRuleTestExamples({
    ruleXml: ext1.Rule, format: 'SCH-DITA', standard: 'DITA 1.3 Xpath3.0', schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00001', title: '', definition: '', proposal: '' },
    vocabulary: vocabDita, parseXml,
    ask: async (messages) => { asked.push(messages); return answer; },
    fetchSchemaCards: async (_std, names) => ({ cards: {}, document_schemas: ['topic'], element_schemas: Object.fromEntries(names.map((n) => [n, ['topic']])) }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
  });
  check('C3b titled-context: no correction round for spanned cells', asked.length === 1 && result.correction === null, JSON.stringify({ asked: asked.length, c: result.correction }));
  check('C3b titled-context: both examples adjusted in row 2', result.examples.every((e) => JSON.stringify(e.spannedEntriesRemoved) === '[2]'), JSON.stringify(result.examples.map((e) => e.spannedEntriesRemoved)));
  check('C3b titled-context: examples run with the fixed tables', result.runs.every((r) => r.validation.runnable), JSON.stringify(result.runs.map((r) => r.validation.structure)));

  // C3b follow-up: the real titled-context table where row 1 spans c1 AND c2
  // (morerows="1") and row 2 only has entry colname="c2". Removing that entry
  // would leave row 2 empty, so the app adjusts nothing in the example and
  // sends it to the correction round with rowFullyCovered.
  const covered = (row2) =>
    `<section><title>LISTA DE MATERIAL OBLIGATORIO</title><table><tgroup cols="3"><colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/><thead><row><entry colname="c1">Part</entry><entry colname="c2">Descripción</entry><entry colname="c3">Cant.</entry></row></thead><tbody><row><entry colname="c1" morerows="1">P-100</entry><entry colname="c2" morerows="1">Seal</entry><entry colname="c3">2</entry></row><row>${row2}</row></tbody></tgroup></table></section>`;
  const coveredContent = covered('<entry colname="c2">Gasket</entry>');
  const untouched = removeSpannedCalsEntries(coveredContent, parseXml);
  check('C3b row covered: content left byte for byte', untouched.content === coveredContent, untouched.content);
  check('C3b row covered: nothing reported as removed', untouched.removedRows.length === 0, JSON.stringify(untouched.removedRows));
  const coveredProblems = checkCalsTableSpans(parseXml(`<topic id="t"><title>T</title><body>${coveredContent}</body></topic>`));
  check('C3b row covered: rowFullyCovered for row 2, no spannedEntry', JSON.stringify(coveredProblems.filter((p) => p.kind === 'rowFullyCovered' || p.kind === 'spannedEntry')) === '[{"kind":"rowFullyCovered","row":2,"columns":["c2"],"from":[1]}]', JSON.stringify(coveredProblems));
  // Barrido final 1/2: the message names the covered cells and the row
  // whose morerows covers them.
  const coveredProblem = { kind: 'rowFullyCovered', row: 2, columns: ['c2'], from: [1] };
  const coveredLine = 'row 2 is entirely covered by morerows from above (column c2, by the morerows of row 1): give row 2 its own entries or lower the morerows';
  check('C3b row covered: exact English message', formatStructureProblem(coveredProblem, 'topic') === coveredLine, formatStructureProblem(coveredProblem, 'topic'));
  check('C3b row covered: EN through i18n = English line', formatSchemaIssue(structureIssues([coveredProblem], { schema: 'topic' })[0], i18n.getFixedT('en')) === coveredLine);
  check('C3b row covered: ES through i18n', formatSchemaIssue(structureIssues([coveredProblem], { schema: 'topic' })[0], i18n.getFixedT('es')) === 'la fila 2 queda entera bajo el morerows de arriba (columna c2, por el morerows de la fila 1): dale a la fila 2 sus propias celdas o reduce el morerows',
    formatSchemaIssue(structureIssues([coveredProblem], { schema: 'topic' })[0], i18n.getFixedT('es')));
  const twoCovered = { kind: 'rowFullyCovered', row: 3, columns: ['c1', 'c2'], from: [1, 2] };
  check('C3b row covered: plural EN/ES', formatSchemaIssue(structureIssues([twoCovered], { schema: 'topic' })[0], i18n.getFixedT('en')).includes('(columns c1, c2, by the morerows of rows 1, 2)')
    && formatSchemaIssue(structureIssues([twoCovered], { schema: 'topic' })[0], i18n.getFixedT('es')).includes('(columnas c1, c2, por el morerows de las filas 1, 2)'));
  check('C3b row covered: without details, the plain line', formatStructureProblem({ kind: 'rowFullyCovered', row: 2 }, 'topic') === 'row 2 is entirely covered by morerows from above: give row 2 its own entries or lower the morerows');
  // An empty <row/> fully spanned from above counts too.
  check('C3b row covered: an empty row under the spans', removeSpannedCalsEntries(tbl('<row><entry morerows="1">A</entry><entry morerows="1">B</entry><entry morerows="1">C</entry></row><row></row>', ''), parseXml).removedRows.length === 0
    && checkCalsTableSpans(parseXml(`<dmodule>${tbl('<row><entry morerows="1">A</entry><entry morerows="1">B</entry><entry morerows="1">C</entry></row><row></row>', '')}</dmodule>`)).some((p) => p.kind === 'rowFullyCovered' && p.row === 2));
  // An empty <row/> with nothing spanning into it is invalid CALS too.
  for (const empty of ['<row/>', '<row></row>']) {
    const emptyTbl = tbl(`<row><entry colname="c1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row>${empty}`);
    const emptyProblems = checkCalsTableSpans(parseXml(`<dmodule>${emptyTbl}</dmodule>`));
    check(`C3b empty row: ${empty} → emptyRow for row 2`, JSON.stringify(emptyProblems) === '[{"kind":"emptyRow","row":2}]', JSON.stringify(emptyProblems));
    check(`C3b empty row: ${empty} left untouched by the morerows fix`, removeSpannedCalsEntries(emptyTbl, parseXml).content === emptyTbl);
    // Barrido final 1/2: nothing reaches it, so the app removes it.
    const removedEmpty = fixCalsRowSpans(emptyTbl, parseXml);
    check(`final 1/2: ${empty} with no span into it → removed by the app`, JSON.stringify(removedEmpty.emptyRowsRemoved) === '[2]' && removedEmpty.content === emptyTbl.replace(empty, ''), removedEmpty.content);
  }
  // Partly spanned from above but no entry of its own: still empty.
  check('C3b empty row: partly spanned empty row → emptyRow', JSON.stringify(checkCalsTableSpans(parseXml(`<dmodule>${tbl('<row><entry colname="c1" morerows="1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row/>')}</dmodule>`))) === '[{"kind":"emptyRow","row":2}]');
  check('C3b empty row: exact English message', formatStructureProblem({ kind: 'emptyRow', row: 2 }, 'descript') === 'row 2 has no entry');
  check('C3b empty row: EN/ES through i18n', formatSchemaIssue(structureIssues([{ kind: 'emptyRow', row: 2 }], { schema: 'descript' })[0], i18n.getFixedT('en')) === 'row 2 has no entry'
    && formatSchemaIssue(structureIssues([{ kind: 'emptyRow', row: 2 }], { schema: 'descript' })[0], i18n.getFixedT('es')) === 'la fila 2 no tiene ninguna celda');
  {
    // An empty row a morerows above reaches (partly) is not touched: it
    // still goes to the correction round with its reason.
    const emptyContent = `<para>Values:</para>${tbl('<row><entry colname="c1" morerows="1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row/>')}`;
    const emptyExamples = [{ label: 'empty row', expected: 'accept', schema: 'descript', content: emptyContent }];
    const emptyRun = testRun(TBL, emptyExamples, setup);
    check('C3b empty row (partly spanned): example not runnable', !emptyRun.runs[0].validation.runnable && emptyRun.runs[0].validation.structure.some((p) => p.kind === 'emptyRow'), JSON.stringify(emptyRun.runs[0].validation.structure));
    check('final 1/2: partly spanned empty row not removed', JSON.stringify(emptyRun.materialized[0].emptyRowsRemoved) === '[]');
    const emptyFailures = exampleFailures(emptyExamples, emptyRun.materialized, emptyRun.runs, { ruleXml: TBL, standard: S42, format: 'BREX-4.2', parseXml });
    check('C3b empty row: goes to the correction round with its message', emptyFailures.length === 1 && emptyFailures[0].problems.includes('row 2 has no entry'), JSON.stringify(emptyFailures));
    // With nothing reaching it, the example runs, with the app's note.
    const freeEmpty = testRun(TBL, [{ label: 'empty row', expected: 'accept', schema: 'descript', content: `<para>Values:</para>${tbl('<row><entry colname="c1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row><row/>')}` }], setup);
    check('final 1/2: empty row removed, example runs', freeEmpty.runs[0].validation.runnable && JSON.stringify(freeEmpty.materialized[0].emptyRowsRemoved) === '[2]', JSON.stringify(freeEmpty.runs[0].validation.structure));
  }
  // Partial overlap still auto-fixed (regression).
  check('C3b row covered: partial overlap still fixed', removeSpannedCalsEntries(covered('<entry colname="c2">Gasket</entry><entry colname="c3">1</entry>'), parseXml).removedRows.join() === '2');

  // Through generateRuleTestExamples: one correction round naming row 2.
  const fixedCovered = covered('<entry colname="c3">1</entry>');
  const coveredAsked = [];
  const coveredResult = await generateRuleTestExamples({
    ruleXml: ext1.Rule, format: 'SCH-DITA', standard: 'DITA 1.3 Xpath3.0', schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00001', title: '', definition: '', proposal: '' },
    vocabulary: vocabDita, parseXml,
    ask: async (messages) => {
      coveredAsked.push(messages);
      const content = coveredAsked.length === 1 ? coveredContent : fixedCovered;
      return JSON.stringify({ proposalMismatch: null, examples: [
        { label: 'quantity given', expected: 'accept', schema: 'topic', content },
        { label: 'quantity missing', expected: 'reject', schema: 'topic', content: section('') },
      ] });
    },
    fetchSchemaCards: async (_std, names) => ({ cards: {}, document_schemas: ['topic'], element_schemas: Object.fromEntries(names.map((n) => [n, ['topic']])) }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
  });
  const correctionText = JSON.stringify(coveredAsked[1] || []);
  check('C3b row covered: goes to the correction round', coveredAsked.length === 2 && correctionText.includes(coveredLine), correctionText.slice(0, 400));
  check('C3b row covered: the other example (partial overlap) is not sent back', !correctionText.includes('Example 2'), correctionText.slice(0, 400));
  check('C3b row covered: first example not adjusted by the app, corrected example runs', JSON.stringify(coveredResult.examples[0].spannedEntriesRemoved) === '[]' && coveredResult.runs[0].validation.runnable, JSON.stringify({ e: coveredResult.examples[0].spannedEntriesRemoved, s: coveredResult.runs[0].validation.structure }));
  check('C3b row covered: the partial-overlap example is still fixed by the app', JSON.stringify(coveredResult.examples[1].spannedEntriesRemoved) === '[2]');

  // C3b follow-up: missing colspecs, added by the app. The EXT-00001 run of
  // 29/09: every table used colname c1/c2/c3 with no <colspec> at all. The
  // real tables are not in the repo; these are the same titled-context
  // tables above (from the real EXT-00001 runs) with their colspecs removed,
  // which is exactly that shape.
  {
    const noSpecs = (html) => html.replace(/<colspec colname="c\d"\/>/g, '');
    const bare = noSpecs(section('2'));
    check('colspec: fixture has colnames and no colspec', bare.includes('colname="c3"') && !bare.includes('<colspec'));
    const added = addMissingCalsColspecs(bare, parseXml);
    check('colspec: EXT-00001 table → the three colspecs at the start of the tgroup', added.added === 3 && added.content === section('2'), added.content);
    // Used out of order: still in column order.
    const outOfOrder = '<table><tgroup cols="3"><tbody><row><entry colname="c3">C</entry><entry colname="c1">A</entry><entry colname="c2">B</entry></row></tbody></tgroup></table>';
    check('colspec: sorted by column, not by first use',
      addMissingCalsColspecs(outOfOrder, parseXml).content === outOfOrder.replace('<tgroup cols="3">', `<tgroup cols="3">${specs}`));
    // Existing colspecs are never touched; new ones go around them in order.
    const partial = '<table><tgroup cols="3"><colspec colname="c2" colnum="2" colwidth="2*"/><tbody><row><entry colname="c1">A</entry><entry colname="c2">B</entry><entry colname="c3">C</entry></row></tbody></tgroup></table>';
    const partialFixed = addMissingCalsColspecs(partial, parseXml);
    check('colspec: existing colspec kept, missing ones before and after it', partialFixed.added === 2
      && partialFixed.content.includes('<tgroup cols="3"><colspec colname="c1"/><colspec colname="c2" colnum="2" colwidth="2*"/><colspec colname="c3"/><tbody>'), partialFixed.content);
    // A gap: the column after it needs @colnum.
    const gap = '<table><tgroup cols="3"><tbody><row><entry colname="c1">A</entry><entry colname="c3">C</entry></row></tbody></tgroup></table>';
    check('colspec: a gap gets @colnum', addMissingCalsColspecs(gap, parseXml).content.includes('<tgroup cols="3"><colspec colname="c1"/><colspec colname="c3" colnum="3"/><tbody>'));
    // namest/nameend count as used names.
    const spanNames = '<table><tgroup cols="2"><tbody><row><entry namest="c1" nameend="c2">AB</entry></row></tbody></tgroup></table>';
    check('colspec: namest/nameend', addMissingCalsColspecs(spanNames, parseXml).content.includes('<tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><tbody>'));
    // Indented content: one colspec per line with the tgroup's child indentation.
    const indented = '<table>\n  <tgroup cols="2">\n    <tbody>\n      <row><entry colname="c1">A</entry><entry colname="c2">B</entry></row>\n    </tbody>\n  </tgroup>\n</table>';
    check('colspec: indented table keeps its layout', addMissingCalsColspecs(indented, parseXml).content
      === '<table>\n  <tgroup cols="2">\n    <colspec colname="c1"/>\n    <colspec colname="c2"/>\n    <tbody>\n      <row><entry colname="c1">A</entry><entry colname="c2">B</entry></row>\n    </tbody>\n  </tgroup>\n</table>');
    // Two tables: each gets its own; a complete table stays byte for byte.
    const two = `${bare}<p>and</p>${noSpecs(section(''))}`;
    const twoFixed = addMissingCalsColspecs(two, parseXml);
    check('colspec: two tables, three each', twoFixed.added === 6 && twoFixed.content === `${section('2')}<p>and</p>${section('')}`, twoFixed.content);
    const complete = section('2');
    check('colspec: complete table untouched', addMissingCalsColspecs(complete, parseXml).content === complete && addMissingCalsColspecs(complete, parseXml).added === 0);
    check('colspec: positional entries need nothing', addMissingCalsColspecs(tbl('<row><entry>A</entry><entry>B</entry><entry>C</entry></row>', ''), parseXml).added === 0);
    check('colspec: malformed content left as is', addMissingCalsColspecs('<table><tgroup cols="1">', parseXml).content === '<table><tgroup cols="1">');

    // Not adjusted: a colname with no column.
    // Barrido final 1/2: names without a number, all named by one row in
    // reading order → that order (the colspecs go in it).
    const named = '<table><tgroup cols="2"><tbody><row><entry colname="part">P-100</entry><entry colname="qty">2</entry></row></tbody></tgroup></table>';
    const namedResult = addMissingCalsColspecs(named, parseXml);
    check('final 1/2: colname="part"/"qty" in one row → colspecs in that order', namedResult.added === 2
      && namedResult.content === named.replace('<tgroup cols="2">', '<tgroup cols="2"><colspec colname="part"/><colspec colname="qty"/>'), namedResult.content);
    // Not adjusted: no row names both.
    const part = '<table><tgroup cols="2"><tbody><row><entry colname="part">P-100</entry></row><row><entry colname="qty">2</entry></row></tbody></tgroup></table>';
    const partResult = addMissingCalsColspecs(part, parseXml);
    check('colspec: colname="part" (no row names every column) → nothing added', partResult.added === 0 && partResult.content === part);
    const partProblems = checkCalsColspecs(parseXml(`<dmodule>${part}</dmodule>`));
    check('colspec: colname="part" → unorderableColname', JSON.stringify(partProblems) === '[{"kind":"unorderableColname","colname":"part"},{"kind":"unorderableColname","colname":"qty"}]', JSON.stringify(partProblems));
    const partLine = 'colname="part" has no <colspec> and its column cannot be worked out: add <colspec colname="part"/> to the <tgroup>, in column order';
    check('colspec: unorderable English message', formatStructureProblem(partProblems[0], 'descript') === partLine);
    check('colspec: unorderable EN/ES through i18n', formatSchemaIssue(structureIssues([partProblems[0]], { schema: 'descript' })[0], i18n.getFixedT('en')) === partLine
      && formatSchemaIssue(structureIssues([partProblems[0]], { schema: 'descript' })[0], i18n.getFixedT('es')) === 'colname="part" no tiene <colspec> y no se puede saber en qué columna va: añade <colspec colname="part"/> al <tgroup>, en el orden de las columnas');
    // Two names for the same column.
    const clash = '<table><tgroup cols="2"><tbody><row><entry colname="c1">A</entry><entry colname="col1">B</entry></row></tbody></tgroup></table>';
    check('colspec: c1 and col1 → col1 unorderable, nothing added', addMissingCalsColspecs(clash, parseXml).added === 0
      && JSON.stringify(checkCalsColspecs(parseXml(clash))) === '[{"kind":"unorderableColname","colname":"col1"}]', JSON.stringify(checkCalsColspecs(parseXml(clash))));
    // More columns than @cols: reported by the check, and (Barrido final
    // 1/2) fixed by the app -- @cols raised to the columns really used, the
    // missing colspecs added, every cell left where it is.
    const wide = noSpecs(section('2')).replace('cols="3"', 'cols="2"');
    const wideProblems = checkCalsColspecs(parseXml(wide));
    check('colspec: 3 columns with cols="2" → tooManyColumns reported', JSON.stringify(wideProblems) === '[{"kind":"tooManyColumns","columns":3,"cols":2}]', JSON.stringify(wideProblems));
    const wideFixed = addMissingCalsColspecs(wide, parseXml);
    check('final 1/2: cols="2" with 3 columns → raised to 3 and colspecs added', wideFixed.content === section('2') && JSON.stringify(wideFixed.colsRaised) === '[{"from":2,"to":3}]' && wideFixed.added === 3, wideFixed.content);
    check('final 1/2: complete table but cols too low → only cols raised', addMissingCalsColspecs(section('2').replace('cols="3"', "cols='2'"), parseXml).content === section('2').replace('cols="3"', "cols='3'"));
    const wideLine = 'the table uses 3 columns but its <tgroup> says cols="2": use at most 2 columns or raise cols';
    check('colspec: tooManyColumns English message', formatStructureProblem(wideProblems[0], 'topic') === wideLine);
    check('colspec: tooManyColumns EN/ES through i18n', formatSchemaIssue(structureIssues(wideProblems, { schema: 'topic' })[0], i18n.getFixedT('en')) === wideLine
      && formatSchemaIssue(structureIssues(wideProblems, { schema: 'topic' })[0], i18n.getFixedT('es')) === 'la tabla usa 3 columnas pero su <tgroup> dice cols="2": usa como mucho 2 columnas o sube cols');
    const beyond = '<table><tgroup cols="3"><tbody><row><entry colname="c1">A</entry><entry colname="c5">E</entry></row></tbody></tgroup></table>';
    check('colspec: c5 with cols="3" → tooManyColumns 5', JSON.stringify(checkCalsColspecs(parseXml(beyond))) === '[{"kind":"tooManyColumns","columns":5,"cols":3}]');
    // One unfixable table leaves the whole example as written.
    const mixed = `${bare}${part}`;
    check('colspec: an unfixable table blocks the whole example', addMissingCalsColspecs(mixed, parseXml).content === mixed);
    check('colspec: complete tables report nothing', checkCalsColspecs(parseXml(section('2'))).length === 0);
    // Panel note.
    check('colspec: panel note EN/ES', i18n.getFixedT('es')('records.ruleTest.colspecsAdded', { count: 3 }) === 'Ajustado por la app: se añadieron 3 colspec.'
      && i18n.getFixedT('en')('records.ruleTest.colspecsAdded', { count: 1 }) === 'Adjusted by the app: added 1 colspec.');

    // Through generateRuleTestExamples with the EXT-00001 tables: no
    // correction round, 3 colspecs added to each example, then the morerows
    // fix reads the columns by name, and both examples run.
    const colAsked = [];
    const colResult = await generateRuleTestExamples({
      ruleXml: ext1.Rule, format: 'SCH-DITA', standard: 'DITA 1.3 Xpath3.0', schemaLocation: 'flat',
      brdp: { identifier: 'BRDP-EXT-00001', title: '', definition: '', proposal: '' },
      vocabulary: vocabDita, parseXml,
      ask: async (messages) => {
        colAsked.push(messages);
        return JSON.stringify({ proposalMismatch: null, examples: [
          { label: 'quantity given', expected: 'accept', schema: 'topic', content: noSpecs(section('2')) },
          { label: 'quantity missing', expected: 'reject', schema: 'topic', content: noSpecs(section('')) },
        ] });
      },
      fetchSchemaCards: async (_std, names) => ({ cards: {}, document_schemas: ['topic'], element_schemas: Object.fromEntries(names.map((n) => [n, ['topic']])) }),
      fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
    });
    check('colspec EXT-00001: no correction round', colAsked.length === 1 && colResult.correction === null, JSON.stringify({ asked: colAsked.length, c: colResult.correction }));
    check('colspec EXT-00001: 3 colspecs added to each example', colResult.examples.every((e) => e.colspecsAdded === 3), JSON.stringify(colResult.examples.map((e) => e.colspecsAdded)));
    check('colspec EXT-00001: morerows fix applied after, by column name', colResult.examples.every((e) => JSON.stringify(e.spannedEntriesRemoved) === '[2]'), JSON.stringify(colResult.examples.map((e) => e.spannedEntriesRemoved)));
    check('colspec EXT-00001: examples run', colResult.runs.every((r) => r.validation.runnable), JSON.stringify(colResult.runs.map((r) => r.validation.structure)));
    const colVerdict = ruleTestVerdict(colResult.examples, colResult.runs, analyzeRule(ext1.Rule, 'SCH-DITA', { parseXml }));
    check('colspec EXT-00001: verdict correct', colVerdict.kind === 'correct', JSON.stringify(colVerdict));

    // "part" goes to the correction round with its reason.
    const partAsked = [];
    await generateRuleTestExamples({
      ruleXml: ext1.Rule, format: 'SCH-DITA', standard: 'DITA 1.3 Xpath3.0', schemaLocation: 'flat',
      brdp: { identifier: 'BRDP-EXT-00001', title: '', definition: '', proposal: '' },
      vocabulary: vocabDita, parseXml,
      ask: async (messages) => {
        partAsked.push(messages);
        // The header row names c1 as "part" but the body rows keep "c1":
        // no row names every column, so the app cannot order them.
        const content = partAsked.length === 1 ? section('2').replace(/<colspec colname="c\d"\/>/g, '').replace('<entry colname="c1">Part</entry>', '<entry colname="part">Part</entry>') : section('2');
        return JSON.stringify({ proposalMismatch: null, examples: [
          { label: 'quantity given', expected: 'accept', schema: 'topic', content },
          { label: 'quantity missing', expected: 'reject', schema: 'topic', content: section('') },
        ] });
      },
      fetchSchemaCards: async (_std, names) => ({ cards: {}, document_schemas: ['topic'], element_schemas: Object.fromEntries(names.map((n) => [n, ['topic']])) }),
      fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
    });
    const partCorrection = JSON.stringify(partAsked[1] || []);
    check('colspec: colname="part" goes to the correction round with its reason', partAsked.length === 2 && partCorrection.includes('colname=\\"part\\" has no <colspec>') && !partCorrection.includes('Example 2'), partCorrection.slice(0, 600));
  }

  // 2. Plain text for the markup of an element the rule does not name.
  const proced = structureOf(S42, 'proced');
  const wrap = (inner) => `<dmodule><content><procedure><mainProcedure><proceduralStep><para>${inner}</para></proceduralStep></mainProcedure></procedure></content></dmodule>`;
  const bad = validateExample(wrap('Torque to <quantity><quantityValue>25</quantityValue></quantity> and see <dmCode foo="1"/>.'), vocabulary, parseXml, proced);
  const emphNames = extractRuleNames(EMPH);
  const withHint = exampleProblems(bad, { standard: S42, schema: 'proced', ruleNames: emphNames });
  check('C3b hint: element the rule does not name → plain-text hint', withHint.includes('<quantityValue> is not allowed inside <quantity>. If this element is not needed to test the rule, remove it and use plain text.'), withHint.join('\n'));
  check('C3b hint: unknown attribute on an element the rule does not name', withHint.includes('@foo does not exist on <dmCode>. If this element is not needed to test the rule, remove it and use plain text.'), withHint.join('\n'));
  check('C3b hint: cards carry no hint', withHint.filter((l) => l.startsWith('card of')).every((l) => !l.includes('plain text')));
  const qvRule = '<structureObjectRule><objectPath allowedObjectFlag="2">//quantityValue/@quantityUnitOfMeasure</objectPath><objectUse>x</objectUse><objectValue valueForm="single" valueAllowed="N.m"/></structureObjectRule>';
  const qvHint = exampleProblems(bad, { standard: S42, schema: 'proced', ruleNames: extractRuleNames(qvRule) });
  check('C3b hint: element the rule names → no hint', qvHint.includes('<quantityValue> is not allowed inside <quantity>'), qvHint.join('\n'));
  check('C3b hint: other elements still get it', qvHint.includes('@foo does not exist on <dmCode>. If this element is not needed to test the rule, remove it and use plain text.'));
  check('C3b hint: without ruleNames nothing changes', !exampleProblems(bad, { standard: S42, schema: 'proced' }).some((l) => l.includes('plain text')));
  const unknown = validateExample(wrap('A <pokemon>x</pokemon> here.'), vocabulary, parseXml, proced);
  check('C3b hint: unknown element name gets it', exampleProblems(unknown, { standard: S42, schema: 'proced', ruleNames: emphNames }).includes('<pokemon> does not exist in S1000D 4.2. If this element is not needed to test the rule, remove it and use plain text.'));
  // Through exampleFailures (the correction round's input).
  const procSetup = setupFor(S42, EMPH, ['proced']);
  const failing = [{ label: 'Procedure without emphasis', expected: 'accept', schema: 'proced', content: 'Torque to <quantity quantityValue="25"/>.' }];
  const fRun = testRun(EMPH, failing, procSetup);
  const failures = exampleFailures(failing, fRun.materialized, fRun.runs, { ruleXml: EMPH, standard: S42, format: 'BREX-4.2', parseXml });
  check('C3b hint: the correction round carries it', failures.length === 1 && failures[0].problems.some((p) => p.endsWith('If this element is not needed to test the rule, remove it and use plain text.')), JSON.stringify(failures));
}


// ─── Rule test on DM metadata (identAndStatusSection / idstatus) ────────────
{
  const S42 = 'S1000D 4.2';
  const S301 = 'S1000D 3.0.1';
  const descript = structureOf(S42, 'descript');
  const minimal = metadataXml(descript.skeleton.metadata.tree).xml;
  // Current rows, or the real rules retired from the template (fixture).
  const t42 = [...readPublicTemplate('brdp-template-4-2.xlsx'), ...retiredTemplateRows('brdp-template-4-2.xlsx')];
  const ruleOf = (id) => t42.find((r) => r.ID === id).Rule;
  // The minimal section with one change (the LLM starts from it).
  const docCode = /<dmCode ([^>]*)infoCode="040"/;
  const withInfoCode = (code) => minimal.replace(docCode, `<dmCode $1infoCode="${code}"`);

  check('metadata: every data module skeleton has the minimal section', descript.skeleton.metadata?.element === 'identAndStatusSection' && structureOf(S301, 'descript').skeleton.metadata?.element === 'idstatus');
  check('metadata: pm, ddn and dml have their own section', ['pm', 'ddn', 'dml'].every((s) => structureOf(S42, s).skeleton.metadata?.element === 'identAndStatusSection') && structureOf(S301, 'pm').skeleton.metadata?.element === 'idstatus');
  check('metadata: not for documents without one (comment, 3.0.1 ddn)', structureOf(S42, 'comment').skeleton.metadata === null && structureOf(S301, 'ddn').skeleton.metadata === null);
  check('metadata: minimal section, in XSD order', /<dmIdent>\s*<dmCode [^>]*\/>\s*<language [^>]*\/>\s*<issueInfo [^>]*\/>/.test(minimal) && /<dmStatus>\s*<security [^>]*\/>\s*<responsiblePartnerCompany>/.test(minimal), minimal);

  // A content-only rule: unchanged placement, the minimal section is part of
  // the dimmed skeleton, the prompt says nothing about metadata.
  const STEP = '<structureObjectRule><objectPath allowedObjectFlag="0">//proceduralStep[count(proceduralStep) = 1]</objectPath><objectUse>No lone sub-step.</objectUse></structureObjectRule>';
  const stepPlace = placeExample(structureOf(S42, 'proced'), ruleTargets(STEP));
  check('metadata: content-only rule keeps its placement', stepPlace.path.join('/') === 'dmodule/content/procedure/mainProcedure' && stepPlace.metadata.insertion === false && stepPlace.contentInsertion === true && stepPlace.unreachable === null);
  const stepSetup = setupFor(S42, STEP, ['proced']);
  const stepEx = materializeExample({ label: 'x', expected: 'accept', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para></proceduralStep>' }, stepSetup, parseXml);
  check('metadata: content-only rule → minimal section in the document, dimmed', stepEx.xml.includes('<identAndStatusSection>') && stepEx.skeletonNodePaths.includes('/dmodule[1]/identAndStatusSection[1]/dmStatus[1]/security[1]') && stepEx.skeletonNodePaths.includes('/dmodule[1]/identAndStatusSection[1]/dmAddress[1]/dmAddressItems[1]/dmTitle[1]/techName[1]/text()'));
  const stepPrompt = buildRuleTestExamplesPrompt({ brdp, standard: S42, format: 'BREX-4.2', ruleXml: STEP, placements: [{ schema: 'proced', role: 'rule', ...stepPlace }] });
  check('metadata: content-only prompt says nothing about the section', !stepPrompt.includes('identification and status') && !stepPrompt.includes('"metadata"'));
  const stepLines = xmlDisplayLines(stepEx.xml, [], parseXml, stepEx.skeletonNodePaths);
  check('metadata: the section is shown dimmed', stepLines.flatMap((l) => l.segments).filter((sg) => sg.text.startsWith('<dmStatus') || sg.text === 'Example company').every((sg) => sg.skeleton));

  // S1-00052: //dmIdent/dmCode/@infoCode, flag 2 with values 055 / 930.
  const R52 = '<structureObjectRule id="BRDP-S1-00052"><objectPath allowedObjectFlag="2">//dmIdent/dmCode/@infoCode</objectPath><objectUse>Only info codes 055 and 930 are used.</objectUse><objectValue valueForm="single" valueAllowed="055"/><objectValue valueForm="single" valueAllowed="930"/></structureObjectRule>';
  const p52 = placeExample(descript, ruleTargets(R52));
  check('S1-00052: the section is the insertion point, no content', p52.metadata.insertion === true && p52.contentInsertion === false, JSON.stringify({ ...p52, metadata: '…' }));
  const set52 = setupFor(S42, R52, ['descript']);
  const ex52 = [
    { label: '055', expected: 'accept', schema: 'descript', content: '', metadata: withInfoCode('055') },
    { label: '930', expected: 'accept', schema: 'descript', content: '', metadata: withInfoCode('930') },
    { label: '000', expected: 'reject', schema: 'descript', content: '', metadata: withInfoCode('000') },
    { label: '002', expected: 'reject', schema: 'descript', content: '', metadata: withInfoCode('002') },
  ];
  const r52 = testRun(R52, ex52, set52);
  check('S1-00052: every example valid against the schema', r52.runs.every((r) => r.validation.runnable), JSON.stringify(r52.runs.map((r) => r.validation.structure)));
  check('S1-00052: 055/930 accepted, 000/002 rejected', r52.runs.map((r) => r.result.status).join() === 'accepted,accepted,rejected,rejected', JSON.stringify(r52.runs.map((r) => r.result.status)));
  check('S1-00052: the data module\'s own @infoCode selected', r52.runs[2].result.selectedNodePaths.includes('/dmodule[1]/identAndStatusSection[1]/dmAddress[1]/dmIdent[1]/dmCode[1]/@infoCode'), JSON.stringify(r52.runs[2].result.selectedNodePaths));
  check('S1-00052: verdict correct, never inconclusive', r52.verdict.kind === 'correct', JSON.stringify(r52.verdict));
  check('S1-00052: the LLM\'s section is content, not skeleton', !r52.materialized[0].skeletonNodePaths.some((p) => p.includes('identAndStatusSection')));
  const noMeta = testRun(R52, [{ label: 'forgot', expected: 'reject', schema: 'descript', content: 'x' }], set52);
  check('S1-00052: an example without its section is not run', noMeta.runs[0].validation.runnable === false && noMeta.runs[0].validation.missingMetadata === 'identAndStatusSection');
  check('S1-00052: …and the correction round says so', exampleProblems(noMeta.runs[0].validation, { standard: S42, schema: 'descript' }).includes('"metadata" is missing: write the complete <identAndStatusSection> of this example'));
  check('S1-00052: missing section in EN/ES', i18n.getFixedT('es')('records.ruleTest.missingMetadata', { element: 'identAndStatusSection' }) === 'el ejemplo no tiene <identAndStatusSection>: la regla lo mira, así que el ejemplo debe incluirlo');
  const bad52 = testRun(R52, [{ label: 'bad', expected: 'accept', schema: 'descript', content: '', metadata: withInfoCode('055').replace('<dmStatus>', '<dmStatus><content/>') }], set52);
  check('S1-00052: the written section is validated against the schema', bad52.runs[0].validation.structure.some((p) => p.kind === 'notAllowed' && p.parent === 'dmStatus'), JSON.stringify(bad52.runs[0].validation.structure));

  // Through generateRuleTestExamples: prompt, "metadata" field, no
  // correction round, verdict correct.
  const asked52 = [];
  const g52 = await generateRuleTestExamples({
    ruleXml: R52, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-S1-00052', title: 'Info codes', definition: 'Which info codes are used.', proposal: 'Only info codes 055 and 930.' },
    vocabulary, parseXml,
    ask: async (messages, systemPrompt) => {
      asked52.push(systemPrompt);
      return JSON.stringify({ proposalMismatch: null, examples: ex52.map(({ label, expected, schema, metadata }) => ({ label, expected, schema, metadata })) });
    },
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript', 'proced'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S42, schema) }),
  });
  check('S1-00052: one LLM call, no correction round', asked52.length === 1 && g52.status === 'ready' && g52.correction === null, JSON.stringify({ ...g52, systemPrompt: undefined, setup: undefined }));
  check('S1-00052: prompt offers the minimal section to start from', asked52[0].includes('your "metadata" is the WHOLE <identAndStatusSection>') && asked52[0].includes('infoCode="040"') && asked52[0].includes('write no "content"'));
  check('S1-00052: prompt says the values never go in a dmRef of the content', asked52[0].includes('never in a reference (<dmRef>) of the content'));
  // Templates round, minor items: metadata only → no "short piece of a
  // manual… 10 lines of content", which would contradict "write no content".
  check('S1-00052: metadata-only prompt never asks for a piece of a manual', !asked52[0].includes('A short piece of') && !asked52[0].includes('at most 10') && asked52[0].includes('Only the identification and status section, starting from the minimal one'));
  check('S1-00052: output format asks for "metadata" and no "content"', asked52[0].includes('"metadata": "<identAndStatusSection>…"}') && !asked52[0].includes('"content": "…"'));
  check('S1-00052: verdict through the pipeline', ruleTestVerdict(g52.examples, g52.runs, analyzeRule(R52, 'BREX-4.2', { parseXml })).kind === 'correct');
  const parsedMeta = parseRuleTestResponse(JSON.stringify({ examples: [{ label: 'a', expected: 'accept', metadata: '<identAndStatusSection/>' }] }));
  check('parse: an example with only "metadata" is accepted', parsedMeta.ok && parsedMeta.examples[0].metadata === '<identAndStatusSection/>' && parsedMeta.examples[0].content === '');
  check('parse: an example with neither is refused', !parseRuleTestResponse(JSON.stringify({ examples: [{ label: 'a', expected: 'accept' }] })).ok);

  // S1-00053 (real template rule): //@issueType[.='revised'], flag 0 --
  // the value is written in dmStatus.
  const R53 = ruleOf('BRDP-S1-00053');
  const p53 = placeExample(descript, ruleTargets(R53));
  check('S1-00053: metadata only', p53.metadata.insertion === true && p53.contentInsertion === false);
  const r53 = testRun(R53, [
    { label: 'changed', expected: 'accept', schema: 'descript', content: '', metadata: minimal.replace('<dmStatus>', '<dmStatus issueType="changed">') },
    { label: 'revised', expected: 'reject', schema: 'descript', content: '', metadata: minimal.replace('<dmStatus>', '<dmStatus issueType="revised">') },
  ], setupFor(S42, R53, ['descript']));
  check('S1-00053: revised in dmStatus rejected, changed accepted', r53.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && r53.verdict.kind === 'correct', JSON.stringify(r53.runs.map((r) => r.validation.structure)));
  check('S1-00053: dmStatus/@issueType selected', r53.runs[1].result.selectedNodePaths.includes('/dmodule[1]/identAndStatusSection[1]/dmStatus[1]/@issueType'));

  // S1-00070 (the template rule until the templates round, which replaced
  // the row: Lufthansa's own CAGE code is no example for other projects):
  // //responsiblePartnerCompany/@enterpriseCode (and enterpriseName) with
  // values -- still a good metadata case, kept here as it was written.
  const R70 = `<structureObjectRule>
            <objectPath allowedObjectFlag="1">//responsiblePartnerCompany/@enterpriseCode</objectPath>
            <objectUse>BRDP-S1-00070. The responsible partner company's enterpriseCode must be C1008 (Lufthansa Technik AG's CAGE code). </objectUse>
            <objectValue valueForm="single" valueAllowed="C1008">CAGE code for LUFTHANSA TECHNIK AG is C1008</objectValue>
          </structureObjectRule>
<structureObjectRule>
            <objectPath allowedObjectFlag="1">//responsiblePartnerCompany/enterpriseName</objectPath>
            <objectUse>BRDP-S1-00070. The responsible partner company's enterpriseName must be 'LUFTHANSA TECHNIK AG'. </objectUse>
            <objectValue valueForm="single" valueAllowed="LUFTHANSA TECHNIK AG">Enterprise Name is LUFTHANSA TECHNIK AG</objectValue>
          </structureObjectRule>`;
  const p70 = placeExample(descript, ruleTargets(R70));
  check('S1-00070: the section is an insertion point', p70.metadata.insertion === true && p70.unreachable === null);
  const rpc = (code, name) => minimal.replace('<responsiblePartnerCompany>\n      <enterpriseName>Example company</enterpriseName>', `<responsiblePartnerCompany enterpriseCode="${code}">\n      <enterpriseName>${name}</enterpriseName>`);
  const r70 = testRun(R70, [
    { label: 'LHT', expected: 'accept', schema: 'descript', content: '', metadata: rpc('C1008', 'LUFTHANSA TECHNIK AG') },
    { label: 'other', expected: 'reject', schema: 'descript', content: '', metadata: rpc('K0001', 'ACME AERO') },
  ], setupFor(S42, R70, ['descript']));
  check('S1-00070: the section was rewritten (not the minimal one)', r70.materialized[0].xml.includes('enterpriseCode="C1008"'));
  check('S1-00070: accepted / rejected on the real values', r70.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && r70.verdict.kind === 'correct', JSON.stringify(r70.runs.map((r) => [r.validation, r.result?.status])));

  // S1-00316: //dmStatus/applicRef | //pmStatus/applicRef, flag 0.
  const R316 = '<structureObjectRule id="BRDP-S1-00316"><objectPath allowedObjectFlag="0">//dmStatus/applicRef | //pmStatus/applicRef</objectPath><objectUse>Applicability is written in the status, never referenced.</objectUse></structureObjectRule>';
  const p316 = placeExample(descript, ruleTargets(R316));
  check('S1-00316: metadata (the pmStatus alternative just does not apply)', p316.metadata.insertion === true && p316.contentInsertion === false && p316.unreachable === null);
  const r316 = testRun(R316, [
    { label: 'applic', expected: 'accept', schema: 'descript', content: '', metadata: minimal },
    { label: 'applicRef', expected: 'reject', schema: 'descript', content: '', metadata: minimal.replace(/<applic>[\s\S]*?<\/applic>/, '<applicRef applicIdentValue="app-001"/>') },
  ], setupFor(S42, R316, ['descript']));
  check('S1-00316: applicRef in dmStatus rejected, applic accepted', r316.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && r316.verdict.kind === 'correct', JSON.stringify(r316.runs.map((r) => r.validation.structure)));

  // S1-00338: //@assyCode[string-length(.) != 2] -- still through a dmRef
  // in the content, and now also on the data module's own dmCode.
  const R338 = '<structureObjectRule id="BRDP-S1-00338"><objectPath allowedObjectFlag="0">//@assyCode[string-length(.) != 2]</objectPath><objectUse>The assembly code has two characters.</objectUse></structureObjectRule>';
  const p338 = placeExample(descript, ruleTargets(R338));
  check('S1-00338: two insertion points (section and content)', p338.metadata.insertion === true && p338.contentInsertion === true && p338.path.at(-1) === 'para', JSON.stringify({ ...p338, metadata: '…' }));
  const dmRef = (assy) => `See <dmRef><dmRefIdent><dmCode modelIdentCode="EXAMPLE" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="${assy}" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="A"/></dmRefIdent></dmRef>.`;
  const r338 = testRun(R338, [
    { label: 'two characters', expected: 'accept', schema: 'descript', content: dmRef('01'), metadata: minimal },
    { label: 'four in the reference', expected: 'reject', schema: 'descript', content: dmRef('0301'), metadata: minimal },
    { label: 'three in the own code', expected: 'reject', schema: 'descript', content: dmRef('01'), metadata: minimal.replace(/<dmCode assyCode="00"/, '<dmCode assyCode="001"') },
  ], setupFor(S42, R338, ['descript']));
  check('S1-00338: dmRef and own dmCode both judged', r338.runs.map((r) => r.result?.status).join() === 'accepted,rejected,rejected' && r338.verdict.kind === 'correct', JSON.stringify(r338.runs.map((r) => [r.validation.structure, r.result?.status])));
  check('S1-00338: the own dmCode is the one rejected in example 3', r338.runs[2].result.violations[0].nodePaths.includes('/dmodule[1]/identAndStatusSection[1]/dmAddress[1]/dmIdent[1]/dmCode[1]/@assyCode'), JSON.stringify(r338.runs[2].result.violations));
  const prompt338 = buildRuleTestExamplesPrompt({ brdp, standard: S42, format: 'BREX-4.2', ruleXml: R338, placements: [{ schema: 'descript', role: 'rule', ...p338 }] });
  check('S1-00338: prompt asks for both "metadata" and "content"', prompt338.includes("The rule also looks at the data module's identification and status section:") && prompt338.includes('a reject example may go against the decision here, in the content, or\n  both:') && !prompt338.includes('never in a reference') && prompt338.includes('"metadata": "<identAndStatusSection>…", "content": "…"'));
  check('S1-00338: metadata AND content → the "short piece of a manual" line stays', prompt338.includes('A short piece of an aircraft maintenance manual'));
  const R338tpl = ruleOf('BRDP-S1-00338');
  check('S1-00338 (template form): also two insertion points', placeExample(descript, ruleTargets(R338tpl)).metadata.insertion === true && placeExample(descript, ruleTargets(R338tpl)).contentInsertion === true);

  // 3.0.1: a rule on idstatus, same behaviour.
  const d301 = structureOf(S301, 'descript');
  const min301 = metadataXml(d301.skeleton.metadata.tree).xml;
  const R301 = '<objrule id="BRDP-301-ISS"><objpath>//dmaddres/issno/@type</objpath><objuse>Only new and changed issues.</objuse><objval valtype="single" val1="new"/><objval valtype="single" val1="changed"/></objrule>';
  const p301 = placeExample(d301, ruleTargets(R301));
  check('3.0.1: idstatus is the insertion point', p301.metadata.element === 'idstatus' && p301.metadata.insertion === true && p301.contentInsertion === false);
  const r301 = testRun(R301, [
    { label: 'new', expected: 'accept', schema: 'descript', content: '', metadata: min301.replace('<issno ', '<issno type="new" ') },
    { label: 'revised', expected: 'reject', schema: 'descript', content: '', metadata: min301.replace('<issno ', '<issno type="revised" ') },
  ], setupFor(S301, R301, ['descript']), { format: 'BREX-3.0.1', vocab: vocabulary301 });
  check('3.0.1: verdict correct on idstatus', r301.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && r301.verdict.kind === 'correct', JSON.stringify(r301.runs.map((r) => [r.validation.structure, r.validation.names, r.result?.status])));

  // A rule that looks at nothing an example can contain: not executable,
  // before any LLM call, with the reason in EN / ES.
  const unreachableRun = async (ruleXml) => {
    let calls = 0;
    const res = await generateRuleTestExamples({
      ruleXml, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat', brdp, vocabulary, parseXml,
      ask: async () => { calls += 1; return '{}'; },
      fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript', 'proced'] }),
      fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S42, schema) }),
    });
    return { res, calls };
  };
  const scopedPm = wrapRuleInSchemaContexts('<structureObjectRule><objectPath allowedObjectFlag="0">//pmStatus/applicRef</objectPath><objectUse>x</objectUse></structureObjectRule>', 'S1000D 4.2', ['descript']);
  const u1 = await unreachableRun(scopedPm);
  check('unreachable: pmStatus in a rule limited to descript → not executable, no LLM call', u1.calls === 0 && u1.res.status === 'not_executable' && u1.res.reason.code === 'unreachable_target' && u1.res.reason.params.names === '<pmStatus>', JSON.stringify(u1.res));
  check('unreachable: reason in EN', formatRuleTestReason(u1.res.reason, i18n.getFixedT('en')) === 'the rule looks at <pmStatus>, which the examples cannot contain.');
  check('unreachable: panel line in ES', i18n.getFixedT('es')('records.ruleTest.analysisUnreachable', { reason: formatRuleTestReason(u1.res.reason, i18n.getFixedT('es')) }) === 'No ejecutable: la regla mira <pmStatus>, que los ejemplos no pueden contener.');
  const u2 = await unreachableRun('<structureObjectRule><objectPath allowedObjectFlag="0">//dmStatuss/@issueType</objectPath><objectUse>x</objectUse></structureObjectRule>');
  check('unreachable: a name that exists nowhere', u2.calls === 0 && u2.res.reason.params.names === '<dmStatuss>', JSON.stringify(u2.res));
  const u3 = await unreachableRun(R316);
  check('unreachable: one reachable alternative is enough', u3.res.status !== 'not_executable');
}

// ─── The brexDmRef follows the data module's own code ──────────────────────
{
  const S42 = 'S1000D 4.2';
  const S301 = 'S1000D 3.0.1';
  const descript = structureOf(S42, 'descript');
  const minimal = metadataXml(descript.skeleton.metadata.tree).xml;
  const OWN = '/dmodule[1]/identAndStatusSection[1]/dmAddress[1]/dmIdent[1]/dmCode[1]';
  const BREX = '/dmodule[1]/identAndStatusSection[1]/dmStatus[1]/brexDmRef[1]/dmRef[1]/dmRefIdent[1]/dmCode[1]';
  // The minimal section with one attribute of the DM's OWN dmCode changed
  // (the brexDmRef's keeps the minimal value, as the LLM tends to write it).
  const ownCode = (attr, value) => minimal.replace(new RegExp(`(<dmIdent>\\s*<dmCode [^>]*?\\b${attr}=")[^"]*"`), `$1${value}"`);
  const brexTag = (xml) => xml.match(/<brexDmRef>[\s\S]*?(<dmCode [^>]*>)/)[1];
  const ownTag = (xml) => xml.match(/<dmIdent>\s*(<dmCode [^>]*>)/)[1];
  const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

  check('brex: the minimal section already has both codes equal (nothing to change)', normalizeBrexReferenceCode(minimal, 'identAndStatusSection').changed === false && normalizeBrexReferenceCode(minimal, 'identAndStatusSection').text === minimal);
  const n = normalizeBrexReferenceCode(ownCode('disassyCodeVariant', 'AB'), 'identAndStatusSection');
  const want = { ...attrsOf(ownTag(n.text)), infoCode: '022', itemLocationCode: 'D' };
  check('brex: every code attribute copied, infoCode 022 and itemLocationCode D kept', n.changed && JSON.stringify(attrsOf(brexTag(n.text))) === JSON.stringify(want) && attrsOf(brexTag(n.text)).disassyCodeVariant === 'AB', brexTag(n.text));
  check('brex: the rest of the section is untouched', n.text.replace(brexTag(n.text), '') === ownCode('disassyCodeVariant', 'AB').replace(brexTag(ownCode('disassyCodeVariant', 'AB')), ''));
  const learn = normalizeBrexReferenceCode(minimal.replace(/(<dmIdent>\s*<dmCode )/, '$1learnCode="H10" learnEventCode="A" '), 'identAndStatusSection');
  check('brex: optional code attributes of the own code (learnCode) copied too', attrsOf(brexTag(learn.text)).learnCode === 'H10' && attrsOf(brexTag(learn.text)).learnEventCode === 'A', brexTag(learn.text));
  const noBrex = minimal.replace(/<brexDmRef>[\s\S]*?<\/brexDmRef>/, '');
  check('brex: no brexDmRef written → nothing changed', normalizeBrexReferenceCode(noBrex, 'identAndStatusSection').text === noBrex);
  check('brex: not a section it knows → nothing changed', normalizeBrexReferenceCode('<x/>', 'pmStatus').changed === false);
  check('brex: a rule on brexDmRef is detected', ruleLooksAtBrexReference('<structureObjectRule><objectPath allowedObjectFlag="0">//brexDmRef//dmCode/@disassyCodeVariant</objectPath></structureObjectRule>') && ruleLooksAtBrexReference('<objrule><objpath objappl="0">//brexref/refdm</objpath></objrule>') && !ruleLooksAtBrexReference('<structureObjectRule><objectPath allowedObjectFlag="0">//@disassyCodeVariant</objectPath></structureObjectRule>'));

  // S1-00342: //@disassyCodeVariant[string-length(.) != 2].
  const R342 = '<structureObjectRule id="BRDP-S1-00342"><objectPath allowedObjectFlag="0">//@disassyCodeVariant[string-length(.) != 2]</objectPath><objectUse>The disassembly code variant has two characters.</objectUse></structureObjectRule>';
  const p342 = placeExample(descript, ruleTargets(R342));
  check('S1-00342: the section (and the content) are insertion points', p342.metadata.insertion === true);
  const ex342 = [
    { label: 'AB', expected: 'accept', schema: 'descript', content: '', metadata: ownCode('disassyCodeVariant', 'AB') },
    { label: 'A', expected: 'reject', schema: 'descript', content: '', metadata: ownCode('disassyCodeVariant', 'A') },
  ];
  const r342 = testRun(R342, ex342, setupFor(S42, R342, ['descript']));
  check('S1-00342: "AB" accepted, "A" rejected, verdict correct', r342.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && r342.verdict.kind === 'correct', JSON.stringify(r342.runs.map((r) => [r.validation.structure, r.result?.violations])));
  check('S1-00342: the brexDmRef got "AB" too, and the example says it was adjusted', attrsOf(brexTag(r342.materialized[0].xml)).disassyCodeVariant === 'AB' && r342.materialized[0].brexReferenceNormalized === true);
  check('S1-00342: the stored metadata is the adjusted one ("Edit" shows it)', attrsOf(brexTag(r342.materialized[0].metadata)).disassyCodeVariant === 'AB');
  check('S1-00342: the "A" example was already equal → not marked adjusted', r342.materialized[1].brexReferenceNormalized === false);
  const before = testRun(R342, ex342, { ...setupFor(S42, R342, ['descript']), keepBrexReference: true });
  check('S1-00342: without the normalization "AB" was rejected by the brexDmRef (the reported bug)', before.runs[0].result.status === 'rejected' && before.runs[0].rejectedByBrexReference === true, JSON.stringify(before.runs[0].result.violations));
  check('S1-00342: no brex note when the own code is rejected too', r342.runs[1].rejectedByBrexReference === false && r342.runs[1].result.violations.some((v) => v.nodePaths.some((p) => p.startsWith(OWN))));

  // S1-00338: unchanged.
  const R338 = '<structureObjectRule id="BRDP-S1-00338"><objectPath allowedObjectFlag="0">//@assyCode[string-length(.) != 2]</objectPath><objectUse>The assembly code has two characters.</objectUse></structureObjectRule>';
  const r338 = testRun(R338, [
    { label: '01', expected: 'accept', schema: 'descript', content: 'See the panel.', metadata: ownCode('assyCode', '01') },
    { label: '001', expected: 'reject', schema: 'descript', content: 'See the panel.', metadata: ownCode('assyCode', '001') },
  ], setupFor(S42, R338, ['descript']));
  check('S1-00338: unchanged (01 accepted, 001 rejected on the own code)', r338.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && r338.verdict.kind === 'correct' && r338.runs[1].result.violations[0].nodePaths.includes(`${OWN}/@assyCode`));

  // Anchored rule: unchanged.
  const RANCH = '<structureObjectRule id="ANCH"><objectPath allowedObjectFlag="0">//dmIdent/dmCode/@disassyCodeVariant[string-length(.) != 2]</objectPath><objectUse>Two characters.</objectUse></structureObjectRule>';
  const rAnch = testRun(RANCH, [
    { label: 'AB', expected: 'accept', schema: 'descript', content: '', metadata: ownCode('disassyCodeVariant', 'AB') },
    { label: 'A', expected: 'reject', schema: 'descript', content: '', metadata: ownCode('disassyCodeVariant', 'A') },
  ], setupFor(S42, RANCH, ['descript']));
  check('anchored //dmIdent/dmCode/@disassyCodeVariant: unchanged, correct', rAnch.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && rAnch.verdict.kind === 'correct' && !rAnch.runs.some((r) => r.rejectedByBrexReference));

  // //dmCode/@infoCode with a list without 022: the brexDmRef keeps 022,
  // and the rejection is attributed to it.
  const RINFO = '<structureObjectRule id="INFO"><objectPath allowedObjectFlag="2">//dmCode/@infoCode</objectPath><objectUse>Only 055 and 930.</objectUse><objectValue valueForm="single" valueAllowed="055"/><objectValue valueForm="single" valueAllowed="930"/></structureObjectRule>';
  const rInfo = testRun(RINFO, [
    { label: '055', expected: 'accept', schema: 'descript', content: '', metadata: ownCode('infoCode', '055') },
  ], setupFor(S42, RINFO, ['descript']));
  check('infoCode list without 022: the brexDmRef keeps infoCode="022"', attrsOf(brexTag(rInfo.materialized[0].xml)).infoCode === '022');
  check('infoCode list without 022: rejected, and the rejection is attributed to the brexDmRef', rInfo.runs[0].result.status === 'rejected' && rInfo.runs[0].rejectedByBrexReference === true && rInfo.runs[0].result.violations.every((v) => v.nodePaths.every((p) => p.startsWith(BREX))), JSON.stringify(rInfo.runs[0].result.violations));
  check('brex rejection note in EN', i18n.getFixedT('en')('records.ruleTest.rejectedByBrexReference') === "The rejection comes from the brexDmRef's data module code (the project's BREX): the rule would reject the real BREX too.");
  check('brex rejection note in ES', i18n.getFixedT('es')('records.ruleTest.rejectedByBrexReference') === 'El rechazo viene del dmCode del brexDmRef (el BREX del proyecto): la regla también rechazaría el BREX real.');
  check('brex adjusted note in EN/ES', /^Adjusted by the app: the brexDmRef/.test(i18n.getFixedT('en')('records.ruleTest.brexReferenceNormalized')) && /^Ajustado por la app: el código del brexDmRef/.test(i18n.getFixedT('es')('records.ruleTest.brexReferenceNormalized')));

  // A rule that looks at brexDmRef explicitly: what the LLM wrote there stays.
  const RBREX = '<structureObjectRule id="BREXREF"><objectPath allowedObjectFlag="0">//brexDmRef//dmCode/@disassyCodeVariant[string-length(.) != 2]</objectPath><objectUse>Two characters in the BREX reference.</objectUse></structureObjectRule>';
  const brexOnly = (value) => minimal.replace(/(<brexDmRef>[\s\S]*?<dmCode [^>]*?\bdisassyCodeVariant=")[^"]*"/, `$1${value}"`);
  const setBrex = setupFor(S42, RBREX, ['descript']);
  const rBrex = testRun(RBREX, [
    { label: 'AB in the BREX ref', expected: 'accept', schema: 'descript', content: '', metadata: brexOnly('AB') },
    { label: 'A in the BREX ref', expected: 'reject', schema: 'descript', content: '', metadata: ownCode('disassyCodeVariant', 'AB') },
  ], setBrex);
  check('rule on brexDmRef: setup keeps it', setBrex.keepBrexReference === true);
  check('rule on brexDmRef: the LLM\'s brexDmRef is kept as written', rBrex.materialized[0].metadata === brexOnly('AB') && rBrex.materialized[0].brexReferenceNormalized === undefined && attrsOf(brexTag(rBrex.materialized[1].xml)).disassyCodeVariant === 'A');
  check('rule on brexDmRef: verdict correct', rBrex.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && rBrex.verdict.kind === 'correct');
  const prepared = await prepareRuleTestSetup({
    ruleXml: RBREX, standard: S42, schemaLocation: 'flat',
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S42, schema) }),
  });
  check('prepareRuleTestSetup: keepBrexReference from the rule', prepared.setup.keepBrexReference === true);

  // A content-only rule: the minimal section is the skeleton, never touched.
  const STEP = '<structureObjectRule><objectPath allowedObjectFlag="0">//proceduralStep[count(proceduralStep) = 1]</objectPath><objectUse>No lone sub-step.</objectUse></structureObjectRule>';
  const stepEx = materializeExample({ label: 'x', expected: 'accept', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para></proceduralStep>', metadata: ownCode('disassyCodeVariant', 'AB') }, setupFor(S42, STEP, ['proced']), parseXml);
  check('content-only rule: no normalization, the section is the minimal skeleton', stepEx.brexReferenceNormalized === undefined && !stepEx.xml.includes('"AB"'));

  // 3.0.1: the <avee> of brexref/refdm rebuilt from the <avee> of dmc.
  const d301 = structureOf(S301, 'descript');
  const min301 = metadataXml(d301.skeleton.metadata.tree).xml;
  check('3.0.1: the minimal section already has both codes equal', normalizeBrexReferenceCode(min301, 'idstatus').changed === false);
  const own301 = (child, value) => min301.replace(new RegExp(`(<dmc>[\\s\\S]*?<${child}>)[^<]*`), `$1${value}`);
  const brexAvee = (xml) => xml.match(/<refdm>\s*<avee>([\s\S]*?)<\/avee>/)[1];
  const ownAvee = (xml) => xml.match(/<dmc>\s*<avee>([\s\S]*?)<\/avee>/)[1];
  const n301 = normalizeBrexReferenceCode(own301('discodev', 'AB'), 'idstatus');
  const childrenOf = (inner) => [...inner.matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map((m) => `${m[1]}=${m[2]}`);
  check('3.0.1: avee of the brexref from the dmc, incode 022 / itemloc D', n301.changed && JSON.stringify(childrenOf(brexAvee(n301.text))) === JSON.stringify(childrenOf(ownAvee(n301.text)).map((c) => (c.startsWith('incode=') ? 'incode=022' : c.startsWith('itemloc=') ? 'itemloc=D' : c))) && brexAvee(n301.text).includes('<discodev>AB</discodev>'), brexAvee(n301.text));
  check('3.0.1: laid out like before (one child per line, well-formed)', brexAvee(n301.text).split('\n').length === brexAvee(min301).split('\n').length && parseXml(n301.text).documentElement.nodeName === 'idstatus', n301.text);
  const R301 = '<objrule id="DISCODEV"><objpath objappl="0">//discodev[string-length(.) != 2]</objpath><objuse>Two characters.</objuse></objrule>';
  const r301 = testRun(R301, [
    { label: 'AB', expected: 'accept', schema: 'descript', content: '', metadata: own301('discodev', 'AB') },
    { label: 'A', expected: 'reject', schema: 'descript', content: '', metadata: own301('discodev', 'A') },
  ], setupFor(S301, R301, ['descript']), { format: 'BREX-3.0.1', vocab: vocabulary301 });
  check('3.0.1: //discodev "AB" accepted, "A" rejected', r301.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && r301.verdict.kind === 'correct', JSON.stringify(r301.runs.map((r) => [r.validation.structure, r.validation.names, r.result?.status])));
}

// ─── One schema per part of the rule (S1-00120) ─────────────────────────────
{
  const S42 = 'S1000D 4.2';
  // The real 4.2 cards (as GET /api/schema-cards serves them) and the real
  // document schemas.
  const cards42 = JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-4-2.json', import.meta.url))).cards;
  const docs42 = [...new Set(Object.values(cards42).flatMap((vs) => vs.flatMap((v) => v.schemas)))]
    .filter((sc) => !['dc', 'rdf', 'xlink', 'xcf'].includes(sc))
    .sort();
  const fetchCards = async (_std, names) => ({
    cards: Object.fromEntries(names.filter((n) => cards42[n]).map((n) => [n, { variants: cards42[n] }])),
    document_schemas: docs42,
  });
  const fetched = [];
  const fetchStructure = async (_std, schema) => {
    fetched.push(schema);
    const st = structureOf(S42, schema);
    return st ? { available: true, ...st } : { available: false };
  };
  const R120 = `<structureObjectRule id="BRDP-S1-00120"><objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor-or-self::proceduralStep) &gt; 5] | //levelledPara[count(ancestor-or-self::levelledPara) &gt; 5]</objectPath><objectUse>No more than five levels of steps or paragraphs.</objectUse></structureObjectRule>
<structureObjectRule id="BRDP-S1-00120-b"><objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor-or-self::proceduralStep) = 5]/title | //levelledPara[count(ancestor-or-self::levelledPara) = 5]/title</objectPath><objectUse>The fifth level has no title.</objectUse></structureObjectRule>`;
  const inSb = docs42.filter((sc) => ['proceduralStep', 'levelledPara'].every((n) => cards42[n].some((v) => v.schemas.includes(sc))));
  check('S1-00120: the only schema with both elements is sb', JSON.stringify(inSb) === '["sb"]', JSON.stringify(inSb));
  const names = ['proceduralStep', 'levelledPara', 'title'];
  const choice = chooseTestSchemas({ documentSchemas: docs42, cards: (await fetchCards(S42, names)).cards, targets: ruleTargets(R120) });
  check('S1-00120: grouped by schema: descript (levelledPara), proced (proceduralStep)', JSON.stringify(choice.groups?.map((g) => [g.schema, g.checked])) === '[["descript",["levelledPara","title"]],["proced",["proceduralStep","title"]]]', JSON.stringify(choice));
  check('S1-00120: never sb', choice.testSchema !== 'sb' && !choice.groups.some((g) => g.schema === 'sb'));
  const prep = await prepareRuleTestSetup({ ruleXml: R120, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards, fetchStructure });
  const pp = prep.promptPlacements;
  check('S1-00120: two rule placements, one per group', pp.length === 2 && pp.every((x) => x.role === 'rule') && JSON.stringify(pp.map((x) => [x.schema, x.insertion, x.group])) === '[["descript","description",["levelledPara","title"]],["proced","mainProcedure",["proceduralStep","title"]]]', JSON.stringify(pp.map((x) => [x.schema, x.insertion, x.group])));
  check('S1-00120: sb structure never fetched', !fetched.includes('sb'));
  check('S1-00120: reachable (not "not executable")', prep.unreachable === null);
  const prompt120 = buildRuleTestExamplesPrompt({ brdp: { identifier: 'BRDP-S1-00120', title: 'Levels', definition: 'How many levels.', proposal: 'At most five levels of steps and paragraphs; the fifth level has no title.' }, standard: S42, format: 'BREX-4.2', ruleXml: R120, placements: pp });
  check('S1-00120: prompt splits the examples by schema', prompt120.includes('the\nexamples are split by schema. For EACH of these schemas write at least one\nexample that follows the decision and one that goes against it') && prompt120.includes('- "descript": for <levelledPara>, <title>') && prompt120.includes('- "proced": for <proceduralStep>, <title>'), prompt120);
  check('S1-00120: prompt places each schema', prompt120.includes('- schema "descript": your content goes directly inside <description>') && prompt120.includes('- schema "proced": your content goes directly inside <mainProcedure>'));
  check('S1-00120: no single-schema sentence', !prompt120.includes('The rule is general: every example uses'));

  const nest = (el, depth, titleAt = null) => {
    let inner = '';
    for (let level = depth; level >= 1; level -= 1) {
      const title = level === titleAt ? `<title>Level ${level}</title>` : '';
      inner = `<${el}>${title}<para>Level ${level} text.</para>${inner}</${el}>`;
    }
    return inner;
  };
  const ex120 = [
    { label: '5 paragraph levels', expected: 'accept', schema: 'descript', content: nest('levelledPara', 5) },
    { label: '6 paragraph levels', expected: 'reject', schema: 'descript', content: nest('levelledPara', 6) },
    { label: 'title on paragraph level 5', expected: 'reject', schema: 'descript', content: nest('levelledPara', 5, 5) },
    { label: '5 step levels', expected: 'accept', schema: 'proced', content: nest('proceduralStep', 5) },
    { label: '6 step levels', expected: 'reject', schema: 'proced', content: nest('proceduralStep', 6) },
    { label: 'title on step level 5', expected: 'reject', schema: 'proced', content: nest('proceduralStep', 5, 5) },
  ];
  const r120 = testRun(R120, ex120, prep.setup);
  check('S1-00120: every example valid in its schema', r120.runs.every((r) => r.validation.runnable), JSON.stringify(r120.runs.map((r) => r.validation.structure)));
  check('S1-00120: accept / reject / reject per schema', r120.runs.map((r) => r.result?.status).join() === 'accepted,rejected,rejected,accepted,rejected,rejected', JSON.stringify(r120.runs.map((r) => r.result?.status)));
  check('S1-00120: verdict correct', r120.verdict.kind === 'correct', JSON.stringify(r120.verdict));
  // Through generateRuleTestExamples (the panel and the eval harness).
  let asked = null;
  const g120 = await generateRuleTestExamples({
    ruleXml: R120, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-S1-00120', title: 'Levels', definition: 'How many levels.', proposal: 'At most five levels.' },
    vocabulary, parseXml,
    ask: async (_m, sys) => { asked = sys; return JSON.stringify({ proposalMismatch: null, examples: ex120 }); },
    fetchSchemaCards: fetchCards, fetchStructure,
  });
  check('S1-00120: pipeline, one LLM call, verdict correct', g120.status === 'ready' && g120.correction === null && ruleTestVerdict(g120.examples, g120.runs, analyzeRule(R120, 'BREX-4.2', { parseXml })).kind === 'correct' && asked.includes('- "proced": for <proceduralStep>'), JSON.stringify(g120.runs.map((r) => r.result?.status)));

  // Unchanged cases: one element, a context rule, a metadata rule.
  const single = '<structureObjectRule><objectPath allowedObjectFlag="0">//proceduralStep[count(proceduralStep) = 1]</objectPath><objectUse>No lone sub-step.</objectUse></structureObjectRule>';
  const cSingle = chooseTestSchemas({ documentSchemas: docs42, cards: (await fetchCards(S42, ['proceduralStep'])).cards, targets: ruleTargets(single) });
  check('one element: no groups, proced', cSingle.groups === null && cSingle.testSchema === 'proced');
  const pSingle = await prepareRuleTestSetup({ ruleXml: single, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards, fetchStructure });
  check('one element: one rule placement without group', pSingle.promptPlacements.length === 1 && pSingle.promptPlacements[0].group === undefined);
  const scoped120 = wrapRuleInSchemaContexts(R120, 'BREX-4.2', S42, ['proced']);
  const cScoped = chooseTestSchemas({ contextSchemas: ['proced'], documentSchemas: docs42, cards: (await fetchCards(S42, names)).cards, targets: ruleTargets(scoped120) });
  check('context rule: schema fixed, no groups', cScoped.groups === null && cScoped.testSchema === 'proced', JSON.stringify(cScoped));
  const R52 = '<structureObjectRule id="BRDP-S1-00052"><objectPath allowedObjectFlag="2">//dmIdent/dmCode/@infoCode</objectPath><objectUse>x</objectUse><objectValue valueForm="single" valueAllowed="055"/></structureObjectRule>';
  const c52 = chooseTestSchemas({ documentSchemas: docs42, cards: (await fetchCards(S42, ['dmIdent', 'dmCode'])).cards, targets: ruleTargets(R52) });
  check('metadata rule S1-00052: no groups, descript', c52.groups === null && c52.testSchema === 'descript');
  const R316 = '<structureObjectRule><objectPath allowedObjectFlag="0">//dmStatus/applicRef | //pmStatus/applicRef</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const c316 = chooseTestSchemas({ documentSchemas: docs42, cards: (await fetchCards(S42, ['dmStatus', 'pmStatus', 'applicRef'])).cards, targets: ruleTargets(R316) });
  check('S1-00316 (pmStatus alternative): no groups, descript', c316.groups === null && c316.testSchema === 'descript', JSON.stringify(c316));
  const mixed = '<structureObjectRule><objectPath allowedObjectFlag="0">//dmRef | //proceduralStep</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const cMixed = chooseTestSchemas({ documentSchemas: docs42, cards: (await fetchCards(S42, ['dmRef', 'proceduralStep'])).cards, targets: ruleTargets(mixed) });
  check('a schema with all that is preferred for one part: no groups (proced)', cMixed.groups === null && cMixed.testSchema === 'proced', JSON.stringify(cMixed));

  // Mejoras A, Part 1: the test schema has every element step of the path.
  for (const [id, first] of [['BRDP-S1-00223', 'optionalPart'], ['BRDP-S1-00224', 'preferredSparePart']]) {
    const rule = `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">//${first}/catalogSeqNumberRef</objectPath><objectUse>No CSN reference in ${first}.</objectUse></structureObjectRule>`;
    const c = chooseTestSchemas({ documentSchemas: docs42, cards: (await fetchCards(S42, [first, 'catalogSeqNumberRef'])).cards, targets: ruleTargets(rule) });
    check(`${id}: test schema ipd (has <${first}>), not descript`, c.groups === null && c.testSchema === 'ipd', JSON.stringify(c));
    const prep = await prepareRuleTestSetup({ ruleXml: rule, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards, fetchStructure });
    const pl = prep.promptPlacements[0];
    check(`${id}: reachable, placed in ipd`, prep.unreachable === null && pl.schema === 'ipd', JSON.stringify([prep.unreachable, pl.schema]));
    const way = (pl.routes?.steps || []).map((st) => st.parent).join('/');
    check(`${id}: the way down goes to <${first}> through itemSeqNumber/partSegment/partRefGroup`, /itemSeqNumber\/partSegment\/partRefGroup$/.test(way) && pl.routes.steps.at(-1).children.includes(first), way);
    const content = `<catalogSeqNumber figureNumber="01" item="001"><itemSeqNumber itemSeqNumberValue="00A"><quantityPerNextHigherAssy>1</quantityPerNextHigherAssy><partRef manufacturerCodeValue="12345" partNumberValue="P1"/><partSegment><itemIdentData><descrForPart>Bolt</descrForPart></itemIdentData><partRefGroup><${first}>__X__<partRef manufacturerCodeValue="12345" partNumberValue="P2"/></${first}></partRefGroup></partSegment><applicabilitySegment><usableOnCodeAssy>A</usableOnCodeAssy></applicabilitySegment></itemSeqNumber></catalogSeqNumber>`;
    const ex = [
      { label: 'no reference', expected: 'accept', content: content.replace('__X__', '') },
      { label: 'with reference', expected: 'reject', content: content.replace('__X__', '<catalogSeqNumberRef figureNumber="02" item="003"/>') },
    ];
    const r = testRun(rule, ex, prep.setup);
    check(`${id}: both ipd examples valid`, r.runs.every((x) => x.validation.runnable), JSON.stringify(r.runs.map((x) => x.validation.structure)));
    check(`${id}: accepted / rejected, verdict correct`, r.runs.map((x) => x.result?.status).join() === 'accepted,rejected' && r.verdict.kind === 'correct', JSON.stringify([r.runs.map((x) => x.result?.status), r.verdict.kind]));
  }
  // No schema has all the steps together: "not executable", no LLM call.
  {
    const rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//optionalPart/proceduralStep</objectPath><objectUse>x</objectUse></structureObjectRule>';
    const prep = await prepareRuleTestSetup({ ruleXml: rule, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards, fetchStructure });
    check('no schema with all steps: unreachable', prep.unreachable?.code === 'unreachable_target', JSON.stringify(prep.unreachable));
  }

  // Part 2: every example invalid → the schema and the reason are named.
  const sbSetup = { standard: S42, schemaLocation: 'flat', placements: { sb: { structure: structureOf(S42, 'sb'), placement: placeExample(structureOf(S42, 'sb'), ruleTargets(R120)) } } };
  const sbPlace = sbSetup.placements.sb.placement;
  const bad = ['a', 'b', 'c', 'd'].map((l, i) => ({ label: l, expected: i % 2 ? 'reject' : 'accept', schema: 'sb', content: '<sbSummary><levelledPara><para>x</para></levelledPara></sbSummary>' }));
  const rBad = testRun(R120, bad, sbSetup);
  check('no runnable: sb placement is where the old choice put it', sbPlace.insertion !== null, JSON.stringify(sbPlace.path));
  check('no runnable: verdict names the schema and counts its examples', rBad.verdict.kind === 'no_runnable' && rBad.verdict.bySchema.length === 1 && rBad.verdict.bySchema[0].schema === 'sb' && rBad.verdict.bySchema[0].count === 4, JSON.stringify(rBad.verdict.bySchema?.map((b) => [b.schema, b.count])));
  const firstProblem = formatSchemaIssue(structureIssues(rBad.verdict.bySchema[0].validation.structure, { schema: 'sb' })[0], i18n.getFixedT('en'));
  check('no runnable: the first reason is a real structure problem', /is not allowed inside <sbSummary>|does not exist/.test(firstProblem), firstProblem);
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  check('no runnable: text EN', en('records.ruleTest.verdicts.noRunnableSchema', { schema: 'sb', count: 4, problem: '<levelledPara> is not allowed inside <sbSummary>', more: en('records.ruleTest.verdicts.noRunnableMore', { count: 2 }) }) === 'The 4 examples of the sb schema are not valid there: <levelledPara> is not allowed inside <sbSummary> (and 2 more problems).');
  check('no runnable: text ES', es('records.ruleTest.verdicts.noRunnableSchema', { schema: 'sb', count: 1, problem: 'x', more: '' }) === 'El ejemplo del esquema sb no es válido en él: x.');
  check('no runnable: record unchanged', JSON.stringify((await import("../src/utils/ruleTestReasons.js")).verdictToTestRecord(rBad.verdict)) === '{"result":"inconclusive","reason":{"code":"test_no_runnable","params":{}}}');
}

// ─── Templates round: the curated rules that were rewritten or replaced ────
// Real rules of public/brdp-template-4-1.xlsx and -4-2.xlsx, run through
// the same placement, assembly, validation and engine as the panel.
{
  const S41 = 'S1000D 4.1';
  const S42 = 'S1000D 4.2';
  const vocab41 = vocabOf('schema-vocabulary-4-1.json');
  const t41 = readPublicTemplate('brdp-template-4-1.xlsx');
  const t42 = readPublicTemplate('brdp-template-4-2.xlsx');
  // Real rules retired from the 4.1 template when it was rebuilt with the
  // 10 project decisions (fixture): still exercised here.
  const retired41 = retiredTemplateRows('brdp-template-4-1.xlsx');
  const rule41 = (id) => (t41.find((r) => r.ID === id) ?? retired41.find((r) => r.ID === id))?.Rule;
  const rule42 = (id) => t42.find((r) => r.ID === id)?.Rule;
  check('templates: replaced 4.1 rows are gone', !rule41('BRDP-EXT-00027') && !rule41('BRDP-EXT-00044'));
  check('templates: replaced 4.2 row is gone', !rule42('BRDP-S1-00070') && Boolean(rule42('BRDP-S1-00187')));
  const run41 = (rule, examples, schemas) => testRun(rule, examples, setupFor(S41, rule, schemas), { format: 'BREX-4.1', vocab: vocab41 });
  const statuses = (r) => r.runs.map((x) => x.result?.status || `invalid:${JSON.stringify(x.validation)}`).join();

  // Predicates now say where the example goes: a path that selects content
  // with a predicate on dmStatus needs the section written too.
  const R14 = rule41('BRDP-EXT-00014');
  const d41 = structureOf(S41, 'descript');
  const p14 = placeExample(d41, ruleTargets(R14));
  check('EXT-00014: predicate on dmStatus → the LLM writes the section and the content', p14.metadata.insertion === true && p14.contentInsertion === true && p14.unreachable === null, JSON.stringify({ m: p14.metadata.insertion, c: p14.contentInsertion }));
  const min41 = metadataXml(d41.skeleton.metadata.tree).xml;
  const issueType = (v) => min41.replace('<dmStatus>', `<dmStatus issueType="${v}">`);
  const r14 = run41(R14, [
    { label: 'changed', expected: 'accept', schema: 'descript', content: 'Torque the bolt <changeInline changeMark="1">to 25 N.m</changeInline>.', metadata: issueType('changed') },
    { label: 'new', expected: 'reject', schema: 'descript', content: 'Torque the bolt <changeInline changeMark="1">to 25 N.m</changeInline>.', metadata: issueType('new') },
  ], ['descript']);
  check('EXT-00014: change mark in a changed DM accepted, in a new one rejected', statuses(r14) === 'accepted,rejected' && r14.verdict.kind === 'correct', statuses(r14));

  const R36 = rule41('BRDP-EXT-00036');
  const p36 = placeExample(d41, ruleTargets(R36));
  check('EXT-00036: metadata only', p36.metadata.insertion === true && p36.contentInsertion === false);
  const issue = (no, type) => issueType(type).replace(/issueNumber="\d+"/, `issueNumber="${no}"`);
  const r36 = run41(R36, [
    { label: '001 new', expected: 'accept', schema: 'descript', content: '', metadata: issue('001', 'new') },
    { label: '001 changed', expected: 'reject', schema: 'descript', content: '', metadata: issue('001', 'changed') },
    { label: '002 changed', expected: 'accept', schema: 'descript', content: '', metadata: issue('002', 'changed') },
  ], ['descript']);
  check('EXT-00036: issue 001 must be new', statuses(r36) === 'accepted,rejected,accepted' && r36.verdict.kind === 'correct', statuses(r36));

  const R40 = rule41('BRDP-EXT-00040');
  const r40 = run41(R40, [
    { label: 'words', expected: 'accept', schema: 'descript', content: 'Set the valve <changeInline changeMark="1">to the open position</changeInline>.' },
    { label: 'element', expected: 'reject', schema: 'descript', content: '<changeInline changeMark="1"><emphasis>Warning lights</emphasis></changeInline> come on.' },
  ], ['descript']);
  check('EXT-00040: changeInline around a whole element rejected, around words accepted', statuses(r40) === 'accepted,rejected' && r40.verdict.kind === 'correct', statuses(r40));

  // Ajustes tras la pasada real, Part 2: every reject example sent back is
  // told to keep what the rule checks. Real case: the reject example had a
  // <changeInline> around an invalid element and the correction replaced it
  // with plain text (the test ended inconclusive).
  const keepLine = 'Keep a node matched by `//changeInline[* and not(text()[normalize-space()])]`: fix the markup around it, do not remove it.';
  const brokenReject = '<changeInline changeMark="1"><pokemonRef>Warning lights</pokemonRef></changeInline> come on.';
  const wordsAccept = 'Set the valve <changeInline changeMark="1">to the open position</changeInline>.';
  const broken40 = run41(R40, [
    { label: 'words', expected: 'accept', schema: 'descript', content: wordsAccept },
    { label: 'element', expected: 'reject', schema: 'descript', content: brokenReject },
  ], ['descript']);
  const f40 = exampleFailures(
    [{ label: 'words', expected: 'accept' }, { label: 'element', expected: 'reject' }],
    broken40.materialized, broken40.runs, { ruleXml: R40, standard: S41, format: 'BREX-4.1', parseXml });
  check('keep matched node: the invalid reject example is told to keep the changeInline', f40.length === 1 && f40[0].index === 1 && f40[0].problems.at(-1) === keepLine, JSON.stringify(f40));
  const brokenAccept = run41(R40, [
    { label: 'words', expected: 'accept', schema: 'descript', content: 'Set the <pokemonRef>valve</pokemonRef> open.' },
    { label: 'element', expected: 'reject', schema: 'descript', content: '<changeInline changeMark="1"><emphasis>Warning lights</emphasis></changeInline> come on.' },
  ], ['descript']);
  const fAccept = exampleFailures(
    [{ label: 'words', expected: 'accept' }, { label: 'element', expected: 'reject' }],
    brokenAccept.materialized, brokenAccept.runs, { ruleXml: R40, standard: S41, format: 'BREX-4.1', parseXml });
  check('keep matched node: never on an accept example', fAccept.length === 1 && fAccept[0].index === 0 && !fAccept[0].problems.some((p) => p.startsWith('Keep a node')), JSON.stringify(fAccept));
  const missing40 = run41(R40, [
    { label: 'words', expected: 'accept', schema: 'descript', content: wordsAccept },
    { label: 'element', expected: 'reject', schema: 'descript', content: 'Warning lights come on.' },
  ], ['descript']);
  const fMissing = exampleFailures(
    [{ label: 'words', expected: 'accept' }, { label: 'element', expected: 'reject' }],
    missing40.materialized, missing40.runs, { ruleXml: R40, standard: S41, format: 'BREX-4.1', parseXml });
  check('keep matched node: a valid reject example without the node gets only the "must contain" line', fMissing.length === 1 && fMissing[0].problems.length === 1 && fMissing[0].problems[0].startsWith('This example must contain'), JSON.stringify(fMissing));
  const asked40 = [];
  const answer40 = (rejectContent) => JSON.stringify({ proposalMismatch: null, examples: [
    { label: 'words', expected: 'accept', schema: 'descript', content: wordsAccept },
    { label: 'element', expected: 'reject', schema: 'descript', content: rejectContent },
  ] });
  const gen40 = await generateRuleTestExamples({
    ruleXml: R40, format: 'BREX-4.1', standard: S41, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00040', title: 'Change marks on whole elements', definition: '', proposal: 'Whole elements shall not be marked with changeInline.' },
    vocabulary: vocab41, parseXml,
    ask: async (messages, systemPrompt) => {
      asked40.push({ messages, systemPrompt });
      if (asked40.length === 1) return answer40(brokenReject);
      // Like the real LLM: without the keep line it drops the changeInline.
      return answer40(messages.at(-1).content.includes('Keep a node matched by')
        ? '<changeInline changeMark="1"><emphasis>Warning lights</emphasis></changeInline> come on.'
        : 'Warning lights come on.');
    },
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript', 'proced'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S41, schema) }),
  });
  check('keep matched node: the correction request carries the line', asked40.length === 2 && asked40[1].messages.at(-1).content.includes(keepLine), asked40[1]?.messages.at(-1).content);
  check('keep matched node: corrected example keeps the changeInline → correct', gen40.status === 'ready' && gen40.runs[1].result?.status === 'rejected' && ruleTestVerdict(gen40.examples, gen40.runs, analyzeRule(R40, 'BREX-4.1', { parseXml })).kind === 'correct', JSON.stringify(gen40.runs.map((x) => x.result?.status)));

  const R41 = rule41('BRDP-EXT-00041');
  const r41 = run41(R41, [
    { label: 'live target', expected: 'accept', schema: 'descript', content: 'See <internalRef internalRefId="par-0002"/> and <changeInline changeType="delete" id="chg-0001">old text</changeInline>.' },
    { label: 'deleted target', expected: 'reject', schema: 'descript', content: 'See <internalRef internalRefId="chg-0001"/> and <changeInline changeType="delete" id="chg-0001">old text</changeInline>.' },
  ], ['descript']);
  check('EXT-00041: reference to deleted information rejected', statuses(r41) === 'accepted,rejected' && r41.verdict.kind === 'correct', statuses(r41));

  // EXT-00019: the 4.x data update file has its own minimal section now;
  // the predicate on updateCode makes the LLM write it, the one on the CIR
  // elements the content.
  const R19 = rule41('BRDP-EXT-00019');
  const u41 = structureOf(S41, 'update');
  check('update: the data update file has an identification and status section', u41.skeleton.metadata?.element === 'updateIdentAndStatusSection');
  const p19 = placeExample(u41, ruleTargets(R19));
  check('EXT-00019: section and content both in the LLM\'s hands', p19.metadata.insertion === true && p19.contentInsertion === true && p19.insertion === 'update', JSON.stringify({ m: p19.metadata.insertion, c: p19.contentInsertion, i: p19.insertion }));
  const minU = metadataXml(u41.skeleton.metadata.tree).xml;
  const tool = (code) => minU.replace(/(<updateCode [^>]*)infoCode="040"/, `$1infoCode="${code}"`);
  check('EXT-00019: the minimal section carries updateCode/@infoCode 040', tool('00N') !== minU);
  const r19 = run41(R19, [
    { label: 'tools', expected: 'accept', schema: 'update', content: '<insertObjectGroup><insertObject><toolSpec/></insertObject></insertObjectGroup>', metadata: tool('00N') },
    { label: 'part in tool CIR', expected: 'reject', schema: 'update', content: '<insertObjectGroup><insertObject><partSpec/></insertObject></insertObjectGroup>', metadata: tool('00N') },
    { label: 'part in parts CIR', expected: 'accept', schema: 'update', content: '<insertObjectGroup><insertObject><partSpec/></insertObject></insertObjectGroup>', metadata: tool('00E') },
  ], ['update']);
  check('EXT-00019: a part in the tool CIR rejected, in another CIR accepted', statuses(r19) === 'accepted,rejected,accepted' && r19.verdict.kind === 'correct', statuses(r19));

  // Plantillas, Part 3: the real run had 0/3 valid update examples -- the
  // LLM wrote the CIR elements straight inside <update>. The prompt now
  // gets the valid way down from the insertion point and the cards of the
  // elements involved (the rule's and the ones its objectUse names).
  check('ruleUseNames: the words of objectUse', ruleUseNames(R19).includes('toolSpec') && ruleUseNames(R19).includes('figure'));
  const p19r = placeExample(u41, ruleTargets(R19), { useNames: ruleUseNames(R19), withRoutes: true });
  const steps19 = Object.fromEntries((p19r.routes?.steps || []).map((st) => [st.parent, st]));
  check('EXT-00019 routes: from <update>', p19r.routes?.from === 'update', JSON.stringify(p19r.routes?.from));
  check('EXT-00019 routes: update > insertObjectGroup > insertObject > partSpec/toolSpec',
    steps19.update?.children.includes('insertObjectGroup') && steps19.insertObjectGroup?.children.includes('insertObject')
      && steps19.insertObject?.children.includes('partSpec') && steps19.insertObject?.children.includes('toolSpec'));
  check('EXT-00019 routes: insertObject lists its own attributes', steps19.insertObject?.attributes.includes('targetPath'));
  check('EXT-00019 routes: deleteObject leads to the Ident elements', steps19.deleteObject?.children.includes('partIdent'));
  const card = (name) => p19r.routes.cards.find((c) => c.name === name);
  check('EXT-00019 cards: partSpec with partIdent and its real attributes', card('partSpec')?.children.some((c) => c.name === 'partIdent' && c.attributes.includes('partNumberValue')));
  check('EXT-00019 cards: toolSpec (named in objectUse)', !!card('toolSpec') && card('toolSpec').children.some((c) => c.name === 'toolIdent'));
  check('EXT-00019 cards: generic attributes never listed', !card('partSpec').children.some((c) => c.attributes.includes('changeMark')));
  check('EXT-00019 routes: without withRoutes, none', placeExample(u41, ruleTargets(R19)).routes === null);
  const prompt19 = buildRuleTestExamplesPrompt({ brdp: { identifier: 'BRDP-EXT-00019', title: 't', definition: 'd', proposal: 'p' }, standard: S41, format: 'BREX-4.1', ruleXml: R19, placements: [{ schema: 'update', role: 'rule', ...p19r }] });
  check('EXT-00019 prompt: the valid way down and the cards', prompt19.includes('The valid way down in this schema') && prompt19.includes('<insertObjectGroup> > <insertObject>') && prompt19.includes('<partSpec>: children'));
  check('contentRoutes: every checked name directly inside -> null', contentRoutes(u41, 'insertObject', ['partSpec', 'toolSpec']) === null);
  check('contentRoutes: no insertion point -> null', contentRoutes(u41, null, ['partSpec']) === null);
  // Which placements get routes (prepareRuleTestSetup): only S1000D schemas
  // whose skeleton does not reach <para> -- the prompt of every other case
  // (snapshot) stays the same.
  const prep19 = await prepareRuleTestSetup({
    ruleXml: R19, standard: S41, schemaLocation: 'flat',
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['update'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S41, schema) }),
  });
  check('prepareRuleTestSetup: EXT-00019 on update has routes', !!prep19.promptPlacements[0]?.routes);
  const prepStep = await prepareRuleTestSetup({
    ruleXml: '<structureObjectRule><objectPath allowedObjectFlag="0">//proceduralStep[count(proceduralStep) = 1]</objectPath><objectUse>x</objectUse></structureObjectRule>', standard: S42, schemaLocation: 'flat',
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['proced'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S42, schema) }),
  });
  check('prepareRuleTestSetup: a para-derived schema gets no routes', prepStep.promptPlacements.every((pl) => pl.routes === null));
  const r19ok = run41(R19, [
    { label: 'tools', expected: 'accept', schema: 'update', content: '<insertObjectGroup><insertObject insertionOrder="1" targetPath="/"><toolSpec><toolIdent manufacturerCodeValue="K0001" toolNumber="T-100"/></toolSpec></insertObject></insertObjectGroup>', metadata: tool('00N') },
    { label: 'part', expected: 'reject', schema: 'update', content: '<insertObjectGroup><insertObject insertionOrder="1" targetPath="/"><partSpec><partIdent manufacturerCodeValue="K0001" partNumberValue="P-100"/></partSpec></insertObject></insertObjectGroup>', metadata: tool('00N') },
  ], ['update']);
  const r19bad = run41(R19, [
    { label: 'straight in update', expected: 'reject', schema: 'update', content: '<insertObject><partSpec/></insertObject>', metadata: tool('00N') },
  ], ['update']);
  // Ruta del esquema, Part 2: the real run's <insertObject> straight inside
  // <update> has a single valid way (update/insertObjectGroup/insertObject),
  // so the application now moves it there instead of sending it back.
  check('EXT-00019: <insertObject> straight inside <update> moved by the app (the real run)',
    r19bad.materialized[0].relocated?.[0]?.path.join('/') === 'update/insertObjectGroup/insertObject'
      && r19bad.materialized[0].content === '<insertObjectGroup><insertObject><partSpec/></insertObject></insertObjectGroup>'
      && r19bad.runs[0].validation.runnable === true, JSON.stringify({ c: r19bad.materialized[0].content, r: r19bad.materialized[0].relocated, s: r19bad.runs[0].validation.structure }));
  check('EXT-00019: examples written along the route are valid and give the right verdict', r19ok.runs.every((r) => r.validation.runnable) && statuses(r19ok) === 'accepted,rejected' && r19ok.verdict.kind === 'correct', statuses(r19ok));

  // 4.2
  const R187 = rule42('BRDP-S1-00187');
  const r187 = testRun(R187, [
    { label: 'two substeps', expected: 'accept', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para><proceduralStep><para>Remove the screws.</para></proceduralStep><proceduralStep><para>Lift the panel.</para></proceduralStep></proceduralStep>' },
    { label: 'one substep', expected: 'reject', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para><proceduralStep><para>Remove the screws.</para></proceduralStep></proceduralStep>' },
  ], setupFor(S42, R187, ['proced']));
  check('S1-00187: a single substep rejected, two accepted', statuses(r187) === 'accepted,rejected' && r187.verdict.kind === 'correct', statuses(r187));
  const R507 = rule42('BRDP-S1-00507');
  const list = (attr) => `<randomList${attr}><listItem><para>Item</para></listItem></randomList>`;
  const r507 = testRun(R507, [
    { label: 'default', expected: 'accept', schema: 'descript', content: list('') },
    { label: 'pf02', expected: 'accept', schema: 'descript', content: list(' listItemPrefix="pf02"') },
    { label: 'pf07', expected: 'reject', schema: 'descript', content: list(' listItemPrefix="pf07"') },
  ], setupFor(S42, R507, ['descript']));
  check('S1-00507: listItemPrefix other than pf02 rejected, absent or pf02 accepted', statuses(r507) === 'accepted,accepted,rejected' && r507.verdict.kind === 'correct', statuses(r507));
}

// ─── Plantillas 4.1/4.2 como ejemplos útiles: the way down in every schema ──
// The rebuilt templates' rows, run through the same placement, assembly,
// validation and engine as the panel. The valid way down from the
// insertion point is now given in every S1000D schema (it only was for
// schemas whose skeleton does not reach <para>), to where each part of the
// rule enters the example.
for (const [S42, file] of [['S1000D 4.2', 'brdp-template-4-2.xlsx'], ['S1000D 4.1', 'brdp-template-4-1.xlsx']]) {
  const t42 = readPublicTemplate(file);
  const rule = (id) => t42.find((r) => r.ID === id).Rule;
  const route = (id, schema) => {
    const r = rule(id);
    const p = placeExample(structureOf(S42, schema), ruleTargets(r), { useNames: ruleUseNames(r), withRoutes: true });
    return { insertion: p.insertion, steps: (p.routes?.steps || []).map((st) => `${st.parent}>${st.children.join('|')}`) };
  };
  const r133 = route('BRDP-S1-00133', 'descript');
  check(`${S42} templates: <parameter> reached through multimedia/multimediaObject`, r133.insertion === 'levelledPara' && r133.steps.join(' ') === 'levelledPara>multimedia multimedia>multimediaObject multimediaObject>parameter', JSON.stringify(r133));
  const r95 = route('BRDP-S1-00095', 'descript');
  check(`${S42} templates: //title/internalRef routes to the <title> (its entry), not only to <internalRef>`, r95.steps.join(' ') === 'para>definitionList definitionList>title', JSON.stringify(r95));
  const r150 = route('BRDP-S1-00150', 'proced');
  check(`${S42} templates: <supportEquipDescr> four levels below <procedure>`, r150.insertion === 'procedure' && r150.steps.at(-1) === 'supportEquipDescrGroup>supportEquipDescr' && r150.steps.length === 4, JSON.stringify(r150));
  const r120 = route('BRDP-S1-00120', 'descript');
  check(`${S42} templates: levelledPara/title gets no misleading way to a <figure> title`, r120.steps.length === 0, JSON.stringify(r120));
  const r187 = route('BRDP-S1-00187', 'proced');
  check(`${S42} templates: a checked element directly inside the insertion point → no way down`, r187.steps.length === 0, JSON.stringify(r187));
  const prep = await prepareRuleTestSetup({
    ruleXml: rule('BRDP-S1-00133'), standard: S42, schemaLocation: 'flat',
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S42, schema) }),
  });
  check(`${S42} prepareRuleTestSetup: a para-derived schema gets the way down when it is needed`, !!prep.promptPlacements[0]?.routes);

  // Each row with a valid pair of examples, written along that way down.
  const runRow = (id, schema, accept, reject) => {
    const r = rule(id);
    return testRun(r, [
      { label: 'accept', expected: 'accept', schema, content: accept },
      { label: 'reject', expected: 'reject', schema, content: reject },
    ], setupFor(S42, r, [schema]));
  };
  const ok = (res) => res.runs.every((x) => x.validation.runnable) && res.runs.map((x) => x.result.status).join() === 'accepted,rejected' && res.verdict.kind === 'correct';
  const why = (res) => JSON.stringify(res.runs.map((x) => [x.validation.structure, x.result?.status]));
  const media = (param) => `<para>The animation shows the pump.</para><multimedia><title>Pump</title><multimediaObject infoEntityIdent="ICN-EXAMPLE-00001-A-00001-01">${param}</multimediaObject></multimedia>`;
  const r133run = runRow('BRDP-S1-00133', 'descript', media(''), media('<parameter id="par-0001" parameterName="speed" parameterValue="slow"/>'));
  check(`${S42} templates S1-00133: <parameter> rejected`, ok(r133run), why(r133run));
  const list = (title) => `See the list.<definitionList><title>${title}</title><definitionListItem><listItemTerm>M6</listItemTerm><listItemDefinition><para>10 N.m</para></listItemDefinition></definitionListItem></definitionList>`;
  const r95run = runRow('BRDP-S1-00095', 'descript', list('Torque values'), list('Torque values (<internalRef internalRefId="fig-0001"/>)'));
  check(`${S42} templates S1-00095: <internalRef> in a title rejected`, ok(r95run), why(r95run));
  const rq = (attr) => `<preliminaryRqmts><reqSupportEquips><supportEquipDescrGroup><supportEquipDescr${attr}><name>Jack</name></supportEquipDescr></supportEquipDescrGroup></reqSupportEquips></preliminaryRqmts><mainProcedure><proceduralStep><para>Lift.</para></proceduralStep></mainProcedure>`;
  const r150run = runRow('BRDP-S1-00150', 'proced', rq(' id="seq-0001"'), rq(''));
  check(`${S42} templates S1-00150: <supportEquipDescr> without id rejected`, ok(r150run), why(r150run));
  const csn = (inner) => `<catalogSeqNumber figureNumber="01" item="001"><itemSeqNumber itemSeqNumberValue="00A">${inner}</itemSeqNumber></catalogSeqNumber>`;
  const r219run = runRow('BRDP-S1-00219', 'ipd', csn('<partSegment><itemIdentData><descrForPart>O-ring</descrForPart></itemIdentData></partSegment>'), csn('<partRef manufacturerCodeValue="K0001" partNumberValue="P-100"/>'));
  check(`${S42} templates S1-00219: <itemSeqNumber> without <partSegment> rejected in ipd`, ok(r219run), why(r219run));
}

// ─── Pending of the test rule: valid nesting for A//B, edited examples ─────
{
  const S42 = 'S1000D 4.2';
  const descript = structureOf(S42, 'descript');
  const NESTED = '<structureObjectRule id="BRDP-S1-00507"><objectPath allowedObjectFlag="0">//randomList//randomList</objectPath><objectUse>Random lists must not be nested.</objectUse></structureObjectRule>';
  const t = ruleTargets(NESTED);
  check('nesting: //randomList//randomList gives the pair', JSON.stringify(t.alternatives[0].descendantPairs) === '[["randomList","randomList"]]', JSON.stringify(t.alternatives));
  check('nesting: shortest path randomList/listItem/para/randomList', nestingPath(descript.elements, 'randomList', 'randomList')?.join('/') === 'randomList/listItem/para/randomList');
  const pl = placeExample(descript, t);
  check('nesting: the placement carries it', JSON.stringify(pl.nestings) === JSON.stringify([{ ancestor: 'randomList', descendant: 'randomList', path: ['randomList', 'listItem', 'para', 'randomList'] }]), JSON.stringify(pl.nestings));
  const prompt = buildRuleTestExamplesPrompt({ brdp, standard: S42, format: 'BREX-4.2', ruleXml: NESTED, placements: [{ schema: 'descript', role: 'rule', ...pl }] });
  check('nesting: prompt gives the valid nesting', prompt.includes('To put <randomList> inside <randomList>, the valid nesting is: randomList/listItem/para/randomList.'));
  // Direct child steps, no descendant step: nothing.
  const DIRECT = '<structureObjectRule><objectPath allowedObjectFlag="0">//randomList/listItem</objectPath><objectUse>x</objectUse></structureObjectRule>';
  check('nesting: no descendant step → none', placeExample(descript, ruleTargets(DIRECT)).nestings.length === 0);
  check('nesting: prompt without a descendant step has no nesting line', !buildRuleTestExamplesPrompt({ brdp, standard: S42, format: 'BREX-4.2', ruleXml: DIRECT, placements: [{ schema: 'descript', role: 'rule', ...placeExample(descript, ruleTargets(DIRECT)) }] }).includes('the valid nesting is'));
  // A//B where B is a direct child of A: trivially valid, nothing added.
  const CHILD = '<structureObjectRule><objectPath allowedObjectFlag="0">//randomList//listItem</objectPath><objectUse>x</objectUse></structureObjectRule>';
  check('nesting: B a direct child of A → none', placeExample(descript, ruleTargets(CHILD)).nestings.length === 0);
  // A//B with no path in the schema: nothing.
  const NONE = '<structureObjectRule><objectPath allowedObjectFlag="0">//para//dmodule</objectPath><objectUse>x</objectUse></structureObjectRule>';
  check('nesting: no path in the schema → none', nestingPath(descript.elements, 'para', 'dmodule') === null && placeExample(descript, ruleTargets(NONE)).nestings.length === 0);
  // Other spellings: descendant:: axis, "*" breaks the chain, attribute end.
  check('nesting: descendant:: axis', JSON.stringify(ruleTargets('<structureObjectRule><objectPath allowedObjectFlag="0">//randomList/descendant::randomList</objectPath><objectUse>x</objectUse></structureObjectRule>').alternatives[0].descendantPairs) === '[["randomList","randomList"]]');
  check('nesting: "*" in between → no pair', ruleTargets('<structureObjectRule><objectPath allowedObjectFlag="0">//randomList//*//randomList</objectPath><objectUse>x</objectUse></structureObjectRule>').alternatives[0].descendantPairs.length === 0);
  check('nesting: a predicate is not a step', ruleTargets('<structureObjectRule><objectPath allowedObjectFlag="0">//randomList[.//randomList]</objectPath><objectUse>x</objectUse></structureObjectRule>').alternatives[0].descendantPairs.length === 0);

  // Correction round: a reject example with <randomList> straight inside
  // another one gets the path and "keep the nesting"; an accept example
  // with the same problem does not.
  const setup = setupFor(S42, NESTED, ['descript']);
  const flat = '<randomList><listItem><para>Remove the panel.</para></listItem><randomList><listItem><para>Screws.</para></listItem></randomList></randomList>';
  const nested = '<randomList><listItem><para>Remove the panel.<randomList><listItem><para>Screws.</para></listItem></randomList></para></listItem></randomList>';
  const single = '<randomList><listItem><para>Remove the panel.</para></listItem></randomList>';
  const exs = [
    { label: 'one list', expected: 'accept', schema: 'descript', content: flat },
    { label: 'nested lists', expected: 'reject', schema: 'descript', content: flat },
  ];
  const r = testRun(NESTED, exs, setup);
  const failures = exampleFailures(exs, r.materialized, r.runs, { ruleXml: NESTED, standard: S42, format: 'BREX-4.2', setup, parseXml });
  const rejectProblems = failures.find((f) => f.index === 1)?.problems.join('\n') || '';
  const acceptProblems = failures.find((f) => f.index === 0)?.problems.join('\n') || '';
  check('nesting: reject example → path and "keep the nesting"', rejectProblems.includes('<randomList> is not allowed inside <randomList>. To put <randomList> inside <randomList>, the valid nesting is: randomList/listItem/para/randomList. Keep the nesting — do not move <randomList> outside <randomList>.'), rejectProblems);
  check('nesting: accept example → no nesting hint', acceptProblems.includes('<randomList> is not allowed inside <randomList>') && !acceptProblems.includes('valid nesting'), acceptProblems);
  // Without the setup (older callers): the problem as before.
  const noSetup = exampleFailures(exs, r.materialized, r.runs, { ruleXml: NESTED, standard: S42, format: 'BREX-4.2', parseXml }).find((f) => f.index === 1).problems.join('\n');
  check('nesting: without setup the problem stays as it was', !noSetup.includes('valid nesting'));
  // The real case: corrected with the hint, the reject example is nested
  // and valid → rejected ✓, verdict correct.
  const fixed = testRun(NESTED, [
    { label: 'one list', expected: 'accept', schema: 'descript', content: single },
    { label: 'nested lists', expected: 'reject', schema: 'descript', content: nested },
  ], setup);
  check('nesting: nested reject example valid and rejected, verdict correct', fixed.runs.every((x) => x.validation.runnable) && fixed.runs.map((x) => x.result.status).join() === 'accepted,rejected' && fixed.verdict.kind === 'correct', JSON.stringify(fixed.runs.map((x) => [x.validation.structure, x.result?.status])));
  // And through generateRuleTestExamples: first answer flat, the correction
  // request carries the path, the corrected answer is nested.
  const answer = (rejectContent) => JSON.stringify({ proposalMismatch: null, examples: [
    { label: 'one list', expected: 'accept', schema: 'descript', content: single },
    { label: 'nested lists', expected: 'reject', schema: 'descript', content: rejectContent },
  ] });
  const asked = [];
  const gen = await generateRuleTestExamples({
    ruleXml: NESTED, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-S1-00507', title: 'Nested lists', definition: '', proposal: 'Random lists shall not be nested.' },
    vocabulary, parseXml,
    ask: async (messages, systemPrompt) => { asked.push({ messages, systemPrompt }); return asked.length === 1 ? answer(flat) : answer(nested); },
    fetchSchemaCards: async () => ({ cards: {}, document_schemas: ['descript', 'proced'] }),
    fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(S42, schema) }),
  });
  check('nesting: generation prompt has the path', asked[0].systemPrompt.includes('the valid nesting is: randomList/listItem/para/randomList'));
  check('nesting: correction request has the path and "keep the nesting"', asked.length === 2 && asked[1].messages.at(-1).content.includes('Keep the nesting — do not move <randomList> outside <randomList>.'), asked[1]?.messages.at(-1).content);
  check('nesting: corrected → rejected ✓ and correct', gen.status === 'ready' && gen.correction.fixed === 1 && gen.runs[1].result.status === 'rejected' && gen.runs[1].matches === true && ruleTestVerdict(gen.examples, gen.runs, analyzeRule(NESTED, 'BREX-4.2', { parseXml })).kind === 'correct', JSON.stringify({ c: gen.correction, s: gen.runs.map((x) => x.result?.status) }));

  // Part 3: edited examples.
  const base = fixed.materialized[1];
  check('edited: a generated example has no mark', !base.editedByUser);
  const edited = editExample(base, single, undefined, setup, parseXml);
  check('edited: changed content → marked, generated text kept', edited.editedByUser === true && edited.generated.content === base.content && edited.content === single);
  const back = editExample(edited, base.content, undefined, setup, parseXml);
  check('edited: back to the generated text → no mark', back.editedByUser === false);
  const same = editExample(base, base.content, undefined, setup, parseXml);
  check('edited: run again unchanged → no mark', same.editedByUser === false);
  const reRun = runExample(NESTED, 'BREX-4.2', edited, { vocabulary, parseXml });
  check('edited: the edited example runs (accepted now)', reRun.result.status === 'accepted');
  for (const lng of ['en', 'es']) {
    const tt = i18n.getFixedT(lng);
    check(`edited: notice and mark texts (${lng})`, tt('records.ruleTest.editedNotice') !== 'records.ruleTest.editedNotice' && tt('records.ruleTest.editedMark') !== 'records.ruleTest.editedMark');
  }
  check('edited: exact ES notice', i18n.getFixedT('es')('records.ruleTest.editedNotice') === 'Este resultado incluye ejemplos editados a mano y no se guarda. Regenera los ejemplos para registrar un test.');
}

// ---------------------------------------------------------------------------
// Registrar la prueba corregida con ejemplos editados.
{
  const { editedExamplesRecord } = await import('../src/utils/ruleTest.js');
  const { ruleTestStatus, verifyWarning, parseRuleTestHistoryValue } = await importRuleTestStatus();
  const correct = { kind: 'correct' };
  const incorrect = { kind: 'incorrect' };
  const exs = [
    { label: 'Accepted', xml: '<a/>', editedByUser: false },
    { label: 'Nested lists', xml: '<dmodule><randomList/></dmodule>', editedByUser: true },
  ];
  const failedRec = { result: 'failed', reason: { code: 'test_incorrect', params: {} } };
  const rec = editedExamplesRecord({ recorded: failedRec, alreadyRecorded: false, examples: exs, verdict: correct });
  check('edited record: failed → correct → recorded as passed with the edited examples', rec && rec.result === 'passed' && rec.reason === null && rec.editedExamples.length === 1 && rec.editedExamples[0].label === 'Nested lists' && rec.editedExamples[0].xml === exs[1].xml, JSON.stringify(rec));
  for (const kind of ['inconclusive', 'not_executable']) {
    check(`edited record: last recorded ${kind} → recorded`, editedExamplesRecord({ recorded: { result: kind, reason: { code: 'x', params: {} } }, alreadyRecorded: false, examples: exs, verdict: correct })?.result === 'passed');
  }
  check('edited record: nothing recorded yet → recorded', editedExamplesRecord({ recorded: null, alreadyRecorded: false, examples: exs, verdict: correct })?.result === 'passed');
  check('edited record: last recorded passed → nothing (what-if)', editedExamplesRecord({ recorded: { result: 'passed', reason: null }, alreadyRecorded: false, examples: exs, verdict: correct }) === null);
  check('edited record: still failing → nothing', editedExamplesRecord({ recorded: failedRec, alreadyRecorded: false, examples: exs, verdict: incorrect }) === null);
  check('edited record: inconclusive after edits → nothing', editedExamplesRecord({ recorded: failedRec, alreadyRecorded: false, examples: exs, verdict: { kind: 'inconclusive' } }) === null);
  check('edited record: already recorded in this generation → nothing', editedExamplesRecord({ recorded: failedRec, alreadyRecorded: true, examples: exs, verdict: correct }) === null);
  check('edited record: no example edited → nothing', editedExamplesRecord({ recorded: failedRec, alreadyRecorded: false, examples: exs.map((e) => ({ ...e, editedByUser: false })), verdict: correct }) === null);

  const ap = (fields) => ({ rule_xml: '<structureObjectRule id="x"><objectPath allowedObjectFlag="0">//randomList//randomList</objectPath><objectUse>u</objectUse></structureObjectRule>', last_test_up_to_date: true, last_test_at: '2026-09-30T10:00:00Z', ...fields });
  const withEdits = ap({ last_test_result: 'passed', last_test_edited_examples: [{ label: 'Nested lists', xml: '<x/>' }] });
  check('edited status: passed with edits → editedCount 1', ruleTestStatus(withEdits).kind === 'passed' && ruleTestStatus(withEdits).editedCount === 1);
  check('edited status: plain passed → editedCount 0', ruleTestStatus(ap({ last_test_result: 'passed' })).editedCount === 0);
  check('edited status: outdated → no edit count', ruleTestStatus({ ...withEdits, last_test_up_to_date: false }).kind === 'outdated' && ruleTestStatus({ ...withEdits, last_test_up_to_date: false }).editedCount === 0);
  const vw = verifyWarning(withEdits, 'BREX-4.2', { parseXml });
  check('edited verify: passed with edits → warning passed_edited, Test now offered', vw?.kind === 'passed_edited' && vw.editedCount === 1 && vw.canTestNow === true);
  check('edited verify: plain passed → no warning', verifyWarning(ap({ last_test_result: 'passed' }), 'BREX-4.2', { parseXml }) === null);

  const hv = JSON.stringify({ result: 'passed', reason: null, edited_examples: [{ label: 'Nested lists', xml: '<x/>' }, { label: 'B', xml: '<y/>' }] });
  const parsed = parseRuleTestHistoryValue(hv);
  check('edited history: parsed with its examples', parsed.result === 'passed' && parsed.editedExamples.length === 2 && parsed.editedExamples[0].xml === '<x/>');
  check('edited history: plain value → no examples', parseRuleTestHistoryValue(JSON.stringify({ result: 'failed', reason: { code: 'x', params: {} } })).editedExamples.length === 0);
  check('edited history: not JSON → null', parseRuleTestHistoryValue('Passed') === null);

  const es = i18n.getFixedT('es');
  const en = i18n.getFixedT('en');
  const texts = [
    [es('records.ruleTest.indicator.passedEdited', { date: '30 sept 2026', count: 1 }), 'Probada ✓ (30 sept 2026) · 1 ejemplo editado a mano'],
    [es('records.ruleTest.indicator.passedEdited', { date: '30 sept 2026', count: 2 }), 'Probada ✓ (30 sept 2026) · 2 ejemplos editados a mano'],
    [en('records.ruleTest.indicator.passedEdited', { date: 'Sep 30, 2026', count: 1 }), 'Tested ✓ (Sep 30, 2026) · 1 example edited by hand'],
    [en('records.ruleTest.indicator.passedEdited', { date: 'Sep 30, 2026', count: 3 }), 'Tested ✓ (Sep 30, 2026) · 3 examples edited by hand'],
    [es('records.ruleTest.editedRecorded', { count: 1 }), 'Registrada como probada con 1 ejemplo editado a mano.'],
    [es('records.ruleTest.editedRecorded', { count: 2 }), 'Registrada como probada con 2 ejemplos editados a mano.'],
    [en('records.ruleTest.editedRecorded', { count: 2 }), 'Recorded as tested with 2 examples edited by hand.'],
    [es('records.ruleTest.results.passedEdited', { count: 1 }), 'Probada con 1 ejemplo editado a mano'],
    [es('records.ruleTest.results.passedEdited', { count: 2 }), 'Probada con 2 ejemplos editados a mano'],
    [en('records.ruleTest.results.passedEdited', { count: 1 }), 'Passed with 1 example edited by hand'],
  ];
  for (const [got, want] of texts) check(`edited text: ${want}`, got === want, got);
  check('edited text: Verify warning (ES) says the last test includes them', es('records.ruleTest.verifyDialog.passedEdited', { count: 2 }).includes('El último test incluye 2 ejemplos editados a mano'));
  check('edited text: Verify warning (EN)', en('records.ruleTest.verifyDialog.passedEdited', { count: 1 }).includes('The last test includes 1 example edited by hand'));
  for (const key of ['editedRecordedOnAccept', 'indicator.passedEditedTitle']) {
    for (const [lng, tt] of [['en', en], ['es', es]]) {
      const v = tt(`records.ruleTest.${key}`, { count: 2, date: 'd' });
      check(`edited text: ${key} (${lng}) translated`, !v.startsWith('records.') && v.includes('2'), v);
    }
  }
  // "Historial desplegable": the edited examples' XML opens with "Show
  // more" (records.history.*), no longer with its own summary text.
  check('history text: header with the count and latest date (EN/ES)', en('records.history.titleCount', { count: 3 }) === 'History (3)' && es('records.history.titleCount', { count: 3 }) === 'Historial (3)' && es('records.history.latest', { date: 'd' }) === 'último: d');
  check('history text: Show more / Ver más', en('records.history.showMore') === 'Show more' && es('records.history.showMore') === 'Ver más' && es('records.history.showLess') === 'Ver menos');
}

// ─── Plantillas, Part 4: boolean paths (s1kd-brexcheck) ────────────────────
// A path that returns true/false is a condition on the whole document; the
// same placement as its node-union twin, a verdict that never ends
// "nothing selected", and a correction round that says which way the
// condition has to go.
{
  const S41 = 'S1000D 4.1';
  const S42 = 'S1000D 4.2';
  const vocab41 = vocabOf('schema-vocabulary-4-1.json');
  const statuses = (r) => r.runs.map((x) => x.result?.status || `invalid:${JSON.stringify(x.validation)}`).join();
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');

  // EXT-00019 as the 4.1 template had it before the rewrite.
  const R19B = `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-1/xml_schema_flat/update.xsd"><structureObjectRuleGroup><structureObjectRule><objectPath allowedObjectFlag="0">//updateCode[attribute::infoCode="00N"] and (//zoneSpec or //partSpec or //circuitBreakerSpec or //zoneIdent or //partIdent)</objectPath><objectUse>Only toolSpec, toolIdent, figure elements can be used in the Data update file representing the tool CIR.</objectUse></structureObjectRule></structureObjectRuleGroup></contextRules>`;
  const t19 = ruleTargets(R19B);
  check('boolean EXT-00019: the condition\'s operands are the alternatives', ['updateCode', 'zoneSpec', 'partSpec', 'partIdent'].every((n) => t19.checked.includes(n)), JSON.stringify(t19.checked));
  const u41 = structureOf(S41, 'update');
  const p19 = placeExample(u41, t19);
  check('boolean EXT-00019: section and content in the LLM\'s hands', p19.metadata.insertion === true && p19.contentInsertion === true, JSON.stringify({ m: p19.metadata.insertion, c: p19.contentInsertion }));
  const minU = metadataXml(u41.skeleton.metadata.tree).xml;
  const cir = (code) => minU.replace(/(<updateCode [^>]*)infoCode="040"/, `$1infoCode="${code}"`);
  const insert = (el) => `<insertObjectGroup><insertObject insertionOrder="1" targetPath="/">${el}</insertObject></insertObjectGroup>`;
  const tool = insert('<toolSpec><toolIdent manufacturerCodeValue="K0001" toolNumber="T-100"/></toolSpec>');
  const part = insert('<partSpec><partIdent manufacturerCodeValue="K0001" partNumberValue="P-100"/></partSpec>');
  const set19 = setupFor(S41, R19B, ['update']);
  const r19 = testRun(R19B, [
    { label: 'tool in the tool CIR', expected: 'accept', schema: 'update', content: tool, metadata: cir('00N') },
    { label: 'part in the tool CIR', expected: 'reject', schema: 'update', content: part, metadata: cir('00N') },
  ], set19, { format: 'BREX-4.1', vocab: vocab41 });
  check('boolean EXT-00019: condition met → rejected, not met → accepted, verdict correct', statuses(r19) === 'accepted,rejected' && r19.verdict.kind === 'correct', statuses(r19));
  check('boolean EXT-00019: the result carries the condition, no node', r19.runs[1].result.conditions[0]?.holds === true && r19.runs[1].result.selectedNodePaths.length === 0 && r19.runs[0].result.conditions[0]?.holds === false);
  // A reject example that does not trigger the condition goes to the
  // correction round with which way it must go.
  const r19miss = testRun(R19B, [
    { label: 'part in the parts CIR', expected: 'reject', schema: 'update', content: part, metadata: cir('00E') },
  ], set19, { format: 'BREX-4.1', vocab: vocab41 });
  const miss = missesRuleProblem({ expected: 'reject' }, r19miss.runs[0], R19B);
  check('boolean: the correction asks the reject example to make the condition TRUE', /must make the rule's condition TRUE: `\/\/updateCode\[attribute::infoCode="00N"\] and/.test(miss || ''), miss);
  check('boolean: never "inconclusive / nothing selected"', r19miss.verdict.kind !== 'inconclusive' || r19miss.verdict.why !== 'nothing_selected', JSON.stringify(r19miss.verdict));
  const conds = ruleConditions(R19B, 'BREX-4.1', { parseXml });
  check('boolean: keep line speaks of the condition', keepMatchedNodeProblem(R19B, conds).startsWith('Keep what makes `//updateCode'), keepMatchedNodeProblem(R19B, conds));
  check('node path: keep line unchanged', keepMatchedNodeProblem(EMPH, []) === 'Keep a node matched by `//emphasis`: fix the markup around it, do not remove it.');
  const failures = exampleFailures([{ label: 'x', expected: 'reject' }], r19miss.materialized, r19miss.runs, { ruleXml: R19B, standard: S41, format: 'BREX-4.1', setup: set19, parseXml });
  check('boolean: exampleFailures sends the reject example back', failures.length === 1 && failures[0].problems[0].includes('condition TRUE'), JSON.stringify(failures));

  // Flag 1: rejects when the condition is false.
  const RF1 = '<structureObjectRule><objectPath allowedObjectFlag="1">//dmStatus/applic or //dmStatus/applicRef</objectPath><objectUse>The status must state the applicability.</objectUse></structureObjectRule>';
  const setF1 = setupFor(S42, RF1, ['descript']);
  const d42 = structureOf(S42, 'descript');
  const min42 = metadataXml(d42.skeleton.metadata.tree).xml;
  const noApplic = min42.replace(/\s*<applic>[\s\S]*?<\/applic>/, '');
  const rF1 = testRun(RF1, [
    { label: 'applic in the status', expected: 'accept', schema: 'descript', content: '', metadata: min42 },
    { label: 'no applicability', expected: 'reject', schema: 'descript', content: '', metadata: noApplic },
  ], setF1);
  check('boolean flag 1: false → rejected, true → accepted', rF1.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && rF1.verdict.kind === 'correct', JSON.stringify(rF1.runs.map((r) => r.result?.status || r.validation)));
  const missF1 = missesRuleProblem({ expected: 'reject' }, rF1.runs[0], RF1);
  check('boolean flag 1: the correction asks for FALSE', /condition FALSE/.test(missF1 || ''), missF1);

  // S1-00316: "or" and "|" -- same placement, same verdict; "|" highlights
  // the node, "or" gives the condition.
  const ror = '<structureObjectRule id="BRDP-S1-00316"><objectPath allowedObjectFlag="0">//dmStatus/applicRef or //pmStatus/applicRef</objectPath><objectUse>Applicability is written in the status, never referenced.</objectUse></structureObjectRule>';
  const rbar = ror.replace(' or ', ' | ');
  const withRef = min42.replace(/<applic>[\s\S]*?<\/applic>/, '<applicRef applicIdentValue="app-0001"/>');
  const ex316 = [
    { label: 'applic', expected: 'accept', schema: 'descript', content: '', metadata: min42 },
    { label: 'applicRef', expected: 'reject', schema: 'descript', content: '', metadata: withRef },
  ];
  const pOr = placeExample(d42, ruleTargets(ror));
  const pBar = placeExample(d42, ruleTargets(rbar));
  check('S1-00316 "or" / "|": same placement', JSON.stringify(pOr) === JSON.stringify(pBar));
  const rOr = testRun(ror, ex316, setupFor(S42, ror, ['descript']));
  const rBar = testRun(rbar, ex316, setupFor(S42, rbar, ['descript']));
  check('S1-00316 "or" / "|": same verdict', statuses(rOr) === statuses(rBar) && statuses(rOr) === 'accepted,rejected' && rOr.verdict.kind === 'correct' && rBar.verdict.kind === 'correct', `${statuses(rOr)} / ${statuses(rBar)}`);
  check('S1-00316 "|": node highlighted; "or": condition', rBar.runs[1].result.selectedNodePaths.some((p) => p.endsWith('/applicRef[1]')) && rOr.runs[1].result.selectedNodePaths.length === 0 && rOr.runs[1].result.conditions[0].holds === true);

  // describeRule explains the condition (EN/ES), never "not executable".
  const d19 = formatRuleDescription(describeRule(R19B, 'BREX-4.1', { parseXml }), en);
  check('describe boolean flag 0 (EN)', d19.lines[0].startsWith('The rule rejects a document in which this condition is true: //updateCode') && d19.lines[0].includes('<zoneSpec>') && d19.lines[0].includes('Only in the schemas: update') && !d19.cannotReject, d19.lines[0]);
  const dF1 = formatRuleDescription(describeRule(RF1, 'BREX-4.2', { parseXml }), es);
  check('describe boolean flag 1 (ES)', dF1.lines[0].startsWith('La regla rechaza un documento en el que no se cumple esta condición: //dmStatus/applic'), dF1.lines[0]);
  const RF2 = RF1.replace('allowedObjectFlag="1"', 'allowedObjectFlag="2"');
  const dF2 = describeRule(RF2, 'BREX-4.2', { parseXml });
  check('describe boolean flag 2: informative, cannot reject', dF2.statements[0].statement.code === 'describe_condition_informative' && dF2.cannotReject === true);
  check('describe boolean flag 2 (EN)', formatRuleDescription(dF2, en).lines[0].startsWith('The condition //dmStatus/applic or //dmStatus/applicRef is only informative'));
  check('ruleConditions: flag of each condition', ruleConditions(RF1, 'BREX-4.2', { parseXml })[0].flag === '1' && conds[0].flag === '0' && conds[0].schema === 'update');
}

// ---------------------------------------------------------------------------
// Resultado "Revisar": the examples pass, but the LLM says the rule does not
// seem to implement the Proposal (real case: "at most three substeps" with
// //proceduralStep[count(proceduralStep) = 1]).
{
  const { verdictToTestRecord, formatRuleTestReason } = await import('../src/utils/ruleTestReasons.js');
  const { editedExamplesRecord } = await import('../src/utils/ruleTest.js');
  const { ruleTestStatus, verifyWarning, parseRuleTestHistoryValue } = await importRuleTestStatus();
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  const S42 = 'S1000D 4.2';
  const R187 = readPublicTemplate('brdp-template-4-2.xlsx').find((row) => row.ID === 'BRDP-S1-00187')?.Rule;
  const exs = [
    { label: 'two substeps', expected: 'accept', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para><proceduralStep><para>Remove the screws.</para></proceduralStep><proceduralStep><para>Lift the panel.</para></proceduralStep></proceduralStep>' },
    { label: 'one substep', expected: 'reject', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para><proceduralStep><para>Remove the screws.</para></proceduralStep></proceduralStep>' },
  ];
  const r = testRun(R187, exs, setupFor(S42, R187, ['proced']));
  const analysis = analyzeRule(R187, 'BREX-4.2', { parseXml });
  const mismatch = 'The Proposal allows at most three substeps; the rule only forbids a single one.';
  const review = ruleTestVerdict(r.materialized, r.runs, analysis, mismatch);
  check('review: "at most three substeps" vs count(...) = 1 → review with the note', review.kind === 'review' && review.mismatch === mismatch, JSON.stringify(review));
  check('review: S1-00187 without a mismatch → correct, as today', ruleTestVerdict(r.materialized, r.runs, analysis, null).kind === 'correct');
  check('review: blank mismatch → correct', ruleTestVerdict(r.materialized, r.runs, analysis, '   ').kind === 'correct');
  const wrong = testRun(R187, exs.map((e) => ({ ...e, expected: e.expected === 'accept' ? 'reject' : 'accept' })), setupFor(S42, R187, ['proced']));
  check('review: an incorrect verdict stays incorrect', ruleTestVerdict(wrong.materialized, wrong.runs, analysis, mismatch).kind === 'incorrect');
  const rec = verdictToTestRecord(review);
  check('review: recorded as review with the code', rec.result === 'review' && rec.reason.code === 'test_proposal_mismatch' && rec.reason.params.mismatch === mismatch, JSON.stringify(rec));
  check('review: reason in EN/ES', formatRuleTestReason(rec.reason, en).startsWith('the examples pass, but the rule does not seem to implement the Proposal (The Proposal') && formatRuleTestReason(rec.reason, es).startsWith('los ejemplos pasan, pero la regla no parece implementar la Propuesta ('));
  check('review: verdict text EN/ES', en('records.ruleTest.verdicts.review', { mismatch }).startsWith('Review: the examples pass') && es('records.ruleTest.verdicts.review', { mismatch }).startsWith('Revisar: los ejemplos pasan, pero la regla no parece implementar la Propuesta'));
  check('review: edited examples never record passed', editedExamplesRecord({ recorded: { result: 'failed', reason: { code: 'x', params: {} } }, alreadyRecorded: false, examples: [{ label: 'a', xml: '<a/>', editedByUser: true }], verdict: review }) === null);
  const ap = { rule_xml: R187, last_test_result: 'review', last_test_reason: rec.reason, last_test_up_to_date: true, last_test_at: '2026-09-30T10:00:00Z' };
  check('review: indicator state', ruleTestStatus(ap).kind === 'review' && ruleTestStatus(ap).reason.code === 'test_proposal_mismatch');
  check('review: indicator text EN/ES', en('records.ruleTest.indicator.review') === 'Review' && es('records.ruleTest.indicator.review') === 'Revisar');
  const vw = verifyWarning(ap, 'BREX-4.2', { parseXml });
  check('review: Verify warns with the reason and Test now', vw?.kind === 'review' && vw.canTestNow === true && vw.reason.code === 'test_proposal_mismatch');
  check('review: Verify text ES', es('records.ruleTest.verifyDialog.review', { reason: formatRuleTestReason(rec.reason, es) }).startsWith('Hay que revisar la última prueba: los ejemplos pasan'));
  check('review: outdated still wins', ruleTestStatus({ ...ap, last_test_up_to_date: false }).kind === 'outdated');
  check('review: History value parsed', parseRuleTestHistoryValue(JSON.stringify({ reason: rec.reason, result: 'review' })).result === 'review' && es('records.ruleTest.results.review') === 'Revisar');
}

// ---------------------------------------------------------------------------
// No sobrescribir una prueba aprobada sin preguntar.
{
  const { passedTestToReplaceAt, parseRuleTestHistoryValue } = await importRuleTestStatus();
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  const ap = (fields) => ({ rule_xml: '<x/>', last_test_up_to_date: true, last_test_at: '2026-09-30T10:00:00Z', ...fields });
  const failedRec = { result: 'failed', reason: { code: 'test_incorrect', params: { permissive: true, strict: false } } };
  check('replace: passed → failed asks, with the passed date', passedTestToReplaceAt(ap({ last_test_result: 'passed' }), failedRec) === '2026-09-30T10:00:00Z');
  for (const result of ['inconclusive', 'review', 'not_executable']) {
    check(`replace: passed → ${result} asks`, passedTestToReplaceAt(ap({ last_test_result: 'passed' }), { result, reason: { code: 'x', params: {} } }) !== null);
  }
  check('replace: passed → passed never asks', passedTestToReplaceAt(ap({ last_test_result: 'passed' }), { result: 'passed', reason: null }) === null);
  check('replace: last test failed → never asks', passedTestToReplaceAt(ap({ last_test_result: 'failed' }), failedRec) === null);
  check('replace: outdated passed test (rule changed) → never asks', passedTestToReplaceAt(ap({ last_test_result: 'passed', last_test_up_to_date: false }), failedRec) === null);
  check('replace: never tested / no approval → never asks', passedTestToReplaceAt(ap({ last_test_result: null }), failedRec) === null && passedTestToReplaceAt(null, failedRec) === null);
  const kept = parseRuleTestHistoryValue(JSON.stringify({ result: 'failed', reason: failedRec.reason, not_recorded: true, kept_test_at: '2026-09-30T10:00:00+00:00' }));
  check('replace: History value of a kept attempt', kept.notRecorded === true && kept.keptTestAt === '2026-09-30T10:00:00+00:00' && kept.result === 'failed');
  check('replace: a normal History value is recorded', parseRuleTestHistoryValue(JSON.stringify({ result: 'failed', reason: failedRec.reason })).notRecorded === false);
  check('replace: question text EN/ES', en('records.ruleTest.replaceQuestion.text', { date: 'Sep 30, 2026' }) === 'The previous test passed on Sep 30, 2026. Record this result and replace it?' && es('records.ruleTest.replaceQuestion.text', { date: '30 sept 2026' }) === 'La prueba anterior salió correcta el 30 sept 2026. ¿Registrar este resultado y sustituirla?');
  check('replace: buttons ES', es('records.ruleTest.replaceQuestion.register') === 'Registrar este resultado' && es('records.ruleTest.replaceQuestion.keep') === 'Mantener la anterior');
  check('replace: History text ES', es('records.ruleTest.results.notRecorded', { result: 'Fallida', date: '30 sept 2026' }) === 'Fallida — no registrado (se mantuvo la prueba del 30 sept 2026)');
}

// ---------------------------------------------------------------------------
// Condiciones con raíz absoluta, y cabecera de pm/ddn/dml. BRDP-EXT-00029 of
// Official Default CMP ATA 4.2 (flag 1): the applicability of a data module
// or a publication module must be stated (All, an assert or an applicRef);
// a DDN or a DML always passes (/ddn, /dml). Before: "not executable: the
// path starts at /ddn…" and 7 invalid pm/ddn/dml examples (Mistral put
// <pmStatus> inside <content>).
{
  const S42 = 'S1000D 4.2';
  const S301 = 'S1000D 3.0.1';
  const es = i18n.getFixedT('es');
  const status = (el) => `(//${el}/applic/assert/@applicPropertyType or //${el}/applic//evaluate/assert/@applicPropertyType or //${el}/applicRef or //${el}/applic/displayText/simplePara[lower-case(.)[contains(.,'all')]])`;
  const EXT29 = `<structureObjectRule id="BRDP-EXT-00029"><objectPath allowedObjectFlag="1">(/ddn or /dml or ${status('dmStatus').slice(1, -1)}) or ${status('pmStatus')}</objectPath><objectUse>The applicability must be stated.</objectUse></structureObjectRule>`;
  // GET /api/schema-cards, from the real structures: which schemas have each name.
  const docs42 = ['comment', 'ddn', 'descript', 'dml', 'ipd', 'pm', 'proced', 'sb'];
  const fetchCards42 = async (_std, names) => ({
    cards: Object.fromEntries(
      names.map((n) => [n, {
        variants: [{ schemas: docs42.filter((d) => structureOf(S42, d).elements[n]), attributes: [], children: [], resolved: true }],
        parents: [],
      }])
    ),
    document_schemas: docs42,
  });
  const fetchStructure = async (std, schema) => ({ available: true, ...structureOf(std, schema) });
  const minimal = (std, schema) => metadataXml(structureOf(std, schema).skeleton.metadata.tree).xml;
  const dm = minimal(S42, 'descript');
  const pm = minimal(S42, 'pm');
  const someText = (x) => x.replace('<simplePara>All</simplePara>', '<simplePara>Some text</simplePara>');
  const assertApplic = dm.replace(/<applic>[\s\S]*?<\/applic>/, '<applic><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></applic>');
  const applicRef = dm.replace(/<applic>[\s\S]*?<\/applic>/, '<applicRef applicIdentValue="a1"/>');

  // The setup: descript, pm, ddn, dml; ddn and dml built whole by the app.
  const setup29 = await prepareRuleTestSetup({ ruleXml: EXT29, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards42, fetchStructure });
  const bySchema = Object.fromEntries(setup29.promptPlacements.map((p) => [p.schema, p]));
  check('EXT-00029: split into descript, pm, ddn and dml', JSON.stringify(Object.keys(bySchema).sort()) === '["ddn","descript","dml","pm"]', JSON.stringify(Object.keys(bySchema)));
  check('EXT-00029: descript and pm write their section, no content', ['descript', 'pm'].every((s) => bySchema[s].metadata?.insertion === true && bySchema[s].contentInsertion === false));
  check('EXT-00029: ddn and dml are built whole by the app', ['ddn', 'dml'].every((s) => bySchema[s].rootOnly === true && bySchema[s].contentInsertion === false && bySchema[s].metadata?.insertion === false));
  check('EXT-00029: nothing untested, nothing unreachable', setup29.untested.length === 0 && setup29.unreachable === null);

  const asked = [];
  const answer = {
    proposalMismatch: null,
    examples: [
      { label: 'DM applicable to All', expected: 'accept', schema: 'descript', metadata: dm },
      { label: 'DM with free text', expected: 'reject', schema: 'descript', metadata: someText(dm) },
      { label: 'DM with an assert', expected: 'accept', schema: 'descript', metadata: assertApplic },
      { label: 'DM with an applicRef', expected: 'accept', schema: 'descript', metadata: applicRef },
      { label: 'PM applicable to All', expected: 'accept', schema: 'pm', metadata: pm },
      { label: 'PM with free text', expected: 'reject', schema: 'pm', metadata: someText(pm) },
      { label: 'A DDN', expected: 'accept', schema: 'ddn' },
      { label: 'A DML', expected: 'accept', schema: 'dml' },
    ],
  };
  const g29 = await generateRuleTestExamples({
    ruleXml: EXT29, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
    brdp: { identifier: 'BRDP-EXT-00029', title: 'Applicability', definition: 'Applicability of DMs and PMs.', proposal: 'The applicability of every data module and publication module must be stated.' },
    vocabulary, parseXml,
    ask: async (_messages, systemPrompt) => { asked.push(systemPrompt); return JSON.stringify(answer); },
    fetchSchemaCards: fetchCards42, fetchStructure,
  });
  check('EXT-00029: one LLM call, no correction round', asked.length === 1 && g29.status === 'ready' && g29.correction === null, JSON.stringify({ status: g29.status, error: g29.error, correction: g29.correction }));
  const verdictOf = (r) => r.result?.status;
  check('EXT-00029: every example valid', g29.runs.every((r) => r.validation.runnable), JSON.stringify(g29.runs.map((r, i) => [g29.examples[i].label, r.validation.structure, r.validation.names?.notFound])));
  check('EXT-00029: descript All / assert / applicRef accepted, "Some text" rejected', ['accepted', 'rejected', 'accepted', 'accepted'].join() === g29.runs.slice(0, 4).map(verdictOf).join(), g29.runs.map(verdictOf).join());
  check('EXT-00029: pm All accepted, pm without anything rejected', verdictOf(g29.runs[4]) === 'accepted' && verdictOf(g29.runs[5]) === 'rejected');
  check('EXT-00029: ddn and dml accepted (the condition is true)', verdictOf(g29.runs[6]) === 'accepted' && verdictOf(g29.runs[7]) === 'accepted' && g29.runs[6].result.conditions[0].holds === true);
  check('EXT-00029: nothing is "not executable"', g29.runs.every((r) => r.result.notExecutableParts.length === 0));
  check('EXT-00029: verdict correct', ruleTestVerdict(g29.examples, g29.runs, analyzeRule(EXT29, 'BREX-4.2', { parseXml })).kind === 'correct');
  const ddnXml = g29.examples[6].xml;
  check('EXT-00029: the ddn is a whole document with its minimal section', /^<ddn [^>]*xsi:noNamespaceSchemaLocation="[^"]*ddn\.xsd"/.test(ddnXml) && ddnXml.includes('<ddnStatus>') && ddnXml.includes('<deliveryList></deliveryList>') && g29.examples[6].rootOnly === true, ddnXml);
  check('EXT-00029: the pm example has its pmStatus in the section, not in <content>', /<identAndStatusSection>[\s\S]*<pmStatus>/.test(g29.examples[4].xml) && !/<content>[\s\S]*<pmStatus>/.test(g29.examples[4].xml));
  const prompt = asked[0];
  check('EXT-00029: prompt — ddn and dml ONE example only', prompt.includes('- "ddn": for <ddn> — ONE example only (see below)') && prompt.includes('(except those marked "ONE example only")'));
  check('EXT-00029: prompt — ddn built whole, no content', prompt.includes('schema "ddn": the rule\'s part for it only asks whether the document IS a\n  <ddn>') && prompt.includes('decision gives to any data dispatch note.'));
  check('EXT-00029: prompt — the pm section is the publication module\'s', prompt.includes("looks at the publication module's identification and status section") && prompt.includes('<pmStatus>'));
  check('EXT-00029: parse — no content is fine only for ddn/dml', parseRuleTestResponse(JSON.stringify({ examples: [{ label: 'a', expected: 'accept', schema: 'ddn' }] }), { contentOptionalSchemas: ['ddn'] }).ok && !parseRuleTestResponse(JSON.stringify({ examples: [{ label: 'a', expected: 'accept', schema: 'descript' }] }), { contentOptionalSchemas: ['ddn'] }).ok);
  check('EXT-00029: root-only note EN/ES', es('records.ruleTest.rootOnlyExample', { root: 'ddn' }) === 'Montado por la aplicación: la regla solo pregunta si el documento es un <ddn>, así que todo <ddn> cumple esa parte.');

  // A node path whose only root is /pm, tested on a pm.
  const pmOnly = '<structureObjectRule id="PMREF"><objectPath allowedObjectFlag="0">/pm/identAndStatusSection/pmStatus/applicRef</objectPath><objectUse>No applicRef in a PM.</objectUse></structureObjectRule>';
  const setupPm = await prepareRuleTestSetup({ ruleXml: pmOnly, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards42, fetchStructure });
  const pPm = setupPm.promptPlacements[0];
  check('/pm only: tested on pm, in its section', setupPm.promptPlacements.length === 1 && pPm.schema === 'pm' && pPm.metadata?.insertion === true, JSON.stringify(setupPm.promptPlacements.map((p) => p.schema)));
  const pmRef = pm.replace(/<applic>[\s\S]*?<\/applic>/, '<applicRef applicIdentValue="a1"/>');
  const rPm = testRun(pmOnly, [
    { label: 'applic', expected: 'accept', schema: 'pm', metadata: pm },
    { label: 'applicRef', expected: 'reject', schema: 'pm', metadata: pmRef },
  ], setupPm.setup);
  check('/pm only: runs on a pm (accepted / rejected)', rPm.runs.map(verdictOf).join() === 'accepted,rejected' && rPm.runs.every((r) => r.validation.runnable), JSON.stringify(rPm.runs.map((r) => [r.result?.status, r.result?.notExecutableReason, r.validation.structure])));

  // The pm's brexDmRef follows its own modelIdentCode.
  const pmOwnModel = pm.replace(/(<pmCode [^>]*modelIdentCode=")EXAMPLE/, '$1ACME');
  const followed = testRun(pmOnly, [{ label: 'model', expected: 'accept', schema: 'pm', metadata: pmOwnModel }], setupPm.setup).materialized[0];
  check('pm: the brexDmRef modelIdentCode follows the pmCode', /<brexDmRef>[\s\S]*<dmCode [^>]*modelIdentCode="ACME"/.test(followed.xml) && followed.brexModelIdentFollowed === true && followed.brexReferenceNormalized === false, followed.xml);
  check('pm: the brexDmRef keeps its own infoCode 022', /<brexDmRef>[\s\S]*<dmCode [^>]*infoCode="022"/.test(followed.xml));
  check('pm: note EN', i18n.getFixedT('en')('records.ruleTest.brexModelIdentFollowed').startsWith("Adjusted by the app: the brexDmRef's modelIdentCode"));

  // 3.0.1 publication module: its idstatus.
  const pm301 = structureOf(S301, 'pm');
  const p301 = placeExample(pm301, ruleTargets('<objrule><objpath objappl="0">//pmstatus/applic</objpath><objuse>u</objuse></objrule>'));
  check('3.0.1 pm: the rule on pmstatus writes its idstatus', p301.metadata?.element === 'idstatus' && p301.metadata.insertion === true && p301.contentInsertion === false);
  check('3.0.1 ddn: no section, content at the root', structureOf(S301, 'ddn').skeleton.metadata === null && structureOf(S301, 'ddn').skeleton.path.join() === 'ddn');

  // A document whose section the app does not build yet (comment): not
  // offered; the result says which part was not tested and why.
  const commentOnly = '<structureObjectRule id="C1"><objectPath allowedObjectFlag="0">//commentStatus/commentResponse</objectPath><objectUse>u</objectUse></structureObjectRule>';
  const sc = await prepareRuleTestSetup({ ruleXml: commentOnly, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards42, fetchStructure });
  check('comment only: not executable, section_unavailable', sc.unreachable?.code === 'section_unavailable' && sc.unreachable.params.schemas === 'comment' && /commentStatus/.test(sc.unreachable.params.names), JSON.stringify(sc.unreachable));
  const gc = await generateRuleTestExamples({
    ruleXml: commentOnly, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat', brdp: { identifier: 'C1', title: 't', definition: 'd', proposal: 'p' },
    vocabulary, parseXml, ask: async () => { throw new Error('the LLM must not be called'); }, fetchSchemaCards: fetchCards42, fetchStructure,
  });
  check('comment only: no LLM call, not executable', gc.status === 'not_executable' && gc.reason.code === 'section_unavailable');
  check('comment only: reason EN/ES', formatRuleTestReason(gc.reason, i18n.getFixedT('en')).includes('looks inside the identification and status section of the comment schema (<commentStatus>') && formatRuleTestReason(gc.reason, es).includes('mira dentro de la sección de identificación y estado del esquema comment (<commentStatus>'), formatRuleTestReason(gc.reason, i18n.getFixedT('en')));
  const mixed = '<structureObjectRule id="C2"><objectPath allowedObjectFlag="0">//commentStatus/commentResponse | //dmStatus/applicRef</objectPath><objectUse>u</objectUse></structureObjectRule>';
  const sm = await prepareRuleTestSetup({ ruleXml: mixed, standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards42, fetchStructure });
  check('comment + dmStatus: descript tested, comment not offered and reported', sm.unreachable === null && sm.promptPlacements.map((p) => p.schema).join() === 'descript' && sm.untested.length === 1 && sm.untested[0].schema === 'comment' && sm.untested[0].element === 'identAndStatusSection', JSON.stringify({ p: sm.promptPlacements.map((p) => p.schema), u: sm.untested }));
  check('untested note ES', es('records.ruleTest.untestedPart', { names: '<commentStatus>', schema: 'comment', element: 'identAndStatusSection' }) === 'Parte de la regla no probada: <commentStatus> (esquema comment). La aplicación todavía no monta la <identAndStatusSection> de ese documento, así que no se ofrecen ejemplos de él.');

  // A content-only rule: unchanged (no rootOnly, no untested).
  const sContent = await prepareRuleTestSetup({ ruleXml: '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>u</objectUse></structureObjectRule>', standard: S42, schemaLocation: 'flat', fetchSchemaCards: fetchCards42, fetchStructure });
  check('content-only rule: unchanged', sContent.promptPlacements.length === 1 && sContent.promptPlacements[0].schema === 'descript' && !sContent.promptPlacements[0].rootOnly && sContent.untested.length === 0 && sContent.promptPlacements[0].contentInsertion === true);
  // A predicate on the root is not "root only".
  check('root with a predicate: not root only', !placeExample(structureOf(S42, 'ddn'), ruleTargets('<structureObjectRule><objectPath allowedObjectFlag="0">/ddn[ddnContent]</objectPath><objectUse>u</objectUse></structureObjectRule>')).rootOnly);
}

// ---------------------------------------------------------------------------
// Guardar la prueba aprobada: the last passed test kept with its examples.
{
  const { passedTestPayload, withPassedTest, savedPassedTest, savedExamplesDate } = await import('../src/utils/ruleTestSaved.js');
  const { ruleTestStatus, parseRuleTestHistoryValue } = await importRuleTestStatus();
  const { ruleXmlHash } = await import('../src/utils/ruleHash.js');
  const { verdictToTestRecord } = await import('../src/utils/ruleTestReasons.js');
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  const S42 = 'S1000D 4.2';
  const R187 = readPublicTemplate('brdp-template-4-2.xlsx').find((row) => row.ID === 'BRDP-S1-00187')?.Rule;
  const exs = [
    { label: 'two substeps', expected: 'accept', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para><proceduralStep><para>Remove the screws.</para></proceduralStep><proceduralStep><para>Lift the panel.</para></proceduralStep></proceduralStep>' },
    { label: 'one substep', expected: 'reject', schema: 'proced', content: '<proceduralStep><para>Remove the panel.</para><proceduralStep><para>Remove the screws.</para></proceduralStep></proceduralStep>' },
    { label: 'broken', expected: 'reject', schema: 'proced', content: '<proceduralStep><pokemon/></proceduralStep>' },
  ];
  const r = testRun(R187, exs, setupFor(S42, R187, ['proced']));
  const payload = passedTestPayload(r.materialized, r.runs, 'A minimum of two sub-steps is required');
  check('saved: only the examples the engine ran are kept', payload.examples.length === 2 && payload.examples.map((e) => e.label).join() === 'two substeps,one substep', JSON.stringify(payload.examples.map((e) => e.label)));
  check('saved: each example keeps its complete document, expected, schema, result and match',
    payload.examples.every((e, i) => e.xml === r.materialized[i].xml && e.xml.startsWith('<dmodule') && e.schema === 'proced' && e.expected === exs[i].expected && e.matches === true)
      && payload.examples[0].result === 'accepted' && payload.examples[1].result === 'rejected');
  check('saved: the dimmed skeleton paths travel with each example', payload.examples[0].skeleton_node_paths.length > 0 && payload.examples[0].skeleton_node_paths.every((p) => typeof p === 'string'));
  check('saved: the Proposal is kept, no examples_from on a new test', payload.proposal === 'A minimum of two sub-steps is required' && !('examples_from' in payload));
  check('saved: examples_from when the test ran on saved examples', passedTestPayload(r.materialized, r.runs, 'p', '2026-09-01T10:00:00Z').examples_from === '2026-09-01T10:00:00Z');
  check('saved: nothing run → nothing kept', passedTestPayload([exs[2]], [{ result: null }], 'p') === null);
  const passedRec = { result: 'passed', reason: null };
  check('saved: withPassedTest adds the examples to a passed record', withPassedTest(passedRec, r.materialized, r.runs, 'p').passedTest?.examples.length === 2);
  const failedRec = verdictToTestRecord({ kind: 'inconclusive' });
  check('saved: withPassedTest leaves any other result alone', withPassedTest(failedRec, r.materialized, r.runs, 'p') === failedRec);

  const at = '2026-09-30T10:00:00+00:00';
  const approval = {
    rule_xml: R187, last_test_result: 'passed', last_test_at: at, last_test_up_to_date: true,
    last_passed_test: { at, rule_xml: R187, rule_hash: ruleXmlHash(R187), proposal: payload.proposal, examples_from: null, edited_count: 0, examples: payload.examples },
  };
  const saved = savedPassedTest(approval, 'A minimum of two sub-steps is required');
  check('saved: the kept test reads back as the panel shows it', saved.examples.length === 2 && saved.examples[0].saved.result === 'accepted' && saved.examples[1].skeletonNodePaths.length > 0 && saved.ruleXml === R187 && !saved.ruleChanged && !saved.proposalChanged);
  check('saved: rule changed → "tested with an earlier version"', savedPassedTest({ ...approval, rule_xml: R187.replace('= 1', '&gt;= 2') }, payload.proposal).ruleChanged === true);
  check('saved: Proposal changed → flagged; blank spaces are not a change', savedPassedTest(approval, 'At least three.').proposalChanged === true && savedPassedTest(approval, '  A minimum of two sub-steps is required ').proposalChanged === false);
  check('saved: no kept test → null', savedPassedTest({ ...approval, last_passed_test: null }) === null && savedPassedTest(null) === null);
  check('saved: the examples date is their own test when they came from one', savedExamplesDate({ at, examplesFrom: '2026-09-01T10:00:00Z' }) === '2026-09-01T10:00:00Z' && savedExamplesDate({ at, examplesFrom: null }) === at);
  check('saved: indicator plain "Tested" when the examples are its own', ruleTestStatus(approval).kind === 'passed' && ruleTestStatus(approval).examplesFrom === null);
  const rerun = { ...approval, last_passed_test: { ...approval.last_passed_test, examples_from: '2026-09-01T10:00:00Z' } };
  check('saved: indicator knows a test on saved examples', ruleTestStatus(rerun).examplesFrom === '2026-09-01T10:00:00Z');
  check('saved: a kept test that is not the last one never labels the indicator', ruleTestStatus({ ...rerun, last_test_at: '2026-09-30T11:00:00+00:00' }).examplesFrom === null && ruleTestStatus({ ...rerun, last_test_result: 'failed' }).examplesFrom === null);
  check('saved: History value reads examples_from', parseRuleTestHistoryValue(JSON.stringify({ result: 'passed', reason: null, examples_from: '2026-09-01T10:00:00Z' })).examplesFrom === '2026-09-01T10:00:00Z' && parseRuleTestHistoryValue(JSON.stringify({ result: 'passed', reason: null })).examplesFrom === null);
  // "Probar con los ejemplos guardados": the current rule on the kept documents.
  const { runSavedTest } = await import('../src/utils/ruleTestSaved.js');
  const { passedTestToReplaceAt } = await importRuleTestStatus();
  const same = runSavedTest(saved, R187, 'BREX-4.2', { vocabulary, parseXml });
  check('rerun: same rule → correct, nothing changes, recorded as passed on the saved examples',
    same.verdict.kind === 'correct' && same.changed.length === 0 && same.record.result === 'passed'
      && same.record.passedTest.examples_from === at && same.record.passedTest.examples.length === 2
      && same.record.passedTest.proposal === saved.proposal, JSON.stringify(same.record).slice(0, 300));
  check('rerun: the kept documents are run as they are (byte for byte)', same.record.passedTest.examples.every((e, i) => e.xml === saved.examples[i].xml));
  const R_GE2 = R187.replace('= 1', '&gt;= 2');
  const changedRule = { ...approval, rule_xml: R_GE2, last_test_up_to_date: false };
  const ge2 = runSavedTest(savedPassedTest(changedRule, payload.proposal), R_GE2, 'BREX-4.2', { vocabulary, parseXml });
  check('rerun: count(proceduralStep) >= 2 → the accept example is now rejected, incorrect', ge2.verdict.kind === 'incorrect' && ge2.changed.includes(0) && ge2.runs[0].result.status === 'rejected' && ge2.record.result === 'failed', JSON.stringify(ge2.changed));
  check('rerun: a failed rerun is never kept as a passed test', !ge2.record.passedTest);
  check('rerun: replacing the (now outdated) passed test is asked', passedTestToReplaceAt(changedRule, ge2.record, { includeOutdated: true }) === at && passedTestToReplaceAt(changedRule, ge2.record) === null);
  check('rerun: nothing to ask when the last test is not a pass, or when the rerun passes',
    passedTestToReplaceAt({ ...changedRule, last_test_result: 'failed' }, ge2.record, { includeOutdated: true }) === null
      && passedTestToReplaceAt(changedRule, same.record, { includeOutdated: true }) === null);
  const back = runSavedTest(savedPassedTest({ ...approval, last_test_result: 'failed' }, payload.proposal), R187, 'BREX-4.2', { vocabulary, parseXml });
  check('rerun: back to the original rule → passes again on the saved examples', back.verdict.kind === 'correct' && back.record.result === 'passed' && back.record.passedTest.examples_from === at);
  const fromEarlier = runSavedTest({ ...saved, examplesFrom: '2026-09-01T10:00:00Z', editedCount: 1 }, R187, 'BREX-4.2', { vocabulary, parseXml });
  check('rerun: examples from an earlier test keep that date and their edited count', fromEarlier.record.passedTest.examples_from === '2026-09-01T10:00:00Z' && fromEarlier.record.passedTest.edited_count === 1);
  check('rerun: texts EN/ES', es('records.ruleTest.saved.rerun') === 'Probar con los ejemplos guardados' && en('records.ruleTest.saved.rerun') === 'Test with the saved examples'
    && es('records.ruleTest.saved.resultChanged', { before: 'aceptado', now: 'rechazado' }) === 'Cambia de resultado: aceptado en la prueba aprobada, rechazado ahora.'
    && es('records.ruleTest.saved.changedSummary', { count: 1, labels: 'two substeps' }) === '1 ejemplo cambia de resultado: two substeps.'
    && es('records.ruleTest.saved.recordedPassed', { from: '01/09/2026' }) === 'Registrado: Probada ✓ (ejemplos de la prueba del 01/09/2026).');
  check('saved: texts EN/ES', en('records.ruleTest.saved.open', { date: '30/09/2026' }) === 'See approved test (30/09/2026)' && es('records.ruleTest.saved.open', { date: '30/09/2026' }) === 'Ver prueba aprobada (30/09/2026)'
    && es('records.ruleTest.saved.ruleChanged').startsWith('Probada con una versión anterior de la regla')
    && es('records.ruleTest.indicator.passedSavedExamples', { from: '01/09/2026' }) === 'Probada ✓ (ejemplos de la prueba del 01/09/2026)'
    && en('records.ruleTest.indicator.passedSavedExamples', { from: '01/09/2026' }) === 'Tested ✓ (examples from the test of 01/09/2026)'
    && es('records.ruleTest.saved.edited', { count: 2 }).includes('2'), [en('records.ruleTest.saved.open', { date: '30/09/2026' }), es('records.ruleTest.saved.ruleChanged')].join(' | '));
}

// ---------------------------------------------------------------------------
// Mensaje de fallo según la causa.
{
  const { verdictCause } = await import('../src/utils/ruleTest.js');
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  const ok = { validation: { runnable: true }, result: { status: 'accepted' } };
  const invalid = { validation: { runnable: false }, result: null };
  check('cause: no example ran → the examples', verdictCause({ kind: 'no_runnable', bySchema: [] }, [invalid])?.cause === 'examples');
  check('cause: nothing selected / missing expectation → the examples', verdictCause({ kind: 'inconclusive', why: 'nothing_selected' }, [ok])?.cause === 'examples' && verdictCause({ kind: 'inconclusive', why: 'missing_expectation' }, [ok, invalid])?.cause === 'examples');
  check('cause: incorrect with an example that did not run → the examples', verdictCause({ kind: 'incorrect', permissive: true, strict: false }, [ok, invalid])?.cause === 'examples');
  const rule = verdictCause({ kind: 'incorrect', permissive: true, strict: false }, [ok, ok]);
  check('cause: incorrect with every example valid → the rule, which way', rule?.cause === 'rule' && rule.permissive && !rule.strict);
  check('cause: correct, review and not executable have none', verdictCause({ kind: 'correct' }, [ok]) === null && verdictCause({ kind: 'review', mismatch: 'x' }, [ok]) === null && verdictCause({ kind: 'not_executable', reason: {} }, []) === null);
  check('cause: texts ES', es('records.ruleTest.cause.examples') === 'Los ejemplos los genera la IA y a veces salen mal. Vuelve a generarlos.'
    && es('records.ruleTest.cause.rulePermissive') === 'La regla aceptó un ejemplo que debía rechazar.'
    && es('records.ruleTest.cause.ruleStrict') === 'La regla rechazó un ejemplo que debía aceptar.'
    && es('records.ruleTest.cause.checkExample', { count: 1 }) === 'Revisa ese ejemplo: si es correcto, el problema está en la regla.');
  check('cause: texts EN', en('records.ruleTest.cause.examples').startsWith('The examples are written by the AI') && en('records.ruleTest.cause.checkExample', { count: 2 }).startsWith('Check those examples'));
  // The real S1-00187 run with expectations swapped: every example valid → the rule.
  const S42 = 'S1000D 4.2';
  const R187 = readPublicTemplate('brdp-template-4-2.xlsx').find((row) => row.ID === 'BRDP-S1-00187')?.Rule;
  const swapped = testRun(R187, [
    { label: 'two substeps', expected: 'reject', schema: 'proced', content: '<proceduralStep><para>A.</para><proceduralStep><para>B.</para></proceduralStep><proceduralStep><para>C.</para></proceduralStep></proceduralStep>' },
    { label: 'one substep', expected: 'accept', schema: 'proced', content: '<proceduralStep><para>A.</para><proceduralStep><para>B.</para></proceduralStep></proceduralStep>' },
  ], setupFor(S42, R187, ['proced']));
  const c = verdictCause(swapped.verdict, swapped.runs);
  check('cause: S1-00187 with swapped expectations → the rule, both ways', c?.cause === 'rule' && c.permissive && c.strict, JSON.stringify(c));
}

// ─── Attribute-only rules: the test schema must carry the attribute ─────────
// BRDP-S1-00151 (//@materialUsage): no element is checked, so the schema
// used to be the first by preference (descript), where no element carries
// @materialUsage. The schema now has to carry it, and the insertion point
// is where one of its carriers can be reached.
{
  const cardsOf = (file) => JSON.parse(fs.readFileSync(new URL(`../backend/schema_cards/schema-cards-${file}.json`, import.meta.url))).cards;
  const docsOf = (cards) => [...new Set(Object.values(cards).flatMap((vs) => vs.flatMap((v) => v.schemas)))]
    .filter((sc) => !['dc', 'rdf', 'xlink', 'xcf'].includes(sc))
    .sort();
  // The same fetchers the panel uses, answered from the real cards (the
  // attribute owners are what GET /api/schema-cards/attribute serves).
  const fetchersFor = (standard, file) => {
    const cards = cardsOf(file);
    const docs = docsOf(cards);
    const attributeCalls = [];
    return {
      cards,
      docs,
      attributeCalls,
      fetchSchemaCards: async (_s, names) => ({
        cards: Object.fromEntries(names.filter((n) => cards[n]).map((n) => [n, { variants: cards[n] }])),
        document_schemas: docs,
      }),
      fetchStructure: async (_s, schema) => {
        const st = structureOf(standard, schema);
        return st ? { available: true, ...st } : { available: false };
      },
      fetchSchemaAttribute: async (_s, name) => {
        attributeCalls.push(name);
        const owners = [];
        for (const [element, vs] of Object.entries(cards)) {
          for (const v of vs) {
            const a = (v.attributes || []).find((x) => x.name === name);
            if (a) owners.push({ element, schemas: v.schemas, required: a.required, enum: a.enum });
          }
        }
        return { available: true, owners };
      },
    };
  };
  const brex = (path, extra = '', flag = 0, id = 'BRDP-TEST-ATTR') => `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="${flag}">${path}</objectPath><objectUse>Attribute rule.</objectUse>${extra}</structureObjectRule>`;
  const carriersOf = (cards, docs, name) => {
    const out = new Set();
    for (const vs of Object.values(cards)) for (const v of vs) if ((v.attributes || []).some((a) => a.name === name)) v.schemas.forEach((sc) => docs.includes(sc) && out.add(sc));
    return [...out];
  };
  const choose = (f, path, attrs) => chooseTestSchemas({
    documentSchemas: f.docs,
    cards: {},
    targets: ruleTargets(brex(path)),
    attributeSchemas: Object.fromEntries(attrs.map((a) => [a, carriersOf(f.cards, f.docs, a)])),
  });

  for (const [standard, file] of [['S1000D 4.2', '4-2'], ['S1000D 4.1', '4-1']]) {
    const f = fetchersFor(standard, file);
    check(`${standard}: //@materialUsage → proced`, choose(f, '//@materialUsage', ['materialUsage']).testSchema === 'proced');
    check(`${standard}: //@timeLimitCategoryValue → schedul (the only schema with it)`, choose(f, '//@timeLimitCategoryValue', ['timeLimitCategoryValue']).testSchema === 'schedul');
    check(`${standard}: //@modelIdentCode → still descript`, choose(f, '//@modelIdentCode', ['modelIdentCode']).testSchema === 'descript');
    check(`${standard}: without owners → as before (descript)`, chooseTestSchemas({ documentSchemas: f.docs, cards: {}, targets: ruleTargets(brex('//@materialUsage')) }).testSchema === 'descript');
    const two = choose(f, '//@indenture | //@timeLimitCategoryValue', ['indenture', 'timeLimitCategoryValue']);
    check(`${standard}: //@indenture | //@timeLimitCategoryValue → two groups (ipd, schedul)`, JSON.stringify(two.groups?.map((g) => g.schema)) === '["ipd","schedul"]', JSON.stringify(two));
    const shared = choose(f, '//@materialUsage | //@timeLimitCategoryValue', ['materialUsage', 'timeLimitCategoryValue']);
    check(`${standard}: two attributes with a schema in common → one schema, no groups`, shared.groups === null && shared.testSchema === 'schedul', JSON.stringify(shared));
    const mixed = chooseTestSchemas({ documentSchemas: f.docs, cards: Object.fromEntries(['supportEquipDescr'].map((n) => [n, { variants: f.cards[n] }])), targets: ruleTargets(brex('//supportEquipDescr/@materialUsage')), attributeSchemas: {} });
    check(`${standard}: //supportEquipDescr/@materialUsage → proced, unchanged`, mixed.testSchema === 'proced' && mixed.groups === null);

    const prep = await prepareRuleTestSetup({ ruleXml: brex('//@materialUsage'), standard, schemaLocation: 'flat', ...f });
    const pp = prep.promptPlacements;
    check(`${standard}: //@materialUsage placed in proced at <procedure>`, pp.length === 1 && pp[0].schema === 'proced' && pp[0].insertion === 'procedure' && prep.unreachable === null, JSON.stringify(pp.map((x) => [x.schema, x.insertion])));
    const routeChildren = (pp[0].routes?.steps || []).flatMap((st) => st.children);
    check(`${standard}: way down to the carriers through <preliminaryRqmts>`, ['preliminaryRqmts', 'supportEquipDescr', 'supplyDescr', 'spareDescr'].every((n) => routeChildren.includes(n)), JSON.stringify(pp[0].routes));
    check(`${standard}: attribute owners asked once`, JSON.stringify(f.attributeCalls) === '["materialUsage"]');
    const same = await prepareRuleTestSetup({ ruleXml: brex('//supportEquipDescr/@materialUsage'), standard, schemaLocation: 'flat', ...f });
    check(`${standard}: element + attribute rule never asks the owners, still proced`, same.promptPlacements[0].schema === 'proced' && JSON.stringify(f.attributeCalls) === '["materialUsage"]');
    const pk = await prepareRuleTestSetup({ ruleXml: brex('//@pokemon'), standard, schemaLocation: 'flat', ...f });
    check(`${standard}: //@pokemon → not executable as today`, pk.unreachable?.code === 'unreachable_target' && pk.unreachable.params.names === '@pokemon');
    const failing = { ...f, fetchSchemaAttribute: async () => { throw new Error('network down'); } };
    const fp = await prepareRuleTestSetup({ ruleXml: brex('//@materialUsage'), standard, schemaLocation: 'flat', ...failing });
    check(`${standard}: owners lookup fails → today's choice (descript)`, fp.promptPlacements[0].schema === 'descript');
    const tl = await prepareRuleTestSetup({ ruleXml: brex('//@timeLimitCategoryValue'), standard, schemaLocation: 'flat', ...f });
    check(`${standard}: //@timeLimitCategoryValue placed in schedul`, tl.promptPlacements[0].schema === 'schedul' && tl.unreachable === null, JSON.stringify(tl.promptPlacements.map((x) => [x.schema, x.insertion])));
  }

  // Template row S1-00334 (//@systemDiffCode, attribute-only): descript
  // stays (every schema has <dmCode>), the content gets the way down to the
  // <dmCode> of a <dmRef>, and its card lists @systemDiffCode first -- the
  // 12-attribute cut used to hide it (13th alphabetically).
  {
    const f = fetchersFor('S1000D 4.2', '4-2');
    const R334 = readPublicTemplate('brdp-template-4-2.xlsx').find((row) => row.ID === 'BRDP-S1-00334').Rule;
    const prep = await prepareRuleTestSetup({ ruleXml: R334, standard: 'S1000D 4.2', schemaLocation: 'flat', ...f });
    const pc = prep.promptPlacements[0];
    const dmCodeCard = pc.routes?.cards?.find((c) => c.name === 'dmCode');
    check('S1-00334: still descript, way down to <dmCode>', pc.schema === 'descript' && Boolean(dmCodeCard), JSON.stringify(pc.routes));
    check('S1-00334: @systemDiffCode first in the <dmCode> card', dmCodeCard?.attributes[0] === 'systemDiffCode', JSON.stringify(dmCodeCard?.attributes));
  }

  // 3.0.1 has no @materialUsage: its attribute-only case is //@man (on
  // <person>, in fault/proced/process/schedul) → proced, not descript.
  {
    const S301 = 'S1000D 3.0.1';
    const f = fetchersFor(S301, '3-0-1');
    const rule = '<objrule><objpath objappl="0">//@man</objpath><objuse>No man attribute.</objuse></objrule>';
    const c = chooseTestSchemas({ documentSchemas: f.docs, cards: {}, targets: ruleTargets(rule), attributeSchemas: { man: carriersOf(f.cards, f.docs, 'man') } });
    check('3.0.1: //@man → proced', c.testSchema === 'proced' && c.groups === null);
    const prep = await prepareRuleTestSetup({ ruleXml: rule, standard: S301, schemaLocation: 'flat', ...f });
    check('3.0.1: //@man placed in proced, reachable', prep.promptPlacements[0].schema === 'proced' && prep.unreachable === null, JSON.stringify(prep.promptPlacements.map((x) => [x.schema, x.insertion])));
  }

  // S1-00151 end to end (4.2): the LLM writes the carriers inside
  // <preliminaryRqmts>, the examples are valid and the verdict is correct.
  {
    const S42 = 'S1000D 4.2';
    const f = fetchersFor(S42, '4-2');
    const R151 = brex('//@materialUsage', '', 0, 'BRDP-S1-00151');
    const equip = (attr) => `<preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup><reqPersons><person man="A"/></reqPersons><reqSupportEquips><supportEquipDescrGroup><supportEquipDescr${attr}><name>Torque wrench</name><reqQuantity>1</reqQuantity></supportEquipDescr></supportEquipDescrGroup></reqSupportEquips><reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts><mainProcedure><proceduralStep><para>Tighten the nut.</para></proceduralStep></mainProcedure><closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts>`;
    const examples = [
      { label: 'no material usage', expected: 'accept', schema: 'proced', content: equip('') },
      { label: 'material usage set', expected: 'reject', schema: 'proced', content: equip(' materialUsage="mu01"') },
    ];
    let asked = null;
    const g = await generateRuleTestExamples({
      ruleXml: R151, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
      brdp: { identifier: 'BRDP-S1-00151', title: 'Material usage', definition: 'Use of @materialUsage.', proposal: 'The attribute @materialUsage is not used.' },
      vocabulary, parseXml,
      ask: async (_m, sys) => { asked = sys; return JSON.stringify({ proposalMismatch: null, examples }); },
      fetchSchemaCards: f.fetchSchemaCards, fetchStructure: f.fetchStructure, fetchSchemaAttribute: f.fetchSchemaAttribute,
    });
    check('S1-00151: prompt uses proced at <procedure> with the way down', asked.includes('"schema": "proced"') && asked.includes('your content goes directly inside <procedure>') && asked.includes('<preliminaryRqmts> > <reqSpares>, <reqSupplies>, <reqSupportEquips>'), asked.slice(0, 400));
    check('S1-00151: both examples valid, no correction round', g.status === 'ready' && g.correction === null && g.runs.every((r) => r.validation.runnable), JSON.stringify(g.runs.map((r) => r.validation.structure)));
    check('S1-00151: accepted / rejected, verdict correct', g.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && ruleTestVerdict(g.examples, g.runs, analyzeRule(R151, 'BREX-4.2', { parseXml })).kind === 'correct', JSON.stringify(g.runs.map((r) => r.result?.status)));
    // S1-00563 (//@timeLimitCategoryValue): only in schedul, on
    // <timeLimitCategory> inside <timeLimitInfo>.
    const R563 = brex('//@timeLimitCategoryValue', '<objectValue valueForm="single" valueAllowed="1"/>', 2, 'BRDP-S1-00563');
    const limit = (value) => `<timeLimitInfo timeLimitIdent="tl-001"><equipGroup><equip><name>Main landing gear</name></equip></equipGroup><timeLimitCategory timeLimitCategoryValue="${value}"/><timeLimit><limitType limitUnitType="lt01"><threshold thresholdUnitOfMeasure="th06"><thresholdValue>6000</thresholdValue></threshold></limitType></timeLimit></timeLimitInfo>`;
    let asked563 = null;
    const g563 = await generateRuleTestExamples({
      ruleXml: R563, format: 'BREX-4.2', standard: S42, schemaLocation: 'flat',
      brdp: { identifier: 'BRDP-S1-00563', title: 'Time limit category', definition: 'Use of the time limit category.', proposal: 'Only hard time limits (category 1) are used.' },
      vocabulary, parseXml,
      ask: async (_m, sys) => { asked563 = sys; return JSON.stringify({ proposalMismatch: null, examples: [
        { label: 'category 1', expected: 'accept', schema: 'schedul', content: limit('1') },
        { label: 'category 2', expected: 'reject', schema: 'schedul', content: limit('2') },
      ] }); },
      fetchSchemaCards: f.fetchSchemaCards, fetchStructure: f.fetchStructure, fetchSchemaAttribute: f.fetchSchemaAttribute,
    });
    check('S1-00563: prompt uses schedul at <maintPlanning> with the way to <timeLimitCategory>', asked563.includes('"schema": "schedul"') && asked563.includes('<timeLimitInfo> (@timeLimitIdent) > <timeLimitCategory>'), asked563.slice(0, 300));
    check('S1-00563: valid, accepted / rejected, verdict correct', g563.runs.every((r) => r.validation.runnable) && g563.runs.map((r) => r.result?.status).join() === 'accepted,rejected' && ruleTestVerdict(g563.examples, g563.runs, analyzeRule(R563, 'BREX-4.2', { parseXml })).kind === 'correct', JSON.stringify(g563.runs.map((r) => [r.validation.structure, r.result?.status])));
  }
}

// ─── Barrido final 1/2, Part 1: DITA tables with merged rows ──────────────
{
  const ext1 = readPublicTemplate('brdp-template-dita-xpath3.xlsx').find((r) => r.ID === 'BRDP-EXT-00001');
  const DITA = 'DITA 1.3 Xpath2.0';
  const vocabDita = vocabOf('schema-vocabulary-dita.json');
  const T = (body, { cols = 3, specs = '<colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>' } = {}) =>
    `<section><title>LISTA DE MATERIAL OBLIGATORIO</title><table><tgroup cols="${cols}">${specs}<thead><row><entry colname="c1">Part</entry><entry colname="c2">Descripción</entry><entry colname="c3">Cant.</entry></row></thead><tbody>${body}</tbody></tgroup></table></section>`;
  const gen = async (examples, extra = []) => {
    const asked = [];
    const result = await generateRuleTestExamples({
      ruleXml: ext1.Rule, format: 'SCH-DITA', standard: 'DITA 1.3 Xpath3.0', schemaLocation: 'flat',
      brdp: { identifier: 'BRDP-EXT-00001', title: '', definition: '', proposal: '' },
      vocabulary: vocabDita, parseXml,
      ask: async (messages, sys) => { asked.push({ messages, sys }); return JSON.stringify({ examples: asked.length === 1 ? examples : extra[asked.length - 2] || examples }); },
      fetchSchemaCards: async (_std, names) => ({ cards: {}, document_schemas: ['topic'], element_schemas: Object.fromEntries(names.map((n) => [n, ['topic']])) }),
      fetchStructure: async (_std, schema) => ({ available: true, ...structureOf(DITA, schema) }),
    });
    return { result, asked };
  };

  // A correct table with merged rows: accepted, and the rule really runs on
  // it -- the quantity of row 2 comes from the morerows of row 1.
  const merged = T('<row><entry colname="c1">P-1</entry><entry colname="c2">Seal</entry><entry colname="c3" morerows="1">2</entry></row><row><entry colname="c1">P-2</entry><entry colname="c2">Gasket</entry></row>');
  const missing = T('<row><entry colname="c1">P-1</entry><entry colname="c2">Seal</entry><entry colname="c3">2</entry></row><row><entry colname="c1">P-2</entry><entry colname="c2">Gasket</entry></row>');
  {
    const { result, asked } = await gen([
      { label: 'merged quantity', expected: 'accept', schema: 'topic', content: merged },
      { label: 'quantity missing', expected: 'reject', schema: 'topic', content: missing },
    ]);
    check('final 1/2 merged rows: no correction round', asked.length === 1 && result.correction === null, JSON.stringify(result.correction));
    check('final 1/2 merged rows: both examples valid and run', result.runs.every((r) => r.validation.runnable), JSON.stringify(result.runs.map((r) => r.validation.structure)));
    check('final 1/2 merged rows: row 2 selected in the merged example (rule ran on it)', result.runs[0].result.selectedNodePaths.length === 2, JSON.stringify(result.runs[0].result.selectedNodePaths));
    check('final 1/2 merged rows: accepted / rejected', result.runs.map((r) => r.result.status).join() === 'accepted,rejected');
    check('final 1/2 merged rows: verdict correct', ruleTestVerdict(result.examples, result.runs, analyzeRule(ext1.Rule, 'SCH-DITA', { parseXml })).kind === 'correct');
    // The prompt carries the model table built from the DITA topic schema.
    const sys = asked[0].sys;
    check('final 1/2 prompt: MODEL TABLE block for a rule on tables', sys.includes('MODEL TABLE:') && sys.includes('<entry colname="c1" morerows="1">A-100</entry>') && sys.includes('the row below has NO\n  <entry> in that column'), sys.slice(sys.indexOf('MODEL TABLE'), sys.indexOf('MODEL TABLE') + 400));
    check('final 1/2 prompt: no proposalMismatch asked any more', !sys.includes('proposalMismatch'));
  }

  // Colnames with no colspec: repaired and validated, no LLM round.
  {
    const bare = merged.replace(/<colspec colname="c\d"\/>/g, '');
    const { result, asked } = await gen([
      { label: 'no colspecs', expected: 'accept', schema: 'topic', content: bare },
      { label: 'quantity missing', expected: 'reject', schema: 'topic', content: missing },
    ]);
    check('final 1/2 colspecs: repaired, valid, no correction round', asked.length === 1 && result.examples[0].colspecsAdded === 3 && result.runs[0].validation.runnable && result.runs[0].result.status === 'accepted');
  }
  // Colnames named after the header ("part", "desc", "cant") with no colspec:
  // the header row gives the order.
  {
    const namedCols = merged.replace(/<colspec colname="c\d"\/>/g, '').replace(/colname="c1"/g, 'colname="part"').replace(/colname="c2"/g, 'colname="desc"').replace(/colname="c3"/g, 'colname="cant"');
    const { result, asked } = await gen([
      { label: 'named columns', expected: 'accept', schema: 'topic', content: namedCols },
      { label: 'quantity missing', expected: 'reject', schema: 'topic', content: missing },
    ]);
    check('final 1/2 named colnames: colspecs part, desc, cant added in header order', asked.length === 1 && result.examples[0].content.includes('<tgroup cols="3"><colspec colname="part"/><colspec colname="desc"/><colspec colname="cant"/>') && result.runs[0].validation.runnable, result.examples[0].content);
  }
  // morerows past the last row and wrong @cols: fixed by the app, with notes.
  {
    const past = T('<row><entry colname="c1">P-1</entry><entry colname="c2">Seal</entry><entry colname="c3">2</entry></row><row><entry colname="c1">P-2</entry><entry colname="c2">Gasket</entry><entry colname="c3" morerows="2">1</entry></row>', { cols: 2 });
    const { result, asked } = await gen([
      { label: 'past the end', expected: 'accept', schema: 'topic', content: past },
      { label: 'quantity missing', expected: 'reject', schema: 'topic', content: missing },
    ]);
    const ex = result.examples[0];
    check('final 1/2 morerows past end: lowered (removed), cols raised, runs', asked.length === 1 && JSON.stringify(ex.morerowsLowered) === '[2]' && JSON.stringify(ex.colsRaised) === '[{"from":2,"to":3}]'
      && !ex.content.includes('morerows') && ex.content.includes('<tgroup cols="3">') && result.runs[0].validation.runnable, ex.content);
    const threeRows = '<table><tgroup cols="2"><tbody><row><entry morerows="3">A</entry><entry>x</entry></row><row><entry>B</entry></row><row><entry>C</entry></row></tbody></tgroup></table>';
    const lowered = fixCalsRowSpans(threeRows, parseXml);
    check('final 1/2 morerows past end: lowered to the rows left (3 → 2)', lowered.content === threeRows.replace('morerows="3"', 'morerows="2"') && JSON.stringify(lowered.morerowsLowered) === '[1]', lowered.content);
    const t = (lng, key, o) => i18n.getFixedT(lng)(`records.ruleTest.${key}`, o);
    check('final 1/2 notes EN/ES', t('en', 'morerowsLowered', { count: 1, rows: '2' }) === 'Adjusted by the app: a morerows that ran past the last row was shortened (row 2).'
      && t('es', 'colsRaised', { count: 1, values: '2 → 3' }) === 'Ajustado por la app: el cols de la tabla no coincidía con sus columnas (2 → 3).'
      && t('es', 'emptyRowsRemoved', { count: 1, rows: '3' }) === 'Ajustado por la app: se quitó una fila vacía (fila 3).');
  }
  // A row entirely covered by the morerows above (the real titled-context
  // shape): rejected with the exact cells, and the correction round gets
  // that reason and the pointer to the model table.
  {
    const covered = T('<row><entry colname="c1" morerows="1">P-100</entry><entry colname="c2" morerows="1">Seal</entry><entry colname="c3">2</entry></row><row><entry colname="c2">Gasket</entry></row>');
    const { result, asked } = await gen(
      [
        { label: 'covered row', expected: 'accept', schema: 'topic', content: covered },
        { label: 'quantity missing', expected: 'reject', schema: 'topic', content: missing },
      ],
      [[
        { label: 'covered row', expected: 'accept', schema: 'topic', content: merged },
        { label: 'quantity missing', expected: 'reject', schema: 'topic', content: missing },
      ]]
    );
    const correction = asked[1]?.messages.at(-1).content || '';
    check('final 1/2 covered row: correction gets the exact reason', correction.includes('row 2 is entirely covered by morerows from above (column c2, by the morerows of row 1)'), correction);
    check('final 1/2 covered row: correction points at the model table', correction.includes(TABLE_MODEL_HINT));
    check('final 1/2 covered row: fixed by the correction', result.correction.fixed === 1 && result.runs.every((r) => r.validation.runnable));
  }
  // The model table itself is valid in every schema it is built for.
  for (const [standard, schema] of [['DITA 1.3 Xpath2.0', 'topic'], ['S1000D 4.2', 'descript'], ['S1000D 3.0.1', 'descript'], ['S1000D 4.1', 'proced']]) {
    const structure = structureOf(standard, schema);
    const model = calsTableModel(structure);
    const doc = parseXml(model);
    const problems = [...checkExampleStructure(doc, structure).filter((p) => p.kind !== 'wrongRoot'), ...checkCalsTableSpans(doc), ...checkCalsColspecs(doc)];
    check(`final 1/2 model table valid in ${standard} ${schema}`, Boolean(model) && problems.length === 0, JSON.stringify(problems));
  }
  check('final 1/2 model: <para> cells in 4.2, plain text in DITA', calsTableModel(structureOf('S1000D 4.2', 'descript')).includes('<entry colname="c2"><para>Seal</para></entry>') && calsTableModel(structureOf('DITA 1.3 Xpath2.0', 'topic')).includes('<entry colname="c2">Seal</entry>'));
  check('final 1/2 model: none for a rule that does not look at tables', !ruleLooksAtTables('<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath></structureObjectRule>', ['emphasis']) && ruleLooksAtTables('', ['row']));
}

// ─── Barrido final 1/2, Part 2: the Proposal check, its own call ──────────
{
  const { buildRuleProposalCheckPrompt, parseRuleProposalCheckResponse, RULE_PROPOSAL_CHECK_USER_MESSAGE } = await import('../src/prompts/ruleProposalCheckPrompt.js');
  const { checkRuleImplementsProposal } = await import('../src/utils/ruleTestRun.js');
  const { RULE_PROPOSAL_CHECK_TEMPERATURE } = await import('../src/prompts/shared.js');
  const { ruleDescriptionText, verdictToTestRecord } = await import('../src/utils/ruleTestReasons.js');
  const R187 = readPublicTemplate('brdp-template-4-2.xlsx').find((r) => r.ID === 'BRDP-S1-00187').Rule;
  const description = ruleDescriptionText(describeRule(R187, 'BREX-4.2', { parseXml }), i18n.getFixedT('en'));
  const brdp3 = { identifier: 'BRDP-S1-00187', title: 'Substeps', definition: 'Number of substeps.', proposal: 'A step has at most three substeps.' };
  const prompt = buildRuleProposalCheckPrompt({ brdp: brdp3, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: R187, ruleDescription: description });
  check('check prompt: the Proposal, the description and the rule', prompt.includes('Proposal: A step has at most three substeps.') && prompt.includes(description) && prompt.includes(R187));
  check('check prompt: JSON shape asked (three levels)', prompt.includes('{"implements": "yes", "reason": ""}') && /"yes".*\n[\s\S]*"partly"[\s\S]*"no"/.test(prompt));
  check('check: temperature 0', RULE_PROPOSAL_CHECK_TEMPERATURE === 0);
  check('check parse: the old boolean true → yes', JSON.stringify(parseRuleProposalCheckResponse('{"implements": true, "missing": ""}')) === '{"ok":true,"level":"yes","reason":""}');
  check('check parse: the old boolean false with fence → no, its "missing" as the reason', JSON.stringify(parseRuleProposalCheckResponse('```json\n{"implements": false, "missing": "Solo prohíbe uno."}\n```')) === '{"ok":true,"level":"no","reason":"Solo prohíbe uno."}');
  check('check parse: not JSON → error', !parseRuleProposalCheckResponse('I think so.').ok);
  check('check parse: an unknown level → error', !parseRuleProposalCheckResponse('{"implements": "maybe"}').ok && !parseRuleProposalCheckResponse('{"reason": "x"}').ok);

  const asks = [];
  const run = (answer) => checkRuleImplementsProposal({
    brdp: brdp3, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: R187, ruleDescription: description,
    ask: async (messages, sys) => { asks.push({ messages, sys }); if (answer instanceof Error) throw answer; return answer; },
  });
  const mismatch = await run('{"implements": "no", "reason": "The Proposal allows at most three substeps; the rule only rejects exactly one."}');
  check('check: "no" → mismatch with its sentence', mismatch.status === 'mismatch' && mismatch.missing.startsWith('The Proposal allows at most three') && mismatch.reason === mismatch.missing);
  check('check: one user message, the fixed one', asks[0].messages.length === 1 && asks[0].messages[0].content === RULE_PROPOSAL_CHECK_USER_MESSAGE);
  check('check: "yes" → implements', (await run('{"implements": "yes", "reason": ""}')).status === 'implements');
  const partial = await run('{"implements": "partly", "reason": "Marking torque values up with <quantity> cannot be checked."}');
  check('check: "partly" → partial with its reason', partial.status === 'partial' && partial.reason.startsWith('Marking torque values'));
  const broken = await run('Looks fine to me.');
  check('check: invalid JSON → unavailable with the reason', broken.status === 'unavailable' && /no JSON object/.test(broken.error), JSON.stringify(broken));
  const thrown = await run(Object.assign(new Error('Connection error. Please try again.'), {}));
  check('check: failed call → unavailable, never throws', thrown.status === 'unavailable' && thrown.error === 'Connection error. Please try again.');

  // Verdicts: the same correct examples with each check result.
  const setup187 = setupFor('S1000D 4.2', R187, ['proced']);
  const step = (n) => `<proceduralStep><para>Remove the cover.</para>${'<proceduralStep><para>Sub.</para></proceduralStep>'.repeat(n)}</proceduralStep>`;
  const ex = [
    { label: 'two substeps', expected: 'accept', schema: 'proced', content: step(2) },
    { label: 'one substep', expected: 'reject', schema: 'proced', content: step(1) },
  ];
  const r = testRun(R187, ex, setup187);
  const analysis187 = analyzeRule(R187, 'BREX-4.2', { parseXml });
  check('verdict: implements → correct, no extra review', ruleTestVerdict(r.materialized, r.runs, analysis187, { status: 'implements' }).kind === 'correct');
  const en0 = i18n.getFixedT('en');
  const es0 = i18n.getFixedT('es');
  const rv = ruleTestVerdict(r.materialized, r.runs, analysis187, mismatch);
  check('verdict: "max three" vs "exactly one" → review with what is missing', rv.kind === 'review' && !rv.unchecked && rv.mismatch === mismatch.missing, JSON.stringify(rv));
  const ru = ruleTestVerdict(r.materialized, r.runs, analysis187, broken);
  check('verdict: check failed → review "could not be checked", never correct', ru.kind === 'review' && ru.unchecked === true && ru.error === broken.error, JSON.stringify(ru));
  const recU = verdictToTestRecord(ru);
  check('verdict: unchecked recorded as review with test_proposal_unchecked', recU.result === 'review' && recU.reason.code === 'test_proposal_unchecked' && recU.reason.params.error === broken.error);
  check('verdict: no check (saved examples) → correct as today', ruleTestVerdict(r.materialized, r.runs, analysis187, null).kind === 'correct');
  check('verdict: "partly" → correct (the panel adds a note), never review', ruleTestVerdict(r.materialized, r.runs, analysis187, partial).kind === 'correct');
  check('partial note EN/ES', en0('records.ruleTest.proposalPartial', { text: 'x' }) === 'The rule covers part of the Proposal: x' && es0('records.ruleTest.proposalPartial', { text: 'x' }) === 'La regla cubre parte de la Propuesta: x');
  const wrongEx = [{ ...ex[0], expected: 'reject' }, ex[1]];
  const rw = testRun(R187, wrongEx, setup187);
  check('verdict: an incorrect verdict stays incorrect whatever the check', ruleTestVerdict(rw.materialized, rw.runs, analysis187, broken).kind === 'incorrect');
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  check('unchecked text EN/ES', en('records.ruleTest.verdicts.reviewUnchecked', { error: 'x' }).startsWith('Review: the examples pass, but the Proposal could not be checked (x)')
    && es('records.ruleTest.verdicts.reviewUnchecked', { error: 'x' }).startsWith('Revisar: los ejemplos pasan, pero no se pudo comprobar la Propuesta (x)')
    && formatRuleTestReason(recU.reason, es) === `los ejemplos pasan, pero no se pudo comprobar la Propuesta (${broken.error})`);

  // Through generateRuleTestExamples: both calls, in parallel; the
  // examples' verdict gets the check.
  const calls = [];
  const g = await generateRuleTestExamples({
    ruleXml: R187, format: 'BREX-4.2', standard: 'S1000D 4.2', schemaLocation: 'flat', brdp: brdp3, vocabulary, parseXml,
    ask: async () => { calls.push('examples'); return JSON.stringify({ examples: ex }); },
    askProposalCheck: async (_m, sys) => { calls.push(sys.startsWith('You check whether') ? 'check' : '?'); return '{"implements": "no", "reason": "Only exactly one substep is rejected."}'; },
    ruleDescription: description,
    fetchSchemaCards: async (_s, names) => ({ cards: {}, document_schemas: ['proced'], element_schemas: Object.fromEntries(names.map((n) => [n, ['proced']])) }),
    fetchStructure: async (_s, schema) => ({ available: true, ...structureOf('S1000D 4.2', schema) }),
  });
  check('generate: one examples call + one check call', calls.sort().join() === 'check,examples', calls.join());
  check('generate: proposalCheck returned', g.proposalCheck?.status === 'mismatch' && g.proposalCheck.missing === 'Only exactly one substep is rejected.');
  check('generate: verdict review 3 of 3 (deterministic once the check answers)', [0, 1, 2].every(() => ruleTestVerdict(g.examples, g.runs, analysis187, g.proposalCheck).kind === 'review'));
  const g0 = await generateRuleTestExamples({
    ruleXml: R187, format: 'BREX-4.2', standard: 'S1000D 4.2', schemaLocation: 'flat', brdp: brdp3, vocabulary, parseXml,
    ask: async () => JSON.stringify({ examples: ex }),
    fetchSchemaCards: async (_s, names) => ({ cards: {}, document_schemas: ['proced'], element_schemas: Object.fromEntries(names.map((n) => [n, ['proced']])) }),
    fetchStructure: async (_s, schema) => ({ available: true, ...structureOf('S1000D 4.2', schema) }),
  });
  check('generate: without askProposalCheck no check (null)', g0.proposalCheck === null);
}

// ─── Barrido final 3, Part 1: the judgement in three levels ─────────────────
{
  const { buildRuleProposalCheckPrompt } = await import('../src/prompts/ruleProposalCheckPrompt.js');
  const { checkRuleImplementsProposal } = await import('../src/utils/ruleTestRun.js');
  const { ruleDescriptionText } = await import('../src/utils/ruleTestReasons.js');
  const en = i18n.getFixedT('en');
  const es = i18n.getFixedT('es');
  const cases = JSON.parse(fs.readFileSync(new URL('./prompt-eval/cases.json', import.meta.url), 'utf8')).cases;
  const byId = (id) => cases.find((c) => c.id === id);
  const boolCase = byId('rule-test-4-1-boolean-tool-cir');
  const boolDesc = describeRule(boolCase.rule, 'BREX-4.1', { parseXml });
  const boolText = ruleDescriptionText(boolDesc, en);
  check('describe: a forbidden condition says what it never rejects (EN)', boolText.includes('Elements and attributes the condition does not name are never rejected by it.'), boolText);
  check('describe: … and in Spanish', ruleDescriptionText(boolDesc, es).includes('Los elementos y atributos que la condición no nombra nunca los rechaza.'));
  const prompt = buildRuleProposalCheckPrompt({ brdp: boolCase.brdp, standard: 'S1000D 4.1', format: 'BREX-4.1', ruleXml: boolCase.rule, ruleDescription: boolText });
  for (const [what, needle] of [
    ['an uncheckable part is partly', 'A part of the Proposal that no XML rule can check'],
    ['forbidding the alternative is yes', 'rejects <y> where <x> belongs'],
    ['a missing attribute is not by itself no', '"if it does not appear, it is not rejected"'],
    ['only A, B, C as a prohibition of the others is yes', 'A, B and C are the allowed ones: the rule\n  must NOT reject them.'],
    ['example: substeps → no', 'step with exactly one substep → "no"'],
    ['example: <quantity> → partly', 'N.m → "partly"'],
    ['example: tool CIR → yes', 'that contains <zoneSpec>, <partSpec>, … → "yes"'],
    ['example: <applic> → yes', '<applicRef> in <dmStatus> and <pmStatus> → "yes"'],
    ['only "no" reasons', 'These are NOT reasons for "no"'],
  ]) check(`judge prompt: ${what}`, prompt.includes(needle), needle);

  // The edge cases of the encargo, the judge's answer given: the verdict.
  const R187 = readPublicTemplate('brdp-template-4-2.xlsx').find((r) => r.ID === 'BRDP-S1-00187').Rule;
  const setup187 = setupFor('S1000D 4.2', R187, ['proced']);
  const step = (n) => `<proceduralStep><para>Remove the cover.</para>${'<proceduralStep><para>Sub.</para></proceduralStep>'.repeat(n)}</proceduralStep>`;
  const r = testRun(R187, [
    { label: 'two', expected: 'accept', schema: 'proced', content: step(2) },
    { label: 'one', expected: 'reject', schema: 'proced', content: step(1) },
  ], setup187);
  const analysis = analyzeRule(R187, 'BREX-4.2', { parseXml });
  const judged = async (answer) => checkRuleImplementsProposal({ brdp: boolCase.brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: R187, ruleDescription: 'x', ask: async () => answer });
  const verdictOf = async (answer) => ruleTestVerdict(r.materialized, r.runs, analysis, await judged(answer)).kind;
  check('edge: "at most three" vs "exactly one" → no → review', (await verdictOf('{"implements": "no", "reason": "Four or more are accepted."}')) === 'review');
  check('edge: N.m + <quantity> → partly → correct', (await verdictOf('{"implements": "partly", "reason": "<quantity> cannot be checked."}')) === 'correct');
  check('edge: "only A, B, C" → yes → correct', (await verdictOf('{"implements": "yes", "reason": ""}')) === 'correct');
  check('edge: a contradicting rule → no → review', (await verdictOf('{"implements": "no", "reason": "It forbids what the Proposal requires."}')) === 'review');
  const failed = ruleTestVerdict(r.materialized, r.runs, analysis, await judged('not json at all'));
  check('edge: the judge call fails → "the Proposal could not be checked"', failed.kind === 'review' && failed.unchecked === true);
  const thrown = await checkRuleImplementsProposal({ brdp: boolCase.brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: R187, ruleDescription: 'x', ask: async () => { throw new Error('down'); } });
  check('edge: the judge call throws → unavailable', thrown.status === 'unavailable' && ruleTestVerdict(r.materialized, r.runs, analysis, thrown).unchecked === true);
  // Raw control characters in the judge's reason (Part 2) are read.
  const raw = await judged('{"implements": "partly", "reason": "First line.\nSecond line."}');
  check('edge: a raw line break inside the reason → read', raw.status === 'partial' && raw.reason === 'First line.\nSecond line.', JSON.stringify(raw));

  // The four real eval cases carry a level check.
  for (const [id, expect] of [['rule-test-4-2-quantity-correction', ['partly', 'yes']], ['rule-test-4-1-boolean-tool-cir', ['yes', 'partly']], ['rule-test-template-4-2-applic-in-status', ['yes', 'partly']], ['rule-test-4-2-review-substeps', ['no']]]) {
    const c = byId(id).checks.find((k) => k.type === 'rule_proposal_check_level');
    check(`eval: ${id} checks the level ${expect.join('/')}`, c && JSON.stringify(c.expect) === JSON.stringify(expect));
  }
}

// ─── Barrido final 3, Part 2: one JSON reader for every LLM answer ─────────
{
  const { readLlmJson, escapeControlCharsInStrings } = await import('../src/prompts/llmJson.js');
  const { parseRuleTestResponse } = await import('../src/prompts/ruleTestExamplesPrompt.js');
  const { parseRuleTestReviewResponse } = await import('../src/prompts/ruleTestReviewPrompt.js');
  const { parseRuleProposalCheckResponse } = await import('../src/prompts/ruleProposalCheckPrompt.js');
  const { parseExtractFromRulesResponse } = await import('../src/prompts/extractFromRulesPrompt.js');
  const { parseFindDecisionsResponse } = await import('../src/prompts/extractFromTextPrompt.js');
  const nl = '\n';
  const inString = `{"examples": [{"label": "a", "expected": "accept", "schema": "proced", "content": "<para>${nl}  Remove the cover.${nl}\t</para>"}]}`;
  check('json: newline and tab inside a string → JSON.parse fails…', (() => { try { JSON.parse(inString); return false; } catch (e) { return /control character/i.test(e.message); } })());
  const read = readLlmJson(inString);
  check('json: … the reader escapes them and reads it', read.ok && read.repaired && read.data.examples[0].content === `<para>${nl}  Remove the cover.${nl}\t</para>`);
  const outside = `{${nl}  "implements": "yes",${nl}\t"reason": ""${nl}}`;
  const ro = readLlmJson(outside);
  check('json: newlines outside the strings → read as always, nothing repaired', ro.ok && !ro.repaired && ro.data.implements === 'yes');
  check('json: unchanged text when there is nothing to escape', escapeControlCharsInStrings(outside.replace(/\t/g, ' ')) === outside.replace(/\t/g, ' '));
  check('json: an escaped quote and backslash inside a string are kept', readLlmJson('{"a": "say \\"hi\\"\\\\ ' + nl + '"}').data?.a === 'say "hi"\\ ' + nl);
  check('json: other control characters → \\u00XX', escapeControlCharsInStrings('{"a": "x\u0001y"}') === '{"a": "x\\u0001y"}');
  const notJson = readLlmJson('I think the rule is fine.');
  check('json: text that is not JSON → error as today', !notJson.ok && notJson.reason === 'no_object');
  const broken = readLlmJson(`{"a": "x${nl}", "b": }`);
  check('json: still invalid after escaping → the first error', !broken.ok && broken.reason === 'invalid' && broken.message.length > 0);
  check('json: fence and text around tolerated', readLlmJson('Here:\n```json\n{"a": 1}\n```\nDone.').data?.a === 1);
  // Every parser that expects JSON reads raw line breaks inside strings.
  check('json: rule-test examples parser', parseRuleTestResponse(inString).ok);
  check('json: review parser', parseRuleTestReviewResponse(`{"cause": "rule", "explanation": "Line one.${nl}Line two."}`).ok);
  check('json: proposal-check parser', parseRuleProposalCheckResponse(`{"implements": "no", "reason": "Line one.${nl}Line two."}`).reason === `Line one.${nl}Line two.`);
  check('json: AI Extract (rules) parser', parseExtractFromRulesResponse(`{"items": [{"key": "c1", "proposal": "Shall be used.${nl}Always."}]}`, ['c1']).items.get('c1').proposal === `Shall be used.${nl}Always.`);
  check('json: AI Extract (text) parser', parseFindDecisionsResponse(`{"decisions": [{"quote": "Line one.${nl}Line two.", "title": "T"}]}`)[0].quote === `Line one.${nl}Line two.`);
  check('json: AI Extract parsers keep their errors', (() => { try { parseFindDecisionsResponse('nothing'); return false; } catch (e) { return e.message === 'the answer is not JSON'; } })()
    && (() => { try { parseFindDecisionsResponse('{"decisions": [}'); return false; } catch (e) { return e.message.startsWith('the answer is not valid JSON: '); } })());
  check('json: the old parsers keep their error texts', parseRuleTestResponse('nothing').error === 'The answer contains no JSON object.' && parseRuleTestResponse('{"examples": [}').error.startsWith('The answer is not valid JSON ('));
}

// ─── Barrido final 3, Part 3: a section element in the wrong place ─────────
{
  const { minimalSectionPlaces } = await import('../src/utils/ruleTest.js');
  const { simplePaths } = await import('../src/utils/schemaPlacement.js');
  const st = structureOf('S1000D 4.2', 'descript');
  const paths = simplePaths(st.elements, ['dmStatus'], 'language', 5);
  check('section: from <dmStatus> to <language> there are several ways (no unique fix)', paths.paths.length > 1, paths.paths.map((p) => p.join('/')).join(' | '));
  const places = minimalSectionPlaces(st.skeleton.metadata.tree);
  check('section: <language> sits once in the minimal section, in <dmIdent>', places.get('language').length === 1 && places.get('language')[0].join('/') === 'identAndStatusSection/dmAddress/dmIdent/language');
  const problems = exampleProblems({ wellFormed: true, structure: [{ kind: 'notAllowed', element: 'language', parent: 'dmStatus' }, { kind: 'notAllowed', element: 'issueInfo', parent: 'dmStatus' }] }, { standard: 'S1000D 4.2', schema: 'descript', sectionTree: st.skeleton.metadata.tree });
  check('section: the correction names the place of the minimal section', problems[0] === '<language> is not allowed inside <dmStatus>. In this section <language> goes inside <dmIdent> (identAndStatusSection/dmAddress/dmIdent/language), as in the minimal section; do not repeat it elsewhere.', problems[0]);
  check('section: … and for <issueInfo>', problems[1].includes('identAndStatusSection/dmAddress/dmIdent/issueInfo'));
  const twice = exampleProblems({ wellFormed: true, structure: [{ kind: 'notAllowed', element: 'dmCode', parent: 'dmStatus' }] }, { standard: 'S1000D 4.2', schema: 'descript', sectionTree: st.skeleton.metadata.tree });
  check('section: an element twice in the minimal section (dmCode) gets no place hint', !twice[0].includes('as in the minimal section'), twice[0]);
  const pm = structureOf('S1000D 4.2', 'pm');
  const pmProblems = exampleProblems({ wellFormed: true, structure: [{ kind: 'notAllowed', element: 'language', parent: 'pmStatus' }] }, { standard: 'S1000D 4.2', schema: 'pm', sectionTree: pm.skeleton.metadata.tree });
  check('section: pm → pmAddress/pmIdent', pmProblems[0].includes('identAndStatusSection/pmAddress/pmIdent/language'), pmProblems[0]);
  const content = exampleProblems({ wellFormed: true, structure: [{ kind: 'notAllowed', element: 'language', parent: 'para' }] }, { standard: 'S1000D 4.2', schema: 'descript', sectionTree: st.skeleton.metadata.tree });
  check('section: a problem outside the section gets no hint', !content[0].includes('minimal section'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
