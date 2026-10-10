"""Project "Schema location" (project_config.schemaLocation): the options per
standard and the custom pattern rules, on PUT /config and on project
creation -- the same rules as the configuration page
(src/utils/ruleSchemaContext.js, validateSchemaPattern)."""
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import Project, User
from app.services.schema_location import schema_location_problem, schema_pattern_problem


async def _admin() -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"schema-loc-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Schema Location Test",
            global_role="admin",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _project(standard: str) -> Project:
    async with async_session_factory() as session:
        project = Project(name=f"Schema Location {uuid.uuid4()}", standard=standard, project_config={"modelIdentCode": "ABC"})
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project


async def _delete(*objects) -> None:
    async with async_session_factory() as session:
        for obj in objects:
            db_obj = await session.get(type(obj), obj.id)
            if db_obj is not None:
                await session.delete(db_obj)
        await session.commit()


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.mark.parametrize(
    "pattern, ok",
    [
        ("../schemas/{schema}.xsd", True),
        ("file:///C:/CSDB/schemas/{schema}.xsd", True),
        ("{schema}_v42.xsd", True),
        ("", False),
        ("   ", False),
        (None, False),
        ("../schemas/proced.xsd", False),
        ("{schema}/{schema}.xsd", False),
        ("../schemas/\n{schema}.xsd", False),
        ('../"{schema}.xsd', False),
        ("<{schema}.xsd", False),
        ("a&b/{schema}.xsd", False),
    ],
)
def test_pattern_rules(pattern, ok):
    assert (schema_pattern_problem(pattern) is None) is ok


def test_options_per_standard():
    assert schema_location_problem("S1000D 3.0.1", {"schemaLocation": "master"}) is None
    assert "not available" in schema_location_problem("S1000D 4.2", {"schemaLocation": "master"})
    assert "not available" in schema_location_problem("S1000D 4.1", {"schemaLocation": "master"})
    assert schema_location_problem("S1000D 4.2", {"schemaLocation": "flat"}) is None
    assert schema_location_problem("S1000D 4.2", {}) is None
    # DITA and S1000D 5.0 have no schema location: never checked.
    assert schema_location_problem("DITA 1.3 Xpath2.0", {"schemaLocation": "anything"}) is None
    assert schema_location_problem("S1000D 5.0", {"schemaLocation": "anything"}) is None


async def test_put_config_saves_a_valid_pattern(client):
    admin = await _admin()
    project = await _project("S1000D 4.2")
    try:
        cfg = {"modelIdentCode": "ABC", "schemaLocation": "custom", "schemaLocationPattern": "../schemas/{schema}.xsd"}
        response = await client.put(f"/api/projects/{project.id}/config", json={"project_config": cfg}, headers=_headers(admin))
        assert response.status_code == 200
        assert response.json()["project_config"] == cfg
    finally:
        await _delete(project, admin)


@pytest.mark.parametrize(
    "standard, cfg, reason",
    [
        ("S1000D 4.2", {"schemaLocation": "custom", "schemaLocationPattern": "../schemas/proced.xsd"}, "{schema}"),
        ("S1000D 4.2", {"schemaLocation": "custom", "schemaLocationPattern": '../"{schema}.xsd'}, 'character "'),
        ("S1000D 4.1", {"schemaLocation": "master"}, "not available"),
        ("S1000D 4.2", {"schemaLocation": "weird"}, "not available"),
    ],
)
async def test_put_config_refuses_an_unusable_location(client, standard, cfg, reason):
    admin = await _admin()
    project = await _project(standard)
    try:
        response = await client.put(f"/api/projects/{project.id}/config", json={"project_config": cfg}, headers=_headers(admin))
        assert response.status_code == 422
        assert reason in response.json()["detail"]
        async with async_session_factory() as session:
            assert (await session.get(Project, project.id)).project_config == {"modelIdentCode": "ABC"}
    finally:
        await _delete(project, admin)


async def test_put_config_3_0_1_master_still_saves(client):
    admin = await _admin()
    project = await _project("S1000D 3.0.1")
    try:
        response = await client.put(
            f"/api/projects/{project.id}/config", json={"project_config": {"schemaLocation": "master"}}, headers=_headers(admin)
        )
        assert response.status_code == 200
    finally:
        await _delete(project, admin)


async def test_create_project_refuses_an_invalid_pattern(client):
    admin = await _admin()
    try:
        response = await client.post(
            "/api/projects",
            json={
                "name": f"Bad pattern {uuid.uuid4()}",
                "standard": "S1000D 4.2",
                "project_config": {"schemaLocation": "custom", "schemaLocationPattern": "no-placeholder.xsd"},
            },
            headers=_headers(admin),
        )
        assert response.status_code == 422
    finally:
        await _delete(admin)
