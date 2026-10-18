"""An email the login refuses can never become an account.

create_admin_user.py writes a user straight into the database; it now runs
the email through app.core.emails.normalize_email -- the same pydantic
EmailStr the login uses -- before creating anything. Create user and Edit
user (the API) already took EmailStr; they are checked here too so the
three ways in stay the same.

The script is run as a subprocess, as an operator runs it (DATABASE_URL is
the test database: conftest exports it to the environment).
"""
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from app.core.emails import InvalidEmail, normalize_email
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import User

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "create_admin_user.py"
PASSWORD = "Correct-Horse-Battery-9"


def _run(email: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "INITIAL_ADMIN_EMAIL": email, "INITIAL_ADMIN_PASSWORD": PASSWORD, "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(
        [sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True, encoding="utf-8",
        cwd=SCRIPT.parent.parent, timeout=120,
    )


async def _users_like(fragment: str) -> list[User]:
    async with async_session_factory() as session:
        return list((await session.execute(select(User).where(User.email.ilike(f"%{fragment}%")))).scalars())


async def _delete(fragment: str) -> None:
    async with async_session_factory() as session:
        for user in (await session.execute(select(User).where(User.email.ilike(f"%{fragment}%")))).scalars():
            await session.delete(user)
        await session.commit()


@pytest.mark.parametrize("domain", ["empresa.local", "host.localhost", "x.test", "x.invalid"])
def test_normalize_email_refuses_reserved_domains(domain):
    with pytest.raises(InvalidEmail) as exc:
        normalize_email(f"admin@{domain}")
    assert "special-use or reserved" in str(exc.value)


def test_normalize_email_lowercases_the_domain_like_the_login():
    assert normalize_email("  Admin@Empresa.COM ") == "Admin@empresa.com"


async def test_reserved_domain_fails_before_creating_anything():
    tag = uuid.uuid4().hex[:10]
    result = _run(f"admin-{tag}@empresa.local")
    try:
        assert result.returncode == 1
        assert "special-use or reserved" in result.stderr
        assert "Nothing was created" in result.stderr
        assert await _users_like(tag) == []
    finally:
        await _delete(tag)


async def test_real_domain_creates_the_admin_and_the_login_works(client):
    tag = uuid.uuid4().hex[:10]
    # Upper-case domain: stored normalised, so the login (which looks the
    # normalised email up) finds it.
    result = _run(f"admin-{tag}@Atexis.COM")
    try:
        assert result.returncode == 0, result.stderr
        users = await _users_like(tag)
        assert [u.email for u in users] == [f"admin-{tag}@atexis.com"]
        assert users[0].global_role == "admin"
        login = await client.post("/api/auth/login", json={"email": f"admin-{tag}@Atexis.COM", "password": PASSWORD})
        assert login.status_code == 200, login.text
    finally:
        await _delete(tag)


async def test_api_create_and_edit_refuse_reserved_domains(client):
    tag = uuid.uuid4().hex[:10]
    async with async_session_factory() as session:
        admin = User(email=f"adm-{tag}@example.com", password_hash=hash_password("x"), display_name="A", global_role="admin")
        session.add(admin)
        await session.commit()
        await session.refresh(admin)
    headers = {"Authorization": f"Bearer {create_access_token(admin.id)}"}
    try:
        created = await client.post(
            "/api/users", json={"email": f"u-{tag}@empresa.local", "display_name": "U"}, headers=headers
        )
        assert created.status_code == 422
        edited = await client.patch(
            f"/api/users/{admin.id}", json={"email": f"adm-{tag}@empresa.local", "display_name": "A"}, headers=headers
        )
        assert edited.status_code == 422
        assert [u.email for u in await _users_like(tag)] == [f"adm-{tag}@example.com"]
    finally:
        await _delete(tag)
