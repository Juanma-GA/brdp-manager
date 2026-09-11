"""Official BRDP catalog (docs request: new feature) + seeding a project
from it. Real Postgres. Catalog rows for these tests are created directly
in the DB under a throwaway standard string, rather than depending on or
polluting the real imported "BREX — S1000D 4.2" catalog (427 real rows,
imported by scripts/import_brdp_catalog.py and verified separately) --
keeps this file fast, isolated, and independent of that import having run.
"""
import uuid

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDPCatalog, Project, User


async def _make_user(global_role: str = "user") -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"catalog-test-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Catalog Test User",
            global_role=global_role,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _cleanup_user(user: User) -> None:
    async with async_session_factory() as session:
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def _cleanup_project(project_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        db_project = await session.get(Project, project_id)
        if db_project is not None:
            await session.delete(db_project)
            await session.commit()


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.fixture
async def catalog_rows():
    standard = f"Test Catalog Standard {uuid.uuid4()}"
    async with async_session_factory() as session:
        session.add_all(
            [
                BRDPCatalog(standard=standard, identifier="CAT-001", title="Cat Title 1", definition="Cat Def 1"),
                BRDPCatalog(standard=standard, identifier="CAT-002", title="Cat Title 2", definition="Cat Def 2"),
                BRDPCatalog(standard=standard, identifier="CAT-003", title="Cat Title 3", definition="Cat Def 3"),
            ]
        )
        await session.commit()
    yield standard
    async with async_session_factory() as session:
        rows = (await session.execute(select(BRDPCatalog).where(BRDPCatalog.standard == standard))).scalars().all()
        for row in rows:
            await session.delete(row)
        await session.commit()


async def test_catalog_count_reflects_real_rows(client, catalog_rows):
    user = await _make_user()
    try:
        response = await client.get(f"/api/brdp-catalog/count?standard={catalog_rows}", headers=_headers(user))
        assert response.status_code == 200
        assert response.json() == {"standard": catalog_rows, "count": 3}
    finally:
        await _cleanup_user(user)


async def test_catalog_count_is_zero_for_a_standard_with_no_rows(client):
    user = await _make_user()
    try:
        response = await client.get(
            f"/api/brdp-catalog/count?standard=Nonexistent Standard {uuid.uuid4()}", headers=_headers(user)
        )
        assert response.status_code == 200
        assert response.json()["count"] == 0
    finally:
        await _cleanup_user(user)


async def test_list_catalog_entries_returns_identifier_title_definition(client, catalog_rows):
    user = await _make_user()
    try:
        response = await client.get(f"/api/brdp-catalog?standard={catalog_rows}", headers=_headers(user))
        assert response.status_code == 200
        entries = response.json()
        assert len(entries) == 3
        assert {e["identifier"] for e in entries} == {"CAT-001", "CAT-002", "CAT-003"}
        by_id = {e["identifier"]: e for e in entries}
        assert by_id["CAT-001"]["title"] == "Cat Title 1"
        assert by_id["CAT-001"]["definition"] == "Cat Def 1"
    finally:
        await _cleanup_user(user)


async def test_viewer_role_can_read_catalog_endpoints(client, catalog_rows):
    """Catalog data is global reference data, not project-scoped -- any
    authenticated user (viewer included, no project role at all needed)
    can read it.
    """
    user = await _make_user(global_role="user")
    try:
        count_response = await client.get(f"/api/brdp-catalog/count?standard={catalog_rows}", headers=_headers(user))
        list_response = await client.get(f"/api/brdp-catalog?standard={catalog_rows}", headers=_headers(user))
        assert count_response.status_code == 200
        assert list_response.status_code == 200
    finally:
        await _cleanup_user(user)


async def test_create_project_with_seed_from_catalog_creates_real_brdps(client, catalog_rows):
    admin = await _make_user(global_role="admin")
    created_id = None
    try:
        response = await client.post(
            "/api/projects",
            json={"name": f"Seeded Project {uuid.uuid4()}", "standard": catalog_rows, "seed_from_catalog": True},
            headers=_headers(admin),
        )
        assert response.status_code == 201
        created_id = uuid.UUID(response.json()["id"])

        brdps = (await client.get(f"/api/projects/{created_id}/brdps", headers=_headers(admin))).json()
        assert len(brdps) == 3
        assert {b["identifier"] for b in brdps} == {"CAT-001", "CAT-002", "CAT-003"}
        seeded = next(b for b in brdps if b["identifier"] == "CAT-001")
        assert seeded["title"] == "Cat Title 1"
        assert seeded["definition"] == "Cat Def 1"
        assert seeded["proposal"] == ""
        assert seeded["validation"] == "Pending"
    finally:
        if created_id is not None:
            await _cleanup_project(created_id)
        await _cleanup_user(admin)


async def test_create_project_without_seed_flag_creates_no_brdps(client, catalog_rows):
    admin = await _make_user(global_role="admin")
    created_id = None
    try:
        response = await client.post(
            "/api/projects",
            json={"name": f"Unseeded Project {uuid.uuid4()}", "standard": catalog_rows},
            headers=_headers(admin),
        )
        assert response.status_code == 201
        created_id = uuid.UUID(response.json()["id"])
        brdps = (await client.get(f"/api/projects/{created_id}/brdps", headers=_headers(admin))).json()
        assert brdps == []
    finally:
        if created_id is not None:
            await _cleanup_project(created_id)
        await _cleanup_user(admin)


async def test_seed_from_catalog_is_noop_for_standard_with_no_catalog_rows(client):
    admin = await _make_user(global_role="admin")
    created_id = None
    try:
        response = await client.post(
            "/api/projects",
            json={
                "name": f"No Catalog Project {uuid.uuid4()}",
                "standard": f"Standard With No Catalog {uuid.uuid4()}",
                "seed_from_catalog": True,
            },
            headers=_headers(admin),
        )
        assert response.status_code == 201
        created_id = uuid.UUID(response.json()["id"])
        brdps = (await client.get(f"/api/projects/{created_id}/brdps", headers=_headers(admin))).json()
        assert brdps == []
    finally:
        if created_id is not None:
            await _cleanup_project(created_id)
        await _cleanup_user(admin)
