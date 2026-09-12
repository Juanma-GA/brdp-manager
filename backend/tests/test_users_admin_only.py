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
        json={"email": "new@example.com", "display_name": "New"},
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


async def test_non_admin_cannot_patch_another_user(client, non_admin_and_admin):
    non_admin, target = non_admin_and_admin
    response = await client.patch(
        f"/api/users/{target.id}",
        json={"email": target.email, "display_name": "Hacked Name"},
        headers=_headers(non_admin),
    )
    assert response.status_code == 403


async def test_non_admin_cannot_delete_another_user(client, non_admin_and_admin):
    non_admin, target = non_admin_and_admin
    response = await client.delete(f"/api/users/{target.id}", headers=_headers(non_admin))
    assert response.status_code == 403


async def test_admin_can_list_and_create_users(client, non_admin_and_admin):
    _, admin = non_admin_and_admin
    listed = await client.get("/api/users", headers=_headers(admin))
    assert listed.status_code == 200
    assert isinstance(listed.json(), list)

    created = await client.post(
        "/api/users",
        json={"email": f"created-{uuid.uuid4()}@example.com", "display_name": "Created"},
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
        json={"email": non_admin.email, "display_name": "Dup"},
        headers=_headers(admin),
    )
    assert response.status_code == 409


async def test_create_user_generates_a_real_random_temporary_password(client, non_admin_and_admin):
    """docs request: no fixed value like "1234" -- must be a real,
    cryptographically random temporary, at least 12 characters, returned
    in plaintext exactly once, and different on every call. Also confirms
    the account starts with must_change_password=True and that the
    temporary actually logs in.
    """
    _, admin = non_admin_and_admin
    email = f"created-{uuid.uuid4()}@example.com"
    created_id = None
    try:
        response = await client.post(
            "/api/users", json={"email": email, "display_name": "Created"}, headers=_headers(admin)
        )
        assert response.status_code == 201
        body = response.json()
        created_id = uuid.UUID(body["id"])
        temp1 = body["temporary_password"]
        assert temp1
        assert len(temp1) >= 12
        assert temp1 != "1234"
        assert body["must_change_password"] is True

        login = await client.post("/api/auth/login", json={"email": email, "password": temp1})
        assert login.status_code == 200

        # A second user's temporary must not be the same string -- proves
        # this is genuinely randomized per call, not a constant in disguise.
        other = await client.post(
            "/api/users",
            json={"email": f"created-{uuid.uuid4()}@example.com", "display_name": "Created 2"},
            headers=_headers(admin),
        )
        assert other.status_code == 201
        temp2 = other.json()["temporary_password"]
        assert temp2 != temp1

        async with async_session_factory() as session:
            db_user = await session.get(User, uuid.UUID(other.json()["id"]))
            if db_user is not None:
                await session.delete(db_user)
                await session.commit()
    finally:
        if created_id is not None:
            async with async_session_factory() as session:
                db_user = await session.get(User, created_id)
                if db_user is not None:
                    await session.delete(db_user)
                    await session.commit()


async def test_non_admin_cannot_reset_another_users_password(client, non_admin_and_admin):
    non_admin, target = non_admin_and_admin
    response = await client.post(f"/api/users/{target.id}/reset-password", headers=_headers(non_admin))
    assert response.status_code == 403


async def test_admin_reset_password_issues_new_random_temporary_and_forces_change(client, non_admin_and_admin):
    non_admin, admin = non_admin_and_admin
    original_email = non_admin.email

    reset1 = await client.post(f"/api/users/{non_admin.id}/reset-password", headers=_headers(admin))
    assert reset1.status_code == 200
    temp1 = reset1.json()["temporary_password"]
    assert temp1
    assert len(temp1) >= 12
    assert temp1 != "1234"

    # The old (fixture-set) password no longer works; the new temporary does.
    old_login = await client.post("/api/auth/login", json={"email": original_email, "password": "irrelevant-password"})
    assert old_login.status_code == 401
    new_login = await client.post("/api/auth/login", json={"email": original_email, "password": temp1})
    assert new_login.status_code == 200

    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {new_login.json()['access_token']}"})
    assert me.json()["must_change_password"] is True

    # Resetting again gives a genuinely different temporary, not the same
    # one replayed.
    reset2 = await client.post(f"/api/users/{non_admin.id}/reset-password", headers=_headers(admin))
    assert reset2.status_code == 200
    assert reset2.json()["temporary_password"] != temp1


async def test_admin_reset_password_revokes_the_users_existing_sessions(client, non_admin_and_admin):
    """Unlike self-service change-password, there is no "current session
    to exclude" here -- an admin resetting someone else's password must
    revoke ALL of that user's active refresh tokens, unconditionally.
    """
    non_admin, admin = non_admin_and_admin
    login = await client.post(
        "/api/auth/login", json={"email": non_admin.email, "password": "irrelevant-password"}
    )
    assert login.status_code == 200
    refresh_token = login.json()["refresh_token"]

    reset = await client.post(f"/api/users/{non_admin.id}/reset-password", headers=_headers(admin))
    assert reset.status_code == 200

    refresh_attempt = await client.post("/api/auth/refresh", json={"refresh_token": refresh_token})
    assert refresh_attempt.status_code == 401
