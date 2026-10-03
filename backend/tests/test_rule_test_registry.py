"""Test de reglas T3: recording the last "Test rule" run on a saved rule.
Real Postgres, no mocking (the test itself runs in the browser; the backend
only records its result, checked against the saved rule's hash).
"""
import hashlib
import json
import uuid

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole

RULE = '<structureObjectRule id="BRDP-T3-001"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>'
DOC_REASON = {"code": "external_document", "params": {"fn": "document()"}}


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@pytest.fixture
async def editor_viewer_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"Rule test registry {uuid.uuid4()}", standard="S1000D 4.2")
        editor = User(
            email=f"t3-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="T3 Editor",
            global_role="user",
        )
        viewer = User(
            email=f"t3-viewer-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="T3 Viewer",
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


async def _brdp_with_rule(client, project, headers, identifier="BRDP-T3-001", rule=RULE):
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": identifier}, headers=headers)
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"
    res = await client.put(url, json={"rule_xml": rule, "source": "llm"}, headers=headers)
    assert res.status_code == 200
    return brdp, url


async def test_never_tested_rule_reports_no_test(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    body = (await client.get(url, headers=headers)).json()
    assert body["last_test_result"] is None
    assert body["last_test_reason"] is None
    assert body["last_test_at"] is None
    assert body["last_test_up_to_date"] is None


async def test_register_passed_test_with_matching_hash(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    res = await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["last_test_result"] == "passed"
    assert body["last_test_reason"] is None
    assert body["last_test_at"] is not None
    assert body["last_test_rule_hash"] == _hash(RULE)
    assert body["last_test_up_to_date"] is True
    # The per-BRDP GET returns the same.
    assert (await client.get(url, headers=headers)).json()["last_test_up_to_date"] is True


async def test_register_rejects_hash_of_another_rule(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    other = RULE.replace("//emphasis", "//para")
    res = await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(other)}, headers=headers)
    assert res.status_code == 409
    assert (await client.get(url, headers=headers)).json()["last_test_result"] is None


async def test_editing_the_rule_after_testing_makes_the_test_outdated(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    edited = RULE.replace("No emphasis.", "Emphasis is not allowed.")
    body = (await client.put(url, json={"rule_xml": edited, "source": "manual"}, headers=headers)).json()
    # The result is kept (it is what was tested), but it no longer applies.
    assert body["last_test_result"] == "passed"
    assert body["last_test_up_to_date"] is False
    # Testing the edited rule brings it up to date again.
    body = (
        await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(edited)}, headers=headers)
    ).json()
    assert body["last_test_up_to_date"] is True


async def test_register_not_executable_keeps_the_reason_code(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    res = await client.post(
        url + "/test",
        json={"result": "not_executable", "reason": DOC_REASON, "rule_hash": _hash(RULE)},
        headers=headers,
    )
    assert res.status_code == 200
    assert res.json()["last_test_result"] == "not_executable"
    assert res.json()["last_test_reason"] == DOC_REASON


async def test_multi_part_reason_is_stored_as_given(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    reason = {
        "code": "parts",
        "params": {"parts": [{"ruleId": "n1", "reason": {"code": "non_context_rule", "params": {}}}]},
    }
    res = await client.post(
        url + "/test", json={"result": "not_executable", "reason": reason, "rule_hash": _hash(RULE)}, headers=headers
    )
    assert res.status_code == 200
    assert res.json()["last_test_reason"] == reason


@pytest.mark.parametrize(
    "payload",
    [
        {"result": "passed", "reason": DOC_REASON},  # a passed test has no reason
        {"result": "failed"},  # a failed test needs one
        {"result": "not_executable"},
        {"result": "review"},  # a review says why
        {"result": "review", "reason": {"code": "test_proposal_mismatch", "params": {"mismatch": "x"}}, "edited_examples": [{"label": "a", "xml": "<a/>"}]},
        {"result": "maybe", "reason": DOC_REASON},  # unknown result
        {"result": "failed", "reason": {"code": "Not a code!", "params": {}}},  # a code, not a sentence
        {"result": "passed", "rule_hash": "abc"},  # not a SHA-256 hex digest
        {"result": "failed", "reason": {"code": "xpath_error", "params": {"message": "x" * 5000}}},  # too large
    ],
)
async def test_register_validates_the_payload(client, editor_viewer_and_project, payload):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    body = {"rule_hash": _hash(RULE), **payload}
    res = await client.post(url + "/test", json=body, headers=headers)
    assert res.status_code == 422


async def test_register_without_a_saved_rule_404s(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-T3-NONE"}, headers=headers)
    ).json()
    url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/BREX-4.2"
    res = await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    assert res.status_code == 404


async def test_viewer_cannot_register_a_test(client, editor_viewer_and_project):
    project, headers, viewer_headers = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    res = await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=viewer_headers)
    assert res.status_code == 403
    # ...but can read the recorded result.
    assert (await client.get(url, headers=viewer_headers)).status_code == 200


async def test_every_registration_adds_a_rule_test_history_entry(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    await client.post(
        url + "/test",
        json={"result": "failed", "reason": {"code": "test_incorrect", "params": {"permissive": True, "strict": False}}, "rule_hash": _hash(RULE)},
        headers=headers,
    )
    await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    # The same result again is still a test: recorded too.
    await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    history = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=headers)).json()
    entries = sorted((h for h in history if h["field_name"] == "rule_test"), key=lambda h: h["changed_at"])
    assert len(entries) == 3
    first, second, third = entries
    assert first["old_value"] == ""
    assert json.loads(first["new_value"]) == {
        "result": "failed",
        "reason": {"code": "test_incorrect", "params": {"permissive": True, "strict": False}},
    }
    assert json.loads(second["old_value"])["result"] == "failed"
    assert json.loads(second["new_value"]) == {"result": "passed", "reason": None}
    assert third["old_value"] == third["new_value"]


async def test_approve_is_not_blocked_by_a_missing_or_failed_test(client, editor_viewer_and_project):
    """Warn, never block (user decision): the backend's approve path is
    unchanged -- the warning lives in the UI.
    """
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    assert (await client.post(url + "/approve", headers=headers)).status_code == 200
    await client.post(url + "/revoke", headers=headers)
    await client.post(
        url + "/test",
        json={"result": "failed", "reason": {"code": "test_incorrect", "params": {"permissive": True, "strict": False}}, "rule_hash": _hash(RULE)},
        headers=headers,
    )
    assert (await client.post(url + "/approve", headers=headers)).status_code == 200


# ─── A test passed with examples edited by hand ─────────────────────────────

EDITED = [
    {
        "label": "Nested lists",
        "xml": "<dmodule><content><description><levelledPara><para><randomList><listItem><para>A<randomList><listItem><para>B</para></listItem></randomList></para></listItem></randomList></para></levelledPara></description></content></dmodule>",
    }
]


async def test_register_passed_with_edited_examples_stores_them(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    failed = {"result": "failed", "reason": {"code": "test_incorrect", "params": {"permissive": True, "strict": False}}, "rule_hash": _hash(RULE)}
    assert (await client.post(f"{url}/test", json=failed, headers=headers)).status_code == 200
    res = await client.post(f"{url}/test", json={"result": "passed", "rule_hash": _hash(RULE), "edited_examples": EDITED}, headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["last_test_result"] == "passed"
    assert body["last_test_edited_examples"] == EDITED
    assert body["last_test_up_to_date"] is True
    # History: the entry carries the edited examples (their XML), the
    # previous one (failed) does not.
    history = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=headers)).json()
    entries = [h for h in history if h["field_name"] == "rule_test"]
    latest = max(entries, key=lambda h: h["changed_at"])
    assert json.loads(latest["new_value"]) == {"result": "passed", "reason": None, "edited_examples": EDITED}
    assert json.loads(latest["old_value"])["result"] == "failed"
    assert "edited_examples" not in json.loads(latest["old_value"])


async def test_a_new_test_without_edits_clears_the_edited_examples(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    await client.post(f"{url}/test", json={"result": "passed", "rule_hash": _hash(RULE), "edited_examples": EDITED}, headers=headers)
    body = (await client.post(f"{url}/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)).json()
    assert body["last_test_result"] == "passed"
    assert body["last_test_edited_examples"] is None


async def test_plain_passed_history_value_is_unchanged(client, editor_viewer_and_project):
    # Without edits, the History value keeps the exact shape it had before.
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    await client.post(f"{url}/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    history = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=headers)).json()
    entry = next(h for h in history if h["field_name"] == "rule_test")
    assert json.loads(entry["new_value"]) == {"result": "passed", "reason": None}


@pytest.mark.parametrize(
    "payload",
    [
        # only a passed test carries edited examples
        {"result": "failed", "reason": {"code": "test_incorrect", "params": {}}, "edited_examples": EDITED},
        # never an empty list
        {"result": "passed", "edited_examples": []},
        # an example without XML
        {"result": "passed", "edited_examples": [{"label": "x", "xml": ""}]},
        # too many
        {"result": "passed", "edited_examples": EDITED * 21},
    ],
)
async def test_edited_examples_payload_is_validated(client, editor_viewer_and_project, payload):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    res = await client.post(f"{url}/test", json={**payload, "rule_hash": _hash(RULE)}, headers=headers)
    assert res.status_code == 422


async def test_register_review_keeps_the_mismatch_and_is_not_passed(client, editor_viewer_and_project):
    """Test de reglas, "Revisar": the examples passed but the rule does not
    seem to implement the Proposal -- its own result, never "passed", with
    the LLM's note as the reason; History records it like any other test.
    """
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    reason = {"code": "test_proposal_mismatch", "params": {"mismatch": "The Proposal allows up to three substeps; the rule forbids a single one."}}
    res = await client.post(url + "/test", json={"result": "review", "reason": reason, "rule_hash": _hash(RULE)}, headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["last_test_result"] == "review"
    assert body["last_test_reason"] == reason
    assert body["last_test_up_to_date"] is True
    history = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=headers)).json()
    entry = next(h for h in history if h["field_name"] == "rule_test")
    assert json.loads(entry["new_value"]) == {"result": "review", "reason": reason}


async def test_keep_previous_leaves_the_passed_test_and_notes_the_attempt(client, editor_viewer_and_project):
    """"Mantener la anterior": a new, not-passed result over a passed test of
    the same rule is not recorded; the passed test stays and History notes
    the attempt with the date of the test that was kept.
    """
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    passed = (await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)).json()
    reason = {"code": "test_incorrect", "params": {"permissive": True, "strict": False}}
    res = await client.post(
        url + "/test", json={"result": "failed", "reason": reason, "rule_hash": _hash(RULE), "keep_previous": True}, headers=headers
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["last_test_result"] == "passed"
    assert body["last_test_reason"] is None
    assert body["last_test_at"] == passed["last_test_at"]
    history = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=headers)).json()
    entries = [h for h in history if h["field_name"] == "rule_test"]
    assert len(entries) == 2
    latest = max(entries, key=lambda h: h["changed_at"])
    value = json.loads(latest["new_value"])
    assert value["result"] == "failed" and value["reason"] == reason and value["not_recorded"] is True
    assert value["kept_test_at"].startswith(passed["last_test_at"][:19])
    assert json.loads(latest["old_value"])["result"] == "passed"


async def test_keep_previous_needs_a_passed_test(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    reason = {"code": "test_no_runnable", "params": {}}
    keep = {"result": "inconclusive", "reason": reason, "rule_hash": _hash(RULE), "keep_previous": True}
    # Never tested: nothing to keep.
    assert (await client.post(url + "/test", json=keep, headers=headers)).status_code == 409
    # Last test failed: nothing passed to keep.
    await client.post(url + "/test", json={"result": "failed", "reason": {"code": "test_incorrect", "params": {}}, "rule_hash": _hash(RULE)}, headers=headers)
    assert (await client.post(url + "/test", json=keep, headers=headers)).status_code == 409
    # A passed test is always recorded: keep_previous with passed is invalid.
    res = await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "keep_previous": True}, headers=headers)
    assert res.status_code == 422


async def test_replacing_a_passed_test_without_keep_records_it(client, editor_viewer_and_project):
    """"Registrar este resultado": recorded as today."""
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)
    reason = {"code": "test_incorrect", "params": {"permissive": True, "strict": False}}
    body = (await client.post(url + "/test", json={"result": "failed", "reason": reason, "rule_hash": _hash(RULE)}, headers=headers)).json()
    assert body["last_test_result"] == "failed" and body["last_test_reason"] == reason


# ─── Guardar la prueba aprobada (last_passed_test) ─────────────────────────

RULE_B = RULE.replace("//emphasis", "//acronym")


def _passed_payload(examples_from=None, proposal="No emphasis in the text."):
    payload = {
        "proposal": proposal,
        "examples": [
            {
                "label": "Plain text",
                "expected": "accept",
                "schema": "descript",
                "xml": "<dmodule><content><description><levelledPara><para>Plain.</para></levelledPara></description></content></dmodule>",
                "skeleton_node_paths": ["/dmodule[1]", "/dmodule[1]/content[1]"],
                "result": "accepted",
                "matches": True,
            },
            {
                "label": "Emphasis",
                "expected": "reject",
                "schema": "descript",
                "xml": "<dmodule><content><description><levelledPara><para><emphasis>X</emphasis></para></levelledPara></description></content></dmodule>",
                "skeleton_node_paths": [],
                "result": "rejected",
                "matches": True,
            },
        ],
    }
    if examples_from is not None:
        payload["examples_from"] = examples_from
    return payload


async def test_passed_test_is_kept_with_its_examples(client, editor_viewer_and_project):
    project, headers, viewer_headers = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    body = (
        await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": _passed_payload()}, headers=headers)
    ).json()
    saved = body["last_passed_test"]
    assert saved["rule_xml"] == RULE and saved["rule_hash"] == _hash(RULE)
    assert saved["proposal"] == "No emphasis in the text."
    assert saved["examples_from"] is None and saved["edited_count"] == 0
    assert saved["at"][:19] == body["last_test_at"][:19]
    assert [e["label"] for e in saved["examples"]] == ["Plain text", "Emphasis"]
    first = saved["examples"][0]
    assert first["schema"] == "descript" and first["expected"] == "accept" and first["result"] == "accepted" and first["matches"] is True
    assert first["skeleton_node_paths"] == ["/dmodule[1]", "/dmodule[1]/content[1]"]
    # A viewer reads it too.
    assert (await client.get(url, headers=viewer_headers)).json()["last_passed_test"]["rule_hash"] == _hash(RULE)


async def test_a_failed_test_leaves_the_passed_test_and_a_new_pass_replaces_it(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    first = (
        await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": _passed_payload()}, headers=headers)
    ).json()["last_passed_test"]
    reason = {"code": "test_incorrect", "params": {"permissive": True, "strict": False}}
    body = (await client.post(url + "/test", json={"result": "failed", "reason": reason, "rule_hash": _hash(RULE)}, headers=headers)).json()
    assert body["last_test_result"] == "failed"
    assert body["last_passed_test"] == first
    # The rule changes: the saved test stays (of an earlier version).
    await client.put(url, json={"rule_xml": RULE_B, "source": "manual"}, headers=headers)
    assert (await client.get(url, headers=headers)).json()["last_passed_test"] == first
    # A new passed test replaces it.
    body = (
        await client.post(
            url + "/test",
            json={"result": "passed", "rule_hash": _hash(RULE_B), "passed_test": _passed_payload(proposal="Other")},
            headers=headers,
        )
    ).json()
    assert body["last_passed_test"]["rule_xml"] == RULE_B and body["last_passed_test"]["proposal"] == "Other"


async def test_a_passed_test_without_examples_clears_the_saved_one(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": _passed_payload()}, headers=headers)
    body = (await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE)}, headers=headers)).json()
    assert body["last_passed_test"] is None


async def test_a_pass_on_saved_examples_keeps_their_date_and_notes_it_in_history(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    brdp, url = await _brdp_with_rule(client, project, headers)
    first = (
        await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": _passed_payload()}, headers=headers)
    ).json()["last_passed_test"]
    body = (
        await client.post(
            url + "/test",
            json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": _passed_payload(examples_from=first["at"])},
            headers=headers,
        )
    ).json()
    assert body["last_passed_test"]["examples_from"][:19] == first["at"][:19]
    history = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/history", headers=headers)).json()
    latest = max((h for h in history if h["field_name"] == "rule_test"), key=lambda h: h["changed_at"])
    assert json.loads(latest["new_value"])["examples_from"][:19] == first["at"][:19]


async def test_a_pass_on_saved_edited_examples_keeps_saying_they_were_edited(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    payload = {**_passed_payload(examples_from="2026-09-01T10:00:00+00:00"), "edited_count": 2}
    body = (await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": payload}, headers=headers)).json()
    assert body["last_passed_test"]["edited_count"] == 2
    bad = {**_passed_payload(), "edited_count": -1}
    resp = await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": bad}, headers=headers)
    assert resp.status_code == 422


async def test_passed_test_payload_is_validated(client, editor_viewer_and_project):
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    reason = {"code": "test_incorrect", "params": {}}
    # Only with a passed result.
    res = await client.post(url + "/test", json={"result": "failed", "reason": reason, "rule_hash": _hash(RULE), "passed_test": _passed_payload()}, headers=headers)
    assert res.status_code == 422
    # Never without examples, never an unknown expectation.
    empty = {**_passed_payload(), "examples": []}
    assert (await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": empty}, headers=headers)).status_code == 422
    bad = _passed_payload()
    bad["examples"][0]["expected"] = "maybe"
    assert (await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": bad}, headers=headers)).status_code == 422


async def test_keep_previous_over_a_passed_test_of_an_earlier_rule(client, editor_viewer_and_project):
    """"Probar con los ejemplos guardados" re-runs the saved test after the
    rule changed and asks before replacing the passed test: "Keep the
    previous one" is allowed although the passed test is outdated."""
    project, headers, _ = editor_viewer_and_project
    _, url = await _brdp_with_rule(client, project, headers)
    passed = (
        await client.post(url + "/test", json={"result": "passed", "rule_hash": _hash(RULE), "passed_test": _passed_payload()}, headers=headers)
    ).json()
    await client.put(url, json={"rule_xml": RULE_B, "source": "manual"}, headers=headers)
    reason = {"code": "test_incorrect", "params": {"permissive": False, "strict": True}}
    res = await client.post(url + "/test", json={"result": "failed", "reason": reason, "rule_hash": _hash(RULE_B), "keep_previous": True}, headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["last_test_result"] == "passed" and body["last_test_at"] == passed["last_test_at"]
    assert body["last_test_up_to_date"] is False
