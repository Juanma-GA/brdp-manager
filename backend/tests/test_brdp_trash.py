"""Papelera (Trash): soft-delete via DELETE /brdps/{id} and the bulk
Reset Data path, GET/restore/permanent-delete under /api/trash. Real
Postgres, no mocking except the Mistral embeddings call (Phase 5's
existing precedent) triggered by validating a BRDP.
"""
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDPHistory, Project, RuleApproval, User, UserProjectRole


@pytest.fixture(autouse=True)
def _mock_embeddings_transport():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": [0.1] * 1024, "index": 0}]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


@pytest.fixture
async def admin_editor_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"Trash Test Project {uuid.uuid4()}", standard="BREX — S1000D 4.2")
        admin = User(
            email=f"trash-admin-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Trash Admin",
            global_role="admin",
        )
        editor = User(
            email=f"trash-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Trash Editor",
            global_role="user",
        )
        session.add_all([project, admin, editor])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(admin)
        await session.refresh(editor)

    admin_headers = {"Authorization": f"Bearer {create_access_token(admin.id)}"}
    editor_headers = {"Authorization": f"Bearer {create_access_token(editor.id)}"}
    yield project, admin, editor, admin_headers, editor_headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        for user_id in (admin.id, editor.id):
            db_user = await session.get(User, user_id)
            if db_user is not None:
                await session.delete(db_user)
        await session.commit()


async def _create_brdp(client, project_id, headers, identifier):
    resp = await client.post(
        f"/api/projects/{project_id}/brdps", json={"identifier": identifier}, headers=headers
    )
    assert resp.status_code == 201
    return resp.json()


async def test_soft_delete_hides_from_list_and_appears_in_trash(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    brdp = await _create_brdp(client, project.id, editor_headers, "BRDP-TRASH-001")

    deleted = await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=editor_headers)
    assert deleted.status_code == 204

    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=editor_headers)
    assert listed.json() == []

    trash = await client.get("/api/trash", headers=admin_headers)
    assert trash.status_code == 200
    entries = [e for e in trash.json() if e["id"] == brdp["id"]]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["identifier"] == "BRDP-TRASH-001"
    assert entry["project_id"] == str(project.id)
    assert entry["project_name"] == project.name
    assert entry["deleted_by_email"] == editor.email


async def test_deleted_brdp_excluded_from_similar_precedent(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project

    # 3 Validated BRDPs, all with the same (mocked) embedding -- exactly
    # MIN_CANDIDATES (similar.py), so sufficient_precedent starts True.
    validated_ids = []
    for i in range(3):
        b = await _create_brdp(client, project.id, editor_headers, f"BRDP-PREC-{i}")
        upd = await client.put(
            f"/api/projects/{project.id}/brdps/{b['id']}",
            json={"definition": "same definition text", "proposal": "same proposal text", "validation": "Validated"},
            headers=editor_headers,
        )
        assert upd.status_code == 200
        validated_ids.append(b["id"])

    query_brdp = await _create_brdp(client, project.id, editor_headers, "BRDP-PREC-QUERY")
    await client.put(
        f"/api/projects/{project.id}/brdps/{query_brdp['id']}",
        json={"definition": "same definition text", "proposal": "same proposal text"},
        headers=editor_headers,
    )

    before = await client.get(
        f"/api/projects/{project.id}/brdps/{query_brdp['id']}/similar",
        params={"kind": "definition"},
        headers=editor_headers,
    )
    assert before.status_code == 200
    assert before.json()["sufficient_precedent"] is True
    assert len(before.json()["candidates"]) == 3

    # Soft-delete one of the 3 precedents -- must drop out of the
    # candidate set even though its embedding/validation are untouched.
    del_resp = await client.delete(
        f"/api/projects/{project.id}/brdps/{validated_ids[0]}", headers=editor_headers
    )
    assert del_resp.status_code == 204

    after = await client.get(
        f"/api/projects/{project.id}/brdps/{query_brdp['id']}/similar",
        params={"kind": "definition"},
        headers=editor_headers,
    )
    assert after.status_code == 200
    assert len(after.json()["candidates"]) == 2
    assert after.json()["sufficient_precedent"] is False


async def test_deleted_brdp_excluded_from_approvals_export_but_rule_approval_survives(
    client, admin_editor_and_project
):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    brdp = await _create_brdp(client, project.id, editor_headers, "BRDP-EXPORT-001")

    proposed = await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2",
        json={"rule_xml": "<structureObjectRule/>", "status": "approved"},
        headers=editor_headers,
    )
    assert proposed.status_code == 200

    export_before = await client.get(f"/api/projects/{project.id}/approvals/BREX-4.2/export", headers=editor_headers)
    assert any(row["brdp_id"] == brdp["id"] for row in export_before.json())

    deleted = await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=editor_headers)
    assert deleted.status_code == 204

    export_after = await client.get(f"/api/projects/{project.id}/approvals/BREX-4.2/export", headers=editor_headers)
    assert not any(row["brdp_id"] == brdp["id"] for row in export_after.json())

    bulk_after = await client.get(f"/api/projects/{project.id}/approvals/BREX-4.2", headers=editor_headers)
    assert not any(row["brdp_id"] == brdp["id"] for row in bulk_after.json())

    # The rule_approvals row itself is untouched by a soft-delete -- only
    # hidden from the reads above, per the docs request ("aunque su
    # rule_approvals siga viva").
    async with async_session_factory() as session:
        approval = await session.get(RuleApproval, (uuid.UUID(brdp["id"]), "BREX-4.2"))
        assert approval is not None
        assert approval.status == "approved"


async def test_restore_brings_back_with_rule_status_intact(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    brdp = await _create_brdp(client, project.id, editor_headers, "BRDP-RESTORE-001")
    await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2",
        json={"rule_xml": "<structureObjectRule/>", "status": "approved"},
        headers=editor_headers,
    )
    await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=editor_headers)

    restored = await client.post(f"/api/trash/{brdp['id']}/restore", headers=admin_headers)
    assert restored.status_code == 200
    assert restored.json()["identifier"] == "BRDP-RESTORE-001"

    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=editor_headers)
    assert any(b["id"] == brdp["id"] for b in listed.json())

    bulk = await client.get(f"/api/projects/{project.id}/approvals/BREX-4.2", headers=editor_headers)
    restored_row = next(row for row in bulk.json() if row["brdp_id"] == brdp["id"])
    assert restored_row["status"] == "approved"

    trash_after = await client.get("/api/trash", headers=admin_headers)
    assert not any(e["id"] == brdp["id"] for e in trash_after.json())


async def test_identifier_reuse_after_delete_then_restore_conflict(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    original = await _create_brdp(client, project.id, editor_headers, "BRDP-REUSE-001")
    await client.delete(f"/api/projects/{project.id}/brdps/{original['id']}", headers=editor_headers)

    # A brand-new BRDP with the SAME identifier in the SAME project must
    # now be allowed -- the partial unique index only constrains active rows.
    recreated = await client.post(
        f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-REUSE-001"}, headers=editor_headers
    )
    assert recreated.status_code == 201
    assert recreated.json()["id"] != original["id"]

    # Restoring the original now conflicts with the new active BRDP --
    # must be a clean, explained 409, not a raw integrity error.
    restore = await client.post(f"/api/trash/{original['id']}/restore", headers=admin_headers)
    assert restore.status_code == 409
    assert "BRDP-REUSE-001" in restore.json()["detail"]


async def test_reset_data_bulk_soft_deletes_all_active(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    created_ids = []
    for i in range(5):
        b = await _create_brdp(client, project.id, editor_headers, f"BRDP-RESET-{i}")
        created_ids.append(b["id"])

    reset = await client.delete(f"/api/projects/{project.id}/brdps", headers=editor_headers)
    assert reset.status_code == 204

    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=editor_headers)
    assert listed.json() == []

    trash = await client.get("/api/trash", headers=admin_headers)
    trashed_ids = {e["id"] for e in trash.json()}
    for brdp_id in created_ids:
        assert brdp_id in trashed_ids


async def test_permanent_delete_removes_from_trash_and_history_survives(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    brdp = await _create_brdp(client, project.id, editor_headers, "BRDP-PURGE-001")
    brdp_uuid = uuid.UUID(brdp["id"])
    await client.put(
        f"/api/projects/{project.id}/brdps/{brdp['id']}", json={"title": "Renamed"}, headers=editor_headers
    )
    await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=editor_headers)

    # Capture this BRDP's own history row ids BEFORE purging -- filtering
    # by brdp_id afterward is impossible (that's the whole point of the
    # SET NULL), so this is what lets the post-purge check stay scoped to
    # THIS brdp instead of any brdp_id-IS-NULL row in the whole table.
    async with async_session_factory() as session:
        history_ids = (
            (await session.execute(select(BRDPHistory.id).where(BRDPHistory.brdp_id == brdp_uuid)))
            .scalars()
            .all()
        )
    assert len(history_ids) >= 2  # the title edit + the delete's "status" entry

    purged = await client.delete(f"/api/trash/{brdp['id']}", headers=admin_headers)
    assert purged.status_code == 204

    trash_after = await client.get("/api/trash", headers=admin_headers)
    assert not any(e["id"] == brdp["id"] for e in trash_after.json())

    restore_gone = await client.post(f"/api/trash/{brdp['id']}/restore", headers=admin_headers)
    assert restore_gone.status_code == 404

    async with async_session_factory() as session:
        surviving = (
            (await session.execute(select(BRDPHistory).where(BRDPHistory.id.in_(history_ids))))
            .scalars()
            .all()
        )
        assert len(surviving) == len(history_ids)
        assert all(row.brdp_id is None for row in surviving)


async def test_editor_cannot_access_trash_endpoints(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    brdp = await _create_brdp(client, project.id, editor_headers, "BRDP-AUTHZ-001")
    await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=editor_headers)

    list_resp = await client.get("/api/trash", headers=editor_headers)
    assert list_resp.status_code == 403

    restore_resp = await client.post(f"/api/trash/{brdp['id']}/restore", headers=editor_headers)
    assert restore_resp.status_code == 403

    purge_resp = await client.delete(f"/api/trash/{brdp['id']}", headers=editor_headers)
    assert purge_resp.status_code == 403
