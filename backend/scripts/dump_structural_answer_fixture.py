"""Consolidation C1, Part 2: dumps the REAL full schema cards and attribute
owners (app.services.schema_cards.get_schema_cards(full=True) and
get_attribute_owners -- the functions GET /api/schema-cards?full=true and
GET /api/schema-cards/attribute call) that scripts/test-structural-answer.mjs
answers from, into scripts/rule-test-fixtures/structural-answers.json, so the
plain-Node test works on what the backend really serves, without a server.
Re-run after generate_schema_cards.py regenerates the cards:

    cd backend && source .venv/bin/activate
    python scripts/dump_structural_answer_fixture.py
"""
import json
from pathlib import Path

from app.services.schema_cards import get_attribute_owners, get_schema_cards

_CARDS = [
    ("S1000D 4.2", ["identAndStatusSection", "para", "table", "emphasis", "dmodule"]),
    ("S1000D 3.0.1", ["para"]),
    ("DITA 1.3 Xpath2.0", ["step", "note"]),
]
_ATTRIBUTES = [
    ("S1000D 4.2", ["emphasisType", "frame"]),
    ("DITA 1.3 Xpath2.0", ["type"]),
]

_OUT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "rule-test-fixtures" / "structural-answers.json"


def main() -> None:
    out: dict = {"cards": {}, "attributes": {}}
    for standard, names in _CARDS:
        available, cards, unknown = get_schema_cards(standard, names, full=True)
        assert available and not unknown, (standard, unknown)
        out["cards"][standard] = cards
    for standard, names in _ATTRIBUTES:
        out["attributes"][standard] = {}
        for name in names:
            available, owners = get_attribute_owners(standard, name)
            assert available and owners, (standard, name)
            out["attributes"][standard][name] = owners
    _OUT_PATH.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {_OUT_PATH}")


if __name__ == "__main__":
    main()
