"""A STAND-IN S1000D 4.1 catalog for verifying AI Extract's "From catalog
(S1000D 4.1)" in this environment. The real 4.1 catalog (552 identifiers in
the user's database) is NOT in the repo, so this builds one with the shape
the user described: the 427 identifiers of the 4.2 catalog in sources/
(same number, same decision -- Title and Definition copied from 4.2), plus
every BRDP-S1 identifier of the "CA" BREX fixture that the 4.2 catalog does
not have (108), with a Title and Definition that say they are stand-ins.
Only identifiers not already in brdp_catalog for S1000D 4.1 are added; the
ones added are listed in a file in the system's temp directory so `cleanup`
removes exactly those.

    cd backend && .venv/bin/python scripts/seed_extract_catalog_41.py
    cd backend && .venv/bin/python scripts/seed_extract_catalog_41.py cleanup
"""
import asyncio
import json
import re
import sys
import tempfile
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.db.base import async_session_factory  # noqa: E402
from app.models import BRDPCatalog  # noqa: E402

STANDARD = "S1000D 4.1"
ROOT = Path(__file__).resolve().parents[2]
SOURCE_42 = ROOT / "sources" / "Issue 4.2 S1000D Business Rules Decision Points v4.8.xlsx"
SHEET = "ATX Propasal S1000D 4.2 BRDP"
CA = ROOT / "backend" / "tests" / "fixtures" / "brex" / "DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml"
ADDED = Path(tempfile.gettempdir()) / "brdp-extract-catalog-41-added.json"


def _rows():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(SOURCE_42, read_only=True)
    known = set()
    for row in wb[SHEET].iter_rows(min_row=2, values_only=True):
        identifier, title, definition = (row[1] or "").strip(), row[2] or "", row[3] or ""
        if identifier:
            known.add(identifier)
            yield identifier, str(title).strip(), str(definition).replace("_x000D_", "").strip()
    ca_ids = sorted(set(re.findall(r'brDecisionIdentNumber="(BRDP-S1-\d{5})"', CA.read_text(encoding="utf-8"))))
    for identifier in ca_ids:
        if identifier not in known:
            yield (
                identifier,
                f"Stand-in 4.1 title of {identifier}",
                f"Stand-in 4.1 definition of {identifier} (the real S1000D 4.1 catalog is not in this repo).",
            )


async def main(cleanup: bool) -> None:
    async with async_session_factory() as db:
        if cleanup:
            added = json.loads(ADDED.read_text()) if ADDED.exists() else []
            if added:
                await db.execute(delete(BRDPCatalog).where(BRDPCatalog.standard == STANDARD, BRDPCatalog.identifier.in_(added)))
                await db.commit()
            ADDED.unlink(missing_ok=True)
            print(f"Removed {len(added)} catalog rows")
            return
        present = set((await db.execute(select(BRDPCatalog.identifier).where(BRDPCatalog.standard == STANDARD))).scalars())
        previous = json.loads(ADDED.read_text()) if ADDED.exists() else []
        added = []
        for identifier, title, definition in _rows():
            if identifier in present or identifier in added:
                continue
            db.add(BRDPCatalog(standard=STANDARD, identifier=identifier, title=title, definition=definition))
            added.append(identifier)
        await db.commit()
        ADDED.write_text(json.dumps(previous + added))
        print(f"Added {len(added)} catalog rows ({len(present)} were already there)")


asyncio.run(main(len(sys.argv) > 1 and sys.argv[1] == "cleanup"))
