"""Writes scripts/rule-test-fixtures/schematron-extract-rules.json: the rule
of every candidate read from the two Schematron fixtures
(backend/tests/fixtures/schematron/) by the same code as the AI Extract job
-- each pattern with its comments and the global sch:let / sch:ns it uses.
The Node tests generate the DITA Schematron from them
(scripts/test-generate-plan.mjs).

    cd backend && .venv/bin/python scripts/dump_schematron_extract_rules.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.rule_extract import build_candidates, read_rules_file  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "backend" / "tests" / "fixtures" / "schematron"
OUT = ROOT / "scripts" / "rule-test-fixtures" / "schematron-extract-rules.json"
FILES = {"xpath2": "DITA 1.3 Xpath2.0", "xpath3": "DITA 1.3 Xpath3.0"}


def main() -> None:
    out = {}
    for flavor, standard in FILES.items():
        rf = read_rules_file((FIXTURES / f"BRDP-D1_schematron-{flavor}.sch").read_bytes(), "SCH-DITA", standard)
        candidates, _ = build_candidates(rf, None)
        out[flavor] = [
            {"identifier": c["origin_identifier"], "title": c["literal"]["title"], "rule_xml": c["rule_xml"]}
            for c in candidates
        ]
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")


main()
