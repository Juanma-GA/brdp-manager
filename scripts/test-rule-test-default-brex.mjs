// Test de reglas: reglas informativas, juicio de listas cerradas y esquema
// según los predicados (pasada S1000D 4.2 por defecto). The rules of the
// default S1000D 4.2 BREX (DMC-S1000D-F-04-10-0301-00A-022A-D_001-00_EN-US,
// s1kd-tools) verbatim, from scripts/rule-test-fixtures/default-brex-4-2.json
// -- numbered as the project «Official Default S1000D 4.2 - 001» numbers
// them (EXT-n is the n-th candidate AI Extract reads) --, on the REAL S1000D
// 4.2 structures and element graph. The LLM is a fake that returns fixed
// examples: what is tested is the application's part.
//   node scripts/test-rule-test-default-brex.mjs
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { danglingReferenceProblems, exampleFailures, generateRuleTestExamples, prepareRuleTestSetup } from '../src/utils/ruleTestRun.js';
import { ruleTestVerdict } from '../src/utils/ruleTest.js';
import { generationOutcome } from '../src/utils/ruleTestOutcome.js';
import { formatRuleStatement, formatRuleTestReason, ruleDescriptionText, verdictToTestRecord } from '../src/utils/ruleTestReasons.js';
import { informativeRule, lintRuleFindings } from '../src/utils/ruleLint.js';
import { describeRule, ruleElementLists } from '../src/utils/ruleTestEngine.js';
import { predicateRequirements } from '../src/validation/rulePathCheck.js';
import { formatCoverageItem, schemaCoverage } from '../src/validation/schemaCoverage.js';
import { buildRuleProposalCheckPrompt } from '../src/prompts/ruleProposalCheckPrompt.js';
import { buildRuleTestExamplesPrompt } from '../src/prompts/ruleTestExamplesPrompt.js';
import { shouldRepeat } from './lib/projectRuleTests.mjs';
import { schemaGraph } from './lib/schemaGraph.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${String(detail).slice(0, 1500)}` : ''}`);
  }
}
function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');
const S42 = 'S1000D 4.2';
const F = 'BREX-4.2';
const RULES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/default-brex-4-2.json', import.meta.url))).rules;
const rule = (n) => RULES[`BRDP-EXT-${String(n).padStart(5, '0')}`].rule_xml;
const STRUCTURES = JSON.parse(fs.readFileSync(new URL('./rule-test-fixtures/structures.json', import.meta.url)));
const structureOf = (schema) => STRUCTURES[`${S42}|${schema}`];
const vocabJson = JSON.parse(fs.readFileSync(new URL('../public/schema-vocabulary-4-2.json', import.meta.url)));
const vocabulary = { elements: new Set(vocabJson.elements), attributes: new Set(vocabJson.attributes) };
const graph = schemaGraph(S42);
const CARDS = JSON.parse(fs.readFileSync(new URL('../backend/schema_cards/schema-cards-4-2.json', import.meta.url)));
const fetchers = {
  fetchSchemaCards: async (_std, names) => ({
    cards: Object.fromEntries(names.filter((n) => CARDS.cards[n]).map((n) => [n, { variants: CARDS.cards[n], parents: CARDS.parents[n] || [] }])),
    document_schemas: graph.schemas,
  }),
  fetchStructure: async (_std, schema) => (structureOf(schema) ? { available: true, ...structureOf(schema) } : { available: false }),
  fetchSchemaGraph: async () => graph,
};
const brdp = (id, proposal = 'p') => ({ identifier: id, title: 't', definition: 'd', proposal });
async function generate(ruleXml, answers, id = 'BRDP-EXT-X', { proposalAnswer = '{"implements": "yes", "reason": ""}' } = {}) {
  const asked = [];
  const proposalChecks = [];
  const result = await generateRuleTestExamples({
    ruleXml, format: F, standard: S42, schemaLocation: 'flat', brdp: brdp(id), vocabulary, parseXml, ...fetchers,
    ruleDescription: 'description',
    askProposalCheck: async (messages, systemPrompt) => {
      proposalChecks.push(systemPrompt);
      return proposalAnswer;
    },
    ask: async (messages, systemPrompt) => {
      asked.push({ messages, systemPrompt });
      const answer = answers[asked.length - 1];
      if (answer === undefined) throw new Error('unexpected LLM call');
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
  const verdict = result?.status === 'ready' ? ruleTestVerdict(result.examples, result.runs, null, result.proposalCheck, null, result.coverage) : null;
  return { result, asked, verdict, proposalChecks };
}
const setupFor = async (ruleXml) => prepareRuleTestSetup({ ruleXml, standard: S42, schemaLocation: 'flat', ...fetchers, format: F, parseXml });
const placementOf = async (ruleXml) => (await setupFor(ruleXml)).promptPlacements.find((x) => x.role === 'rule');

// ─── Part 1.1: informative rules ────────────────────────────────────────────
const INFORMATIVE = [2, 9, 10, 11, 28, 30, 64, 66, 77, 79, 260];
const MUST_NOT = [37, 38, 39, 40, 42, 63];
for (const n of [...INFORMATIVE, ...MUST_NOT]) {
  const info = informativeRule(rule(n), F, { parseXml });
  check(`1.1 EXT-${n}: informative`, info !== null, rule(n));
  check(`1.1 EXT-${n}: "must not" note ${MUST_NOT.includes(n)}`, info?.mustNot === MUST_NOT.includes(n), JSON.stringify(info));
  // the lint says the same (one function)
  const findings = lintRuleFindings(rule(n), F, { parseXml });
  const kinds = findings.map((f) => f.code || f.kind);
  if (!MUST_NOT.includes(n)) check(`1.1 EXT-${n}: lint "informative rule (flag 2)"`, findings.some((f) => f.known && /informative/.test(JSON.stringify(f))), JSON.stringify(findings));
  else check(`1.1 EXT-${n}: lint keeps "must not but allowed"`, JSON.stringify(kinds).includes('must'), JSON.stringify(findings));
}
{
  const { result, asked, proposalChecks } = await generate(rule(2), []);
  check('1.1 EXT-00002 informative without any LLM call', result?.status === 'informative' && asked.length === 0 && proposalChecks.length === 0, JSON.stringify({ s: result?.status, asked: asked.length, p: proposalChecks.length }));
  const outcome = generationOutcome(result, {});
  check('1.1 outcome: verdict informative', outcome.verdict?.kind === 'informative' && outcome.verdict.mustNot === false, JSON.stringify(outcome.verdict));
  const record = verdictToTestRecord(outcome.verdict);
  check('1.1 recorded as informative', record.result === 'informative' && record.reason.code === 'test_informative', JSON.stringify(record));
  check('1.1 reason EN', formatRuleTestReason(record.reason, en) === 'informative rule: it rejects nothing; it documents what is allowed.', formatRuleTestReason(record.reason, en));
  check('1.1 reason ES', formatRuleTestReason(record.reason, es) === 'regla informativa: no rechaza nada; documenta lo que está permitido.', formatRuleTestReason(record.reason, es));
  check('1.1 verdict EN', en('records.ruleTest.verdicts.informative') === 'Informative: this rule rejects nothing; it documents what is allowed.', en('records.ruleTest.verdicts.informative'));
  check('1.1 verdict ES', es('records.ruleTest.verdicts.informative') === 'Informativa: esta regla no rechaza nada; documenta lo que está permitido.', es('records.ruleTest.verdicts.informative'));
  check('1.1 run-project-rule-tests: informative is never repeated', shouldRepeat({ result: 'informative' }) === false);
}
{
  const { result } = await generate(rule(37), []);
  check('1.1 EXT-00037 informative + must-not note', result?.status === 'informative' && result.informative.mustNot === true, JSON.stringify(result?.informative));
  const record = verdictToTestRecord(generationOutcome(result, {}).verdict);
  check('1.1 must-not note EN', formatRuleTestReason(record.reason, en).includes('"must not"'), formatRuleTestReason(record.reason, en));
  check('1.1 must-not note ES', /«must not»/.test(formatRuleTestReason(record.reason, es)), formatRuleTestReason(record.reason, es));
}
{
  // Flag 2 with objectValue: tested as today.
  const values = '<structureObjectRule><objectPath allowedObjectFlag="2">//@emphasisType</objectPath><objectUse>x</objectUse><objectValue valueForm="single" valueAllowed="em01"/></structureObjectRule>';
  check('1.1 flag 2 with values: not informative', informativeRule(values, F, { parseXml }) === null);
  // An informative part + a flag 0 part: tested as always.
  const mixed = `<structureObjectRuleGroup>${rule(9).match(/<structureObjectRule[\s\S]*?<\/structureObjectRule>/)[0]}<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>x</objectUse></structureObjectRule></structureObjectRuleGroup>`;
  check('1.1 informative part + flag 0 part: not informative', informativeRule(mixed, F, { parseXml }) === null);
  const desc = describeRule(rule(2), F, { parseXml });
  check('1.1 describeRule still says it cannot reject', desc.cannotReject === true);
}

// ─── El juez de la Propuesta, Part 1: the CIR rules' element list ──────────
{
  const CIR = { 14: '0A1', 17: '00F', 19: '00H', 20: '00J', 22: '00L', 23: '00M', 25: '00X' };
  for (const [n, code] of Object.entries(CIR)) {
    const d = describeRule(rule(Number(n)), F, { parseXml });
    const s = d.statements[0]?.statement;
    check(`JL1 EXT-000${n}: ancestor list`, s?.code === 'describe_forbidden_in_ancestor_list' && s.params.ancestor === '<dataUpdateFile>' && s.params.within === '<update>'
      && s.params.target === '<updateCode>' && JSON.stringify(s.params.conditions) === JSON.stringify([{ attr: '@infoCode', value: code }]) && s.params.count === 26, JSON.stringify(s));
    check(`JL1 EXT-000${n}: can reject`, !d.cannotReject);
  }
  const d19 = describeRule(rule(19), F, { parseXml });
  const s19 = d19.statements[0];
  const full = formatRuleStatement(s19.statement, s19.schemas, en);
  check('JL1 EXT-00019 EN text, whole list', full.startsWith('In a <dataUpdateFile> whose <updateCode> has @infoCode "00H", none of these may appear inside <update>: <partSpec>, <functionalItemSpec>,')
    && full.includes('<cautionIdent> (26).') && full.endsWith('Only in the schemas: update.'), full);
  const esText = formatRuleStatement(s19.statement, s19.schemas, es);
  check('JL1 EXT-00019 ES text', esText.startsWith('En un <dataUpdateFile> cuyo <updateCode> tiene @infoCode "00H", no puede aparecer dentro de <update> ninguno de estos: <partSpec>,') && esText.includes('(26)'), esText);
  check('JL1 EXT-00019 judge text has the 26 names', s19.statement.params.forbidden.every((x) => ruleDescriptionText(d19, en).includes(x)) && !ruleDescriptionText(d19, en).includes('…'), ruleDescriptionText(d19, en));
  const cut = formatRuleStatement(s19.statement, s19.schemas, en, { listMax: 8 });
  check('JL1 panel cut: 8 names and "…"', (cut.match(/<[A-Za-z]+Spec>|<[A-Za-z]+Ident>/g) || []).length === 8 && cut.includes(', … (26)'), cut);
  // EXT-00014: 13 Spec + 13 Ident, uncut.
  const s14 = describeRule(rule(14), F, { parseXml }).statements[0].statement;
  check('JL1 EXT-00014: 13 Spec + 13 Ident', s14.params.forbidden.filter((x) => /Spec>$/.test(x)).length === 13 && s14.params.forbidden.filter((x) => /Ident>$/.test(x)).length === 13, JSON.stringify(s14.params.forbidden));
  check('JL1 EXT-00014 in the judge prompt, uncut', (() => {
    const p = buildRuleProposalCheckPrompt({ brdp: brdp('BRDP-EXT-00014', 'Only x'), ruleXml: rule(14), ruleDescription: ruleDescriptionText(describeRule(rule(14), F, { parseXml }), en), format: F, standard: S42 });
    return s14.params.forbidden.every((x) => p.includes(x));
  })());
  // Outside the pattern: literal as before.
  const wrap = (path) => `<structureObjectRule id="R1"><objectPath allowedObjectFlag="0">${path}</objectPath><objectUse>u</objectUse></structureObjectRule>`;
  const literal = describeRule(wrap('//updateCode[attribute::infoCode="00H" and contains(., \'x\') and ancestor::dataUpdateFile[descendant::a or descendant::b]]'), F, { parseXml }).statements[0].statement;
  check('JL1 unknown extra condition → literal', literal.code === 'describe_forbidden' && literal.params.qualifier?.kind === 'condition', JSON.stringify(literal));
  const neg = describeRule(wrap('//updateCode[ancestor::dataUpdateFile[descendant::a or not(descendant::b)]]'), F, { parseXml }).statements[0].statement;
  check('JL1 negated list term → literal', neg.code === 'describe_forbidden', JSON.stringify(neg));
  const one = describeRule(wrap('//updateCode[ancestor::dataUpdateFile[descendant::a]]'), F, { parseXml }).statements[0].statement;
  check('JL1 one-name "list" → as before', one.code !== 'describe_forbidden_in_ancestor_list', JSON.stringify(one));
  const plain = describeRule(wrap('//x[ancestor-or-self::r[.//a or b]]'), F, { parseXml }).statements[0].statement;
  check('JL1 no conditions on X, no intermediate', plain.code === 'describe_forbidden_in_ancestor_list' && plain.params.within === null && plain.params.conditions.length === 0, JSON.stringify(plain));
  check('JL1 plain text EN', formatRuleStatement(plain, [], en) === 'In a <r> with a <x>, none of these may appear: <a>, <b> (2).', formatRuleStatement(plain, [], en));
  const emph = describeRule(wrap('//emphasis'), F, { parseXml }).statements[0].statement;
  check('JL1 //emphasis unchanged', emph.code === 'describe_forbidden', JSON.stringify(emph));
  const flag2 = describeRule(wrap('//updateCode[ancestor::r[a or b]]').replace('"0"', '"2"'), F, { parseXml }).statements[0].statement;
  check('JL1 flag 2 unchanged', flag2.code === 'describe_allowed', JSON.stringify(flag2));
  // ruleElementLists.
  check('JL1 ruleElementLists EXT-00019', JSON.stringify(ruleElementLists(rule(19), F, { parseXml }).forbidden) === JSON.stringify(s19.statement.params.forbidden.map((x) => x.slice(1, -1))));
  check('JL1 ruleElementLists not(self::)', JSON.stringify(ruleElementLists(wrap('//avee/*[not(self::modelic or self::sdc)]'), 'BREX-4.2', { parseXml })) === JSON.stringify({ forbidden: [], allowedOnly: ['modelic', 'sdc'] }));
  check('JL1 ruleElementLists no list', JSON.stringify(ruleElementLists(wrap('//emphasis'), F, { parseXml })) === JSON.stringify({ forbidden: [], allowedOnly: [] }));
}

// ─── Part 1.2: closed lists in the Proposal judgement ──────────────────────
{
  const prompt = buildRuleProposalCheckPrompt({
    brdp: { identifier: 'BRDP-EXT-00014', title: 't', definition: 'd', proposal: 'Only toolSpec, toolIdent, … can be used.' },
    standard: S42,
    format: F,
    ruleXml: rule(14),
    ruleDescription: '- description',
  });
  check('1.2 prompt: forbidding the rest implements "only these"', prompt.includes("Forbidding every element that is not in the\n  Proposal's list implements \"only these\"."), prompt);
  check('1.2 prompt: incomplete list is "partly", never "no"', prompt.includes('the answer is "partly", never "no".'));
}

// ─── Part 2.1: reference destinations ───────────────────────────────────────
{
  for (const [n, schema] of [[46, 'proced'], [47, 'proced'], [48, 'proced'], [50, 'proced'], [55, 'proced'], [56, 'sb']]) {
    const p = await placementOf(rule(n));
    check(`2.1a EXT-${n}: test schema ${schema}`, p?.schema === schema, `${p?.schema} ${p?.insertion}`);
    check(`2.1a EXT-${n}: insertion reaches a destination`, (p?.references || []).every((r) => r.ways.length > 0), JSON.stringify(p?.references));
  }
  // No schema with <commentCode> has a <supplyDescr>: not executable, no LLM.
  const noDestination = '<structureObjectRule><objectPath allowedObjectFlag="0">//commentCode[not(attribute::seqNumber = //supplyDescr/@id)]</objectPath><objectUse>x</objectUse></structureObjectRule>';
  const none = await generate(noDestination, []);
  check('2.1a no destination in any schema: not executable without the LLM', none.result?.status === 'not_executable' && none.result.reason.code === 'reference_no_schema' && none.asked.length === 0, JSON.stringify({ s: none.result?.status, r: none.result?.reason }));
  if (none.result?.reason) {
    check('2.1a reason EN', formatRuleTestReason(none.result.reason, en).includes('<supplyDescr>') && formatRuleTestReason(none.result.reason, en).includes('@seqNumber'), formatRuleTestReason(none.result.reason, en));
    check('2.1a reason ES', formatRuleTestReason(none.result.reason, es).startsWith('ningún esquema de S1000D 4.2 con <commentCode>'), formatRuleTestReason(none.result.reason, es));
  }
}

// ─── Part 2.1b: an example meant to be accepted that points to nothing ──────
const procedure = (supplyId, refId) => `<preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup><reqSupportEquips><noSupportEquips/></reqSupportEquips><reqSupplies><supplyDescrGroup><supplyDescr id="${supplyId}"><name>Sealant</name><identNumber><manufacturerCode>12345</manufacturerCode><partAndSerialNumber><partNumber>PN-1</partNumber></partAndSerialNumber></identNumber><reqQuantity>1</reqQuantity></supplyDescr></supplyDescrGroup></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts><mainProcedure><proceduralStep><para>Apply the sealant <internalRef internalRefId="${refId}" internalRefTargetType="irtt04"/>.</para></proceduralStep></mainProcedure><closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts>`;
{
  const accept = { label: 'points to its supply', expected: 'accept', schema: 'proced', content: procedure('SUP-0001', 'SUP-0001') };
  const dangling = { label: 'points to its supply', expected: 'accept', schema: 'proced', content: procedure('SUP-0001', 'SE123') };
  const reject = { label: 'points to nothing', expected: 'reject', schema: 'proced', content: procedure('SUP-0001', 'SE123') };
  const { result, asked, verdict } = await generate(rule(46), [{ examples: [dangling, reject] }, { examples: [accept, reject] }], 'BRDP-EXT-00046');
  check('2.1b EXT-00046 proced: two LLM calls (one correction round)', asked.length === 2, String(asked.length));
  const correction = asked[1]?.messages?.map((m) => m.content).join('\n') || '';
  check('2.1b correction names the dangling id', correction.includes('The example points to SE123 (@internalRefId of <internalRef>), but no <supplyDescr> or <embeddedSupplyDescr> has id="SE123" in this document'), correction.slice(0, 1500));
  check('2.1b correction only for the accept example', !/Example 2[\s\S]*points to SE123/.test(correction.split('Example 2')[1] || ''), correction.slice(0, 1500));
  check('2.1b after the correction: accepted, verdict correct', result?.runs?.[0]?.result?.status === 'accepted' && verdict?.kind === 'correct', JSON.stringify({ v: verdict, r0: result?.runs?.[0]?.validation }));
  // The function itself: never for a reject example, nothing for an id that exists.
  const refs = [{ element: 'internalRef', attribute: 'internalRefId', destinations: [{ name: 'supplyDescr', attribute: 'id' }] }];
  const rejectedRun = (xml, path) => ({ validation: { runnable: true }, result: { status: 'rejected', violations: [{ nodePaths: [path] }] } });
  const doc = '<dmodule><content><para><internalRef internalRefId="SE123"/></para><supplyDescr id="SUP-1"/></content></dmodule>';
  const path = '/dmodule[1]/content[1]/para[1]/internalRef[1]';
  check('2.1b accept + dangling → one line', danglingReferenceProblems({ expected: 'accept' }, doc, rejectedRun(doc, path), refs, parseXml).length === 1);
  check('2.1b reject + dangling → nothing', danglingReferenceProblems({ expected: 'reject' }, doc, rejectedRun(doc, path), refs, parseXml).length === 0);
  const ok = doc.replace('SUP-1', 'SE123');
  check('2.1b accept + existing id → nothing', danglingReferenceProblems({ expected: 'accept' }, ok, rejectedRun(ok, path), refs, parseXml).length === 0);
  check('2.1b accepted example → nothing', danglingReferenceProblems({ expected: 'accept' }, doc, { validation: { runnable: true }, result: { status: 'accepted', violations: [] } }, refs, parseXml).length === 0);
  check('2.1b exampleFailures is exported', typeof exampleFailures === 'function');
}

// ─── Part 2.2: what the predicates require picks the schema ─────────────────
{
  check('2.2 requirements EXT-00152', JSON.stringify(predicateRequirements(rule(152), F, { parseXml })) === '[[["content","brex"]]]', JSON.stringify(predicateRequirements(rule(152), F, { parseXml })));
  for (const [n, schema, insertion] of [[152, 'brex', 'para'], [151, 'brex', 'para'], [144, 'brdoc', 'para'], [134, 'comrep', null], [133, 'descript', 'content']]) {
    const p = await placementOf(rule(n));
    check(`2.2 EXT-${n}: ${schema}`, p?.schema === schema && (insertion === null || p.insertion === insertion), `${p?.schema} ${p?.insertion}`);
  }
  // A rule without predicates that require anything: the same as before.
  const plain = '<structureObjectRule><objectPath allowedObjectFlag="0">//dmCode[@infoCode!="022"]</objectPath><objectUse>x</objectUse></structureObjectRule>';
  check('2.2 no requirement → descript', (await placementOf(plain))?.schema === 'descript');
  // A negated requirement asks for nothing.
  check('2.2 negated → no requirement', predicateRequirements('<structureObjectRule><objectPath allowedObjectFlag="0">/dmodule[not(content/brex)]/identAndStatusSection</objectPath></structureObjectRule>', F, { parseXml }).length === 0);
}

// ─── Part 2.3: frontMatter descendants in predicates ────────────────────────
{
  for (const [n, way] of [
    [123, 'content/frontMatter/frontMatterList/frontMatterSubList/frontMatterDmEntry/dmRef'],
    [124, 'content/frontMatter/frontMatterList/frontMatterSubList/frontMatterDmEntry/dmRef'],
    [127, 'content/frontMatter/frontMatterList/frontMatterSubList/frontMatterPmEntry/pmRef'],
    [130, 'content/frontMatter/frontMatterList/frontMatterSubList/frontMatterExternalPubEntry/externalPubRef'],
  ]) {
    const p = await placementOf(rule(n));
    check(`2.3 EXT-${n}: frontmatter, way through the front matter list`, p?.schema === 'frontmatter' && p.innerWays?.[0]?.way.join('/') === way, JSON.stringify({ s: p?.schema, w: p?.innerWays }));
  }
  const setup = await setupFor(rule(127));
  const prompt = buildRuleTestExamplesPrompt({
    brdp: brdp('BRDP-EXT-00127'), standard: S42, format: F, ruleXml: rule(127), ruleDescription: '- d', schemaFacts: setup.schemaFacts, placements: setup.promptPlacements,
  });
  check('2.3 prompt: exact way', prompt.includes("The rule's condition looks at <pmRef> inside <frontMatter>: write it by exactly this way: content/frontMatter/frontMatterList/frontMatterSubList/frontMatterPmEntry/pmRef."), prompt.slice(prompt.indexOf('EACH EXAMPLE'), prompt.indexOf('EACH EXAMPLE') + 2500));
  // EXT-00127: a valid example in the front matter; @id on <pmRef> rejected.
  const fm = (attr) => `<frontMatter><frontMatterList frontMatterType="fm01"><frontMatterSubList><frontMatterPmEntry><pmRef${attr}><pmRefIdent><pmCode modelIdentCode="EXAMPLE" pmIssuer="12345" pmNumber="00001" pmVolume="00"/></pmRefIdent></pmRef></frontMatterPmEntry></frontMatterSubList></frontMatterList></frontMatter>`;
  const examples = [
    { label: 'reference without the attributes', expected: 'accept', schema: 'frontmatter', content: fm('') },
    { label: 'reference with @id', expected: 'reject', schema: 'frontmatter', content: fm(' id="pm-1"') },
  ];
  const { result, verdict, asked } = await generate(rule(127), [{ examples }], 'BRDP-EXT-00127');
  check('2.3 EXT-00127 accept valid and accepted', result?.runs?.[0]?.validation?.runnable && result.runs[0].result?.status === 'accepted', JSON.stringify(result?.runs?.[0]?.validation));
  check('2.3 EXT-00127 @id rejected', result?.runs?.[1]?.result?.status === 'rejected', JSON.stringify(result?.runs?.[1]));
  check('2.3 EXT-00127 correct, one call', verdict?.kind === 'correct' && asked.length === 1, JSON.stringify(verdict));
  // EXT-00115: <publisherLogo> never has those attributes → covered.
  const cov = schemaCoverage(rule(115), F, graph, { parseXml });
  check('2.3 EXT-00115 coverage: attributes absent', cov?.items?.[0]?.kind === 'attributesAbsent' && cov.items[0].element === 'publisherLogo', JSON.stringify(cov));
  check('2.3 coverage EN', formatCoverageItem(cov.items[0], en) === '<publisherLogo> never has @id, @authorityName or @authorityDocument', formatCoverageItem(cov.items[0], en));
  check('2.3 coverage ES', formatCoverageItem(cov.items[0], es) === '<publisherLogo> nunca tiene @id, @authorityName ni @authorityDocument', formatCoverageItem(cov.items[0], es));
  const accept115 = { label: 'logo without attributes', expected: 'accept', schema: 'frontmatter', content: '<frontMatterTitlePage><productIntroName><name>Example</name></productIntroName><pmTitle>Example</pmTitle><pmCode modelIdentCode="EXAMPLE" pmIssuer="12345" pmNumber="00001" pmVolume="00"/><issueInfo issueNumber="001" inWork="00"/><issueDate year="2026" month="01" day="01"/><security securityClassification="01"/><responsiblePartnerCompany><enterpriseName>X</enterpriseName></responsiblePartnerCompany><publisherLogo><symbol infoEntityIdent="ICN-1"/></publisherLogo></frontMatterTitlePage>' };
  const g = await generate(rule(115), [{ examples: [accept115] }], 'BRDP-EXT-00115');
  check('2.3 EXT-00115 never "Review" (impossible path): accept only', g.result?.status === 'ready' && g.result.coverage?.items?.[0]?.kind === 'attributesAbsent', JSON.stringify({ s: g.result?.status, r: g.result?.reason }));
  check('2.3 EXT-00115 prompt asks for accept examples only', /only examples meant to be accepted|no example meant to be rejected/i.test(g.asked[0]?.systemPrompt || ''), (g.asked[0]?.systemPrompt || '').slice(0, 300));
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
