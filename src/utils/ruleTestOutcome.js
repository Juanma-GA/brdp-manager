// What a "Test rule" run records, from the rule's analysis and the result
// of generateRuleTestExamples -- one function for the panel (useRuleTest.js)
// and for scripts/run-project-rule-tests.mjs (every rule of a project), so
// the two never record different things for the same run. Pure.
import { ruleTestVerdict } from './ruleTest.js';
import { verdictToTestRecord } from './ruleTestReasons.js';
import { withPassedTest } from './ruleTestSaved.js';

// A rule that cannot be executed at all: the analysis IS the result; no
// example is needed to know it (recorded when the panel opens, no LLM).
export function notExecutableRecord(analysis) {
  return analysis?.status === 'not_executable' ? { result: 'not_executable', reason: analysis.reason } : null;
}

// result: what generateRuleTestExamples returned (null when a newer
// generation replaced it). analysis: analyzeRule's; threshold: the rule's
// threshold against the Proposal (thresholdMismatch); proposal: the BRDP's
// Proposal, kept with the examples of a passed test.
//   { record, verdict } -- record null when nothing is to be recorded (an
//   error: the AI call failed or its answer could not be used).
export function generationOutcome(result, { analysis, threshold, proposal }) {
  if (!result) return { record: null, verdict: null };
  if (result.status === 'not_executable') return { record: { result: 'not_executable', reason: result.reason }, verdict: null };
  if (result.status === 'path_review') {
    // Mejoras C, Part 1: the path cannot exist -- "review", no LLM call.
    const verdict = { kind: 'review', path: result.reason };
    return { record: verdictToTestRecord(verdict), verdict };
  }
  if (result.status !== 'ready') return { record: null, verdict: null };
  const verdict = ruleTestVerdict(result.examples, result.runs, analysis, result.proposalCheck, threshold, result.coverage);
  // A passed test keeps its examples (Guardar la prueba aprobada).
  return { record: withPassedTest(verdictToTestRecord(verdict), result.examples, result.runs, proposal), verdict };
}
