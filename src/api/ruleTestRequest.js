// The body of POST .../approvals/{format}/test (Test de reglas T3): what the
// panel sends to record a test of the SAVED rule. Pure (no browser API
// client), so scripts/run-project-rule-tests.mjs records exactly what the
// panel records. The hash of the tested rule_xml travels with it; the
// backend refuses (409) a result for a rule that is not the saved one.
import { ruleXmlHash } from '../utils/ruleHash.js';

// `keepPrevious` ("Mantener la anterior"): the result is not recorded -- the
// passed test stays and History notes the attempt.
export function ruleTestRequestBody(testedRuleXml, record, { keepPrevious = false } = {}) {
  return {
    result: record.result,
    reason: record.reason,
    rule_hash: ruleXmlHash(testedRuleXml),
    // A test passed after editing examples by hand carries them.
    ...(record.editedExamples?.length ? { edited_examples: record.editedExamples } : {}),
    // A passed test keeps its examples (Guardar la prueba aprobada).
    ...(record.result === 'passed' && record.passedTest ? { passed_test: record.passedTest } : {}),
    ...(keepPrevious ? { keep_previous: true } : {}),
  };
}
