"""A session survives a refresh whose answer never reached the browser.

Real case (verify-aacf3-texts.mjs, intermittent): a page reload, then a
navigation that aborted the reload's POST /api/auth/refresh after the
server had rotated the token; the browser kept the old cookie, the next
refresh presented it and got 401 -> the login page. Two tabs opened at
once send the same cookie too. A token replaced by a refresh now still
refreshes for REFRESH_TOKEN_REUSE_GRACE_SECONDS (a fresh pair each time);
logout, password change/reset and deleting the user end sessions for good.
With the previous code the two "same cookie twice" tests fail (401).
"""
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.security import create_access_token, hash_password, hash_refresh_token
from app.db.base import async_session_factory
from app.models import RefreshToken, User

PASSWORD = "correct-horse-battery-staple"


@pytest.fixture
async def user():
    async with async_session_factory() as session:
        row = User(email=f"grace-{uuid.uuid4()}@example.com", password_hash=hash_password(PASSWORD), display_name="G", global_role="user")
        session.add(row)
        await session.commit()
        await session.refresh(row)
    yield row
    async with async_session_factory() as session:
        db_user = await session.get(User, row.id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def _login(client, user) -> str:
    response = await client.post("/api/auth/login", json={"email": user.email, "password": PASSWORD})
    assert response.status_code == 200
    return response.cookies["refresh_token"]


async def _refresh_with(client, raw: str):
    client.cookies.clear()
    client.cookies["refresh_token"] = raw
    return await client.post("/api/auth/refresh")


async def test_the_same_cookie_twice_keeps_the_session(client, user):
    first = await _login(client, user)
    assert (await _refresh_with(client, first)).status_code == 200
    # The answer above "never reached the browser": it sends the old cookie.
    again = await _refresh_with(client, first)
    assert again.status_code == 200
    # ... and gets a working session of its own.
    assert (await _refresh_with(client, again.cookies["refresh_token"])).status_code == 200


async def test_two_tabs_at_once(client, user):
    import asyncio

    first = await _login(client, user)
    client.cookies.clear()
    results = await asyncio.gather(
        *[client.post("/api/auth/refresh", cookies={"refresh_token": first}) for _ in range(2)]
    )
    assert [r.status_code for r in results] == [200, 200]


async def test_after_the_grace_the_old_cookie_is_refused(client, user):
    first = await _login(client, user)
    assert (await _refresh_with(client, first)).status_code == 200
    grace = get_settings().refresh_token_reuse_grace_seconds
    async with async_session_factory() as session:
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == hash_refresh_token(first))
            .values(rotated_at=RefreshToken.rotated_at - timedelta(seconds=grace + 1))
        )
        await session.commit()
    assert (await _refresh_with(client, first)).status_code == 401


async def test_grace_zero_is_strict_single_use(client, user, monkeypatch):
    monkeypatch.setattr(get_settings(), "refresh_token_reuse_grace_seconds", 0)
    first = await _login(client, user)
    assert (await _refresh_with(client, first)).status_code == 200
    assert (await _refresh_with(client, first)).status_code == 401


async def test_logout_ends_the_session_and_its_previous_cookie(client, user):
    first = await _login(client, user)
    second = (await _refresh_with(client, first)).cookies["refresh_token"]
    client.cookies["refresh_token"] = second
    assert (await client.post("/api/auth/logout")).status_code == 204
    assert (await _refresh_with(client, second)).status_code == 401
    # The cookie rotated a moment ago belongs to the same session: no way back.
    assert (await _refresh_with(client, first)).status_code == 401


async def test_password_change_and_reset_end_the_other_sessions(client, user):
    other_first = await _login(client, user)
    assert (await _refresh_with(client, other_first)).status_code == 200  # other tab, rotated
    mine = await _login(client, user)
    access = create_access_token(user.id)
    client.cookies.clear()
    client.cookies["refresh_token"] = mine
    changed = await client.post(
        "/api/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "Another-Horse-Battery-77"},
        headers={"Authorization": f"Bearer {access}"},
    )
    assert changed.status_code in (200, 204), changed.text
    assert (await _refresh_with(client, other_first)).status_code == 401
    assert (await _refresh_with(client, mine)).status_code == 200  # the caller's own session stays

    # An admin's reset ends every session, the rotated ones too.
    async with async_session_factory() as session:
        admin = User(email=f"grace-adm-{uuid.uuid4()}@example.com", password_hash="x", display_name="A", global_role="admin")
        session.add(admin)
        await session.commit()
        await session.refresh(admin)
    try:
        last = (await _login_new(client, user, "Another-Horse-Battery-77"))
        assert (await _refresh_with(client, last)).status_code == 200
        reset = await client.post(f"/api/users/{user.id}/reset-password", headers={"Authorization": f"Bearer {create_access_token(admin.id)}"})
        assert reset.status_code == 200
        assert (await _refresh_with(client, last)).status_code == 401
    finally:
        async with async_session_factory() as session:
            await session.delete(await session.get(User, admin.id))
            await session.commit()


async def _login_new(client, user, password) -> str:
    client.cookies.clear()
    response = await client.post("/api/auth/login", json={"email": user.email, "password": password})
    assert response.status_code == 200
    return response.cookies["refresh_token"]


async def test_deleted_user_never_refreshes(client, user):
    first = await _login(client, user)
    assert (await _refresh_with(client, first)).status_code == 200
    async with async_session_factory() as session:
        admin = User(email=f"grace-adm2-{uuid.uuid4()}@example.com", password_hash="x", display_name="A", global_role="admin")
        session.add(admin)
        await session.commit()
        await session.refresh(admin)
    try:
        deleted = await client.delete(f"/api/users/{user.id}", headers={"Authorization": f"Bearer {create_access_token(admin.id)}"})
        assert deleted.status_code in (200, 204), deleted.text
        assert (await _refresh_with(client, first)).status_code == 401
        async with async_session_factory() as session:
            rows = (await session.execute(select(RefreshToken).where(RefreshToken.user_id == user.id))).scalars().all()
            assert rows and all(r.revoked_at is not None and r.rotated_at is None for r in rows)
    finally:
        async with async_session_factory() as session:
            await session.delete(await session.get(User, admin.id))
            await session.commit()
