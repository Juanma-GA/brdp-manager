// Test de reglas T3, Part 0: the reasons of the rule test as codes. The
// engine (ruleTestEngine.js: runRuleOnFragment, analyzeRule) returns
// { code, params } instead of an English sentence, and the recorded test
// result (rule_approvals.last_test_reason) stores the same object, so the
// panel, the Rule Status indicator, the Verify dialog and History all show
// it in the viewer's language -- switching the interface language changes
// the text of a reason recorded earlier. Pure module: the Node tests pass
// the real i18n `t` (i18n.getFixedT('en' | 'es')).
//
// Reason codes (text: records.ruleTest.reasons.<code>, EN/ES):
//   engine (T1/T2b): external_document {fn}, non_context_rule,
//     mandatory_whole_document, xpath_error {message},
//     unsupported_value_form {form}, unsupported_format {format},
//     fragment_not_well_formed {message}, rule_not_well_formed {message},
//     no_rule_element {element}, empty_path {element},
//     invalid_flag {attr, value, allowed}, path_not_nodes {kind},
//     absolute_root {name, root}, schema_unknown {schema},
//     empty_schema_context {element, attr} (a context block with an empty
//     rulesContext/context: s1kd-brexcheck applies it to no schema),
//     missing_value {element, attr}, bad_range {text},
//     mixed_range {from, to};
//   Schematron engine (T4): extension_function {name},
//     sch_unsupported {feature}, sch_missing_attribute {element, attr};
//   both engines (T4b): external_placeholder {placeholder} ('@@…@@'
//     replaced by the project's tooling after Generate);
//     analyzeRule warning (never a refusal): xpath3_syntax {features};
//   the rule test's setup (rule test on DM metadata): unreachable_target
//     {names} -- no document the examples can be built on can contain what
//     the rule looks at (known before any LLM call); section_unavailable
//     {names, schemas} -- what the rule looks at lives only in the
//     identification and status section of a document the application does
//     not build it for yet (comment, …), so that schema is not offered;
//     example_impossible {element, other, axis, inside, standard} (Mejoras
//     A, Part 2) -- the rule's checked element must (not) be inside another
//     one, and no schema of the standard allows one of the two examples;
//   analyzeRule (C3): rule_format {problem, ...params} -- the stored XML is
//     not a rule of its format; `problem` is checkRuleFormat's code
//     (rule_format_missing, …), shown with the same text as on save;
//   several parts: parts {parts: [{ ruleId, reason }]};
//   recorded verdicts (verdictToTestRecord below): test_incorrect
//     {permissive, strict}, test_nothing_selected, test_missing_expectation,
//     test_no_runnable, test_proposal_mismatch {mismatch},
//     test_proposal_unchecked {error} (Barrido final 1/2),
//     test_impossible_path {format, problems} (Mejoras C, Part 1: every
//     path of the rule cannot exist in the standard; validation/
//     rulePathCheck.js's problems, formatted with formatPathProblem).

import { formatSchemaIssue } from '../validation/schemaValidation.js';
import { formatPathProblem } from '../validation/rulePathCheck.js';

export const ENGINE_REASON_CODES = [
  'external_document', 'non_context_rule', 'mandatory_whole_document', 'xpath_error', 'unsupported_value_form',
  'unsupported_format', 'fragment_not_well_formed', 'rule_not_well_formed', 'no_rule_element', 'empty_path',
  'invalid_flag', 'path_not_nodes', 'absolute_root', 'schema_unknown', 'missing_value', 'bad_range', 'mixed_range',
  'extension_function', 'sch_unsupported', 'sch_missing_attribute', 'xpath3_syntax', 'external_placeholder',
  'rule_format', 'unreachable_target', 'section_unavailable', 'empty_schema_context', 'example_impossible',
];
export const VERDICT_REASON_CODES = ['test_impossible_path', 'test_incorrect', 'test_nothing_selected', 'test_missing_expectation', 'test_no_runnable', 'test_proposal_mismatch', 'test_proposal_unchecked', 'test_threshold_mismatch'];

// A reason as text in the language of `t`. Unknown codes (a newer build's
// reason read by an older one) fall back to the code itself, never to "".
export function formatRuleTestReason(reason, t) {
  if (!reason || !reason.code) return '';
  const params = reason.params || {};
  if (reason.code === 'parts') {
    return (params.parts || [])
      .map((p) => t('records.ruleTest.reasons.part', { ruleId: p.ruleId, reason: formatRuleTestReason(p.reason, t) }))
      .join(' ');
  }
  if (reason.code === 'test_incorrect') {
    const which = params.permissive && params.strict ? 'both' : params.permissive ? 'permissive' : 'strict';
    return t(`records.ruleTest.reasons.test_incorrect.${which}`);
  }
  if (reason.code === 'test_threshold_mismatch') {
    return t('records.ruleTest.reasons.test_threshold_mismatch', { detail: formatThresholdMismatch(params, t) || '' });
  }
  if (reason.code === 'test_impossible_path') {
    return (params.problems || []).map((p) => formatPathProblem(p, t, { format: params.format })).join(' ');
  }
  if (reason.code === 'rule_format') {
    const { problem, ...problemParams } = params;
    const detail = formatSchemaIssue({ source: 'rule', code: problem, params: problemParams }, t);
    return t('records.ruleTest.reasons.rule_format', { detail, defaultValue: detail });
  }
  if (reason.code === 'example_impossible') {
    const where = `${params.axis === 'parent' ? 'parent' : 'ancestor'}${params.inside ? 'Inside' : 'Outside'}`;
    return t(`records.ruleTest.reasons.example_impossible.${where}`, { ...params, defaultValue: reason.code });
  }
  const values = { ...params };
  if (reason.code === 'path_not_nodes') values.kind = t(`records.ruleTest.reasons.valueKinds.${params.kind}`, { defaultValue: params.kind });
  return t(`records.ruleTest.reasons.${reason.code}`, { ...values, defaultValue: reason.code });
}

// The result to record for a panel verdict (ruleTest.js's ruleTestVerdict):
//   { result: 'passed' | 'review' | 'failed' | 'inconclusive' | 'not_executable', reason }
// "review": the examples passed but the rule does not seem to implement the
// Proposal (test_proposal_mismatch {mismatch} -- the check's sentence, as
// the LLM wrote it), or the Proposal could not be checked
// (test_proposal_unchecked {error}, Barrido final 1/2).
// null while there is no verdict yet.
export function verdictToTestRecord(verdict) {
  if (!verdict) return null;
  switch (verdict.kind) {
    case 'correct':
      return { result: 'passed', reason: null };
    case 'review':
      if (verdict.path) return { result: 'review', reason: verdict.path };
      if (verdict.threshold) return { result: 'review', reason: { code: 'test_threshold_mismatch', params: { numbers: verdict.threshold.numbers, thresholds: verdict.threshold.thresholds } } };
      return verdict.unchecked
        ? { result: 'review', reason: { code: 'test_proposal_unchecked', params: { error: verdict.error || '' } } }
        : { result: 'review', reason: { code: 'test_proposal_mismatch', params: { mismatch: verdict.mismatch } } };
    case 'incorrect':
      return { result: 'failed', reason: { code: 'test_incorrect', params: { permissive: Boolean(verdict.permissive), strict: Boolean(verdict.strict) } } };
    case 'inconclusive':
      return {
        result: 'inconclusive',
        reason: { code: verdict.why === 'nothing_selected' ? 'test_nothing_selected' : 'test_missing_expectation', params: {} },
      };
    case 'no_runnable':
      return { result: 'inconclusive', reason: { code: 'test_no_runnable', params: {} } };
    case 'not_executable':
      return { result: 'not_executable', reason: verdict.reason };
    default:
      return null;
  }
}

// ─── The deterministic rule description (T3b, Part 1) ───────────────────────
// ruleTestEngine.js's describeRule → one sentence per statement, in the
// language of `t` (records.ruleTest.describe.*). The same text, in English,
// goes to the LLM in "Review with the assistant".
function formatValues(values, t) {
  return values
    .map((v) => {
      if (v.unsupported) return t('records.ruleTest.describe.valueUnsupported', { form: v.form });
      if (v.form === 'range') return t('records.ruleTest.describe.valueRange', { from: v.from, to: v.to });
      if (v.form === 'pattern') return t('records.ruleTest.describe.valuePattern', { pattern: v.pattern });
      return v.value;
    })
    .join(', ');
}

export function formatRuleStatement(statement, schemas, t) {
  const params = statement.params || {};
  if (statement.code === 'describe_not_executable') {
    return t('records.ruleTest.describe.describe_not_executable', { reason: formatRuleTestReason(params.reason, t) });
  }
  const values = { ...params };
  if ('target' in params) values.target = params.target || t('records.ruleTest.describe.nodesOf', { path: params.path });
  if (params.values) values.values = formatValues(params.values, t);
  // Plantillas, Part 4: the names a condition looks at.
  if (Array.isArray(params.names)) values.names = params.names.join(', ');
  // Mejoras A, Part 4: a threshold ("more than 5", "at level 7 or deeper").
  if (params.op) {
    values.amountText = t(`records.ruleTest.describe.amount.${params.op}`, { n: params.amount });
    if (params.mode) values.levels = t(`records.ruleTest.describe.levels.${params.mode === 'upto' && params.level === 1 ? 'exactly' : params.mode}`, { level: params.level });
    if (statement.code === 'describe_forbidden_children') values.childWord = t(`records.ruleTest.describe.childWord.${params.op === 'eq' && params.amount === 1 ? 'one' : 'other'}`);
    if (statement.code === 'describe_forbidden_length') values.lengthText = t(`records.ruleTest.describe.length.${params.op}`, { n: params.amount });
  }
  // Mejoras B, Part 4.1.
  if (statement.code === 'describe_forbidden_in_nesting') {
    values.levels = t(`records.ruleTest.describe.inLevel.${params.mode}`, { level: params.level });
  }
  if (statement.code === 'describe_forbidden_attr') {
    values.subject = params.childOf ? t('records.ruleTest.describe.anyChildOf', { parent: params.childOf }) : params.target;
    values.condition = t(`records.ruleTest.describe.attrCondition.${params.kind}`, { attr: params.attr, value: params.value });
  }
  // Mejoras C, Part 3: "<techstd> without <authex> or without <notes>".
  if (statement.code === 'describe_forbidden_existence') {
    values.condition = (params.conditions || [])
      .map((c) => t(`records.ruleTest.describe.existence.${c.negated ? 'without' : 'with'}${c.kind === 'inside' ? 'Inside' : ''}`, { name: c.name }))
      .join(t(`records.ruleTest.describe.existence.joiner.${params.joiner === 'or' ? 'or' : 'and'}`));
  }
  // "The nodes selected by …" is plural: its own sentence where the verb
  // agrees (Mejoras B, Part 4.1 c).
  const nodesKey = !params.target && 'target' in params ? `records.ruleTest.describe.${statement.code}_nodes` : null;
  const nodesText = nodesKey ? t(nodesKey, { ...values, defaultValue: '' }) : '';
  let text = nodesText || t(`records.ruleTest.describe.${statement.code}`, { ...values, defaultValue: statement.code });
  // Schematron: a role="warning"/"info" check never rejects (T4).
  if (params.warning) text = t('records.ruleTest.describe.schWarning', { text });
  else if (params.constant) text = t('records.ruleTest.describe.schConstant', { text });
  return schemas && schemas.length ? t('records.ruleTest.describe.onlyInSchemas', { text, schemas: schemas.join(', ') }) : text;
}

// → { lines: [text], cannotReject } | null when the rule cannot be described.
export function formatRuleDescription(description, t) {
  if (!description?.available) return null;
  return {
    lines: description.statements.map((s) => formatRuleStatement(s.statement, s.schemas, t)),
    cannotReject: description.cannotReject,
  };
}

// The description as one English text block, for a prompt.
export function ruleDescriptionText(description, t) {
  const formatted = formatRuleDescription(description, t);
  if (!formatted) return '';
  const lines = formatted.lines.map((l) => `- ${l}`);
  if (formatted.cannotReject) lines.push(`- ${t('records.ruleTest.describe.cannotReject')}`);
  return lines.join('\n');
}

// Mejoras B, Part 3: why the rule ACCEPTED an example meant to be rejected,
// one line per example from the engine's acceptanceDetails (codes cause_*,
// text: records.ruleTest.acceptCause.*). Never changes the verdict.
//   cause_mandatory_present {parent, child}, cause_mandatory_present_values,
//   cause_mandatory_somewhere {target}, cause_missing {target},
//   cause_predicate {amount, target, predicate},
//   cause_predicate_nesting {…, deepest, mode, level},
//   cause_predicate_path {amount, target, path},
//   cause_attr_has / _lacks / _equals / _not_equals {count, target, childOf, attr, value},
//   cause_values_allowed / cause_values_not_prohibited {count, values},
//   cause_sch_context {amount, target, context},
//   cause_condition {names, path, truth} (Remates B, Part 1).
// null when there is no cause to give (the verdict's own text stands).
const ATTR_CAUSE_KEYS = {
  cause_attr_has: 'attrHas',
  cause_attr_lacks: 'attrLacks',
  cause_attr_equals: 'attrEquals',
  cause_attr_not_equals: 'attrNotEquals',
};
export function formatAcceptCause(cause, t) {
  if (!cause?.code) return null;
  const p = cause.params || {};
  const k = (key, params) => t(`records.ruleTest.acceptCause.${key}`, params);
  switch (cause.code) {
    case 'cause_mandatory_present':
      return k('mandatoryPresent', p);
    case 'cause_mandatory_present_values':
      return k('mandatoryPresentValues', p);
    case 'cause_mandatory_somewhere':
      return k('mandatorySomewhere', p);
    case 'cause_missing':
      return k('missing', p);
    case 'cause_predicate':
      return k('predicate', p);
    case 'cause_predicate_nesting': {
      const levels = t(`records.ruleTest.describe.levels.${p.mode === 'upto' && p.level === 1 ? 'exactly' : p.mode}`, { level: p.level });
      return `${k('predicate', p)}${k('nestingDeepest', { deepest: p.deepest, levels })}`;
    }
    case 'cause_predicate_path':
      return k('predicatePath', p);
    case 'cause_values_allowed':
      return k('valuesAllowed', p);
    case 'cause_values_not_prohibited':
      return k('valuesNotProhibited', p);
    case 'cause_sch_context':
      return k('schContext', p);
    case 'cause_condition': {
      // Remates B, Part 1, case b: the names the example contains, and the
      // condition (flag 0: false; flag 1: true) as it is in the example.
      const names = Array.isArray(p.names) ? p.names : [String(p.names || '')];
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} ${t('records.assistant.listAnd')} ${names[names.length - 1]}` : names[0];
      return k(p.truth === 'true' ? 'conditionTrue' : 'conditionFalse', { names: list, path: p.path, count: names.length });
    }
    default: {
      const key = ATTR_CAUSE_KEYS[cause.code];
      if (!key) return null;
      return k(`${key}${p.childOf ? 'Child' : ''}`, { ...p, target: p.childOf || p.target });
    }
  }
}

// The line of one run: the causes of its parts joined, or null.
export function acceptCauseText(run, t) {
  const lines = (run?.acceptance || []).map((d) => formatAcceptCause(d.cause, t)).filter(Boolean);
  return lines.length ? [...new Set(lines)].join('; ') : null;
}

// Mejoras B, Part 2: the threshold warning. "The Proposal speaks of 5; the
// rule allows up to 6 levels and rejects from level 7 on." One sentence
// per threshold (the first one is enough in practice), in the language of t.
export function thresholdRuleText(th, t) {
  const k = (key, params) => t(`records.ruleTest.threshold.${key}`, params);
  if (th.kind === 'nesting') {
    const name = `<${th.name}>`;
    if (th.mode === 'from') return k('nesting.from', { allowed: th.level - 1, level: th.level, name });
    return k(`nesting.${th.mode}`, { level: th.level, name });
  }
  const what =
    th.kind === 'children' ? k('what.children', { name: `<${th.name}>` })
    : th.kind === 'ancestors' ? k('what.ancestors', { name: `<${th.name}>` })
    : k('what.length');
  return k(`amount.${th.op}`, { n: th.n, prev: th.n - 1, next: th.n + 1, what });
}
export function formatThresholdMismatch(mismatch, t) {
  if (!mismatch) return null;
  const numbers = mismatch.numbers.join(', ');
  return t('records.ruleTest.threshold.mismatch', { numbers, rule: thresholdRuleText(mismatch.thresholds[0], t) });
}
