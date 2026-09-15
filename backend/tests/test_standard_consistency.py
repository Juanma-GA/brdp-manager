"""Guards the one thing that has no compiler or DB constraint to catch it:
project.standard is a plain string repeated in three independent places
(the Create Project dropdown's 7 canonical values in ProjectsPage.jsx, the
frontend's STANDARD_TO_RULE_FORMAT in src/constants/ruleFormats.js, and the
backend's _STANDARD_TO_RULE_FORMAT in app/api/routes/similar.py) with no
shared source of truth. A stray comma, a straight vs. em dash, a renamed
standard, or a new standard added to only one of the three would currently
surface as a 400/500 in production for a real project's Suggest Rule flow,
not a CI failure. This test reads the actual JS source as text (no JS
runtime available here) and the actual backend dict via import, and fails
loudly the moment any of the three disagree.
"""
import re
from pathlib import Path

from app.api.routes.similar import _STANDARD_TO_RULE_FORMAT as BACKEND_RULE_FORMATS

REPO_ROOT = Path(__file__).resolve().parents[2]

# The 7 exact standards the Create Project dropdown offers (docs/v2 §2 --
# fixed forever once a project is created). "BREX — S1000D 5.0"/"6.0" are
# listed there but have no generation engine, so they correctly never
# appear in either STANDARD_TO_RULE_FORMAT map.
EXPECTED_STANDARD_COUNT = 7


def _extract_project_standards() -> list[str]:
    source = (REPO_ROOT / "src" / "pages" / "ProjectsPage.jsx").read_text()
    block_match = re.search(r"const STANDARD_OPTIONS = \[(.*?)\];", source, re.DOTALL)
    assert block_match, "Could not find STANDARD_OPTIONS array in ProjectsPage.jsx -- did it get renamed/moved?"
    return re.findall(r"value:\s*'([^']+)'", block_match.group(1))


def _extract_frontend_rule_formats() -> dict[str, str]:
    source = (REPO_ROOT / "src" / "constants" / "ruleFormats.js").read_text()
    block_match = re.search(r"export const STANDARD_TO_RULE_FORMAT = \{(.*?)\};", source, re.DOTALL)
    assert block_match, "Could not find STANDARD_TO_RULE_FORMAT object in ruleFormats.js -- did it get renamed/moved?"
    return dict(re.findall(r"'([^']+)':\s*'([^']+)'", block_match.group(1)))


def test_exactly_seven_canonical_standards():
    standards = _extract_project_standards()
    assert len(standards) == EXPECTED_STANDARD_COUNT, (
        f"Expected exactly {EXPECTED_STANDARD_COUNT} standards in ProjectsPage.jsx's STANDARD_OPTIONS, "
        f"found {len(standards)}: {standards}"
    )
    assert len(set(standards)) == len(standards), f"Duplicate standard values in STANDARD_OPTIONS: {standards}"


def test_frontend_and_backend_rule_format_keys_match_exactly():
    frontend_keys = set(_extract_frontend_rule_formats())
    backend_keys = set(BACKEND_RULE_FORMATS)
    assert frontend_keys == backend_keys, (
        "src/constants/ruleFormats.js's STANDARD_TO_RULE_FORMAT and "
        "backend/app/api/routes/similar.py's _STANDARD_TO_RULE_FORMAT must have identical keys.\n"
        f"Only in frontend: {sorted(frontend_keys - backend_keys)}\n"
        f"Only in backend: {sorted(backend_keys - frontend_keys)}"
    )


def test_frontend_and_backend_rule_format_values_match():
    """Same standard must map to the same rule_approvals format id on both
    sides -- a drift here (e.g. frontend keeps freezing under 'BREX-3.0.1'
    while the backend expects 'SCH-S1000D') would silently return zero
    precedent from /similar?kind=rule instead of erroring.
    """
    frontend = _extract_frontend_rule_formats()
    mismatches = {
        standard: (frontend[standard], BACKEND_RULE_FORMATS[standard])
        for standard in frontend
        if standard in BACKEND_RULE_FORMATS and frontend[standard] != BACKEND_RULE_FORMATS[standard]
    }
    assert not mismatches, f"Format id mismatches between frontend and backend (standard: (frontend, backend)): {mismatches}"


def test_rule_format_keys_are_a_subset_of_the_canonical_standards():
    """Every standard used as a rule-format key -- on EITHER side -- must be
    one of the 7 exact canonical strings. Catches a typo'd or stale standard
    string in either map that no longer corresponds to a real dropdown value.
    """
    canonical = set(_extract_project_standards())
    frontend_keys = set(_extract_frontend_rule_formats())
    backend_keys = set(BACKEND_RULE_FORMATS)

    assert frontend_keys <= canonical, (
        f"ruleFormats.js has standard(s) not in the canonical 7: {sorted(frontend_keys - canonical)}"
    )
    assert backend_keys <= canonical, (
        f"similar.py's _STANDARD_TO_RULE_FORMAT has standard(s) not in the canonical 7: "
        f"{sorted(backend_keys - canonical)}"
    )
