// Lint of ONE rule (Barrido final 2/2): the checks that scripts/lint-curated-
// templates.mjs and backend/scripts/lint_stored_rules.py run over every
// stored rule, here as a pure module so the "Test rule" panel and the
// suggested / pasted rule show the same warnings while the rule is worked on
// (Part 2). Before this round the checks lived in scripts/lib/ruleLint.mjs,
// which is now a thin wrapper (English texts, xmldom) around this module.
//
// It asks the rule-test engine -- the same describeRule / analyzeRule the
// panel uses, no LLM -- and flags (code -> what the scripts call it):
//   - not_rule_format ("not a rule of the format"): what Paste rule, the
//     manual editor and PUT …/approvals/{format} would now refuse;
//   - multiple_paths ("more than one objectPath in a rule", Mejoras A): a
//     rule element with two objectPath / objectUse (invalid against the
//     BREX XSD; refused on save like the previous one);
//   - not_node_path ("not a node path"): the path returns a number or a
//     string instead of nodes. A path that returns true/false is a
//     condition, evaluated like s1kd-brexcheck -- not a finding;
//   - not_executable / partially_executable, with the engine's reason.
//     Reasons that are known and accepted (another file: doc-available(),
//     doc(), document(); a value replaced outside the app, @@…@@; a
//     nonContextRule) carry known: true -- listed apart, not counted;
//   - cannot_reject: the rule can reject no document. BREX flag 2 without
//     values that does not say "must not" is an informative rule
//     (informative, known: true), as in the default S1000D BREX;
//   - must_not_allowed ('"must not" but allowed'): the rule's own text says
//     "must not" / "no debe" … but its semantics allow the node;
//   - flag1_value_predicate ("flag 1 with a value predicate"):
//     allowedObjectFlag="1" / objappl="1" on a path whose last step filters
//     by the node's own value and no objectValue/objval -- only ONE node
//     with a good value has to exist, a bad one is never rejected (never for
//     a path that is a condition on the whole document);
//   - flag1_with_values ("flag 1 with values", Mejoras F, Part 2.2b, amber):
//     allowedObjectFlag="1" / objappl="1" WITH objectValue / objval --
//     validators do not agree: some require the value on every node of the
//     parent step, others only that the document have one such node (and
//     then reject a document without the parent at all). Forbidding the
//     opposite (flag 0 on parent[not(@a='v')]) means the same everywhere.
//     Real rules: BRDP-EXT-00001, 00086, 02772, BRDP-S1-00024;
//   - ancestor_depth ("count(ancestor::*) as depth"): counts every
//     ancestor, not how deep the element is nested;
//   - impossible_path ("path that cannot exist", Mejoras C): a step of the
//     path the standard's schemas never allow (<trade> inside <perscat>,
//     /techstd as a root) -- only with options.graph (the standard's
//     element graph); validation/rulePathCheck.js;
//   - duplicate_values ("duplicate allowed value", new this round): the same
//     value twice in one rule's list of allowed values -- BREX objectValue /
//     objval of one structureObjectRule / objrule, or a sequence of string
//     literals in an XPath ("@type = ('em01', 'em01')").
//
// Once per rule (Part 1): a rule with the same problem in three places --
// three structureObjectRules with the same flag-1 mistake, three statements
// that say "must not" -- gives ONE finding of that code, whose `items` keeps
// every place (the detail lists them all; `occurrences` is how many).
//
//   lintRuleFindings(ruleXml, format, { parseXml }) ->
//     [{ code, known, items: [params, …], occurrences }]
//   formatLintFinding(finding, t) -> { kind, detail }   (kind: the English
//     name the scripts print; detail: translated with t)
import { analyzeRule, describeRule, parseXmlDocument, pathGroups, ruleConditions } from './ruleTestEngine.js';
import { formatRuleStatement, formatRuleTestReason } from './ruleTestReasons.js';
import { wrapRuleXmlFragment } from './ruleXmlFragment.js';
import { checkRuleFormat, extractRuleXPaths, formatSchemaIssue, ruleFormatIssues } from '../validation/schemaValidation.js';
import { checkRulePaths, formatPathProblem } from '../validation/rulePathCheck.js';

// "Must not" wording, English and Spanish (the templates mix both).
const MUST_NOT_RE = /\b(must not|shall not|must be no|shall be no|should not|may not|cannot|can not|not allowed|forbidden|prohibited|no debe|no deben|no debe haber|no se (?:debe|deben|permite|permiten|puede|pueden|utiliza|utilizan|usa|usan)|prohibid[oa]s?)\b/i;

const LINT_KINDS = {
  not_rule_format: 'not a rule of the format',
  multiple_paths: 'more than one objectPath in a rule',
  not_node_path: 'not a node path',
  not_executable: 'not executable',
  partially_executable: 'partially executable',
  informative: 'informative rule (flag 2)',
  cannot_reject: 'cannot reject',
  must_not_allowed: '"must not" but allowed',
  flag1_value_predicate: 'flag 1 with a value predicate',
  flag1_with_values: 'flag 1 with values',
  ancestor_depth: 'count(ancestor::*) as depth',
  duplicate_values: 'duplicate allowed value',
  impossible_path: 'path that cannot exist',
};

// The findings the lint scripts are the only place to show before this
// round: the "Test rule" panel already shows executability (analyzeRule)
// and "cannot reject" (describeRule), the suggestion panel the rule format.
// `panel`: what RuleTestPanel adds; `suggestion`: what the suggested /
// pasted rule adds (it shows no description, so "cannot reject" too).
// Warnings shown amber, not red: the rule is not wrong, but validators
// may read it differently (Mejoras F, Part 2.2b).
const AMBER_CODES = new Set(['flag1_with_values']);

const LINT_CODES_FOR = {
  panel: ['must_not_allowed', 'flag1_value_predicate', 'flag1_with_values', 'ancestor_depth', 'duplicate_values'],
  suggestion: ['cannot_reject', 'must_not_allowed', 'flag1_value_predicate', 'flag1_with_values', 'ancestor_depth', 'duplicate_values'],
};

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

function ruleDocument(ruleXml, parseXml) {
  try {
    return parseXml(wrapRuleXmlFragment(String(ruleXml || '')));
  } catch {
    return null;
  }
}

// BREX rule elements: id (the way describeRule keys a rule: @id, else
// brDecisionRef/@brDecisionIdentNumber, else "rule N"), flag, path, the
// objectUse/objuse text and the allowed values.
function brexRules(doc) {
  if (!doc) return [];
  // Mejoras A, Part 3: one entry per path (a rule element with two
  // objectPath is checked on both, never only the first), each with the
  // use and values written after it.
  return descendants(doc.documentElement, ['structureObjectRule', 'objrule']).flatMap((el, i) => {
    const is301 = localName(el) === 'objrule';
    const spec = is301
      ? { path: 'objpath', use: 'objuse', value: 'objval' }
      : { path: 'objectPath', use: 'objectUse', value: 'objectValue' };
    const ref = descendants(el, ['brDecisionRef'])[0];
    const baseId = el.getAttribute('id') || ref?.getAttribute('brDecisionIdentNumber') || `rule ${i + 1}`;
    const groups = pathGroups(el, spec);
    return (groups.length ? groups : [{ path: null, use: null, values: [] }]).map((g) => ({
      id: baseId,
      flag: g.path?.getAttribute(is301 ? 'objappl' : 'allowedObjectFlag') || '',
      flagAttr: is301 ? 'objappl' : 'allowedObjectFlag',
      valueElement: spec.value,
      path: (g.path?.textContent || '').trim(),
      use: textOf(g.use),
      values: g.values.map((v) =>
        is301
          ? { form: v.getAttribute('valtype') || 'single', value: [v.getAttribute('val1') || '', v.getAttribute('val2') || ''].filter(Boolean).join('~') }
          : { form: v.getAttribute('valueForm') || 'single', value: v.getAttribute('valueAllowed') || '' },
      ),
    }));
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
const normalizeSpace = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// A parenthesised sequence of two or more string literals: ('a', 'b', "c").
const LITERAL_SEQUENCE_RE = /\(\s*((?:"[^"]*"|'[^']*')(?:\s*,\s*(?:"[^"]*"|'[^']*'))+)\s*\)/g;
const LITERAL_RE = /"([^"]*)"|'([^']*)'/g;

// Values listed more than once: [{ value, count }], in first-seen order.
function repeated(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([value, count]) => ({ value, count }));
}

function duplicateValueItems(rules, xpaths) {
  const items = [];
  for (const rule of rules) {
    // Same form AND same value: "em01" single twice. A range and a single
    // with the same text are different checks.
    const keyed = rule.values.map((v) => `${v.form}\u0000${v.value}`);
    const dups = repeated(keyed).map(({ value, count }) => ({ value: value.split('\u0000')[1], count }));
    if (dups.length) items.push({ where: rule.id, duplicates: dups });
  }
  for (const xpath of xpaths) {
    LITERAL_SEQUENCE_RE.lastIndex = 0;
    let m;
    while ((m = LITERAL_SEQUENCE_RE.exec(xpath))) {
      const literals = [...m[1].matchAll(LITERAL_RE)].map((l) => l[1] ?? l[2]);
      const dups = repeated(literals);
      if (dups.length) items.push({ where: `"${clip(normalizeSpace(m[0]), 80)}"`, duplicates: dups });
    }
  }
  return items;
}

const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const KNOWN_REASON_CODES = new Set(['external_document', 'external_placeholder', 'non_context_rule']);
function isKnownReason(reason) {
  if (!reason) return false;
  if (reason.code === 'parts') return (reason.params?.parts || []).every((p) => isKnownReason(p.reason));
  return KNOWN_REASON_CODES.has(reason.code);
}
const pathNotNodes = (reason) =>
  reason?.code === 'path_not_nodes' || (reason?.code === 'parts' && (reason.params?.parts || []).some((p) => pathNotNodes(p.reason)));

const statementOf = (s) => ({ statement: s.statement, schemas: s.schemas });

// Every occurrence, before grouping: [{ code, known, params }].
function occurrences(ruleXml, format, parseXml) {
  const out = [];
  const add = (code, params, known = false) => out.push({ code, known, params });
  // Mejoras A, Part 3: a rule element with two objectPath (or objectUse)
  // is its own finding, not a generic "not a rule of the format".
  for (const issue of ruleFormatIssues(checkRuleFormat(ruleXml, format))) {
    add(issue.code === 'rule_format_multiple' ? 'multiple_paths' : 'not_rule_format', { issue });
  }

  const analysis = analyzeRule(ruleXml, format, { parseXml });
  if (analysis.status === 'not_executable' && pathNotNodes(analysis.reason)) add('not_node_path', { reason: analysis.reason });
  else if (analysis.status === 'not_executable') add('not_executable', { reason: analysis.reason }, isKnownReason(analysis.reason));
  else if (analysis.status === 'partial') add('partially_executable', { reason: analysis.reason }, isKnownReason(analysis.reason));

  const isSchematron = format === 'SCH-DITA';
  const doc = ruleDocument(ruleXml, parseXml);
  const rules = isSchematron ? [] : brexRules(doc);
  const texts = {};
  for (const r of rules) texts[r.id] = texts[r.id] ? `${texts[r.id]} ${r.use}` : r.use;
  const description = describeRule(ruleXml, format, { parseXml });
  const informativeCodes = new Set(['describe_allowed', 'describe_condition_informative']);
  const saysMustNot = (s) => MUST_NOT_RE.test(s.ruleIds.map((id) => texts[id] || '').join(' '));
  const informative =
    description.available &&
    description.cannotReject &&
    !isSchematron &&
    description.statements.some((s) => informativeCodes.has(s.statement.code)) &&
    !description.statements.some((s) => informativeCodes.has(s.statement.code) && saysMustNot(s));
  if (informative) {
    for (const s of description.statements.filter((x) => informativeCodes.has(x.statement.code))) add('informative', statementOf(s), true);
  } else if (description.available && description.cannotReject) {
    const allowed = description.statements.filter((s) =>
      ['describe_allowed', 'describe_condition_informative', 'describe_sch_assert', 'describe_sch_report'].includes(s.statement.code),
    );
    if (allowed.length === 0) add('cannot_reject', {});
    for (const s of allowed) add('cannot_reject', statementOf(s));
  }
  if (description.available) {
    for (const s of description.statements) {
      const { code, params } = s.statement;
      let says = '';
      if (informativeCodes.has(code)) says = s.ruleIds.map((id) => texts[id] || '').join(' ');
      else if ((code === 'describe_sch_assert' || code === 'describe_sch_report') && (params.warning || params.constant)) says = params.message || '';
      if (says && MUST_NOT_RE.test(says)) add('must_not_allowed', { ruleIds: s.ruleIds, says: clip(says), ...statementOf(s) });
    }
  }

  if (!isSchematron) {
    const conditionPaths = new Set(ruleConditions(ruleXml, format, { parseXml }).map((c) => normalizeSpace(c.path)));
    for (const rule of rules) {
      if (conditionPaths.has(normalizeSpace(rule.path))) continue;
      if (rule.flag === '1' && rule.values.length === 0 && lastStepPredicates(rule.path).some(filtersByOwnValue)) {
        add('flag1_value_predicate', { id: rule.id, attr: rule.flagAttr, path: clip(rule.path), valueElement: rule.valueElement });
      }
      if (rule.flag === '1' && rule.values.length > 0) add('flag1_with_values', flag1WithValuesParams(rule));
    }
  }
  const xpaths = extractRuleXPaths(ruleXml);
  for (const xp of xpaths.filter((x) => ANCESTOR_WILDCARD_RE.test(x))) add('ancestor_depth', { path: clip(xp) });
  for (const item of duplicateValueItems(rules, xpaths)) add('duplicate_values', item);
  return out;
}

// Mejoras F, Part 2.2b: the parent step and the target of a flag-1 path
// with values (/dmodule/content//tbody/row/@rowsep → row, @rowsep) and the
// opposite to forbid -- only for single values.
function flag1WithValuesParams(rule) {
  const stripped = String(rule.path || '').replace(/\[[^\]]*\]/g, '');
  const steps = stripped.split(/\/+/).map((st) => st.trim()).filter(Boolean);
  const last = steps[steps.length - 1] || '';
  const before = steps[steps.length - 2] || '';
  const target = last.startsWith('@') ? last : `<${last}>`;
  const parent = before && /^[A-Za-z_][\w.-]*$/.test(before) ? before : null;
  const singles = rule.values.every((v) => v.form === 'single') ? rule.values.map((v) => v.value) : null;
  const test = last.replace(/^@/, '@');
  const fix =
    parent && singles?.length
      ? `${parent}[not(${singles.map((v) => `${test}='${v}'`).join(' or ')})]`
      : null;
  return { id: rule.id, attr: rule.flagAttr, path: clip(rule.path), parent: parent ? `<${parent}>` : null, target, fix };
}

export function lintRuleFindings(ruleXml, format, options = {}) {
  const parseXml = options.parseXml || parseXmlDocument;
  const grouped = new Map();
  const found = occurrences(String(ruleXml || ''), format, parseXml);
  if (options.graph) {
    for (const problem of checkRulePaths(String(ruleXml || ''), format, options.graph, { parseXml, schemaLocation: options.schemaLocation || null }).problems) {
      found.push({ code: 'impossible_path', known: false, params: { problem, format } });
    }
  }
  for (const o of found) {
    const key = `${o.code}\u0000${o.known}`;
    if (!grouped.has(key)) grouped.set(key, { code: o.code, known: o.known, items: [], occurrences: 0 });
    const g = grouped.get(key);
    g.occurrences += 1;
    // The same place reported twice (two identical statements) is one item.
    if (!g.items.some((it) => JSON.stringify(it) === JSON.stringify(o.params))) g.items.push(o.params);
  }
  return [...grouped.values()];
}

function formatItem(code, params, t) {
  const k = (key, values) => t(`records.ruleLint.details.${key}`, values);
  const statement = () => formatRuleStatement(params.statement, params.schemas, t);
  switch (code) {
    case 'not_rule_format':
    case 'multiple_paths':
      return formatSchemaIssue(params.issue, t);
    case 'not_node_path':
    case 'not_executable':
    case 'partially_executable':
      return formatRuleTestReason(params.reason, t);
    case 'informative':
    case 'cannot_reject':
      return params.statement ? statement() : '';
    case 'must_not_allowed':
      return k('mustNotAllowed', { ids: params.ruleIds.join(', '), says: params.says, statement: statement() });
    case 'flag1_value_predicate':
      return k('flag1ValuePredicate', params);
    case 'flag1_with_values':
      return params.parent
        ? `${k('flag1WithValues', params)}${params.fix ? k('flag1WithValuesFix', params) : ''}`
        : k('flag1WithValuesNoParent', params);
    case 'ancestor_depth':
      return k('ancestorDepth', params);
    case 'impossible_path':
      return formatPathProblem(params.problem, t, { format: params.format });
    case 'duplicate_values':
      return k('duplicateValues', {
        where: params.where,
        values: params.duplicates.map((d) => k('duplicateValue', { value: d.value, count: d.count })).join(', '),
      });
    default:
      return '';
  }
}

export function formatLintFinding(finding, t) {
  const items = [...new Set(finding.items.map((p) => formatItem(finding.code, p, t)).filter(Boolean))];
  let detail = items.join(' / ');
  if (finding.code === 'informative') detail = t('records.ruleLint.details.informative', { statements: detail });
  else if (finding.code === 'cannot_reject' && !detail) detail = t('records.ruleLint.details.noCheckCanFail');
  return { kind: LINT_KINDS[finding.code] || finding.code, detail };
}

// The warnings one place of the interface adds (LINT_CODES_FOR), each with
// its translated title and detail -- never blocking.
export function lintWarnings(ruleXml, format, place, t, options = {}) {
  if (!ruleXml || !format) return [];
  let findings;
  try {
    findings = lintRuleFindings(ruleXml, format, options);
  } catch {
    return [];
  }
  return findings
    .filter((f) => !f.known && LINT_CODES_FOR[place].includes(f.code))
    .map((f) => ({ code: f.code, title: t(`records.ruleLint.titles.${f.code}`), detail: formatLintFinding(f, t).detail, amber: AMBER_CODES.has(f.code) }));
}
