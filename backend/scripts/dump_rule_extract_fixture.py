"""Writes scripts/rule-test-fixtures/extract-candidates.json: real candidates
read from the two BREX fixtures (backend/tests/fixtures/brex/) by the same
code as the AI Extract job, for the prompt snapshot and the Node tests of
src/prompts/extractFromRulesPrompt.js. No database: each candidate gets the
classification below and its texts from the same set_texts as the job (an
empty 4.2 project; "catalog" with the catalog texts given here).

    cd backend && .venv/bin/python scripts/dump_rule_extract_fixture.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.rule_extract import build_candidates, read_rules_file  # noqa: E402
from app.services.rule_extract_jobs import default_rule_specification, other_specification, set_texts  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "backend" / "tests" / "fixtures" / "brex"
OUT = ROOT / "scripts" / "rule-test-fixtures" / "extract-candidates.json"

# identifier → (classification, catalog texts). S1-00117, S1-00037 and
# S1-00001 have a nonContextRule: as new EXT only their Title is left for
# the AI. S1-00052 and S1-00007 have only executable rules.
PICK = {
    "DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml": {
        "BRDP-S1-00052": ("catalog", ("Information codes", "Decide on which information codes apply to the project.")),
        "BRDP-S1-00117": ("new_ext", None),
        "BRDP-S1-00037": ("new_ext", None),
        "BRDP-S1-00001": ("new_ext", None),
        "BRDP-S1-00006": ("catalog", ("Schemas", "Decide which schemas to use.")),
    },
    "DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml": {
        "BRDP-S1-00007": ("catalog", ("Optional elements", "Decide whether and how to use each optional element.")),
        "BRDP-S2-00002": ("other_spec", None),
        "BREX-S1-00242": ("default_rule", None),
    },
}


def main() -> None:
    out = {}
    for name, ids in PICK.items():
        rf = read_rules_file((FIXTURES / name).read_bytes(), "BREX-4.2", "S1000D 4.2")
        candidates, _ = build_candidates(rf, "4.2")
        by_id = {c["origin_identifier"]: c for c in candidates}
        for identifier, (classification, catalog) in ids.items():
            c = dict(by_id[identifier])
            c.pop("rule_xml")
            c.pop("rule_preview")
            c["classification"] = c["base_classification"] = classification
            c["specification"] = default_rule_specification(identifier) or other_specification(identifier, "S1000D 4.2")
            if catalog:
                c["catalog_texts"] = {"title": catalog[0], "definition": catalog[1]}
            set_texts(c)
            out[identifier] = c
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(out)} candidates)")


main()
