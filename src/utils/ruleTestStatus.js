// Test de reglas T3, Parts 2-3: what the recorded test of a saved rule
// means now, for the Rule Status indicator and the warning before Verify.
// Pure (the Node tests import it). `approval` is the RuleApprovalOut of the
// per-BRDP GET: last_test_result / last_test_reason / last_test_at /
// last_test_up_to_date (the backend compares the tested rule's hash with
// the saved rule_xml).
import { analyzeRule, RULE_TEST_FORMATS } from './ruleTestEngine.js';

// The indicator state of a saved rule:
//   { kind: 'not_tested' | 'outdated' | 'passed' | 'failed' | 'inconclusive' | 'not_executable',
//     reason, at }
// "outdated" wins over the recorded result: a result about another rule
// says nothing about this one.
export function ruleTestStatus(approval) {
  if (!approval || !approval.last_test_result) return { kind: 'not_tested', reason: null, at: null };
  const at = approval.last_test_at || null;
  if (approval.last_test_up_to_date === false) return { kind: 'outdated', reason: null, at };
  return { kind: approval.last_test_result, reason: approval.last_test_reason || null, at };
}

// The warning before moving a rule to Verified (warn, never block -- user
// decision: some rules cannot be executed at all):
//   null                                  -- passed and up to date: no dialog
//   { kind: 'not_tested' | 'outdated', canTestNow: true }
//   { kind: 'failed' | 'inconclusive', reason, canTestNow: true }
//   { kind: 'not_executable', reason, canTestNow: false }
// A rule never tested (or tested before it changed) that the engine cannot
// run anyway gets the not_executable warning straight away, from
// analyzeRule: "Test now" would only tell the same thing. Only the formats
// the engine runs (S1000D BREX) are checked; another format (SCH-DITA) has
// no test to ask for, so no dialog.
export function verifyWarning(approval, format, options = {}) {
  if (!RULE_TEST_FORMATS.includes(format) || !approval) return null;
  const status = ruleTestStatus(approval);
  if (status.kind === 'passed') return null;
  if (status.kind === 'not_executable') return { kind: 'not_executable', reason: status.reason, canTestNow: false };
  if (status.kind === 'failed' || status.kind === 'inconclusive') return { kind: status.kind, reason: status.reason, canTestNow: true };
  const analysis = analyzeRule(approval.rule_xml, format, options);
  if (analysis.status === 'not_executable') return { kind: 'not_executable', reason: analysis.reason, canTestNow: false };
  return { kind: status.kind, reason: null, canTestNow: true };
}
