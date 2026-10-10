"""Corrección propuesta de reglas con defecto: the backend side. Which
defects a rule has and what correction fits it is decided in the browser
(src/validation/ruleCorrection.js, tested in scripts/test-rule-correction.mjs);
the backend saves an accepted correction like any rule save (with a History
event saying what it fixed) and remembers a discarded one by the rule
text's hash. Real Postgres, no mocking.
"""
import hashlib
import json
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole

RULE = '<objrule id="XML-R-2828"><objpath objappl="0">//figure//legend/def[not(normalize-space(.) = ancestor::figure//graphic//hotspot/@title)]</objpath><objuse>x</objuse></objrule>'
FIXED = RULE.replace("legend/def", "legend/deflist/def")
CORRECTION = {
    "fixes": [
        {
            "code": "path",
            "params": {"problem": {"kind": "child", "element": "def", "parent": "legend", "parents": ["deflist"]}},
            "fix": {"kind": "path", "pathFix": {"kind": "insert_steps", "from": "legend/def", "to": "legend/deflist/def", "added": ["deflist"]}},
        }
    ],
    "remaining": [],
}


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@pytest.fixture
async def editor_viewer_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"Rule correction {uuid.uuid4()}", standard="S1000D 3.0.1")
        editor = User(
            email=f"cp-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="CP Editor",
            global_role="user",
        )
        viewer = User(
            email=f"cp-viewer-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="CP Viewer",
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

    yield (
        project,
        {"Authorization": f"Bearer {create_access_token(editor.id)}"},
        {"Authorization": f"Bearer {create_access_token(viewer.id)}"},
    )

    async with async_session_factory() as session:
        for model, key in ((Project, project.id), (User, editor.id), (User, viewer.id)):
            row = await session.get(model, key)
            if row is not None:
                await session.delete(row)
        await session.commit()


async def _brdp_with_rule(client, project, headers, status="pending_review"):
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-EXT-02816"}, headers=headers)
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-3.0.1"
    res = await client.put(url, json={"rule_xml": RULE, "source": "manual", "status": status}, headers=headers)
    assert res.status_code == 200
    return brdp, url


async def _history(client, project, brdp, headers):
    return (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=headers)).json()


async def test_accepted_correction_is_saved_with_its_history_event(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    res = await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    assert res.status_code == 200
    res = await client.put(
        url, json={"rule_xml": FIXED, "source": "manual", "status": "pending_review", "correction": CORRECTION}, headers=headers
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rule_xml"] == FIXED
    assert body["status"] == "pending_review"
    # The test was of the old text: outdated, never lost.
    assert body["test_category"] == "outdated"
    history = await _history(client, project, brdp, headers)
    rule_changes = [h for h in history if h["field_name"] == "rule"]
    assert rule_changes[0]["old_value"] == RULE and rule_changes[0]["new_value"] == FIXED
    event = next(h for h in history if h["field_name"] == "rule_corrected")
    assert json.loads(event["new_value"]) == CORRECTION
    assert event["user_email"].startswith("cp-editor-")


async def test_accepting_on_a_verified_rule_follows_the_normal_save(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers, status="approved")
    res = await client.put(
        url, json={"rule_xml": FIXED, "source": "manual", "status": "pending_review", "correction": CORRECTION}, headers=headers
    )
    assert res.status_code == 200
    assert res.json()["status"] == "pending_review"
    history = await _history(client, project, brdp, headers)
    status_change = next(h for h in history if h["field_name"] == "rule_status")
    assert (status_change["old_value"], status_change["new_value"]) == ("verified", "draft")


async def test_a_save_without_correction_writes_no_event(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    await client.put(url, json={"rule_xml": FIXED, "source": "manual"}, headers=headers)
    history = await _history(client, project, brdp, headers)
    assert not [h for h in history if h["field_name"] == "rule_corrected"]


async def test_correction_payload_is_validated(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    for bad in ({"fixes": []}, {"fixes": [{"code": "Not A Code"}]}, {"fixes": [{"code": "path", "params": {"x": "y" * 30000}}]}):
        res = await client.put(url, json={"rule_xml": FIXED, "source": "manual", "correction": bad}, headers=headers)
        assert res.status_code == 422, bad


async def test_dismissal_is_remembered_by_rule_hash(client, editor_viewer_and_project):
    project, headers, viewer = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    assert (await client.get(url, headers=headers)).json()["correction_dismissed_hash"] is None
    res = await client.post(url + "/correction-dismissal", json={"rule_hash": _hash(RULE)}, headers=headers)
    assert res.status_code == 200, res.text
    assert res.json()["correction_dismissed_hash"] == _hash(RULE)
    # The bulk lookup Records checks the project's rules with carries it too.
    bulk = (
        await client.get(f"/api/projects/{project.id}/approvals/BREX-3.0.1/export", headers=headers)
    ).json()
    assert bulk[0]["correction_dismissed_hash"] == _hash(RULE)
    # The rule text itself is untouched.
    assert (await client.get(url, headers=headers)).json()["rule_xml"] == RULE


async def test_dismissal_of_another_text_is_refused(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    res = await client.post(url + "/correction-dismissal", json={"rule_hash": _hash(FIXED)}, headers=headers)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "rule_correction_outdated"


async def test_viewer_cannot_dismiss_or_accept(client, editor_viewer_and_project):
    project, headers, viewer = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    res = await client.post(url + "/correction-dismissal", json={"rule_hash": _hash(RULE)}, headers=viewer)
    assert res.status_code == 403
    res = await client.put(url, json={"rule_xml": FIXED, "source": "manual", "correction": CORRECTION}, headers=viewer)
    assert res.status_code == 403
    # A viewer still reads the dismissal state.
    assert (await client.get(url, headers=viewer)).status_code == 200


async def test_dismissal_without_rule_is_404(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-EXT-1"}, headers=headers)
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-3.0.1"
    res = await client.post(url + "/correction-dismissal", json={"rule_hash": _hash(RULE)}, headers=headers)
    assert res.status_code == 404
