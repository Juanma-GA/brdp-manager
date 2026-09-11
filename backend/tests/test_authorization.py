"""Authorization, end-to-end against the real app + real Postgres. Two
distinct axes per docs/v2/03-especificacion-v2-para-claude-code.md §4.3,
tested separately because they are two different bugs:

  (a) cross-project isolation -- an editor of project A must not be able
      to read or write project B's data, even with a project_id path
      param they're not entitled to (and even if they smuggle in a real
      brdp_id that actually belongs to B while claiming project A in the
      path).
  (b) same-project role level -- a viewer of project A can read project
      A's data but must never be able to write it (create/update/delete a
      BRDP, or propose/approve/revoke a rule), even though they have
      legitimate read access to that exact project.

Also covers the §4.3 clarification: global_role='admin' bypasses
per-project checks entirely, with no user_project_roles row needed, and
GET /api/projects reflects that (admin sees every project; everyone else
sees only what they're assigned to).
"""
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, Project, RuleApproval, User, UserProjectRole


async def _make_user(global_role: str = "user") -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"authz-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Authz Test User",
            global_role=global_role,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _make_project(standard: str = "S1000D 4.2") -> Project:
    async with async_session_factory() as session:
        project = Project(name=f"Authz Test Project {uuid.uuid4()}", standard=standard)
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project


async def _assign_role(user_id: uuid.UUID, project_id: uuid.UUID, role: str) -> None:
    async with async_session_factory() as session:
        session.add(UserProjectRole(user_id=user_id, project_id=project_id, role=role))
        await session.commit()


async def _make_brdp(project_id: uuid.UUID, identifier: str = "BRDP-AUTHZ-001") -> BRDP:
    async with async_session_factory() as session:
        brdp = BRDP(project_id=project_id, identifier=identifier)
        session.add(brdp)
        await session.commit()
        await session.refresh(brdp)
        return brdp


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _cleanup(*, users=(), projects=()):
    async with async_session_factory() as session:
        for project in projects:
            db_project = await session.get(Project, project.id)
            if db_project is not None:
                await session.delete(db_project)  # cascades to brdps/approvals
        for user in users:
            db_user = await session.get(User, user.id)
            if db_user is not None:
                await session.delete(db_user)  # cascades to user_project_roles
        await session.commit()


@pytest.fixture
async def scenario():
    """Two projects, one editor and one viewer both scoped to project A
    only, one admin with NO user_project_roles row at all, and one BRDP in
    each project.
    """
    project_a = await _make_project()
    project_b = await _make_project()
    editor_a = await _make_user()
    viewer_a = await _make_user()
    admin = await _make_user(global_role="admin")
    await _assign_role(editor_a.id, project_a.id, "editor")
    await _assign_role(viewer_a.id, project_a.id, "viewer")
    brdp_a = await _make_brdp(project_a.id, "BRDP-A-001")
    brdp_b = await _make_brdp(project_b.id, "BRDP-B-001")

    yield {
        "project_a": project_a,
        "project_b": project_b,
        "editor_a": editor_a,
        "viewer_a": viewer_a,
        "admin": admin,
        "brdp_a": brdp_a,
        "brdp_b": brdp_b,
    }

    await _cleanup(users=[editor_a, viewer_a, admin], projects=[project_a, project_b])


# ---------------------------------------------------------------------------
# Axis (a): cross-project isolation
# ---------------------------------------------------------------------------


async def test_editor_of_a_cannot_list_brdps_of_b(client, scenario):
    response = await client.get(
        f"/api/projects/{scenario['project_b'].id}/brdps", headers=_headers(scenario["editor_a"])
    )
    assert response.status_code == 403


async def test_editor_of_a_cannot_create_brdp_in_b(client, scenario):
    response = await client.post(
        f"/api/projects/{scenario['project_b'].id}/brdps",
        json={"identifier": "BRDP-HACK"},
        headers=_headers(scenario["editor_a"]),
    )
    assert response.status_code == 403


async def test_editor_of_a_cannot_update_brdp_belonging_to_b_via_spoofed_project_id(client, scenario):
    """The subtler variant: project_id in the path IS one editor_a is
    entitled to (A), but brdp_id in the path actually belongs to B. The
    role check on project_id alone would pass -- only the resource
    ownership check (comparing the fetched BRDP's real project_id) catches
    this. 404, not 403: the caller shouldn't learn the BRDP exists at all.
    """
    response = await client.put(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_b'].id}",
        json={"title": "hacked"},
        headers=_headers(scenario["editor_a"]),
    )
    assert response.status_code == 404


async def test_editor_of_a_cannot_delete_brdp_belonging_to_b_via_spoofed_project_id(client, scenario):
    response = await client.delete(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_b'].id}",
        headers=_headers(scenario["editor_a"]),
    )
    assert response.status_code == 404


async def test_editor_of_a_cannot_read_or_write_notes_of_b(client, scenario):
    get_resp = await client.get(
        f"/api/projects/{scenario['project_b'].id}/brdps/{scenario['brdp_b'].id}/notes",
        headers=_headers(scenario["editor_a"]),
    )
    assert get_resp.status_code == 403

    put_resp = await client.put(
        f"/api/projects/{scenario['project_b'].id}/brdps/{scenario['brdp_b'].id}/notes",
        json={"text": "hacked"},
        headers=_headers(scenario["editor_a"]),
    )
    assert put_resp.status_code == 403


async def test_editor_of_a_cannot_propose_approval_in_b(client, scenario):
    response = await client.put(
        f"/api/projects/{scenario['project_b'].id}/brdps/{scenario['brdp_b'].id}/approvals/BREX-4.2",
        json={"rule_xml": "<hacked/>"},
        headers=_headers(scenario["editor_a"]),
    )
    assert response.status_code == 403


async def test_editor_of_a_cannot_read_history_of_a_brdp_in_b(client, scenario):
    """Cross-project isolation for the new GET .../history endpoint --
    editor_a has a real editor role, just not on project B, so this must
    fail on project ownership, not merely be hidden by the UI.
    """
    response = await client.get(
        f"/api/projects/{scenario['project_b'].id}/brdps/{scenario['brdp_b'].id}/history",
        headers=_headers(scenario["editor_a"]),
    )
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# Axis (b): same-project role level (viewer vs editor, same project)
# ---------------------------------------------------------------------------


async def test_viewer_of_a_can_read_brdps_of_a(client, scenario):
    response = await client.get(
        f"/api/projects/{scenario['project_a'].id}/brdps", headers=_headers(scenario["viewer_a"])
    )
    assert response.status_code == 200


async def test_viewer_of_a_cannot_create_brdp_in_a(client, scenario):
    response = await client.post(
        f"/api/projects/{scenario['project_a'].id}/brdps",
        json={"identifier": "BRDP-VIEWER-HACK"},
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_cannot_read_next_ext_identifier_in_a(client, scenario):
    """Add BRDP's pre-filled ID field is part of the creation flow, which
    is editor+ end to end -- a viewer must not even be able to read what
    the next identifier would be.
    """
    response = await client.get(
        f"/api/projects/{scenario['project_a'].id}/brdps/next-ext-identifier",
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_editor_of_a_cannot_create_a_project_even_with_catalog_seed(client, scenario):
    """Project creation (docs/v2 §4.2) is stricter than editor -- admin
    only, same reasoning as DELETE /api/projects/{id} -- and the new
    seed_from_catalog flag doesn't change that: an editor of an existing
    project still can't create a brand new one, catalog-seeded or not.
    """
    response = await client.post(
        "/api/projects",
        json={"name": "Editor Should Not Create This", "standard": "BREX — S1000D 4.2", "seed_from_catalog": True},
        headers=_headers(scenario["editor_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_cannot_update_brdp_in_a(client, scenario):
    response = await client.put(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}",
        json={"title": "viewer was here"},
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_cannot_delete_brdp_in_a(client, scenario):
    response = await client.delete(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}",
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_can_read_history_of_a_brdp_in_a(client, scenario):
    """Positive control for test_editor_of_a_cannot_read_history_of_a_brdp_in_b:
    proves that 403 is genuinely about role/project scope, not a broken
    endpoint -- the exact same viewer, reading history for a BRDP in a
    project they DO belong to, must succeed.
    """
    response = await client.get(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/history",
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 200


async def test_viewer_of_a_can_read_approval_in_a(client, scenario):
    response = await client.get(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2",
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 200  # null body, but readable


async def test_viewer_of_a_cannot_propose_approval_in_a(client, scenario):
    """The exact scenario the user called out: viewer of a project can
    read it fine, but must not be able to approve/revoke a rule in that
    SAME project.
    """
    response = await client.put(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2",
        json={"rule_xml": "<viewer-hack/>"},
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_cannot_approve_a_pending_rule_in_a(client, scenario):
    async with async_session_factory() as session:
        session.add(
            RuleApproval(
                brdp_id=scenario["brdp_a"].id, format="BREX-4.2", rule_xml="<x/>", status="pending_review"
            )
        )
        await session.commit()

    response = await client.post(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2/approve",
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_cannot_revoke_an_approved_rule_in_a(client, scenario):
    async with async_session_factory() as session:
        session.add(
            RuleApproval(
                brdp_id=scenario["brdp_a"].id, format="BREX-4.2", rule_xml="<x/>", status="approved"
            )
        )
        await session.commit()

    response = await client.delete(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2",
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_cannot_revoke_an_approved_rule_via_new_endpoint_in_a(client, scenario):
    """The new Rule Status stepper's Revoke action (Verified -> Draft, docs
    request item 2) -- distinct from the pre-existing DELETE endpoint above,
    but the same editor-only gate must apply.
    """
    async with async_session_factory() as session:
        session.add(
            RuleApproval(
                brdp_id=scenario["brdp_a"].id, format="BREX-4.2", rule_xml="<x/>", status="approved"
            )
        )
        await session.commit()

    response = await client.post(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2/revoke",
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_cannot_post_accepted_suggestion_feedback_in_a(client, scenario):
    """Same criterion already applied to rule_approvals: a viewer can log
    that they discarded a suggestion (read-only, no mutation), but
    outcome='accepted' is a claim they acted on it -- and the real accept
    action is editor-gated, so this must be too.
    """
    response = await client.post(
        "/api/suggestion-feedback",
        json={
            "brdp_id": str(scenario["brdp_a"].id),
            "kind": "definition",
            "suggested_text": "viewer-hack",
            "outcome": "accepted",
        },
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 403


async def test_viewer_of_a_can_post_discarded_suggestion_feedback_in_a(client, scenario):
    """Positive control for the same rule: a discarded outcome is exactly
    what §4.3 says a viewer CAN do with the BRDP Assistant.
    """
    response = await client.post(
        "/api/suggestion-feedback",
        json={
            "brdp_id": str(scenario["brdp_a"].id),
            "kind": "definition",
            "suggested_text": "not for me",
            "outcome": "discarded",
        },
        headers=_headers(scenario["viewer_a"]),
    )
    assert response.status_code == 201


async def test_editor_of_a_cannot_delete_project_a_even_though_assigned_as_editor(client, scenario):
    """DELETE /api/projects/{id} is admin-only, deliberately stricter than
    the editor role that otherwise controls everything about a project's
    content -- an editor of project A can edit/create/delete BRDPs in A,
    but must never be able to make project A itself disappear.
    """
    response = await client.delete(
        f"/api/projects/{scenario['project_a'].id}", headers=_headers(scenario["editor_a"])
    )
    assert response.status_code == 403


async def test_editor_of_a_can_propose_and_approve_in_a(client, scenario):
    """Positive control: editor really can do what viewer can't, in the
    SAME project -- proves the 403s above are about role, not something
    incidentally broken about the endpoint. Extended to also cover the new
    Revoke endpoint (docs request item 2): the full Draft -> Verified ->
    Draft happy path, confirming revoke preserves rule_xml rather than
    deleting it.
    """
    propose = await client.put(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2",
        json={"rule_xml": "<structureObjectRule/>"},
        headers=_headers(scenario["editor_a"]),
    )
    assert propose.status_code == 200

    approve = await client.post(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2/approve",
        headers=_headers(scenario["editor_a"]),
    )
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    revoke = await client.post(
        f"/api/projects/{scenario['project_a'].id}/brdps/{scenario['brdp_a'].id}/approvals/BREX-4.2/revoke",
        headers=_headers(scenario["editor_a"]),
    )
    assert revoke.status_code == 200
    revoke_body = revoke.json()
    assert revoke_body["status"] == "pending_review"
    assert revoke_body["rule_xml"] == "<structureObjectRule/>"
    assert revoke_body["approved_at"] is None


# ---------------------------------------------------------------------------
# Admin bypass (§4.3 clarification)
# ---------------------------------------------------------------------------


async def test_admin_with_no_project_roles_row_can_still_edit_any_project(client, scenario):
    response = await client.put(
        f"/api/projects/{scenario['project_b'].id}/brdps/{scenario['brdp_b'].id}",
        json={"title": "admin edit"},
        headers=_headers(scenario["admin"]),
    )
    assert response.status_code == 200
    assert response.json()["title"] == "admin edit"


async def test_admin_sees_every_project_editor_sees_only_assigned(client, scenario):
    admin_projects = await client.get("/api/projects", headers=_headers(scenario["admin"]))
    admin_ids = {p["id"] for p in admin_projects.json()}
    assert str(scenario["project_a"].id) in admin_ids
    assert str(scenario["project_b"].id) in admin_ids

    editor_projects = await client.get("/api/projects", headers=_headers(scenario["editor_a"]))
    editor_ids = {p["id"] for p in editor_projects.json()}
    assert str(scenario["project_a"].id) in editor_ids
    assert str(scenario["project_b"].id) not in editor_ids


async def test_effective_role_reflects_the_callers_real_capability_per_project(client, scenario):
    """Phase 4 addition: the frontend hides edit controls based on
    `effective_role` in the project payload, so it has to be computed
    correctly per caller. Unlike the raw user_project_roles.role value,
    effective_role is never null for an admin -- the admin bypass (§4.3) is
    resolved server-side to "editor" so the client never re-derives it.
    """
    admin_view = (
        await client.get(f"/api/projects/{scenario['project_a'].id}/config", headers=_headers(scenario["admin"]))
    ).json()
    assert admin_view["effective_role"] == "editor"

    editor_view = (
        await client.get(f"/api/projects/{scenario['project_a'].id}/config", headers=_headers(scenario["editor_a"]))
    ).json()
    assert editor_view["effective_role"] == "editor"

    viewer_view = (
        await client.get(f"/api/projects/{scenario['project_a'].id}/config", headers=_headers(scenario["viewer_a"]))
    ).json()
    assert viewer_view["effective_role"] == "viewer"

    list_response = await client.get("/api/projects", headers=_headers(scenario["editor_a"]))
    project_a_entry = next(p for p in list_response.json() if p["id"] == str(scenario["project_a"].id))
    assert project_a_entry["effective_role"] == "editor"


async def test_list_projects_gives_admin_effective_role_editor_with_no_role_row(client, scenario):
    """The specific §4.3 read-side case: `scenario["admin"]` has NO
    user_project_roles row for project_a at all (see the scenario fixture
    docstring) -- a naive implementation returning the raw row would give
    null/None here. GET /api/projects must still resolve it to "editor".
    """
    list_response = await client.get("/api/projects", headers=_headers(scenario["admin"]))
    assert list_response.status_code == 200
    project_a_entry = next(p for p in list_response.json() if p["id"] == str(scenario["project_a"].id))
    assert project_a_entry["effective_role"] == "editor"


async def test_list_projects_gives_real_viewer_effective_role_viewer(client, scenario):
    """The other side of the same rule: a real (non-admin) viewer role must
    come through in the list unchanged, not upgraded or dropped.
    """
    list_response = await client.get("/api/projects", headers=_headers(scenario["viewer_a"]))
    assert list_response.status_code == 200
    project_a_entry = next(p for p in list_response.json() if p["id"] == str(scenario["project_a"].id))
    assert project_a_entry["effective_role"] == "viewer"
