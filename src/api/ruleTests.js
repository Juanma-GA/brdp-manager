// Test de reglas T3: records the result of a "Test rule" run on the SAVED
// rule (body: ruleTestRequest.js, shared with the script that tests every
// rule of a project).
import { authFetchJson } from '../services/apiClient';
import { ruleTestRequestBody } from './ruleTestRequest.js';

// `keepPrevious` ("Mantener la anterior"): the result is not recorded -- the
// passed test stays and History notes the attempt.
export function registerRuleTest(projectId, brdpId, format, testedRuleXml, record, { keepPrevious = false } = {}) {
  return authFetchJson(`/api/projects/${projectId}/brdps/${brdpId}/approvals/${format}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ruleTestRequestBody(testedRuleXml, record, { keepPrevious })),
  });
}
