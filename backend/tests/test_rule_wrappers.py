"""Legacy wrappers around stored rules (app/services/rule_wrappers.py).

Real cases BRDP-S1-00507 (<rules>) and BRDP-S1-00070 (a bare
<structureObjectRuleGroup>), S1000D 4.2: Generate took them apart, the
format check and the rule test rejected them. Now the Excel import stores
the rules clean and normalize_stored_rule_wrappers() (behind
scripts/normalize_rule_wrappers.py) cleans what is already stored, with a
history entry. The cases in fixtures/rule_wrapper_cases.json are shared
with the JavaScript twin (scripts/test-rule-wrappers.mjs).
"""
import json
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from app.api.routes.approvals import _rule_format_problem
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, BRDPHistory, Project, RuleApproval, User, UserProjectRole
from app.services.rule_wrappers import normalize_stored_rule_wrappers, split_rule_pieces, unwrap_rule_xml

CASES = json.loads((Path(__file__).parent / "fixtures" / "rule_wrapper_cases.json").read_text(encoding="utf-8"))["cases"]
REAL = {c["name"].split(":")[0].replace("real ", ""): c for c in CASES if c["name"].startswith("real ")}
WRAPPED_00507 = REAL["BRDP-S1-00507"]["input"]
CLEAN_00507 = REAL["BRDP-S1-00507"]["expected"]
SOR = '<structureObjectRule><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>'


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_cases(case):
    cleaned, changed = unwrap_rule_xml(case["input"], case["format"])
    assert changed == case["changed"]
    assert cleaned == case["expected"]
    pieces = split_rule_pieces(case["input"], case["format"])
    got = None if pieces is None else [{"kind": p["kind"], "text": p["text"]} for p in pieces]
    assert got == case["pieces"]
    if changed:
        # The cleaned rule is a rule of its format, and the original was not.
        assert _rule_format_problem(cleaned, case["format"]) is None
        assert _rule_format_problem(case["input"], case["format"])["code"] == "rule_format_wrapper"


def test_real_rules_keep_their_text_exactly():
    # Every rule of the real rows is carried over byte for byte.
    for case in (REAL["BRDP-S1-00507"], REAL["BRDP-S1-00070"]):
        for piece in case["pieces"]:
            assert piece["text"] in case["input"]
            assert piece["text"] in case["expected"]
    assert REAL["BRDP-S1-00507"]["expected"].startswith("<structureObjectRule>")
    assert REAL["BRDP-S1-00507"]["expected"].rstrip().endswith("</nonContextRule>")
    assert REAL["BRDP-S1-00070"]["expected"].count("<structureObjectRule>") == 2


def test_malformed_rule_is_left_as_it_is():
    broken = "<rules><structureObjectRule></rules>"
    assert unwrap_rule_xml(broken, "BREX-4.2") == (broken, False)


def test_empty_rule_is_left_as_it_is():
    assert unwrap_rule_xml("", "BREX-4.2") == ("", False)


# ─── Excel import ─────────────────────────────────────────────────────────


@pytest.fixture
async def editor_and_project():
    async with async_session_factory() as session:
        project = Project(name=f"Wrapper Test Project {uuid.uuid4()}", standard="S1000D 4.2")
        editor = User(
            email=f"wrapper-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Wrapper Test Editor",
            global_role="user",
        )
        session.add_all([project, editor])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)
    yield project, editor, {"Authorization": f"Bearer {create_access_token(editor.id)}"}
    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        db_user = await session.get(User, editor.id)
        if db_user is not None:
            await session.delete(db_user)
        await session.commit()


def _row(identifier, rule, rule_status="Verified"):
    return {
        "row_number": 2,
        "identifier": identifier,
        "title": "Nested random lists",
        "definition": "Some definition",
        "proposal": "Some proposal",
        "proposal_status": "Validated",
        "rule_status": rule_status,
        "rule": rule,
    }


async def _apply(client, project_id, headers, rows):
    resp = await client.post(
        f"/api/projects/{project_id}/brdps/import/apply", json={"rows": rows, "conflict_resolution": "keep"}, headers=headers
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    for _ in range(20):
        body = (await client.get(f"/api/projects/{project_id}/brdps/import/status/{job_id}", headers=headers)).json()
        if body["status"] != "running":
            return body
    raise AssertionError("import job never finished")


async def _approval(project_id, identifier):
    async with async_session_factory() as session:
        return (
            await session.execute(
                select(RuleApproval)
                .join(BRDP, BRDP.id == RuleApproval.brdp_id)
                .where(BRDP.project_id == project_id, BRDP.identifier == identifier)
            )
        ).scalar_one()


async def test_import_stores_the_real_wrapped_rule_clean(client, editor_and_project):
    project, _editor, headers = editor_and_project
    rows = [_row("BRDP-S1-00507", WRAPPED_00507)]
    analyzed = (await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)).json()
    assert analyzed["results"][0]["outcome"] == "ok"
    assert (await _apply(client, project.id, headers, rows))["status"] == "completed"
    approval = await _approval(project.id, "BRDP-S1-00507")
    assert approval.rule_xml == CLEAN_00507
    assert approval.status == "approved"
    assert _rule_format_problem(approval.rule_xml, "BREX-4.2") is None
    async with async_session_factory() as session:
        history = (
            await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id == approval.brdp_id, BRDPHistory.field_name == "rule"))
        ).scalars().all()
    assert [(h.old_value, h.new_value) for h in history] == [("", CLEAN_00507)]


async def test_import_keeps_a_clean_rule_byte_for_byte(client, editor_and_project):
    project, _editor, headers = editor_and_project
    clean = REAL["BRDP-S1-00006"]["input"]
    await _apply(client, project.id, headers, [_row("BRDP-S1-00006", clean)])
    assert (await _approval(project.id, "BRDP-S1-00006")).rule_xml == clean


async def test_reimporting_the_wrapped_file_over_the_clean_rule_is_not_an_override(client, editor_and_project):
    project, _editor, headers = editor_and_project
    rows = [_row("BRDP-S1-00507", WRAPPED_00507)]
    await _apply(client, project.id, headers, rows)
    analyzed = (await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)).json()
    assert analyzed["results"][0]["rule_override"] is False


# ─── Cleaning what is already stored ──────────────────────────────────────


async def test_normalize_stored_rules_dry_run_then_real(editor_and_project):
    project, editor, _headers = editor_and_project
    wrapped_with_text = f"<rules>see note {SOR}</rules>"
    stored = {
        "BRDP-WRAP-REAL": (WRAPPED_00507, "approved"),
        "BRDP-WRAP-GROUP": (REAL["BRDP-S1-00070"]["input"], "pending_review"),
        "BRDP-WRAP-CLEAN": (SOR, "approved"),
        "BRDP-WRAP-TEXT": (wrapped_with_text, "pending_review"),
    }
    async with async_session_factory() as session:
        for identifier, (xml, status) in stored.items():
            brdp = BRDP(project_id=project.id, identifier=identifier, title="t", definition="d", proposal="p", validation="Validated")
            session.add(brdp)
            await session.flush()
            session.add(RuleApproval(brdp_id=brdp.id, format="BREX-4.2", rule_xml=xml, source="manual", status=status))
        await session.commit()

    def ours(results):
        return {r["identifier"]: r for r in results if r["project"] == project.name}

    async with async_session_factory() as session:
        user = await session.get(User, editor.id)
        dry = ours(await normalize_stored_rule_wrappers(session, user, dry_run=True))
        await session.commit()
    assert set(dry) == {"BRDP-WRAP-REAL", "BRDP-WRAP-GROUP", "BRDP-WRAP-TEXT"}
    assert dry["BRDP-WRAP-REAL"]["changed"] and dry["BRDP-WRAP-REAL"]["new"] == CLEAN_00507
    assert dry["BRDP-WRAP-GROUP"]["changed"]
    assert not dry["BRDP-WRAP-TEXT"]["changed"]
    # Dry run: nothing written, no history.
    for identifier, (xml, _status) in stored.items():
        assert (await _approval(project.id, identifier)).rule_xml == xml
    async with async_session_factory() as session:
        brdp_ids = select(BRDP.id).where(BRDP.project_id == project.id)
        assert (await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id.in_(brdp_ids)))).first() is None

    async with async_session_factory() as session:
        user = await session.get(User, editor.id)
        real = ours(await normalize_stored_rule_wrappers(session, user, dry_run=False))
        await session.commit()
    assert set(real) == set(dry)

    real_rule = await _approval(project.id, "BRDP-WRAP-REAL")
    assert real_rule.rule_xml == CLEAN_00507 and real_rule.status == "approved"
    group_rule = await _approval(project.id, "BRDP-WRAP-GROUP")
    assert group_rule.rule_xml == REAL["BRDP-S1-00070"]["expected"] and group_rule.status == "pending_review"
    assert (await _approval(project.id, "BRDP-WRAP-CLEAN")).rule_xml == SOR
    assert (await _approval(project.id, "BRDP-WRAP-TEXT")).rule_xml == wrapped_with_text

    async with async_session_factory() as session:
        entries = (
            await session.execute(
                select(BRDP.identifier, BRDPHistory)
                .join(BRDP, BRDP.id == BRDPHistory.brdp_id)
                .where(BRDP.project_id == project.id)
            )
        ).all()
    by_id = {identifier: h for identifier, h in entries}
    assert set(by_id) == {"BRDP-WRAP-REAL", "BRDP-WRAP-GROUP"}
    assert by_id["BRDP-WRAP-REAL"].field_name == "rule"
    assert (by_id["BRDP-WRAP-REAL"].old_value, by_id["BRDP-WRAP-REAL"].new_value) == (WRAPPED_00507, CLEAN_00507)
    assert by_id["BRDP-WRAP-REAL"].user_email == editor.email

    # Running it again finds nothing left to clean in this project, only the
    # one it must not touch.
    async with async_session_factory() as session:
        user = await session.get(User, editor.id)
        again = ours(await normalize_stored_rule_wrappers(session, user, dry_run=False))
        await session.commit()
    assert set(again) == {"BRDP-WRAP-TEXT"}
