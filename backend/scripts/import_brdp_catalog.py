"""One-off import: load an official BRDP catalog spreadsheet into the
brdp_catalog table for a given standard (docs request -- new "official
catalog per standard" feature). Same pattern as create_admin_user.py/
seed_dev_data.py:

    cd backend && python scripts/import_brdp_catalog.py <path.xlsx> "<standard>"

Example:
    python scripts/import_brdp_catalog.py catalog_sources/s1000d_4.2.xlsx "BREX — S1000D 4.2"

Reads the "Auto-gen Decisions" sheet, columns ID / Title / Definition
(header row 1, data from row 2), skipping any row whose ID cell is
blank rather than stopping at the first one -- the 4.2 source file only
has blank IDs as ~2300 trailing rows after the real data, but the 4.1
source file has 228 blank-ID "No BRDP" rows INTERSPERSED between real
rows (552 real rows total, confirmed against the real file), so
stopping at the first blank would import nothing. Skipping uniformly
handles both shapes: 4.2's trailing blanks are just skipped as a block,
same net result as before. "_x000D_" is a leaked, literal Windows CR
escape that shows up throughout Definition text in the source file
(visible garbage if inserted as-is) -- normalized to a real newline here.

Idempotent: upserts by (standard, identifier) rather than inserting
blindly, so re-running the same file never duplicates rows -- confirmed
by running twice against the real file (see this round's closure
evidence).
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl
from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import BRDPCatalog

SHEET_NAME = "Auto-gen Decisions"

# Mirrors the 7 exact standards ProjectsPage.jsx's STANDARD_OPTIONS offers
# (docs/v2 §2) -- kept in sync manually, same as this project's other
# cross-file standard lists (e.g. STANDARD_TO_RULE_FORMAT). A typo'd
# standard here would silently create an orphan catalog no project could
# ever match, so this is checked rather than trusted blindly.
_KNOWN_STANDARDS = {
    "BREX — S1000D 3.0.1",
    "BREX — S1000D 4.1",
    "BREX — S1000D 4.2",
    "BREX — S1000D 5.0",
    "BREX — S1000D 6.0",
    "Schematron 1.0 — S1000D",
    "Schematron 1.0 — DITA",
}


def _clean(value) -> str:
    if value is None:
        return ""
    return str(value).replace("_x000D_", "\n").strip()


def _read_rows(xlsx_path: Path) -> list[tuple[str, str, str]]:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    if SHEET_NAME not in wb.sheetnames:
        print(f"Sheet {SHEET_NAME!r} not found. Sheets in file: {wb.sheetnames}", file=sys.stderr)
        sys.exit(1)
    ws = wb[SHEET_NAME]

    rows = []
    for row in ws.iter_rows(min_row=2, max_col=3, values_only=True):
        identifier = row[0]
        if identifier is None or str(identifier).strip() == "":
            continue  # blank-ID row (a "No BRDP" filler row, or trailing blank) -- skip, don't stop
        rows.append((str(identifier).strip(), _clean(row[1]), _clean(row[2])))
    return rows


async def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: python {sys.argv[0]} <path.xlsx> \"<standard>\"", file=sys.stderr)
        sys.exit(1)

    xlsx_path = Path(sys.argv[1])
    standard = sys.argv[2]

    if not xlsx_path.is_file():
        print(f"File not found: {xlsx_path}", file=sys.stderr)
        sys.exit(1)
    if standard not in _KNOWN_STANDARDS:
        print(
            f"{standard!r} is not one of the 7 canonical standards: {sorted(_KNOWN_STANDARDS)}",
            file=sys.stderr,
        )
        sys.exit(1)

    rows = _read_rows(xlsx_path)
    if not rows:
        print("No data rows found -- nothing to import.", file=sys.stderr)
        sys.exit(1)

    created = 0
    updated = 0
    async with async_session_factory() as session:
        for identifier, title, definition in rows:
            existing = (
                await session.execute(
                    select(BRDPCatalog).where(
                        BRDPCatalog.standard == standard, BRDPCatalog.identifier == identifier
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                session.add(BRDPCatalog(standard=standard, identifier=identifier, title=title, definition=definition))
                created += 1
            else:
                existing.title = title
                existing.definition = definition
                updated += 1
        await session.commit()

    print(f"Imported {len(rows)} rows for {standard!r}: {created} created, {updated} updated (upsert).")


if __name__ == "__main__":
    asyncio.run(main())
