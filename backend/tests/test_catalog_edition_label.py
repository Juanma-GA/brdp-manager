"""The "4.1" label next to a BRDP identifier: BRDPOut.catalog_edition, the
other S1000D edition whose catalog has the identifier when the catalog of
the project's standard does not. Computed per response (never stored), with
the same lookup as the Excel import and AI Extract, and a constant number of
queries whatever the number of BRDPs. Catalog rows use BRDP-S1-9xxxx."""

import io
import uuid

import openpyxl

from app.db.base import async_session_factory
from app.models import BRDP, UserProjectRole
from app.services.excel_io import parse_import_file
from tests.test_brdp_status_counts_and_filters import QueryCounter
from tests.test_import_catalog_edition import _ids, catalog_rows, make_project  # noqa: F401 -- fixtures


async def _seed(project_id, identifiers):
    async with async_session_factory() as session:
        for identifier in identifiers:
            session.add(BRDP(project_id=project_id, identifier=identifier, title="t", definition="d", proposal="p", validation="Pending"))
        await session.commit()


async def _labels(client, project, headers):
    rows = (await client.get(f"/api/projects/{project.id}/brdps", headers=headers)).json()
    return {b["identifier"]: b["catalog_edition"] for b in rows}


async def test_labels_in_the_list(client, make_project, catalog_rows):
    own, other, nowhere, marked_base = _ids(4)
    s2 = other.replace("BRDP-S1-", "BRDP-S2-")
    await catalog_rows([
        ("S1000D 4.2", own, "own", "d"),
        ("S1000D 4.1", other, "4.1", "d"),
        ("S1000D 4.1", s2, "4.1", "d"),
        ("S1000D 4.1", marked_base, "4.1", "d"),
    ])
    project, headers = await make_project("S1000D 4.2")
    marked = f"{marked_base}-4.1"
    ext = "BRDP-EXT-00001"
    await _seed(project.id, [own, other, nowhere, marked, s2, ext])
    labels = await _labels(client, project, headers)
    assert labels == {
        own: None,             # in the project's catalog
        other: "S1000D 4.1",   # only in another edition
        nowhere: None,         # in no catalog
        marked: "S1000D 4.1",  # AI Extract's marked identifier, looked up without its suffix
        s2: None,              # another specification
        ext: None,
    }


async def test_newer_edition_no_own_catalog_and_dita(client, make_project, catalog_rows):
    only42, filler = _ids(2)
    await catalog_rows([("S1000D 4.2", only42, "4.2", "d"), ("S1000D 4.1", filler, "own", "d")])
    p41, h41 = await make_project("S1000D 4.1")
    await _seed(p41.id, [only42])
    assert (await _labels(client, p41, h41)) == {only42: "S1000D 4.2"}
    # A standard with no catalog loaded at all: no label.
    p38, h38 = await make_project("S1000D 3.8")
    await _seed(p38.id, [only42])
    assert (await _labels(client, p38, h38)) == {only42: None}
    dita, hd = await make_project("DITA 1.3 Xpath2.0")
    await _seed(dita.id, [only42])
    assert (await _labels(client, dita, hd)) == {only42: None}


async def test_constant_number_of_queries(client, make_project, catalog_rows):
    """SOPTE-sized projects must not get one catalog query per BRDP: the
    list sends the same number of statements for 3 BRDPs as for 300."""
    ids = _ids(300)
    await catalog_rows([("S1000D 4.1", i, "4.1", "d") for i in ids[:150]] + [("S1000D 4.2", ids[299], "own", "d")])
    small, hs = await make_project("S1000D 4.2")
    big, hb = await make_project("S1000D 4.2")
    await _seed(small.id, ids[:3])
    await _seed(big.id, ids)
    with QueryCounter() as few:
        labels_small = await _labels(client, small, hs)
    with QueryCounter() as many:
        labels_big = await _labels(client, big, hb)
    assert few.count == many.count
    assert sum(1 for v in labels_big.values() if v) == 150 and all(labels_small.values())


async def test_create_and_update_responses_carry_the_label(client, make_project, catalog_rows):
    (other,) = _ids(1)
    filler = _ids(1)[0]
    await catalog_rows([("S1000D 4.1", other, "4.1", "d"), ("S1000D 4.2", filler, "own", "d")])
    project, headers = await make_project("S1000D 4.2")
    created = (await client.post(f"/api/projects/{project.id}/brdps", json={"identifier": other}, headers=headers)).json()
    assert created["catalog_edition"] == "S1000D 4.1"  # also a BRDP created by hand
    updated = (
        await client.put(f"/api/projects/{project.id}/brdps/{created['id']}", json={"title": "x"}, headers=headers)
    ).json()
    assert updated["catalog_edition"] == "S1000D 4.1"


async def test_compare_carries_the_label_and_searches_other_projects(client, make_project, catalog_rows):
    other, filler = _ids(2)
    await catalog_rows([("S1000D 4.1", other, "4.1", "d"), ("S1000D 4.2", filler, "own", "d")])
    a, ha = await make_project("S1000D 4.2")
    b, _hb = await make_project("S1000D 4.2")
    await _seed(a.id, [other])
    await _seed(b.id, [other])
    # The editor of a also gets viewer on b, so b's BRDP is visible.
    me = (await client.get("/api/auth/me", headers=ha)).json()
    async with async_session_factory() as session:
        session.add(UserProjectRole(user_id=uuid.UUID(me["id"]), project_id=b.id, role="viewer"))
        await session.commit()
    mine = (await client.get(f"/api/projects/{a.id}/brdps", headers=ha)).json()[0]
    cands = (await client.get(f"/api/projects/{a.id}/brdps/{mine['id']}/compare-candidates", headers=ha)).json()
    # Official identifier (in the 4.1 catalog): other projects are searched.
    assert cands["catalog_identifier"] is True
    assert [c["catalog_edition"] for c in cands["same_brdp"]] == ["S1000D 4.1"]
    theirs = cands["same_brdp"][0]["brdp_id"]
    detail = (await client.get(f"/api/projects/{a.id}/brdps/{mine['id']}/compare-detail/{theirs}", headers=ha)).json()
    assert detail["catalog_edition"] == "S1000D 4.1"


async def test_export_column_and_import_ignores_it(client, make_project):
    project, headers = await make_project("S1000D 4.2")
    row = {"id": "BRDP-S1-00001", "title": "T", "definition": "D", "proposal": "P", "proposalStatus": "Pending",
           "ruleStatus": "To Do", "rule": "", "catalogEdition": "S1000D 4.1"}
    res = await client.post(f"/api/projects/{project.id}/export.xlsx", json={"rows": [row]}, headers=headers)
    assert res.status_code == 200
    sheet = openpyxl.load_workbook(io.BytesIO(res.content)).worksheets[0]
    header = [c.value for c in sheet[1]]
    assert header[-1] == "Catalog Edition"
    assert sheet.cell(2, len(header)).value == "S1000D 4.1"
    # Read back: the import never sees the column (the identifier decides).
    parsed = parse_import_file(res.content, "export.xlsx")
    assert parsed["errors"] == [] and set(parsed["rows"][0]) == {
        "row_number", "identifier", "title", "definition", "proposal", "proposal_status", "rule_status", "rule",
    }
