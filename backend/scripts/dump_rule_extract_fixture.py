"""Writes scripts/rule-test-fixtures/extract-candidates.json: real candidates
read from the two BREX fixtures (backend/tests/fixtures/brex/) and the two
Schematron fixtures (backend/tests/fixtures/schematron/) by the same
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
FIXTURES = ROOT / "backend" / "tests" / "fixtures"
OUT = ROOT / "scripts" / "rule-test-fixtures" / "extract-candidates.json"

# identifier → (classification, catalog texts). S1-00117, S1-00037 and
# S1-00001 have a nonContextRule: as new EXT only their Title is left for
# the AI. S1-00052 and S1-00007 have only executable rules sharing one
# objectUse, which is their Proposal: as new EXT the AI writes Title and
# Definition. S1-00006's objectUses only say who decided ("Decision by
# Company."): as catalog, the AI writes the Proposal.
# File → (rule format, standard, {identifier: …}). A Schematron candidate is
# keyed "<file stem>/<identifier>" (its EXT numbers repeat across files).
FILES = {
    "brex/DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml": ("BREX-4.2", "S1000D 4.2"),
    "brex/DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml": ("BREX-4.2", "S1000D 4.2"),
    # EXT-00002: Title from its comment, the AI writes Definition and Proposal.
    "schematron/BRDP-D1_schematron-xpath2.sch": ("SCH-DITA", "DITA 1.3 Xpath2.0"),
}
PICK = {
    "brex/DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml": {
        "BRDP-S1-00052": ("new_ext", None),
        "BRDP-S1-00117": ("new_ext", None),
        "BRDP-S1-00037": ("new_ext", None),
        "BRDP-S1-00001": ("new_ext", None),
        "BRDP-S1-00006": ("catalog", ("Schemas", "Decide which schemas to use.")),
    },
    "brex/DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml": {
        "BRDP-S1-00007": ("new_ext", None),
        "BRDP-S2-00002": ("other_spec", None),
        "BREX-S1-00242": ("default_rule", None),
    },
    "schematron/BRDP-D1_schematron-xpath2.sch": {
        "BRDP-EXT-00002": ("new_ext", None),
    },
}


def main() -> None:
    out = {}
    for name, ids in PICK.items():
        rule_format, standard = FILES[name]
        rf = read_rules_file((FIXTURES / name).read_bytes(), rule_format, standard)
        candidates, _ = build_candidates(rf, "4.2" if rule_format == "BREX-4.2" else None)
        by_id = {c["origin_identifier"]: c for c in candidates}
        for identifier, (classification, catalog) in ids.items():
            c = dict(by_id[identifier])
            c.pop("rule_xml")
            c.pop("rule_preview")
            c["classification"] = c["base_classification"] = classification
            c["specification"] = default_rule_specification(identifier) or other_specification(identifier, standard)
            if catalog:
                c["catalog_texts"] = {"title": catalog[0], "definition": catalog[1]}
            set_texts(c)
            key = identifier if rule_format.startswith("BREX") else f"{Path(name).stem}/{identifier}"
            out[key] = c
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(out)} candidates)")


main()
