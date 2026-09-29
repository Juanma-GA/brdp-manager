// Lint of ONE stored rule, shared by scripts/lint-curated-templates.mjs (the
// curated Excel templates) and scripts/lint-rules-stdin.mjs (the rules stored
// in the database, behind backend/scripts/lint_stored_rules.py). It asks the
// rule-test engine -- the same describeRule / analyzeRule the "Test rule"
// panel uses, no LLM -- and flags:
//   - not a rule of the format: what Paste rule, the manual editor and
//     PUT …/approvals/{format} would now refuse (C2, Part 0);
//   - not a node path: the path returns true/false (or a number) instead of
//     nodes, e.g. //a and //b;
//   - not executable (whole rule) or partially executable, with the reason.
//     Reasons that are known and accepted (another file: doc-available(),
//     doc(), document(); a value replaced outside the app, @@…@@; a
//     nonContextRule, no XPath by design) carry known: true -- the callers
//     list them apart and do not count them;
//   - cannot reject: the rule can reject no document (BREX flag 2 without
//     values; Schematron whose checks never fail);
//   - "must not" but allowed: the rule's own text says "must not" / "no
//     debe" … but its semantics allow the node;
//   - flag 1 with a value predicate: allowedObjectFlag="1" / objappl="1" on a
//     path whose last step filters by the node's value
//     (//@assyCode[matches(., …)]) and no objectValue/objval -- the rule only
//     requires that ONE node with a good value exists, so a node with a bad
//     value is never rejected (a real Lufthansa pattern);
//   - count(ancestor::*) as depth: counts every ancestor (dmodule, content,
//     …), not how deep the element is nested (a real Lufthansa pattern).
//
//   lintRule(ruleXml, format) -> [{ kind, detail, known? }]
import { DOMParser } from '@xmldom/xmldom';
import i18n from '../../src/i18n/index.js';
import { analyzeRule, describeRule } from '../../src/utils/ruleTestEngine.js';
import { formatRuleStatement, formatRuleTestReason } from '../../src/utils/ruleTestReasons.js';
import { checkRuleFormat, extractRuleXPaths, formatSchemaIssue, ruleFormatIssues } from '../../src/validation/schemaValidation.js';

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

export const escCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const KNOWN_REASON_CODES = new Set(['external_document', 'external_placeholder', 'non_context_rule']);
function isKnownReason(reason) {
  if (!reason) return false;
  if (reason.code === 'parts') return (reason.params?.parts || []).every((p) => isKnownReason(p.reason));
  return KNOWN_REASON_CODES.has(reason.code);
}

// BREX rule elements with their flag and path, for the two Lufthansa
// patterns below. id: the way describeRule keys a rule (@id, else
// brDecisionRef/@brDecisionIdentNumber, else "rule N").
function brexRules(ruleXml) {
  let doc;
  try {
    doc = parseXml(`<root ${namespaceDecls(ruleXml)}>${ruleXml}</root>`);
  } catch {
    return [];
  }
  return descendants(doc.documentElement, ['structureObjectRule', 'objrule']).map((el, i) => {
    const is301 = localName(el) === 'objrule';
    const pathEl = descendants(el, [is301 ? 'objpath' : 'objectPath'])[0];
    const ref = descendants(el, ['brDecisionRef'])[0];
    return {
      id: el.getAttribute('id') || ref?.getAttribute('brDecisionIdentNumber') || `rule ${i + 1}`,
      flag: pathEl?.getAttribute(is301 ? 'objappl' : 'allowedObjectFlag') || '',
      flagAttr: is301 ? 'objappl' : 'allowedObjectFlag',
      path: (pathEl?.textContent || '').trim(),
      hasValues: descendants(el, [is301 ? 'objval' : 'objectValue']).length > 0,
    };
  });
}

// Top-level pieces of an XPath: split on `sep` outside quotes, [] and ().
function splitTopLevel(expr, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && expr.startsWith(sep, i)) {
      out.push(expr.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(expr.slice(start));
  return out;
}

// Predicates written on the LAST step of each alternative of the path.
function lastStepPredicates(path) {
  const preds = [];
  for (const alternative of splitTopLevel(path, '|')) {
    const steps = splitTopLevel(alternative.trim(), '/');
    const last = steps[steps.length - 1] || '';
    let depth = 0;
    let quote = null;
    let open = -1;
    for (let i = 0; i < last.length; i++) {
      const c = last[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') {
        if (depth === 0) open = i;
        depth++;
      } else if (c === ']') {
        depth--;
        if (depth === 0 && open >= 0) preds.push(last.slice(open + 1, i));
      }
    }
  }
  return preds;
}

// A predicate that filters by the node's OWN value: a value function applied
// to "." (or with no argument) or "." compared with something. A predicate on
// children or other attributes (//para[@id], //dmCode[@infoCode = '040'])
// does not count.
const VALUE_FUNCTION_RE = /\b(?:matches|string-length|starts-with|ends-with|contains|normalize-space|number|substring|string|translate|upper-case|lower-case)\s*\(\s*(?:\.(?![\w./])|\))/;
const SELF_COMPARISON_RE = /(?:^|[\s(,])\.\s*(?:!=|<=|>=|=|<|>|\b(?:eq|ne|lt|le|gt|ge)\b)|(?:!=|<=|>=|=|<|>|\b(?:eq|ne|lt|le|gt|ge)\b)\s*\.(?![\w./])/;
function filtersByOwnValue(predicate) {
  const text = predicate.replace(/"[^"]*"|'[^']*'/g, '""');
  return VALUE_FUNCTION_RE.test(text) || SELF_COMPARISON_RE.test(text);
}

const ANCESTOR_WILDCARD_RE = /\bcount\s*\(\s*ancestor(?:-or-self)?::(?:\*|node\s*\(\s*\))/;

function lufthansaPatterns(ruleXml, format) {
  const findings = [];
  if (format !== 'SCH-DITA') {
    for (const rule of brexRules(ruleXml)) {
      if (rule.flag === '1' && !rule.hasValues && lastStepPredicates(rule.path).some(filtersByOwnValue)) {
        findings.push({
          kind: 'flag 1 with a value predicate',
          detail: `${rule.id}: ${rule.flagAttr}="1" on "${clip(rule.path)}" only requires ONE node with such a value to exist; a node with any other value is never rejected. Use flag 0 with the opposite predicate, or a value check (${format === 'BREX-3.0.1' ? 'objval' : 'objectValue'}).`,
        });
      }
    }
  }
  const depthPaths = extractRuleXPaths(ruleXml).filter((xp) => ANCESTOR_WILDCARD_RE.test(xp));
  if (depthPaths.length) {
    findings.push({
      kind: 'count(ancestor::*) as depth',
      detail: `"${clip(depthPaths[0])}" counts every ancestor (the document root, content, …), not how deep the element is nested; count only the nested element, e.g. count(ancestor-or-self::proceduralStep).`,
    });
  }
  return findings;
}

export function lintRule(ruleXml, format) {
  const findings = [];
  // C2, Part 0: the same check Paste rule, the manual editor and
  // PUT …/approvals/{format} apply -- a row the import stored as it was
  // would now be refused if saved from the interface.
  for (const issue of ruleFormatIssues(checkRuleFormat(ruleXml, format))) {
    findings.push({ kind: 'not a rule of the format', detail: formatSchemaIssue(issue, t) });
  }
  const analysis = analyzeRule(ruleXml, format, { parseXml });
  // A path that returns true/false (or a number) instead of nodes gets its
  // own name: it is a mistake in the rule, never a limit of the test.
  const pathNotNodes = (reason) =>
    reason?.code === 'path_not_nodes' || (reason?.code === 'parts' && (reason.params?.parts || []).some((p) => pathNotNodes(p.reason)));
  if (analysis.status === 'not_executable' && pathNotNodes(analysis.reason)) {
    findings.push({ kind: 'not a node path', detail: formatRuleTestReason(analysis.reason, t) });
  } else if (analysis.status === 'not_executable') {
    findings.push({ kind: 'not executable', detail: formatRuleTestReason(analysis.reason, t), known: isKnownReason(analysis.reason) });
  } else if (analysis.status === 'partial') {
    findings.push({ kind: 'partially executable', detail: formatRuleTestReason(analysis.reason, t), known: isKnownReason(analysis.reason) });
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
  findings.push(...lufthansaPatterns(ruleXml, format));
  return findings;
}

