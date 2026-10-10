"""Reusable helper for scripts/prompt-snapshot/ (the "Ajustes al juego de
pruebas de prompts" round, Part 5): dumps the REAL, already-compacted
schema-cards entries for a fixed list of (standard, element name) pairs
by calling app.services.schema_cards.get_schema_cards() directly -- the
exact same function GET /api/schema-cards calls, so the fixture's
`para`/`table` entries reflect whatever compaction rules are actually live
(MAX_ATTRIBUTES/MAX_CHILDREN/MAX_ENUM_VALUES, and Part 4's
enum-range-only-when-len>MAX_ENUM_VALUES gate) -- never a hand-rolled
approximation that could quietly drift from production.

This needs no running server and no database -- get_schema_cards() is a
pure, in-memory lookup over backend/schema_cards/*.json, loaded once at
import sys
import time. Re-run this whenever generate_schema_cards.py regenerates
those files (a schema/XSD update) so the frontend prompt-snapshot fixture
stays honest about what the backend would actually return today:

    cd backend && source .venv/bin/activate
    python scripts/dump_schema_cards_fixture.py
"""
import json
from pathlib import Path

from app.services.schema_cards import get_schema_cards

# The only (standard, names) pairs the prompt-snapshot fixture cases need --
# <para> in S1000D 4.2 for its real 8-variant/enum-range shape (docs
# request's own edge case), <table> for the single-variant common case,
# <identAndStatusSection> for a card with no child common to all schemas
# ("fichas sin hijos comunes" round).
_REQUESTS = [
    ("S1000D 4.2", ["identAndStatusSection", "para", "table"]),
]

_OUT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "prompt-snapshot" / "schema-cards-fixture.json"


def main() -> None:
    out: dict[str, dict] = {}
    for standard, names in _REQUESTS:
        available, cards, unknown = get_schema_cards(standard, names)
        if not available or unknown:
            raise RuntimeError(f"Unexpected result for {standard}/{names}: available={available} unknown={unknown}")
        out[standard] = cards

    _OUT_PATH.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {_OUT_PATH}")


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # UTF-8 on any console or pipe, Windows included (Protecciones 1c)
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    main()
