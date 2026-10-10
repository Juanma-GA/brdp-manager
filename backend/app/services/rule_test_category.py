"""The one decision of what a saved rule's test means now (AACF 2, Part 2):
the Rule Status indicator of each rule (RuleApprovalOut.test_category, read
by src/utils/ruleTestStatus.js) and the breakdown of the verified rules in
BRDP Records' header (brdp_repository.compute_verified_test_counts) both
come from rule_test_category() below -- never two logics that could drift
apart.

Every rule is in exactly ONE category:
  - not_tested: never tested, or a stored test the app cannot read (no
    rule hash, or a result that is not one of the recorded ones) -- never
    outside the sum;
  - outdated: tested, but the rule changed since (the tested hash is not
    the saved rule's) -- wins over whatever the old result was;
  - otherwise the recorded result: passed (also "passed with examples
    edited by hand"), schema_covered (Mejoras E: the rule forbids what no
    valid document of the schema can contain, and an example meant to be
    accepted passed), review, failed, inconclusive, not_executable.
"""
import hashlib

RECORDED_RESULTS = ("passed", "schema_covered", "review", "failed", "inconclusive", "not_executable")
# The order the header lists them in (passed first, always shown).
TEST_CATEGORIES = ("passed", "schema_covered", "not_tested", "review", "failed", "inconclusive", "not_executable", "outdated")


def rule_xml_hash(rule_xml: str) -> str:
    """SHA-256 hex digest of a rule_xml, byte for byte (UTF-8) -- the same
    digest the frontend computes (src/utils/ruleHash.js) for the rule it
    tested, and Postgres computes with encode(sha256(convert_to(rule_xml,
    'UTF8')), 'hex') when it counts many rules at once. No normalisation:
    any change to the saved text makes an earlier test outdated.
    """
    return hashlib.sha256(rule_xml.encode("utf-8")).hexdigest()


def rule_test_category(result: str | None, tested_hash: str | None, current_hash: str) -> str:
    if result not in RECORDED_RESULTS or not tested_hash:
        return "not_tested"
    if tested_hash != current_hash:
        return "outdated"
    return result
