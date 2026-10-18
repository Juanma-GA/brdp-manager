"""Export to Excel with cells over Excel's 32,767-character limit, without
losing data ("Exportar a Excel con celdas demasiado largas sin perder
datos").

A cell over the limit is never cut: the export writes the fixed
OMITTED_CELL_MARKER (excel_io.py) in its place and names it in the
X-Export-Omitted-Cells header; the import reads a cell that is exactly the
marker as "this field is unchanged" (import_jobs.resolve_omitted_cells).
Real Postgres (the test database), real export, parse, analyze and apply
endpoints -- the file goes through openpyxl as the user's would.

The real case: BRDP-EXT-00183 of "Official Default S1000D 4.2 - 001", a
Rule of 83,921 characters.
"""
import io
import json
import uuid
import zipfile

import pytest
from sqlalchemy import select

from app.api.routes.excel import _OMITTED_CELLS_HEADER_MAX_BYTES, omitted_cells_header
from app.core.config import EXCEL_CELL_CHAR_LIMIT
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, BRDPHistory, Project, RuleApproval, User, UserProjectRole
from app.services.excel_io import OMITTED_CELL_MARKER, _workbook_bytes, build_export

FORMAT = "BREX-4.2"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _long_rule(identifier: str, length: int) -> str:
    """A well-formed rule of exactly `length` characters: a value list long
    enough, padded inside the objectUse."""
    head = f'<structureObjectRule id="{identifier}"><objectPath allowedObjectFlag="2">//@infoCode</objectPath><objectUse>'
    values = "".join(f'<objectValue valueForm="single" valueAllowed="{n:03d}">Code {n:03d}</objectValue>' for n in range(1000))
    tail = "</objectUse>" + values + "</structureObjectRule>"
    pad = length - len(head) - len(tail)
    assert pad > 0
    return head + "x" * pad + tail


LONG_RULE = _long_rule("BRDP-EXT-00183", 83921)
SHORT_RULE = '<structureObjectRule id="BRDP-OC-002"><objectPath allowedObjectFlag="0">//emphasis</objectPath><objectUse>No emphasis.</objectUse></structureObjectRule>'
LONG_DEFINITION = "Definition. " + "d" * 40000
LONG_PROPOSAL = "Proposal. " + "p" * 35000


@pytest.fixture
async def project_with_long_cells(client):
    """BRDP-EXT-00183: Verified rule of 83,921 characters, with a recorded
    test. BRDP-OC-002: Definition and Proposal over the limit (stored
    directly: older data, the API limits new text to 32,767), short Draft
    rule. BRDP-OC-003: nothing long, no rule."""
    async with async_session_factory() as session:
        project = Project(name=f"Omitted cells {uuid.uuid4()}", standard="S1000D 4.2")
        editor = User(
            email=f"omitted-cells-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Omitted Cells Editor",
            global_role="user",
        )
        session.add_all([project, editor])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        long_rule_brdp = BRDP(project_id=project.id, identifier="BRDP-EXT-00183", title="Information codes", definition="Which codes.", proposal="Allowed codes.", validation="Validated")
        long_text_brdp = BRDP(project_id=project.id, identifier="BRDP-OC-002", title="Long texts", definition=LONG_DEFINITION, proposal=LONG_PROPOSAL, validation="Pending")
        plain_brdp = BRDP(project_id=project.id, identifier="BRDP-OC-003", title="Plain", definition="Short.", proposal="Short proposal.", validation="Pending")
        session.add_all([long_rule_brdp, long_text_brdp, plain_brdp])
        await session.flush()
        session.add_all([
            RuleApproval(brdp_id=long_rule_brdp.id, format=FORMAT, rule_xml=LONG_RULE, status="approved", source="extracted",
                         last_test_result="passed", last_test_rule_hash="abc"),
            RuleApproval(brdp_id=long_text_brdp.id, format=FORMAT, rule_xml=SHORT_RULE, status="pending_review", source="manual"),
        ])
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)
    headers = {"Authorization": f"Bearer {create_access_token(editor.id)}"}
    yield project, headers

    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
        db_user = await session.get(User, editor.id)
        if db_user is not None:
            await session.delete(db_user)
        await session.commit()


async def _state(project_id) -> dict:
    """Everything the import could touch, per identifier."""
    async with async_session_factory() as session:
        brdps = (await session.execute(select(BRDP).where(BRDP.project_id == project_id))).scalars().all()
        approvals = (await session.execute(select(RuleApproval).join(BRDP).where(BRDP.project_id == project_id))).scalars().all()
        by_brdp = {a.brdp_id: a for a in approvals}
        history = (await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id.in_([b.id for b in brdps])))).scalars().all()
        state = {}
        for b in brdps:
            a = by_brdp.get(b.id)
            state[b.identifier] = {
                "title": b.title, "definition": b.definition, "proposal": b.proposal, "validation": b.validation,
                "rule": None if a is None else (a.rule_xml, a.status, a.source, a.approved_at, a.last_test_result, a.last_test_rule_hash),
            }
        state["_history"] = sorted((h.brdp_id.hex, h.field_name, h.new_value[:40]) for h in history)
        return state


async def _export(client, project, headers):
    """The file the page would download (rows as brdpToExportRow builds
    them), and the parse endpoint's rows."""
    brdps = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    approvals = (await client.get(f"/api/projects/{project.id}/approvals/{FORMAT}/export", headers=headers)).json()
    by_brdp = {a["brdp_id"]: a for a in approvals}
    labels = {"pending_review": "Draft", "approved": "Verified"}
    rows = []
    for b in sorted(brdps, key=lambda b: b["identifier"]):
        a = by_brdp.get(b["id"])
        rows.append({
            "id": b["identifier"], "title": b["title"], "definition": b["definition"], "proposal": b["proposal"],
            "proposalStatus": b["validation"], "ruleStatus": labels[a["status"]] if a else "To Do",
            "rule": a["rule_xml"] if a else "", "catalogEdition": "",
        })
    xlsx = await client.post(f"/api/projects/{project.id}/export.xlsx", json={"rows": rows}, headers=headers)
    assert xlsx.status_code == 200, xlsx.text
    parsed = await client.post(f"/api/projects/{project.id}/brdps/import/parse", files={"file": ("export.xlsx", xlsx.content, XLSX)}, headers=headers)
    assert parsed.status_code == 200, parsed.text
    assert parsed.json()["errors"] == []
    return xlsx, parsed.json()["rows"]


async def _analyze(client, project, headers, rows):
    res = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    assert res.status_code == 200, res.text
    return {r["identifier"]: r for r in res.json()["results"]}


async def _apply(client, project, headers, rows):
    res = await client.post(f"/api/projects/{project.id}/brdps/import/apply", json={"rows": rows, "conflict_resolution": "keep"}, headers=headers)
    assert res.status_code == 202, res.text
    body = (await client.get(f"/api/projects/{project.id}/brdps/import/status/{res.json()['job_id']}", headers=headers)).json()
    assert body["status"] == "completed", body
    return body["result"]


def _row(rows, identifier):
    return next(r for r in rows if r["identifier"] == identifier)


# ─── Export ──────────────────────────────────────────────────────────────


def test_marker_is_a_fixed_text_well_under_the_limit():
    assert OMITTED_CELL_MARKER == "[[BRDP-MANAGER: NO EXPORTADO — supera 32.767 caracteres; se conserva el de la app]]"
    assert len(OMITTED_CELL_MARKER) < EXCEL_CELL_CHAR_LIMIT


def test_a_cell_of_exactly_the_limit_is_exported_complete_and_one_more_is_not():
    at_limit = {"id": "A", "rule": "x" * EXCEL_CELL_CHAR_LIMIT}
    over = {"id": "B", "rule": "x" * (EXCEL_CELL_CHAR_LIMIT + 1)}
    _data, omitted = build_export([at_limit])
    assert omitted == []
    _data, omitted = build_export([at_limit, over])
    assert omitted == [{"id": "B", "field": "Rule", "length": EXCEL_CELL_CHAR_LIMIT + 1}]


def test_a_project_without_long_cells_gets_the_same_file_as_before():
    rows = [{"id": "A", "title": "T", "definition": "D", "proposal": "P", "proposalStatus": "Pending", "ruleStatus": "Draft", "rule": SHORT_RULE}]
    data, omitted = build_export(rows)
    assert omitted == []

    def sheet_parts(xlsx):
        with zipfile.ZipFile(io.BytesIO(xlsx)) as z:
            return {name: z.read(name) for name in z.namelist() if name.startswith("xl/")}

    # Same writer, same sheet and strings byte for byte (only the creation
    # time in docProps differs between two writes).
    assert sheet_parts(data) == sheet_parts(_workbook_bytes(rows))


def test_header_lists_every_cell_or_says_how_many_did_not_fit():
    few = [{"id": f"BRDP-EXT-{n:05d}", "field": "Rule", "length": 40000} for n in range(3)]
    assert json.loads(omitted_cells_header(few)) == {"total": 3, "cells": [{"id": c["id"], "field": "Rule"} for c in few]}
    many = [{"id": f"BRDP-EXT-{n:05d}", "field": "Definition", "length": 40000} for n in range(500)]
    value = omitted_cells_header(many)
    parsed = json.loads(value)
    assert len(value) <= _OMITTED_CELLS_HEADER_MAX_BYTES
    assert parsed["total"] == 500 and 0 < len(parsed["cells"]) < 500
    assert parsed["cells"] == [{"id": c["id"], "field": "Definition"} for c in many[: len(parsed["cells"])]]
    # Non-ASCII identifiers stay ASCII in the header (a header is latin-1).
    assert omitted_cells_header([{"id": "BRDP-Ñ-1", "field": "Rule", "length": 1}]).isascii()


async def test_export_ext_00183_names_it_and_writes_the_marker(client, project_with_long_cells):
    project, headers = project_with_long_cells
    xlsx, rows = await _export(client, project, headers)
    assert json.loads(xlsx.headers["x-export-omitted-cells"]) == {
        "total": 3,
        "cells": [
            {"id": "BRDP-EXT-00183", "field": "Rule"},
            {"id": "BRDP-OC-002", "field": "Definition"},
            {"id": "BRDP-OC-002", "field": "Proposal"},
        ],
    }
    assert len(LONG_RULE) == 83921
    assert _row(rows, "BRDP-EXT-00183")["rule"] == OMITTED_CELL_MARKER
    assert _row(rows, "BRDP-EXT-00183")["rule_status"] == "Verified"
    assert _row(rows, "BRDP-OC-002")["definition"] == OMITTED_CELL_MARKER
    assert _row(rows, "BRDP-OC-002")["proposal"] == OMITTED_CELL_MARKER
    assert _row(rows, "BRDP-OC-002")["rule"] == SHORT_RULE
    assert _row(rows, "BRDP-OC-003")["proposal"] == "Short proposal."


# ─── Import ──────────────────────────────────────────────────────────────


async def test_reimporting_the_export_untouched_changes_nothing(client, project_with_long_cells):
    project, headers = project_with_long_cells
    before = await _state(project.id)
    _xlsx, rows = await _export(client, project, headers)
    results = await _analyze(client, project, headers, rows)
    assert all(r["outcome"] == "ok" and r["unchanged"] and not r["rule_override"] for r in results.values())
    assert results["BRDP-EXT-00183"]["rule_kept"] and results["BRDP-EXT-00183"]["omitted_kept"] == ["Rule"]
    assert results["BRDP-OC-002"]["omitted_kept"] == ["Definition", "Proposal"]
    assert all(r["omitted_ignored"] == [] for r in results.values())
    # "Rules: 0 change".
    assert sum(r["rule_override"] for r in results.values()) == 0

    result = await _apply(client, project, headers, rows)
    assert result["unchanged"] == 3 and result["updated"] == 0 and result["created"] == 0
    assert await _state(project.id) == before


async def test_marker_rule_with_another_changed_field_changes_only_that_field(client, project_with_long_cells):
    project, headers = project_with_long_cells
    before = await _state(project.id)
    _xlsx, rows = await _export(client, project, headers)
    _row(rows, "BRDP-EXT-00183")["proposal"] = "Allowed codes, revised."
    results = await _analyze(client, project, headers, rows)
    r = results["BRDP-EXT-00183"]
    assert not r["unchanged"] and r["rule_kept"] and not r["rule_override"]

    await _apply(client, project, headers, rows)
    after = await _state(project.id)
    assert after["BRDP-EXT-00183"]["proposal"] == "Allowed codes, revised."
    # Rule, Rule Status, source, test: untouched.
    assert after["BRDP-EXT-00183"]["rule"] == before["BRDP-EXT-00183"]["rule"]
    assert {k: v for k, v in after.items() if k not in ("BRDP-EXT-00183", "_history")} == {
        k: v for k, v in before.items() if k not in ("BRDP-EXT-00183", "_history")
    }
    # The only history entry is the Proposal.
    new_history = [h for h in after["_history"] if h not in before["_history"]]
    assert [h[1] for h in new_history] == ["proposal"]


async def test_marker_in_definition_and_proposal_behaves_as_in_rule(client, project_with_long_cells):
    project, headers = project_with_long_cells
    before = await _state(project.id)
    _xlsx, rows = await _export(client, project, headers)
    _row(rows, "BRDP-OC-002")["title"] = "Long texts, renamed"
    await _apply(client, project, headers, rows)
    after = await _state(project.id)
    assert after["BRDP-OC-002"]["title"] == "Long texts, renamed"
    assert after["BRDP-OC-002"]["definition"] == LONG_DEFINITION
    assert after["BRDP-OC-002"]["proposal"] == LONG_PROPOSAL
    assert after["BRDP-OC-002"]["rule"] == before["BRDP-OC-002"]["rule"]
    new_history = [h for h in after["_history"] if h not in before["_history"]]
    assert [h[1] for h in new_history] == ["title"]


async def test_marker_in_a_new_row_is_ignored_with_a_warning(client, project_with_long_cells):
    project, headers = project_with_long_cells
    _xlsx, rows = await _export(client, project, headers)
    new_row = dict(_row(rows, "BRDP-EXT-00183"), identifier="BRDP-EXT-00999", row_number=99, title=OMITTED_CELL_MARKER)
    rows.append(new_row)
    r = (await _analyze(client, project, headers, rows))["BRDP-EXT-00999"]
    assert r["outcome"] == "ok" and r["action"] == "create"
    assert r["omitted_ignored"] == ["Title", "Rule"] and r["omitted_kept"] == []
    assert not r["rule_new"]

    await _apply(client, project, headers, rows)
    after = await _state(project.id)
    assert after["BRDP-EXT-00999"]["title"] == ""
    assert after["BRDP-EXT-00999"]["rule"] is None
    assert OMITTED_CELL_MARKER not in json.dumps(after, default=str)


async def test_marker_rule_for_a_brdp_without_rule_is_ignored(client, project_with_long_cells):
    project, headers = project_with_long_cells
    _xlsx, rows = await _export(client, project, headers)
    row = _row(rows, "BRDP-OC-003")
    row.update(rule=OMITTED_CELL_MARKER, rule_status="Draft")
    r = (await _analyze(client, project, headers, rows))["BRDP-OC-003"]
    assert r["outcome"] == "ok" and r["omitted_ignored"] == ["Rule"] and r["unchanged"]
    await _apply(client, project, headers, rows)
    assert (await _state(project.id))["BRDP-OC-003"]["rule"] is None


async def test_an_edited_marker_is_an_ordinary_value(client, project_with_long_cells):
    project, headers = project_with_long_cells
    _xlsx, rows = await _export(client, project, headers)
    edited = OMITTED_CELL_MARKER + " (edited)"
    _row(rows, "BRDP-OC-002")["proposal"] = edited
    _row(rows, "BRDP-EXT-00183")["rule"] = OMITTED_CELL_MARKER.lower()
    results = await _analyze(client, project, headers, rows)
    assert results["BRDP-OC-002"]["omitted_kept"] == ["Definition"] and not results["BRDP-OC-002"]["unchanged"]
    # Not exactly the marker: read as the Rule text it is, like any other
    # Rule cell -- a different rule, shown as "changes".
    assert results["BRDP-EXT-00183"]["outcome"] == "ok"
    assert results["BRDP-EXT-00183"]["rule_override"] and not results["BRDP-EXT-00183"]["rule_kept"]
    assert results["BRDP-EXT-00183"]["omitted_kept"] == []

    await _apply(client, project, headers, rows)
    assert (await _state(project.id))["BRDP-OC-002"]["proposal"] == edited
