"""Excel import of an official identifier that the catalog of the project's
standard does not have but another S1000D edition's does (as AI Extract's
"From catalog (S1000D 4.1)"): the row imports with its identifier, that
edition's Title/Definition, a warning and one History entry. The catalog
rows use identifiers BRDP-S1-9xxxx, far above any real catalog number, so
the tests do not depend on which real catalogs are loaded."""

import json
import random
import uuid

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, BRDPHistory, Project, User, UserProjectRole
from tests.test_brdp_import import _apply_and_wait, _row
from tests.test_rule_extract import _brex, _extract, _ref_rule


def _ids(n):
    numbers = random.sample(range(90000, 100000), n)
    return [f"BRDP-S1-{x:05d}" for x in numbers]


def _own(standard):
    """One catalog row of the project's own standard: "its catalog is
    loaded", the precondition of the other-edition lookup."""
    (filler,) = _ids(1)
    return (standard, filler, "own", "d")


@pytest.fixture
async def catalog_rows():
    """Seeds catalog rows: list of (standard, identifier, title, definition);
    removes them afterwards."""
    created = []

    async def seed(entries):
        async with async_session_factory() as session:
            for standard, identifier, title, definition in entries:
                row = BRDPCatalog(standard=standard, identifier=identifier, title=title, definition=definition)
                session.add(row)
                created.append(row)
            await session.commit()

    yield seed
    async with async_session_factory() as session:
        for row in created:
            obj = await session.get(BRDPCatalog, row.id)
            if obj is not None:
                await session.delete(obj)
        await session.commit()


@pytest.fixture
async def make_project():
    made = []

    async def make(standard):
        async with async_session_factory() as session:
            project = Project(name=f"Edition Import {uuid.uuid4()}", standard=standard)
            editor = User(email=f"ed-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="Ed", global_role="user")
            session.add_all([project, editor])
            await session.flush()
            session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
            await session.commit()
            await session.refresh(project)
            made.append((project.id, editor.id))
        return project, {"Authorization": f"Bearer {create_access_token(editor.id)}"}

    yield make
    async with async_session_factory() as session:
        for project_id, user_id in made:
            for model, oid in ((Project, project_id), (User, user_id)):
                obj = await session.get(model, oid)
                if obj is not None:
                    await session.delete(obj)
        await session.commit()


async def _analyze(client, project, headers, rows):
    res = await client.post(f"/api/projects/{project.id}/brdps/import/analyze", json={"rows": rows}, headers=headers)
    assert res.status_code == 200, res.text
    return {r["identifier"]: r for r in res.json()["results"]}


async def _history(brdp_id, field):
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(BRDPHistory.new_value).where(BRDPHistory.brdp_id == brdp_id, BRDPHistory.field_name == field)
            )
        ).scalars().all()
    return list(rows)


async def _brdps(client, project, headers):
    return {b["identifier"]: b for b in (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()}


async def test_identifier_only_in_another_edition_imports_with_its_texts_warning_and_history(
    client, make_project, catalog_rows
):
    own, other, nowhere = _ids(3)
    await catalog_rows([
        ("S1000D 4.2", own, "Own title", "Own definition"),
        ("S1000D 4.1", other, "4.1 title", "4.1 definition"),
    ])
    project, headers = await make_project("S1000D 4.2")
    rows = [
        _row(2, own, title="Own title", definition="Own definition"),
        _row(3, other, title="Excel title", definition="Excel definition", proposal="Excel proposal", proposal_status="Validated"),
        _row(4, nowhere, title="Nowhere title"),
        _row(5, "", title="no id"),
    ]
    analyzed = await _analyze(client, project, headers, rows)
    # In the project's own catalog: as today, no edition warning.
    assert analyzed[own]["catalog_edition"] is None and analyzed[own]["catalog_override"] is False
    # Only in 4.1: imports (never rejected), with the edition, retired in 4.2,
    # and the substitution warning since the Excel texts differ.
    assert analyzed[other]["outcome"] == "ok"
    assert analyzed[other]["catalog_edition"] == "S1000D 4.1"
    assert analyzed[other]["catalog_edition_retired"] is True
    assert analyzed[other]["catalog_override"] is True
    # In no catalog: as today.
    assert analyzed[nowhere]["catalog_edition"] is None and analyzed[nowhere]["catalog_override"] is False

    job = await _apply_and_wait(client, project.id, headers, rows)
    assert job["status"] == "completed" and job["result"]["created"] == 3
    brdps = await _brdps(client, project, headers)
    # Identifier kept as is; Title/Definition from 4.1; Proposal and status from the Excel.
    b = brdps[other]
    assert (b["title"], b["definition"], b["proposal"], b["validation"]) == (
        "4.1 title", "4.1 definition", "Excel proposal", "Validated",
    )
    assert brdps[nowhere]["title"] == "Nowhere title"
    events = await _history(uuid.UUID(b["id"]), "catalog_edition")
    assert [json.loads(e) for e in events] == [{"catalog_edition": "S1000D 4.1", "catalog_standard": "S1000D 4.2"}]
    assert await _history(uuid.UUID(brdps[own]["id"]), "catalog_edition") == []

    # Re-importing the same file (as after Export to Excel): nothing changes,
    # no second History entry.
    analyzed = await _analyze(client, project, headers, [_row(3, other, title="4.1 title", definition="4.1 definition",
                                                               proposal="Excel proposal", proposal_status="Validated")])
    assert analyzed[other]["unchanged"] is True and analyzed[other]["catalog_edition"] == "S1000D 4.1"
    assert analyzed[other]["catalog_override"] is False
    job = await _apply_and_wait(client, project.id, headers, rows)
    assert job["result"]["created"] == 0
    # A Proposal change re-writes the texts but never repeats the event.
    rows[1]["proposal"] = "Changed proposal"
    await _apply_and_wait(client, project.id, headers, rows)
    assert len(await _history(uuid.UUID(b["id"]), "catalog_edition")) == 1


async def test_empty_excel_texts_are_filled_from_the_other_edition(client, make_project, catalog_rows):
    (other,) = _ids(1)
    await catalog_rows([_own("S1000D 4.2"), ("S1000D 4.1", other, "4.1 title", "4.1 definition")])
    project, headers = await make_project("S1000D 4.2")
    rows = [_row(2, other, title="", definition="")]
    analyzed = await _analyze(client, project, headers, rows)
    assert analyzed[other]["catalog_edition"] == "S1000D 4.1"
    await _apply_and_wait(client, project.id, headers, rows)
    b = (await _brdps(client, project, headers))[other]
    assert (b["title"], b["definition"]) == ("4.1 title", "4.1 definition")


async def test_existing_brdp_keeps_today_rule_and_still_shows_the_edition(client, make_project, catalog_rows):
    (other,) = _ids(1)
    await catalog_rows([_own("S1000D 4.2"), ("S1000D 4.1", other, "4.1 title", "4.1 definition")])
    project, headers = await make_project("S1000D 4.2")
    async with async_session_factory() as session:
        brdp = BRDP(project_id=project.id, identifier=other, title="Old", definition="Old", proposal="Old", validation="Pending")
        session.add(brdp)
        await session.commit()
        brdp_id = brdp.id
    rows = [_row(2, other, title="Excel", definition="Excel", proposal="New")]
    analyzed = await _analyze(client, project, headers, rows)
    assert analyzed[other]["action"] == "update" and analyzed[other]["catalog_edition"] == "S1000D 4.1"
    job = await _apply_and_wait(client, project.id, headers, rows)
    assert job["result"]["updated"] == 1
    b = (await _brdps(client, project, headers))[other]
    assert (b["title"], b["proposal"]) == ("4.1 title", "New")
    assert len(await _history(brdp_id, "catalog_edition")) == 1


async def test_closest_edition_and_newer_edition_in_an_older_project(client, make_project, catalog_rows):
    a, b = _ids(2)
    await catalog_rows([
        _own("S1000D 4.1"),
        # a: in 3.0.1 and 4.2 → for a 4.1 project, 4.2 is the closest (0.1 vs 1.0x).
        ("S1000D 3.0.1", a, "3.0.1 title", "d"),
        ("S1000D 4.2", a, "4.2 title", "d"),
        # b: only in 4.2.
        ("S1000D 4.2", b, "4.2 b", "d"),
    ])
    project, headers = await make_project("S1000D 4.1")
    analyzed = await _analyze(client, project, headers, [_row(2, a), _row(3, b)])
    assert analyzed[a]["catalog_edition"] == "S1000D 4.2"
    assert analyzed[b]["catalog_edition"] == "S1000D 4.2"
    # A newer edition: the decision was not retired, it is in 4.2.
    assert analyzed[b]["catalog_edition_retired"] is False


async def test_tie_picks_the_most_recent_edition(client, make_project, catalog_rows):
    (x,) = _ids(1)
    # 4.0 project (synthetic name, still an S1000D edition): 3.9 and 4.1 at
    # the same distance → 4.1.
    (filler,) = _ids(1)
    await catalog_rows([
        ("S1000D 4.0", filler, "own", "d"),  # the project's standard has a catalog
        ("S1000D 3.9", x, "3.9", "d"),
        ("S1000D 4.1", x, "4.1", "d"),
    ])
    project, headers = await make_project("S1000D 4.0")
    analyzed = await _analyze(client, project, headers, [_row(2, x)])
    assert analyzed[x]["catalog_edition"] == "S1000D 4.1"


async def test_no_catalog_for_the_project_standard_means_no_edition_lookup(client, make_project, catalog_rows):
    """A standard with no catalog loaded at all (here a synthetic S1000D
    3.8): "not in its catalog" cannot be told from "catalog not loaded", so
    the row imports as today, with the Excel's texts and no warning."""
    (x,) = _ids(1)
    await catalog_rows([("S1000D 4.1", x, "4.1 title", "d")])
    project, headers = await make_project("S1000D 3.8")
    analyzed = await _analyze(client, project, headers, [_row(2, x, title="Excel title")])
    assert analyzed[x]["catalog_edition"] is None and analyzed[x]["catalog_override"] is False


async def test_dita_ext_and_other_specification_unchanged(client, make_project, catalog_rows):
    (s1,) = _ids(1)
    s2 = s1.replace("BRDP-S1-", "BRDP-S2-")
    ext = s1.replace("BRDP-S1-", "BRDP-EXT-")
    await catalog_rows([
        ("S1000D 4.1", s1, "4.1", "d"),
        ("S1000D 4.1", s2, "4.1", "d"),
        ("S1000D 4.1", ext, "4.1", "d"),
    ])
    dita, dheaders = await make_project("DITA 1.3 Xpath2.0")
    analyzed = await _analyze(client, dita, dheaders, [_row(2, s1)])
    assert analyzed[s1]["catalog_edition"] is None and analyzed[s1]["catalog_override"] is False
    project, headers = await make_project("S1000D 4.2")
    analyzed = await _analyze(client, project, headers, [_row(2, s2), _row(3, ext)])
    assert analyzed[s2]["catalog_edition"] is None and analyzed[ext]["catalog_edition"] is None


async def test_ai_extract_finds_the_excel_import_and_the_excel_finds_ai_extract(client, make_project, catalog_rows):
    """Excel → AI Extract: the BREX rule of a BRDP imported from Excel with
    the edition mark reads "Already exists". AI Extract → Excel: a BRDP
    imported by AI Extract as "From catalog (S1000D 4.1)" is an update for
    the Excel, and its History event is not repeated."""
    from_excel, from_extract = _ids(2)
    await catalog_rows([
        _own("S1000D 4.2"),
        ("S1000D 4.1", from_excel, "4.1 A", "d A"),
        ("S1000D 4.1", from_extract, "4.1 B", "d B"),
    ])
    project, headers = await make_project("S1000D 4.2")
    await _apply_and_wait(client, project.id, headers, [_row(2, from_excel)])

    content = _ref_rule(from_excel, "Use A.", "//a") + _ref_rule(from_extract, "Use B.", "//b")
    job, cands = await _extract(client, project.id, headers, _brex("4.2", content))
    by_origin = {c["origin_identifier"]: c for c in cands}
    assert by_origin[from_excel]["classification"] in ("same", "changed")
    assert by_origin[from_extract]["classification"] == "catalog_edition"

    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await client.post(f"{url}/apply", headers=headers, json={"keys": [by_origin[from_extract]["key"]]})
    assert res.status_code == 200, res.text
    analyzed = await _analyze(client, project, headers, [_row(2, from_extract, title="4.1 B", definition="d B", proposal="Changed")])
    assert analyzed[from_extract]["action"] == "update"
    assert analyzed[from_extract]["catalog_edition"] == "S1000D 4.1"
    await _apply_and_wait(client, project.id, headers, [_row(2, from_extract, proposal="Changed")])
    b = (await _brdps(client, project, headers))[from_extract]
    # AI Extract's own event already says it; the Excel import adds none.
    assert await _history(uuid.UUID(b["id"]), "catalog_edition") == []
