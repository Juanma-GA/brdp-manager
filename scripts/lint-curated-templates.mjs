// Test de reglas T4b, Part 4: lint of the curated Excel templates
// (public/brdp-template-*.xlsx, the files "Download Excel template" serves
// and Suggest Rule uses as its last precedent group). For every rule of
// every template it asks the rule-test engine -- the same describeRule /
// analyzeRule the "Test rule" panel uses, no LLM -- and flags:
//   - cannot reject: the rule can reject no document (BREX flag 2 without
//     values; Schematron whose checks never fail -- only warning/info roles,
//     or a test that never looks at the document);
//   - "must not" but allowed: the rule's own text (BREX objectUse/objuse,
//     Schematron message) says "must not" / "shall not" / "no debe" … but
//     its semantics allow the node;
//   - not executable (whole rule) or partially executable, with the reason.
//     Reasons that are known and accepted -- the rule is right, the test
//     simply cannot run it here: another file (doc-available(), doc(),
//     document(): the DITA templates read the ditamap), a value replaced
//     outside the app (@@URI-CARPETA-DOSIER@@, filled in by an external
//     script) and a nonContextRule (a BREX rule with no XPath by design) --
//     go to a separate "Known and accepted" section and are not
//     counted as findings. So does an informative rule (Plantillas, Part 4):
//     BREX allowedObjectFlag="2" without values that does not say "must
//     not" -- it documents what is allowed and never rejects, as in the
//     default S1000D BREX; a boolean path (//a and //b) is a condition the
//     engine evaluates like s1kd-brexcheck, never "not a node path".
//   - not a rule of the format (C2, Part 0): what Paste rule, the manual
//     editor and PUT …/approvals/{format} would now refuse -- loose text, a
//     wrapper such as <rules>, or an element of another format.
// Output: one markdown table per template (rules with no finding are left
// out; a template with none says so). Exit code 0 always: the lint reports,
// it never fixes a template.
// Run: node scripts/lint-curated-templates.mjs
import { readPublicTemplate } from './lib/readXlsx.mjs';
import { CURATED_TEMPLATE_BY_STANDARD } from '../src/utils/excelUtils.js';
import { STANDARD_TO_RULE_FORMAT } from '../src/constants/ruleFormats.js';
import { escCell, lintRule } from './lib/ruleLint.mjs';

let total = 0;
const known = [];
for (const [standard, file] of Object.entries(CURATED_TEMPLATE_BY_STANDARD)) {
  const format = STANDARD_TO_RULE_FORMAT[standard];
  const rows = readPublicTemplate(file).filter((r) => String(r.Rule || '').trim());
  const lines = [];
  for (const row of rows) {
    for (const f of lintRule(String(row.Rule), format)) {
      const line = `| ${row.ID} | ${f.kind} | ${escCell(f.detail)} |`;
      if (f.known) known.push(`| ${file.slice(1)} |${line.slice(1)}`);
      else lines.push(line);
    }
  }
  total += lines.length;
  console.log(`\n### ${file.slice(1)} — ${standard} (${format}), ${rows.length} rules\n`);
  if (lines.length === 0) console.log('No findings.');
  else console.log(['| Rule | Finding | Detail |', '|---|---|---|', ...lines].join('\n'));
}
console.log('\n### Known and accepted (not counted)\n');
if (known.length === 0) console.log('None.');
else console.log(['| Template | Rule | Finding | Detail |', '|---|---|---|---|', ...known].join('\n'));
console.log(`\n${total} finding(s).`);
