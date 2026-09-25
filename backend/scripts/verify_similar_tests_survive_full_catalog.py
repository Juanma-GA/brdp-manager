"""One-off robustness check for the "tests que dependen de los datos
existentes" round (docs request): seeds ADVERSARIAL real data -- a
project + several Validated BRDPs + catalog rows for EVERY real standard
(S1000D 3.0.1/4.1/4.2/5.0/6.0, DITA 1.3 Xpath2.0/Xpath3.0), all with
embeddings deliberately set to the EXACT same vector every mocked query
embedding in test_similar.py/test_embedding_jobs.py/test_brdp_trash.py
uses ([1.0, 0, ...] a.k.a. _SAME_DIRECTION, plus [0.1]*1024 for the trash
precedent test) -- the worst case that would break any lingering test
still assuming "no other real data for this standard, similarity ~0".

Usage:
    python scripts/verify_similar_tests_survive_full_catalog.py seed
    python -m pytest -q                                    # full suite
    python scripts/verify_similar_tests_survive_full_catalog.py cleanup

Not meant to stay seeded -- self-cleans via its own `cleanup` command,
same convention as seed_sopte_scale_verification.py /
seed_alignment_check_projects.py.
"""
import asyncio
import sys
import uuid

from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, Project

_REAL_STANDARDS = [
    "S1000D 3.0.1",
    "S1000D 4.1",
    "S1000D 4.2",
    "S1000D 5.0",
    "S1000D 6.0",
    "DITA 1.3 Xpath2.0",
    "DITA 1.3 Xpath3.0",
]

_MARKER = "ADVERSARIAL-CATALOG-CHECK"
_SAME_DIRECTION = [1.0] + [0.0] * 1023
_TRASH_QUERY_VECTOR = [0.1] * 1024


async def seed():
    async with async_session_factory() as session:
        for standard in _REAL_STANDARDS:
            project = Project(name=f"{_MARKER} {standard} {uuid.uuid4()}", standard=standard)
            session.add(project)
            await session.flush()
            for i in range(5):
                session.add(
                    BRDP(
                        project_id=project.id,
                        identifier=f"BRDP-{_MARKER}-{i}",
                        title=f"{_MARKER} title {i}",
                        definition=f"{_MARKER} definition {i}",
                        proposal=f"{_MARKER} proposal {i}",
                        validation="Validated",
                        embedding=_SAME_DIRECTION,
                    )
                )
                session.add(
                    BRDP(
                        project_id=project.id,
                        identifier=f"BRDP-{_MARKER}-TRASHVEC-{i}",
                        title=f"{_MARKER} trash-vector title {i}",
                        definition=f"{_MARKER} trash-vector definition {i}",
                        proposal=f"{_MARKER} trash-vector proposal {i}",
                        validation="Validated",
                        embedding=_TRASH_QUERY_VECTOR,
                    )
                )
            for i in range(5):
                session.add(
                    BRDPCatalog(
                        standard=standard,
                        identifier=f"BRDP-{_MARKER}-CAT-{i}",
                        title=f"{_MARKER} catalog title {i}",
                        definition=f"{_MARKER} catalog definition {i}",
                        embedding=_SAME_DIRECTION,
                    )
                )
        await session.commit()
    print(f"Seeded {len(_REAL_STANDARDS)} adversarial projects (5 Validated BRDPs + 5 trash-vector BRDPs each) "
          f"and {len(_REAL_STANDARDS) * 5} catalog rows, one set per real standard.")


async def cleanup():
    async with async_session_factory() as session:
        from sqlalchemy import delete

        result = await session.execute(delete(Project).where(Project.name.like(f"{_MARKER}%")))
        catalog_result = await session.execute(delete(BRDPCatalog).where(BRDPCatalog.identifier.like(f"BRDP-{_MARKER}-CAT-%")))
        await session.commit()
        print(f"Deleted {result.rowcount} adversarial projects (BRDPs cascade) and {catalog_result.rowcount} catalog rows.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "seed"
    asyncio.run({"seed": seed, "cleanup": cleanup}[cmd]())
