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
//   several parts: parts {parts: [{ ruleId, reason }]};
//   recorded verdicts (verdictToTestRecord below): test_incorrect
//     {permissive, strict}, test_nothing_selected, test_missing_expectation,
//     test_no_runnable.

export const ENGINE_REASON_CODES = [
  'external_document', 'non_context_rule', 'mandatory_whole_document', 'xpath_error', 'unsupported_value_form',
  'unsupported_format', 'fragment_not_well_formed', 'rule_not_well_formed', 'no_rule_element', 'empty_path',
  'invalid_flag', 'path_not_nodes', 'absolute_root', 'schema_unknown', 'missing_value', 'bad_range', 'mixed_range',
];
export const VERDICT_REASON_CODES = ['test_incorrect', 'test_nothing_selected', 'test_missing_expectation', 'test_no_runnable'];

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
  const values = { ...params };
  if (reason.code === 'path_not_nodes') values.kind = t(`records.ruleTest.reasons.valueKinds.${params.kind}`, { defaultValue: params.kind });
  return t(`records.ruleTest.reasons.${reason.code}`, { ...values, defaultValue: reason.code });
}

// The result to record for a panel verdict (ruleTest.js's ruleTestVerdict):
//   { result: 'passed' | 'failed' | 'inconclusive' | 'not_executable', reason }
// null while there is no verdict yet.
export function verdictToTestRecord(verdict) {
  if (!verdict) return null;
  switch (verdict.kind) {
    case 'correct':
      return { result: 'passed', reason: null };
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
