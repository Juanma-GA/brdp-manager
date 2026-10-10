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
from httpx import ASGITransport, AsyncClient

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
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
    assert body["token_type"] == "bearer"

    # AACF HR1 + "Auth & Storage": the refresh token must never appear in
    # the JSON body -- only as a Set-Cookie header the browser can't read
    # back via document.cookie.
    assert "refresh_token" not in body

    set_cookie = response.headers.get("set-cookie")
    assert set_cookie is not None
    assert "refresh_token=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "Path=/api/auth" in set_cookie
    # settings.environment defaults to "development" for the test app --
    # Secure must stay off, or the cookie would be silently dropped by the
    # browser over plain HTTP local dev.
    assert "Secure" not in set_cookie


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


async def test_me_response_includes_null_preferred_language_for_a_fresh_user(client, test_user):
    """docs request's own edge case: an account that predates this column
    (or just hasn't touched the language switcher) must not break login
    or GET /me -- it reads back as null, not a default that would hide
    the "no preference chosen yet" state from the frontend.
    """
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]
    response = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert response.status_code == 200
    assert response.json()["preferred_language"] is None


async def test_me_update_changes_preferred_language_without_touching_display_name(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {access_token}"}

    # Partial update -- LanguageSwitcher.jsx sends ONLY preferred_language,
    # never display_name alongside it.
    response = await client.patch("/api/auth/me", json={"preferred_language": "es"}, headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["preferred_language"] == "es"
    assert body["display_name"] == test_user.display_name  # untouched

    async with async_session_factory() as session:
        db_user = await session.get(User, test_user.id)
        assert db_user.preferred_language == "es"
        assert db_user.display_name == test_user.display_name


async def test_me_update_rejects_unsupported_language(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]
    response = await client.patch(
        "/api/auth/me",
        json={"preferred_language": "fr"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 422


async def test_preferred_language_follows_the_account_across_a_fresh_login(client, test_user):
    """The real edge case behind this feature -- logging in again (this
    app's stand-in for "a different browser", since a fresh login here is
    a fully independent token/session with nothing carried over from the
    first one) must reflect the account's saved language, not a browser
    default.
    """
    first_login = await client.post(
        "/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD}
    )
    await client.patch(
        "/api/auth/me",
        json={"preferred_language": "es"},
        headers={"Authorization": f"Bearer {first_login.json()['access_token']}"},
    )

    second_login = await client.post(
        "/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD}
    )
    me = await client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {second_login.json()['access_token']}"}
    )
    assert me.json()["preferred_language"] == "es"


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
    old_refresh = login.cookies["refresh_token"]

    # No body at all -- the client's cookie jar carries the token, exactly
    # like a real browser tab that never touched the value directly.
    refreshed = await client.post("/api/auth/refresh")
    assert refreshed.status_code == 200
    assert "refresh_token" not in refreshed.json()
    new_refresh = client.cookies["refresh_token"]
    assert new_refresh != old_refresh

    # The old refresh token was single-use -- force it back onto the
    # client's own cookie jar (which has already moved on to the rotated
    # value) and confirm reusing it fails.
    client.cookies["refresh_token"] = old_refresh
    reused = await client.post("/api/auth/refresh")
    assert reused.status_code == 401

    # The freshly rotated one still works exactly once.
    client.cookies["refresh_token"] = new_refresh
    second_refresh = await client.post("/api/auth/refresh")
    assert second_refresh.status_code == 200


async def test_refresh_with_unknown_token_rejected(client):
    client.cookies["refresh_token"] = "not-a-real-token"
    response = await client.post("/api/auth/refresh")
    assert response.status_code == 401


async def test_refresh_without_any_cookie_rejected_cleanly(client):
    """docs request's own edge case: calling /refresh with no cookie at all
    (curl, a session that never logged in) must be a clean 401, not a 500.
    """
    response = await client.post("/api/auth/refresh")
    assert response.status_code == 401


async def test_logout_revokes_refresh_token(client, test_user):
    await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    assert "refresh_token" in client.cookies

    logout_response = await client.post("/api/auth/logout")
    assert logout_response.status_code == 204
    set_cookie = logout_response.headers.get("set-cookie")
    assert set_cookie is not None
    assert "refresh_token=" in set_cookie
    assert "Max-Age=0" in set_cookie or '""' in set_cookie

    # httpx's own cookie jar honors the Max-Age=0 expiry, same as a real
    # browser would -- the next request from this client carries no cookie
    # at all, not a stale one.
    reuse_after_logout = await client.post("/api/auth/refresh")
    assert reuse_after_logout.status_code == 401


async def test_logout_with_unknown_token_is_a_noop_not_an_error(client):
    client.cookies["refresh_token"] = "never-issued"
    response = await client.post("/api/auth/logout")
    assert response.status_code == 204


async def test_logout_without_any_cookie_is_a_noop_not_an_error(client):
    response = await client.post("/api/auth/logout")
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


async def test_change_password_with_correct_current_password_succeeds(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]

    response = await client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "new-correct-password"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 204

    old_password_login = await client.post(
        "/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD}
    )
    assert old_password_login.status_code == 401

    new_password_login = await client.post(
        "/api/auth/login", json={"email": test_user.email, "password": "new-correct-password"}
    )
    assert new_password_login.status_code == 200


async def test_change_password_clears_must_change_password_flag(client, test_user):
    """docs request: a successful change is what lifts the frontend's
    force-change-password gate set by Create user/admin Reset password.
    """
    async with async_session_factory() as session:
        db_user = await session.get(User, test_user.id)
        db_user.must_change_password = True
        await session.commit()

    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]
    me_before = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert me_before.json()["must_change_password"] is True

    response = await client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "new-correct-password"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 204

    me_after = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert me_after.json()["must_change_password"] is False


async def test_change_password_with_wrong_current_password_rejected(client, test_user):
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]

    response = await client.post(
        "/api/auth/change-password",
        json={"current_password": "totally-wrong", "new_password": "new-correct-password"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 403

    # The real password must still work -- nothing changed.
    still_works = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    assert still_works.status_code == 200


async def test_change_password_without_a_valid_token_rejected(client):
    response = await client.post(
        "/api/auth/change-password",
        json={"current_password": "whatever", "new_password": "new-correct-password"},
    )
    assert response.status_code == 401


async def test_change_password_rejects_new_password_shorter_than_minimum(client, test_user):
    """The app's first-ever password policy (docs request): >= 8 chars,
    nothing else. 7 chars must be rejected; the real password must still
    work afterward, same as the wrong-current-password case above.
    """
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]

    response = await client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "short7!"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 422

    still_works = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    assert still_works.status_code == 200


async def test_change_password_revokes_other_sessions_but_not_the_current_one(client, test_user):
    """Two real, independent sessions (docs request's "dos pestañas"), each
    its own AsyncClient so each gets its own cookie jar -- a single client
    can't hold two different refresh_token cookie values for the same
    path at once, same as two separate browser tabs would need to be two
    separate cookie stores if they weren't sharing one browser profile.
    Changing the password from session A must revoke session B's refresh
    token (read from ITS OWN cookie by the endpoint) while leaving
    session A's (read from the request that made the change) usable.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client_a, AsyncClient(
        transport=transport, base_url="http://test"
    ) as client_b:
        session_a = await client_a.post(
            "/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD}
        )
        await client_b.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
        access_token_a = session_a.json()["access_token"]

        response = await client_a.post(
            "/api/auth/change-password",
            json={"current_password": TEST_PASSWORD, "new_password": "new-correct-password"},
            headers={"Authorization": f"Bearer {access_token_a}"},
        )
        assert response.status_code == 204

        # Session B is forced to re-login on its next refresh -- the whole
        # point of this feature.
        session_b_refresh = await client_b.post("/api/auth/refresh")
        assert session_b_refresh.status_code == 401

        # Session A's own refresh token (read from ITS request's cookie by
        # the endpoint) was excluded, so it's still usable.
        session_a_refresh = await client_a.post("/api/auth/refresh")
        assert session_a_refresh.status_code == 200


async def test_change_password_without_a_refresh_cookie_revokes_every_session(client, test_user):
    """change-password called with no refresh_token cookie at all (the
    access token alone is enough to authenticate the request) -- every
    active refresh token for this user still gets revoked, current session
    included, same as the old "no current_refresh_token in the body" case.
    """
    login = await client.post("/api/auth/login", json={"email": test_user.email, "password": TEST_PASSWORD})
    access_token = login.json()["access_token"]
    refresh_token = login.cookies["refresh_token"]

    # Drop the cookie from the client's own jar (a per-request `cookies=`
    # override only ADDS to the jar, it can't suppress an entry already in
    # it) so this call carries an access token but genuinely no refresh
    # cookie, as if the caller's had already expired or been cleared --
    # change-password must not require it to be present.
    client.cookies.delete("refresh_token")
    response = await client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "new-correct-password"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 204

    client.cookies["refresh_token"] = refresh_token
    refresh_attempt = await client.post("/api/auth/refresh")
    assert refresh_attempt.status_code == 401
