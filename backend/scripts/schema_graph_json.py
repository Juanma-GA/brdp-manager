"""A standard's whole element graph as JSON -- for the Node scripts in
scripts/ (rule lint of the curated templates and of stored rules, the path
check's tests), so they check rule paths against exactly what
GET /api/schema-cards/graph serves (app/services/rule_test_skeletons.py,
get_standard_graph). No database, no server.

    cd backend && .venv/bin/python scripts/schema_graph_json.py "S1000D 3.0.1"

The Node side is scripts/lib/schemaGraph.mjs.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.rule_test_skeletons import get_standard_graph


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: schema_graph_json.py <standard>", file=sys.stderr)
        sys.exit(2)
    sys.stdout.buffer.write(json.dumps(get_standard_graph(sys.argv[1]), separators=(",", ":")).encode("utf-8"))


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # UTF-8 on any console or pipe, Windows included (Protecciones 1c)
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    main()
