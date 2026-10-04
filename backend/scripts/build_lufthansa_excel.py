"""Writes an Excel import file (the 7 columns of Export to Excel) with one
row per BRDP of the real Lufthansa BREX in tests/fixtures/brex/ (502 rows,
every one an official BRDP-S1 identifier): Title "Lufthansa title …",
Definition/Proposal from the file's decision texts (or a placeholder),
Proposal Status Validated, Rule Status Draft and the BRDP's rule. Stands in
for the project's own Excel (not in this repository) to check the Excel
import against the S1000D 4.2 and 4.1 catalogs.

    python scripts/build_lufthansa_excel.py OUT.xlsx
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.services.excel_io import build_export_workbook  # noqa: E402
from app.services.rule_extract import build_candidates, read_rules_file  # noqa: E402

LUFTHANSA = ROOT / "tests" / "fixtures" / "brex" / "DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml"


def main(out: str) -> None:
    rf = read_rules_file(LUFTHANSA.read_bytes(), "BREX-4.2", "S1000D 4.2")
    candidates, _warnings = build_candidates(rf, "4.2")
    rows = []
    for c in candidates:
        identifier = c["origin_identifier"]
        literal = c.get("literal") or {}
        rows.append({
            "id": identifier,
            "title": f"Lufthansa title {identifier}",
            "definition": literal.get("definition") or f"Lufthansa definition {identifier}",
            "proposal": literal.get("proposal") or f"Lufthansa proposal {identifier}",
            "proposalStatus": "Validated",
            "ruleStatus": "Draft" if c.get("rule_xml") and not c.get("rule_problem") else "To Do",
            "rule": c["rule_xml"] if c.get("rule_xml") and not c.get("rule_problem") else "",
        })
    Path(out).write_bytes(build_export_workbook(rows))
    print(f"{len(rows)} rows -> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
