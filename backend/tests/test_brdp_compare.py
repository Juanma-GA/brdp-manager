"""Comparar dos BRDP lado a lado: compare-candidates, compare-detail and the
"rule_copied" event of "Usar esta Regla". Real Postgres, no mocking.

Identifiers are unique per test run (BRDP-CMP-<uuid>), so the official
catalog rows seeded here never collide with real data, whatever the
environment holds.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, Project, RuleApproval, User, UserProjectRole

RULE_42 = (
    '<structureObjectRule id="R1"><objectPath allowedObjectFlag="0">//emphasis</objectPath>'
    "<objectUse>No emphasis.</objectUse></structureObjectRule>"
)
RULE_301 = '<objrule><objpath objappl="0">//emphasis</objpath><objuse>No emphasis.</objuse></objrule>'


def _headers(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _user(prefix, global_role="user"):
    return User(
        email=f"{prefix}-{uuid.uuid4()}@example.com",
        password_hash=hash_password("irrelevant-password"),
        display_name=prefix,
        global_role=global_role,
    )


@pytest.fixture
async def world():
    """current (4.2) + same42 (4.2) + same41 (4.1) + hidden (4.2, no role) +
    extra (4.2, where the same identifier is only in the Papelera). The
    viewer sees current, same42, same41 and extra; the admin sees all."""
    identifier = f"BRDP-CMP-{uuid.uuid4().hex[:10]}"
    ext_identifier = f"BRDP-EXT-{uuid.uuid4().hex[:8]}"
    created = {}
    async with async_session_factory() as session:
        projects = {
            "current": Project(name=f"Cmp current {uuid.uuid4()}", standard="S1000D 4.2"),
            "same42": Project(name=f"Cmp A same42 {uuid.uuid4()}", standard="S1000D 4.2"),
            "same41": Project(name=f"Cmp B same41 {uuid.uuid4()}", standard="S1000D 4.1"),
            "hidden": Project(name=f"Cmp C hidden {uuid.uuid4()}", standard="S1000D 4.2"),
            "extra": Project(name=f"Cmp D extra {uuid.uuid4()}", standard="S1000D 4.2"),
        }
        viewer = _user("cmp-viewer")
        editor = _user("cmp-editor")
        outsider = _user("cmp-outsider")
        admin = _user("cmp-admin", "admin")
        catalog = BRDPCatalog(standard="S1000D 4.2", identifier=identifier, title="Catalog title", definition="Catalog definition")
        session.add_all([*projects.values(), viewer, editor, outsider, admin, catalog])
        await session.flush()
        for key in ("current", "same42", "same41", "extra"):
            session.add(UserProjectRole(user_id=viewer.id, project_id=projects[key].id, role="viewer"))
        session.add(UserProjectRole(user_id=editor.id, project_id=projects["current"].id, role="editor"))
        session.add(UserProjectRole(user_id=editor.id, project_id=projects["same42"].id, role="viewer"))

        brdps = {
            "current": BRDP(project_id=projects["current"].id, identifier=identifier, title="Current", definition="Def current", proposal="Prop current"),
            "same42": BRDP(project_id=projects["same42"].id, identifier=identifier, title="Same 4.2", definition="Def 42", proposal="Prop 42", validation="Validated"),
            "same41": BRDP(project_id=projects["same41"].id, identifier=identifier, title="Same 4.1", definition="Def 41", proposal="Prop 41"),
            "hidden": BRDP(project_id=projects["hidden"].id, identifier=identifier, title="Hidden"),
            "trashed": BRDP(project_id=projects["extra"].id, identifier=identifier, title="Trashed", deleted_at=datetime.now(timezone.utc)),
            "current_ext": BRDP(project_id=projects["current"].id, identifier=ext_identifier, title="Own EXT"),
            "same42_ext": BRDP(project_id=projects["same42"].id, identifier=ext_identifier, title="Other EXT"),
            "same42_301": BRDP(project_id=projects["same42"].id, identifier=f"BRDP-CMP301-{uuid.uuid4().hex[:6]}", title="Has a 3.0.1 rule"),
        }
        session.add_all(brdps.values())
        await session.flush()
        session.add(
            RuleApproval(
                brdp_id=brdps["same42"].id,
                format="BREX-4.2",
                rule_xml=RULE_42,
                source="llm",
                status="approved",
                last_test_result="passed",
                last_test_rule_hash=hashlib.sha256(RULE_42.encode()).hexdigest(),
                last_test_at=datetime.now(timezone.utc),
            )
        )
        session.add(RuleApproval(brdp_id=brdps["same42_301"].id, format="BREX-4.2", rule_xml=RULE_301, source="manual", status="pending_review"))
        await session.commit()
        created.update(projects=projects, brdps=brdps, users=[viewer, editor, outsider, admin], catalog=catalog)

    yield {
        "identifier": identifier,
        "projects": {k: p.id for k, p in projects.items()},
        "project_names": {k: p.name for k, p in projects.items()},
        "brdps": {k: b.id for k, b in brdps.items()},
        "viewer": _headers(viewer),
        "editor": _headers(editor),
        "outsider": _headers(outsider),
        "admin": _headers(admin),
    }

    async with async_session_factory() as session:
        for project in created["projects"].values():
            row = await session.get(Project, project.id)
            if row is not None:
                await session.delete(row)
        for user in created["users"]:
            row = await session.get(User, user.id)
            if row is not None:
                await session.delete(row)
        row = await session.get(BRDPCatalog, created["catalog"].id)
        if row is not None:
            await session.delete(row)
        await session.commit()


def _candidates_url(w, brdp="current", project="current"):
    return f"/api/projects/{w['projects'][project]}/brdps/{w['brdps'][brdp]}/compare-candidates"


def _detail_url(w, other_id, brdp="current", project="current"):
    return f"/api/projects/{w['projects'][project]}/brdps/{w['brdps'][brdp]}/compare-detail/{other_id}"


async def test_candidates_for_a_viewer_only_list_projects_they_can_see(client, world):
    res = await client.get(_candidates_url(world), headers=world["viewer"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["catalog_identifier"] is True
    assert body["standard"] == "S1000D 4.2"
    ids = [c["brdp_id"] for c in body["same_brdp"]]
    # same42 and same41; never hidden (no role), never the trashed one, never itself.
    assert ids == [str(world["brdps"]["same42"]), str(world["brdps"]["same41"])]
    same42, same41 = body["same_brdp"]
    assert same42["project_name"] == world["project_names"]["same42"]
    assert same42["standard"] == "S1000D 4.2"
    assert same42["validation"] == "Validated"
    assert same42["rule_format"] == "BREX-4.2"
    assert same42["rule_state"] == "verified"
    assert same42["last_test_result"] == "passed"
    assert same42["last_test_up_to_date"] is True
    # Another standard: included and marked with its standard.
    assert same41["standard"] == "S1000D 4.1"
    assert same41["rule_format"] == "BREX-4.1"
    assert same41["rule_state"] == "todo"
    assert same41["last_test_result"] is None


async def test_admin_sees_every_project(client, world):
    body = (await client.get(_candidates_url(world), headers=world["admin"])).json()
    ids = {c["brdp_id"] for c in body["same_brdp"]}
    assert str(world["brdps"]["hidden"]) in ids
    assert str(world["brdps"]["trashed"]) not in ids
    assert len(ids) == 3


async def test_user_without_role_on_current_project_is_refused(client, world):
    res = await client.get(_candidates_url(world), headers=world["outsider"])
    assert res.status_code == 403


async def test_ext_identifier_is_never_searched_in_other_projects(client, world):
    body = (await client.get(_candidates_url(world, brdp="current_ext"), headers=world["admin"])).json()
    assert body["catalog_identifier"] is False
    assert body["same_brdp"] == []


async def test_detail_of_a_visible_brdp(client, world):
    res = await client.get(_detail_url(world, world["brdps"]["same42"]), headers=world["viewer"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["project_name"] == world["project_names"]["same42"]
    assert body["standard"] == "S1000D 4.2"
    assert body["definition"] == "Def 42"
    assert body["proposal"] == "Prop 42"
    assert body["rule_format"] == "BREX-4.2"
    assert body["rule"]["rule_xml"] == RULE_42
    assert body["rule"]["status"] == "approved"
    assert body["rule"]["last_test_result"] == "passed"
    assert body["rule"]["last_test_up_to_date"] is True


async def test_detail_of_the_current_brdp_and_one_without_rule(client, world):
    body = (await client.get(_detail_url(world, world["brdps"]["current"]), headers=world["viewer"])).json()
    assert body["title"] == "Current"
    assert body["rule"] is None


async def test_detail_of_a_project_without_access_is_404_not_403(client, world):
    res = await client.get(_detail_url(world, world["brdps"]["hidden"]), headers=world["viewer"])
    assert res.status_code == 404
    assert (await client.get(_detail_url(world, world["brdps"]["hidden"]), headers=world["admin"])).status_code == 200


async def test_detail_of_a_trashed_or_unknown_brdp_is_404(client, world):
    assert (await client.get(_detail_url(world, world["brdps"]["trashed"]), headers=world["admin"])).status_code == 404
    assert (await client.get(_detail_url(world, uuid.uuid4()), headers=world["admin"])).status_code == 404


async def test_detail_needs_a_role_on_the_current_project(client, world):
    res = await client.get(_detail_url(world, world["brdps"]["same42"]), headers=world["outsider"])
    assert res.status_code == 403


async def _history(client, world, headers):
    url = f"/api/projects/{world['projects']['current']}/brdps/{world['brdps']['current']}/history"
    return (await client.get(url, headers=headers)).json()


async def test_copying_a_rule_records_the_rule_and_a_copied_from_event(client, world):
    url = f"/api/projects/{world['projects']['current']}/brdps/{world['brdps']['current']}/approvals/BREX-4.2"
    res = await client.put(
        url,
        json={"rule_xml": RULE_42, "source": "copied", "status": "pending_review", "copied_from_brdp_id": str(world["brdps"]["same42"])},
        headers=world["editor"],
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "pending_review"
    assert res.json()["source"] == "copied"
    history = await _history(client, world, world["editor"])
    fields = [h["field_name"] for h in history]
    assert "rule" in fields and "rule_status" in fields
    copied = [h for h in history if h["field_name"] == "rule_copied"]
    assert len(copied) == 1
    value = json.loads(copied[0]["new_value"])
    assert value["project_name"] == world["project_names"]["same42"]
    assert value["identifier"] == world["identifier"]
    assert value["standard"] == "S1000D 4.2"
    assert value["brdp_id"] == str(world["brdps"]["same42"])


async def test_a_copy_requested_as_approved_is_saved_as_draft(client, world):
    url = f"/api/projects/{world['projects']['current']}/brdps/{world['brdps']['current']}/approvals/BREX-4.2"
    res = await client.put(
        url,
        json={"rule_xml": RULE_42, "source": "copied", "status": "approved", "copied_from_brdp_id": str(world["brdps"]["same42"])},
        headers=world["editor"],
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "pending_review"
    assert res.json()["approved_at"] is None
    history = await _history(client, world, world["editor"])
    assert len([h for h in history if h["field_name"] == "rule_copied"]) == 1
    status_changes = [h for h in history if h["field_name"] == "rule_status"]
    assert status_changes and status_changes[0]["new_value"] == "draft"


async def test_copying_from_a_brdp_the_user_cannot_see_is_404_and_saves_nothing(client, world):
    url = f"/api/projects/{world['projects']['current']}/brdps/{world['brdps']['current']}/approvals/BREX-4.2"
    res = await client.put(
        url,
        json={"rule_xml": RULE_42, "source": "copied", "copied_from_brdp_id": str(world["brdps"]["hidden"])},
        headers=world["editor"],
    )
    assert res.status_code == 404
    assert (await client.get(url, headers=world["editor"])).json() is None
    assert not [h for h in await _history(client, world, world["editor"]) if h["field_name"] == "rule_copied"]


async def test_copying_a_rule_of_another_format_is_refused(client, world):
    url = f"/api/projects/{world['projects']['current']}/brdps/{world['brdps']['current']}/approvals/BREX-4.2"
    res = await client.put(
        url,
        json={"rule_xml": RULE_301, "source": "copied", "copied_from_brdp_id": str(world["brdps"]["same42_301"])},
        headers=world["editor"],
    )
    assert res.status_code == 422
    assert "objrule" in res.json()["detail"]
    assert not [h for h in await _history(client, world, world["editor"]) if h["field_name"] == "rule_copied"]


async def test_a_viewer_cannot_copy(client, world):
    url = f"/api/projects/{world['projects']['current']}/brdps/{world['brdps']['current']}/approvals/BREX-4.2"
    res = await client.put(
        url,
        json={"rule_xml": RULE_42, "source": "copied", "copied_from_brdp_id": str(world["brdps"]["same42"])},
        headers=world["viewer"],
    )
    assert res.status_code == 403
