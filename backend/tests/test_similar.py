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

Suggest Proposal corpus round (docs request): kind='proposal' ALSO gets
its own dedicated corpus now (_get_proposal_similar, tested separately
further down this file, mirroring the definition corpus's own section) --
MIN_CANDIDATES/candidate-cap-10/insufficient-precedent no longer apply to
it either. The remaining tests of those GENERIC semantics (zero/two/
fifteen-plus candidates, standard filtering) move one more time, to
kind='rule' -- the only kind left with the old behavior. kind='rule'
needs a real, mapped project standard (STANDARD_TO_RULE_FORMAT), which
would normally reintroduce the exact real-standard-data fragility a
previous round eliminated -- avoided here with `_fake_rule_format()`
below, which monkeypatches a fresh, per-test SYNTHETIC format string onto
_make_project()'s already-synthetic standard, so these tests stay just as
isolated from real approved rules in the environment as every other test
in this file that doesn't genuinely need a real standard.

Test isolation from real data (docs request, "tests que dependen de los
datos existentes" round): candidate search here scans ALL projects (and,
for kind='definition', the catalog) of a given STANDARD -- so a test that
hardcodes a real standard string ("S1000D 4.2", etc.) and then asserts an
EXACT candidate count/set is only correct by accident, in an environment
that happens to have no other real data for that standard. An earlier
round hit this directly: 3 tests here started failing the moment this
sandbox picked up real, persistent catalog fixtures under "S1000D 4.2"
from an unrelated verification round, and were "fixed" by moving them to
"S1000D 4.1" -- which only postpones the same failure to whichever
environment (this sandbox once 4.1 is loaded too, or any real deployment)
has data for THAT standard instead. The real fix: _make_project() below
defaults to a fresh, per-call synthetic standard string (never a real
S1000D/DITA standard) when no `standard=` is given, so a test that just
needs "some standard, consistently used within itself" is isolated by
construction from whatever real data exists in the environment, and the
whole suite passes the same way whether the DB's catalog is empty or
fully loaded for every real standard. Tests that genuinely need a REAL
standard (kind='rule' format-mapping) still pass one explicitly, and
their candidate assertions are subset checks (their own known rows are
present), never exact-set equality against the full candidate list.
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
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT

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


async def _make_project(standard: str | None = None) -> Project:
    """`standard` defaults to a fresh, per-call synthetic string (never a
    real S1000D/DITA standard) -- most tests here just need SOME standard,
    consistently used within that one test, and must never accidentally
    collide with real catalog/BRDP data for a real standard that might
    already exist in this environment. Tests that genuinely need a REAL
    standard (the kind='rule' format-mapping tests) still pass one
    explicitly.
    """
    if standard is None:
        standard = f"TEST-STANDARD-{uuid.uuid4()}"
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


def _fake_rule_format(monkeypatch: pytest.MonkeyPatch, standard: str) -> str:
    """Registers a fresh, per-call synthetic rule format for `standard`
    (itself already a synthetic, per-test standard from _make_project())
    so a kind='rule' test can exercise the real format-mapped code path
    without needing a real S1000D/DITA standard -- and therefore without
    any risk of a test's exact-count assertion colliding with real
    approved rules already in this environment under a real format like
    "BREX-4.2". Reverted automatically by pytest's monkeypatch fixture
    teardown, so it never leaks into another test.
    """
    fmt = f"TEST-RULE-FORMAT-{uuid.uuid4()}"
    monkeypatch.setitem(STANDARD_TO_RULE_FORMAT, standard, fmt)
    return fmt


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


async def test_zero_candidates_reports_insufficient_precedent(client, monkeypatch):
    project = await _make_project()
    _fake_rule_format(monkeypatch, project.standard)
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is False
        assert body["candidates"] == []
        assert "insufficient" in body["message"].lower()
    finally:
        await _cleanup(project, [editor])


async def test_two_passing_candidates_reports_insufficient_precedent(client, monkeypatch):
    """Below MIN_CANDIDATES (3) even though the two DO pass the
    similarity threshold -- the "not enough precedent" rule is about
    COUNT, not just quality.
    """
    project = await _make_project()
    fmt = _fake_rule_format(monkeypatch, project.standard)
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    close_ones = [
        await _make_validated_candidate(
            project.id, _SAME_DIRECTION, f"BRDP-CLOSE-{i}", rule_xml=f"<rule id='{i}'/>", rule_format=fmt
        )
        for i in range(2)
    ]
    # A dissimilar one too, to prove it's correctly excluded rather than
    # padding the response up to 3.
    far_one = await _make_validated_candidate(
        project.id, _ORTHOGONAL_DIRECTION, "BRDP-FAR-1", rule_xml="<rule id='far'/>", rule_format=fmt
    )
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
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


async def test_fifteen_plus_candidates_reports_sufficient_precedent_capped_at_ten(client, monkeypatch):
    project = await _make_project()
    fmt = _fake_rule_format(monkeypatch, project.standard)
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    for i in range(15):
        await _make_validated_candidate(
            project.id, _SAME_DIRECTION, f"BRDP-MANY-{i}", rule_xml=f"<rule id='{i}'/>", rule_format=fmt
        )
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
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


async def test_different_standard_is_excluded_from_candidates(client, monkeypatch):
    project_a = await _make_project()
    project_b = await _make_project()
    fmt_a = _fake_rule_format(monkeypatch, project_a.standard)
    editor = await _make_editor(project_a.id)
    source = await _make_source_brdp(project_a.id)
    # Enough close candidates in project_b to pass MIN_CANDIDATES on their
    # own, IF the standard filter were broken -- registered under
    # project_a's OWN rule format on purpose: project_b's real Project.
    # standard column still differs (its own fresh synthetic value), so
    # this proves standard filtering catches it regardless of format.
    for i in range(5):
        await _make_validated_candidate(
            project_b.id, _SAME_DIRECTION, f"BRDP-OTHERSTD-{i}", rule_xml=f"<rule id='{i}'/>", rule_format=fmt_a
        )
    try:
        response = await client.get(
            f"/api/projects/{project_a.id}/brdps/{source.id}/similar?kind=rule", headers=_headers(editor)
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
        # Subset, not exact-set equality (docs request): this test needs a
        # REAL standard to exercise the real STANDARD_TO_RULE_FORMAT
        # mapping, so it can't isolate itself from other real approved
        # BREX-4.2 rules that may already exist for this standard in the
        # environment -- it only has to prove OUR 3 rows are present.
        texts = {c["text"] for c in body["candidates"]}
        assert {f"<rule id='{i}'/>" for i in range(3)} <= texts
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
        # Subset, not exact-set equality -- same reasoning as the S1000D
        # 4.2 rule-mapping test above (docs request).
        texts = {c["text"] for c in body["candidates"]}
        assert {f"<sch:pattern id='{i}'/>" for i in range(3)} <= texts
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
    shared_standard = f"TEST-STANDARD-{uuid.uuid4()}"
    project_a = await _make_project(standard=shared_standard)
    project_b = await _make_project(standard=shared_standard)
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

    _make_project()'s default standard is a fresh synthetic string per
    call, so "zero candidates" holds regardless of what real catalog/BRDP
    data exists for any real standard in this environment.
    """
    project = await _make_project()
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

    project_a/project_b/the catalog entry all share ONE fresh synthetic
    standard (never a real one), so the exact-set assertion below can
    never leak in or be diluted by real catalog/BRDP data for any real
    standard in this environment.
    """
    shared_standard = f"TEST-STANDARD-{uuid.uuid4()}"
    project_a = await _make_project(standard=shared_standard)
    project_b = await _make_project(standard=shared_standard)
    editor = await _make_editor(project_a.id)
    source = await _make_source_brdp(project_a.id)
    other_project_candidate = await _make_validated_candidate(project_b.id, _SAME_DIRECTION, "BRDP-OTHERPROJ-1")
    catalog_entry = await _make_catalog_entry(shared_standard, _SAME_DIRECTION, "BRDP-CAT-1")
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
    """
    project = await _make_project()
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
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    other_standard = f"TEST-STANDARD-OTHER-{uuid.uuid4()}"
    other_standard_entry = await _make_catalog_entry(other_standard, _SAME_DIRECTION, "BRDP-OTHERSTD-CAT")
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

    The identifier ("BRDP-S1-00070") deliberately follows a realistic
    S1000D naming convention, but the catalog row is created under
    project.standard -- _make_project()'s fresh synthetic standard, never
    a real one -- so this (standard, identifier) pair can never already
    exist in this environment's real catalog data, however realistic the
    identifier looks.
    """
    project = await _make_project()
    editor = await _make_editor(project.id)
    catalog_entry = await _make_catalog_entry(project.standard, None, "BRDP-S1-00070")
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
    project = await _make_project()
    editor = await _make_editor(project.id)
    catalog_entry = await _make_catalog_entry(project.standard, None, "BRDP-S1-00070")
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
    project = await _make_project()
    editor = await _make_editor(project.id)
    other_standard = f"TEST-STANDARD-OTHER-{uuid.uuid4()}"
    catalog_entry = await _make_catalog_entry(other_standard, None, "BRDP-S1-00070")
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
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    shared_text = "Shared torque calibration definition, identical byte for byte."
    catalog_entry = await _make_catalog_entry(
        project.standard, _SAME_DIRECTION, "BRDP-DUP-001", definition=shared_text
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
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    catalog_entry = await _make_catalog_entry(
        project.standard, _SAME_DIRECTION, "BRDP-DUP-002", definition="Official catalog wording."
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
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    # 1 close candidate -- keeps len(similar) at 1, below 3, so style
    # references kick in.
    close_one = await _make_validated_candidate(project.id, _SAME_DIRECTION, "BRDP-DUP-CLOSE")
    shared_far_text = "Identical far-away definition text, duplicated on purpose."
    far_catalog = await _make_catalog_entry(
        project.standard, _ORTHOGONAL_DIRECTION, "BRDP-DUP-FAR", definition=shared_far_text
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


# ---- kind='proposal' corpus (docs request, Suggest Proposal round) -------
#
# Three disjoint groups (_get_proposal_similar), tested independently of
# the generic proposal/rule semantics above (now exercised via kind='rule'
# only). The catalog never enters this corpus at all -- it has no Proposal
# -- so these tests never need _make_catalog_entry for embeddings, only
# for the plain (standard, identifier) existence check that gates
# same_brdp.


async def test_proposal_same_brdp_group_matches_other_projects_by_identifier(client):
    """docs request point 1: identifier exists in the catalog -> up to 5
    Validated BRDPs from OTHER projects sharing that EXACT identifier, via
    a direct lookup (no embeddings needed on either side).
    """
    project = await _make_project()
    catalog_entry = await _make_catalog_entry(project.standard, None, "BRDP-S1-00070")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00070")
    other_project = await _make_project(standard=project.standard)
    # _SAME_DIRECTION (not orthogonal) on purpose: this candidate would
    # ALSO pass the "Similar decisions" similarity search on its own
    # merits, so its absence from `candidates` below actually proves the
    # cross-group dedup, not just that a dissimilar row was never a
    # candidate to begin with.
    match = await _make_validated_candidate(
        other_project.id, _SAME_DIRECTION, "BRDP-S1-00070", definition="Other project's definition"
    )
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["sufficient_precedent"] is True
        assert len(body["same_brdp"]) == 1
        entry = body["same_brdp"][0]
        assert entry["id"] == str(match.id)
        assert entry["identifier"] == "BRDP-S1-00070"
        assert entry["text"] == match.proposal  # `text` is the Proposal for this kind
        assert entry["definition"] == "Other project's definition"
        assert entry["source"] == other_project.name  # bare project name, never "Records: "-prefixed
        assert str(match.id) not in {c["id"] for c in body["candidates"]}  # not double-counted in "Similar decisions"
    finally:
        await _cleanup(project, [editor])
        await _cleanup(other_project)
        await _cleanup_catalog([catalog_entry])


async def test_proposal_same_brdp_group_capped_at_five(client):
    project = await _make_project()
    catalog_entry = await _make_catalog_entry(project.standard, None, "BRDP-S1-00099")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00099")
    other_projects = [await _make_project(standard=project.standard) for _ in range(7)]
    for i, other_project in enumerate(other_projects):
        await _make_validated_candidate(other_project.id, _ORTHOGONAL_DIRECTION, "BRDP-S1-00099")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        assert len(response.json()["same_brdp"]) == 5  # PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT, not all 7
    finally:
        await _cleanup(project, [editor])
        for other_project in other_projects:
            await _cleanup(other_project)
        await _cleanup_catalog([catalog_entry])


async def test_proposal_same_brdp_group_empty_for_ext_identifier(client):
    """docs request edge case: an EXT identifier never has a same_brdp
    group, even if another project happens to share the exact string --
    identifier matching is only meaningful for a real catalog-issued id.
    """
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-EXT-00007")
    other_project = await _make_project(standard=project.standard)
    # Same identifier string, purely coincidental (both projects' own
    # auto-generated EXT sequence happened to reach 00007) -- must NOT
    # match, since "BRDP-EXT-00007" is not in the catalog at all.
    await _make_validated_candidate(other_project.id, _SAME_DIRECTION, "BRDP-EXT-00007")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["same_brdp"] == []
        # It's still a real, valid "Similar decisions" match though (same
        # identifier coincidentally also means max similarity here) --
        # confirms this ISN'T a blanket exclusion of that BRDP, only of
        # the same_brdp *group* for a non-catalog identifier.
        assert len(body["candidates"]) == 1
    finally:
        await _cleanup(project, [editor])
        await _cleanup(other_project)


async def test_proposal_similar_group_provides_all_five_when_same_brdp_empty(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-EXT-00001")
    other_project = await _make_project(standard=project.standard)
    for i in range(7):
        await _make_validated_candidate(other_project.id, _SAME_DIRECTION, f"BRDP-EXT-OTHER-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["same_brdp"] == []
        assert len(body["candidates"]) == 5  # capped at PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT, all from "similar"
    finally:
        await _cleanup(project, [editor])
        await _cleanup(other_project)


async def test_proposal_similar_group_tops_up_same_brdp_to_combined_five(client):
    """docs request point 1: "si es de catálogo, solo se usan para
    completar hasta 5 en total con el grupo anterior" -- 2 in same_brdp
    (capped by a real limit of 2 available) + candidates fills the
    remaining 3 slots, never exceeding 5 combined.
    """
    project = await _make_project()
    catalog_entry = await _make_catalog_entry(project.standard, None, "BRDP-S1-00042")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00042")
    same_id_projects = [await _make_project(standard=project.standard) for _ in range(2)]
    for other_project in same_id_projects:
        await _make_validated_candidate(other_project.id, _ORTHOGONAL_DIRECTION, "BRDP-S1-00042")
    similar_project = await _make_project(standard=project.standard)
    for i in range(6):
        await _make_validated_candidate(similar_project.id, _SAME_DIRECTION, f"BRDP-SIMILAR-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["same_brdp"]) == 2
        assert len(body["candidates"]) == 3  # 5 - 2, not the full 5 and not all 6 available
    finally:
        await _cleanup(project, [editor])
        for other_project in same_id_projects:
            await _cleanup(other_project)
        await _cleanup(similar_project)
        await _cleanup_catalog([catalog_entry])


async def test_proposal_this_project_group_capped_at_three(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    for i in range(5):
        await _make_validated_candidate(project.id, _SAME_DIRECTION, f"BRDP-OWN-{i}")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["this_project"]) == 3  # PROPOSAL_THIS_PROJECT_LIMIT, not all 5
        assert body["this_project"][0]["source"] == ""  # never named -- "this project" is implied
        assert body["same_brdp"] == []
        assert body["candidates"] == []  # own-project candidates never leak into the "other projects" groups
    finally:
        await _cleanup(project, [editor])


async def test_proposal_candidates_below_similarity_threshold_excluded_from_all_groups(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    other_project = await _make_project(standard=project.standard)
    far_other = await _make_validated_candidate(other_project.id, _ORTHOGONAL_DIRECTION, "BRDP-FAR-OTHER")
    far_own = await _make_validated_candidate(project.id, _ORTHOGONAL_DIRECTION, "BRDP-FAR-OWN")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["candidates"] == []
        assert body["this_project"] == []
        assert body["sufficient_precedent"] is True  # no MIN_CANDIDATES gate, even with zero real matches
        assert body["message"] is None
    finally:
        await _cleanup(project, [editor])
        await _cleanup(other_project)


async def test_proposal_excludes_candidates_with_empty_proposal(client):
    """docs request point 1: "Solo BRDPs Validated (con Proposal no
    vacía)" -- a Validated BRDP with an empty Proposal must never appear
    in ANY group, even if it would otherwise qualify (same identifier,
    high similarity, own project).
    """
    project = await _make_project()
    catalog_entry = await _make_catalog_entry(project.standard, None, "BRDP-S1-00050")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00050")
    other_project = await _make_project(standard=project.standard)
    async with async_session_factory() as session:
        # Same identifier as source (would qualify for same_brdp) but
        # empty Proposal.
        session.add(
            BRDP(
                project_id=other_project.id,
                identifier="BRDP-S1-00050",
                definition="text",
                proposal="",
                validation="Validated",
                embedding=_ORTHOGONAL_DIRECTION,
            )
        )
        # High similarity (would qualify for "This project") but empty
        # Proposal.
        session.add(
            BRDP(
                project_id=project.id,
                identifier="BRDP-EMPTY-PROPOSAL-OWN",
                definition="text",
                proposal="",
                validation="Validated",
                embedding=_SAME_DIRECTION,
            )
        )
        await session.commit()
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["same_brdp"] == []
        assert body["candidates"] == []
        assert body["this_project"] == []
    finally:
        await _cleanup(project, [editor])
        await _cleanup(other_project)
        await _cleanup_catalog([catalog_entry])


async def test_proposal_rejects_when_definition_is_empty(client):
    project = await _make_project()
    editor = await _make_editor(project.id)
    async with async_session_factory() as session:
        source = BRDP(
            project_id=project.id,
            identifier="BRDP-NODEF-001",
            definition="",
            proposal="",
            validation="Pending",
        )
        session.add(source)
        await session.commit()
        await session.refresh(source)
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 400
        assert "definition" in response.json()["detail"].lower()
    finally:
        await _cleanup(project, [editor])


async def test_proposal_allowed_on_catalog_sourced_brdp(client):
    """Unlike kind='definition', a catalog-sourced BRDP is explicitly
    ALLOWED for Suggest Proposal (docs request point 2) -- the catalog
    only ever supplies the official Definition, never a Proposal, which
    is always this project's own decision to make.
    """
    project = await _make_project()
    catalog_entry = await _make_catalog_entry(project.standard, None, "BRDP-S1-00077")
    editor = await _make_editor(project.id)
    source = await _make_source_brdp_with_identifier(project.id, "BRDP-S1-00077")
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
    finally:
        await _cleanup(project, [editor])
        await _cleanup_catalog([catalog_entry])


async def test_proposal_excluded_pending_other_projects_scoped_to_non_empty_proposal(client):
    """docs request point 1 (\"Se mantiene el recuento de excluidas por
    falta de embedding\"), scoped correctly: a Validated-but-unembedded
    BRDP in another project with an EMPTY Proposal must not inflate this
    count -- it was never going to be a candidate anyway (missing
    Proposal, not missing embedding), so counting it would overstate the
    embedding gap's real impact.
    """
    project = await _make_project()
    editor = await _make_editor(project.id)
    source = await _make_source_brdp(project.id)
    other_project = await _make_project(standard=project.standard)
    async with async_session_factory() as session:
        session.add(
            BRDP(
                project_id=other_project.id,
                identifier="BRDP-PENDING-WITH-PROPOSAL",
                definition="text",
                proposal="A real proposal",
                validation="Validated",
            )
        )
        session.add(
            BRDP(
                project_id=other_project.id,
                identifier="BRDP-PENDING-NO-PROPOSAL",
                definition="text",
                proposal="",
                validation="Validated",
            )
        )
        await session.commit()
    try:
        response = await client.get(
            f"/api/projects/{project.id}/brdps/{source.id}/similar?kind=proposal", headers=_headers(editor)
        )
        assert response.status_code == 200
        assert response.json()["excluded_pending_other_projects"] == 1
    finally:
        await _cleanup(project, [editor])
        await _cleanup(other_project)
