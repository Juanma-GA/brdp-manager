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
//   analyzeRule (C3): rule_format {problem, ...params} -- the stored XML is
//     not a rule of its format; `problem` is checkRuleFormat's code
//     (rule_format_missing, …), shown with the same text as on save;
//   several parts: parts {parts: [{ ruleId, reason }]};
//   recorded verdicts (verdictToTestRecord below): test_incorrect
//     {permissive, strict}, test_nothing_selected, test_missing_expectation,
//     test_no_runnable, test_proposal_mismatch {mismatch}.

import { formatSchemaIssue } from '../validation/schemaValidation.js';

export const ENGINE_REASON_CODES = [
  'external_document', 'non_context_rule', 'mandatory_whole_document', 'xpath_error', 'unsupported_value_form',
  'unsupported_format', 'fragment_not_well_formed', 'rule_not_well_formed', 'no_rule_element', 'empty_path',
  'invalid_flag', 'path_not_nodes', 'absolute_root', 'schema_unknown', 'missing_value', 'bad_range', 'mixed_range',
  'extension_function', 'sch_unsupported', 'sch_missing_attribute', 'xpath3_syntax', 'external_placeholder',
  'rule_format', 'unreachable_target', 'section_unavailable',
];
export const VERDICT_REASON_CODES = ['test_incorrect', 'test_nothing_selected', 'test_missing_expectation', 'test_no_runnable', 'test_proposal_mismatch'];

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
  if (reason.code === 'rule_format') {
    const { problem, ...problemParams } = params;
    const detail = formatSchemaIssue({ source: 'rule', code: problem, params: problemParams }, t);
    return t('records.ruleTest.reasons.rule_format', { detail, defaultValue: detail });
  }
  const values = { ...params };
  if (reason.code === 'path_not_nodes') values.kind = t(`records.ruleTest.reasons.valueKinds.${params.kind}`, { defaultValue: params.kind });
  return t(`records.ruleTest.reasons.${reason.code}`, { ...values, defaultValue: reason.code });
}

// The result to record for a panel verdict (ruleTest.js's ruleTestVerdict):
//   { result: 'passed' | 'review' | 'failed' | 'inconclusive' | 'not_executable', reason }
// "review": the examples passed but the rule does not seem to implement the
// Proposal (test_proposal_mismatch {mismatch} -- the LLM's note, as it wrote it).
// null while there is no verdict yet.
export function verdictToTestRecord(verdict) {
  if (!verdict) return null;
  switch (verdict.kind) {
    case 'correct':
      return { result: 'passed', reason: null };
    case 'review':
      return { result: 'review', reason: { code: 'test_proposal_mismatch', params: { mismatch: verdict.mismatch } } };
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
  let text = t(`records.ruleTest.describe.${statement.code}`, { ...values, defaultValue: statement.code });
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
