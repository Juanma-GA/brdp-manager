"""One-off catalog rows for scripts/verify-remates-b.mjs (Remates B,
Part 2): three identifiers that exist in only one catalog edition each --
BRDP-S1-99001 in S1000D 4.1, BRDP-S1-99002 in S1000D 5.0 and
BRDP-S1-99003 in S1000D 4.2 -- so a 4.2 project sees one "From catalog"
row and "From catalog (another edition)" rows of one or two editions.

Rerunning wipes and recreates what this script owns; "cleanup" only
removes it (rows carrying MARK in their definition; a real catalog row is
never touched).

    cd backend && python scripts/seed_remates_b_catalog.py [cleanup]
"""
import asyncio
import json
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):  # UTF-8 on any console or pipe, Windows included (Protecciones 1c)
    _stream.reconfigure(encoding="utf-8", errors="backslashreplace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete

from app.db.base import async_session_factory
from app.models import BRDPCatalog

MARK = "Seeded by seed_remates_b_catalog.py"
ROWS = [
    ("S1000D 4.1", "BRDP-S1-99001", "Torque values in tables", "Decide how torque values are given in tables."),
    ("S1000D 5.0", "BRDP-S1-99002", "Warning colours", "Decide which colours warnings use."),
    ("S1000D 4.2", "BRDP-S1-99003", "Step numbering", "Decide how procedural steps are numbered."),
]


async def main():
    cleanup = len(sys.argv) > 1 and sys.argv[1] == "cleanup"
    async with async_session_factory() as db:
        await db.execute(delete(BRDPCatalog).where(BRDPCatalog.definition.like(f"%{MARK}%")))
        if not cleanup:
            for standard, identifier, title, definition in ROWS:
                db.add(BRDPCatalog(standard=standard, identifier=identifier, title=title, definition=f"{definition} ({MARK})"))
        await db.commit()
    print(json.dumps({"cleaned": True} if cleanup else {"seeded": [r[1] for r in ROWS]}))


asyncio.run(main())
