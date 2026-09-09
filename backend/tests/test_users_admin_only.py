"""GET/POST /api/users and project-role assignment are admin-only
(docs/v2 §4.2: "solo admin"), regardless of any per-project role a
non-admin might hold.
"""
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import User


@pytest.fixture
async def non_admin_and_admin():
    async with async_session_factory() as session:
        non_admin = User(
            email=f"non-admin-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Non Admin",
            global_role="user",
        )
        admin = User(
            email=f"admin-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Admin",
            global_role="admin",
        )
        session.add_all([non_admin, admin])
        await session.commit()
        await session.refresh(non_admin)
        await session.refresh(admin)

    yield non_admin, admin

    async with async_session_factory() as session:
        for user in (non_admin, admin):
            db_user = await session.get(User, user.id)
            if db_user is not None:
                await session.delete(db_user)
        await session.commit()


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_non_admin_cannot_list_users(client, non_admin_and_admin):
    non_admin, _ = non_admin_and_admin
    response = await client.get("/api/users", headers=_headers(non_admin))
    assert response.status_code == 403


async def test_non_admin_cannot_create_users(client, non_admin_and_admin):
    non_admin, _ = non_admin_and_admin
    response = await client.post(
        "/api/users",
        json={"email": "new@example.com", "password": "x", "display_name": "New"},
        headers=_headers(non_admin),
    )
    assert response.status_code == 403


async def test_non_admin_cannot_assign_project_roles(client, non_admin_and_admin):
    non_admin, target = non_admin_and_admin
    response = await client.put(
        f"/api/users/{target.id}/project-roles",
        json={"project_id": str(uuid.uuid4()), "role": "editor"},
        headers=_headers(non_admin),
    )
    assert response.status_code == 403


async def test_admin_can_list_and_create_users(client, non_admin_and_admin):
    _, admin = non_admin_and_admin
    listed = await client.get("/api/users", headers=_headers(admin))
    assert listed.status_code == 200
    assert isinstance(listed.json(), list)

    created = await client.post(
        "/api/users",
        json={"email": f"created-{uuid.uuid4()}@example.com", "password": "x", "display_name": "Created"},
        headers=_headers(admin),
    )
    assert created.status_code == 201

    async with async_session_factory() as session:
        db_user = await session.get(User, uuid.UUID(created.json()["id"]))
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def test_creating_user_with_duplicate_email_conflicts(client, non_admin_and_admin):
    non_admin, admin = non_admin_and_admin
    response = await client.post(
        "/api/users",
        json={"email": non_admin.email, "password": "x", "display_name": "Dup"},
        headers=_headers(admin),
    )
    assert response.status_code == 409
