"""AACF 2, Part 2: the breakdown of the verified rules in BRDP Records'
header. The categories add up to the verified count, and every rule's
category in the header is the category its own indicator shows
(RuleApprovalOut.test_category) -- the same function decides both.
Real Postgres.
"""
import uuid
from datetime import datetime, timezone

import pytest

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, Project, RuleApproval, User
from app.services.rule_test_category import TEST_CATEGORIES, rule_test_category, rule_xml_hash


def _rule(n):
    return f'<structureObjectRule id="R{n}"><objectPath allowedObjectFlag="0">//x{n}</objectPath><objectUse>u</objectUse></structureObjectRule>'


# (identifier suffix, status, last_test_result, hash: "same" | "other" | None, expected category)
CASES = [
    ("passed", "approved", "passed", "same", "passed"),
    ("passed-edited", "approved", "passed", "same", "passed"),
    ("review", "approved", "review", "same", "review"),
    ("failed", "approved", "failed", "same", "failed"),
    ("inconclusive", "approved", "inconclusive", "same", "inconclusive"),
    ("not-executable", "approved", "not_executable", "same", "not_executable"),
    ("never", "approved", None, None, "not_tested"),
    ("no-hash", "approved", "passed", None, "not_tested"),
    ("unknown-result", "approved", "weird", "same", "not_tested"),
    ("outdated-passed", "approved", "passed", "other", "outdated"),
    ("outdated-failed", "approved", "failed", "other", "outdated"),
    ("draft-passed", "pending_review", "passed", "same", None),  # not verified: never counted
]


@pytest.fixture
async def project_with_rules():
    async with async_session_factory() as session:
        project = Project(name=f"Breakdown {uuid.uuid4()}", standard="S1000D 4.2")
        admin = User(email=f"bd-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="BD", global_role="admin")
        session.add_all([project, admin])
        await session.flush()
        ids = {}
        for n, (suffix, status, result, hash_kind, _expected) in enumerate(CASES):
            brdp = BRDP(project_id=project.id, identifier=f"BRDP-BD-{suffix}")
            session.add(brdp)
            await session.flush()
            rule = _rule(n)
            tested_hash = {"same": rule_xml_hash(rule), "other": rule_xml_hash(rule + " "), None: None}[hash_kind]
            session.add(
                RuleApproval(
                    brdp_id=brdp.id,
                    format="BREX-4.2",
                    rule_xml=rule,
                    status=status,
                    last_test_result=result,
                    last_test_rule_hash=tested_hash,
                    last_test_at=datetime.now(timezone.utc) if result else None,
                    last_test_edited_examples=[{"label": "x", "xml": "<x/>"}] if suffix == "passed-edited" else None,
                )
            )
            ids[suffix] = brdp.id
        # A verified rule under ANOTHER format (stale): never counted.
        stale = BRDP(project_id=project.id, identifier="BRDP-BD-stale")
        session.add(stale)
        await session.flush()
        session.add(RuleApproval(brdp_id=stale.id, format="BREX-4.1", rule_xml=_rule(99), status="approved"))
        await session.commit()
    yield project, admin, ids
    async with async_session_factory() as session:
        await session.delete(await session.get(Project, project.id))
        await session.delete(await session.get(User, admin.id))
        await session.commit()


def _headers(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def test_the_category_function():
    h = rule_xml_hash("<r/>")
    assert rule_test_category(None, None, h) == "not_tested"
    assert rule_test_category("passed", None, h) == "not_tested"
    assert rule_test_category("passed", "", h) == "not_tested"
    assert rule_test_category("other", h, h) == "not_tested"
    assert rule_test_category("failed", rule_xml_hash("<s/>"), h) == "outdated"
    for result in ("passed", "review", "failed", "inconclusive", "not_executable"):
        assert rule_test_category(result, h, h) == result


async def test_counts_add_up_and_match_each_indicator(client, project_with_rules):
    project, admin, ids = project_with_rules
    headers = _headers(admin)
    stats = (await client.get(f"/api/projects/{project.id}/brdps/stats", headers=headers)).json()
    verified = stats["rule_status_counts"]["verified"]
    breakdown = stats["verified_test_counts"]
    assert verified == 11
    assert sum(breakdown.values()) == verified
    assert set(breakdown) == set(TEST_CATEGORIES)
    expected = {c: 0 for c in TEST_CATEGORIES}
    for _suffix, status, _r, _h, category in CASES:
        if status == "approved":
            expected[category] += 1
    assert breakdown == expected
    # Each rule's indicator (GET approval) shows the category it is counted in.
    for suffix, status, _r, _h, category in CASES:
        approval = (
            await client.get(f"/api/projects/{project.id}/brdps/{ids[suffix]}/approvals/BREX-4.2", headers=headers)
        ).json()
        if status == "approved":
            assert approval["test_category"] == category, suffix


async def test_category_filter_lists_exactly_those_rules(client, project_with_rules):
    project, admin, ids = project_with_rules
    headers = _headers(admin)
    breakdown = (await client.get(f"/api/projects/{project.id}/brdps/stats", headers=headers)).json()["verified_test_counts"]
    for category in TEST_CATEGORIES:
        rows = (await client.get(f"/api/projects/{project.id}/brdps?test_category={category}", headers=headers)).json()
        assert len(rows) == breakdown[category], category
    rows = (await client.get(f"/api/projects/{project.id}/brdps?test_category=outdated", headers=headers)).json()
    assert {r["identifier"] for r in rows} == {"BRDP-BD-outdated-passed", "BRDP-BD-outdated-failed"}
    # Coexists with the other filters (AND).
    rows = (
        await client.get(f"/api/projects/{project.id}/brdps?test_category=passed&rule_status=draft", headers=headers)
    ).json()
    assert rows == []
    assert (await client.get(f"/api/projects/{project.id}/brdps?test_category=bogus", headers=headers)).status_code == 422


async def test_verified_zero_and_no_rule_format(client):
    async with async_session_factory() as session:
        empty = Project(name=f"Breakdown empty {uuid.uuid4()}", standard="S1000D 4.2")
        no_format = Project(name=f"Breakdown 5.0 {uuid.uuid4()}", standard="S1000D 5.0")
        admin = User(email=f"bd0-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="BD0", global_role="admin")
        session.add_all([empty, no_format, admin])
        await session.commit()
    try:
        stats = (await client.get(f"/api/projects/{empty.id}/brdps/stats", headers=_headers(admin))).json()
        assert stats["rule_status_counts"]["verified"] == 0
        assert stats["verified_test_counts"] == {c: 0 for c in TEST_CATEGORIES}
        stats = (await client.get(f"/api/projects/{no_format.id}/brdps/stats", headers=_headers(admin))).json()
        assert stats["verified_test_counts"] is None
        rows = (await client.get(f"/api/projects/{no_format.id}/brdps?test_category=passed", headers=_headers(admin))).json()
        assert rows == []
    finally:
        async with async_session_factory() as session:
            for obj in (await session.get(Project, empty.id), await session.get(Project, no_format.id), await session.get(User, admin.id)):
                await session.delete(obj)
            await session.commit()
