"""Two-phase (analyze/apply) Excel import of Rule/Rule Status (docs
request). Real Postgres, no mocking except the Mistral embeddings call
triggered by a row importing as validation="Validated" (Phase 5's existing
precedent, not new to this file) -- mocked here because this file's job is
import correctness, not embeddings correctness.
"""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDPCatalog, ImportJob, Project, RuleApproval, User, UserProjectRole
from app.schemas.brdp_import import ImportRowIn
from app.services.import_jobs import STALE_JOB_MINUTES, get_running_job, run_import_job


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
        project = Project(name=f"Import Test Project {uuid.uuid4()}", standard="S1000D 4.2")
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
async def dita_editor_and_project():
    """Same shape as editor_and_project, but standard="DITA 1.3" -- used to
    confirm the generic import path (well-formedness, Rule/Rule Status
    combinations, rule_override) behaves identically for native Schematron
    content (SCH-DITA format) as it does for BREX-shaped XML, now that
    DITA 1.3 has a rule_format at all (see rule_formats.py).
    """
    async with async_session_factory() as session:
        project = Project(name=f"DITA Import Test Project {uuid.uuid4()}", standard="DITA 1.3")
        editor = User(
            email=f"dita-import-editor-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="DITA Import Test Editor",
            global_role="user",
        )
        session.add_all([project, editor])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)

    editor_headers = {"Authorization": f"Bearer {create_access_token(editor.id)}"}
    yield project, editor_headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        db_user = await session.get(User, editor.id)
        if db_user is not None:
            await session.delete(db_user)
        await session.commit()


@pytest.fixture
async def catalog_entry():
    """A single brdp_catalog row for "S1000D 4.2" (matches
    editor_and_project's fixture standard exactly) -- global reference
    data, not project-scoped, so it's seeded/torn down independently.
    """
    identifier = f"BRDP-CAT-{uuid.uuid4()}"
    async with async_session_factory() as session:
        entry = BRDPCatalog(
            standard="S1000D 4.2",
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


async def _apply_and_wait(client, project_id, headers, rows, conflict_resolution="keep"):
    """Apply is now async (docs request: background job, not a blocking
    request) -- POST /apply returns job_id immediately (202), the actual
    work happens via BackgroundTasks. Under the test client's ASGITransport
    (in-process, no real network), Starlette runs background tasks to
    completion as part of the same coroutine chain that sends the
    response, so by the time `await client.post(...)` returns here the job
    has, in practice, already finished -- but this still polls
    /status/{job_id} (bounded, 20 x 0.25s) rather than assuming that
    timing, so the test keeps working even if that implementation detail
    ever changes. Returns the final ImportJobStatusOut body.
    """
    apply_resp = await client.post(
        f"/api/projects/{project_id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": conflict_resolution},
        headers=headers,
    )
    assert apply_resp.status_code == 202
    job_id = apply_resp.json()["job_id"]

    for _ in range(20):
        status_resp = await client.get(f"/api/projects/{project_id}/brdps/import/status/{job_id}", headers=headers)
        body = status_resp.json()
        if body["status"] != "running":
            return body
        await asyncio.sleep(0.25)
    raise AssertionError(f"Import job {job_id} never left 'running' status")


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


async def test_analyze_accepts_multi_root_rulescontext_rule(client, editor_and_project):
    """A real approved BRDP's Rule cell can legitimately mix a loose
    structureObjectRule with one or more complete <contextRules
    rulesContext="..."> blocks (S1000D 4.2 allows repeated <contextRules>
    as siblings under <brex>, confirmed against brex4.2.xsd: contextRules
    maxOccurs="unbounded") -- e.g. a real Lufthansa BREX rule scoped to a
    specific schema like fault.xsd. That's multiple XML-sibling roots in
    one Rule cell, which used to be rejected outright as "not well-formed
    XML" (etree.fromstring() requires exactly one root) before
    _xml_well_formed_error started wrapping fragments in a throwaway
    <root>.
    """
    project, headers, _viewer_headers = editor_and_project
    multi_root_rule = (
        '<structureObjectRule id="x"><objectPath allowedObjectFlag="1">//x</objectPath></structureObjectRule>'
        '<contextRules rulesContext="fault.xsd"><structureObjectRuleGroup>'
        '<structureObjectRule id="x-ctx"><objectPath allowedObjectFlag="1">//scoped</objectPath></structureObjectRule>'
        "</structureObjectRuleGroup></contextRules>"
    )
    rows = [_row(2, "BRDP-IMP-CTX", rule_status="Verified", rule=multi_root_rule)]

    response = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (result,) = response.json()["results"]
    assert result["outcome"] == "ok"


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

    body = await _apply_and_wait(client, project.id, headers, rows)
    assert body["status"] == "completed"
    assert body["result"]["created"] == 3
    assert body["result"]["rejected"] == 0

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

    body = await _apply_and_wait(client, project.id, headers, rows)
    assert body["result"]["created"] == 0
    assert body["result"]["rejected"] == 1

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

    body = await _apply_and_wait(client, project.id, headers, rows)
    assert body["result"]["conflicts_kept"] == 1
    assert body["result"]["conflicts_cleared"] == 0

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

    body = await _apply_and_wait(client, project.id, headers, rows, conflict_resolution="clear")
    assert body["result"]["conflicts_kept"] == 0
    assert body["result"]["conflicts_cleared"] == 1

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

    await _apply_and_wait(client, project.id, headers, rows)

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

    await _apply_and_wait(client, project.id, headers, rows)

    (brdp,) = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    assert brdp["title"] == catalog_entry.title  # applied from the catalog regardless
    assert brdp["definition"] == catalog_entry.definition
    assert brdp["proposal"] == "Distinct proposal proving this row was processed"


async def test_catalog_match_is_standard_specific(client, editor_and_project, catalog_entry):
    """The same identifier exists in the catalog under a DIFFERENT standard
    ("S1000D 4.1") -- editor_and_project's project is "S1000D 4.2", so this
    must NOT match (docs request: the filter is the project's exact
    standard, not any standard the identifier happens to appear under).
    """
    project, headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        other_standard_entry = BRDPCatalog(
            standard="S1000D 4.1",
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

        await _apply_and_wait(client, project.id, headers, rows)
        (brdp,) = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
        assert brdp["title"] == "Real Excel title"
        assert brdp["definition"] == "Real Excel definition"
    finally:
        async with async_session_factory() as session:
            db_entry = await session.get(BRDPCatalog, other_standard_entry_id)
            if db_entry is not None:
                await session.delete(db_entry)
            await session.commit()


async def test_rule_override_warns_when_reimporting_a_different_rule(client, editor_and_project):
    """Same idea as catalog_override, for the Rule column (docs request):
    reimporting an identifier that already has an approved rule, bringing
    a DIFFERENT Rule, must warn before Apply replaces it -- confirmed
    missing today (a targeted fix reimport gave outcome="ok" with no
    warning at all).
    """
    project, headers, _viewer_headers = editor_and_project
    other_rule = '<structureObjectRule id="y"><objectPath allowedObjectFlag="1">//y</objectPath></structureObjectRule>'
    created = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMP-RULEOVERRIDE"}, headers=headers)
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": VALID_RULE, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    rows = [_row(2, "BRDP-IMP-RULEOVERRIDE", rule_status="Verified", rule=other_rule)]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["rule_override"] is True

    await _apply_and_wait(client, project.id, headers, rows)
    approval_after = (await client.get(approve_url, headers=headers)).json()
    assert approval_after["rule_xml"] == other_rule  # the warned-about replacement did happen


async def test_rule_override_does_not_warn_when_rule_is_unchanged(client, editor_and_project):
    """Edge case (a): identical (or whitespace-only-different) Rule ->
    no warning, same "don't cry wolf" standard catalog_override already
    applies to Title/Definition.
    """
    project, headers, _viewer_headers = editor_and_project
    created = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMP-RULESAME"}, headers=headers)
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": VALID_RULE, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    # Same rule, but with different (irrelevant) surrounding whitespace --
    # must not count as a real difference.
    reformatted_rule = f"  {VALID_RULE}  \n"
    rows = [_row(2, "BRDP-IMP-RULESAME", rule_status="Verified", rule=reformatted_rule)]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["rule_override"] is False


async def test_rule_override_fires_on_a_whitespace_only_attribute_value_change(client, editor_and_project):
    """Real case found reimporting BRDP-EXT-01516/02609: a correction that
    only changes a run of whitespace INSIDE an attribute value (double
    space -> single space in val1) is a REAL content change and must warn
    -- the old naive `re.sub(r"\\s+", " ", ...)` over the raw string
    collapsed the significant space in the attribute right along with the
    insignificant indentation between tags, so this case went undetected.
    """
    project, headers, _viewer_headers = editor_and_project
    original_rule = (
        '<structureObjectRule id="w"><objectPath allowedObjectFlag="1" '
        'val1="SISTEMAS DE  SISTEMAS">//w</objectPath></structureObjectRule>'
    )
    corrected_rule = (
        '<structureObjectRule id="w"><objectPath allowedObjectFlag="1" '
        'val1="SISTEMAS DE SISTEMAS">//w</objectPath></structureObjectRule>'
    )
    created = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMP-ATTRWS"}, headers=headers)
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": original_rule, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    rows = [_row(2, "BRDP-IMP-ATTRWS", rule_status="Verified", rule=corrected_rule)]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["rule_override"] is True


async def test_rule_override_does_not_fire_for_indentation_only_difference(client, editor_and_project):
    """Same Rule, pretty-printed with newlines/indentation between the
    structureObjectRule and objectPath tags -- purely cosmetic whitespace
    BETWEEN elements (not inside an attribute value or real text), must
    still be ignored, same as the flat-string case
    test_rule_override_does_not_warn_when_rule_is_unchanged already covers.
    """
    project, headers, _viewer_headers = editor_and_project
    pretty_printed_rule = (
        '<structureObjectRule id="x">\n  <objectPath allowedObjectFlag="1">//x</objectPath>\n</structureObjectRule>'
    )
    created = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMP-INDENTONLY"}, headers=headers)
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": VALID_RULE, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    rows = [_row(2, "BRDP-IMP-INDENTONLY", rule_status="Verified", rule=pretty_printed_rule)]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["rule_override"] is False


DITA_RULE = '<sch:pattern><sch:rule context="task"><sch:assert role="error" id="x" test="@id">msg</sch:assert></sch:rule></sch:pattern>'
DITA_RULE_CHANGED = '<sch:pattern><sch:rule context="task"><sch:assert role="error" id="x" test="@id and @conref">msg</sch:assert></sch:rule></sch:pattern>'


async def test_dita_project_accepts_native_schematron_rule_and_verified_lands_approved(client, dita_editor_and_project):
    """Confirms the real gap this round closes: before DITA 1.3 had an
    entry in STANDARD_TO_RULE_FORMAT, ANY row bringing Rule/Rule Status
    content for a DITA project was rejected outright ("This project's
    standard has no rule format"), regardless of how well-formed the XML
    was -- no DITA BRDP could ever reach 'approved'. Also confirms the
    real Apply behavior for a Verified row: it lands as status='approved'
    directly, no separate manual approval step (docs request).
    """
    project, headers = dita_editor_and_project
    rows = [_row(2, "BRDP-DITA-001", rule_status="Verified", rule=DITA_RULE)]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok", analyzed  # would have been "rejected" before this round
    assert analyzed["action"] == "create"

    await _apply_and_wait(client, project.id, headers, rows)
    created = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    (brdp,) = created
    approval = (
        await client.get(f"/api/projects/{project.id}/brdps/{brdp['id']}/approvals/SCH-DITA", headers=headers)
    ).json()
    assert approval["rule_xml"] == DITA_RULE
    assert approval["status"] == "approved"  # Verified -> approved directly, confirmed


async def test_dita_project_todo_rule_status_still_rejects_stray_rule_content(client, dita_editor_and_project):
    """Edge case: To Do + non-empty Rule is still a rejection for DITA,
    same generic combination check BREX projects get -- nothing about
    accepting SCH-DITA loosens the well-formedness/combination rules.
    """
    project, headers = dita_editor_and_project
    rows = [_row(2, "BRDP-DITA-TODO", rule_status="To Do", rule=DITA_RULE)]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "rejected"
    assert "claims no rule exists, but one does" in analyzed["reason"]


async def test_dita_project_rejects_malformed_native_schematron(client, dita_editor_and_project):
    """The well-formedness check is generic XML validation, not BREX-shaped
    -- confirmed here with real (broken) Schematron rather than assumed.
    """
    project, headers = dita_editor_and_project
    rows = [_row(2, "BRDP-DITA-BROKEN", rule_status="Verified", rule="<sch:pattern><unclosed>")]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "rejected"
    assert "not well-formed XML" in analyzed["reason"]


async def test_dita_rule_override_fires_on_reimport_with_changed_native_schematron(client, dita_editor_and_project):
    """rule_override (today's structural-comparison fix) must work
    identically for native Schematron as it does for BREX/S1000D content
    -- no special-casing by format anywhere in _classify_row.
    """
    project, headers = dita_editor_and_project
    rows = [_row(2, "BRDP-DITA-OVERRIDE", rule_status="Verified", rule=DITA_RULE)]
    await _apply_and_wait(client, project.id, headers, rows)

    changed_rows = [_row(2, "BRDP-DITA-OVERRIDE", rule_status="Verified", rule=DITA_RULE_CHANGED)]
    analyze_resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": changed_rows}, headers=headers
    )
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["rule_override"] is True

    # And re-importing the SAME rule (only reformatted) must NOT fire --
    # same structural-not-literal comparison BREX gets.
    reformatted_rows = [_row(2, "BRDP-DITA-OVERRIDE", rule_status="Verified", rule=f"  {DITA_RULE}  \n")]
    analyze_resp2 = await client.post(
        f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": reformatted_rows}, headers=headers
    )
    (analyzed2,) = analyze_resp2.json()["results"]
    assert analyzed2["rule_override"] is False


async def test_rule_override_never_fires_for_a_new_brdp(client, editor_and_project):
    """Edge case (b): action == "create" (the BRDP doesn't exist yet) ->
    nothing to overwrite, so this must never fire regardless of the
    incoming Rule.
    """
    project, headers, _viewer_headers = editor_and_project
    rows = [_row(2, "BRDP-IMP-RULENEW", rule_status="Verified", rule=VALID_RULE)]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["action"] == "create"
    assert analyzed["rule_override"] is False


async def test_rule_override_and_catalog_override_both_fire_together(client, editor_and_project, catalog_entry):
    """Edge case (c): a row that triggers both warnings at once must show
    both, neither suppressing the other.
    """
    project, headers, _viewer_headers = editor_and_project
    other_rule = '<structureObjectRule id="z"><objectPath allowedObjectFlag="1">//z</objectPath></structureObjectRule>'
    created = (
        await client.post(
            f"/api/projects/{project.id}/brdps", json={"identifier": catalog_entry.identifier}, headers=headers
        )
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": VALID_RULE, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    rows = [
        _row(
            2,
            catalog_entry.identifier,
            title="Excel title (should be ignored)",
            definition="Excel definition (should be ignored)",
            rule_status="Verified",
            rule=other_rule,
        )
    ]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "ok"
    assert analyzed["catalog_override"] is True
    assert analyzed["rule_override"] is True


async def test_rule_override_does_not_interfere_with_existing_conflict_case(client, editor_and_project):
    """Edge case (d): the pre-existing conflict case (file says "no rule",
    a real one already exists) must keep working exactly as before --
    rule_override is meaningless there (rule_xml is empty) and must stay
    False, never masking or replacing the conflict outcome.
    """
    project, headers, _viewer_headers = editor_and_project
    created = (
        await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": "BRDP-IMP-CONFLICT3"}, headers=headers)
    ).json()
    approve_url = f"/api/projects/{project.id}/brdps/{created['id']}/approvals/BREX-4.2"
    await client.put(approve_url, json={"rule_xml": VALID_RULE, "source": "llm"}, headers=headers)
    await client.post(approve_url + "/approve", headers=headers)

    rows = [_row(2, "BRDP-IMP-CONFLICT3", rule_status="To Do", rule="")]

    analyze_resp = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    (analyzed,) = analyze_resp.json()["results"]
    assert analyzed["outcome"] == "conflict"
    assert analyzed["rule_override"] is False


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


async def test_apply_rejects_concurrent_job_for_same_project(client, editor_and_project):
    """Docs request: decide and document the concurrency behavior -- at
    most one running job per project, a second Apply while one is
    in-flight is rejected outright (409) rather than silently interleaved
    (two jobs racing on the same identifiers could double-create or lose
    an update on the same BRDP). Simulated here with a running ImportJob
    row inserted directly: the real background task actually completes
    synchronously before `await client.post(.../apply)` returns under the
    test client's ASGITransport (see _apply_and_wait's docstring), so a
    genuinely in-flight job can't be produced through the real endpoint
    within a single test.
    """
    project, headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        session.add(ImportJob(project_id=project.id, status="running", total_rows=1))
        await session.commit()

    rows = [_row(2, "BRDP-IMP-CONCURRENT", rule_status="To Do", rule="")]
    resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )
    assert resp.status_code == 409
    assert "already running" in resp.json()["detail"]

    # The second request was rejected before doing anything -- nothing written.
    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=headers)
    assert listed.json() == []


async def test_status_active_returns_the_running_job_for_the_project(client, editor_and_project):
    """Docs request: any page that loads can ask "is an import running"
    without knowing a job_id in advance -- covers navigating away and
    back, reloading, or reopening the app later.
    """
    project, headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        job = ImportJob(project_id=project.id, status="running", total_rows=5, processed_rows=2, validated_rows_total=1)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        job_id = job.id

    resp = await client.get(f"/api/projects/{project.id}/brdps/import/status/active", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body is not None
    assert body["id"] == str(job_id)
    assert body["status"] == "running"
    assert body["processed_rows"] == 2
    assert body["total_rows"] == 5


async def test_status_active_returns_null_when_no_job_ever_existed(client, editor_and_project):
    project, headers, _viewer_headers = editor_and_project
    resp = await client.get(f"/api/projects/{project.id}/brdps/import/status/active", headers=headers)
    assert resp.status_code == 200
    assert resp.json() is None


async def test_status_active_returns_the_finished_job_after_it_completes(client, editor_and_project):
    """The literal reported scenario (docs request): close the tab while
    an import is running, reopen the app later -- the job already
    finished by then, so /status/active must still surface its final
    result rather than silently going back to null the moment the job
    leaves "running". This is what get_most_recent_job (not
    get_running_job) buys: the most recent job for the project regardless
    of terminal state.
    """
    project, headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        job = ImportJob(
            project_id=project.id,
            status="completed",
            total_rows=3,
            processed_rows=3,
            validated_rows_total=1,
            result={"created": 3, "updated": 0, "rejected": 0, "conflicts_kept": 0, "conflicts_cleared": 0},
        )
        session.add(job)
        await session.commit()

    resp = await client.get(f"/api/projects/{project.id}/brdps/import/status/active", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body is not None
    assert body["status"] == "completed"
    assert body["result"]["created"] == 3


async def test_status_job_id_rejects_a_job_from_another_project(client, editor_and_project):
    """A job_id is meaningless outside its own project -- confirms
    /status/{job_id} checks job.project_id against the URL's project_id
    rather than trusting the id alone (a viewer of project A must not be
    able to peek at project B's import progress just by guessing a UUID).
    """
    project, headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        other_project = Project(name="Other Project", standard="S1000D 4.2")
        session.add(other_project)
        await session.flush()
        job = ImportJob(project_id=other_project.id, status="completed", total_rows=1, processed_rows=1)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        job_id = job.id
        other_project_id = other_project.id

    try:
        resp = await client.get(f"/api/projects/{project.id}/brdps/import/status/{job_id}", headers=headers)
        assert resp.status_code == 404
    finally:
        async with async_session_factory() as session:
            db_job = await session.get(ImportJob, job_id)
            if db_job is not None:
                await session.delete(db_job)
            db_project = await session.get(Project, other_project_id)
            if db_project is not None:
                await session.delete(db_project)
            await session.commit()


async def test_embedding_failure_mid_job_marks_job_failed_and_rolls_back_everything(client, editor_and_project):
    """HR7: a mid-job failure must be visible and explained, never a
    silent degradation, and must never leave rows in an ambiguous partial
    state -- the whole job's writes are one Postgres transaction,
    uncommitted until the very end, so a failure on a LATER row rolls back
    an EARLIER row's otherwise-successful create too. Simulated here
    (this sandbox has no route to api.mistral.ai) with a mock transport
    that fails the embedding call outright, exactly the shape a real
    Mistral outage would take.
    """
    project, headers, _viewer_headers = editor_and_project
    rows = [
        _row(2, "BRDP-IMP-FAIL-A", proposal_status="Pending", rule_status="To Do", rule=""),
        _row(3, "BRDP-IMP-FAIL-B", proposal_status="Validated", rule_status="To Do", rule=""),
    ]

    def failing_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"error": "simulated Mistral outage"})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(failing_handler)

    body = await _apply_and_wait(client, project.id, headers, rows)

    assert body["status"] == "failed"
    assert body["error"]
    assert body["result"] is None

    listed = await client.get(f"/api/projects/{project.id}/brdps", headers=headers)
    assert listed.json() == []  # BRDP-IMP-FAIL-A's otherwise-successful create rolled back too


async def test_run_import_job_marks_failed_on_cancellation(editor_and_project):
    """Confirmed real (not hypothetical) root cause: asyncio.CancelledError
    has inherited from BaseException, not Exception, since Python 3.8 --
    the plain `except Exception` in run_import_job never saw it, so a real
    interruption (a dev --reload restart mid-job, or a Ctrl+C/SIGTERM)
    left the import_jobs row 'running' forever, which permanently blocked
    every future Apply on that project via get_running_job's 409 -- there
    was no way to recover short of editing Postgres by hand. Cancels the
    coroutine directly (BackgroundTasks isn't reachable from a test) to
    exercise the exact `except asyncio.CancelledError` branch, and confirms
    the row is left 'failed' with a clear message instead of abandoned --
    and that a fresh Apply is no longer blocked afterward.
    """
    project, _editor_headers, _viewer_headers = editor_and_project
    async with async_session_factory() as session:
        editor_role = (
            await session.execute(
                select(UserProjectRole).where(
                    UserProjectRole.project_id == project.id, UserProjectRole.role == "editor"
                )
            )
        ).scalar_one()
        editor_id = editor_role.user_id

        job = ImportJob(project_id=project.id, status="running", total_rows=1)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        job_id = job.id

    rows = [ImportRowIn(row_number=2, identifier="BRDP-IMP-CANCEL", proposal_status="Validated")]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": [0.1] * 1024, "index": 0}]})

    task = asyncio.ensure_future(
        run_import_job(job_id, project.id, rows, "keep", editor_id, httpx.MockTransport(handler))
    )
    await asyncio.sleep(0)  # let the coroutine actually start (reach its first real await)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    async with async_session_factory() as session:
        db_job = await session.get(ImportJob, job_id)
        assert db_job.status == "failed"
        assert "interrupted" in db_job.error.lower()

        # No longer a phantom blocker -- a fresh Apply attempt would go through.
        assert await get_running_job(project.id, session) is None


async def test_apply_allows_new_import_after_stale_running_job_and_marks_it_failed(client, editor_and_project):
    """The cheap fallback for a hard crash that never runs any cleanup
    code (a real process kill, simulated here the only way this sandbox
    can -- inserting the stale row directly, since actually crashing the
    test's own backend isn't possible from within a test): a `running` job
    older than STALE_JOB_MINUTES no longer blocks a new Apply, and gets
    marked `failed` in the same request rather than left dangling.
    """
    project, headers, _viewer_headers = editor_and_project
    stale_started_at = datetime.now(timezone.utc) - timedelta(minutes=STALE_JOB_MINUTES + 1)
    async with async_session_factory() as session:
        job = ImportJob(project_id=project.id, status="running", total_rows=1, started_at=stale_started_at)
        session.add(job)
        await session.commit()
        await session.refresh(job)
        stale_job_id = job.id

    rows = [_row(2, "BRDP-IMP-AFTER-STALE", rule_status="To Do", rule="")]
    resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )
    assert resp.status_code == 202  # not 409 -- the stale job no longer counts as blocking

    async with async_session_factory() as session:
        stale_job = await session.get(ImportJob, stale_job_id)
        assert stale_job.status == "failed"
        assert str(STALE_JOB_MINUTES) in stale_job.error
        assert stale_job.finished_at is not None


async def test_apply_still_blocks_on_a_running_job_under_the_staleness_threshold(client, editor_and_project):
    """No false positives: a job that's genuinely still running, well
    under STALE_JOB_MINUTES old, must keep blocking a concurrent Apply
    exactly as it does today.
    """
    project, headers, _viewer_headers = editor_and_project
    recent_started_at = datetime.now(timezone.utc) - timedelta(minutes=5)
    async with async_session_factory() as session:
        session.add(ImportJob(project_id=project.id, status="running", total_rows=1, started_at=recent_started_at))
        await session.commit()

    rows = [_row(2, "BRDP-IMP-STILL-BLOCKED", rule_status="To Do", rule="")]
    resp = await client.post(
        f"/api/projects/{project.id}/brdps/import/apply",
        json={"rows": rows, "conflict_resolution": "keep"},
        headers=headers,
    )
    assert resp.status_code == 409


async def test_status_active_reaps_a_stale_running_job_on_its_own(client, editor_and_project):
    """GET /status/active (get_most_recent_job) must self-heal a stale
    `running` row on the very next poll, not just after some later Apply
    attempt happens to trigger the fix via get_running_job -- a page
    polling this endpoint alone must see the job flip to `failed`.
    """
    project, headers, _viewer_headers = editor_and_project
    stale_started_at = datetime.now(timezone.utc) - timedelta(minutes=STALE_JOB_MINUTES + 30)
    async with async_session_factory() as session:
        job = ImportJob(project_id=project.id, status="running", total_rows=1, started_at=stale_started_at)
        session.add(job)
        await session.commit()

    resp = await client.get(f"/api/projects/{project.id}/brdps/import/status/active", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert str(STALE_JOB_MINUTES) in body["error"]
