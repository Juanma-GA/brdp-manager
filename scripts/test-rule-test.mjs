// Tests for Test rule (T2 of 4) -- plain Node, the real modules:
// src/prompts/ruleTestExamplesPrompt.js (prompt + response parsing) and
// src/utils/ruleTest.js (example validation, runs, global verdict,
// highlighted display). Run: node scripts/test-rule-test.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import {
  buildRuleTestExamplesPrompt,
  buildCopyableTestPrompt,
  parseRuleTestResponse,
  RULE_TEST_USER_MESSAGE,
} from '../src/prompts/ruleTestExamplesPrompt.js';
import { pickOtherSchema, runExample, ruleTestVerdict, validateExample, xmlDisplayLines } from '../src/utils/ruleTest.js';
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
const vocabJson = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-4-2.json', import.meta.url)));
const vocabulary = { elements: new Set(vocabJson.elements), attributes: new Set(vocabJson.attributes) };
const opts = { vocabulary, parseXml };

function testRun(ruleXml, examples, format = 'BREX-4.2') {
  const runs = examples.map((ex) => runExample(ruleXml, format, ex, opts));
  return { runs, verdict: ruleTestVerdict(examples, runs) };
}

const brdp = {
  identifier: 'BRDP-TEST-001',
  title: 'Use of the element <emphasis>',
  definition: 'Decide whether <emphasis> may be used.',
  proposal: 'El elemento <emphasis> no se utiliza.',
};

// ─── Prompt ─────────────────────────────────────────────────────────────────
{
  const rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>';
  const p = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: rule });
  check('prompt: contains the rule verbatim', p.includes(rule));
  check('prompt: contains Title/Definition/Proposal', p.includes(`Title: ${brdp.title}`) && p.includes(`Proposal: ${brdp.proposal}`));
  check('prompt: explanation in the language of the Proposal', p.includes('in the same language as the Proposal'));
  check('prompt: examples in English, max 10 lines', p.includes('In English, at most 10 lines.'));
  check('prompt: aeronautical content', p.includes('aircraft maintenance manual'));
  check('prompt: no customer data', p.includes('No customer data, no real manufacturer names'));
  check('prompt: general rule → schema null', p.includes('set "schema" to null'));
  check('prompt: no third example for a general rule', !p.includes('third example'));
  check('prompt: strict JSON output', p.includes('OUTPUT: strict JSON only') && p.includes('"expected": "accept"'));
  check('prompt: no mandatory line without flag 1', !p.includes('makes a node mandatory'));
  check('prompt: relative path → ancestors line', p.includes("Include every ancestor element the rule's path needs"));
  check('prompt: user message', buildCopyableTestPrompt(p) === `${p}\n\n${RULE_TEST_USER_MESSAGE}`);
  check('temperature constant', RULE_TEST_TEMPERATURE === 0.5);

  const abs = '<objrule><objpath objappl="1">/dmodule/content//thead/colspec</objpath></objrule>';
  const pa = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 3.0.1', format: 'BREX-3.0.1', ruleXml: abs });
  check('prompt: absolute path → start at <dmodule>', pa.includes('each example starts with the element the path\n  starts with (<dmodule>)'), pa);
  check('prompt: flag 1 → whole document', pa.includes('makes a node mandatory'));

  const proced = wrapRuleInSchemaContexts(rule, 'BREX-4.2', 'S1000D 4.2', ['proced']);
  const pc = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: proced, contextSchemas: ['proced'], otherSchema: 'descript' });
  check('prompt: context rule → schema "proced"', pc.includes('set "schema" to\n"proced"'), pc);
  check('prompt: context rule → third example of descript, expected accept', pc.includes('Add a third example from the descript schema ("schema": "descript",\n"expected": "accept")'), pc);

  const facts = [{ name: 'emphasis', entry: { variants: [{ schemas: ['descript'], attributes: [{ name: 'emphasisType', required: false, enum: ['em01', 'em02'] }], children: [], resolved: true }], parents: ['para'] } }];
  const pf = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: rule, schemaFacts: facts });
  check('prompt: schema facts block', pf.includes('SCHEMA FACTS') && pf.includes('<emphasis>'));
  check('prompt: with facts, names come from the rule or the facts', pf.includes('the rule or in the SCHEMA FACTS below'));
  check('prompt: without facts, never invent a name', p.includes('Never invent a name.') && !p.includes('SCHEMA FACTS'));
}

// ─── Response parsing ───────────────────────────────────────────────────────
{
  const good = '{"explanation":"Prohíbe <emphasis>.","examples":[{"label":"ok","expected":"accept","schema":null,"xml":"<para>a</para>"},{"label":"bad","expected":"reject","schema":null,"xml":"<para><emphasis>a</emphasis></para>"}]}';
  const r = parseRuleTestResponse(good);
  check('parse: valid JSON', r.ok && r.examples.length === 2 && r.explanation === 'Prohíbe <emphasis>.', JSON.stringify(r));
  check('parse: fenced JSON', parseRuleTestResponse('```json\n' + good + '\n```').ok);
  check('parse: text around JSON', parseRuleTestResponse('Here you go:\n' + good + '\nDone').ok);
  const broken = parseRuleTestResponse('{"explanation": "x", "examples": [ {"label": "a", ');
  check('parse: broken JSON → error', !broken.ok && /not valid JSON/.test(broken.error), JSON.stringify(broken));
  check('parse: no JSON at all', !parseRuleTestResponse('Sorry, I cannot.').ok);
  check('parse: bad expected', /must be "accept" or "reject"/.test(parseRuleTestResponse('{"explanation":"x","examples":[{"expected":"maybe","xml":"<a/>"}]}').error || ''));
  check('parse: missing xml', /has no "xml"/.test(parseRuleTestResponse('{"explanation":"x","examples":[{"expected":"accept"}]}').error || ''));
  check('parse: string "null" schema → null', parseRuleTestResponse('{"explanation":"x","examples":[{"expected":"accept","schema":"null","xml":"<a/>"}]}').examples[0].schema === null);
}

// ─── Validation ─────────────────────────────────────────────────────────────
{
  check('validate: malformed', !validateExample('<para><emphasis>a</para>', vocabulary, parseXml).wellFormed);
  const unk = validateExample('<para><pokemon/></para>', vocabulary, parseXml);
  check('validate: unknown name → not runnable', unk.wellFormed && !unk.runnable && unk.names.notFound.includes('<pokemon>'), JSON.stringify(unk));
  const wrong = validateExample('<para><label/></para>', vocabulary, parseXml);
  check('validate: wrong type (label is an attribute in 4.2)', !wrong.runnable && wrong.names.wrongType[0]?.name === 'label', JSON.stringify(wrong));
  check('validate: real names → runnable', validateExample('<para>Torque the <emphasis emphasisType="em01">bolt</emphasis>.</para>', vocabulary, parseXml).runnable);
  check('validate: xsi attributes are not vocabulary', validateExample('<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="x"><content/></dmodule>', vocabulary, parseXml).runnable);
  check('validate: no vocabulary → only well-formedness', validateExample('<pokemon/>', null, parseXml).runnable);
}

// ─── Edge cases of the encargo ──────────────────────────────────────────────
{
  // //emphasis with flag 0
  const rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>Do not use emphasis.</objectUse></structureObjectRule>';
  const examples = [
    { label: 'Plain step', expected: 'accept', schema: null, xml: '<proceduralStep><para>Remove the access panel.</para></proceduralStep>' },
    { label: 'Emphasised warning text', expected: 'reject', schema: null, xml: '<proceduralStep><para>Do <emphasis>not</emphasis> touch the fan.</para></proceduralStep>' },
  ];
  const { runs, verdict } = testRun(rule, examples);
  check('//emphasis: accept example accepted', runs[0].result.status === 'accepted' && runs[0].matches === true);
  check('//emphasis: reject example rejected, <emphasis> selected', runs[1].result.status === 'rejected' && runs[1].result.selectedNodePaths[0] === '/proceduralStep[1]/para[1]/emphasis[1]', JSON.stringify(runs[1].result));
  check('//emphasis: verdict correct', verdict.kind === 'correct', JSON.stringify(verdict));
  const lines = xmlDisplayLines(examples[1].xml, runs[1].result.selectedNodePaths, parseXml);
  const highlighted = lines.flatMap((l) => l.segments.filter((s) => s.highlight).map((s) => s.text));
  check('//emphasis: display highlights <emphasis> start and end tag', JSON.stringify(highlighted) === JSON.stringify(['<emphasis', '>', '</emphasis>']), JSON.stringify(lines));
  check('//emphasis: display is indented, the mixed-content <para> on one line', lines.length === 3 && lines.map((l) => l.depth).join() === '0,1,0', JSON.stringify(lines.map((l) => l.depth)));
  check('//emphasis: the <para> line reads as the text', lines[1].segments.map((s) => s.text).join('') === '<para>Do <emphasis>not</emphasis> touch the fan.</para>', JSON.stringify(lines[1]));
  const nested = xmlDisplayLines('<dmodule><content><procedure><proceduralStep><para>Torque to 25 N·m.</para></proceduralStep></procedure></content></dmodule>', [], parseXml);
  check('display: nested elements one per line, indented', nested.map((l) => l.depth).join() === '0,1,2,3,4,3,2,1,0', JSON.stringify(nested.map((l) => l.depth)));
}
{
  // @emphasisType em01/em02
  const rule = '<structureObjectRule><objectPath allowedObjectFlag="2">//@emphasisType</objectPath><objectUse>Only em01 and em02 are allowed.</objectUse><objectValue valueForm="single" valueAllowed="em01"/><objectValue valueForm="single" valueAllowed="em02"/></structureObjectRule>';
  const examples = [
    { label: 'em01', expected: 'accept', schema: null, xml: '<para>Apply <emphasis emphasisType="em01">sealant</emphasis>.</para>' },
    { label: 'em05', expected: 'reject', schema: null, xml: '<para>Apply <emphasis emphasisType="em05">sealant</emphasis>.</para>' },
  ];
  const { runs, verdict } = testRun(rule, examples);
  check('@emphasisType: em05 rejected with the rule message', runs[1].result.status === 'rejected' && runs[1].result.violations[0].message === 'Only em01 and em02 are allowed.');
  check('@emphasisType: em01 accepted', runs[0].result.status === 'accepted');
  check('@emphasisType: verdict correct', verdict.kind === 'correct');
  const hl = xmlDisplayLines(examples[1].xml, runs[1].result.selectedNodePaths, parseXml).flatMap((l) => l.segments).filter((s) => s.highlight).map((s) => s.text);
  check('@emphasisType: only the attribute is highlighted', JSON.stringify(hl) === JSON.stringify(['emphasisType="em05"']), JSON.stringify(hl));
  // Edit em05 → em02 and run again
  const edited = { ...examples[1], xml: examples[1].xml.replace('em05', 'em02') };
  const again = runExample(rule, 'BREX-4.2', edited, opts);
  check('@emphasisType: edited to em02 → accepted', again.result.status === 'accepted' && again.matches === false);
  const v2 = ruleTestVerdict([examples[0], edited], [runs[0], again]);
  check('@emphasisType: after the edit the verdict says the rule was permissive', v2.kind === 'incorrect' && v2.permissive && !v2.strict, JSON.stringify(v2));
}
{
  // <emphasis> forbidden only in proced
  const rule = wrapRuleInSchemaContexts('<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis in procedures.</objectUse></structureObjectRule>', 'BREX-4.2', 'S1000D 4.2', ['proced']);
  const examples = [
    { label: 'proced without', expected: 'accept', schema: 'proced', xml: '<proceduralStep><para>Remove the panel.</para></proceduralStep>' },
    { label: 'proced with', expected: 'reject', schema: 'proced', xml: '<proceduralStep><para>Remove the <emphasis>panel</emphasis>.</para></proceduralStep>' },
    { label: 'descript with', expected: 'accept', schema: 'descript', xml: '<levelledPara><para>The <emphasis>panel</emphasis> is blue.</para></levelledPara>' },
  ];
  const { runs, verdict } = testRun(rule, examples);
  check('proced-only: descript example with <emphasis> accepted (rule does not apply)', runs[2].result.status === 'accepted' && runs[2].matches === true && runs[2].result.outOfScopeSchemas[0] === 'proced', JSON.stringify(runs[2].result));
  check('proced-only: proced example rejected', runs[1].result.status === 'rejected');
  check('proced-only: verdict correct', verdict.kind === 'correct', JSON.stringify(verdict));
  check('pickOtherSchema: descript for proced', pickOtherSchema(['proced'], ['descript', 'proced', 'ipd']) === 'descript');
  check('pickOtherSchema: proced when descript is taken', pickOtherSchema(['descript'], ['descript', 'proced']) === 'proced');
  check('pickOtherSchema: any other document schema', pickOtherSchema(['descript', 'proced', 'ipd', 'fault'], ['descript', 'proced', 'ipd', 'fault', 'crew']) === 'crew');
  check('pickOtherSchema: general rule → null', pickOtherSchema([], ['descript']) === null);
}
{
  // document() → not executable, examples still there
  const rule = "<structureObjectRule><objectPath allowedObjectFlag=\"0\">document('other.xml')//emphasis</objectPath></structureObjectRule>";
  const examples = [
    { label: 'a', expected: 'accept', schema: null, xml: '<para>a</para>' },
    { label: 'b', expected: 'reject', schema: null, xml: '<para><emphasis>b</emphasis></para>' },
  ];
  const { runs, verdict } = testRun(rule, examples);
  check('document(): verdict not executable with the engine reason', verdict.kind === 'not_executable' && /reads another file/.test(verdict.reason), JSON.stringify(verdict));
  check('document(): examples were still validated and kept', runs.every((r) => r.validation.wellFormed));
}
{
  // Inconclusive: nothing selected anywhere
  const rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath></structureObjectRule>';
  const examples = [
    { label: 'a', expected: 'accept', schema: null, xml: '<para>a</para>' },
    { label: 'b', expected: 'reject', schema: null, xml: '<para>b</para>' },
  ];
  const { verdict } = testRun(rule, examples);
  check('inconclusive: no example selected anything', verdict.kind === 'inconclusive' && verdict.why === 'nothing_selected', JSON.stringify(verdict));
}
{
  // Incorrect, strict direction
  const rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//para</objectPath></structureObjectRule>';
  const examples = [
    { label: 'a', expected: 'accept', schema: null, xml: '<levelledPara><para>a</para></levelledPara>' },
    { label: 'b', expected: 'reject', schema: null, xml: '<levelledPara><para>b</para></levelledPara>' },
  ];
  const { verdict } = testRun(rule, examples);
  check('incorrect: rule rejected an example meant to comply', verdict.kind === 'incorrect' && verdict.strict && !verdict.permissive, JSON.stringify(verdict));
}
{
  // Invalid examples are never run, never dropped
  const rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath></structureObjectRule>';
  const examples = [
    { label: 'a', expected: 'accept', schema: null, xml: '<para>a<pokemon/></para>' },
    { label: 'b', expected: 'reject', schema: null, xml: '<para><emphasis>b</para>' },
  ];
  const { runs, verdict } = testRun(rule, examples);
  check('invalid examples: not run', runs.every((r) => r.result === null && r.matches === null));
  check('invalid examples: verdict no_runnable', verdict.kind === 'no_runnable', JSON.stringify(verdict));
  const one = testRun(rule, [examples[0], { ...examples[1], xml: '<para><emphasis>b</emphasis></para>' }]);
  check('one invalid example: the runnable one alone is inconclusive (no accept ran)', one.verdict.kind === 'inconclusive' && one.verdict.why === 'missing_expectation', JSON.stringify(one.verdict));
  check('display: malformed XML → null', xmlDisplayLines('<para><emphasis>b</para>', [], parseXml) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
