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

Suggest Definition corpus round (docs request): MIN_CANDIDATES/
sufficient_precedent/candidate-cap-10 semantics below no longer apply to
kind='definition' at all (its own corpus/threshold logic lives in
_get_definition_similar, tested separately further down this file) --
the generic tests that exercise those semantics (standard filtering,
self-exclusion, the pending-embedding exclusion count, the insufficient-
precedent degrade) were switched to kind='proposal' here, which keeps
the old behavior byte-for-byte. Only tests that were never actually
about that gating (self-exclusion, auth) were left on kind='definition'.
"""
import uuid

import httpx
import pytest

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDP, BRDPCatalog, Project, RuleApproval, User, UserProjectRole
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


async def _make_project(standard: str = "S1000D 4.2") -> Project:
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


async def _make_source_brdp_with_identifier(project_id: uuid.UUID, identifier: str) -> BRDP:
    """Same as _make_source_brdp, but with a caller-chosen identifier --
    needed to test the catalog-BRDP rejection (docs request, Suggest
    Definition corpus round), which is keyed on identifier.
    """
    async with async_session_factory() as session:
        brdp = BRDP(
            project_id=project_id,
            identifier=identifier,
            definition="Some definition text",
            proposal="Some proposal text",
            validation="Pending",
        )
        session.add(brdp)
        await session.commit()
        await session.refresh(brdp)
        return brdp


async def _make_catalog_entry(
    standard: str, embedding: list[float] | None, identifier: str, definition: str | None = None
) -> BRDPCatalog:
    async with async_session_factory() as session:
        entry = BRDPCatalog(
            standard=standard,
            identifier=identifier,
            title=f"Catalog title for {identifier}",
            definition=definition if definition is not None else f"Catalog definition for {identifier}",
            embedding=embedding,
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
        return entry


async def _cleanup_catalog(entries: list[BRDPCatalog]) -> None:
    async with async_session_factory() as session:
        for entry in entries:
            db_entry = await session.get(BRDPCatalog, entry.id)
            if db_entry is not None:
                await session.delete(db_entry)
        await session.commit()


async def _make_validated_candidate(
    project_id: uuid.UUID,
    embedding: list[float],
    identifier: str,
    rule_xml: str | None = None,
    rule_format: str = "BREX-4.2",
    definition: str | None = None,
) -> BRDP:
    async with async_session_factory() as session:
        brdp = BRDP(
            project_id=project_id,
            identifier=identifier,
            definition=definition if definition is not None else f"Definition for {identifier}",
            proposal=f"Proposal for {identifier}",
            validation="Validated",
            embedding=embedding,
        )
        session.add(brdp)
        await session.flush()
        if rule_xml is not None:
            session.add(
                RuleApproval(brdp_id=brdp.id, format=rule_format, rule_xml=rule_xml, source="manual", status="approved")
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
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
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
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
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
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
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
    project_a = await _make_project(standard="S1000D 4.2")
    project_b = await _make_project(standard="S1000D 3.0.1")
    editor = await _make_editor(project_a.id)
    source = await _make_source_brdp(project_a.id)
    # Enough close candidates in project_b to pass MIN_CANDIDATES on their
    # own, IF the standard filter were broken.
    for i in range(5):
        await _make_validated_candidate(project_b.id, _SAME_DIRECTION, f"BRDP-OTHERSTD-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project_a.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["candidates"] == []
        assert body["sufficient_precedent"] is False
    finally:
        await _cleanup(project_a, [editor])
        await _cleanup(project_b)


async def test_kind_rule_maps_project_standard_to_rule_format(client):
    project = await _make_project(standard="S1000D 4.2")
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


async def test_kind_rule_maps_dita_standard_to_sch_dita_format(client):
    """DITA 1.3 has no BREX equivalent, but it DOES have its own native
    Schematron rule-kind (generateSchematronDITA.js's deterministic
    assembler, approved rows frozen under format 'SCH-DITA') -- confirms
    Suggest Rule now returns real precedent for a DITA project instead of
    the previous hard 400 (see test_kind_rule_unsupported_standard_returns_400
    below, which used to use DITA 1.3 as ITS example of an unsupported
    standard before this format was added). Uses "DITA 1.3 Xpath2.0" (the
    single "DITA 1.3" standard split in two by migration
    0013_split_dita_xpath_standards.py) -- both flavors map to the same
    SCH-DITA format either way, so which one this test uses is arbitrary.
    """
    project = await _make_project(standard="DITA 1.3 Xpath2.0")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    candidates = [
        await _make_validated_candidate(
            project.id, _SAME_DIRECTION, f"BRDP-DITARULE-{i}", rule_xml=f"<sch:pattern id='{i}'/>", rule_format="SCH-DITA"
        )
        for i in range(3)
    ]
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is True
        assert body["format"] == "SCH-DITA"
        texts = {c["text"] for c in body["candidates"]}
        assert texts == {f"<sch:pattern id='{i}'/>" for i in range(3)}
        assert len(candidates) == 3  # sanity on the fixture itself
    finally:
        await _cleanup(project, [editor])


async def test_kind_rule_unsupported_standard_returns_400(client):
    """S1000D 5.0/6.0 are real dropdown values (docs/v2 §2) but have no
    generation engine and no rule_approvals format at all -- confirmed
    genuinely unsupported, unlike DITA 1.3 (see the test above), which
    this test used before DITA got its own SCH-DITA format.
    """
    project = await _make_project(standard="S1000D 5.0")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
        )
        assert response.status_code == 400
    finally:
        await _cleanup(project, [editor])


async def test_excluded_pending_other_projects_counts_other_projects_without_embedding(client):
    """HR7 -- on-demand embeddings (docs request): a Validated BRDP in
    ANOTHER project of the same standard that hasn't been through ITS OWN
    project's embedding job yet (embedding IS NULL) is invisible to this
    search; the response must say how many were excluded for exactly that
    reason, never silently return fewer candidates with no explanation.
    Scoped to OTHER projects only -- a pending BRDP in the CURRENT project
    is not counted here (it's blocked from ever reaching Suggest at all by
    the frontend's own disabled-while-pending rule, so counting it would
    double up with that).
    """
    project_a = await _make_project(standard="S1000D 4.2")
    project_b = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project_a.id)
    source = await _make_source_brdp(project_a.id)
    # 3 real candidates in project_a itself (sufficient precedent) plus one
    # more Validated-but-pending BRDP in project_a -- must NOT be counted,
    # since it's the current project, not "another" one.
    for i in range(3):
        await _make_validated_candidate(project_a.id, _SAME_DIRECTION, f"BRDP-OWN-{i}")
    async with async_session_factory() as session:
        session.add(
            BRDP(
                project_id=project_a.id,
                identifier="BRDP-OWNPROJ-PENDING",
                definition="text",
                proposal="text",
                validation="Validated",
            )
        )
        await session.commit()
    # In project_b: one Validated BRDP WITH an embedding (a real candidate
    # elsewhere, never pending) and two Validated BRDPs with NO embedding
    # yet (pending -- excluded from this search, and counted).
    await _make_validated_candidate(project_b.id, _SAME_DIRECTION, "BRDP-OTHERPROJ-EMBEDDED")
    async with async_session_factory() as session:
        for i in range(2):
            session.add(
                BRDP(
                    project_id=project_b.id,
                    identifier=f"BRDP-OTHERPROJ-PENDING-{i}",
                    definition="text",
                    proposal="text",
                    validation="Validated",
                )
            )
        await session.commit()
    try:
        response = await client.get(
            f"/api/projects/{project_a.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is True
        assert body["excluded_pending_other_projects"] == 2
    finally:
        await _cleanup(project_a, [editor])
        await _cleanup(project_b)


async def test_excluded_pending_other_projects_is_zero_when_nothing_pending(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    for i in range(3):
        await _make_validated_candidate(project.id, _SAME_DIRECTION, f"BRDP-NOPEND-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        assert response.json()["excluded_pending_other_projects"] == 0
    finally:
        await _cleanup(project, [editor])


async def test_viewer_can_read_similar_but_requires_authentication(client):
    project = await _make_project()
    source = await _make_source_brdp(project.id)
    unauthenticated = await client.get(f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition")
    assert unauthenticated.status_code == 401
    await _cleanup(project)


# ---- kind='definition' corpus (docs request, Suggest Definition round) ----
#
# Its own MIN_CANDIDATES-free, catalog-including corpus logic
# (_get_definition_similar), tested independently of the generic
# proposal/rule tests above (which were switched to kind='proposal' and
# keep asserting the OLD, still-current behavior for those two kinds).


async def test_definition_never_reports_insufficient_precedent_even_with_zero_candidates(client):
    """docs request: MIN_CANDIDATES is gone for kind='definition' -- the
    LLM is always called, with 0, 1, or more references. sufficient_
    precedent stays True and message stays None even with a totally empty
    corpus (no Validated BRDPs anywhere, no catalog for this standard).

    Uses 'S1000D 4.1', not the default 'S1000D 4.2' -- this dev sandbox
    has real, intentionally-persistent catalog fixtures seeded under
    'S1000D 4.2' (seed_ask_compare_catalog.py/seed_suggest_definition_
    catalog.py, documented in CLAUDE.md as reusable), which would make
    "zero candidates" false in this specific environment.
    """
    project = await _make_project(standard="S1000D 4.1")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is True
        assert body["message"] is None
        assert body["candidates"] == []
        assert body["style_references"] == []
    finally:
        await _cleanup(project, [editor])


async def test_definition_candidates_include_catalog_and_other_projects_records_with_source_labels(client):
    """docs request point 2: candidates = Validated BRDPs of the same
    standard from ALL projects (excluding the source's own) + catalog
    entries of that standard -- each labeled by origin.

    Uses 'S1000D 4.1', not 'S1000D 4.2' -- this dev sandbox has real,
    intentionally-persistent catalog fixtures seeded under 'S1000D 4.2'
    (see the note on the zero-candidates test above), which would leak
    into `by_identifier` here and break the exact-set assertion below.
    """
    project_a = await _make_project(standard="S1000D 4.1")
    project_b = await _make_project(standard="S1000D 4.1")
    editor = await _make_editor(project_a.id)
    source = await _make_source_brdp(project_a.id)
    other_project_candidate = await _make_validated_candidate(project_b.id, _SAME_DIRECTION, "BRDP-OTHERPROJ-1")
    catalog_entry = await _make_catalog_entry("S1000D 4.1", _SAME_DIRECTION, "BRDP-CAT-1")
    try:
        response = await client.get(
            f"/api/projects/{project_a.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        by_identifier = {c["identifier"]: c for c in body["candidates"]}
        assert set(by_identifier) == {"BRDP-OTHERPROJ-1", "BRDP-CAT-1"}
        assert by_identifier["BRDP-OTHERPROJ-1"]["source"] == f"Records: {project_b.name}"
        assert by_identifier["BRDP-CAT-1"]["source"] == "Catalog"
        assert by_identifier["BRDP-CAT-1"]["title"] == catalog_entry.title
        assert by_identifier["BRDP-CAT-1"]["text"] == catalog_entry.definition
        assert by_identifier["BRDP-CAT-1"]["definition"] == catalog_entry.definition
        assert by_identifier["BRDP-OTHERPROJ-1"]["definition"] == other_project_candidate.definition
        # <3 similar -> style references would normally kick in, but the
        # whole corpus is these same 2 entries -- nothing left to add.
        assert body["style_references"] == []
    finally:
        await _cleanup(project_a, [editor])
        await _cleanup(project_b)
        await _cleanup_catalog([catalog_entry])


async def test_definition_similar_capped_at_five(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    for i in range(7):
        await _make_validated_candidate(project.id, _SAME_DIRECTION, f"BRDP-MANY-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["candidates"]) == 5  # DEFINITION_SIMILAR_LIMIT, not all 7
        assert all(c["score"] == pytest.approx(1.0) for c in body["candidates"])
        assert body["style_references"] == []  # 5 similar -- never <3, so none added
    finally:
        await _cleanup(project, [editor])


async def test_definition_style_references_added_only_below_three_similar(client):
    """docs request point 2: style references (the 3 lowest-similarity
    candidates in the whole corpus) are added ONLY when fewer than 3
    passed the similarity threshold -- never repeating one already in
    `candidates`.
    """
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    close_one = await _make_validated_candidate(project.id, _SAME_DIRECTION, "BRDP-CLOSE-1")
    far_ones = [
        await _make_validated_candidate(project.id, _ORTHOGONAL_DIRECTION, f"BRDP-FAR-{i}") for i in range(4)
    ]
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert [c["identifier"] for c in body["candidates"]] == ["BRDP-CLOSE-1"]
        assert body["candidates"][0]["definition"] == close_one.definition
        assert len(body["style_references"]) == 3  # DEFINITION_STYLE_REFERENCE_LIMIT, out of 4 available
        style_ids = {c["id"] for c in body["style_references"]}  # JSON -- UUIDs serialize as strings
        assert str(close_one.id) not in style_ids  # never repeats one already in `candidates`
        assert style_ids <= {str(b.id) for b in far_ones}
        # docs request (readable references round): `definition` travels
        # in the response for style_references too, not just candidates.
        far_by_id = {str(b.id): b for b in far_ones}
        for c in body["style_references"]:
            assert c["definition"] == far_by_id[c["id"]].definition
    finally:
        await _cleanup(project, [editor])


async def test_definition_style_references_empty_when_three_or_more_similar(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    for i in range(3):
        await _make_validated_candidate(project.id, _SAME_DIRECTION, f"BRDP-CLOSE-{i}")
    # Dissimilar candidates present too -- must NOT be added as style
    # references just because they exist; only the <3-similar trigger
    # matters, and there are exactly 3 similar here.
    for i in range(2):
        await _make_validated_candidate(project.id, _ORTHOGONAL_DIRECTION, f"BRDP-FAR-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["candidates"]) == 3
        assert body["style_references"] == []
    finally:
        await _cleanup(project, [editor])


async def test_definition_style_references_never_duplicate_similar_in_tiny_corpus(client):
    """Edge case: the whole corpus has fewer than 3 candidates total, all
    of them already in `candidates` -- style references must end up
    empty, not repeat them (docs request: "sin repetir ninguna ya
    incluida").

    Uses 'S1000D 4.1', not the default 'S1000D 4.2' -- this dev sandbox
    has real, intentionally-persistent catalog fixtures seeded under
    'S1000D 4.2' (see the note on the zero-candidates test above), which
    would populate style_references here and break this assertion.
    """
    project = await _make_project(standard="S1000D 4.1")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    await _make_validated_candidate(project.id, _SAME_DIRECTION, "BRDP-ONLY-1")
    await _make_validated_candidate(project.id, _SAME_DIRECTION, "BRDP-ONLY-2")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["candidates"]) == 2
        assert body["style_references"] == []
    finally:
        await _cleanup(project, [editor])


async def test_definition_candidates_exclude_catalog_of_a_different_standard(client):
    project = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    other_standard_entry = await _make_catalog_entry("S1000D 3.0.1", _SAME_DIRECTION, "BRDP-OTHERSTD-CAT")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        assert response.json()["candidates"] == []
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([other_standard_entry])


async def test_definition_rejects_source_brdp_that_is_itself_a_catalog_entry(client):
    """docs request point 1: an official catalog BRDP already has a
    standard-issued Definition -- Suggest Definition is rejected with 400
    (the frontend's own disabled-button defense is separate; this is the
    server-side one). Checked against the real table by (standard,
    identifier), never by prefix -- see the next test.
    """
    project = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project.id)
    catalog_entry = await _make_catalog_entry("S1000D 4.2", None, "BRDP-S1-00070")
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00070")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 400
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([catalog_entry])


async def test_definition_catalog_rejection_is_by_exact_table_match_not_prefix(client):
    """The identifier LOOKS like a catalog-style identifier (same prefix
    convention) but is genuinely not one of the entries in the table --
    must be allowed, proving the check is a real (standard, identifier)
    lookup, not a prefix heuristic.
    """
    project = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project.id)
    catalog_entry = await _make_catalog_entry("S1000D 4.2", None, "BRDP-S1-00070")
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00099")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([catalog_entry])


async def test_definition_catalog_rejection_scoped_to_this_project_standard_only(client):
    """The same identifier exists in the catalog, but for a DIFFERENT
    standard than this project's -- must not be rejected (the catalog
    check is (standard, identifier), not identifier alone).
    """
    project = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project.id)
    catalog_entry = await _make_catalog_entry("S1000D 3.0.1", None, "BRDP-S1-00070")
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00070")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([catalog_entry])


# ---- kind='definition' catalog/records dedup (docs request, Suggest ----
# Definition language/wrap/dedup round), point 3 -----------------------


async def test_definition_dedupes_records_candidate_matching_catalog_by_identical_text(client):
    """A catalog entry and a Records BRDP sharing an identifier AND
    byte-identical Definition text are the same precedent shown twice --
    only the Catalog one should survive, so it doesn't spend two of the 5
    'similar' slots on the same content.
    """
    project = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    shared_text = "Shared torque calibration definition, identical byte for byte."
    catalog_entry = await _make_catalog_entry(
        "S1000D 4.2", _SAME_DIRECTION, "BRDP-DUP-001", definition=shared_text
    )
    records_dup = await _make_validated_candidate(
        project.id, _SAME_DIRECTION, "BRDP-DUP-001", definition=shared_text
    )
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        matching = [c for c in body["candidates"] if c["identifier"] == "BRDP-DUP-001"]
        assert len(matching) == 1, f"expected exactly 1 surviving candidate for BRDP-DUP-001, got {matching}"
        assert matching[0]["source"] == "Catalog", "the Catalog entry is kept, not the Records one"
        assert str(records_dup.id) not in {c["id"] for c in body["candidates"]}
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([catalog_entry])


async def test_definition_keeps_both_when_catalog_and_records_definitions_differ(client):
    """Same identifier in both Catalog and Records, but the project
    ADAPTED the wording -- genuinely different precedent, both must
    survive.
    """
    project = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    catalog_entry = await _make_catalog_entry(
        "S1000D 4.2", _SAME_DIRECTION, "BRDP-DUP-002", definition="Official catalog wording."
    )
    records_adapted = await _make_validated_candidate(
        project.id, _SAME_DIRECTION, "BRDP-DUP-002", definition="Project-adapted wording, different from the catalog."
    )
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        matching = [c for c in body["candidates"] if c["identifier"] == "BRDP-DUP-002"]
        assert len(matching) == 2, f"different text -- both must survive, got {matching}"
        sources = {c["source"] for c in matching}
        assert sources == {"Catalog", f"Records: {project.name}"}
        assert str(records_adapted.id) in {c["id"] for c in body["candidates"]}
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([catalog_entry])


async def test_definition_dedup_also_applies_to_style_references(client):
    """The same dedup rule applies to the style-references pool (<3
    similar), not just the 'similar' list -- a duplicate there would
    waste one of the 3 style-reference slots the same way.
    """
    project = await _make_project(standard="S1000D 4.2")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    # 1 close candidate -- keeps len(similar) at 1, below 3, so style
    # references kick in.
    close_one = await _make_validated_candidate(project.id, _SAME_DIRECTION, "BRDP-DUP-CLOSE")
    shared_far_text = "Identical far-away definition text, duplicated on purpose."
    far_catalog = await _make_catalog_entry(
        "S1000D 4.2", _ORTHOGONAL_DIRECTION, "BRDP-DUP-FAR", definition=shared_far_text
    )
    far_records_dup = await _make_validated_candidate(
        project.id, _ORTHOGONAL_DIRECTION, "BRDP-DUP-FAR", definition=shared_far_text
    )
    # A third, genuinely distinct far candidate so the style-reference
    # pool still has something real to fill with after the dup collapses.
    far_other = await _make_validated_candidate(project.id, _ORTHOGONAL_DIRECTION, "BRDP-DUP-FAR-OTHER")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=definition", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        matching = [c for c in body["style_references"] if c["identifier"] == "BRDP-DUP-FAR"]
        assert len(matching) == 1, f"expected exactly 1 surviving style reference for BRDP-DUP-FAR, got {matching}"
        assert matching[0]["source"] == "Catalog"
        assert str(far_records_dup.id) not in {c["id"] for c in body["style_references"]}
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([far_catalog])
