"""Re-importing the Excel never touches a rule that has not changed
("Importación que no toca las reglas que no cambian"). Real Postgres, real
export (POST .../export.xlsx) and real parse (POST .../import/parse): the
file goes through openpyxl exactly as the user's would.

A rule whose text in the file is structurally the same as the stored one
(app/services/import_jobs.py's _rule_xml_structurally_equal, both sides
without legacy wrappers) keeps its rule_approvals row as it is: rule_xml
byte for byte, source, approved_at and its test. Only a real change of the
rule replaces it -- and even then the test is kept, shown as outdated.
"""
import hashlib
import uuid

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, BRDPHistory, Project, RuleApproval, User, UserProjectRole

FORMAT = "BREX-4.2"

# Stored with CRLF and a trailing newline, as a rule pasted through the API
# can be: the Excel round trip turns CRLF into LF, so the file's text is not
# byte-identical to the stored one even when nobody touched it.
RULE_A = (
    '<structureObjectRule id="BRDP-KR-001">\r\n'
    '  <objectPath allowedObjectFlag="0">//emphasis</objectPath>\r\n'
    "  <objectUse>No emphasis.</objectUse>\r\n"
    "</structureObjectRule>\r\n"
)
RULE_B = (
    '<structureObjectRule id="BRDP-KR-002"><objectPath allowedObjectFlag="2">//@emphasisType</objectPath>'
    '<objectUse>Only em01.</objectUse><objectValue valueForm="single" valueAllowed="em01"/></structureObjectRule>'
)
RULE_C = '<structureObjectRule id="BRDP-KR-003"><objectPath allowedObjectFlag="0">//acronym</objectPath><objectUse>No acronyms in the text.</objectUse></structureObjectRule>'

APPROVAL_FIELDS = (
    "rule_xml",
    "source",
    "status",
    "approved_at",
    "last_test_result",
    "last_test_reason",
    "last_test_at",
    "last_test_by",
    "last_test_rule_hash",
    "last_test_edited_examples",
    "last_passed_test",
)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _passed_payload(proposal: str) -> dict:
    return {
        "proposal": proposal,
        "examples": [
            {
                "label": "Plain text",
                "expected": "accept",
                "schema": "descript",
                "xml": "<dmodule><content><description><levelledPara><para>Plain.</para></levelledPara></description></content></dmodule>",
                "skeleton_node_paths": ["/dmodule[1]"],
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


@pytest.fixture
async def project_with_tested_rules(client):
    """Three BRDPs, each with a rule and a recorded test:
    - KR-001: Verified, source "llm", passed test kept with its examples,
      stored with CRLF line breaks;
    - KR-002: Draft, source "extracted", failed test;
    - KR-003: Verified, source "manual", passed test with examples edited
      by hand.
    """
    async with async_session_factory() as session:
        project = Project(name=f"Keep rules {uuid.uuid4()}", standard="S1000D 4.2")
        editor = User(
            email=f"keep-rules-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Keep Rules Editor",
            global_role="user",
        )
        session.add_all([project, editor])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)
    headers = {"Authorization": f"Bearer {create_access_token(editor.id)}"}

    async def add(identifier, rule, source, verified, test):
        proposal = f"Proposal of {identifier}."
        brdp = (
            await client.post(
                f"/api/projects/{project.id}/brdps",
                json={"identifier": identifier, "title": f"Title {identifier}", "definition": "Definition.", "proposal": proposal, "validation": "Validated"},
                headers=headers,
            )
        ).json()
        url = f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/{FORMAT}"
        res = await client.put(url, json={"rule_xml": rule, "source": source, "status": "approved" if verified else "pending_review"}, headers=headers)
        assert res.status_code == 200, res.text
        res = await client.post(url + "/test", json={"rule_hash": _hash(rule), **test(proposal)}, headers=headers)
        assert res.status_code == 200, res.text
        return brdp

    await add("BRDP-KR-001", RULE_A, "llm", True, lambda p: {"result": "passed", "passed_test": _passed_payload(p)})
    await add(
        "BRDP-KR-002", RULE_B, "extracted", False,
        lambda p: {"result": "failed", "reason": {"code": "test_incorrect", "params": {"permissive": 1, "strict": 0}}},
    )
    await add(
        "BRDP-KR-003", RULE_C, "manual", True,
        lambda p: {
            "result": "passed",
            "edited_examples": [{"label": "Edited", "xml": "<dmodule><content/></dmodule>"}],
            "passed_test": _passed_payload(p),
        },
    )
    yield project, headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        db_user = await session.get(User, editor.id)
        if db_user is not None:
            await session.delete(db_user)
        await session.commit()


async def _approvals(project_id) -> dict[str, dict]:
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(BRDP.identifier, RuleApproval)
                .join(RuleApproval, RuleApproval.brdp_id == BRDP.id)
                .where(BRDP.project_id == project_id, RuleApproval.format == FORMAT)
            )
        ).all()
        return {identifier: {f: getattr(a, f) for f in APPROVAL_FIELDS} for identifier, a in rows}


async def _rule_history(project_id) -> list[tuple[str, str]]:
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(BRDP.identifier, BRDPHistory.field_name)
                .join(BRDPHistory, BRDPHistory.brdp_id == BRDP.id)
                .where(BRDP.project_id == project_id, BRDPHistory.field_name.in_(("rule", "rule_status")))
            )
        ).all()
        return sorted((i, f) for i, f in rows)


async def _export_rows(client, project, headers) -> list[dict]:
    """The file the user would download: the export endpoint fed with the
    rows the page builds (brdpToExportRow), read back by the import's own
    parse endpoint."""
    brdps = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    approvals = (await client.get(f"/api/projects/{project.id}/approvals/{FORMAT}/export", headers=headers)).json()
    by_brdp = {a["brdp_id"]: a for a in approvals}
    labels = {"pending_review": "Draft", "approved": "Verified"}
    rows = []
    for b in brdps:
        a = by_brdp.get(b["id"])
        rows.append(
            {
                "id": b["identifier"],
                "title": b["title"],
                "definition": b["definition"],
                "proposal": b["proposal"],
                "proposalStatus": b["validation"],
                "ruleStatus": labels[a["status"]] if a else "To Do",
                "rule": a["rule_xml"] if a else "",
                "catalogEdition": "",
            }
        )
    xlsx = await client.post(f"/api/projects/{project.id}/export.xlsx", json={"rows": rows}, headers=headers)
    assert xlsx.status_code == 200, xlsx.text
    parsed = await client.post(
        f"/api/projects/{project.id}/brdps/import/parse",
        files={"file": ("export.xlsx", xlsx.content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        headers=headers,
    )
    assert parsed.status_code == 200, parsed.text
    body = parsed.json()
    assert body["errors"] == []
    return body["rows"]


async def _analyze(client, project, headers, rows) -> list[dict]:
    res = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()["results"]


async def _apply(client, project, headers, rows, conflict_resolution="keep") -> dict:
    res = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": conflict_resolution},
        headers=headers,
    )
    assert res.status_code == 202, res.text
    job_id = res.json()["job_id"]
    body = (await client.get(f"/api/projects/{project.id}/brdps/import/status/{job_id}", headers=headers)).json()
    assert body["status"] == "completed", body
    return body


def _row(rows, identifier) -> dict:
    return next(r for r in rows if r["identifier"] == identifier)


async def test_reimporting_the_export_unchanged_leaves_every_rule_row_identical(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    history_before = await _rule_history(project.id)
    rows = await _export_rows(client, project, headers)
    # The round trip really did change the text of KR-001 (CRLF -> LF): the
    # case that used to leave its test "outdated".
    assert _row(rows, "BRDP-KR-001")["rule"] != RULE_A

    results = await _analyze(client, project, headers, rows)
    assert all(r["rule_kept"] and not r["rule_override"] for r in results)

    await _apply(client, project, headers, rows)
    assert await _approvals(project.id) == before
    assert await _rule_history(project.id) == history_before

    # Every test still up to date.
    for identifier in ("BRDP-KR-001", "BRDP-KR-002", "BRDP-KR-003"):
        brdp = next(b for b in (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json() if b["identifier"] == identifier)
        approval = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/{FORMAT}", headers=headers)).json()
        assert approval["last_test_up_to_date"] is True, identifier


async def test_changing_only_the_proposal_keeps_the_rule_and_its_test(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    rows = await _export_rows(client, project, headers)
    _row(rows, "BRDP-KR-001")["proposal"] = "A new proposal, written after the test."

    await _apply(client, project, headers, rows)
    assert await _approvals(project.id) == before
    brdps = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    kr1 = next(b for b in brdps if b["identifier"] == "BRDP-KR-001")
    assert kr1["proposal"] == "A new proposal, written after the test."
    # The saved passed test still carries the Proposal it was written for:
    # the page compares it with the BRDP's and warns (proposalChanged).
    assert before["BRDP-KR-001"]["last_passed_test"]["proposal"] == "Proposal of BRDP-KR-001."


async def test_reindenting_the_rule_in_the_file_does_not_touch_it(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    rows = await _export_rows(client, project, headers)
    _row(rows, "BRDP-KR-002")["rule"] = RULE_B.replace("><", ">\n      <")
    _row(rows, "BRDP-KR-003")["rule"] = "\n\n" + RULE_C.replace("><", ">\r\n\t<") + "\n"

    results = await _analyze(client, project, headers, rows)
    assert _row(results, "BRDP-KR-002")["rule_kept"] and _row(results, "BRDP-KR-003")["rule_kept"]
    await _apply(client, project, headers, rows)
    assert await _approvals(project.id) == before


async def test_a_legacy_wrapper_in_the_file_is_the_same_rule(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    rows = await _export_rows(client, project, headers)
    _row(rows, "BRDP-KR-003")["rule"] = f"<rules>{RULE_C}</rules>"

    results = await _analyze(client, project, headers, rows)
    assert _row(results, "BRDP-KR-003")["rule_kept"] and not _row(results, "BRDP-KR-003")["rule_override"]
    await _apply(client, project, headers, rows)
    assert await _approvals(project.id) == before


async def test_changing_the_rule_status_keeps_the_rule_text_source_and_test(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    history_before = await _rule_history(project.id)
    rows = await _export_rows(client, project, headers)
    _row(rows, "BRDP-KR-001")["rule_status"] = "Draft"
    _row(rows, "BRDP-KR-002")["rule_status"] = "Verified"

    await _apply(client, project, headers, rows)
    after = await _approvals(project.id)
    for identifier, new_status in (("BRDP-KR-001", "pending_review"), ("BRDP-KR-002", "approved")):
        assert after[identifier]["status"] == new_status
        for field in APPROVAL_FIELDS:
            if field not in ("status", "approved_at"):
                assert after[identifier][field] == before[identifier][field], (identifier, field)
    assert after["BRDP-KR-001"]["approved_at"] is None
    assert after["BRDP-KR-002"]["approved_at"] is not None
    assert after["BRDP-KR-003"] == before["BRDP-KR-003"]
    # Only the status is in History, never the rule text.
    history_after = await _rule_history(project.id)
    new_entries = list(history_after)
    for entry in history_before:
        new_entries.remove(entry)
    assert sorted(new_entries) == [("BRDP-KR-001", "rule_status"), ("BRDP-KR-002", "rule_status")]


async def test_a_real_rule_change_is_saved_and_its_test_kept_as_outdated(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    rows = await _export_rows(client, project, headers)
    new_rule = RULE_A.replace("//emphasis", "//emphasis[@emphasisType]").replace("\r\n", "\n")
    _row(rows, "BRDP-KR-001")["rule"] = new_rule

    results = await _analyze(client, project, headers, rows)
    assert _row(results, "BRDP-KR-001")["rule_override"] and not _row(results, "BRDP-KR-001")["rule_kept"]
    await _apply(client, project, headers, rows)
    after = await _approvals(project.id)
    kr1 = after["BRDP-KR-001"]
    assert kr1["rule_xml"] == new_rule
    for field in ("last_test_result", "last_test_reason", "last_test_at", "last_test_by", "last_test_rule_hash", "last_test_edited_examples", "last_passed_test"):
        assert kr1[field] == before["BRDP-KR-001"][field], field
    brdp = next(b for b in (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json() if b["identifier"] == "BRDP-KR-001")
    approval = (await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/{FORMAT}", headers=headers)).json()
    assert approval["last_test_up_to_date"] is False
    assert approval["test_category"] == "outdated"
    assert approval["last_passed_test"] is not None
    # The other two rules did not change.
    assert after["BRDP-KR-002"] == before["BRDP-KR-002"]
    assert after["BRDP-KR-003"] == before["BRDP-KR-003"]


async def test_two_spaces_inside_an_attribute_value_is_a_different_rule(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    rows = await _export_rows(client, project, headers)
    changed = RULE_B.replace('valueAllowed="em01"', 'valueAllowed="em01  "')
    _row(rows, "BRDP-KR-002")["rule"] = changed

    results = await _analyze(client, project, headers, rows)
    assert _row(results, "BRDP-KR-002")["rule_override"]
    await _apply(client, project, headers, rows)
    after = await _approvals(project.id)
    assert after["BRDP-KR-002"]["rule_xml"] == changed
    assert after["BRDP-KR-002"]["last_test_rule_hash"] == before["BRDP-KR-002"]["last_test_rule_hash"]


async def test_todo_with_empty_rule_is_a_conflict_and_keep_changes_nothing(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    before = await _approvals(project.id)
    rows = await _export_rows(client, project, headers)
    _row(rows, "BRDP-KR-001")["rule"] = ""
    _row(rows, "BRDP-KR-001")["rule_status"] = "To Do"

    results = await _analyze(client, project, headers, rows)
    assert _row(results, "BRDP-KR-001")["outcome"] == "conflict"
    await _apply(client, project, headers, rows, conflict_resolution="keep")
    assert await _approvals(project.id) == before


async def test_new_brdp_and_a_rule_for_a_brdp_without_one_are_written_as_before(client, project_with_tested_rules):
    project, headers = project_with_tested_rules
    rows = await _export_rows(client, project, headers)
    new_rule = RULE_C.replace("BRDP-KR-003", "BRDP-KR-NEW")
    rows.append(
        {
            "row_number": 99, "identifier": "BRDP-KR-NEW", "title": "New", "definition": "", "proposal": "",
            "proposal_status": "Pending", "rule_status": "Draft", "rule": new_rule,
        }
    )
    results = await _analyze(client, project, headers, rows)
    new = _row(results, "BRDP-KR-NEW")
    assert new["action"] == "create" and not new["rule_kept"] and not new["rule_override"]
    await _apply(client, project, headers, rows)
    after = await _approvals(project.id)
    assert after["BRDP-KR-NEW"]["rule_xml"] == new_rule
    assert after["BRDP-KR-NEW"]["status"] == "pending_review"
    assert after["BRDP-KR-NEW"]["source"] == "manual"
    assert after["BRDP-KR-NEW"]["last_test_result"] is None
