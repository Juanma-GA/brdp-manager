"""Functional correctness of the brdps/notes/approvals CRUD endpoints
(as an editor -- authorization itself is covered separately in
test_authorization.py). Real Postgres, no mocking -- except the Mistral
embeddings call triggered by validating a BRDP (Phase 5), mocked here
because this file's job is CRUD correctness, not embeddings correctness
(see test_similar.py / test_embeddings.py for that).
"""
import uuid

import httpx
import pytest

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import Project, User, UserProjectRole


@pytest.fixture(autouse=True)
def _mock_embeddings_transport():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": [0.1] * 1024, "index": 0}]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


@pytest.fixture
async def editor_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"CRUD Test Project {uuid.uuid4()}", standard="S1000D 4.2")
        user = User(
            email=f"crud-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="CRUD Test Editor",
            global_role="user",
        )
        session.add_all([project, user])
        await session.flush()
        session.add(UserProjectRole(user_id=user.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(user)

    headers = {"Authorization": f"Bearer {create_access_token(user.id)}"}
    yield project, headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
        await session.commit()


async def test_brdp_create_read_update_delete(client, editor_and_project):
    project, headers = editor_and_project

    created = await client.post(
        f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-CRUD-001"}, headers=headers
    )
    assert created.status_code == 201
    brdp = created.json()
    assert brdp["validation"] == "Pending"
    assert brdp["history"] == []

    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=headers)
    assert len(listed.json()) == 1

    updated = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}",
        json={"title": "New title", "validation": "Validated"},
        headers=headers,
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["title"] == "New title"
    assert body["validation"] == "Validated"
    assert body["identifier"] == "BRDP-CRUD-001"  # untouched fields survive a partial update

    deleted = await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=headers)
    assert deleted.status_code == 204

    listed_after = await client.get(f"/api/projects/{project.id}/brdps", headers=headers)
    assert listed_after.json() == []


async def test_note_defaults_to_empty_then_upserts(client, editor_and_project):
    project, headers = editor_and_project
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-NOTE-001"}, headers=headers)
    ).json()

    empty = await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/notes", headers=headers)
    assert empty.status_code == 200
    assert empty.json()["text"] == ""

    upserted = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}/notes", json={"text": "some notes"}, headers=headers
    )
    assert upserted.status_code == 200
    assert upserted.json()["text"] == "some notes"

    refetched = await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/notes", headers=headers)
    assert refetched.json()["text"] == "some notes"

    overwritten = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}/notes", json={"text": "replaced"}, headers=headers
    )
    assert overwritten.json()["text"] == "replaced"


async def test_approval_propose_get_approve_revoke_lifecycle(client, editor_and_project):
    project, headers = editor_and_project
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-APPR-001"}, headers=headers)
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"

    none_yet = await client.get(url, headers=headers)
    assert none_yet.status_code == 200
    assert none_yet.json() is None

    proposed = await client.put(url, json={"rule_xml": "<structureObjectRule/>", "source": "llm"}, headers=headers)
    assert proposed.status_code == 200
    assert proposed.json()["status"] == "pending_review"
    assert proposed.json()["approved_at"] is None

    fetched = await client.get(url, headers=headers)
    assert fetched.json()["status"] == "pending_review"

    approved = await client.post(url + "/approve", headers=headers)
    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"
    assert approved.json()["approved_at"] is not None

    revoked = await client.delete(url, headers=headers)
    assert revoked.status_code == 204

    gone = await client.get(url, headers=headers)
    assert gone.json() is None


async def test_approving_without_a_pending_review_row_404s(client, editor_and_project):
    project, headers = editor_and_project
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-APPR-002"}, headers=headers)
    ).json()

    response = await client.post(
        f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2/approve", headers=headers
    )
    assert response.status_code == 404


async def test_manual_propose_can_save_directly_as_approved(client, editor_and_project):
    """v1 parity: DetailPanel's manual edit mode saves straight to
    'approved' -- a human who wrote/reviewed the rule themselves has
    nothing left to re-review.
    """
    project, headers = editor_and_project
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-APPR-003"}, headers=headers)
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"

    response = await client.put(
        url, json={"rule_xml": "<manual/>", "source": "manual", "status": "approved"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["approved_at"] is not None
