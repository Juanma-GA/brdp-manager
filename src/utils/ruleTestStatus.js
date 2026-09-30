// Test de reglas T3, Parts 2-3: what the recorded test of a saved rule
// means now, for the Rule Status indicator and the warning before Verify.
// Pure (the Node tests import it). `approval` is the RuleApprovalOut of the
// per-BRDP GET: last_test_result / last_test_reason / last_test_at /
// last_test_up_to_date (the backend compares the tested rule's hash with
// the saved rule_xml).
import { analyzeRule, RULE_TEST_FORMATS } from './ruleTestEngine.js';

// The indicator state of a saved rule:
//   { kind: 'not_tested' | 'outdated' | 'passed' | 'review' | 'failed' | 'inconclusive' | 'not_executable',
//     reason, at }
// "outdated" wins over the recorded result: a result about another rule
// says nothing about this one.
// editedCount: how many examples the user edited by hand to get that
// recorded passed test (last_test_edited_examples; 0 for a test recorded
// from the examples as the LLM wrote them).
export function ruleTestStatus(approval) {
  if (!approval || !approval.last_test_result) return { kind: 'not_tested', reason: null, at: null, editedCount: 0 };
  const at = approval.last_test_at || null;
  const editedCount = Array.isArray(approval.last_test_edited_examples) ? approval.last_test_edited_examples.length : 0;
  if (approval.last_test_up_to_date === false) return { kind: 'outdated', reason: null, at, editedCount: 0 };
  return { kind: approval.last_test_result, reason: approval.last_test_reason || null, at, editedCount };
}

// A "rule_test" History value is JSON: {"result", "reason"} plus, for a
// passed test reached by editing examples by hand, "edited_examples":
// [{label, xml}]. Returns the parsed value, or null for a value that is
// not that JSON (shown as it is).
export function parseRuleTestHistoryValue(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.result !== 'string') return null;
    const edited = Array.isArray(parsed.edited_examples) ? parsed.edited_examples.filter((ex) => ex && typeof ex.xml === 'string') : [];
    return { result: parsed.result, reason: parsed.reason || null, editedExamples: edited };
  } catch {
    return null;
  }
}

// The warning before moving a rule to Verified (warn, never block -- user
// decision: some rules cannot be executed at all):
//   null                                  -- passed and up to date, examples as the LLM wrote them: no dialog
//   { kind: 'passed_edited', editedCount, canTestNow: true }
//                                         -- passed, but with examples edited by hand
//   { kind: 'not_tested' | 'outdated', canTestNow: true }
//   { kind: 'review' | 'failed' | 'inconclusive', reason, canTestNow: true }
//   { kind: 'not_executable', reason, canTestNow: false }
// A rule never tested (or tested before it changed) that the engine cannot
// run anyway gets the not_executable warning straight away, from
// analyzeRule: "Test now" would only tell the same thing. Only the formats
// the engine runs (BREX and, since T4, SCH-DITA) are checked; another format has
// no test to ask for, so no dialog.
export function verifyWarning(approval, format, options = {}) {
  if (!RULE_TEST_FORMATS.includes(format) || !approval) return null;
  const status = ruleTestStatus(approval);
  if (status.kind === 'passed') {
    return status.editedCount > 0 ? { kind: 'passed_edited', reason: null, editedCount: status.editedCount, canTestNow: true } : null;
  }
  if (status.kind === 'not_executable') return { kind: 'not_executable', reason: status.reason, canTestNow: false };
  if (status.kind === 'review' || status.kind === 'failed' || status.kind === 'inconclusive') return { kind: status.kind, reason: status.reason, canTestNow: true };
  const analysis = analyzeRule(approval.rule_xml, format, options);
  if (analysis.status === 'not_executable') return { kind: 'not_executable', reason: analysis.reason, canTestNow: false };
  return { kind: status.kind, reason: null, canTestNow: true };
}
