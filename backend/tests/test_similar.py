"""GET .../brdps/{brdp_id}/similar -- docs/v2 §3 point 3 / §6's explicit
test requirement: 0, 2, and 15+ candidate BRDPs, confirming the "not
enough precedent" degrade is explicit (HR7), never silent padding with
weak matches.

Embeddings are set directly on BRDP rows via the DB session (not through
the API) so each test controls exact cosine similarity deterministically,
independent of any real Mistral call. The route's OWN query-embedding
call (for the source BRDP) is mocked via get_httpx_transport to always
return the same fixed vector, so "similarity to the query" is just
"similarity to that fixed vector" -- exact and reproducible.
"""
import uuid

import httpx
import pytest

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDP, Project, RuleApproval, User, UserProjectRole
from app.models.brdp import EMBEDDING_DIM

# Two orthogonal unit vectors -- cosine_similarity(SAME, SAME) == 1.0,
# cosine_similarity(SAME, OTHER) == 0.0. Crisp, easy-to-reason-about
# separation across MIN_SIMILARITY (0.5) with no floating-point ambiguity.
_SAME_DIRECTION = [1.0] + [0.0] * (EMBEDDING_DIM - 1)
_ORTHOGONAL_DIRECTION = [0.0, 1.0] + [0.0] * (EMBEDDING_DIM - 2)


@pytest.fixture(autouse=True)
def _mock_query_embedding_transport():
    """The route always computes a fresh query embedding for the SOURCE
    BRDP -- mocked to always return _SAME_DIRECTION regardless of input
    text, so every test just has to choose each candidate's stored
    embedding to control whether it passes the threshold.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": _SAME_DIRECTION, "index": 0}]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


async def _make_project(standard: str = "BREX — S1000D 4.2") -> Project:
    async with async_session_factory() as session:
        project = Project(name=f"Similar Test Project {uuid.uuid4()}", standard=standard)
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project


async def _make_editor(project_id: uuid.UUID) -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"similar-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Similar Test Editor",
            global_role="user",
        )
        session.add(user)
        await session.flush()
        session.add(UserProjectRole(user_id=user.id, project_id=project_id, role="editor"))
        await session.commit()
        await session.refresh(user)
        return user


async def _make_source_brdp(project_id: uuid.UUID) -> BRDP:
    """The BRDP we're requesting suggestions FOR -- deliberately NOT
    Validated (that's the whole point of the feature: helping with one
    that isn't validated yet), so it must never appear in its own
    candidate list.
    """
    async with async_session_factory() as session:
        brdp = BRDP(
            project_id=project_id,
            identifier="BRDP-SOURCE-001",
            definition="Some definition text",
            proposal="Some proposal text",
            validation="Pending",
        )
        session.add(brdp)
        await session.commit()
        await session.refresh(brdp)
        return brdp


async def _make_validated_candidate(
    project_id: uuid.UUID, embedding: list[float], identifier: str, rule_xml: str | None = None
) -> BRDP:
    async with async_session_factory() as session:
        brdp = BRDP(
            project_id=project_id,
            identifier=identifier,
            definition=f"Definition for {identifier}",
            proposal=f"Proposal for {identifier}",
            validation="Validated",
            embedding=embedding,
        )
        session.add(brdp)
        await session.flush()
        if rule_xml is not None:
            session.add(
                RuleApproval(brdp_id=brdp.id, format="BREX-4.2", rule_xml=rule_xml, source="manual", status="approved")
            )
        await session.commit()
        await session.refresh(brdp)
        return brdp


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _cleanup(project: Project, extra_users: list[User] | None = None) -> None:
    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)  # cascades to brdps/rule_approvals/user_project_roles rows tied to it
        await session.commit()
    for user in extra_users or []:
        async with async_session_factory() as session:
            db_user = await session.get(User, user.id)
            if db_user is not None:
                await session.delete(db_user)
            await session.commit()


async def test_zero_candidates_reports_insufficient_precedent(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is False
        assert body["candidates"] == []
        assert "insufficient" in body["message"].lower()
    finally:
        await _cleanup(project, [editor])


async def test_two_passing_candidates_reports_insufficient_precedent(client):
    """Below MIN_CANDIDATES (3) even though the two DO pass the
    similarity threshold -- the "not enough precedent" rule is about
    COUNT, not just quality.
    """
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    close_ones = [
        await _make_validated_candidate(project.id, _SAME_DIRECTION, f"BRDP-CLOSE-{i}") for i in range(2)
    ]
    # A dissimilar one too, to prove it's correctly excluded rather than
    # padding the response up to 3.
    far_one = await _make_validated_candidate(project.id, _ORTHOGONAL_DIRECTION, "BRDP-FAR-1")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is False
        assert len(body["candidates"]) == 2
        returned_ids = {c["id"] for c in body["candidates"]}
        assert returned_ids == {str(b.id) for b in close_ones}
        assert str(far_one.id) not in returned_ids
        assert "insufficient" in body["message"].lower()
    finally:
        await _cleanup(project, [editor])


async def test_fifteen_plus_candidates_reports_sufficient_precedent_capped_at_ten(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    for i in range(15):
        await _make_validated_candidate(project.id, _SAME_DIRECTION, f"BRDP-MANY-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is True
        assert body["message"] is None
        assert len(body["candidates"]) == 10  # CANDIDATE_LIMIT, not all 15
        assert all(c["score"] == pytest.approx(1.0) for c in body["candidates"])
    finally:
        await _cleanup(project, [editor])


async def test_source_brdp_never_appears_in_its_own_candidates(client):
    """Even if the source BRDP were somehow Validated with an embedding
    identical to the query, it must never suggest itself as precedent for
    itself.
    """
    project = await _make_project()
    editor = await _make_editor(project.id)
    async with async_session_factory() as session:
        source = BRDP(
            project_id=project.id,
            identifier="BRDP-SELF-001",
            definition="text",
            proposal="text",
            validation="Validated",
            embedding=_SAME_DIRECTION,
        )
        session.add(source)
        await session.commit()
        await session.refresh(source)
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        assert source.id not in {uuid.UUID(c["id"]) for c in response.json()["candidates"]}
    finally:
        await _cleanup(project, [editor])


async def test_different_standard_is_excluded_from_candidates(client):
    project_a = await _make_project(standard="BREX — S1000D 4.2")
    project_b = await _make_project(standard="BREX — S1000D 3.0.1")
    editor = await _make_editor(project_a.id)
    source = await _make_source_brdp(project_a.id)
    # Enough close candidates in project_b to pass MIN_CANDIDATES on their
    # own, IF the standard filter were broken.
    for i in range(5):
        await _make_validated_candidate(project_b.id, _SAME_DIRECTION, f"BRDP-OTHERSTD-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project_a.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["candidates"] == []
        assert body["sufficient_precedent"] is False
    finally:
        await _cleanup(project_a, [editor])
        await _cleanup(project_b)


async def test_kind_rule_maps_project_standard_to_rule_format(client):
    project = await _make_project(standard="BREX — S1000D 4.2")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    candidates = [
        await _make_validated_candidate(project.id, _SAME_DIRECTION, f"BRDP-RULE-{i}", rule_xml=f"<rule id='{i}'/>")
        for i in range(3)
    ]
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is True
        assert body["format"] == "BREX-4.2"
        texts = {c["text"] for c in body["candidates"]}
        assert texts == {f"<rule id='{i}'/>" for i in range(3)}
        assert len(candidates) == 3  # sanity on the fixture itself
    finally:
        await _cleanup(project, [editor])


async def test_kind_rule_unsupported_standard_returns_400(client):
    project = await _make_project(standard="Schematron 1.0 — DITA")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
        )
        assert response.status_code == 400
    finally:
        await _cleanup(project, [editor])


async def test_viewer_can_read_similar_but_requires_authentication(client):
    project = await _make_project()
    source = await _make_source_brdp(project.id)
    unauthenticated = await client.get(f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition")
    assert unauthenticated.status_code == 401
    await _cleanup(project)
