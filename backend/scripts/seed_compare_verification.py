"""One-off fixtures for scripts/verify-brdp-compare.mjs ("Comparar dos BRDP
lado a lado"): an official catalog row BRDP-S1-00052 for S1000D 4.2 and
BRDP-D1-CMP-001 for DITA 1.3 Xpath2.0 (the comparison only searches other
projects for a catalog identifier), and a viewer account with a known
password (no forced password change) to check that a viewer sees the
comparison without the "Use this…" buttons. The projects themselves are
created by the verification script through the API.

Rerunning wipes and recreates what this script owns; "cleanup" only
removes it. Catalog rows that already existed before (a real catalog) are
never touched: the script records whether it created them.

    cd backend && python scripts/seed_compare_verification.py [cleanup]
"""
import asyncio
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.core.security import hash_password
from app.db.base import async_session_factory
from app.models import BRDPCatalog, User

CATALOG = [
    ("S1000D 4.2", "BRDP-S1-00052", "Information codes", "Decide which information codes are used in the project."),
    ("DITA 1.3 Xpath2.0", "BRDP-D1-CMP-001", "Note types", "Decide which note types are used in the project."),
]
MARK = "Seeded by seed_compare_verification.py"
VIEWER_EMAIL = "compare-viewer@example.com"
VIEWER_PASSWORD = "CompareViewer123!"


async def main():
    cleanup = len(sys.argv) > 1 and sys.argv[1] == "cleanup"
    async with async_session_factory() as db:
        for standard, identifier, _title, _definition in CATALOG:
            rows = (
                await db.execute(
                    select(BRDPCatalog).where(
                        BRDPCatalog.standard == standard,
                        BRDPCatalog.identifier == identifier,
                        BRDPCatalog.definition.like(f"%{MARK}%"),
                    )
                )
            ).scalars().all()
            for row in rows:
                await db.delete(row)
        viewer = (await db.execute(select(User).where(User.email == VIEWER_EMAIL))).scalar_one_or_none()
        if viewer is not None:
            await db.delete(viewer)
        await db.commit()
        if cleanup:
            print(json.dumps({"cleaned": True}))
            return

        for standard, identifier, title, definition in CATALOG:
            exists = (
                await db.execute(select(BRDPCatalog).where(BRDPCatalog.standard == standard, BRDPCatalog.identifier == identifier))
            ).scalar_one_or_none()
            if exists is None:
                db.add(BRDPCatalog(id=uuid.uuid4(), standard=standard, identifier=identifier, title=title, definition=f"{definition} ({MARK})"))
        viewer = User(
            email=VIEWER_EMAIL,
            password_hash=hash_password(VIEWER_PASSWORD),
            display_name="Compare viewer",
            global_role="user",
            must_change_password=False,
        )
        db.add(viewer)
        await db.commit()
        print(json.dumps({"viewer_id": str(viewer.id), "viewer_email": VIEWER_EMAIL, "viewer_password": VIEWER_PASSWORD}))


if __name__ == "__main__":
    asyncio.run(main())
