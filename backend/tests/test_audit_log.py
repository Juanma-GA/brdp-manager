"""Protecciones 2b: audit log of administrative actions.

One row per action, written in the same transaction as the action: a
refused action (404, 403, 409, 400) leaves none, and a row that cannot be
written undoes the action. The rows outlive their actor and target, never
carry a password, and only an admin can read them through
GET /api/admin/audit-log.

Real Postgres, no mocking (except replacing the audit writer in the one
test that makes it fail).
"""
import json
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, AuditLog, EmbeddingJob, Project, User, UserProjectRole

PASSWORD = "Audit-log-pw-123"


def _headers(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _user(prefix, global_role="user"):
    return User(
        email=f"{prefix}-{uuid.uuid4()}@example.com",
        password_hash=hash_password(PASSWORD),
        display_name=prefix,
        global_role=global_role,
    )


@pytest.fixture
async def world():
    """An admin (the actor), an editor of the project, a plain user (the
    target of user and role actions), and a project with one active BRDP
    and two in the Papelera."""
    async with async_session_factory() as session:
        project = Project(name=f"Audit project {uuid.uuid4()}", standard="S1000D 4.2")
        other = Project(name=f"Audit other {uuid.uuid4()}", standard="S1000D 4.2")
        admin = _user("audit-admin", "admin")
        editor = _user("audit-editor")
        target = _user("audit-target")
        session.add_all([project, other, admin, editor, target])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        now = datetime.now(timezone.utc)
        active = BRDP(project_id=project.id, identifier="BRDP-AUD-00001", title="Active one")
        trashed_a = BRDP(project_id=project.id, identifier="BRDP-AUD-00002", title="Trashed A", deleted_at=now)
        trashed_b = BRDP(project_id=project.id, identifier="BRDP-AUD-00003", title="Trashed B", deleted_at=now)
        trashed_other = BRDP(project_id=other.id, identifier="BRDP-AUD-00004", title="Other", deleted_at=now)
        session.add_all([active, trashed_a, trashed_b, trashed_other])
        await session.commit()
        ids = {
            "project": project,
            "other": other,
            "admin": admin,
            "editor": editor,
            "target": target,
            "active": active.id,
            "trashed_a": trashed_a.id,
            "trashed_b": trashed_b.id,
            "trashed_other": trashed_other.id,
        }
    yield ids
    async with async_session_factory() as session:
        for p in (project, other):
            row = await session.get(Project, p.id)
            if row is not None:
                await session.delete(row)
        for u in (admin, editor, target):
            row = await session.get(User, u.id)
            if row is not None:
                await session.delete(row)
        await session.execute(delete(AuditLog).where(AuditLog.actor_id.in_([admin.id, editor.id])))
        await session.commit()


async def _rows(world, action=None):
    """Audit rows written by this test's admin or editor, oldest first."""
    async with async_session_factory() as session:
        stmt = select(AuditLog).where(AuditLog.actor_id.in_([world["admin"].id, world["editor"].id]))
        if action:
            stmt = stmt.where(AuditLog.action == action)
        return list((await session.execute(stmt.order_by(AuditLog.created_at, AuditLog.id))).scalars().all())


# ── BRDPs ────────────────────────────────────────────────────────────────


async def test_brdp_deleted_permanently_one(client, world):
    response = await client.delete(f"/api/trash/{world['trashed_a']}", headers=_headers(world["editor"]))
    assert response.status_code == 204
    [row] = await _rows(world)
    assert row.action == "brdp.deleted_permanently"
    assert row.actor_id == world["editor"].id and row.actor_email == world["editor"].email
    assert row.target_type == "brdp" and row.target_id == world["trashed_a"]
    assert row.target_label == "BRDP-AUD-00002"
    assert row.project_id == world["project"].id and row.project_name == world["project"].name
    assert row.detail == {"title": "Trashed A"}


async def test_bulk_delete_writes_one_row_per_brdp_really_deleted(client, world):
    """An active BRDP, an unknown id and one from a project the editor
    cannot act on are not deleted, so they leave no row."""
    ids = [world["trashed_a"], world["trashed_b"], world["active"], uuid.uuid4(), world["trashed_other"]]
    response = await client.request(
        "DELETE", "/api/trash", json={"brdp_ids": [str(i) for i in ids]}, headers=_headers(world["editor"])
    )
    assert response.status_code == 200
    assert set(response.json()["deleted"]) == {str(world["trashed_a"]), str(world["trashed_b"])}
    rows = await _rows(world)
    assert sorted(r.target_label for r in rows) == ["BRDP-AUD-00002", "BRDP-AUD-00003"]
    assert all(r.action == "brdp.deleted_permanently" for r in rows)


async def test_refused_brdp_deletes_leave_no_row(client, world):
    # 404: an active BRDP is not in the Papelera.
    assert (await client.delete(f"/api/trash/{world['active']}", headers=_headers(world["editor"]))).status_code == 404
    # 403: the editor has no role on the other project.
    assert (
        await client.delete(f"/api/trash/{world['trashed_other']}", headers=_headers(world["editor"]))
    ).status_code == 403
    assert await _rows(world) == []


# ── Projects ─────────────────────────────────────────────────────────────


async def test_project_trashed_restored_and_deleted_permanently(client, world):
    admin = _headers(world["admin"])
    project = world["project"]
    assert (await client.delete(f"/api/projects/{project.id}", headers=admin)).status_code == 204
    restored = await client.post(
        f"/api/trash/projects/{project.id}/restore", json={"name": project.name + " back"}, headers=admin
    )
    assert restored.status_code == 200
    assert (await client.delete(f"/api/projects/{project.id}", headers=admin)).status_code == 204
    assert (await client.delete(f"/api/trash/projects/{project.id}", headers=admin)).status_code == 204

    trashed, restored_row, trashed_again, deleted = await _rows(world)
    assert trashed.action == "project.trashed" and trashed.target_label == project.name
    assert trashed.target_type == "project" and trashed.target_id == project.id
    assert trashed.detail == {"standard": "S1000D 4.2"}
    assert restored_row.action == "project.restored"
    assert restored_row.target_label == project.name + " back"
    assert restored_row.detail == {"previous_name": project.name}
    assert trashed_again.action == "project.trashed"
    assert deleted.action == "project.deleted_permanently"
    # Three BRDPs: one active and two in the Papelera -- all counted.
    assert deleted.detail == {"brdp_count": 3, "standard": "S1000D 4.2", "was_in_trash": True}
    assert deleted.project_name == project.name + " back"


async def test_project_deleted_with_permanent_true_writes_one_row(client, world):
    """A project with many BRDPs is still one row, with the number."""
    project = world["project"]
    async with async_session_factory() as session:
        session.add_all(
            [BRDP(project_id=project.id, identifier=f"BRDP-AUD-1{n:04d}", title="x") for n in range(500)]
        )
        await session.commit()
    response = await client.delete(f"/api/projects/{project.id}?permanent=true", headers=_headers(world["admin"]))
    assert response.status_code == 204
    [row] = await _rows(world)
    assert row.action == "project.deleted_permanently"
    assert row.detail == {"brdp_count": 503, "standard": "S1000D 4.2", "was_in_trash": False}


async def test_refused_project_actions_leave_no_row(client, world):
    admin = _headers(world["admin"])
    project = world["project"]
    # 409: a job runs on the project.
    async with async_session_factory() as session:
        job = EmbeddingJob(project_id=project.id, status="running", total_items=1, processed_items=0)
        session.add(job)
        await session.commit()
    assert (await client.delete(f"/api/projects/{project.id}", headers=admin)).status_code == 409
    async with async_session_factory() as session:
        (await session.get(EmbeddingJob, job.id)).status = "completed"
        await session.commit()
    # 403: an editor cannot delete a project.
    assert (await client.delete(f"/api/projects/{project.id}", headers=_headers(world["editor"]))).status_code == 403
    # 404: restore and permanent delete of a project not in the Papelera.
    assert (await client.post(f"/api/trash/projects/{project.id}/restore", headers=admin)).status_code == 404
    assert (await client.delete(f"/api/trash/projects/{project.id}", headers=admin)).status_code == 404
    # 409: restoring under a name an active project already has.
    assert (await client.delete(f"/api/projects/{project.id}", headers=admin)).status_code == 204
    clash = await client.post(
        f"/api/trash/projects/{project.id}/restore", json={"name": world["other"].name}, headers=admin
    )
    assert clash.status_code == 409
    assert [r.action for r in await _rows(world)] == ["project.trashed"]


# ── Users ────────────────────────────────────────────────────────────────


async def test_user_created_updated_and_password_reset(client, world):
    admin = _headers(world["admin"])
    email = f"audit-new-{uuid.uuid4()}@example.com"
    created = await client.post(
        "/api/users", json={"email": email, "display_name": "New", "global_role": "user"}, headers=admin
    )
    assert created.status_code == 201
    user_id = created.json()["id"]
    temporary = created.json()["temporary_password"]
    try:
        # No change: no row.
        same = await client.patch(f"/api/users/{user_id}", json={"email": email, "display_name": "New"}, headers=admin)
        assert same.status_code == 200
        new_email = f"audit-renamed-{uuid.uuid4()}@example.com"
        changed = await client.patch(
            f"/api/users/{user_id}", json={"email": new_email, "display_name": "Renamed"}, headers=admin
        )
        assert changed.status_code == 200
        reset = await client.post(f"/api/users/{user_id}/reset-password", headers=admin)
        assert reset.status_code == 200
        new_temporary = reset.json()["temporary_password"]

        created_row, updated_row, reset_row = await _rows(world)
        assert created_row.action == "user.created" and created_row.target_label == email
        assert created_row.target_type == "user" and str(created_row.target_id) == user_id
        assert created_row.detail == {"global_role": "user"}
        assert updated_row.action == "user.updated"
        assert updated_row.detail == {
            "email": {"old": email, "new": new_email},
            "display_name": {"old": "New", "new": "Renamed"},
        }
        assert reset_row.action == "user.password_reset" and reset_row.detail == {}
        # No password anywhere in the log, not even a temporary one.
        for row in (created_row, updated_row, reset_row):
            dumped = json.dumps(row.detail) + row.target_label
            assert temporary not in dumped and new_temporary not in dumped
    finally:
        async with async_session_factory() as session:
            row = await session.get(User, uuid.UUID(user_id))
            if row is not None:
                await session.delete(row)
                await session.commit()


async def test_user_trashed_restored_and_deleted_permanently_with_roles(client, world):
    admin = _headers(world["admin"])
    target = world["target"]
    for project, role in ((world["project"], "editor"), (world["other"], "viewer")):
        assigned = await client.put(
            f"/api/users/{target.id}/project-roles", json={"project_id": str(project.id), "role": role}, headers=admin
        )
        assert assigned.status_code == 200
    assert (await client.delete(f"/api/users/{target.id}", headers=admin)).status_code == 204
    assert (await client.post(f"/api/users/{target.id}/restore", headers=admin)).status_code == 200
    assert (await client.delete(f"/api/users/{target.id}", headers=admin)).status_code == 204
    assert (await client.delete(f"/api/users/{target.id}/permanent", headers=admin)).status_code == 204

    rows = [r for r in await _rows(world) if r.target_type == "user"]
    assert [r.action for r in rows] == ["user.trashed", "user.restored", "user.trashed", "user.deleted_permanently"]
    assert all(r.target_id == target.id and r.target_label == target.email for r in rows)
    assert rows[0].detail == {"global_role": "user"}
    assert rows[-1].detail == {
        "global_role": "user",
        "project_roles": sorted(
            [
                {"project": world["project"].name, "role": "editor"},
                {"project": world["other"].name, "role": "viewer"},
            ],
            key=lambda r: r["project"],
        ),
    }


async def test_refused_user_actions_leave_no_row(client, world):
    admin = _headers(world["admin"])
    target = world["target"]
    # 400: an admin cannot delete themself.
    assert (await client.delete(f"/api/users/{world['admin'].id}", headers=admin)).status_code == 400
    # 403: only an admin manages users.
    assert (await client.delete(f"/api/users/{target.id}", headers=_headers(world["editor"]))).status_code == 403
    # 404: unknown user; restore and permanent delete of an active one.
    assert (await client.post(f"/api/users/{uuid.uuid4()}/reset-password", headers=admin)).status_code == 404
    assert (await client.post(f"/api/users/{target.id}/restore", headers=admin)).status_code == 404
    assert (await client.delete(f"/api/users/{target.id}/permanent", headers=admin)).status_code == 404
    # 409: an email another user has.
    clash = await client.patch(
        f"/api/users/{target.id}", json={"email": world["editor"].email, "display_name": "x"}, headers=admin
    )
    assert clash.status_code == 409
    # 409: restoring a user whose email an active user now has.
    assert (await client.delete(f"/api/users/{target.id}", headers=admin)).status_code == 204
    async with async_session_factory() as session:
        twin = User(email=target.email, password_hash=hash_password(PASSWORD), display_name="twin", global_role="user")
        session.add(twin)
        await session.commit()
    try:
        assert (await client.post(f"/api/users/{target.id}/restore", headers=admin)).status_code == 409
    finally:
        async with async_session_factory() as session:
            await session.delete(await session.get(User, twin.id))
            await session.commit()
    assert [r.action for r in await _rows(world)] == ["user.trashed"]


# ── Project roles ────────────────────────────────────────────────────────


async def test_project_role_assigned_changed_and_removed(client, world):
    admin = _headers(world["admin"])
    target, project = world["target"], world["project"]
    url = f"/api/users/{target.id}/project-roles"
    body = {"project_id": str(project.id)}
    assert (await client.put(url, json={**body, "role": "viewer"}, headers=admin)).status_code == 200
    # Same role again: no row.
    assert (await client.put(url, json={**body, "role": "viewer"}, headers=admin)).status_code == 200
    assert (await client.put(url, json={**body, "role": "editor"}, headers=admin)).status_code == 200
    assert (await client.delete(f"{url}/{project.id}", headers=admin)).status_code == 204
    # Removing a role that is not there: no row.
    assert (await client.delete(f"{url}/{project.id}", headers=admin)).status_code == 204

    assigned, changed, removed = await _rows(world)
    for row in (assigned, changed, removed):
        assert row.target_type == "project_role"
        assert row.target_id == target.id and row.target_label == target.email
        assert row.project_id == project.id and row.project_name == project.name
    assert assigned.action == "project_role.assigned" and assigned.detail == {"old_role": None, "new_role": "viewer"}
    assert changed.action == "project_role.changed" and changed.detail == {"old_role": "viewer", "new_role": "editor"}
    assert removed.action == "project_role.removed" and removed.detail == {"old_role": "editor", "new_role": None}


async def test_refused_role_assignments_leave_no_row(client, world):
    admin = _headers(world["admin"])
    url = f"/api/users/{world['target'].id}/project-roles"
    assert (
        await client.put(url, json={"project_id": str(uuid.uuid4()), "role": "viewer"}, headers=admin)
    ).status_code == 404
    assert (
        await client.put(
            f"/api/users/{uuid.uuid4()}/project-roles",
            json={"project_id": str(world["project"].id), "role": "viewer"},
            headers=admin,
        )
    ).status_code == 404
    assert (
        await client.put(url, json={"project_id": str(world["project"].id), "role": "owner"}, headers=admin)
    ).status_code == 422
    assert await _rows(world) == []


async def test_admin_removing_their_own_role_is_recorded_with_actor_as_target(client, world):
    admin = world["admin"]
    url = f"/api/users/{admin.id}/project-roles"
    assert (
        await client.put(url, json={"project_id": str(world["project"].id), "role": "viewer"}, headers=_headers(admin))
    ).status_code == 200
    assert (await client.delete(f"{url}/{world['project'].id}", headers=_headers(admin))).status_code == 204
    rows = await _rows(world)
    assert [r.action for r in rows] == ["project_role.assigned", "project_role.removed"]
    assert all(r.actor_id == admin.id and r.target_id == admin.id for r in rows)


# ── Survival and failure ─────────────────────────────────────────────────


async def test_rows_outlive_their_actor_and_target(client, world):
    """Delete the BRDP, then the project, then the actor itself for good:
    the rows stay with the labels and emails as they were."""
    editor = world["editor"]
    assert (await client.delete(f"/api/trash/{world['trashed_a']}", headers=_headers(editor))).status_code == 204
    admin = _headers(world["admin"])
    assert (await client.delete(f"/api/users/{editor.id}", headers=admin)).status_code == 204
    assert (await client.delete(f"/api/users/{editor.id}/permanent", headers=admin)).status_code == 204
    assert (
        await client.delete(f"/api/projects/{world['project'].id}?permanent=true", headers=admin)
    ).status_code == 204
    async with async_session_factory() as session:
        brdp_row = (
            await session.execute(select(AuditLog).where(AuditLog.target_id == world["trashed_a"]))
        ).scalar_one()
        assert await session.get(User, editor.id) is None
        assert await session.get(Project, world["project"].id) is None
    assert brdp_row.actor_id == editor.id and brdp_row.actor_email == editor.email
    assert brdp_row.target_label == "BRDP-AUD-00002" and brdp_row.project_name == world["project"].name
    actions = [r.action for r in await _rows(world)]
    assert actions == [
        "brdp.deleted_permanently",
        "user.trashed",
        "user.deleted_permanently",
        "project.deleted_permanently",
    ]


async def test_audit_row_that_cannot_be_written_undoes_the_action(client, world, monkeypatch):
    """If the audit row cannot be written, the permanent delete does not
    happen and the caller gets the usual sanitized error."""
    from app.api.routes import trash

    def broken_record(db, actor, action, **kwargs):
        # An action the table's CHECK constraint refuses: the commit fails.
        db.add(AuditLog(actor_id=actor.id, actor_email=actor.email, action="not.an.action", target_type="brdp", target_label="x"))

    monkeypatch.setattr(trash, "record", broken_record)
    response = await client.delete(f"/api/trash/{world['trashed_a']}", headers=_headers(world["editor"]))
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "internal_error"
    async with async_session_factory() as session:
        assert await session.get(BRDP, world["trashed_a"]) is not None
    assert await _rows(world) == []


# ── GET /api/admin/audit-log ─────────────────────────────────────────────


async def test_endpoint_is_admin_only(client, world):
    response = await client.get("/api/admin/audit-log", headers=_headers(world["editor"]))
    assert response.status_code == 403


async def test_endpoint_filters_limit_and_truncated(client, world):
    admin = _headers(world["admin"])
    target, project = world["target"], world["project"]
    url = f"/api/users/{target.id}/project-roles"
    for role in ("viewer", "editor", "viewer"):
        await client.put(url, json={"project_id": str(project.id), "role": role}, headers=admin)
    await client.post(f"/api/users/{target.id}/reset-password", headers=admin)

    everything = (await client.get("/api/admin/audit-log?limit=1000", headers=admin)).json()
    mine = [r for r in everything["rows"] if r["actor_id"] == str(world["admin"].id)]
    assert [r["action"] for r in mine] == [
        "user.password_reset",
        "project_role.changed",
        "project_role.changed",
        "project_role.assigned",
    ]
    assert everything["days"] == 30 and everything["limit"] == 1000
    first = mine[0]
    assert set(first) == {
        "id", "created_at", "actor_id", "actor_email", "action", "target_type", "target_id",
        "target_label", "project_id", "project_name", "detail",
    }

    by_action = (await client.get("/api/admin/audit-log?action=project_role.changed", headers=admin)).json()
    assert by_action["rows"] and all(r["action"] == "project_role.changed" for r in by_action["rows"])
    by_type = (await client.get("/api/admin/audit-log?target_type=user", headers=admin)).json()
    assert by_type["rows"] and all(r["target_type"] == "user" for r in by_type["rows"])

    one = (await client.get("/api/admin/audit-log?limit=1", headers=admin)).json()
    assert len(one["rows"]) == 1 and one["truncated"] is True
    assert one["rows"][0]["id"] == everything["rows"][0]["id"]
    exact = (await client.get("/api/admin/audit-log?target_type=project_role&limit=1000", headers=admin)).json()
    assert exact["truncated"] is False

    for bad in ("action=not.an.action", "target_type=nothing", "days=0", "days=367", "limit=0", "limit=1001"):
        assert (await client.get(f"/api/admin/audit-log?{bad}", headers=admin)).status_code == 422, bad
