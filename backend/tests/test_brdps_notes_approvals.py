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


async def test_duplicate_identifier_rejected_within_same_project(client, editor_and_project):
    project, headers = editor_and_project
    created = await client.post(
        f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-DUP-001"}, headers=headers
    )
    assert created.status_code == 201

    duplicate = await client.post(
        f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-DUP-001"}, headers=headers
    )
    assert duplicate.status_code == 409
    assert "already exists" in duplicate.json()["detail"]

    # the rejected duplicate must not have been saved anyway
    listed = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    assert len(listed) == 1


async def test_identifier_cannot_be_changed_via_put(client, editor_and_project):
    """identifier is immutable once a BRDP is created (docs request: "ID
    nunca debe ser editable, bajo ningún concepto") -- BRDPUpdate doesn't
    declare the field at all, so sending it is silently ignored (not a
    422, not a 409, no special-casing); other fields in the same request
    still apply normally. This replaces the old rename-conflict tests,
    which no longer have a rename to test in the first place.
    """
    project, headers = editor_and_project
    brdp = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMMUTABLE-001"}, headers=headers
        )
    ).json()

    response = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}",
        json={"identifier": "BRDP-SHOULD-BE-IGNORED", "title": "New Title"},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["identifier"] == "BRDP-IMMUTABLE-001"
    assert body["title"] == "New Title"


async def test_same_identifier_is_allowed_in_a_different_project(client, editor_and_project):
    """Uniqueness is per-project, not global -- two independent BRDP
    datasets are allowed to use the same identifier string.
    """
    project_a, headers_a = editor_and_project
    async with async_session_factory() as session:
        project_b = Project(name=f"CRUD Test Project B {uuid.uuid4()}", standard="BREX — S1000D 4.2")
        user_b = User(
            email=f"crud-b-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="CRUD Test Editor B",
            global_role="user",
        )
        session.add_all([project_b, user_b])
        await session.flush()
        session.add(UserProjectRole(user_id=user_b.id, project_id=project_b.id, role="editor"))
        await session.commit()
        await session.refresh(project_b)
        await session.refresh(user_b)
    headers_b = {"Authorization": f"Bearer {create_access_token(user_b.id)}"}

    try:
        created_a = await client.post(
            f"/api/projects/{project_a.id}/brdps", json={"identifier": "BRDP-SHARED-ID"}, headers=headers_a
        )
        assert created_a.status_code == 201

        created_b = await client.post(
            f"/api/projects/{project_b.id}/brdps", json={"identifier": "BRDP-SHARED-ID"}, headers=headers_b
        )
        assert created_b.status_code == 201
    finally:
        async with async_session_factory() as session:
            db_project_b = await session.get(Project, project_b.id)
            if db_project_b is not None:
                await session.delete(db_project_b)
            db_user_b = await session.get(User, user_b.id)
            if db_user_b is not None:
                await session.delete(db_user_b)
            await session.commit()


async def test_next_ext_identifier_starts_at_00001_for_a_new_project(client, editor_and_project):
    project, headers = editor_and_project
    response = await client.get(f"/api/projects/{project.id}/brdps/next-ext-identifier", headers=headers)
    assert response.status_code == 200
    assert response.json()["identifier"] == "BRDP-EXT-00001"


async def test_next_ext_identifier_ignores_non_ext_identifiers(client, editor_and_project):
    """Catalog-imported identifiers (BRDP-S1-NNNNN) and anything else that
    isn't BRDP-EXT-NNNNN must not influence the EXT sequence at all --
    a project seeded from the catalog still starts its first manual BRDP
    at 00001.
    """
    project, headers = editor_and_project
    await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-S1-00099"}, headers=headers)
    await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "SOME-OTHER-ID-999"}, headers=headers)

    response = await client.get(f"/api/projects/{project.id}/brdps/next-ext-identifier", headers=headers)
    assert response.json()["identifier"] == "BRDP-EXT-00001"


async def test_next_ext_identifier_increments_from_existing_ext_ids(client, editor_and_project):
    project, headers = editor_and_project
    await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-EXT-00001"}, headers=headers)
    await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-EXT-00002"}, headers=headers)

    response = await client.get(f"/api/projects/{project.id}/brdps/next-ext-identifier", headers=headers)
    assert response.json()["identifier"] == "BRDP-EXT-00003"


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


async def test_bulk_project_approvals_lists_every_brdps_status(client, editor_and_project):
    """Powers RecordsPage's Rule Status column sort (docs request): needs
    every BRDP's status up front to sort the full dataset before
    pagination, not fetch each row independently like the per-BRDP GET
    endpoint above does for display. A BRDP with no approval row at all
    (draft-1 here) is simply absent from the result -- the frontend
    treats that as "todo", same convention as ruleStateOf(null) already
    uses for the per-BRDP endpoint.
    """
    project, headers = editor_and_project
    todo_brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-BULK-000"}, headers=headers)
    ).json()
    draft_brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-BULK-001"}, headers=headers)
    ).json()
    verified_brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-BULK-002"}, headers=headers)
    ).json()

    await client.put(
        f"/api/projects/{project.id}/brdps/{draft_brdp['id']}/approvals/BREX-4.2",
        json={"rule_xml": "<structureObjectRule/>", "source": "llm"},
        headers=headers,
    )
    approve_url = f"/api/projects/{project.id}/brdps/{verified_brdp['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": "<structureObjectRule/>", "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    response = await client.get(f"/api/projects/{project.id}/approvals/BREX-4.2", headers=headers)
    assert response.status_code == 200
    by_brdp_id = {row["brdp_id"]: row["status"] for row in response.json()}

    assert todo_brdp["id"] not in by_brdp_id
    assert by_brdp_id[draft_brdp["id"]] == "pending_review"
    assert by_brdp_id[verified_brdp["id"]] == "approved"


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


async def test_propose_rejects_malformed_xml(client, editor_and_project):
    """The manual rule editor is a write path into rule_approvals that
    bypasses the generation engine entirely -- so it also bypasses the
    engine's own checkWellFormed() safety net. Without a check here, a
    broken tag saved from the editor (or straight against the API) would
    surface silently, later, inside a generated BREX/Schematron document
    instead of at save time.
    """
    project, headers = editor_and_project
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-APPR-004"}, headers=headers)
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"

    response = await client.put(
        url, json={"rule_xml": "<structureObjectRule>", "source": "manual"}, headers=headers
    )
    assert response.status_code == 422
    assert "not well-formed" in response.json()["detail"]

    # Confirm it was really rejected, not saved anyway.
    fetched = await client.get(url, headers=headers)
    assert fetched.json() is None
