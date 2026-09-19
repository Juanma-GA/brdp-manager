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
        project = Project(name=f"Trash Test Project {uuid.uuid4()}", standard="S1000D 4.2")
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


async def test_editor_can_list_restore_and_delete_own_projects_trash(client, admin_editor_and_project):
    """An editor is no longer admin-gated out of the Trash entirely -- they
    can see and act on their OWN project's trashed rows through every
    endpoint (list, restore, single delete, bulk delete), same as an admin
    would for that project.
    """
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    brdp = await _create_brdp(client, project.id, editor_headers, "BRDP-AUTHZ-001")
    await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=editor_headers)

    list_resp = await client.get("/api/trash", headers=editor_headers)
    assert list_resp.status_code == 200
    assert any(e["id"] == brdp["id"] for e in list_resp.json())

    restore_resp = await client.post(f"/api/trash/{brdp['id']}/restore", headers=editor_headers)
    assert restore_resp.status_code == 200

    await client.delete(f"/api/projects/{project.id}/brdps/{brdp['id']}", headers=editor_headers)
    purge_resp = await client.delete(f"/api/trash/{brdp['id']}", headers=editor_headers)
    assert purge_resp.status_code == 204

    brdp2 = await _create_brdp(client, project.id, editor_headers, "BRDP-AUTHZ-002")
    await client.delete(f"/api/projects/{project.id}/brdps/{brdp2['id']}", headers=editor_headers)
    bulk_resp = await client.request(
        "DELETE", "/api/trash", json={"brdp_ids": [brdp2["id"]]}, headers=editor_headers
    )
    assert bulk_resp.status_code == 200
    assert bulk_resp.json() == {"deleted": [brdp2["id"]], "not_found": []}


async def test_pure_viewer_gets_403_from_trash_list_not_an_empty_list(client, admin_editor_and_project):
    """A viewer (no editor role anywhere) reads as 'no access', not 'your
    trash happens to be empty' -- the section shouldn't even render for
    them, and a direct API call must be a 403, never a 200 with [].
    """
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project

    async with async_session_factory() as session:
        viewer = User(
            email=f"trash-viewer-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Trash Viewer",
            global_role="user",
        )
        session.add(viewer)
        await session.flush()
        session.add(UserProjectRole(user_id=viewer.id, project_id=project.id, role="viewer"))
        await session.commit()
        await session.refresh(viewer)

    viewer_headers = {"Authorization": f"Bearer {create_access_token(viewer.id)}"}
    try:
        resp = await client.get("/api/trash", headers=viewer_headers)
        assert resp.status_code == 403
    finally:
        async with async_session_factory() as session:
            db_user = await session.get(User, viewer.id)
            if db_user is not None:
                await session.delete(db_user)
            await session.commit()


async def test_editor_of_project_a_cannot_touch_project_bs_trash(client, admin_editor_and_project):
    """The actual authorization boundary this round adds: being an editor
    of ONE project must never leak into another project's trash, whether
    through the list, the single-row endpoints (must be 403, not 404 --
    the row genuinely exists, the caller just can't act on it -- and
    definitely not a silent 200/500), or the bulk endpoint (folded into
    `not_found`, indistinguishable from a row that's simply gone, so this
    can't be used to probe another project's data).
    """
    project_a, admin, editor_a, admin_headers, editor_a_headers = admin_editor_and_project

    async with async_session_factory() as session:
        project_b = Project(name=f"Trash Test Project B {uuid.uuid4()}", standard="S1000D 4.2")
        session.add(project_b)
        await session.commit()
        await session.refresh(project_b)

    try:
        brdp_b = await _create_brdp(client, project_b.id, admin_headers, "BRDP-OTHERPROJ-001")
        del_resp = await client.delete(f"/api/projects/{project_b.id}/brdps/{brdp_b['id']}", headers=admin_headers)
        assert del_resp.status_code == 204

        list_resp = await client.get("/api/trash", headers=editor_a_headers)
        assert list_resp.status_code == 200
        assert not any(e["id"] == brdp_b["id"] for e in list_resp.json())

        restore_resp = await client.post(f"/api/trash/{brdp_b['id']}/restore", headers=editor_a_headers)
        assert restore_resp.status_code == 403

        purge_resp = await client.delete(f"/api/trash/{brdp_b['id']}", headers=editor_a_headers)
        assert purge_resp.status_code == 403

        bulk_resp = await client.request(
            "DELETE", "/api/trash", json={"brdp_ids": [brdp_b["id"]]}, headers=editor_a_headers
        )
        assert bulk_resp.status_code == 200
        assert bulk_resp.json() == {"deleted": [], "not_found": [brdp_b["id"]]}

        # Untouched throughout -- still trashed, visible to admin.
        admin_trash = await client.get("/api/trash", headers=admin_headers)
        assert any(e["id"] == brdp_b["id"] for e in admin_trash.json())
    finally:
        async with async_session_factory() as session:
            db_project = await session.get(Project, project_b.id)
            if db_project is not None:
                await session.delete(db_project)
            await session.commit()


async def test_bulk_delete_only_removes_the_selected_rows(client, admin_editor_and_project):
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    created = []
    for i in range(5):
        b = await _create_brdp(client, project.id, editor_headers, f"BRDP-BULK-{i}")
        await client.delete(f"/api/projects/{project.id}/brdps/{b['id']}", headers=editor_headers)
        created.append(b["id"])

    selected = created[:3]
    kept = created[3:]

    resp = await client.request("DELETE", "/api/trash", json={"brdp_ids": selected}, headers=admin_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert sorted(body["deleted"]) == sorted(selected)
    assert body["not_found"] == []

    trash_after = await client.get("/api/trash", headers=admin_headers)
    remaining_ids = {e["id"] for e in trash_after.json()}
    for brdp_id in selected:
        assert brdp_id not in remaining_ids
    for brdp_id in kept:
        assert brdp_id in remaining_ids


async def test_bulk_delete_real_race_reports_restored_row_without_aborting_rest(
    client, admin_editor_and_project
):
    """Not simulated with SQL (docs request explicit on this) -- an actual
    second HTTP call (standing in for "another admin") restores one of
    the 3 selected rows for real, in between the selection and the bulk
    delete request that follows, exactly the sequence a genuine race would
    produce.
    """
    project, admin, editor, admin_headers, editor_headers = admin_editor_and_project
    created = []
    for i in range(3):
        b = await _create_brdp(client, project.id, editor_headers, f"BRDP-RACE-{i}")
        await client.delete(f"/api/projects/{project.id}/brdps/{b['id']}", headers=editor_headers)
        created.append(b["id"])

    selected = list(created)  # snapshot, as the UI would have from its own earlier checkbox selection

    # The real race: this row leaves the Trash for real before the bulk
    # delete request below is sent.
    restored_id = selected[1]
    restore_resp = await client.post(f"/api/trash/{restored_id}/restore", headers=admin_headers)
    assert restore_resp.status_code == 200

    resp = await client.request("DELETE", "/api/trash", json={"brdp_ids": selected}, headers=admin_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["not_found"] == [restored_id]
    assert sorted(body["deleted"]) == sorted(x for x in selected if x != restored_id)

    # The restored row is untouched -- still exists, no longer trashed.
    trash_after = await client.get("/api/trash", headers=admin_headers)
    assert not any(e["id"] == restored_id for e in trash_after.json())
    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=editor_headers)
    assert any(b["id"] == restored_id for b in listed.json())
