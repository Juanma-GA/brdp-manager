"""Real per-field audit trail (docs request: Option B, a genuine
brdp_history table -- not v1's unused brdps.history JSONB blob). Covers:
a real diff writes exactly one row per changed field, a no-op save
writes nothing, rule_status transitions get logged from approvals.py,
and a viewer can read but not write.
"""
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDPHistory, Project, User, UserProjectRole


@pytest.fixture(autouse=True)
def _mock_embeddings_transport():
    """A "Validated" proposal_status change triggers a real embedding call
    (docs/v2 §3 point 1) -- mocked here for the same reason
    test_brdps_notes_approvals.py mocks it: this file's job is the audit
    trail, not embeddings correctness.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": [0.1] * 1024, "index": 0}]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


@pytest.fixture
async def editor_viewer_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"History Test Project {uuid.uuid4()}", standard="BREX — S1000D 4.2")
        editor = User(
            email=f"history-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="History Test Editor",
            global_role="user",
        )
        viewer = User(
            email=f"history-viewer-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="History Test Viewer",
            global_role="user",
        )
        session.add_all([project, editor, viewer])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        session.add(UserProjectRole(user_id=viewer.id, project_id=project.id, role="viewer"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)
        await session.refresh(viewer)

    editor_headers = {"Authorization": f"Bearer {create_access_token(editor.id)}"}
    viewer_headers = {"Authorization": f"Bearer {create_access_token(viewer.id)}"}
    yield project, editor, editor_headers, viewer_headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        for user_id in (editor.id, viewer.id):
            db_user = await session.get(User, user_id)
            if db_user is not None:
                await session.delete(db_user)
        await session.commit()


async def test_editing_a_field_writes_one_history_row_with_old_and_new_value(
    client, editor_viewer_and_project
):
    project, editor, editor_headers, _viewer_headers = editor_viewer_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-HIST-001"}, headers=editor_headers
        )
    ).json()

    response = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}",
        json={"definition": "New definition text"},
        headers=editor_headers,
    )
    assert response.status_code == 200

    history = (
        await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=editor_headers)
    ).json()
    assert len(history) == 1
    assert history[0]["field_name"] == "definition"
    assert history[0]["old_value"] == ""
    assert history[0]["new_value"] == "New definition text"
    assert history[0]["user_email"] == editor.email


async def test_saving_the_same_value_writes_no_history_row(client, editor_viewer_and_project):
    """The core "un cambio real, no un guardado" requirement -- a PUT that
    doesn't actually change anything must not pollute the audit trail.
    """
    project, _editor, editor_headers, _viewer_headers = editor_viewer_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps",
            json={"identifier": "BRDP-HIST-002", "title": "Same Title"},
            headers=editor_headers,
        )
    ).json()

    response = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}",
        json={"title": "Same Title"},
        headers=editor_headers,
    )
    assert response.status_code == 200

    history = (
        await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=editor_headers)
    ).json()
    assert history == []


async def test_multiple_field_changes_in_one_save_write_multiple_rows(client, editor_viewer_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_viewer_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-HIST-003"}, headers=editor_headers
        )
    ).json()

    response = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}",
        json={"title": "New Title", "definition": "New Definition", "validation": "Validated"},
        headers=editor_headers,
    )
    assert response.status_code == 200

    history = (
        await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=editor_headers)
    ).json()
    field_names = {h["field_name"] for h in history}
    # "validation" is exposed under its Proposal Status audit name, not the
    # raw DB column name -- matches the renamed table column in the UI.
    # identifier is absent from BRDPUpdate entirely (immutable once
    # created), so it can never appear here.
    assert field_names == {"title", "definition", "proposal_status"}


async def test_history_ordered_newest_first(client, editor_viewer_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_viewer_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-HIST-004"}, headers=editor_headers
        )
    ).json()

    await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"title": "First"}, headers=editor_headers
    )
    await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"title": "Second"}, headers=editor_headers
    )

    history = (
        await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=editor_headers)
    ).json()
    assert len(history) == 2
    assert history[0]["new_value"] == "Second"
    assert history[1]["new_value"] == "First"


async def test_rule_status_transitions_are_logged(client, editor_viewer_and_project):
    project, _editor, editor_headers, _viewer_headers = editor_viewer_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-HIST-005"}, headers=editor_headers
        )
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"

    # todo -> draft (creating the rule)
    await client.put(url, json={"rule_xml": "<structureObjectRule/>", "source": "manual"}, headers=editor_headers)
    # editing while still draft must NOT log a second rule_status transition
    await client.put(
        url, json={"rule_xml": "<structureObjectRule id='x'/>", "source": "manual"}, headers=editor_headers
    )
    # draft -> verified
    await client.post(url + "/approve", headers=editor_headers)
    # verified -> draft
    await client.post(url + "/revoke", headers=editor_headers)

    history = (
        await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=editor_headers)
    ).json()
    rule_status_entries = [h for h in history if h["field_name"] == "rule_status"]
    transitions = [(h["old_value"], h["new_value"]) for h in reversed(rule_status_entries)]
    assert transitions == [("todo", "draft"), ("draft", "verified"), ("verified", "draft")]


async def test_viewer_can_read_history_but_not_trigger_writes(client, editor_viewer_and_project):
    project, _editor, editor_headers, viewer_headers = editor_viewer_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-HIST-006"}, headers=editor_headers
        )
    ).json()
    await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"title": "Editor Wrote This"}, headers=editor_headers
    )

    response = await client.get(
        f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=viewer_headers
    )
    assert response.status_code == 200
    assert len(response.json()) == 1

    denied = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"title": "Viewer Hack"}, headers=viewer_headers
    )
    assert denied.status_code == 403


async def test_history_survives_the_acting_users_account_being_deleted(client, editor_viewer_and_project):
    """user_id is ON DELETE SET NULL specifically so the audit trail
    outlives the account that made the change -- user_email is the
    point-in-time snapshot that keeps "who" visible even then.
    """
    project, editor, editor_headers, _viewer_headers = editor_viewer_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-HIST-007"}, headers=editor_headers
        )
    ).json()
    await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"title": "Before Deletion"}, headers=editor_headers
    )

    async with async_session_factory() as session:
        db_editor = await session.get(User, editor.id)
        await session.delete(db_editor)
        await session.commit()

    async with async_session_factory() as session:
        rows = (
            (await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id == uuid.UUID(brdp["id"]))))
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].user_id is None
        assert rows[0].user_email == editor.email
