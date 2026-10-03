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
// independent SCH-S1000D approval set any more.
//
// DITA 1.3 Xpath2.0 / DITA 1.3 Xpath3.0 -> 'SCH-DITA' (both): DITA has no
// BREX equivalent, but it DOES have its own native Schematron rule-kind --
// generateSchematronDITA.js's real generation path is a purely deterministic
// assembler (no LLM call in it), injecting each approved SCH-DITA
// rule_approvals row's rule_xml verbatim. Without this entry no DITA BRDP
// could ever reach 'approved' at all.
//
// Split from a single "DITA 1.3" standard (migration
// 0013_split_dita_xpath_standards.py) because each BRDP's Rule content is
// genuinely different hand-authored XPath 2.0 vs 3.0 syntax -- unlike the
// Schematron-for-S1000D merge above, there is no shared deterministic
// conversion step to hide that behind one standard, so two real, separate
// project standards exist. Both map to the SAME format here (the
// assembly/approval machinery is identical either way); only
// generateSchematronDITA.js's assembled document's queryBinding attribute
// ("xslt2"/"xslt3") differs, derived from project.standard at generation
// time, not from this map.
export const STANDARD_TO_RULE_FORMAT = {
  'S1000D 4.2': 'BREX-4.2',
  'S1000D 4.1': 'BREX-4.1',
  'S1000D 3.0.1': 'BREX-3.0.1',
  'DITA 1.3 Xpath2.0': 'SCH-DITA',
  'DITA 1.3 Xpath3.0': 'SCH-DITA',
};
