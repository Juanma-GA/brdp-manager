"""Loads the S1000D 4.2 BRDP catalog that is in the repo
(sources/Issue 4.2 S1000D Business Rules Decision Points v4.8.xlsx, sheet
"ATX Propasal S1000D 4.2 BRDP": columns identifier / title / definition) into
brdp_catalog, for scripts/verify-rule-extract.mjs ("De catálogo" needs a
catalog; this environment has only a few test rows). Only identifiers not
already there are added, and the ones added are listed in a file in the
system's temp directory so `cleanup` removes exactly those and nothing else.

    cd backend && .venv/bin/python scripts/seed_extract_catalog_42.py
    cd backend && .venv/bin/python scripts/seed_extract_catalog_42.py cleanup
"""
import asyncio
import json
import sys
import tempfile
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.db.base import async_session_factory  # noqa: E402
from app.models import BRDPCatalog  # noqa: E402

STANDARD = "S1000D 4.2"
SOURCE = Path(__file__).resolve().parents[2] / "sources" / "Issue 4.2 S1000D Business Rules Decision Points v4.8.xlsx"
SHEET = "ATX Propasal S1000D 4.2 BRDP"
ADDED = Path(tempfile.gettempdir()) / "brdp-extract-catalog-42-added.json"


def _rows():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(SOURCE, read_only=True)
    for row in wb[SHEET].iter_rows(min_row=2, values_only=True):
        identifier, title, definition = (row[1] or "").strip(), row[2] or "", row[3] or ""
        if identifier:
            yield identifier, str(title).strip(), str(definition).replace("_x000D_", "").strip()


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
