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
//   - not a rule of the format (C2, Part 0): what Paste rule, the manual
//     editor and PUT …/approvals/{format} would now refuse -- loose text, a
//     wrapper such as <rules>, or an element of another format.
// Output: one markdown table per template (rules with no finding are left
// out; a template with none says so). Exit code 0 always: the lint reports,
// it never fixes a template.
// Run: node scripts/lint-curated-templates.mjs
import fs from 'node:fs';
import XLSX from 'xlsx';
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../src/i18n/index.js';
import { CURATED_TEMPLATE_BY_STANDARD } from '../src/utils/excelUtils.js';
import { STANDARD_TO_RULE_FORMAT } from '../src/constants/ruleFormats.js';
import { analyzeRule, describeRule } from '../src/utils/ruleTestEngine.js';
import { formatRuleStatement, formatRuleTestReason } from '../src/utils/ruleTestReasons.js';
import { checkRuleFormat, formatSchemaIssue, ruleFormatIssues } from '../src/validation/schemaValidation.js';

function parseXml(text) {
  const messages = [];
  const doc = new DOMParser({ errorHandler: (_l, msg) => messages.push(msg) }).parseFromString(text, 'text/xml');
  if (messages.length) throw new Error(messages[0].replace(/^\[xmldom \w+\]\s*/, '').split('\n')[0]);
  return doc;
}
const t = i18n.getFixedT('en');

// "Must not" wording, English and Spanish (the templates mix both).
const MUST_NOT_RE = /\b(must not|shall not|must be no|shall be no|should not|may not|cannot|can not|not allowed|forbidden|prohibited|no debe|no deben|no debe haber|no se (?:debe|deben|permite|permiten|puede|pueden|utiliza|utilizan|usa|usan)|prohibid[oa]s?)\b/i;

const localName = (el) => el.localName || el.nodeName.replace(/^.*:/, '');
const textOf = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
function descendants(node, names) {
  const out = [];
  const walk = (n) => {
    for (const c of Array.from(n.childNodes || [])) {
      if (c.nodeType !== 1) continue;
      if (names.includes(localName(c))) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

// The rule's own "what it says" text, per rule id: BREX objectUse/objuse,
// Schematron assert/report messages. Keyed the way describeRule keys its
// statements (@id, else brDecisionRef/@brDecisionIdentNumber, else "rule N").
function ruleTexts(ruleXml) {
  let doc;
  try {
    doc = parseXml(`<root>${ruleXml}</root>`.replace(/<root>/, `<root ${namespaceDecls(ruleXml)}>`));
  } catch {
    return {};
  }
  const out = {};
  descendants(doc.documentElement, ['structureObjectRule', 'objrule']).forEach((el, i) => {
    const ref = descendants(el, ['brDecisionRef'])[0];
    const id = el.getAttribute('id') || ref?.getAttribute('brDecisionIdentNumber') || `rule ${i + 1}`;
    out[id] = textOf(descendants(el, ['objectUse', 'objuse'])[0]);
  });
  return out;
}
function namespaceDecls(xml) {
  const prefixes = new Set([...xml.matchAll(/<\/?([A-Za-z_][\w.-]*):/g)].map((m) => m[1]));
  return [...prefixes].map((p) => `xmlns:${p}="urn:lint:${p}"`).join(' ');
}

const escCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function lintRule(ruleXml, format) {
  const findings = [];
  // C2, Part 0: the same check Paste rule, the manual editor and
  // PUT …/approvals/{format} apply -- a row the import stored as it was
  // would now be refused if saved from the interface.
  for (const issue of ruleFormatIssues(checkRuleFormat(ruleXml, format))) {
    findings.push({ kind: 'not a rule of the format', detail: formatSchemaIssue(issue, t) });
  }
  const analysis = analyzeRule(ruleXml, format, { parseXml });
  if (analysis.status === 'not_executable') {
    findings.push({ kind: 'not executable', detail: formatRuleTestReason(analysis.reason, t) });
  } else if (analysis.status === 'partial') {
    findings.push({ kind: 'partially executable', detail: formatRuleTestReason(analysis.reason, t) });
  }
  const description = describeRule(ruleXml, format, { parseXml });
  if (description.available && description.cannotReject) {
    const allowed = description.statements
      .filter((s) => ['describe_allowed', 'describe_sch_assert', 'describe_sch_report'].includes(s.statement.code))
      .map((s) => formatRuleStatement(s.statement, s.schemas, t))
      .filter(Boolean);
    findings.push({ kind: 'cannot reject', detail: allowed.join(' / ') || 'no check can fail' });
  }
  if (description.available) {
    const texts = format === 'SCH-DITA' ? {} : ruleTexts(ruleXml);
    for (const s of description.statements) {
      const { code, params } = s.statement;
      let says = '';
      if (code === 'describe_allowed') says = s.ruleIds.map((id) => texts[id] || '').join(' ');
      else if ((code === 'describe_sch_assert' || code === 'describe_sch_report') && (params.warning || params.constant)) says = params.message || '';
      if (says && MUST_NOT_RE.test(says)) {
        findings.push({ kind: '"must not" but allowed', detail: `${s.ruleIds.join(', ')}: says "${clip(says)}" — ${formatRuleStatement(s.statement, s.schemas, t)}` });
      }
    }
  }
  return findings;
}

let total = 0;
for (const [standard, file] of Object.entries(CURATED_TEMPLATE_BY_STANDARD)) {
  const format = STANDARD_TO_RULE_FORMAT[standard];
  const wb = XLSX.read(fs.readFileSync(new URL(`../public${file}`, import.meta.url)));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).filter((r) => String(r.Rule || '').trim());
  const lines = [];
  for (const row of rows) {
    for (const f of lintRule(String(row.Rule), format)) lines.push(`| ${row.ID} | ${f.kind} | ${escCell(f.detail)} |`);
  }
  total += lines.length;
  console.log(`\n### ${file.slice(1)} — ${standard} (${format}), ${rows.length} rules\n`);
  if (lines.length === 0) console.log('No findings.');
  else console.log(['| Rule | Finding | Detail |', '|---|---|---|', ...lines].join('\n'));
}
console.log(`\n${total} finding(s).`);
