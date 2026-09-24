"""One-off: seed 2 BRDPCatalog rows for S1000D 4.2 directly in Postgres,
so the "+ Compare with another BRDP" search in Ask a Question has a real
Catalog-sourced result to pick in this sandbox -- this environment has no
real imported catalog for any standard (GET /api/brdp-catalog/count is 0
everywhere, confirmed before writing this), so the picker's Catalog half
is otherwise untestable here. Rerunning wipes and recreates the two rows
this script owns (fixed identifiers below), so it's safe to reuse; pass
"cleanup" to remove them instead of seeding.

    cd backend && python scripts/seed_ask_compare_catalog.py [cleanup]
"""
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, select

from app.db.base import async_session_factory
from app.models import BRDPCatalog

STANDARD = "S1000D 4.2"
ENTRIES = [
    ("BRDP-CAT-ASKTEST-001", "Catalog: fastener torque values", "Catalog reference definition about fastener torque values for structural panels."),
    ("BRDP-CAT-ASKTEST-002", "Catalog: corrosion inspection interval", "Catalog reference definition about corrosion inspection intervals for exterior skin panels."),
]


async def main():
    cleanup = len(sys.argv) > 1 and sys.argv[1] == "cleanup"
    async with async_session_factory() as db:
        identifiers = [e[0] for e in ENTRIES]
        existing = (
            await db.execute(
                select(BRDPCatalog).where(BRDPCatalog.standard == STANDARD, BRDPCatalog.identifier.in_(identifiers))
            )
        ).scalars().all()
        for row in existing:
            await db.delete(row)
        await db.commit()

        if cleanup:
            print(f"Removed {len(existing)} seeded catalog rows.")
            return

        for identifier, title, definition in ENTRIES:
            db.add(BRDPCatalog(id=uuid.uuid4(), standard=STANDARD, identifier=identifier, title=title, definition=definition))
        await db.commit()
        print(f"Seeded {len(ENTRIES)} catalog rows for {STANDARD}.")


if __name__ == "__main__":
    asyncio.run(main())
