"""AACF 2, Parts 3 and 4 (Decisión 13, HR9): projects and users go to a
Papelera instead of being deleted.

A project in the Papelera must not appear or count anywhere: one test per
query the encargo lists (project list, Suggest, Comparar, the BRDP
Papelera, jobs, Excel, direct URLs), plus restore, permanent delete, the
running-job block and the name rules. A deleted user cannot log in or
refresh, can be restored, and their email is offered for a restore
instead of a second account.

Real Postgres, no mocking except the embeddings transport of Suggest (the
same fixed vector test_similar.py uses).
"""
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import (
    BRDP,
    BRDPCatalog,
    BRDPHistory,
    EmbeddingJob,
    Project,
    RefreshToken,
    RuleApproval,
    User,
    UserProjectRole,
)
from app.models.brdp import EMBEDDING_DIM

_VECTOR = [1.0] + [0.0] * (EMBEDDING_DIM - 1)
PASSWORD = "Soft-delete-pw-123"


@pytest.fixture(autouse=True)
def _mock_embeddings():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": _VECTOR, "index": 0}]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


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
    """Two projects of the same synthetic standard: `kept` (stays active)
    and `gone` (deleted in each test). Each has a Validated BRDP with an
    embedding and a verified rule, all sharing an identifier that is in
    the catalog, so Suggest and Comparar would find `gone` if nothing
    excluded it. A viewer has a role on both."""
    standard = f"TEST-SOFT-{uuid.uuid4()}"
    identifier = f"BRDP-SOFT-{uuid.uuid4().hex[:8]}"
    async with async_session_factory() as session:
        kept = Project(name=f"Soft kept {uuid.uuid4()}", standard=standard)
        gone = Project(name=f"Soft gone {uuid.uuid4()}", standard=standard)
        admin = _user("soft-admin", "admin")
        viewer = _user("soft-viewer")
        catalog = BRDPCatalog(standard=standard, identifier=identifier, title="Cat", definition="Cat def")
        session.add_all([kept, gone, admin, viewer, catalog])
        await session.flush()
        for p in (kept, gone):
            session.add(UserProjectRole(user_id=viewer.id, project_id=p.id, role="viewer"))
        brdps = {}
        for key, p in (("kept", kept), ("gone", gone)):
            b = BRDP(
                project_id=p.id,
                identifier=identifier,
                title=f"{key} title",
                definition=f"{key} definition",
                proposal=f"{key} proposal",
                validation="Validated",
                embedding=_VECTOR,
            )
            session.add(b)
            await session.flush()
            session.add(RuleApproval(brdp_id=b.id, format="BREX-4.2", rule_xml="<structureObjectRule/>", status="approved"))
            brdps[key] = b
        trashed_in_gone = BRDP(
            project_id=gone.id, identifier=f"BRDP-TRASHED-{uuid.uuid4().hex[:6]}", deleted_at=datetime.now(timezone.utc)
        )
        session.add(trashed_in_gone)
        await session.flush()
        session.add(BRDPHistory(brdp_id=brdps["gone"].id, user_id=admin.id, user_email=admin.email, field_name="title", old_value="a", new_value="b"))
        await session.commit()
        ids = {
            "standard": standard,
            "identifier": identifier,
            "kept": kept.id,
            "gone": gone.id,
            "gone_name": gone.name,
            "brdp_kept": brdps["kept"].id,
            "brdp_gone": brdps["gone"].id,
            "trashed_in_gone": trashed_in_gone.id,
            "admin": admin,
            "viewer": viewer,
            "catalog": catalog.id,
        }
    yield ids
    async with async_session_factory() as session:
        for pid in (kept.id, gone.id):
            row = await session.get(Project, pid)
            if row is not None:
                await session.delete(row)
        for user in (admin, viewer):
            row = await session.get(User, user.id)
            if row is not None:
                await session.delete(row)
        row = await session.get(BRDPCatalog, ids["catalog"])
        if row is not None:
            await session.delete(row)
        await session.commit()


async def _delete(client, world, project_key="gone"):
    response = await client.delete(f"/api/projects/{world[project_key]}", headers=_headers(world["admin"]))
    assert response.status_code == 204, response.text


# ── Part 3: projects ─────────────────────────────────────────────────────


async def test_delete_moves_to_the_papelera_and_keeps_everything(client, world):
    await _delete(client, world)
    async with async_session_factory() as session:
        project = await session.get(Project, world["gone"])
        assert project.deleted_at is not None
        assert project.deleted_by == world["admin"].id and project.deleted_by_email == world["admin"].email
        assert await session.get(BRDP, world["brdp_gone"]) is not None
        assert (await session.execute(select(RuleApproval).where(RuleApproval.brdp_id == world["brdp_gone"]))).scalar_one()
        assert (await session.execute(select(UserProjectRole).where(UserProjectRole.project_id == world["gone"]))).scalars().all()


async def test_project_list_and_its_counts_exclude_it(client, world):
    await _delete(client, world)
    for user in (world["admin"], world["viewer"]):
        ids = {p["id"] for p in (await client.get("/api/projects", headers=_headers(user))).json()}
        assert str(world["kept"]) in ids and str(world["gone"]) not in ids


async def test_direct_urls_are_not_found(client, world):
    await _delete(client, world)
    gone = world["gone"]
    for user in (world["admin"], world["viewer"]):
        for path in (
            f"/api/projects/{gone}/config",
            f"/api/projects/{gone}/brdps",
            f"/api/projects/{gone}/brdps/stats",
            f"/api/projects/{gone}/brdps/{world['brdp_gone']}/history",
            f"/api/projects/{gone}/approvals/BREX-4.2",
        ):
            response = await client.get(path, headers=_headers(user))
            assert response.status_code == 404, (path, response.status_code)
            assert response.json()["detail"]["code"] == "project_not_found"
    # Someone who never had a role keeps the plain 403 (no existence leak).
    async with async_session_factory() as session:
        stranger = _user("soft-stranger")
        session.add(stranger)
        await session.commit()
    try:
        assert (await client.get(f"/api/projects/{gone}/brdps", headers=_headers(stranger))).status_code == 403
    finally:
        async with async_session_factory() as session:
            await session.delete(await session.get(User, stranger.id))
            await session.commit()


async def test_writes_to_a_deleted_project_are_not_found(client, world):
    await _delete(client, world)
    admin = _headers(world["admin"])
    gone = world["gone"]
    assert (await client.post(f"/api/projects/{gone}/brdps", json={"identifier": "BRDP-X-1"}, headers=admin)).status_code == 404
    assert (await client.patch(f"/api/projects/{gone}", json={"name": "x"}, headers=admin)).status_code == 404
    assert (await client.put(f"/api/projects/{gone}/config", json={"project_config": {}}, headers=admin)).status_code == 404


async def test_suggest_never_uses_a_deleted_project_as_precedent(client, world):
    """Suggest Definition and Proposal (similar.py) look across projects of
    the standard: the deleted project's BRDP (same identifier, same
    vector) must be gone from every group."""
    url = f"/api/projects/{world['kept']}/brdps/{world['brdp_kept']}/similar"
    before = (await client.get(f"{url}?kind=proposal", headers=_headers(world["admin"]))).json()
    found_before = {c["id"] for group in ("same_brdp", "candidates") for c in before.get(group, [])}
    assert str(world["brdp_gone"]) in found_before  # the test would prove nothing otherwise
    await _delete(client, world)
    for kind in ("proposal", "definition"):
        body = (await client.get(f"{url}?kind={kind}", headers=_headers(world["admin"]))).json()
        found = {c["id"] for group in ("same_brdp", "candidates", "this_project", "style_references") for c in body.get(group, [])}
        assert str(world["brdp_gone"]) not in found, kind


async def test_suggest_pending_count_ignores_a_deleted_project(client, world):
    async with async_session_factory() as session:
        b = await session.get(BRDP, world["brdp_gone"])
        b.embedding = None
        await session.commit()
    url = f"/api/projects/{world['kept']}/brdps/{world['brdp_kept']}/similar?kind=proposal"
    assert (await client.get(url, headers=_headers(world["admin"]))).json()["excluded_pending_other_projects"] == 1
    await _delete(client, world)
    assert (await client.get(url, headers=_headers(world["admin"]))).json()["excluded_pending_other_projects"] == 0


async def test_compare_never_offers_a_deleted_project(client, world):
    base = f"/api/projects/{world['kept']}/brdps/{world['brdp_kept']}"
    before = (await client.get(f"{base}/compare-candidates", headers=_headers(world["viewer"]))).json()
    assert str(world["gone"]) in {c["project_id"] for c in before["same_brdp"]}
    await _delete(client, world)
    after = (await client.get(f"{base}/compare-candidates", headers=_headers(world["viewer"]))).json()
    assert str(world["gone"]) not in {c["project_id"] for c in after["same_brdp"]}
    detail = await client.get(f"{base}/compare-detail/{world['brdp_gone']}", headers=_headers(world["admin"]))
    assert detail.status_code == 404


async def test_rule_copy_from_a_deleted_project_is_not_found(client, world):
    await _delete(client, world)
    response = await client.put(
        f"/api/projects/{world['kept']}/brdps/{world['brdp_kept']}/approvals/BREX-4.2",
        json={
            "rule_xml": '<structureObjectRule><objectPath allowedObjectFlag="0">//x</objectPath><objectUse>u</objectUse></structureObjectRule>',
            "status": "pending_review",
            "source": "copied",
            "copied_from_brdp_id": str(world["brdp_gone"]),
        },
        headers=_headers(world["admin"]),
    )
    assert response.status_code == 404


async def test_brdp_papelera_hides_a_deleted_projects_trash_until_restored(client, world):
    trash_ids = lambda body: {row["id"] for row in body}  # noqa: E731
    admin = _headers(world["admin"])
    assert str(world["trashed_in_gone"]) in trash_ids((await client.get("/api/trash", headers=admin)).json())
    await _delete(client, world)
    assert str(world["trashed_in_gone"]) not in trash_ids((await client.get("/api/trash", headers=admin)).json())
    assert (await client.post(f"/api/trash/{world['trashed_in_gone']}/restore", headers=admin)).status_code == 404
    assert (await client.delete(f"/api/trash/{world['trashed_in_gone']}", headers=admin)).status_code == 404
    assert (await client.post(f"/api/trash/projects/{world['gone']}/restore", headers=admin)).status_code == 200
    assert str(world["trashed_in_gone"]) in trash_ids((await client.get("/api/trash", headers=admin)).json())


async def test_jobs_and_excel_of_a_deleted_project_are_not_found(client, world):
    await _delete(client, world)
    admin = _headers(world["admin"])
    gone = world["gone"]
    assert (await client.post(f"/api/projects/{gone}/embeddings/compute", headers=admin)).status_code == 404
    assert (await client.get(f"/api/projects/{gone}/embeddings/pending", headers=admin)).status_code == 404
    assert (await client.get(f"/api/projects/{gone}/brdps/import/status/active", headers=admin)).status_code == 404
    assert (await client.get(f"/api/projects/{gone}/ai-extract/jobs/active", headers=admin)).status_code == 404
    response = await client.post(f"/api/projects/{gone}/export.xlsx", json={"rows": []}, headers=admin)
    assert response.status_code == 404


async def test_delete_is_refused_while_a_job_runs(client, world):
    async with async_session_factory() as session:
        job = EmbeddingJob(project_id=world["gone"], status="running", total_items=5, processed_items=1)
        session.add(job)
        await session.commit()
    response = await client.delete(f"/api/projects/{world['gone']}", headers=_headers(world["admin"]))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "project_has_running_job"
    assert response.json()["detail"]["jobs"] == ["embeddings"]
    async with async_session_factory() as session:
        assert (await session.get(Project, world["gone"])).deleted_at is None
        (await session.get(EmbeddingJob, job.id)).status = "completed"
        await session.commit()
    await _delete(client, world)


async def test_restore_brings_everything_back(client, world):
    await _delete(client, world)
    admin = _headers(world["admin"])
    listed = (await client.get("/api/trash/projects", headers=admin)).json()
    row = next(p for p in listed if p["id"] == str(world["gone"]))
    assert row["brdp_count"] == 1 and row["deleted_by_email"] == world["admin"].email
    assert row["standard"] == world["standard"]
    restored = await client.post(f"/api/trash/projects/{world['gone']}/restore", headers=admin)
    assert restored.status_code == 200
    viewer = _headers(world["viewer"])
    brdps = (await client.get(f"/api/projects/{world['gone']}/brdps", headers=viewer)).json()
    assert [b["id"] for b in brdps] == [str(world["brdp_gone"])]
    approvals = (await client.get(f"/api/projects/{world['gone']}/approvals/BREX-4.2", headers=viewer)).json()
    assert approvals and approvals[0]["status"] == "approved"
    history = (await client.get(f"/api/projects/{world['gone']}/brdps/{world['brdp_gone']}/history", headers=viewer)).json()
    assert history and history[0]["field_name"] == "title"
    assert str(world["gone"]) in {p["id"] for p in (await client.get("/api/projects", headers=viewer)).json()}


async def test_restore_refuses_a_name_taken_by_an_active_project(client, world):
    await _delete(client, world)
    admin = _headers(world["admin"])
    # The name is reusable after the delete...
    created = await client.post("/api/projects", json={"name": world["gone_name"], "standard": "S1000D 4.2"}, headers=admin)
    assert created.status_code == 201
    try:
        # ...so restoring the deleted one under it is refused, clearly.
        refused = await client.post(f"/api/trash/projects/{world['gone']}/restore", headers=admin)
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "project_name_taken"
        # Case and spaces do not make a different name.
        refused = await client.post(
            f"/api/trash/projects/{world['gone']}/restore", json={"name": f"  {world['gone_name'].upper()} "}, headers=admin
        )
        assert refused.status_code == 409
        restored = await client.post(
            f"/api/trash/projects/{world['gone']}/restore", json={"name": f"{world['gone_name']} (restored)"}, headers=admin
        )
        assert restored.status_code == 200 and restored.json()["name"] == f"{world['gone_name']} (restored)"
    finally:
        await client.delete(f"/api/projects/{created.json()['id']}?permanent=true", headers=admin)


async def test_permanent_delete_cascades_and_keeps_history(client, world):
    await _delete(client, world)
    admin = _headers(world["admin"])
    assert (await client.delete(f"/api/trash/projects/{world['gone']}", headers=admin)).status_code == 204
    async with async_session_factory() as session:
        assert await session.get(Project, world["gone"]) is None
        assert await session.get(BRDP, world["brdp_gone"]) is None
        assert (await session.execute(select(RuleApproval).where(RuleApproval.brdp_id == world["brdp_gone"]))).first() is None
        assert (await session.execute(select(UserProjectRole).where(UserProjectRole.project_id == world["gone"]))).first() is None
        kept_history = (
            await session.execute(select(BRDPHistory).where(BRDPHistory.user_email == world["admin"].email))
        ).scalars().all()
        assert kept_history and all(h.brdp_id is None for h in kept_history)
    # Only a project already in the Papelera can be deleted permanently there.
    assert (await client.delete(f"/api/trash/projects/{world['kept']}", headers=admin)).status_code == 404


async def test_permanent_query_deletes_an_active_project_at_once(client, world):
    response = await client.delete(f"/api/projects/{world['gone']}?permanent=true", headers=_headers(world["admin"]))
    assert response.status_code == 204
    async with async_session_factory() as session:
        assert await session.get(Project, world["gone"]) is None


async def test_project_papelera_is_admin_only(client, world):
    await _delete(client, world)
    viewer = _headers(world["viewer"])
    assert (await client.get("/api/trash/projects", headers=viewer)).status_code == 403
    assert (await client.post(f"/api/trash/projects/{world['gone']}/restore", headers=viewer)).status_code == 403
    assert (await client.delete(f"/api/trash/projects/{world['gone']}", headers=viewer)).status_code == 403


async def test_no_role_can_be_assigned_on_a_deleted_project(client, world):
    await _delete(client, world)
    response = await client.put(
        f"/api/users/{world['viewer'].id}/project-roles",
        json={"project_id": str(world["gone"]), "role": "editor"},
        headers=_headers(world["admin"]),
    )
    assert response.status_code == 404
    users = (await client.get("/api/users", headers=_headers(world["admin"]))).json()
    viewer_row = next(u for u in users if u["id"] == str(world["viewer"].id))
    assert {r["project_id"] for r in viewer_row["project_roles"]} == {str(world["kept"])}


# ── Part 4: users ────────────────────────────────────────────────────────


async def _login(client, email, password=PASSWORD):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def test_deleted_user_cannot_log_in_or_refresh(client, world):
    viewer = world["viewer"]
    logged = await _login(client, viewer.email)
    assert logged.status_code == 200
    cookie = logged.cookies.get("refresh_token")
    assert (await client.get("/api/auth/me", headers=_headers(viewer))).status_code == 200
    assert (await client.delete(f"/api/users/{viewer.id}", headers=_headers(world["admin"]))).status_code == 204
    # The open session ends at its next request...
    assert (await client.get("/api/auth/me", headers=_headers(viewer))).status_code == 401
    # ...the refresh is refused (its tokens were revoked)...
    client.cookies.set("refresh_token", cookie)
    assert (await client.post("/api/auth/refresh")).status_code == 401
    client.cookies.clear()
    # ...and logging in again gives the same answer as a wrong password.
    response = await _login(client, viewer.email)
    assert response.status_code == 401 and response.json()["detail"] == "Invalid email or password"


async def test_deleted_user_leaves_the_list_and_appears_in_deleted_users(client, world):
    admin = _headers(world["admin"])
    await client.delete(f"/api/users/{world['viewer'].id}", headers=admin)
    assert str(world["viewer"].id) not in {u["id"] for u in (await client.get("/api/users", headers=admin)).json()}
    deleted = (await client.get("/api/users/deleted", headers=admin)).json()
    row = next(u for u in deleted if u["id"] == str(world["viewer"].id))
    assert row["email"] == world["viewer"].email and row["deleted_by_email"] == world["admin"].email
    assert (await client.get("/api/users/deleted", headers=_headers(world["viewer"]))).status_code == 401


async def test_restore_user_with_their_roles(client, world):
    admin = _headers(world["admin"])
    await client.delete(f"/api/users/{world['viewer'].id}", headers=admin)
    restored = await client.post(f"/api/users/{world['viewer'].id}/restore", headers=admin)
    assert restored.status_code == 200
    assert (await _login(client, world["viewer"].email)).status_code == 200
    projects = {p["id"] for p in (await client.get("/api/projects", headers=_headers(world["viewer"]))).json()}
    assert {str(world["kept"]), str(world["gone"])} <= projects


async def test_restore_user_whose_project_was_deleted_permanently(client, world):
    admin = _headers(world["admin"])
    await client.delete(f"/api/users/{world['viewer'].id}", headers=admin)
    await _delete(client, world)
    await client.delete(f"/api/trash/projects/{world['gone']}", headers=admin)
    assert (await client.post(f"/api/users/{world['viewer'].id}/restore", headers=admin)).status_code == 200
    users = (await client.get("/api/users", headers=admin)).json()
    viewer_row = next(u for u in users if u["id"] == str(world["viewer"].id))
    assert {r["project_id"] for r in viewer_row["project_roles"]} == {str(world["kept"])}


async def test_creating_a_user_with_a_deleted_users_email_offers_a_restore(client, world):
    admin = _headers(world["admin"])
    await client.delete(f"/api/users/{world['viewer'].id}", headers=admin)
    response = await client.post(
        "/api/users", json={"email": world["viewer"].email, "display_name": "Again"}, headers=admin
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "user_deleted_exists" and detail["user_id"] == str(world["viewer"].id)
    async with async_session_factory() as session:
        same = (await session.execute(select(User).where(User.email == world["viewer"].email))).scalars().all()
        assert len(same) == 1  # never a second account
    # Changing another user's email to it is refused too (it stays theirs).
    other = (await client.post("/api/users", json={"email": f"o-{uuid.uuid4()}@example.com", "display_name": "O"}, headers=admin)).json()
    try:
        moved = await client.patch(f"/api/users/{other['id']}", json={"email": world["viewer"].email, "display_name": "O"}, headers=admin)
        assert moved.status_code == 409
    finally:
        async with async_session_factory() as session:
            await session.delete(await session.get(User, uuid.UUID(other["id"])))
            await session.commit()


async def test_permanent_user_delete_keeps_history_email(client, world):
    admin = _headers(world["admin"])
    async with async_session_factory() as session:
        session.add(
            BRDPHistory(
                brdp_id=world["brdp_kept"], user_id=world["viewer"].id, user_email=world["viewer"].email, field_name="title", old_value="x", new_value="y"
            )
        )
        session.add(RefreshToken(user_id=world["viewer"].id, token_hash=f"h-{uuid.uuid4()}", expires_at=datetime.now(timezone.utc) + timedelta(days=1)))
        await session.commit()
    # Only a deleted user can be deleted permanently.
    assert (await client.delete(f"/api/users/{world['viewer'].id}/permanent", headers=admin)).status_code == 404
    await client.delete(f"/api/users/{world['viewer'].id}", headers=admin)
    assert (await client.delete(f"/api/users/{world['viewer'].id}/permanent", headers=admin)).status_code == 204
    async with async_session_factory() as session:
        assert await session.get(User, world["viewer"].id) is None
        rows = (await session.execute(select(BRDPHistory).where(BRDPHistory.user_email == world["viewer"].email))).scalars().all()
        assert rows and rows[0].user_id is None
    history = (await client.get(f"/api/projects/{world['kept']}/brdps/{world['brdp_kept']}/history", headers=admin)).json()
    assert world["viewer"].email in {h["user_email"] for h in history}


async def test_self_and_last_admin_guards_still_hold(client, world):
    admin = world["admin"]
    response = await client.delete(f"/api/users/{admin.id}", headers=_headers(admin))
    assert response.status_code == 400
