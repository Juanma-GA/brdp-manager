"""project.standard (one of the 7 exact display strings the Create Project
dropdown offers) -> rule_approvals format id. Mirrors
src/constants/ruleFormats.js exactly -- keep both in sync if a new
standard/format is ever added. "Schematron 1.0 — S1000D" is keyed under
its OWN format id (SCH-S1000D), not BREX-3.0.1: generateBREXSch.js
generates a real BREX 3.0.1 under the hood and converts it deterministically,
but freezes its own approvals under the Schematron format id. DITA has no
rule-kind precedent at all -- there is no BREX equivalent for it, so it is
deliberately absent from this map.

Previously duplicated inline in app/api/routes/similar.py as its own
module-level `_STANDARD_TO_RULE_FORMAT` -- extracted here so the BRDP
import endpoints (app/api/routes/brdp_import.py) can use the exact same
mapping instead of a third copy.
"""

STANDARD_TO_RULE_FORMAT = {
    "BREX — S1000D 4.2": "BREX-4.2",
    "BREX — S1000D 4.1": "BREX-4.1",
    "BREX — S1000D 3.0.1": "BREX-3.0.1",
    "Schematron 1.0 — S1000D": "SCH-S1000D",
}
