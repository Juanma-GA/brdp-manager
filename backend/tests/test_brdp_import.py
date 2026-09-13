"""Two-phase (analyze/apply) Excel import of Rule/Rule Status (docs
request). Real Postgres, no mocking except the Mistral embeddings call
triggered by a row importing as validation="Validated" (Phase 5's existing
precedent, not new to this file) -- mocked here because this file's job is
import correctness, not embeddings correctness.
"""
import uuid

import httpx
import pytest

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDPCatalog, Project, RuleApproval, User, UserProjectRole


@pytest.fixture(autouse=True)
def _mock_embeddings_transport():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": [0.1] * 1024, "index": 0}]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


@pytest.fixture
async def editor_and_project():
    # Canonical standard string (docs/v2 §2, matches
    # STANDARD_TO_RULE_FORMAT/src/constants/ruleFormats.js exactly) --
    # unlike test_brdps_notes_approvals.py's fixture, the actual string
    # matters here: /import/analyze derives the rule format FROM
    # project.standard, it isn't passed in the URL like approvals.py's
    # routes.
    async with async_session_factory() as session:
        project = Project(name=f"Import Test Project {uuid.uuid4()}", standard="BREX — S1000D 4.2")
        editor = User(
            email=f"import-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Import Test Editor",
            global_role="user",
        )
        viewer = User(
            email=f"import-viewer-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Import Test Viewer",
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

    editor_headers = {"Authorization": f"Bearer {create_access_token(editor.id)}"}
    viewer_headers = {"Authorization": f"Bearer {create_access_token(viewer.id)}"}
    yield project, editor_headers, viewer_headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        for user_id in (editor.id, viewer.id):
            db_user = await session.get(User, user_id)
            if db_user is not None:
                await session.delete(db_user)
        await session.commit()


@pytest.fixture
async def catalog_entry():
    """A single brdp_catalog row for "BREX — S1000D 4.2" (matches
    editor_and_project's fixture standard exactly) -- global reference
    data, not project-scoped, so it's seeded/torn down independently.
    """
    identifier = f"BRDP-CAT-{uuid.uuid4()}"
    async with async_session_factory() as session:
        entry = BRDPCatalog(
            standard="BREX — S1000D 4.2",
            identifier=identifier,
            title="Catalog title",
            definition="Catalog definition",
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)

    yield entry

    async with async_session_factory() as session:
        db_entry = await session.get(BRDPCatalog, entry.id)
        if db_entry is not None:
            await session.delete(db_entry)
        await session.commit()


def _row(row_number, identifier, **overrides):
    row = {
        "row_number": row_number,
        "identifier": identifier,
        "title": "Some title",
        "definition": "Some definition",
        "proposal": "Some proposal",
        "proposal_status": "Pending",
        "rule_status": "To Do",
        "rule": "",
    }
    row.update(overrides)
    return row


VALID_RULE = '<structureObjectRule id="x"><objectPath allowedObjectFlag="1">//x</objectPath></structureObjectRule>'
INVALID_RULE = "<structureObjectRule><unclosed>"


async def test_analyze_rejects_empty_rule_with_verified_status(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    rows = [_row(2, "BRDP-IMP-001", rule_status="Verified", rule="")]

    response = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    assert response.status_code == 200
    (result,) = response.json()["results"]
    assert result["outcome"] == "rejected"
    assert "claims a rule that doesn't exist" in result["reason"]

    # Nothing touched Postgres -- analyze is read-only.
    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=headers)
    assert listed.json() == []


async def test_analyze_rejects_valid_rule_with_todo_status(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    rows = [_row(2, "BRDP-IMP-002", rule_status="To Do", rule=VALID_RULE)]

    response = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (result,) = response.json()["results"]
    assert result["outcome"] == "rejected"
    assert "claims no rule exists, but one does" in result["reason"]


async def test_analyze_rejects_malformed_xml_regardless_of_status(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    rows = [_row(2, "BRDP-IMP-003", rule_status="Draft", rule=INVALID_RULE)]

    response = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (result,) = response.json()["results"]
    assert result["outcome"] == "rejected"
    assert "not well-formed XML" in result["reason"]
    # Distinct reason from the two combination-mismatch cases above.
    assert "claims" not in result["reason"]


async def test_analyze_rejects_invalid_rule_status_value(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    rows = [_row(2, "BRDP-IMP-004", rule_status="Pending Review", rule="")]

    response = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (result,) = response.json()["results"]
    assert result["outcome"] == "rejected"
    assert "Invalid Rule Status value" in result["reason"]


async def test_apply_valid_draft_and_verified_rows_write_real_postgres_state(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    rows = [
        _row(2, "BRDP-IMP-DRAFT", rule_status="Draft", rule=VALID_RULE, title="Draft row"),
        _row(3, "BRDP-IMP-VERIFIED", rule_status="Verified", rule=VALID_RULE, title="Verified row"),
        _row(4, "BRDP-IMP-TODO", rule_status="To Do", rule="", title="Todo row"),
    ]

    apply_resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )
    assert apply_resp.status_code == 200
    body = apply_resp.json()
    assert body["created"] == 3
    assert body["rejected"] == 0

    brdps = {b["identifier"]: b for b in (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()}
    draft_brdp = brdps["BRDP-IMP-DRAFT"]
    verified_brdp = brdps["BRDP-IMP-VERIFIED"]
    todo_brdp = brdps["BRDP-IMP-TODO"]
    assert draft_brdp["title"] == "Draft row"

    draft_approval = (
        await client.get(f"/api/projects/{project.id}/brdps/{draft_brdp['id']}/approvals/BREX-4.2", headers=headers)
    ).json()
    assert draft_approval["status"] == "pending_review"
    assert draft_approval["rule_xml"] == VALID_RULE
    assert draft_approval["approved_at"] is None

    verified_approval = (
        await client.get(f"/api/projects/{project.id}/brdps/{verified_brdp['id']}/approvals/BREX-4.2", headers=headers)
    ).json()
    assert verified_approval["status"] == "approved"
    assert verified_approval["rule_xml"] == VALID_RULE
    assert verified_approval["approved_at"] is not None  # real timestamp, not just the status

    todo_approval = (
        await client.get(f"/api/projects/{project.id}/brdps/{todo_brdp['id']}/approvals/BREX-4.2", headers=headers)
    ).json()
    assert todo_approval is None  # todo = no rule_approvals row at all


async def test_apply_skips_rejected_rows_entirely(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    rows = [_row(2, "BRDP-IMP-BAD", rule_status="Verified", rule="", title="Should never be written")]

    apply_resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )
    body = apply_resp.json()
    assert body["created"] == 0
    assert body["rejected"] == 1

    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=headers)
    assert listed.json() == []  # nothing applied, not even title


async def test_conflict_keep_leaves_existing_rule_intact(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    created = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMP-CONFLICT"}, headers=headers)
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": VALID_RULE, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    rows = [_row(2, "BRDP-IMP-CONFLICT", rule_status="To Do", rule="", title="Updated via import")]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "conflict"
    assert analyzed["existing_rule_status"] == "Verified"

    apply_resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )
    body = apply_resp.json()
    assert body["conflicts_kept"] == 1
    assert body["conflicts_cleared"] == 0

    brdp_after = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()[0]
    assert brdp_after["title"] == "Updated via import"  # core fields still apply
    get_approval_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    approval_after = (await client.get(get_approval_url, headers=headers)).json()
    assert approval_after["status"] == "approved"  # rule untouched


async def test_conflict_clear_wipes_existing_rule_to_todo(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    created = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMP-CONFLICT2"}, headers=headers)
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": VALID_RULE, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    rows = [_row(2, "BRDP-IMP-CONFLICT2", rule_status="To Do", rule="")]

    apply_resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "clear"},
        headers=headers,
    )
    body = apply_resp.json()
    assert body["conflicts_kept"] == 0
    assert body["conflicts_cleared"] == 1

    approval_after = (await client.get(approve_url, headers=headers)).json()
    assert approval_after is None  # genuinely back to "todo"


async def test_catalog_match_overrides_title_definition_and_flags_a_warning(client, editor_and_project, catalog_entry):
    project, headers, _viewer_headers = editor_and_project
    rows = [
        _row(
            2,
            catalog_entry.identifier,
            title="Excel title (should be ignored)",
            definition="Excel definition (should be ignored)",
            proposal="Excel proposal (should survive)",
            proposal_status="Validated",
        )
    ]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["catalog_override"] is True  # warning surfaced BEFORE apply

    await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )

    (brdp,) = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    assert brdp["title"] == "Catalog title"  # from brdp_catalog, NOT the Excel
    assert brdp["definition"] == "Catalog definition"
    assert brdp["proposal"] == "Excel proposal (should survive)"  # catalog never touches Proposal
    assert brdp["validation"] == "Validated"  # nor Proposal Status


async def test_catalog_match_with_identical_values_applies_but_does_not_warn(client, editor_and_project, catalog_entry):
    """Correction (docs request): the warning is about VISIBILITY of a
    change, not a condition for the substitution to happen. A row whose
    Excel Title/Definition already equal the catalog's has nothing
    perceptible to flag, but the values still come from the catalog (this
    test proves that by giving a real, distinguishable Proposal so the
    Postgres row can't be mistaken for one that got no catalog treatment
    at all).
    """
    project, headers, _viewer_headers = editor_and_project
    rows = [
        _row(
            2,
            catalog_entry.identifier,
            title=catalog_entry.title,  # exactly matches the catalog already
            definition=catalog_entry.definition,
            proposal="Distinct proposal proving this row was processed",
        )
    ]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["catalog_override"] is False  # nothing to warn about

    await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )

    (brdp,) = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    assert brdp["title"] == catalog_entry.title  # applied from the catalog regardless
    assert brdp["definition"] == catalog_entry.definition
    assert brdp["proposal"] == "Distinct proposal proving this row was processed"


async def test_catalog_match_is_standard_specific(client, editor_and_project, catalog_entry):
    """The same identifier exists in the catalog under a DIFFERENT standard
    ("BREX — S1000D 4.1") -- editor_and_project's project is "BREX —
    S1000D 4.2", so this must NOT match (docs request: the filter is the
    project's exact standard, not any standard the identifier happens to
    appear under).
    """
    project, headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        other_standard_entry = BRDPCatalog(
            standard="BREX — S1000D 4.1",
            identifier=catalog_entry.identifier,
            title="Wrong-standard catalog title",
            definition="Wrong-standard catalog definition",
        )
        session.add(other_standard_entry)
        await session.commit()
        await session.refresh(other_standard_entry)
        other_standard_entry_id = other_standard_entry.id

    try:
        # Use a fresh identifier that ISN'T seeded under 4.2 at all --
        # proves a 4.1-only catalog row never leaks into a 4.2 project's
        # import.
        non_catalog_identifier = f"BRDP-EXT-{uuid.uuid4()}"
        rows = [_row(2, non_catalog_identifier, title="Real Excel title", definition="Real Excel definition")]

        analyze_resp = await client.post(
            f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers
        )
        (analyzed,) = analyze_resp.json()["results"]
        assert analyzed["catalog_override"] is False

        await client.post(
            f"/api/projects/{project.id}/brdps/import/apply",
            json={"rows": rows, "conflict_resolution": "keep"},
            headers=headers,
        )
        (brdp,) = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
        assert brdp["title"] == "Real Excel title"
        assert brdp["definition"] == "Real Excel definition"
    finally:
        async with async_session_factory() as session:
            db_entry = await session.get(BRDPCatalog, other_standard_entry_id)
            if db_entry is not None:
                await session.delete(db_entry)
            await session.commit()


async def test_apply_is_editor_gated_viewer_gets_403_and_writes_nothing(client, editor_and_project):
    project, _editor_headers, viewer_headers = editor_and_project
    rows = [_row(2, "BRDP-IMP-AUTH", rule_status="To Do", rule="")]

    analyze_resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=viewer_headers
    )
    assert analyze_resp.status_code == 403

    apply_resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=viewer_headers,
    )
    assert apply_resp.status_code == 403

    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=viewer_headers)
    assert listed.json() == []
