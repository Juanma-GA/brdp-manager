"""AACF 3, Part 1 (HR1): the person's interface preferences live in
users.ui_preferences on the server -- a closed schema (sidebar_collapsed,
records_detail_width), merged key by key by PATCH /api/auth/me (HR10).
"""
import asyncio
import uuid

import pytest
from sqlalchemy import text

from app.core.security import hash_password
from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole

PASSWORD = "correct-horse-battery-staple"


@pytest.fixture
async def person():
    async with async_session_factory() as session:
        user = User(
            email=f"uiprefs-{uuid.uuid4()}@example.com",
            password_hash=hash_password(PASSWORD),
            display_name="UI prefs",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
    yield user
    async with async_session_factory() as session:
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def _headers(client, user):
    login = await client.post("/api/auth/login", json={"email": user.email, "password": PASSWORD})
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def _patch(client, headers, prefs):
    return await client.patch("/api/auth/me", json={"ui_preferences": prefs}, headers=headers)


async def test_a_new_user_has_empty_preferences(client, person):
    headers = await _headers(client, person)
    me = await client.get("/api/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["ui_preferences"] == {}


async def test_a_user_from_before_the_migration_reads_as_empty(client, person):
    # The column default: a row inserted without the column reads as {}.
    async with async_session_factory() as session:
        value = (
            await session.execute(text("SELECT ui_preferences FROM users WHERE id = :id"), {"id": person.id})
        ).scalar_one()
    assert value == {}


async def test_keys_are_merged_never_replaced(client, person):
    headers = await _headers(client, person)
    first = await _patch(client, headers, {"sidebar_collapsed": False})
    assert first.status_code == 200 and first.json()["ui_preferences"] == {"sidebar_collapsed": False}
    second = await _patch(client, headers, {"records_detail_width": 600})
    assert second.json()["ui_preferences"] == {"sidebar_collapsed": False, "records_detail_width": 600}
    # Changing one key leaves the other.
    third = await _patch(client, headers, {"sidebar_collapsed": True})
    assert third.json()["ui_preferences"] == {"sidebar_collapsed": True, "records_detail_width": 600}
    # Other profile fields are untouched by a preferences PATCH.
    assert third.json()["display_name"] == "UI prefs"


async def test_null_removes_only_that_key(client, person):
    headers = await _headers(client, person)
    await _patch(client, headers, {"sidebar_collapsed": False, "records_detail_width": 700})
    response = await _patch(client, headers, {"records_detail_width": None})
    assert response.json()["ui_preferences"] == {"sidebar_collapsed": False}


async def test_concurrent_saves_of_different_keys_are_both_kept(client, person):
    """Two tabs, each saving a different key at the same time."""
    headers = await _headers(client, person)
    await asyncio.gather(
        _patch(client, headers, {"sidebar_collapsed": False}),
        _patch(client, headers, {"records_detail_width": 512}),
    )
    me = await client.get("/api/auth/me", headers=headers)
    assert me.json()["ui_preferences"] == {"sidebar_collapsed": False, "records_detail_width": 512}


@pytest.mark.parametrize(
    "prefs",
    [
        {"theme": "dark"},
        {"sidebar_collapsed": "yes"},
        {"sidebar_collapsed": 1},
        {"records_detail_width": "600"},
        {"records_detail_width": 600.5},
        {"records_detail_width": True},
        {"records_detail_width": 100},
        {"records_detail_width": 100000},
    ],
)
async def test_unknown_key_or_wrong_type_is_422_and_nothing_changes(client, person, prefs):
    headers = await _headers(client, person)
    await _patch(client, headers, {"sidebar_collapsed": False})
    response = await _patch(client, headers, prefs)
    assert response.status_code == 422
    me = await client.get("/api/auth/me", headers=headers)
    assert me.json()["ui_preferences"] == {"sidebar_collapsed": False}


async def test_preferences_follow_the_person_to_a_new_login(client, person):
    first = await _headers(client, person)
    await _patch(client, first, {"sidebar_collapsed": False, "records_detail_width": 640})
    second = await _headers(client, person)
    me = await client.get("/api/auth/me", headers=second)
    assert me.json()["ui_preferences"] == {"sidebar_collapsed": False, "records_detail_width": 640}


async def test_a_viewer_saves_their_own_preferences(client, person):
    """Preferences belong to the person, not to a project: a viewer with no
    editor role anywhere can save them."""
    async with async_session_factory() as session:
        project = Project(name=f"uiprefs-{uuid.uuid4()}", standard="S1000D 4.2")
        session.add(project)
        await session.flush()
        session.add(UserProjectRole(user_id=person.id, project_id=project.id, role="viewer"))
        await session.commit()
        project_id = project.id
    try:
        headers = await _headers(client, person)
        response = await _patch(client, headers, {"records_detail_width": 500})
        assert response.status_code == 200
        assert response.json()["ui_preferences"] == {"records_detail_width": 500}
    finally:
        async with async_session_factory() as session:
            await session.delete(await session.get(Project, project_id))
            await session.commit()
