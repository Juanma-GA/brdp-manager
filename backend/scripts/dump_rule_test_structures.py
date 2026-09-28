"""Test rule (T2b): dumps the REAL schema structures and derived skeletons
(app.services.rule_test_skeletons.get_schema_structure -- the same function
GET /api/schema-cards/structure calls) for the schemas the frontend tests use,
into scripts/rule-test-fixtures/structures.json, so plain-Node tests
(scripts/test-rule-test.mjs, scripts/check-prompt-snapshot.mjs) work on what
the backend really serves, without a server. No database needed. Re-run
after generate_schema_cards.py regenerates the cards:

    cd backend && source .venv/bin/activate
    python scripts/dump_rule_test_structures.py
"""
import json
from pathlib import Path

from app.services.rule_test_skeletons import get_schema_structure

_REQUESTS = [
    ("S1000D 4.2", ["descript", "proced", "ipd"]),
    ("S1000D 4.1", ["proced"]),
    ("S1000D 3.0.1", ["descript", "proced"]),
    # T4: DITA topic types (the XPath 3.0 standard has the same graphs).
    ("DITA 1.3 Xpath2.0", ["topic", "task", "map"]),
]

_OUT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "rule-test-fixtures" / "structures.json"


def main() -> None:
    out: dict[str, dict] = {}
    for standard, schemas in _REQUESTS:
        for schema in schemas:
            data = get_schema_structure(standard, schema)
            if not data["available"]:
                raise RuntimeError(f"No structure for {standard}/{schema}")
            out[f"{standard}|{schema}"] = {"skeleton": data["skeleton"], "elements": data["elements"]}
    _OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    _OUT_PATH.write_text(json.dumps(out, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {_OUT_PATH} ({len(out)} structures)")


if __name__ == "__main__":
    main()
