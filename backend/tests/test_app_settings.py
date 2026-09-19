"""GET/PUT /api/settings/import-eta -- the installation-wide Apply/Import
ETA settings (docs request: moved off per-project project_config into one
global row, admin-only to edit). GET is deliberately NOT admin-gated (any
authenticated user, including an editor with no global_role at all) --
see app/api/routes/app_settings.py's docstring: an editor triggering a
real Apply import in any project needs to read these 4 numbers to show
their own accurate ETA, same as GET /api/config/ai-provider. What's
admin-only is changing the value (PUT) and the Settings page section that
exposes it as an editable control (frontend-only, not tested here).
"""
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import AppSettings, User
from app.models.app_settings import SINGLETON_ID


@pytest.fixture
async def admin_and_user():
    async with async_session_factory() as session:
        admin = User(
            email=f"settings-admin-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Settings Admin",
            global_role="admin",
        )
        non_admin = User(
            email=f"settings-user-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Settings Non Admin",
            global_role="user",
        )
        session.add_all([admin, non_admin])
        await session.commit()
        await session.refresh(admin)
        await session.refresh(non_admin)

    yield admin, non_admin

    async with async_session_factory() as session:
        for user in (admin, non_admin):
            db_user = await session.get(User, user.id)
            if db_user is not None:
                await session.delete(db_user)
        await session.commit()


@pytest.fixture
async def restore_app_settings():
    """The row this endpoint edits is a true singleton (one per
    installation, not one per test) -- without saving/restoring its
    original values, a test that PUTs a new value would permanently
    change what every other test (and a real admin's dev session) sees
    afterward.
    """
    async with async_session_factory() as session:
        settings = await session.get(AppSettings, SINGLETON_ID)
        original = {
            "apply_eta_ms_per_plain_row": settings.apply_eta_ms_per_plain_row,
            "apply_eta_ms_per_validated_row": settings.apply_eta_ms_per_validated_row,
            "apply_eta_validated_rows_threshold": settings.apply_eta_validated_rows_threshold,
            "apply_eta_warning_seconds": settings.apply_eta_warning_seconds,
            "updated_by": settings.updated_by,
        }

    yield

    async with async_session_factory() as session:
        settings = await session.get(AppSettings, SINGLETON_ID)
        for key, value in original.items():
            setattr(settings, key, value)
        await session.commit()


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_requires_authentication(client):
    response = await client.get("/api/settings/import-eta")
    assert response.status_code == 401


async def test_any_authenticated_user_can_read(client, admin_and_user):
    _admin, non_admin = admin_and_user
    response = await client.get("/api/settings/import-eta", headers=_headers(non_admin))
    assert response.status_code == 200
    body = response.json()

    async with async_session_factory() as session:
        settings = await session.get(AppSettings, SINGLETON_ID)
    assert body["apply_eta_ms_per_plain_row"] == settings.apply_eta_ms_per_plain_row
    assert body["apply_eta_ms_per_validated_row"] == settings.apply_eta_ms_per_validated_row
    assert body["apply_eta_validated_rows_threshold"] == settings.apply_eta_validated_rows_threshold
    assert body["apply_eta_warning_seconds"] == settings.apply_eta_warning_seconds


async def test_migration_seeded_the_real_measured_value(client, admin_and_user):
    """Regression guard for the docs request's own point 5 -- migration
    0009 must not have reset this to some other placeholder: 1500ms/
    Validated row is the real number measured against production Mistral
    (see migration 0007's docstring, carried forward by 0009).
    """
    _admin, non_admin = admin_and_user
    response = await client.get("/api/settings/import-eta", headers=_headers(non_admin))
    assert response.json()["apply_eta_ms_per_validated_row"] == 1500


async def test_non_admin_cannot_update(client, admin_and_user):
    _admin, non_admin = admin_and_user
    response = await client.put(
        "/api/settings/import-eta",
        json={
            "apply_eta_ms_per_plain_row": 5,
            "apply_eta_ms_per_validated_row": 2000,
            "apply_eta_validated_rows_threshold": 20,
            "apply_eta_warning_seconds": 45,
        },
        headers=_headers(non_admin),
    )
    assert response.status_code == 403


async def test_admin_can_update_and_it_persists_and_is_globally_visible(
    client, admin_and_user, restore_app_settings
):
    admin, non_admin = admin_and_user
    response = await client.put(
        "/api/settings/import-eta",
        json={
            "apply_eta_ms_per_plain_row": 7,
            "apply_eta_ms_per_validated_row": 60000,
            "apply_eta_validated_rows_threshold": 1,
            "apply_eta_warning_seconds": 5,
        },
        headers=_headers(admin),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["apply_eta_ms_per_plain_row"] == 7
    assert body["apply_eta_ms_per_validated_row"] == 60000
    assert body["apply_eta_validated_rows_threshold"] == 1
    assert body["apply_eta_warning_seconds"] == 5
    assert body["updated_by"] == str(admin.id)

    # A DIFFERENT user (non-admin, e.g. an editor about to run an Apply
    # import in some other project) reading it right after sees the new
    # global value too -- there is exactly one row, not one per project.
    read_back = await client.get("/api/settings/import-eta", headers=_headers(non_admin))
    assert read_back.json()["apply_eta_ms_per_validated_row"] == 60000
