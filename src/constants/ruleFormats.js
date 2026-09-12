// project.standard (one of the 7 exact display strings the Create Project
// dropdown offers, canonical since v2's project management round) ->
// rule_approvals format id. Mirrors backend/app/api/routes/similar.py's
// _STANDARD_TO_RULE_FORMAT exactly -- keep both in sync if a new standard/
// format is ever added. "Schematron 1.0 — S1000D" is keyed under its OWN
// format id (SCH-S1000D), not BREX-3.0.1: generateBREXSch.js generates a
// real BREX 3.0.1 under the hood and converts it deterministically
// (brexToSchematron.js), but freezes its own approvals under the
// Schematron format id (see CLAUDE.md). DITA has no rule-kind precedent
// at all -- there is no BREX equivalent for it.
export const STANDARD_TO_RULE_FORMAT = {
  'BREX — S1000D 4.2': 'BREX-4.2',
  'BREX — S1000D 4.1': 'BREX-4.1',
  'BREX — S1000D 3.0.1': 'BREX-3.0.1',
  'Schematron 1.0 — S1000D': 'SCH-S1000D',
};
