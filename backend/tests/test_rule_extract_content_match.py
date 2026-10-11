"""AI Extract: rules already in the project recognized by their content.

The real case (ATA CMP BREX issue 010 into a project made from issue 009 by
Excel: no BRDP identifiers, no "extracted_from" history) is reproduced with
tests/fixtures/brex/ATA-CMP-like-*.{xml,json}, built by
scripts/build_ata_like_fixtures.py from real rules of the "CA" BREX: the ATA
files themselves are not in this repository. The edge cases use small rules
written here; the files with identifiers (Lufthansa, CA, Navantia) must
classify exactly as before.
"""
import json
import uuid
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import BRDP, BRDPHistory, Project, RuleApproval, User, UserProjectRole
from app.services import rule_formats
from app.services.rule_extract import build_candidates, read_rules_file
from app.services.rule_extract_jobs import (
    MODIFIED_MATCH_MARGIN,
    classify_candidates,
    content_similarity,
    marked_modified,
    match_by_content,
    rule_content,
)

FIXTURES = Path(__file__).parent / "fixtures"
ATA_010 = FIXTURES / "brex" / "ATA-CMP-like-010-reconstructed.xml"
ATA_009 = FIXTURES / "brex" / "ATA-CMP-like-009-project-rules.json"
LUFTHANSA = FIXTURES / "brex" / "DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml"
CA = FIXTURES / "brex" / "DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml"
NAV2 = FIXTURES / "schematron" / "BRDP-D1_schematron-xpath2.sch"
NAV3 = FIXTURES / "schematron" / "BRDP-D1_schematron-xpath3.sch"


def _b(identifier):
    return SimpleNamespace(id=identifier, identifier=identifier)


def _cand(key, rule_xml):
    return {"key": key, "rule_xml": rule_xml}


def _sor(n, path="//randomList", use="Random lists are not used.", flag="0", extra=""):
    return (
        f'<structureObjectRule id="SOR-{n}">\n      <objectPath allowedObjectFlag="{flag}">{path}</objectPath>\n'
        f"      <objectUse>{use}</objectUse>{extra}\n    </structureObjectRule>"
    )


def _stored(path="//randomList", use="Random lists are not used.", flag="0", extra=""):
    return f'<structureObjectRule><objectPath allowedObjectFlag="{flag}">{path}</objectPath><objectUse>{use}</objectUse>{extra}</structureObjectRule>'


def _match(cands, pool, fmt="BREX-4.2"):
    out = match_by_content(cands, pool, fmt)
    return {k: (v["how"], v["brdp"].identifier) if "brdp" in v else ("warning", v["warning"]["code"], v["warning"]["params"]) for k, v in out.items()}


# ── Normalization and matching (no database) ──────────────────────────────


def test_identical_except_id_indentation_and_comments_is_the_same_rule():
    pool = [(_b("BRDP-EXT-00001"), _stored())]
    file_rule = "<!-- ATA rule -->\n" + _sor(1).replace("<objectUse>", "<!-- note --><objectUse>")
    assert _match([_cand("c1", file_rule)], pool) == {"c1": ("exact", "BRDP-EXT-00001")}


def test_a_literal_keeps_its_spaces():
    # Two spaces inside an XPath literal are another rule: not "same". The
    # objectUse is the same, so it is the same rule changed (content).
    pool = [(_b("BRDP-EXT-00001"), _stored(path="//para[. = 'a b']"))]
    file_rule = _sor(1, path="//para[. = 'a  b']")
    assert rule_content(file_rule, "BREX-4.2").pieces != rule_content(pool[0][1], "BREX-4.2").pieces
    assert _match([_cand("c1", file_rule)], pool) == {"c1": ("content", "BRDP-EXT-00001")}


def test_flag_defaults_to_2_and_identifier_in_objectuse_is_ignored():
    pool = [(_b("BRDP-EXT-00001"), _stored(flag="2", use="BRDP-EXT-00001. Random lists are not used."))]
    rule = '<structureObjectRule id="SOR-1"><objectPath>//randomList</objectPath><objectUse>Random lists are not used.</objectUse></structureObjectRule>'
    assert _match([_cand("c1", rule)], pool) == {"c1": ("exact", "BRDP-EXT-00001")}


def test_project_correction_is_a_content_match():
    # Path corrected by the project, objectUse unchanged; and objectUse
    # corrected, path unchanged.
    pool = [
        (_b("BRDP-EXT-00043"), _stored(path="//description//levelledPara/levelledParaAlts", use="Alternatives of levelled paragraphs are not used.")),
        (_b("BRDP-EXT-00044"), _stored(path="//footnote", use="Footnotes are not used in the CMP. Corrected.")),
    ]
    cands = [
        _cand("c1", _sor(43, path="//levelledParaAlts", use="Alternatives of levelled paragraphs are not used.")),
        _cand("c2", _sor(44, path="//footnote", use="Footnotes are not used in the CMP.")),
    ]
    assert _match(cands, pool) == {"c1": ("content", "BRDP-EXT-00043"), "c2": ("content", "BRDP-EXT-00044")}


def test_changed_by_the_file_found_by_similarity_and_placeholder_not_found():
    pool = [
        (_b("BRDP-EXT-00002"), _stored(path="/dmodule/content/description//randomList/listItem", use="Random list items shall only contain paragraphs and notes.")),
        (_b("BRDP-EXT-00005"), _stored(path="//caption", use="Captions are not used.")),
    ]
    cands = [
        _cand("sor3", _sor(3, path="/dmodule/content/description//randomList/listItemGroup", use="Random list items shall only contain paragraphs and notes. Revised.")),
        _cand("sor97", _sor(97, path="//placeholder", use="Place holder rule for future use", flag="2")),
    ]
    assert _match(cands, pool) == {"sor3": ("similarity", "BRDP-EXT-00002")}


def test_marked_modified_attributes():
    assert marked_modified('<structureObjectRule changeType="modify" changeMark="1"/>', "BREX-4.2")
    assert marked_modified("<structureObjectRule changeMark='1'><objectPath/></structureObjectRule>", "BREX-4.1")
    assert marked_modified('<structureObjectRule><objectUse changeType="modify">x</objectUse></structureObjectRule>', "BREX-4.2")
    assert not marked_modified('<structureObjectRule changeType="add" changeMark="1"/>', "BREX-4.2")
    assert not marked_modified('<structureObjectRule changeType="delete" changeMark="1"/>', "BREX-4.2")
    assert not marked_modified('<!-- <x changeType="modify"/> --><structureObjectRule/>', "BREX-4.2")
    assert not marked_modified('<structureObjectRule changeMark="0"/>', "BREX-4.2")
    assert marked_modified('<objrule change="modify" mark="1"/>', "BREX-3.0.1")
    assert not marked_modified('<objrule change="add" mark="1"/>', "BREX-3.0.1")
    # 3.0.1 has no changeType; DITA has no change attributes.
    assert not marked_modified('<objrule changeType="modify"/>', "BREX-3.0.1")
    assert not marked_modified('<pattern changeType="modify"/>', "SCH-DITA")


def test_change_attributes_never_count_when_comparing():
    pool = [(_b("BRDP-EXT-00001"), _stored())]
    rule = _sor(1).replace('id="SOR-1"', 'id="SOR-1" changeType="modify" changeMark="1" reasonForUpdateRefIds="r1"')
    rule = rule.replace("<objectUse>", '<objectUse changeType="modify" changeMark="1">')
    assert _match([_cand("c1", rule)], pool) == {"c1": ("exact", "BRDP-EXT-00001")}


_PDHL_USE = (
    "The schema is not allowed. The Product Definitions High Level of each information set describes the "
    "different type of schemas permitted for the corresponding information set. (Chap. 2.5.1 Para_2.1.3)."
)
_PDHL_PATH = (
    '/dmodule[not((@xsi:noNamespaceSchemaLocation = "http://www.s1000d.org/S1000D_4-2/xml_schema_flat/descript.xsd") '
    'or (@xsi:noNamespaceSchemaLocation = "http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd") '
    'or (@xsi:noNamespaceSchemaLocation = "http://www.s1000d.org/S1000D_4-2/xml_schema_flat/crew.xsd"))]'
)
_PDHL_MODIFIED_PATH = _PDHL_PATH.replace(' or (@xsi:noNamespaceSchemaLocation = "http://www.s1000d.org/S1000D_4-2/xml_schema_flat/crew.xsd")', "")
_PDHL_MODIFIED_USE = "The schema is not allowed. (Chap. 2.5.1 Para_2.1.3)."


def _modified_sor(change="modify"):
    return _sor(3, path=_PDHL_MODIFIED_PATH, use=_PDHL_MODIFIED_USE).replace('id="SOR-3"', f'id="SOR-3" changeType="{change}" changeMark="1"')


def test_marked_as_modified_with_one_similar_brdp_and_margin():
    # The path loses a condition and the objectUse a sentence: under
    # CONTENT_SIMILARITY, matched only because the file marks it modified.
    pool = [
        (_b("BRDP-EXT-00002"), _stored(path=_PDHL_PATH, use=_PDHL_USE)),
        (_b("BRDP-EXT-00005"), _stored(path="//caption", use="Captions are not used.")),
    ]
    out = match_by_content([_cand("sor3", _modified_sor())], pool, "BREX-4.2")
    assert out["sor3"]["how"] == "modified" and out["sor3"]["brdp"].identifier == "BRDP-EXT-00002"
    assert 0.5 <= out["sor3"]["similarity"] < 0.85
    # Without the change marks (or marked as added): as before, no match.
    unmarked = _sor(3, path=_PDHL_MODIFIED_PATH, use=_PDHL_MODIFIED_USE)
    assert _match([_cand("sor3", unmarked)], pool) == {}
    assert _match([_cand("sor3", _modified_sor("add"))], pool) == {}


def test_marked_as_modified_with_two_similar_brdps_and_no_margin():
    # Two BRDPs as close to it: no clear best, so "Nueva EXT".
    other_path = _PDHL_PATH.replace("proced.xsd", "ipd.xsd")
    pool = [
        (_b("BRDP-EXT-00002"), _stored(path=_PDHL_PATH, use=_PDHL_USE)),
        (_b("BRDP-EXT-00003"), _stored(path=other_path, use=_PDHL_USE)),
    ]
    rc = rule_content(_modified_sor(), "BREX-4.2")
    scores = sorted((content_similarity(rc.grams, rule_content(x, "BREX-4.2").grams) for _, x in pool), reverse=True)
    assert scores[0] - scores[1] < MODIFIED_MATCH_MARGIN
    assert _match([_cand("sor3", _modified_sor())], pool) == {}


def test_same_rule_in_two_brdps_matches_none():
    pool = [(_b("BRDP-EXT-00007"), _stored()), (_b("BRDP-EXT-00008"), _stored())]
    assert _match([_cand("c1", _sor(1))], pool) == {
        "c1": ("warning", "rule_in_several_brdps", {"identifiers": ["BRDP-EXT-00007", "BRDP-EXT-00008"]})
    }


def test_a_brdp_takes_one_candidate_exact_wins():
    pool = [(_b("BRDP-EXT-00001"), _stored())]
    # c1 resembles it (objectUse changed), c2 is identical: c2 wins even if
    # it comes later in the file.
    cands = [_cand("c1", _sor(1, use="Random lists are not used. Revised.")), _cand("c2", _sor(2))]
    assert _match(cands, pool) == {
        "c2": ("exact", "BRDP-EXT-00001"),
        "c1": ("warning", "brdp_already_matched", {"identifier": "BRDP-EXT-00001"}),
    }


def test_same_path_but_a_different_decision_is_not_a_match():
    # Lufthansa's BRDP-S1-00151 and the default BREX's BREX-S1-00211: the
    # same path, two decisions (similarity 0.35, under CONTENT_MATCH_FLOOR).
    pool = [
        (
            _b("BREX-S1-00211"),
            _stored(
                path="//@materialUsage", flag="2", use="Attribute materialUsage - Material usage (Chap 3.9.6.1, Table 40)",
                extra='<objectValue valueForm="single" valueAllowed="mu01">Discarded</objectValue>',
            ),
        )
    ]
    rule = _stored(path="//@materialUsage", use="BRDP-S1-00151. Decision by Company. ")
    assert _match([_cand("c1", rule)], pool) == {}


def test_values_and_context_are_part_of_the_rule():
    ctx = 'http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd'
    value = '<objectValue valueForm="single" valueAllowed="pf02"/>'
    stored = f'<contextRules rulesContext="{ctx}"><structureObjectRuleGroup>{_stored(flag="2", extra=value)}</structureObjectRuleGroup></contextRules>'
    same = f'<contextRules rulesContext="{ctx}">\n<structureObjectRuleGroup>\n{_sor(1, flag="2", extra=value)}\n</structureObjectRuleGroup>\n</contextRules>'
    other_value = same.replace("pf02", "pf03")
    general = _sor(1, flag="2", extra=value)
    pool = [(_b("BRDP-EXT-00001"), stored)]
    assert _match([_cand("c1", same)], pool) == {"c1": ("exact", "BRDP-EXT-00001")}
    assert _match([_cand("c1", other_value)], pool) == {"c1": ("content", "BRDP-EXT-00001")}
    # Without the context block it is another rule; the path and objectUse
    # are only compared within the same context, and the text is still very
    # similar: a match by similarity.
    assert _match([_cand("c1", general)], pool) == {"c1": ("similarity", "BRDP-EXT-00001")}


def test_brex_3_0_1_objrule_and_noncontext_comment():
    stored = '<objrule><objpath objappl="0">//randlist</objpath><objuse>No random lists.</objuse></objrule><!-- nonContextRule: Decide on random lists. -->'
    file_rule = '<objrule id="R1">\n  <objpath objappl="0">//randlist</objpath>\n  <objuse>No random lists.</objuse>\n</objrule>\n<!--  nonContextRule  Decide on random lists.  -->'
    assert _match([_cand("c1", file_rule)], [(_b("BRDP-EXT-00009"), stored)], "BREX-3.0.1") == {"c1": ("exact", "BRDP-EXT-00009")}


def test_schematron_pattern_without_ids_and_changed_test():
    stored = (
        '<sch:pattern xmlns:sch="http://purl.oclc.org/dsdl/schematron"><sch:rule context="note">'
        '<sch:assert test="@type">Every note has a type.</sch:assert></sch:rule></sch:pattern>'
    )
    same = '<pattern id="p-1"><!-- c --><rule id="r" context="note"><assert id="a" test="@type">Every note has a type.</assert></rule></pattern>'
    changed = same.replace('test="@type"', 'test="@type and @othertype"')
    pool = [(_b("BRDP-EXT-00004"), stored)]
    assert _match([_cand("c1", same)], pool, "SCH-DITA") == {"c1": ("exact", "BRDP-EXT-00004")}
    assert _match([_cand("c1", changed)], pool, "SCH-DITA") == {"c1": ("content", "BRDP-EXT-00004")}


# ── Through the endpoints ─────────────────────────────────────────────────


@pytest.fixture
def synthetic_standard(monkeypatch):
    standard = f"TEST-CONTENT-MATCH-{uuid.uuid4()}"
    monkeypatch.setitem(rule_formats.STANDARD_TO_RULE_FORMAT, standard, "BREX-4.2")
    return standard


@pytest.fixture
async def ata_project(synthetic_standard):
    """The project of "issue 009": 461 BRDPs and their Verified rules, as
    an Excel import leaves them (no extracted_from history)."""
    rows = json.loads(ATA_009.read_text(encoding="utf-8"))
    async with async_session_factory() as session:
        project = Project(name=f"ATA CMP {uuid.uuid4()}", standard=synthetic_standard)
        editor = User(email=f"cm-ed-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="Ed", global_role="user")
        session.add_all([project, editor])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        for r in rows:
            b = BRDP(project_id=project.id, identifier=r["identifier"], title=r["title"], definition="D", proposal="P", validation="Validated")
            session.add(b)
            await session.flush()
            session.add(RuleApproval(brdp_id=b.id, format="BREX-4.2", rule_xml=r["rule_xml"], status="approved", source="manual"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)
    yield project, {"Authorization": f"Bearer {create_access_token(editor.id)}"}, rows
    async with async_session_factory() as session:
        await session.delete(await session.get(Project, project.id))
        await session.delete(await session.get(User, editor.id))
        await session.commit()


async def _stored_rules(project_id):
    async with async_session_factory() as session:
        rows = (
            await session.execute(select(BRDP.identifier, RuleApproval.rule_xml, RuleApproval.status).join(RuleApproval).where(BRDP.project_id == project_id))
        ).all()
    return {i: (x, s) for i, x, s in rows}


async def test_ata_issue_010_into_the_issue_009_project(client, ata_project):
    project, editor, rows = ata_project
    res = await client.post(
        f"/api/projects/{project.id}/ai-extract/parse", headers=editor,
        files={"file": ("DMC-ATABREX-F-00-00-0000-01A-022A-D_010-00_EN-US.XML", ATA_010.read_bytes(), "application/xml")},
    )
    assert res.status_code == 202, res.text
    job_id = res.json()["job_id"]
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job_id}"
    job = (await client.get(url, headers=editor)).json()
    assert job["status"] == "completed", job
    cands = (await client.get(f"{url}/candidates", headers=editor)).json()["candidates"]
    assert len(cands) == 463
    counts = Counter(c["classification"] for c in cands)
    assert counts == {"same": 450, "changed": 11, "new_ext": 2}
    sor = {int(c["rule_preview"][0].split('id="SOR-')[1].split('"')[0]): c for c in cands}
    corrected = {r["identifier"] for r in rows if r["change"] in ("path", "objectUse", "flag")}
    changed = [c for c in cands if c["classification"] == "changed"]
    # The ten corrections of the project: matched by content, unchecked, the
    # warning and the stored rule for the diff.
    by_content = [c for c in changed if c["match_by"] == "content"]
    assert {c["identifier"] for c in by_content} == corrected and len(by_content) == 10
    for c in by_content:
        assert c["selected"] is False and c["existing_rule_xml"]
        assert [w["code"] for w in c["warnings"]] == ["content_match_changed"]
    # SOR-3, changed by ATA and marked changeType="modify" (0.82, under
    # CONTENT_SIMILARITY): matched with BRDP-EXT-00002, unchecked.
    s3 = sor[3]
    assert (s3["classification"], s3["identifier"], s3["match_by"], s3["selected"]) == ("changed", "BRDP-EXT-00002", "similarity", False)
    [w] = s3["warnings"]
    assert w["code"] == "modified_match" and w["params"]["identifier"] == "BRDP-EXT-00002"
    assert 0.5 <= w["params"]["similarity"] < 0.85
    # The placeholders: new EXT numbers after the project's.
    assert (sor[97]["classification"], sor[98]["classification"]) == ("new_ext", "new_ext")
    assert {sor[97]["identifier"], sor[98]["identifier"]} == {"BRDP-EXT-00462", "BRDP-EXT-00463"}
    assert sor[97]["selected"] is True
    # The 450 equal ones: their project identifier, unchecked.
    same = [c for c in cands if c["classification"] == "same"]
    assert all(c["identifier"].startswith("BRDP-EXT-") and c["selected"] is False for c in same)
    assert len({c["identifier"] for c in same + changed}) == 461

    # Reclassify a content match to new EXT and back.
    patch = f"{url}/candidates"
    one = by_content[0]
    res = await client.patch(patch, headers=editor, json={"items": [{"key": one["key"], "classification": "new_ext"}]})
    [moved] = res.json()["candidates"]
    assert moved["classification"] == "new_ext" and moved["identifier"] == "BRDP-EXT-00464"
    res = await client.patch(patch, headers=editor, json={"items": [{"key": one["key"], "classification": "changed"}]})
    [back] = res.json()["candidates"]
    assert (back["classification"], back["identifier"]) == ("changed", one["identifier"])

    # Importing what is checked by default changes no rule of the project.
    before = await _stored_rules(project.id)
    checked = [c for c in (await client.get(patch, headers=editor)).json()["candidates"] if c["selected"]]
    assert {c["key"] for c in checked} == {sor[97]["key"], sor[98]["key"]}
    items = [{"key": c["key"], "draft_status": "drafted", **{f: f"AI {f}" for f in c["ai_fields"]}} for c in checked]
    assert (await client.patch(patch, headers=editor, json={"items": items})).status_code == 200
    res = await client.post(f"{url}/apply", headers=editor, json={"keys": [c["key"] for c in checked]})
    assert res.status_code == 200, res.text
    assert (res.json()["created"], res.json()["updated"]) == (2, 0)
    after = await _stored_rules(project.id)
    assert {k: v for k, v in after.items() if k in before} == before

    # In another extraction, checking SOR-3 updates BRDP-EXT-00002's rule;
    # the history says how it was found.
    async def extract_again(name):
        res = await client.post(
            f"/api/projects/{project.id}/ai-extract/parse", headers=editor,
            files={"file": (name, ATA_010.read_bytes(), "application/xml")},
        )
        assert res.status_code == 202, res.text
        job_url = f"/api/projects/{project.id}/ai-extract/jobs/{res.json()['job_id']}"
        return job_url, (await client.get(f"{job_url}/candidates", headers=editor)).json()["candidates"]

    url2, cands2 = await extract_again("DMC-ATABREX-F-00-00-0000-01A-022A-D_010-00_EN-US.XML")
    s3 = next(c for c in cands2 if 'id="SOR-3"' in c["rule_preview"][0])
    assert (s3["classification"], s3["identifier"], s3["match_by"]) == ("changed", "BRDP-EXT-00002", "similarity")
    res = await client.post(f"{url2}/apply", headers=editor, json={"keys": [s3["key"]]})
    assert res.status_code == 200 and res.json()["updated"] == 1, res.text
    async with async_session_factory() as session:
        b2 = (await session.execute(select(BRDP).where(BRDP.project_id == project.id, BRDP.identifier == "BRDP-EXT-00002"))).scalar_one()
        events = (await session.execute(select(BRDPHistory.new_value).where(BRDPHistory.brdp_id == b2.id, BRDPHistory.field_name == "extracted_from"))).scalars().all()
    event = json.loads(events[-1])
    assert event["match_by"] == "similarity" and event["file"].startswith("DMC-ATABREX")
    stored = await _stored_rules(project.id)
    assert "<objectUse>The schema is not allowed. (Chap." in stored["BRDP-EXT-00002"][0] and stored["BRDP-EXT-00002"][1] == "pending_review"
    assert {k: v for k, v in stored.items() if k != "BRDP-EXT-00002"} == {k: v for k, v in after.items() if k != "BRDP-EXT-00002"}

    # Read again: SOR-3 is now the same rule. The two placeholders imported
    # above have the same rule, so neither is matched: "Nueva EXT" with the
    # warning naming both.
    _, cands3 = await extract_again("again.XML")
    assert Counter(c["classification"] for c in cands3) == {"same": 451, "changed": 10, "new_ext": 2}
    for c in cands3:
        if c["classification"] == "new_ext":
            assert any(
                w["code"] == "rule_in_several_brdps" and w["params"]["identifiers"] == ["BRDP-EXT-00462", "BRDP-EXT-00463"]
                for w in c["warnings"]
            )


async def test_project_brdps_not_in_the_file(client, ata_project):
    """The project's BRDPs with a rule that no row of the file is matched
    with: named, by the rows' current classification; never for a text job."""
    project, editor, _rows = ata_project
    async with async_session_factory() as session:
        extra = BRDP(project_id=project.id, identifier="BRDP-EXT-00999", title="Only in the project", definition="D", proposal="P", validation="Validated")
        no_rule = BRDP(project_id=project.id, identifier="BRDP-EXT-00998", title="No rule", definition="D", proposal="P", validation="Pending")
        session.add_all([extra, no_rule])
        await session.flush()
        session.add(RuleApproval(brdp_id=extra.id, format="BREX-4.2", rule_xml=_stored(path="//projectOnly"), status="pending_review", source="manual"))
        await session.commit()
    res = await client.post(
        f"/api/projects/{project.id}/ai-extract/parse", headers=editor,
        files={"file": ("DMC-ATABREX-F-00-00-0000-01A-022A-D_010-00_EN-US.XML", ATA_010.read_bytes(), "application/xml")},
    )
    url = f"/api/projects/{project.id}/ai-extract/jobs/{res.json()['job_id']}"
    res = await client.get(f"{url}/unmatched-project-brdps", headers=editor)
    assert res.status_code == 200, res.text
    assert res.json()["brdps"] == [{"identifier": "BRDP-EXT-00999", "title": "Only in the project", "rule_state": "draft"}]
    assert len(res.json()["project_brdps"]) == 462
    # SOR-3 reclassified as a new EXT: BRDP-EXT-00002 is no longer in the file.
    cands = (await client.get(f"{url}/candidates", headers=editor)).json()["candidates"]
    s3 = next(c for c in cands if 'id="SOR-3"' in c["rule_preview"][0])
    await client.patch(f"{url}/candidates", headers=editor, json={"items": [{"key": s3["key"], "classification": "new_ext"}]})
    brdps = (await client.get(f"{url}/unmatched-project-brdps", headers=editor)).json()["brdps"]
    assert [b["identifier"] for b in brdps] == ["BRDP-EXT-00002", "BRDP-EXT-00999"] and brdps[0]["rule_state"] == "verified"
    # A text job: nothing.
    res = await client.post(
        f"/api/projects/{project.id}/ai-extract/text", headers=editor, json={"text": "The project decides to use only numbered lists."}
    )
    assert res.status_code == 202, res.text
    text_url = f"/api/projects/{project.id}/ai-extract/jobs/{res.json()['job_id']}"
    out = (await client.get(f"{text_url}/unmatched-project-brdps", headers=editor)).json()
    assert out["brdps"] == [] and out["project_brdps"] == []


# ── Files with identifiers: as before ─────────────────────────────────────

FILES = {
    "lufthansa": (LUFTHANSA, "BREX-4.2", "4.2"),
    "ca": (CA, "BREX-4.2", "4.2"),
    "nav2": (NAV2, "SCH-DITA", None),
    "nav3": (NAV3, "SCH-DITA", None),
}
# The Navantia files need a real DITA standard (the XPath 3.0 one reads both:
# an xslt2 Schematron is only a warning there); their EXT identifiers never
# depend on a catalog.
DITA_STANDARD = "DITA 1.3 Xpath3.0"


async def _classified(project, name):
    path, fmt, issue = FILES[name]
    cands = build_candidates(read_rules_file(path.read_bytes(), fmt, project.standard), issue)[0]
    async with async_session_factory() as db:
        await classify_candidates(project, cands, db)
    return cands


async def _seed_from(project, cands, fmt):
    """The project after importing those candidates with their identifiers."""
    async with async_session_factory() as db:
        for c in cands:
            b = BRDP(project_id=project.id, identifier=c["origin_identifier"] or c["identifier"], title="t", definition="d", proposal="p", validation="Pending")
            db.add(b)
            await db.flush()
            if c["rule_xml"] and not c.get("rule_problem"):
                db.add(RuleApproval(brdp_id=b.id, format=fmt, rule_xml=c["rule_xml"], status="pending_review", source="extracted"))
        await db.commit()


def _summary(cands):
    return dict(Counter(f"{c['classification']}{' [x]' if c['selected'] else ''}" for c in cands))


@pytest.mark.parametrize(
    "into, already, expected",
    [
        # Counts taken with the code before matching by content (same
        # synthetic standard, no catalog).
        ("lufthansa", "lufthansa", {"same": 502}),
        ("ca", "ca", {"same": 533}),
        ("ca", "lufthansa", {"changed [x]": 240, "default_rule": 243, "new_ext [x]": 43, "other_spec [x]": 7}),
        ("lufthansa", "ca", {"changed [x]": 240, "new_ext [x]": 262}),
        ("nav2", "nav2", {"same": 6}),
        ("nav3", "nav3", {"same": 7}),
        ("nav3", "nav2", {"changed [x]": 6, "new_ext [x]": 1}),
    ],
)
async def test_files_with_identifiers_classify_as_before(monkeypatch, into, already, expected):
    fmt = FILES[into][1]
    if fmt == "SCH-DITA":
        standard = DITA_STANDARD
    else:
        standard = f"TEST-CONTENT-MATCH-{uuid.uuid4()}"
        monkeypatch.setitem(rule_formats.STANDARD_TO_RULE_FORMAT, standard, fmt)
    async with async_session_factory() as db:
        project = Project(name=f"As before {uuid.uuid4()}", standard=standard)
        db.add(project)
        await db.commit()
        await db.refresh(project)
    try:
        await _seed_from(project, await _classified(project, already), fmt)
        cands = await _classified(project, into)
        assert _summary(cands) == expected
        assert not any(c.get("match_by") for c in cands)
        assert not any(w["code"] in ("content_match_changed", "similarity_match") for c in cands for w in c["warnings"])
    finally:
        async with async_session_factory() as db:
            await db.delete(await db.get(Project, project.id))
            await db.commit()
