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
import sys
import json
from pathlib import Path

from app.services.rule_test_skeletons import get_element_relation
from app.services.schema_cards import get_attribute_owners, get_schema_cards

_CARDS = [
    ("S1000D 4.2", ["identAndStatusSection", "para", "table", "emphasis", "dmodule"]),
    ("S1000D 3.0.1", ["para"]),
    ("DITA 1.3 Xpath2.0", ["step", "note", "p"]),
]
_ATTRIBUTES = [
    ("S1000D 4.2", ["emphasisType", "frame", "changeMark"]),
    ("DITA 1.3 Xpath2.0", ["type", "outputclass"]),
]
# C2, Part 3: GET /api/schema-cards/relation (Ask's yes/no answers).
_RELATIONS = [
    ("S1000D 4.2", [("para", "emphasis"), ("para", "footnote"), ("para", "listItem"), ("para", "table"), ("title", "emphasis"), ("table", "para")]),
    ("DITA 1.3 Xpath2.0", [("p", "table"), ("p", "li"), ("title", "table")]),
]

_OUT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "rule-test-fixtures" / "structural-answers.json"


def main() -> None:
    out: dict = {"cards": {}, "attributes": {}, "relations": {}}
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
    for standard, pairs in _RELATIONS:
        out["relations"][standard] = {}
        for parent, child in pairs:
            data = get_element_relation(standard, parent, child)
            assert data["available"] and data["parent_exists"] and data["child_exists"], (standard, parent, child)
            out["relations"][standard][f"{parent}/{child}"] = {
                "available": True,
                "parent_exists": True,
                "child_exists": True,
                "schemas": [{"schema_name": e["schema"], "direct": e["direct"], "path": e["path"]} for e in data["schemas"]],
            }
    _OUT_PATH.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {_OUT_PATH}")


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # UTF-8 on any console or pipe, Windows included (Protecciones 1c)
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    main()
