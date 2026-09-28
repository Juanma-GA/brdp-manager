// Test de reglas T3: records the result of a "Test rule" run on the SAVED
// rule. The hash of the tested rule_xml travels with it; the backend
// refuses (409) a result for a rule that is not the saved one.
import { authFetchJson } from '../services/apiClient';
import { ruleXmlHash } from '../utils/ruleHash.js';

export function registerRuleTest(projectId, brdpId, format, testedRuleXml, record) {
  return authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${format}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: record.result, reason: record.reason, rule_hash: ruleXmlHash(testedRuleXml) }),
  });
}
