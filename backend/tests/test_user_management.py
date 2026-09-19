"""Functional correctness for PATCH/DELETE /api/users/{id} -- authorization
(admin-only) is covered separately in test_users_admin_only.py. Real
Postgres, no mocking.

Both delete guards get their own dedicated, distinguishable test: given
only an admin can ever call this endpoint, "delete the last remaining
admin" is only ever reachable as an admin deleting THEMSELVES while they
are that last admin (proven below: if the target is admin and the total
admin count is <=1, the target must be the caller, since the caller is
always counted as an admin to have reached this code at all). The route
checks that case first specifically so its response is distinguishable
from the plain "admin cannot delete self while other admins exist" case --
both are exercised here with their own assertion on the response detail,
not just a shared 400.
"""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import RefreshToken, User


async def _make_user(global_role: str = "user", display_name: str = "Test User") -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"usermgmt-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name=display_name,
            global_role=global_role,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _delete_user_row(user_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        db_user = await session.get(User, user_id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def test_admin_can_update_another_users_email_and_display_name(client):
    admin = await _make_user(global_role="admin")
    target = await _make_user(display_name="Original Name")
    new_email = f"renamed-{uuid.uuid4()}@example.com"
    try:
        response = await client.patch(
            f"/api/users/{target.id}",
            json={"email": new_email, "display_name": "Updated Name"},
            headers=_headers(admin),
        )
        assert response.status_code == 200
        body = response.json()
        assert body["email"] == new_email
        assert body["display_name"] == "Updated Name"
        # global_role untouched -- UserUpdate has no such field at all.
        assert body["global_role"] == "user"

        async with async_session_factory() as session:
            db_user = await session.get(User, target.id)
            assert db_user.email == new_email
            assert db_user.display_name == "Updated Name"
    finally:
        await _delete_user_row(admin.id)
        await _delete_user_row(target.id)


async def test_update_user_rejects_duplicate_email(client):
    admin = await _make_user(global_role="admin")
    user_a = await _make_user()
    user_b = await _make_user()
    try:
        response = await client.patch(
            f"/api/users/{user_b.id}",
            json={"email": user_a.email, "display_name": user_b.display_name},
            headers=_headers(admin),
        )
        assert response.status_code == 409
    finally:
        await _delete_user_row(admin.id)
        await _delete_user_row(user_a.id)
        await _delete_user_row(user_b.id)


async def test_update_unknown_user_is_404(client):
    admin = await _make_user(global_role="admin")
    try:
        response = await client.patch(
            f"/api/users/{uuid.uuid4()}",
            json={"email": "nobody@example.com", "display_name": "Nobody"},
            headers=_headers(admin),
        )
        assert response.status_code == 404
    finally:
        await _delete_user_row(admin.id)


async def test_admin_can_delete_a_normal_user_and_cascade_removes_their_tokens(client):
    """Real cascade check via a direct DB read afterward, not just the 204:
    refresh_tokens for the deleted user are gone (ondelete='CASCADE' on
    users.id, confirmed against the 0001 migration) -- nothing else
    references users.id at all (brdps/notes/rule_approvals don't), so this
    is the entire blast radius by design.
    """
    admin = await _make_user(global_role="admin")
    target = await _make_user()

    try:
        async with async_session_factory() as session:
            session.add(
                RefreshToken(
                    user_id=target.id,
                    token_hash=f"hash-{uuid.uuid4()}",
                    expires_at=datetime.now(timezone.utc) + timedelta(days=30),
                )
            )
            await session.commit()

        response = await client.delete(f"/api/users/{target.id}", headers=_headers(admin))
        assert response.status_code == 204

        async with async_session_factory() as session:
            assert await session.get(User, target.id) is None
            leftover_tokens = (
                (await session.execute(select(RefreshToken).where(RefreshToken.user_id == target.id))).scalars().all()
            )
            assert leftover_tokens == []
    finally:
        await _delete_user_row(admin.id)
        await _delete_user_row(target.id)


async def test_admin_deleting_own_account_is_blocked_even_with_other_admins_present(client):
    """Two admins exist -- deleting either one would still leave an admin,
    so this must be the plain self-delete guard firing (not the last-admin
    one), confirmed via the response detail text.
    """
    admin = await _make_user(global_role="admin")
    other_admin = await _make_user(global_role="admin")
    try:
        response = await client.delete(f"/api/users/{admin.id}", headers=_headers(admin))
        assert response.status_code == 400
        assert "own account" in response.json()["detail"].lower()

        async with async_session_factory() as session:
            assert await session.get(User, admin.id) is not None
    finally:
        await _delete_user_row(admin.id)
        await _delete_user_row(other_admin.id)


async def test_cannot_delete_the_last_remaining_admin_in_the_system(client):
    """The guard counts EVERY admin in the (shared, real) database, not
    just ones created by this test -- so every other admin already present
    is temporarily downgraded to 'user' for the assertion, then restored
    exactly in `finally` regardless of outcome. With exactly one admin
    left, only that admin can call this admin-only endpoint at all, and
    the only user_id they could target that is also 'admin' is themselves
    -- so this necessarily exercises the "last admin" branch, not just
    "self-delete", confirmed via the response detail text differing from
    the other self-delete test above.
    """
    async with async_session_factory() as session:
        other_admins = (await session.execute(select(User).where(User.global_role == "admin"))).scalars().all()
        other_admin_ids = [u.id for u in other_admins]
        for u in other_admins:
            u.global_role = "user"
        await session.commit()

    sole_admin = await _make_user(global_role="admin")
    try:
        async with async_session_factory() as session:
            remaining_admins = (await session.execute(select(User).where(User.global_role == "admin"))).scalars().all()
            assert [u.id for u in remaining_admins] == [sole_admin.id], "test setup invariant broken"

        response = await client.delete(f"/api/users/{sole_admin.id}", headers=_headers(sole_admin))
        assert response.status_code == 400
        assert "last remaining admin" in response.json()["detail"].lower()

        async with async_session_factory() as session:
            assert await session.get(User, sole_admin.id) is not None
    finally:
        async with async_session_factory() as session:
            for user_id in other_admin_ids:
                db_user = await session.get(User, user_id)
                if db_user is not None:
                    db_user.global_role = "admin"
            await session.commit()
        await _delete_user_row(sole_admin.id)


async def test_deleting_one_of_two_admins_by_the_other_succeeds(client):
    """Sanity check that the last-admin guard does NOT over-trigger: with
    exactly two admins, one deleting the OTHER (not themselves) is a
    perfectly normal operation and must succeed, leaving exactly one admin.
    """
    acting_admin = await _make_user(global_role="admin")
    other_admin = await _make_user(global_role="admin")
    try:
        response = await client.delete(f"/api/users/{other_admin.id}", headers=_headers(acting_admin))
        assert response.status_code == 204

        async with async_session_factory() as session:
            assert await session.get(User, other_admin.id) is None
            assert await session.get(User, acting_admin.id) is not None
    finally:
        await _delete_user_row(acting_admin.id)
        await _delete_user_row(other_admin.id)
