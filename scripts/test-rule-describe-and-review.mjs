// Test de reglas T3b: describeRule (the deterministic "what the rule
// checks"), the decision-based examples prompt, the review prompt and the
// "PREVIOUS RULE FAILED ITS TEST" block of Suggest Rule. Pure functions, no
// server, no LLM: node scripts/test-rule-describe-and-review.mjs
//
// describeRule is run over EVERY Verified rule of the BREX templates (4.2,
// 4.1, 3.0.1): each must get a description, and every line must format in
// English and Spanish with no raw i18n key and no "{{" left.
import { DOMParser } from '@xmldom/xmldom';
import { readPublicTemplate } from './lib/readXlsx.mjs';
import i18n from '../src/i18n/index.js';
import { describeRule, pathThreshold } from '../src/utils/ruleTestEngine.js';
import { formatRuleDescription, ruleDescriptionText } from '../src/utils/ruleTestReasons.js';
import { wrapRuleInSchemaContexts } from '../src/utils/ruleSchemaContext.js';
import { buildRuleTestExamplesPrompt, parseRuleTestResponse } from '../src/prompts/ruleTestExamplesPrompt.js';
import {
  buildRuleTestReviewPrompt,
  mismatchedExamples,
  parseRuleTestReviewResponse,
  RULE_TEST_REVIEW_USER_MESSAGE,
} from '../src/prompts/ruleTestReviewPrompt.js';
import { buildSuggestRulePrompt } from '../src/prompts/suggestRulePrompt.js';
import { RULE_TEST_REVIEW_TEMPERATURE } from '../src/prompts/shared.js';

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
  const doc = new DOMParser({ errorHandler: (_level, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0]);
  return doc;
}
const tEn = i18n.getFixedT('en');
const tEs = i18n.getFixedT('es');
const describe = (xml, format) => describeRule(xml, format, { parseXml });
const lines = (xml, format, t = tEn) => formatRuleDescription(describe(xml, format), t);

// ---------------------------------------------------------------------------
// 1. Edge cases of the encargo
const EMPH0 = '<structureObjectRule id="R1"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>';
const EMPH2 = '<structureObjectRule id="R1"><objectPath allowedObjectFlag="2">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>';
const ETYPE =
  '<structureObjectRule id="R2"><objectPath allowedObjectFlag="2">//emphasis/@emphasisType</objectPath><objectUse>Only em01 and em02.</objectUse>' +
  '<objectValue valueForm="single" valueAllowed="em01">Bold</objectValue><objectValue valueForm="single" valueAllowed="em02">Italic</objectValue></structureObjectRule>';

{
  const en = lines(ETYPE, 'BREX-4.2');
  const es = lines(ETYPE, 'BREX-4.2', tEs);
  check('emphasisType: one statement', en.lines.length === 1, JSON.stringify(en));
  check('emphasisType EN: values + not rejected when absent', en.lines[0] === '@emphasisType, when it appears, can only take: em01, em02; if it does not appear, it is not rejected (path //emphasis/@emphasisType).', en.lines[0]);
  check('emphasisType ES: "si no aparece, no se rechaza"', es.lines[0].includes('solo puede valer: em01, em02; si no aparece, no se rechaza'), es.lines[0]);
  check('emphasisType: can reject', !en.cannotReject);
}
{
  const d = describe(EMPH2, 'BREX-4.2');
  const en = lines(EMPH2, 'BREX-4.2');
  const es = lines(EMPH2, 'BREX-4.2', tEs);
  check('flag 2 //emphasis: cannotReject', d.cannotReject === true);
  check('flag 2 //emphasis EN: allowed', en.lines[0] === '<emphasis> is allowed: this rule does not reject it (path //emphasis).', en.lines[0]);
  check('flag 2 //emphasis ES: warning text', tEs('records.ruleTest.describe.cannotReject') === 'Esta regla no puede rechazar ningún contenido.');
  check('flag 2 //emphasis: warning in the prompt text', ruleDescriptionText(d, tEn).endsWith('- This rule cannot reject any content.'));
  check('flag 2 //emphasis ES: permitido', es.lines[0].startsWith('<emphasis> está permitido'), es.lines[0]);
}
{
  const en = lines(EMPH0, 'BREX-4.2');
  check('flag 0 //emphasis: must not appear', en.lines[0] === '<emphasis> must not appear (path //emphasis).' && !en.cannotReject, en.lines[0]);
  check('flag 0 //emphasis ES: no puede aparecer', lines(EMPH0, 'BREX-4.2', tEs).lines[0].startsWith('<emphasis> no puede aparecer'));
}
{
  const proced = wrapRuleInSchemaContexts(EMPH0, 'BREX-4.2', 'S1000D 4.2', ['proced']);
  const d = describe(proced, 'BREX-4.2');
  check('proced context: schema recorded', JSON.stringify(d.statements[0].schemas) === '["proced"]', JSON.stringify(d));
  check('proced context EN', lines(proced, 'BREX-4.2').lines[0].endsWith('Only in the schemas: proced.'));
  check('proced context ES: "solo en los esquemas: proced"', lines(proced, 'BREX-4.2', tEs).lines[0].endsWith('Solo en los esquemas: proced.'));
  const two = wrapRuleInSchemaContexts(EMPH0, 'BREX-4.2', 'S1000D 4.2', ['proced', 'descript']);
  const d2 = describe(two, 'BREX-4.2');
  check('two contexts, same rule: one statement, both schemas', d2.statements.length === 1 && d2.statements[0].schemas.join(',') === 'proced,descript', JSON.stringify(d2));
}
{
  const r301 = '<objrule id="R3"><objpath objappl="0">//randlist</objpath><objuse>No random lists.</objuse></objrule>';
  check('3.0.1 objappl 0: must not appear', lines(r301, 'BREX-3.0.1').lines[0] === '<randlist> must not appear (path //randlist).');
  const r301v = '<objrule id="R4"><objpath>//emphasis/@emph</objpath><objuse>Only em01.</objuse><objval valtype="single" val1="em01">Bold</objval></objrule>';
  check('3.0.1 without objappl + objval: restricted values', lines(r301v, 'BREX-3.0.1').lines[0].startsWith('@emph, when it appears, can only take: em01;'));
  const r301m = '<objrule id="R5"><objpath objappl="1">//table/@frame</objpath><objuse>Frame.</objuse></objrule>';
  check('3.0.1 objappl 1: each <table> must contain @frame', lines(r301m, 'BREX-3.0.1').lines[0].startsWith('Each <table> must contain @frame'));
  const r301n = '<objrule id="R6"><objpath objappl="0">//randlist</objpath><objuse>No.</objuse></objrule><!-- nonContextRule id="X": something -->';
  check('3.0.1 objrule + nonContext comment: objrule described', describe(r301n, 'BREX-3.0.1').statements.some((s) => s.statement.code === 'describe_forbidden'));
}
{
  const range = '<structureObjectRule id="R7"><objectPath allowedObjectFlag="2">//quantity/@quantityValue</objectPath><objectUse>1 to 10.</objectUse><objectValue valueForm="range" valueAllowed="1~10">x</objectValue></structureObjectRule>';
  check('range: from 1 to 10', lines(range, 'BREX-4.2').lines[0].includes('can only take: from 1 to 10'), lines(range, 'BREX-4.2').lines[0]);
  const doc = "<structureObjectRule id=\"R8\"><objectPath allowedObjectFlag=\"0\">document('x.xml')//emphasis</objectPath><objectUse>x</objectUse></structureObjectRule>";
  const dd = lines(doc, 'BREX-4.2');
  check('document(): not checked, with the reason', dd.lines[0].startsWith('Not checked by the test engine: The rule reads another file (document())'), dd.lines[0]);
  const nc = '<nonContextRule id="R9"><simplePara>Use plain English.</simplePara></nonContextRule>';
  check('nonContextRule: described', lines(nc, 'BREX-4.2').lines[0].startsWith('A decision with no XPath check'));
  check('unknown format: not available', describe(EMPH0, 'XSD-1.1').available === false);
  check('malformed rule: not available', describe('<structureObjectRule>', 'BREX-4.2').available === false);
  check('not available → formatRuleDescription null', formatRuleDescription({ available: false }, tEn) === null);
  check('no target (alternatives) → nodes of the path', lines('<structureObjectRule id="R"><objectPath allowedObjectFlag="0">//a | //b</objectPath><objectUse>x</objectUse></structureObjectRule>', 'BREX-4.2').lines[0].startsWith('The nodes selected by //a | //b must not appear'));
}

// ---------------------------------------------------------------------------
// 2. Every Verified rule of the BREX templates gets a description
const TEMPLATE_FILES = { 'BREX-4.2': '4-2', 'BREX-4.1': '4-1', 'BREX-3.0.1': '3-0-1' };
let templateCount = 0;
for (const [format, suffix] of Object.entries(TEMPLATE_FILES)) {
  const rows = readPublicTemplate(`brdp-template-${suffix}.xlsx`).filter((r) => r['Rule Status'] === 'Verified' && r.Rule);
  for (const row of rows) {
    templateCount += 1;
    const d = describe(row.Rule, format);
    check(`${format} ${row.ID}: described`, d.available && d.statements.length > 0, JSON.stringify(d));
    if (!d.available) continue;
    for (const t of [tEn, tEs]) {
      const f = formatRuleDescription(d, t);
      for (const line of f.lines) {
        check(`${format} ${row.ID} (${t === tEn ? 'en' : 'es'}): "${line.slice(0, 60)}…" fully formatted`, line && !line.includes('{{') && !/^describe_/.test(line) && !line.includes('records.ruleTest'), line);
      }
    }
  }
}
check('templates: 30 Verified BREX rules described', templateCount === 30, String(templateCount));

// ---------------------------------------------------------------------------
// 3. Examples prompt: the decision, not the rule
const brdp = { identifier: 'BRDP-S1-00100', title: 'Emphasis', definition: 'Emphasis types.', proposal: 'Only @emphasisType em01 and em02 shall be used.' };
const placements = [{ schema: 'descript', role: 'rule', path: ['dmodule', 'content', 'description', 'levelledPara', 'para'], insertion: 'para', allowedChildren: ['emphasis'] }];
const p = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: ETYPE, placements });
check('examples prompt: the decision comes first and is what is tested', p.indexOf('the examples test THIS') < p.indexOf('The rule under test'));
check('examples prompt: rule only for the names involved', p.includes('use it only to know which elements,\nattributes and schemas are involved'));
check('examples prompt: examples from the decision, never from the rule', p.includes('written from the Proposal\'s DECISION,\n  never from the rule'));
check('examples prompt: value restriction ≠ mandatory', p.includes('A restriction on values does not make an attribute or element mandatory'));
check('examples prompt: reject breaks exactly what the Proposal decides', p.includes('The reject example goes against exactly\n  what the Proposal decides'));
check('examples prompt: no explanation asked', !p.includes('"explanation"'));
check('examples prompt: no PREVIOUS block by default', !p.includes('PREVIOUS EXAMPLES WERE WRONG'));
const mm = [{ label: 'Sealant step without emphasisType', expected: 'reject', got: 'accepted', content: 'Apply <emphasis>sealant</emphasis>.', xml: '<dmodule/>' }];
const pr = buildRuleTestExamplesPrompt({ brdp, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: ETYPE, placements, previousReview: { explanation: 'The Proposal only restricts values.', mismatches: mm } });
check('examples prompt: PREVIOUS block with the example and the diagnosis', pr.includes('PREVIOUS EXAMPLES WERE WRONG') && pr.includes('"Sealant step without emphasisType" (expected reject, the rule accepted it)') && pr.includes('Diagnosis: The Proposal only restricts values.'));
const parsedOld = parseRuleTestResponse('{"explanation":"x","proposalMismatch":null,"examples":[{"label":"a","expected":"accept","content":"x"}]}');
check('examples parse: explanation ignored', parsedOld.ok && !('explanation' in parsedOld));

// ---------------------------------------------------------------------------
// 4. Review prompt, parse, mismatches
const examples = [
  { label: 'ok', expected: 'accept', content: 'a', xml: '<a/>' },
  { label: 'bad', expected: 'reject', content: 'b', xml: '<b/>' },
];
const runs = [{ matches: true, result: { status: 'accepted' } }, { matches: false, result: { status: 'accepted' } }];
const mis = mismatchedExamples(examples, runs);
check('mismatches: only the example that did not match', mis.length === 1 && mis[0].label === 'bad' && mis[0].got === 'accepted' && mis[0].xml === '<b/>');
const desc = ruleDescriptionText(describe(EMPH2, 'BREX-4.2'), tEn);
const rp = buildRuleTestReviewPrompt({ brdp: { ...brdp, proposal: '<emphasis> shall not be used.' }, standard: 'S1000D 4.2', format: 'BREX-4.2', ruleXml: EMPH2, ruleDescription: desc, mismatches: mis });
check('review prompt: exact description', rp.includes('What the rule checks (computed by the application from its XML — exact):\n- <emphasis> is allowed') && rp.includes('This rule cannot reject any content.'));
check('review prompt: mismatch with expected/got/xml', rp.includes('Example 1 ("bad"): expected rejected, the rule accepted it.\n<b/>'));
check('review prompt: three causes + language of the Proposal', rp.includes('"rule":') && rp.includes('"example":') && rp.includes('"unclear":') && rp.includes('same language as the Proposal'));
check('review prompt: judged against the Proposal', rp.includes('Judge against the Proposal'));
check('review: user message + temperature', RULE_TEST_REVIEW_USER_MESSAGE === 'Review this failed rule test.' && RULE_TEST_REVIEW_TEMPERATURE === 0.3);
check('review parse: ok', JSON.stringify(parseRuleTestReviewResponse('```json\n{"cause":"rule","explanation":"x"}\n```')) === '{"ok":true,"cause":"rule","explanation":"x"}');
check('review parse: bad cause', !parseRuleTestReviewResponse('{"cause":"both","explanation":"x"}').ok);
check('review parse: no explanation', !parseRuleTestReviewResponse('{"cause":"example"}').ok);
check('review parse: not JSON', !parseRuleTestReviewResponse('The rule is wrong.').ok);

// ---------------------------------------------------------------------------
// Mejoras A, Part 4: thresholds on the last step explained
{
  const flag0 = (p) => `<structureObjectRule id="R"><objectPath allowedObjectFlag="0">${p}</objectPath><objectUse>x</objectUse></structureObjectRule>`;
  const one = (p, t = tEn) => lines(flag0(p), 'BREX-4.2', t).lines[0];
  const S186 = '//proceduralStep[count(ancestor::proceduralStep)>5]';
  check('S1-00186 EN: level 7 or deeper', one(S186) === '<proceduralStep> must not be nested at level 7 or deeper (with more than 5 <proceduralStep> above it) (path //proceduralStep[count(ancestor::proceduralStep)>5]).', one(S186));
  check('S1-00186 ES: a partir del nivel 7', one(S186, tEs) === '<proceduralStep> no puede estar anidado a partir del nivel 7 (con más de 5 <proceduralStep> por encima) (ruta //proceduralStep[count(ancestor::proceduralStep)>5]).', one(S186, tEs));
  check('ancestor-or-self > 5 → level 6', one('//proceduralStep[count(ancestor-or-self::proceduralStep)>5]').includes('at level 6 or deeper (with more than 4'));
  check('ancestor = 4 → at level 5 (ES en el nivel 5)', one('//proceduralStep[count(ancestor::proceduralStep)=4]', tEs).includes('en el nivel 5 (con exactamente 4'));
  check('number on the left (5 < count)', pathThreshold('//x[5 < count(ancestor::x)]')?.level === 7);
  check('ancestor-or-self <= 2 → levels 1 to 2', one('//levelledPara[count(ancestor-or-self::levelledPara) &lt;= 2]').includes('at levels 1 to 2'));
  const S187 = '//proceduralStep[count(proceduralStep) = 1]';
  check('S1-00187 EN: exactly 1 child', one(S187).startsWith('<proceduralStep> with exactly 1 <proceduralStep> child must not appear'), one(S187));
  check('S1-00187 ES: exactamente 1 hijo', one(S187, tEs).startsWith('<proceduralStep> con exactamente 1 <proceduralStep> hijo no puede aparecer'), one(S187, tEs));
  check('count(H) > 3 → children plural', one('//randomList[count(listItem) > 3]').includes('more than 3 <listItem> children'));
  const S338 = '//@assyCode[string-length(.) != 2]';
  check('S1-00338 EN: not exactly 2 characters', one(S338).startsWith('@assyCode whose value does not have exactly 2 characters must not appear'), one(S338));
  check('S1-00338 ES: no tenga exactamente 2 caracteres', one(S338, tEs).startsWith('@assyCode cuyo valor no tenga exactamente 2 caracteres no puede aparecer'), one(S338, tEs));
  check('count(ancestor::OTHER): "above it", never "level"', one('//para[count(ancestor::levelledPara)>3]') === '<para> with more than 3 <levelledPara> above it must not appear (path //para[count(ancestor::levelledPara)>3]).' && !one('//para[count(ancestor::levelledPara)>3]', tEs).includes('nivel'));
  // Mejoras B, Part 4.1 a: a nesting threshold on an earlier step is explained too.
  check('threshold not on the last step → "in a <x> at level N"', one('//proceduralStep[count(ancestor::proceduralStep)>5]/para') === '<para> must not appear in a <proceduralStep> at level 7 or deeper (path //proceduralStep[count(ancestor::proceduralStep)>5]/para).', one('//proceduralStep[count(ancestor::proceduralStep)>5]/para'));
  check('MB4.1 =4 / ancestor-or-self =5 ES', one('//proceduralStep[count(ancestor::proceduralStep)=4]/title', tEs) === '<title> no puede aparecer en un <proceduralStep> de nivel 5 (ruta //proceduralStep[count(ancestor::proceduralStep)=4]/title).' && one('//proceduralStep[count(ancestor-or-self::proceduralStep)=5]/title', tEs).startsWith('<title> no puede aparecer en un <proceduralStep> de nivel 5'));
  check('MB4.1 attribute predicates ES', one('//entry[@applicRefId]', tEs).startsWith('<entry> con @applicRefId no puede aparecer') && one('//entry[not(@applicRefId)]', tEs).startsWith('<entry> sin @applicRefId no puede aparecer')
    && one("//entry[@a='v']", tEs).startsWith('<entry> con @a = «v» no puede aparecer') && one("//entry[@a != 'v']", tEs).startsWith('<entry> con @a distinto de «v» no puede aparecer'));
  check('MB4.1 * step', one('//entry/*[@applicRefId]', tEs).startsWith('Cualquier elemento hijo de <entry> con @applicRefId no puede aparecer') && one('//entry/*[@applicRefId]').startsWith('Any child element of <entry> with @applicRefId must not appear'));
  check('MB4.1 two predicates on one step → as before', one('//a[@x][@y]') === '<a> must not appear (path //a[@x][@y]).');
  check('MB4.1 two thresholds on one step → as before', one('//a[count(b)>1][count(c)>2]') === '<a> must not appear (path //a[count(b)>1][count(c)>2]).');
  check('MB4.1 c concordance ES', one('(//a | //b)[1]', tEs) === 'Los nodos que selecciona (//a | //b)[1] no pueden aparecer.', one('(//a | //b)[1]', tEs));
  check('not a number → as before', pathThreshold('//proceduralStep[count(ancestor::proceduralStep)>last()]') === null);
  check('flag 2 with a threshold → still "allowed"', lines(flag0(S186).replace('"0"', '"2"'), 'BREX-4.2').lines[0].startsWith('<proceduralStep> is allowed'));
  check('threshold rule can reject', !describe(flag0(S186), 'BREX-4.2').cannotReject);
  check('3.0.1 objappl 0 explained too', lines(`<objrule><objpath objappl="0">${S186}</objpath><objuse>x</objuse></objrule>`, 'BREX-3.0.1').lines[0].includes('level 7 or deeper'));
}

// ---------------------------------------------------------------------------
// 5. Suggest Rule with the failed test
const refs = { sameBrdp: [], similar: [], formatExamples: [] };
const brdpRule = { ...brdp, proposal: '<emphasis> shall not be used.' };
const base = buildSuggestRulePrompt(brdpRule, 'S1000D 4.2', 'BREX-4.2', refs, []);
check('suggest rule: no failed test → no block', !base.includes('PREVIOUS RULE FAILED ITS TEST'));
const withFailed = buildSuggestRulePrompt(brdpRule, 'S1000D 4.2', 'BREX-4.2', refs, [], null, { ruleXml: EMPH2, mismatches: mis, diagnosis: 'Flag 2 allows it.' });
check('suggest rule: failed-test block with rule, example, diagnosis', withFailed.includes('PREVIOUS RULE FAILED ITS TEST') && withFailed.includes(EMPH2) && withFailed.includes('- "bad" (expected rejected, the rule accepted it):\n<b/>') && withFailed.includes('Diagnosis: Flag 2 allows it.'));
check('suggest rule: block before NOT CHECKABLE', withFailed.indexOf('PREVIOUS RULE FAILED ITS TEST') < withFailed.indexOf('NOT CHECKABLE:'));
check('suggest rule: rest of the prompt unchanged', withFailed.replace(/\n\nPREVIOUS RULE FAILED ITS TEST:[\s\S]*?Do not copy the previous rule's mistake\./, '') === base);

// ─── Mejoras C, Part 3: document roots and existence predicates ──────────
{
  const parseXmlC = (x) => new DOMParser().parseFromString(x, 'text/xml');
  const objrule = (path, flag = '0') => `<objrule id="R"><objpath objappl="${flag}">${path}</objpath><objuse>x</objuse></objrule>`;
  const lines = (path, t, flag = '0') => formatRuleDescription(describeRule(objrule(path, flag), 'BREX-3.0.1', { parseXml: parseXmlC }), t).lines;
  const cases = [
    ['/dmodule[not(//actref)]', 'Every document must contain at least one <actref> (applies to <dmodule> documents', 'Todo documento debe contener algún <actref> (se aplica a los documentos <dmodule>'],
    ['/dmodule[not(.//actref)]', 'Every document must contain at least one <actref>', 'Todo documento debe contener algún <actref>'],
    ['/pm[not(//actref)]', 'applies to <pm> documents', 'se aplica a los documentos <pm>'],
    ['/dmodule[//actref]', 'No document may contain <actref>', 'Ningún documento puede contener <actref>'],
    ['//techstd[not(authex) or not(notes)]', '<techstd> without <authex> or without <notes> must not appear', '<techstd> sin <authex> o sin <notes> no puede aparecer'],
    ['//techstd[authex and @id]', '<techstd> with <authex> and with @id must not appear', '<techstd> con <authex> y con @id no puede aparecer'],
    ['//para[not(.//emphasis)]', '<para> without any <emphasis> inside must not appear', '<para> sin ningún <emphasis> dentro no puede aparecer'],
    ['//x[not(a)]', '<x> without <a> must not appear', '<x> sin <a> no puede aparecer'],
  ];
  for (const [path, en, es] of cases) {
    const le = lines(path, tEn);
    const ls = lines(path, tEs);
    check(`Mejoras C describe: ${path} EN`, le.length === 1 && le[0].includes(en), le.join(' | '));
    check(`Mejoras C describe: ${path} ES`, ls.length === 1 && ls[0].includes(es), ls.join(' | '));
  }
  // as before: mixed and/or, a single attribute, //x off a document root,
  // other predicates, and flags 1/2.
  check('Mejoras C describe: mixed and/or as before', lines('//x[a and not(b) or c]', tEn)[0].startsWith('<x> must not appear'));
  check('Mejoras C describe: single attribute as before', lines('//x[@id]', tEn)[0].startsWith('<x> with @id must not appear'));
  check('Mejoras C describe: //y off a root as before', lines('//x[not(//y)]', tEn)[0].startsWith('<x> must not appear'));
  check('Mejoras C describe: function predicate as before', lines("//x[starts-with(., 'a')]", tEn)[0].startsWith('<x> must not appear'));
  check('Mejoras C describe: flag 1 as before', !lines('/dmodule[not(//actref)]', tEn, '1')[0].includes('Every document must contain'));
  // can reject
  const d = describeRule(objrule('/dmodule[not(//actref)]'), 'BREX-3.0.1', { parseXml: parseXmlC });
  check('Mejoras C describe: can reject', d.cannotReject === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
