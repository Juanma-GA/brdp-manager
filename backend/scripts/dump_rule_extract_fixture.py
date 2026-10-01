"""Writes scripts/rule-test-fixtures/extract-candidates.json: real candidates
read from the two BREX fixtures (backend/tests/fixtures/brex/) by the same
code as the AI Extract job, for the prompt snapshot and the Node tests of
src/prompts/extractFromRulesPrompt.js. No database: classification fields
are set here the way classify_candidates would set them for an empty 4.2
project whose catalog has the S1 identifiers.

    cd backend && .venv/bin/python scripts/dump_rule_extract_fixture.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.rule_extract import build_candidates, read_rules_file  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "backend" / "tests" / "fixtures" / "brex"
OUT = ROOT / "scripts" / "rule-test-fixtures" / "extract-candidates.json"

PICK = {
    "DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml": ["BRDP-S1-00052", "BRDP-S1-00117", "BRDP-S1-00037", "BRDP-S1-00006"],
    "DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml": ["BRDP-S1-00007", "BRDP-S2-00002", "BREX-S1-00242"],
}


def main() -> None:
    out = {}
    for name, ids in PICK.items():
        rf = read_rules_file((FIXTURES / name).read_bytes(), "BREX-4.2", "S1000D 4.2")
        candidates, _ = build_candidates(rf, "4.2")
        by_id = {c["origin_identifier"]: c for c in candidates}
        for identifier in ids:
            c = dict(by_id[identifier])
            c.pop("rule_xml")
            c.pop("rule_preview")
            out[identifier] = c
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(out)} candidates)")


main()
