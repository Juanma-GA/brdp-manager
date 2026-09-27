"""Verified rules from the curated per-standard Excel templates (the same
files "Download Excel template" serves from public/) -- Suggest Rule's
last-resort `template_fallback` group, used only when a standard has too
few real Verified rules of its own to show the LLM what its rule format
can express.

The standard -> file mapping mirrors src/utils/excelUtils.js's
CURATED_TEMPLATE_BY_STANDARD exactly (same pattern as
rule_formats.py/ruleFormats.js); tests/test_standard_consistency.py fails
if the two ever drift.
"""
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import openpyxl
from openpyxl.utils.escape import unescape

PUBLIC_DIR = Path(__file__).resolve().parents[3] / "public"

CURATED_TEMPLATE_BY_STANDARD = {
    "S1000D 3.0.1": "brdp-template-3-0-1.xlsx",
    "S1000D 4.1": "brdp-template-4-1.xlsx",
    "S1000D 4.2": "brdp-template-4-2.xlsx",
    "DITA 1.3 Xpath2.0": "brdp-template-dita-xpath2.xlsx",
    "DITA 1.3 Xpath3.0": "brdp-template-dita-xpath3.xlsx",
}


@dataclass(frozen=True)
class TemplateRule:
    identifier: str
    title: str
    definition: str
    proposal: str
    rule_xml: str


@lru_cache(maxsize=None)
def _load_file(filename: str) -> tuple[TemplateRule, ...]:
    workbook = openpyxl.load_workbook(PUBLIC_DIR / filename, read_only=True)
    try:
        rows = list(workbook.active.iter_rows(values_only=True))
    finally:
        workbook.close()
    if not rows:
        return ()
    header = [str(h).strip() if h is not None else "" for h in rows[0]]
    out: list[TemplateRule] = []
    for raw in rows[1:]:
        # openpyxl hands back Excel's own escapes verbatim ("_x000d_" for a
        # CR inside a cell) -- decoded here, then CRLF normalized, so the
        # rule text reaches the prompt exactly as it reads in Excel.
        row = {
            name: ("" if value is None else unescape(str(value)).replace("\r\n", "\n").replace("\r", "\n"))
            for name, value in zip(header, raw)
        }
        if row.get("Rule Status", "").strip() != "Verified" or not row.get("Rule", "").strip():
            continue
        out.append(
            TemplateRule(
                identifier=row.get("ID", "").strip(),
                title=row.get("Title", "").strip(),
                definition=row.get("Definition", "").strip(),
                proposal=row.get("Proposal", "").strip(),
                rule_xml=row["Rule"].strip(),
            )
        )
    return tuple(out)


def load_template_rules(standard: str) -> list[TemplateRule]:
    """Verified rows of `standard`'s curated template, in file order (the
    files are curated easy -> medium -> hard). Empty for a standard with no
    curated template (S1000D 5.0/6.0).
    """
    filename = CURATED_TEMPLATE_BY_STANDARD.get(standard)
    if filename is None:
        return []
    return list(_load_file(filename))
