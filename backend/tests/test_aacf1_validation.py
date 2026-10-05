"""AACF 1, Parts 3 and 5: server-side input validation and sanitized errors.

- BRDP create/edit: Proposal Status only takes the values the app uses;
  Title, Definition, Proposal and the refusal reason have a maximum length
  (Settings) and over it the request is refused with the limit, never cut;
  `history` is no longer accepted in the body.
- Project creation: the standard must be one of the supported ones; the
  project_config must have the shape the app stores.
- An unexpected error answers with a code and a reference only; the
  exception's text goes to the server log under that reference.

The LLM proxy's parameter list is tested in test_llm_proxy.py, AI Extract's
long quotes and titles in test_text_extract.py.
"""
import logging
import traceback
import uuid

import pytest

from app.core.config import get_settings
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole
from app.services.rule_formats import SUPPORTED_STANDARDS


@pytest.fixture
async def editor_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"AACF1 Validation {uuid.uuid4()}", standard="S1000D 4.2")
        user = User(
            email=f"aacf1-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="AACF1 Editor",
            global_role="user",
        )
        session.add_all([project, user])
        await session.flush()
        session.add(UserProjectRole(user_id=user.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(user)
    yield project, {"Authorization": f"Bearer {create_access_token(user.id)}"}
    async with async_session_factory() as session:
        for obj in (await session.get(Project, project.id), await session.get(User, user.id)):
            if obj is not None:
                await session.delete(obj)
        await session.commit()


@pytest.fixture
async def admin_headers():
    async with async_session_factory() as session:
        user = User(
            email=f"aacf1-admin-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="AACF1 Admin",
            global_role="admin",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
    yield {"Authorization": f"Bearer {create_access_token(user.id)}"}
    async with async_session_factory() as session:
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
        await session.commit()


async def _create(client, project, headers, **fields):
    return await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": f"BRDP-V-{uuid.uuid4().hex[:6]}", **fields}, headers=headers)


# ── BRDP create / edit ─────────────────────────────────────────────────────


async def test_validation_outside_the_list_is_refused(client, editor_and_project):
    project, headers = editor_and_project
    res = await _create(client, project, headers, validation="Approved")
    assert res.status_code == 422
    assert res.json()["detail"][0]["type"] == "literal_error"
    brdp = (await _create(client, project, headers)).json()
    res = await client.put(f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"validation": "validated"}, headers=headers)
    assert res.status_code == 422
    res = await client.put(f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"validation": "Refused"}, headers=headers)
    assert res.status_code == 200 and res.json()["validation"] == "Refused"


@pytest.mark.parametrize(
    "field, limit_name",
    [("title", "brdp_title_max_chars"), ("definition", "brdp_text_max_chars"), ("proposal", "brdp_text_max_chars"), ("comments", "brdp_text_max_chars")],
)
async def test_text_over_its_limit_is_refused_never_cut(client, editor_and_project, field, limit_name):
    project, headers = editor_and_project
    limit = getattr(get_settings(), limit_name)
    brdp = (await _create(client, project, headers)).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}"

    res = await client.put(url, json={field: "x" * (limit + 1)}, headers=headers)
    assert res.status_code == 422
    [error] = res.json()["detail"]
    assert error["type"] == "string_too_long" and error["loc"][-1] == field and error["ctx"]["max_length"] == limit
    # Nothing was saved, and nothing was cut.
    stored = next(b for b in (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json() if b["id"] == brdp["id"])
    assert stored[field] == ""
    # Exactly the limit is accepted, whole.
    res = await client.put(url, json={field: "y" * limit}, headers=headers)
    assert res.status_code == 200 and len(res.json()[field]) == limit
    # On create too.
    res = await _create(client, project, headers, **{field: "x" * (limit + 1)})
    assert res.status_code == 422


async def test_text_limit_defaults_are_the_existing_limits():
    """Title: the limit AI Extract already used for a title; long texts:
    Excel's cell limit, so every saved BRDP can be exported."""
    from app.core.config import EXCEL_CELL_CHAR_LIMIT
    from app.services import excel_io

    settings = get_settings()
    assert settings.brdp_title_max_chars == 2000
    assert settings.brdp_text_max_chars == EXCEL_CELL_CHAR_LIMIT == excel_io.EXCEL_CELL_CHAR_LIMIT == 32767


async def test_a_brdp_saved_with_a_longer_text_reads_exports_and_edits_its_other_fields(client, editor_and_project):
    """A BRDP already saved with a text over the new limit (it can only come
    from before the limit, or the Excel import) is read and exported as
    before; only an edit of that field asks to shorten it."""
    project, headers = editor_and_project
    long_title = "t" * (get_settings().brdp_title_max_chars + 50)
    brdp = (await _create(client, project, headers)).json()
    async with async_session_factory() as session:
        from app.models import BRDP

        row = await session.get(BRDP, uuid.UUID(brdp["id"]))
        row.title = long_title
        await session.commit()
    listed = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    assert next(b for b in listed if b["id"] == brdp["id"])["title"] == long_title
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}"
    assert (await client.put(url, json={"proposal": "Shall be used."}, headers=headers)).status_code == 200
    assert (await client.put(url, json={"title": long_title}, headers=headers)).status_code == 422


async def test_history_in_the_body_is_refused(client, editor_and_project):
    project, headers = editor_and_project
    res = await _create(client, project, headers, history=[{"x": 1}])
    assert res.status_code == 422 and res.json()["detail"][0]["type"] == "extra_forbidden"
    brdp = (await _create(client, project, headers)).json()
    res = await client.put(f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"history": []}, headers=headers)
    assert res.status_code == 422 and res.json()["detail"][0]["loc"][-1] == "history"


async def test_a_null_field_is_refused_instead_of_a_500(client, editor_and_project):
    project, headers = editor_and_project
    brdp = (await _create(client, project, headers)).json()
    res = await client.put(f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"title": None}, headers=headers)
    assert res.status_code == 422


# ── Project creation ───────────────────────────────────────────────────────


async def test_unknown_standard_is_refused(client, admin_headers):
    res = await client.post("/api/projects", json={"name": f"P {uuid.uuid4()}", "standard": "S1000D 9.9"}, headers=admin_headers)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail["code"] == "standard_not_supported" and detail["standard"] == "S1000D 9.9"
    assert detail["supported"] == list(SUPPORTED_STANDARDS)


async def test_every_supported_standard_is_accepted(client, admin_headers):
    created = []
    try:
        for standard in SUPPORTED_STANDARDS:
            res = await client.post("/api/projects", json={"name": f"P {uuid.uuid4()}", "standard": standard}, headers=admin_headers)
            assert res.status_code == 201, (standard, res.text)
            created.append(res.json()["id"])
    finally:
        for project_id in created:
            await client.delete(f"/api/projects/{project_id}", headers=admin_headers)


async def test_project_config_with_a_value_that_is_not_text_is_refused(client, admin_headers, editor_and_project):
    res = await client.post(
        "/api/projects",
        json={"name": f"P {uuid.uuid4()}", "standard": "S1000D 4.2", "project_config": {"modelIdentCode": 12}},
        headers=admin_headers,
    )
    assert res.status_code == 422
    assert res.json()["detail"] == {"code": "project_config_value_not_text", "key": "modelIdentCode"}
    project, headers = editor_and_project
    res = await client.put(f"/api/projects/{project.id}/config", json={"project_config": {"projectName": ["x"]}}, headers=headers)
    assert res.status_code == 422 and res.json()["detail"]["key"] == "projectName"
    # A key the app does not know is kept (not a shape the app refuses).
    res = await client.put(
        f"/api/projects/{project.id}/config", json={"project_config": {"projectName": "X", "legacyKey": 1}}, headers=headers
    )
    assert res.status_code == 200


# ── Sanitized unexpected errors ────────────────────────────────────────────


async def test_unexpected_error_body_has_code_and_ref_and_the_log_has_the_detail(client, editor_and_project, monkeypatch, caplog):
    project, headers = editor_and_project
    from app.api.routes import brdps as route

    async def boom(*_a, **_k):
        raise RuntimeError("secret internal detail: connection string postgres://x")

    monkeypatch.setattr(route, "list_active_brdps", boom)
    with caplog.at_level(logging.ERROR, logger="app.errors"):
        res = await client.get(f"/api/projects/{project.id}/brdps", headers=headers)
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert detail["code"] == "internal_error" and len(detail["ref"]) == 8
    assert "secret" not in res.text and "RuntimeError" not in res.text and "postgres" not in res.text
    [record] = [r for r in caplog.records if f"ref={detail['ref']}" in r.getMessage()]
    assert "secret internal detail" in "".join(traceback.format_exception(*record.exc_info))
    assert f"/api/projects/{project.id}/brdps" in record.getMessage()
