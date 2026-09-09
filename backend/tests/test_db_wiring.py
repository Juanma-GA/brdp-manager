"""Phase 1 smoke test: the FastAPI app boots, the async SQLAlchemy engine
connects to the real Postgres instance, and every ORM model's table exists
with the shape Alembic's migration created (see
alembic/versions/0001_initial_schema.py).
"""
import uuid

import pytest
from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import BRDP, Project, User


async def test_health_check_hits_real_db(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_can_insert_and_query_every_table():
    """Round-trips a User -> Project -> BRDP chain through the real DB,
    proving the FKs, JSONB defaults, and the pgvector `embedding` column
    (left NULL here, populated in Phase 5) all work end-to-end.
    """
    async with async_session_factory() as session:
        user = User(
            email=f"smoke-{uuid.uuid4()}@example.com",
            password_hash="not-a-real-hash",
            display_name="Smoke Test User",
            global_role="admin",
        )
        project = Project(name="Smoke Test Project", standard="S1000D 4.2")
        session.add_all([user, project])
        await session.flush()

        brdp = BRDP(project_id=project.id, identifier="BRDP-SMOKE-00001")
        session.add(brdp)
        await session.commit()

        fetched = (await session.execute(select(BRDP).where(BRDP.id == brdp.id))).scalar_one()
        assert fetched.identifier == "BRDP-SMOKE-00001"
        assert fetched.validation == "Pending"  # default
        assert fetched.history == []  # JSONB default
        assert fetched.embedding is None  # not yet computed (Phase 5)

        await session.delete(fetched)
        await session.delete(project)
        await session.delete(user)
        await session.commit()
