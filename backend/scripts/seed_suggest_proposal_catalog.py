"""One-off: seed 1 BRDPCatalog row for S1000D 4.2 directly in Postgres, so
the Suggest Proposal corpus round's live verification script has a real
catalog-issued identifier to reuse across several projects for the "Same
BRDP in other projects" group (docs request -- that group is gated on the
identifier existing in brdp_catalog, an EXT-style auto-generated id could
coincidentally collide across two unrelated projects). Same convention as
seed_suggest_definition_catalog.py/seed_ask_compare_catalog.py: rerunning
wipes and recreates the row this script owns (fixed identifier below), so
it's safe to reuse; pass "cleanup" to remove it instead of seeding.

    cd backend && python scripts/seed_suggest_proposal_catalog.py [cleanup]
"""
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import BRDPCatalog

STANDARD = "S1000D 4.2"
IDENTIFIER = "BRDP-SPCAT-LIVE-001"
TITLE = "Catalog: fuel line clamp spacing"
DEFINITION = "Official catalog definition about the maximum spacing allowed between fuel line clamps."


async def main():
    cleanup = len(sys.argv) > 1 and sys.argv[1] == "cleanup"
    async with async_session_factory() as db:
        existing = (
            await db.execute(
                select(BRDPCatalog).where(BRDPCatalog.standard == STANDARD, BRDPCatalog.identifier == IDENTIFIER)
            )
        ).scalars().all()
        for row in existing:
            await db.delete(row)
        await db.commit()

        if cleanup:
            print(f"Removed {len(existing)} seeded catalog row(s).")
            return

        db.add(BRDPCatalog(id=uuid.uuid4(), standard=STANDARD, identifier=IDENTIFIER, title=TITLE, definition=DEFINITION))
        await db.commit()
        print(f"Seeded 1 catalog row ({IDENTIFIER}) for {STANDARD}.")


if __name__ == "__main__":
    asyncio.run(main())
