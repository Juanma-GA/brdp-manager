// src/utils/ruleWrappers.js against the cases shared with its Python twin
// (backend/tests/fixtures/rule_wrapper_cases.json; pytest runs the same file
// in backend/tests/test_rule_wrappers.py), plus how Generate takes a joined
// set of rules apart (generateBREX41/301 split the rules of every approved
// BRDP joined by line breaks).
//
//     node scripts/test-rule-wrappers.mjs
import fs from 'node:fs';
import { splitRuleXmlPieces, unwrapRuleXml } from '../src/utils/ruleWrappers.js';
import { checkRuleFormat } from '../src/validation/schemaValidation.js';

let failures = 0;
let passed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const { cases } = JSON.parse(fs.readFileSync(new URL('../backend/tests/fixtures/rule_wrapper_cases.json', import.meta.url), 'utf8'));
for (const c of cases) {
  const { xml, changed } = unwrapRuleXml(c.input, c.format);
  check(`${c.name}: changed`, changed === c.changed, `${changed}`);
  check(`${c.name}: text`, xml === c.expected, xml);
  const pieces = splitRuleXmlPieces(c.input, c.format);
  const got = pieces === null ? null : pieces.map((p) => ({ kind: p.kind, text: p.text }));
  check(`${c.name}: pieces`, JSON.stringify(got) === JSON.stringify(c.pieces), JSON.stringify(got));
  if (changed) check(`${c.name}: cleaned rule passes the format check`, checkRuleFormat(xml, c.format).ok);
}

// Generate joins every approved rule and takes the whole text apart: the two
// real wrapped rules and the clean one give their rules and blocks, and the
// same pieces before and after cleaning.
const real = Object.fromEntries(cases.filter((c) => c.name.startsWith('real ')).map((c) => [c.name.split(':')[0].replace('real ', ''), c]));
const before = [real['BRDP-S1-00507'].input, real['BRDP-S1-00070'].input, real['BRDP-S1-00006'].input].join('\n');
const after = [real['BRDP-S1-00507'].expected, real['BRDP-S1-00070'].expected, real['BRDP-S1-00006'].expected].join('\n');
const kinds = (text) => splitRuleXmlPieces(text, 'BREX-4.2').map((p) => p.kind).join(',');
check('Generate: kinds of the joined real rules', kinds(before) === 'rule,noncontext,rule,rule,rule,block,block,block', kinds(before));
check(
  'Generate: same pieces before and after cleaning',
  JSON.stringify(splitRuleXmlPieces(before, 'BREX-4.2').map((p) => p.text)) === JSON.stringify(splitRuleXmlPieces(after, 'BREX-4.2').map((p) => p.text))
);
// Rules inside a context block are never taken again as loose rules.
check('Generate: block rules not repeated', splitRuleXmlPieces(real['BRDP-S1-00006'].input, 'BREX-4.2').filter((p) => p.kind === 'rule').length === 1);
// A self-closing rule and a prefixed name.
check('self-closing structureObjectRule', kinds('<rules><structureObjectRule/></rules>') === 'rule');
check('SCH-DITA: no split', splitRuleXmlPieces('<sch:pattern/>', 'SCH-DITA') === null);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
