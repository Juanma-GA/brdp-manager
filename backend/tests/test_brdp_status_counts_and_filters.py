"""Functional correctness of:
  - GET /api/projects's new proposal_status_counts/rule_status_counts
    columns (Part 1 of the encargo), computed in a fixed number of SQL
    queries regardless of how many projects are in the response (never
    one query per project -- the same N+1 class of bug already fixed
    twice this session, for Reset Data and Import).
  - GET /api/projects/{id}/brdps/stats (Part 2), the same counts scoped
    to a single project, for BRDP Records' header summary.
  - GET /api/projects/{id}/brdps's new proposal_status/rule_status query
    params (Part 3), applied in SQL.

Real Postgres throughout -- validating a BRDP no longer calls Mistral at
all (on-demand embeddings, docs request), so there's nothing left to mock
here.
"""
import uuid

import pytest
from sqlalchemy import event

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory, engine
from app.main import app
from app.models import BRDP, Project, RuleApproval, User


class QueryCounter:
    """Counts real SQL statements sent to Postgres during the `with` block
    -- the only honest way to confirm GET /api/projects stays O(1)
    regardless of how many projects it serializes, rather than eyeballing
    the query code.
    """

    def __init__(self):
        self.count = 0

    def _on_execute(self, conn, cursor, statement, parameters, context, executemany):
        self.count += 1

    def __enter__(self):
        event.listen(engine.sync_engine, "before_cursor_execute", self._on_execute)
        return self

    def __exit__(self, *exc):
        event.remove(engine.sync_engine, "before_cursor_execute", self._on_execute)


async def _make_user(global_role: str = "admin") -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"stats-test-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Stats Test User",
            global_role=global_role,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _make_project(standard: str = "S1000D 4.2") -> Project:
    async with async_session_factory() as session:
        project = Project(name=f"Stats Test Project {uuid.uuid4()}", standard=standard)
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _cleanup_project(project_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        db_project = await session.get(Project, project_id)
        if db_project is not None:
            await session.delete(db_project)
            await session.commit()


async def _cleanup_user(user: User) -> None:
    async with async_session_factory() as session:
        db_user = await session.get(User, user.id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def _seed_mixed_brdps(project_id: uuid.UUID, rule_format: str) -> dict:
    """3 Pending, 4 Validated, 2 Refused (9 total, active). Rule Status,
    independently: 2 approved (Verified), 3 pending_review (Draft), the
    rest get no rule_approvals row at all (To Do) -- deliberately NOT
    aligned with Proposal Status groupings, so a combined filter test can
    tell a real AND from an accidental OR.
    Returns the expected counts dict for assertions.
    """
    async with async_session_factory() as session:
        brdps = []
        for i, validation in enumerate(["Pending"] * 3 + ["Validated"] * 4 + ["Refused"] * 2):
            brdp = BRDP(
                project_id=project_id,
                identifier=f"BRDP-STATS-{i:03d}",
                title=f"Title {i}",
                definition=f"Definition {i}",
                proposal=f"Proposal {i}",
                validation=validation,
            )
            session.add(brdp)
            brdps.append(brdp)
        await session.flush()

        # Verified (approved): brdps[0], brdps[1] (both Pending)
        session.add(RuleApproval(brdp_id=brdps[0].id, format=rule_format, rule_xml="<x/>", status="approved"))
        session.add(RuleApproval(brdp_id=brdps[1].id, format=rule_format, rule_xml="<x/>", status="approved"))
        # Draft (pending_review): brdps[3], brdps[4], brdps[5] (Validated)
        session.add(RuleApproval(brdp_id=brdps[3].id, format=rule_format, rule_xml="<x/>", status="pending_review"))
        session.add(RuleApproval(brdp_id=brdps[4].id, format=rule_format, rule_xml="<x/>", status="pending_review"))
        session.add(RuleApproval(brdp_id=brdps[5].id, format=rule_format, rule_xml="<x/>", status="pending_review"))
        # A stale approval under a DIFFERENT format -- must never be
        # counted as this project's real Rule Status.
        session.add(RuleApproval(brdp_id=brdps[6].id, format="SCH-DITA", rule_xml="<x/>", status="approved"))
        await session.commit()

    return {
        "proposal_status_counts": {"pending": 3, "validated": 4, "refused": 2},
        # to_do = 9 total - 2 verified - 3 draft = 4 (brdps[2], [6], [7], [8] --
        # [6]'s stale other-format row doesn't count as this format's approval).
        "rule_status_counts": {"to_do": 4, "draft": 3, "verified": 2},
    }


async def test_projects_list_includes_correct_status_counts(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        expected = await _seed_mixed_brdps(project.id, "BREX-4.2")
        response = await client.get("/api/projects", headers=_headers(admin))
        assert response.status_code == 200
        row = next(p for p in response.json() if p["id"] == str(project.id))
        assert row["proposal_status_counts"] == expected["proposal_status_counts"]
        assert row["rule_status_counts"] == expected["rule_status_counts"]
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_brand_new_project_has_all_zero_counts_not_missing_or_nan(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        response = await client.get("/api/projects", headers=_headers(admin))
        row = next(p for p in response.json() if p["id"] == str(project.id))
        assert row["proposal_status_counts"] == {"pending": 0, "validated": 0, "refused": 0}
        assert row["rule_status_counts"] == {"to_do": 0, "draft": 0, "verified": 0}
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_standard_with_no_rule_format_counts_everything_as_to_do(client):
    """S1000D 5.0/6.0 have no STANDARD_TO_RULE_FORMAT entry -- confirms
    the code path that skips the rule_approvals join entirely still
    reports a correct (not missing/crashed) to_do count.
    """
    admin = await _make_user()
    project = await _make_project(standard="S1000D 5.0")
    try:
        async with async_session_factory() as session:
            session.add(BRDP(project_id=project.id, identifier="BRDP-NOFMT-001", validation="Validated"))
            await session.commit()
        response = await client.get("/api/projects", headers=_headers(admin))
        row = next(p for p in response.json() if p["id"] == str(project.id))
        assert row["rule_status_counts"] == {"to_do": 1, "draft": 0, "verified": 0}
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_projects_list_query_count_is_independent_of_project_count():
    """The real point: fetch GET /api/projects with 1 extra project vs.
    with several more, and confirm the SQL statement count doesn't grow --
    proves compute_status_counts() is 2 queries total, not 2 per project.
    """
    from httpx import ASGITransport, AsyncClient

    admin = await _make_user()
    project_a = await _make_project()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            with QueryCounter() as qc_one:
                resp1 = await ac.get("/api/projects", headers=_headers(admin))
            assert resp1.status_code == 200
            count_with_one_extra_project = qc_one.count

            more_projects = [await _make_project() for _ in range(5)]
            try:
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac2:
                    with QueryCounter() as qc_many:
                        resp2 = await ac2.get("/api/projects", headers=_headers(admin))
                assert resp2.status_code == 200
                count_with_six_extra_projects = qc_many.count
                assert count_with_six_extra_projects == count_with_one_extra_project, (
                    f"query count grew with more projects "
                    f"({count_with_one_extra_project} -> {count_with_six_extra_projects}) -- "
                    "compute_status_counts() is no longer O(1)"
                )
            finally:
                for p in more_projects:
                    await _cleanup_project(p.id)
    finally:
        await _cleanup_project(project_a.id)
        await _cleanup_user(admin)
        await engine.dispose()


async def test_brdp_stats_endpoint_matches_projects_list_counts(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        expected = await _seed_mixed_brdps(project.id, "BREX-4.2")
        response = await client.get(f"/api/projects/{project.id}/brdps/stats", headers=_headers(admin))
        assert response.status_code == 200
        body = response.json()
        assert body["proposal_status_counts"] == expected["proposal_status_counts"]
        assert body["rule_status_counts"] == expected["rule_status_counts"]
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_brdp_stats_for_empty_project_is_all_zero(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        response = await client.get(f"/api/projects/{project.id}/brdps/stats", headers=_headers(admin))
        assert response.status_code == 200
        body = response.json()
        assert body["proposal_status_counts"] == {"pending": 0, "validated": 0, "refused": 0}
        assert body["rule_status_counts"] == {"to_do": 0, "draft": 0, "verified": 0}
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_list_brdps_filters_by_proposal_status_in_sql(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        await _seed_mixed_brdps(project.id, "BREX-4.2")
        response = await client.get(
            f"/api/projects/{project.id}/brdps", params={"proposal_status": "Validated"}, headers=_headers(admin)
        )
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 4
        assert all(r["validation"] == "Validated" for r in rows)
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_list_brdps_filters_by_rule_status_verified_in_sql(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        await _seed_mixed_brdps(project.id, "BREX-4.2")
        response = await client.get(
            f"/api/projects/{project.id}/brdps", params={"rule_status": "verified"}, headers=_headers(admin)
        )
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 2  # brdps[0], brdps[1] approved above
        assert {r["identifier"] for r in rows} == {"BRDP-STATS-000", "BRDP-STATS-001"}
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_list_brdps_filters_by_rule_status_todo_excludes_draft_and_verified(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        await _seed_mixed_brdps(project.id, "BREX-4.2")
        response = await client.get(
            f"/api/projects/{project.id}/brdps", params={"rule_status": "todo"}, headers=_headers(admin)
        )
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 4  # brdps[2], [6] (stale other-format row), [7], [8]
        assert all(r["identifier"] not in {"BRDP-STATS-000", "BRDP-STATS-001"} for r in rows)
        assert all(r["identifier"] not in {"BRDP-STATS-003", "BRDP-STATS-004", "BRDP-STATS-005"} for r in rows)
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_list_brdps_combines_proposal_and_rule_status_filters_with_and(client):
    """The real point of this test: Validated+Draft together must return
    ONLY the intersection (brdps[3], [4], [5] -- all three are Validated
    AND Draft; brdps[6] is also Validated but has no draft approval of
    its own format, so it's correctly excluded) -- neither filter alone
    gives that exact set, so a plain "last one wins" bug would fail this.
    """
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        await _seed_mixed_brdps(project.id, "BREX-4.2")
        response = await client.get(
            f"/api/projects/{project.id}/brdps",
            params={"proposal_status": "Validated", "rule_status": "draft"},
            headers=_headers(admin),
        )
        assert response.status_code == 200
        rows = response.json()
        assert {r["identifier"] for r in rows} == {"BRDP-STATS-003", "BRDP-STATS-004", "BRDP-STATS-005"}
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_list_brdps_no_rule_format_standard_returns_empty_for_draft_or_verified(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 5.0")
    try:
        async with async_session_factory() as session:
            session.add(BRDP(project_id=project.id, identifier="BRDP-NOFMT-001", validation="Validated"))
            await session.commit()
        response = await client.get(
            f"/api/projects/{project.id}/brdps", params={"rule_status": "verified"}, headers=_headers(admin)
        )
        assert response.status_code == 200
        assert response.json() == []

        response_todo = await client.get(
            f"/api/projects/{project.id}/brdps", params={"rule_status": "todo"}, headers=_headers(admin)
        )
        assert len(response_todo.json()) == 1
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_list_brdps_rejects_unknown_proposal_status_value(client):
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps", params={"proposal_status": "Bogus"}, headers=_headers(admin)
        )
        assert response.status_code == 422
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)


async def test_list_brdps_unfiltered_still_returns_everything_unchanged(client):
    """No filter params at all -- every other caller of this endpoint
    (Export to Excel, GeneratePage's dataset fetch, Delete-project's BRDP
    count) must see the exact same unfiltered list as before this round.
    """
    admin = await _make_user()
    project = await _make_project(standard="S1000D 4.2")
    try:
        await _seed_mixed_brdps(project.id, "BREX-4.2")
        response = await client.get(f"/api/projects/{project.id}/brdps", headers=_headers(admin))
        assert response.status_code == 200
        assert len(response.json()) == 9
    finally:
        await _cleanup_project(project.id)
        await _cleanup_user(admin)
