// "Comparar dos BRDP lado a lado": the deterministic parts of the view --
// word diff, normalized XML and line diff, structural summary (BREX and
// Schematron), summary facts -- and the Ask prompt with a BRDP of another
// project. Run: node scripts/test-brdp-compare.mjs
import { DOMParser } from '@xmldom/xmldom';
import {
  compareDetails,
  compareRuleStructure,
  diffRuleLines,
  diffSequences,
  diffText,
  foldEqualRows,
  normalizeRuleXml,
  textsEqual,
} from '../src/utils/brdpCompare.js';
import { buildAskSystemPrompt } from '../src/prompts/askPrompt.js';
import { readPublicTemplate } from './lib/readXlsx.mjs';

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
const opts = { parseXml };
const changedText = (segments) => segments.filter((s) => s.changed).map((s) => s.text).join('|');

// ── Myers ──
{
  const apply = (a, b) => {
    const ops = diffSequences(a, b);
    const outA = ops.filter((o) => o.op !== 'insert').map((o) => a[o.a]);
    const outB = ops.filter((o) => o.op !== 'delete').map((o) => b[o.b]);
    return outA.join('') === a.join('') && outB.join('') === b.join('') ? ops : null;
  };
  const cases = [['', ''], ['abc', ''], ['', 'abc'], ['abcabba', 'cbabac'], ['abcdef', 'abcxef'], ['kitten', 'sitting'], ['aaaa', 'aa']];
  for (const [x, y] of cases) {
    const ops = apply([...x], [...y]);
    check(`myers reconstructs both sides: "${x}" / "${y}"`, ops !== null);
  }
  const ops = diffSequences([...'abcabba'], [...'cbabac']);
  check('myers is minimal on the classic example (5 edits)', ops.filter((o) => o.op !== 'equal').length === 5);
  // Random round trips.
  let ok = true;
  for (let i = 0; i < 200; i += 1) {
    const rnd = () => Array.from({ length: Math.floor(Math.random() * 30) }, () => 'abc'[Math.floor(Math.random() * 3)]);
    if (!apply(rnd(), rnd())) ok = false;
  }
  check('myers reconstructs 200 random pairs', ok);
}

// ── Word diff ──
{
  const d = diffText('The element <emphasis> shall not be used.', 'The element <emphasis> shall be used sparingly.');
  check('word diff: not equal', !d.equal);
  check('word diff: left marks the removed word', changedText(d.left).includes('not'), JSON.stringify(d.left));
  check('word diff: right marks the added word', changedText(d.right).includes('sparingly'), JSON.stringify(d.right));
  check('word diff: unchanged words stay unmarked', !changedText(d.left).includes('element') && !changedText(d.right).includes('element'));
  check('word diff: left text is intact', d.left.map((s) => s.text).join('') === 'The element <emphasis> shall not be used.');
  check('word diff: right text is intact', d.right.map((s) => s.text).join('') === 'The element <emphasis> shall be used sparingly.');
  const ws = diffText('Two  words\nhere', 'Two words here');
  check('whitespace only: equal', ws.equal);
  check('whitespace only: nothing marked', !ws.left.some((s) => s.changed) && !ws.right.some((s) => s.changed));
  const ph = diffText('Use [VALUE: e.g. 5] levels.', 'Use 4 levels.');
  check('placeholder text diffed as words', changedText(ph.left).includes('VALUE'));
  const accents = diffText('Definición del módulo', 'Definición del módulo');
  check('accented words are equal tokens', accents.equal && !accents.left.some((s) => s.changed));
  check('textsEqual ignores trailing spaces and CRLF', textsEqual('a\r\nb ', 'a\nb'));
  check('empty vs text', !diffText('', 'x').equal && changedText(diffText('', 'x').right) === 'x');
}

// ── Normalized XML ──
const RULE_A = `<structureObjectRule id="BRDP-S1-00052">
  <brDecisionRef brDecisionIdentNumber="BRDP-S1-00052"/>
  <objectPath allowedObjectFlag="2">//dmIdent/dmCode/@infoCode</objectPath>
  <objectUse>Allowed info codes.</objectUse>
  <objectValue valueForm="single" valueAllowed="000"/>
  <objectValue valueForm="single" valueAllowed="055"/>
</structureObjectRule>`;
const RULE_A_REFORMATTED = `<structureObjectRule   id="BRDP-S1-00052"><brDecisionRef brDecisionIdentNumber="BRDP-S1-00052"/>
<objectPath allowedObjectFlag="2">
    //dmIdent/dmCode/@infoCode
</objectPath>
<objectUse>Allowed   info
  codes.</objectUse><objectValue valueForm="single" valueAllowed="000"/><objectValue valueForm="single" valueAllowed="055"/></structureObjectRule>`;
{
  const a = normalizeRuleXml(RULE_A, opts);
  const b = normalizeRuleXml(RULE_A_REFORMATTED, opts);
  check('normalized: parses', a.ok && b.ok);
  check('normalized: indentation and line breaks do not matter', a.text === b.text, `${a.text}\n---\n${b.text}`);
  check('normalized: uniform two-space indentation', a.text.split('\n')[1].startsWith('  <brDecisionRef'));
  const quoted = normalizeRuleXml('<sch:rule context="p"><sch:assert test="@x = \'a  b\'">m</sch:assert></sch:rule>', opts);
  check('normalized: whitespace inside an XPath string literal is kept', quoted.text.includes("'a  b'"), quoted.text);
  const collapsedLit = normalizeRuleXml('<sch:rule context="p"><sch:assert test="@x = \'a b\'">m</sch:assert></sch:rule>', opts);
  check('normalized: a literal with one space differs from one with two', quoted.text !== collapsedLit.text);
  const broken = normalizeRuleXml('<objrule><objpath>//a</objrule>', opts);
  check('normalized: malformed XML is returned as written', !broken.ok && broken.text.includes('<objpath>'));
  const details = compareDetails(
    { rule_format: 'BREX-4.2', rule: { rule_xml: RULE_A, status: 'approved' } },
    { rule_format: 'BREX-4.2', rule: { rule_xml: RULE_A_REFORMATTED, status: 'approved' } },
    opts,
  );
  check('rules equal except formatting → "Regla igual"', details.rule.status === 'equal');
  check('...and the structural summary has no change', details.rule.structure.status === 'compared' && !details.rule.structure.changed);
}

// ── Line diff and folding ──
{
  const left = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
  const right = ['a', 'b', 'c', 'd', 'e', 'X', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n');
  const rows = diffRuleLines(left, right);
  check('line diff: one changed row', rows.filter((r) => r.kind === 'changed').length === 1 && rows.find((r) => r.kind === 'changed').right === 'X');
  check('line diff: one added row', rows.filter((r) => r.kind === 'added').length === 1);
  const folded = foldEqualRows(diffRuleLines(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'changed' : `l${i}`)).join('\n')));
  const folds = folded.filter((r) => r.kind === 'fold');
  check('fold: two folds around one change', folds.length === 2, JSON.stringify(folded.map((r) => r.kind)));
  check('fold: 3 lines of context each side', folded.findIndex((r) => r.kind === 'changed') === 4 && folded.length === 9);
  check('fold: no line lost', folded.reduce((n, r) => n + (r.kind === 'fold' ? r.rows.length : 1), 0) === 30);
  check('fold: a short run is not folded', foldEqualRows(diffRuleLines('a\nb\nc', 'a\nx\nc')).every((r) => r.kind !== 'fold'));
}

// ── Structural summary, BREX ──
const brexRule = (values, { id = 'BRDP-S1-00052', flag = '2', path = '//dmIdent/dmCode/@infoCode' } = {}) =>
  `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="${flag}">${path}</objectPath><objectUse>u</objectUse>${values
    .map((v) => `<objectValue valueForm="single" valueAllowed="${v}"/>`)
    .join('')}</structureObjectRule>`;
{
  const s = compareRuleStructure({ format: 'BREX-4.2', xml: brexRule(['000', '002']) }, { format: 'BREX-4.2', xml: brexRule(['000', '055', '930']) }, opts);
  check('BREX: compared', s.status === 'compared' && s.family === 'brex4');
  check('BREX: values added +055, +930', s.valuesAdded.join(',') === '055,930', s.valuesAdded.join(','));
  check('BREX: values removed −002', s.valuesRemoved.join(',') === '002');
  check('BREX: one changed rule with the value changes', s.items.length === 1 && s.items[0].kind === 'changed' && s.items[0].changes.valuesAdded.length === 2);

  // 155 vs 153 objectValue: "−2 valores", saying which.
  const many = Array.from({ length: 155 }, (_, i) => String(i).padStart(3, '0'));
  const fewer = many.filter((v) => v !== '077' && v !== '140');
  const big = compareRuleStructure({ format: 'BREX-4.2', xml: brexRule(many) }, { format: 'BREX-4.2', xml: brexRule(fewer) }, opts);
  check('155 vs 153: −2 values, named', big.valuesRemoved.join(',') === '077,140' && big.valuesAdded.length === 0);
  const lines = diffRuleLines(normalizeRuleXml(brexRule(many), opts).text, normalizeRuleXml(brexRule(fewer), opts).text);
  check('155 vs 153: text view marks exactly the 2 removed lines', lines.filter((r) => r.kind !== 'equal').length === 2 && lines.filter((r) => r.kind === 'removed').length === 2);
  check('155 vs 153: text view folds the unchanged values', foldEqualRows(lines).some((r) => r.kind === 'fold'));

  const flag = compareRuleStructure({ format: 'BREX-4.2', xml: brexRule([], { flag: '2', path: '//emphasis' }) }, { format: 'BREX-4.1', xml: brexRule([], { flag: '0', path: '//emphasis' }) }, opts);
  check('BREX 4.2 vs 4.1: same family, flag change', flag.status === 'compared' && flag.items[0].changes.flag.join('→') === '2→0');
  const noFlag = compareRuleStructure({ format: 'BREX-4.2', xml: '<structureObjectRule id="x"><objectPath>//a</objectPath><objectUse>u</objectUse></structureObjectRule>' }, { format: 'BREX-4.2', xml: brexRule([], { id: 'x', flag: '2', path: '//a' }) }, opts);
  check('BREX: absent flag is the default 2', noFlag.status === 'compared' && !noFlag.changed);
  const path = compareRuleStructure({ format: 'BREX-4.2', xml: brexRule([], { id: 'A', path: '//emphasis' }) }, { format: 'BREX-4.2', xml: brexRule([], { id: 'B', path: '//para/emphasis' }) }, opts);
  check('BREX: different ids pair in order, path changed', path.items.length === 1 && path.items[0].changes.path.join('→') === '//emphasis→//para/emphasis');
  const extra = compareRuleStructure(
    { format: 'BREX-4.2', xml: brexRule([], { id: 'A', path: '//a' }) },
    { format: 'BREX-4.2', xml: `${brexRule([], { id: 'A', path: '//a' })}<nonContextRule id="N"><simplePara>x</simplePara></nonContextRule>` },
    opts,
  );
  check('BREX: an extra nonContextRule is "added"', extra.items.map((i) => i.kind).join(',') === 'same,added' && extra.items[1].right.kind === 'nonContext');
  const range = compareRuleStructure(
    { format: 'BREX-4.2', xml: '<structureObjectRule id="r"><objectPath>//@a</objectPath><objectUse>u</objectUse><objectValue valueForm="range" valueAllowed="1~10"/></structureObjectRule>' },
    { format: 'BREX-4.2', xml: '<structureObjectRule id="r"><objectPath>//@a</objectPath><objectUse>u</objectUse><objectValue valueForm="range" valueAllowed="1~20"/><objectValue valueForm="pattern" valueAllowed="em0[1-5]"/></structureObjectRule>' },
    opts,
  );
  check('BREX: range and pattern values', range.valuesRemoved.join(',') === '1~10' && range.valuesAdded.join(',') === '1~20,pattern: em0[1-5]');
  const ctx = compareRuleStructure(
    { format: 'BREX-4.2', xml: brexRule([], { id: 'c', path: '//a' }) },
    { format: 'BREX-4.2', xml: `<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd"><structureObjectRuleGroup>${brexRule([], { id: 'c', path: '//a' })}</structureObjectRuleGroup></contextRules>` },
    opts,
  );
  check('BREX: the schema of a context block is a change', ctx.items[0].changes.schema?.[1] === 'proced');

  // 3.0.1 vs 3.0.1
  const r301 = (v) => `<objrule><objpath objappl="1">//@incode</objpath><objuse>u</objuse><objval valtype="single" val1="${v}"/></objrule>`;
  const s301 = compareRuleStructure({ format: 'BREX-3.0.1', xml: r301('040') }, { format: 'BREX-3.0.1', xml: r301('041') }, opts);
  check('BREX 3.0.1: values compared', s301.family === 'brex301' && s301.valuesAdded.join() === '041' && s301.valuesRemoved.join() === '040');

  // Formats differ: objrule 3.0.1 vs structureObjectRule 4.2.
  const diff = compareRuleStructure({ format: 'BREX-3.0.1', xml: r301('040') }, { format: 'BREX-4.2', xml: brexRule(['040']) }, opts);
  check('formats differ (3.0.1 vs 4.2): no structural summary', diff.status === 'formats_differ' && diff.leftFormat === 'BREX-3.0.1');
  const dd = compareDetails(
    { rule_format: 'BREX-3.0.1', rule: { rule_xml: r301('040'), status: 'approved' } },
    { rule_format: 'BREX-4.2', rule: { rule_xml: brexRule(['040']), status: 'pending_review' } },
    opts,
  );
  check('formats differ: text view still there', dd.rule.status === 'different' && dd.rule.leftText.includes('<objrule>') && dd.rule.rightText.includes('<structureObjectRule'));
  check('rule state compared (verified vs draft)', dd.ruleState === false);

  // One side without a rule.
  check('missing on the right', compareRuleStructure({ format: 'BREX-4.2', xml: brexRule(['1']) }, null, opts).side === 'right');
  check('missing on the left', compareRuleStructure(null, { format: 'BREX-4.2', xml: brexRule(['1']) }, opts).side === 'left');
  check('neither has a rule', compareRuleStructure(null, null, opts).status === 'none');
  const none = compareDetails({ rule_format: 'BREX-4.2', rule: null }, { rule_format: null, rule: null }, opts);
  check('details: no rule on either side', none.rule.status === 'none' && none.ruleState);
}

// ── Structural summary, Schematron ──
{
  const sch = (test, ctx = 'note') => `<sch:pattern id="p"><sch:rule context="${ctx}"><sch:assert id="a1" test="${test}" role="error">Note needs a type.</sch:assert></sch:rule></sch:pattern>`;
  const s = compareRuleStructure({ format: 'SCH-DITA', xml: sch('@type') }, { format: 'SCH-DITA', xml: sch("@type = ('note','tip')") }, opts);
  check('Schematron: compared', s.status === 'compared' && s.family === 'sch');
  check('Schematron: test change', s.items.length === 1 && s.items[0].changes.test?.[0] === '@type' && !s.items[0].changes.context, JSON.stringify(s.items));
  const c = compareRuleStructure({ format: 'SCH-DITA', xml: sch('@type') }, { format: 'SCH-DITA', xml: sch('@type', 'step/note') }, opts);
  check('Schematron: context change', c.items[0].changes.context?.join('→') === 'note→step/note');
  const same = compareRuleStructure({ format: 'SCH-DITA', xml: sch('@type') }, { format: 'SCH-DITA', xml: `<pattern id="p">\n  <rule context="note">\n    <assert id="a1" test="@type" role="error">Note needs a type.</assert>\n  </rule>\n</pattern>` }, opts);
  check('Schematron: prefixed and unprefixed with different layout are the same', same.status === 'compared' && !same.changed, JSON.stringify(same));
  const report = compareRuleStructure(
    { format: 'SCH-DITA', xml: sch('@type') },
    { format: 'SCH-DITA', xml: `${sch('@type')}<sch:pattern id="q"><sch:rule context="p"><sch:report id="r1" test="table">No tables.</sch:report></sch:rule></sch:pattern>` },
    opts,
  );
  check('Schematron: an added report', report.items.map((i) => i.kind).join(',') === 'same,added' && report.items[1].right.kind === 'report');
  check('Schematron vs BREX: formats differ', compareRuleStructure({ format: 'SCH-DITA', xml: sch('@type') }, { format: 'BREX-4.2', xml: brexRule(['1']) }, opts).status === 'formats_differ');
}

// ── Real template rules ──
{
  const rows42 = readPublicTemplate('brdp-template-4-2.xlsx');
  const rows41 = readPublicTemplate('brdp-template-4-1.xlsx');
  let allSelfEqual = true;
  for (const row of rows42) {
    if (!row.Rule) continue;
    const d = compareDetails({ rule_format: 'BREX-4.2', rule: { rule_xml: row.Rule, status: 'approved' } }, { rule_format: 'BREX-4.2', rule: { rule_xml: row.Rule, status: 'approved' } }, opts);
    if (d.rule.status !== 'equal' || d.rule.structure.status !== 'compared' || d.rule.structure.changed) allSelfEqual = false;
  }
  check('every 4.2 template rule compares equal with itself', allSelfEqual);
  const r42 = rows42.find((r) => r.ID === 'BRDP-S1-00219');
  const r41 = rows41.find((r) => r.ID === 'BRDP-S1-00219');
  const cross = compareRuleStructure({ format: 'BREX-4.2', xml: r42.Rule }, { format: 'BREX-4.1', xml: r41.Rule }, opts);
  check('S1-00219 4.2 vs 4.1: same structure (same family)', cross.status === 'compared' && !cross.changed, JSON.stringify(cross.items.map((i) => i.changes)));
  const ditaRows = readPublicTemplate('brdp-template-dita-xpath2.xlsx').filter((r) => r.Rule);
  let ditaOk = true;
  for (const row of ditaRows) {
    const s = compareRuleStructure({ format: 'SCH-DITA', xml: row.Rule }, { format: 'SCH-DITA', xml: row.Rule }, opts);
    if (s.status !== 'compared' || s.changed) ditaOk = false;
  }
  check('every DITA template rule compares equal with itself', ditaOk);
}

// ── Ask prompt with a BRDP of another project ──
{
  const brdp = { identifier: 'BRDP-S1-00052', title: 'Info codes', definition: 'D', proposal: 'P', validation: 'Validated' };
  const other = {
    source: 'other_project',
    projectName: 'Official Default 4.2',
    standard: 'S1000D 4.2',
    identifier: 'BRDP-S1-00052',
    title: 'Info codes',
    definition: 'Other definition',
    proposal: 'Other proposal',
    validation: 'Validated',
    ruleState: 'verified',
    ruleXml: RULE_A,
  };
  const prompt = buildAskSystemPrompt(brdp, null, other, 'S1000D 4.2', { available: false, notFound: [], wrongType: [] }, []);
  check('Ask: other-project source label', prompt.includes('BRDP being compared against (source: Project "Official Default 4.2" (S1000D 4.2)):'));
  check('Ask: other-project block has proposal and rule', prompt.includes('Proposal: Other proposal') && prompt.includes('Rule Status: Verified') && prompt.includes('//dmIdent/dmCode/@infoCode'));
  const records = buildAskSystemPrompt(brdp, null, { ...other, source: 'records' }, 'S1000D 4.2', { available: false, notFound: [], wrongType: [] }, []);
  check('Ask: records label unchanged', records.includes('(source: Records):'));
  const catalog = buildAskSystemPrompt(brdp, null, { source: 'catalog', identifier: 'X', title: 'T', definition: 'D' }, 'S1000D 4.2', { available: false, notFound: [], wrongType: [] }, []);
  check('Ask: catalog label unchanged, without proposal', catalog.includes('(source: Catalog):') && !catalog.split('source: Catalog')[1].includes('Proposal:'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
