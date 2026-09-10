"""Phase 2: JWT auth end-to-end against the real app + real Postgres --
no mocking of the DB layer or the JWT signing/verification logic. Covers
the §6 test requirement explicitly: expired token, token signed with a
different key, and absence of a token must ALL be rejected.
"""
import uuid
from datetime import timedelta

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import User

TEST_PASSWORD = "correct-horse-battery-staple"


@pytest.fixture
async def test_user():
    async with async_session_factory() as session:
        user = User(
            email=f"authtest-{uuid.uuid4()}@example.com",
            password_hash=hash_password(TEST_PASSWORD),
            display_name="Auth Test User",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        yield user
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def test_login_with_correct_credentials_succeeds(client, test_user):
    response = await client.post(
        "/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD}
    )
    assert response.status_code == 200
    body = response.json()
    assert "access_token" in body
    assert "refresh_token" in body
    assert body["token_type"] == "bearer"


async def test_login_with_wrong_password_rejected(client, test_user):
    response = await client.post(
        "/api/auth/login", json={"email": test_user.email, "password": "wrong-password"}
    )
    assert response.status_code == 401


async def test_login_with_unknown_email_rejected(client):
    response = await client.post(
        "/api/auth/login", json={"email": "no-such-user@example.com", "password": "anything"}
    )
    assert response.status_code == 401


async def test_me_with_valid_token_succeeds(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]

    response = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert response.status_code == 200
    assert response.json()["email"] == test_user.email


async def test_me_without_token_rejected(client):
    """§6: "ausencia de token... debe rechazarse"."""
    response = await client.get("/api/auth/me")
    assert response.status_code == 401


async def test_me_with_expired_token_rejected(client, test_user):
    """§6: "token expirado... debe rechazarse". Signed with the app's real
    key, genuinely expired (not mocked) via create_access_token's own
    expires_delta parameter.
    """
    expired_token = create_access_token(test_user.id, expires_delta=timedelta(minutes=-5))
    response = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_token}"})
    assert response.status_code == 401


async def test_me_with_token_signed_by_different_key_rejected(client, test_user):
    """§6: "token firmado con otra clave... debe rechazarse". A genuinely
    different, freshly generated RSA keypair -- not the app's key, not a
    shared secret, not a mock of jwt.decode.
    """
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_private_pem = other_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    forged_token = pyjwt.encode(
        {"sub": str(test_user.id), "type": "access"}, other_private_pem, algorithm="RS256"
    )
    response = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {forged_token}"})
    assert response.status_code == 401


async def test_me_with_malformed_token_rejected(client):
    response = await client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-jwt-at-all"})
    assert response.status_code == 401


async def test_me_update_changes_display_name(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]

    response = await client.patch(
        "/api/auth/me",
        json={"display_name": "Renamed Self"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "Renamed Self"

    async with async_session_factory() as session:
        db_user = await session.get(User, test_user.id)
        assert db_user.display_name == "Renamed Self"


async def test_me_update_ignores_global_role_change(client):
    """A non-admin sending global_role in the PATCH /api/auth/me body must
    NOT become admin -- MeUpdate has no global_role field at all, so this
    confirms the extra field is silently dropped, not silently applied.
    """
    async with async_session_factory() as session:
        user = User(
            email=f"selfpromote-{uuid.uuid4()}@example.com",
            password_hash=hash_password(TEST_PASSWORD),
            display_name="Would-Be Admin",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)

    try:
        login = await client.post("/api/auth/login", json={"email": user.email, "password": TEST_PASSWORD})
        access_token = login.json()["access_token"]

        response = await client.patch(
            "/api/auth/me",
            json={"display_name": "Still Not Admin", "global_role": "admin", "email": "hijacked@example.com"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["global_role"] == "user"
        assert body["email"] == user.email
        assert body["display_name"] == "Still Not Admin"

        async with async_session_factory() as session:
            db_user = await session.get(User, user.id)
            assert db_user.global_role == "user"
            assert db_user.email == user.email
    finally:
        async with async_session_factory() as session:
            db_user = await session.get(User, user.id)
            if db_user is not None:
                await session.delete(db_user)
                await session.commit()


async def test_refresh_rotates_token_and_invalidates_the_old_one(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    old_refresh = login.json()["refresh_token"]

    refreshed = await client.post("/api/auth/refresh", json={"refresh_token": old_refresh})
    assert refreshed.status_code == 200
    new_refresh = refreshed.json()["refresh_token"]
    assert new_refresh != old_refresh

    # The old refresh token was single-use -- reusing it must fail.
    reused = await client.post("/api/auth/refresh", json={"refresh_token": old_refresh})
    assert reused.status_code == 401

    # The freshly rotated one still works exactly once.
    second_refresh = await client.post("/api/auth/refresh", json={"refresh_token": new_refresh})
    assert second_refresh.status_code == 200


async def test_refresh_with_unknown_token_rejected(client):
    response = await client.post("/api/auth/refresh", json={"refresh_token": "not-a-real-token"})
    assert response.status_code == 401


async def test_logout_revokes_refresh_token(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    refresh_token = login.json()["refresh_token"]

    logout_response = await client.post("/api/auth/logout", json={"refresh_token": refresh_token})
    assert logout_response.status_code == 204

    reuse_after_logout = await client.post("/api/auth/refresh", json={"refresh_token": refresh_token})
    assert reuse_after_logout.status_code == 401


async def test_logout_with_unknown_token_is_a_noop_not_an_error(client):
    response = await client.post("/api/auth/logout", json={"refresh_token": "never-issued"})
    assert response.status_code == 204


async def test_login_locks_out_after_repeated_failures(client, test_user):
    from app.core.rate_limit import _MAX_ATTEMPTS, clear_attempts

    clear_attempts(test_user.email)
    for _ in range(_MAX_ATTEMPTS):
        response = await client.post(
            "/api/auth/login", json={"email": test_user.email, "password": "wrong-password"}
        )
        assert response.status_code == 401

    locked = await client.post(
        "/api/auth/login", json={"email": test_user.email, "password": "wrong-password"}
    )
    assert locked.status_code == 429

    # Even the CORRECT password is locked out during the window.
    still_locked = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    assert still_locked.status_code == 429

    clear_attempts(test_user.email)
