"""Reads a BREX or Schematron file with the AI Extract code
(app/services/rule_extract.py: read_rules_file + build_candidates) and writes
its candidates as JSON on stdout: [{identifier, rule_xml, rule_count,
noncontext_count, warnings}], in file order. Used by the Node tests that
check the round trip original → AI Extract → Generate
(scripts/lib/extractRules.mjs).

    .venv/bin/python scripts/extract_rules_json.py <file> <format> <standard> [<issue>]

Always writes UTF-8 (a Windows console would default to cp1252).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.rule_extract import build_candidates, read_rules_file  # noqa: E402


def main() -> None:
    path, rule_format, standard = sys.argv[1:4]
    issue = sys.argv[4] if len(sys.argv) > 4 else None
    rf = read_rules_file(Path(path).read_bytes(), rule_format, standard)
    candidates, file_warnings = build_candidates(rf, issue)
    out = {
        "file_warnings": file_warnings,
        "candidates": [
            {
                "identifier": c["origin_identifier"],
                "rule_xml": c["rule_xml"],
                "rule_count": c["rule_count"],
                "noncontext_count": c["noncontext_count"],
                "warnings": c["warnings"],
            }
            for c in candidates
        ],
    }
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


main()
