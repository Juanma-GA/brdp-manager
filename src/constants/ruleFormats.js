// project.standard (one of the 6 exact display strings the Create Project
// dropdown offers, canonical since v2's project management round) ->
// rule_approvals format id. Mirrors backend/app/api/routes/similar.py's
// _STANDARD_TO_RULE_FORMAT exactly -- keep both in sync if a new standard/
// format is ever added. There is no longer a separate "Schematron 1.0 —
// S1000D" standard/format: Schematron for S1000D is a Generate-page output
// selector on top of the S1000D 3.0.1/4.1/4.2 standards (generateBREXSch.js
// generates a real BREX under the hood and converts it deterministically
// via brexToSchematron.js), and the SAME BREX-format approved rules feed
// both the BREX and the Schematron output (see CLAUDE.md) -- there is no
// independent SCH-S1000D approval set any more. DITA has no rule-kind
// precedent at all -- there is no BREX equivalent for it.
export const STANDARD_TO_RULE_FORMAT = {
  'S1000D 4.2': 'BREX-4.2',
  'S1000D 4.1': 'BREX-4.1',
  'S1000D 3.0.1': 'BREX-3.0.1',
};
