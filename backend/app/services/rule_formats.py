"""project.standard (one of the 6 exact display strings the Create Project
dropdown offers) -> rule_approvals format id. Mirrors
src/constants/ruleFormats.js exactly -- keep both in sync if a new
standard/format is ever added. There is no longer a separate "Schematron
1.0 — S1000D" standard/format: Schematron for S1000D is a Generate-page
output selector on top of the S1000D 3.0.1/4.1/4.2 standards (generateBREXSch.js
generates a real BREX under the hood and converts it deterministically), and
the SAME BREX-format approved rules feed both the BREX and the Schematron
output -- there is no independent SCH-S1000D approval set any more.

DITA 1.3 -> "SCH-DITA": DITA has no BREX equivalent, but it DOES have its
own native Schematron rule-kind -- generateSchematronDITA.js's real
generation path is a purely deterministic assembler (no LLM call in it),
injecting each approved SCH-DITA rule_approvals row's rule_xml verbatim
and falling back to a traceability comment for anything not approved.
Without an entry here, no DITA BRDP could ever reach `approved` at all
(import_jobs.py's rule_format lookup would stay None, and any row
bringing Rule/Rule Status content was rejected outright) -- this was a
real gap, not an intentional "DITA has no rule format" design choice.
"""

STANDARD_TO_RULE_FORMAT = {
    "S1000D 4.2": "BREX-4.2",
    "S1000D 4.1": "BREX-4.1",
    "S1000D 3.0.1": "BREX-3.0.1",
    "DITA 1.3": "SCH-DITA",
}
