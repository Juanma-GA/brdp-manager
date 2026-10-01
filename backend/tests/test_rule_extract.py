"""AI Extract (1/2): import BRDPs from a BREX or a Schematron.

Two real fixtures (tests/fixtures/brex/): Lufthansa's original client BREX
(DMC-LHTSTD-…-022A, S1000D 4.2: the BRDP identifier only in the text of
objectUse/simplePara, 61 rules, 469 nonContextRule, context blocks) and the
"CA" BREX (DMC-CAAA…-022AD, S1000D 4.2: brDecisionRef on every rule, 5,536
rules for 533 identifiers, BRDP-S1-00007 with 4,500 rules, rules with
S1000D 4.1 schema URLs, BRDP-S2-… identifiers, BREX-S1-… numbers). The
other formats (4.1, 3.0.1, DITA Schematron) and the edge cases (empty
rulesContext, "does not exist in S1000D 4.x", entities) use small files
written here.

Classification tests use a synthetic standard mapped to a real rule format
(monkeypatched STANDARD_TO_RULE_FORMAT), so the real catalog of this
environment never changes their result.
"""
import json
import uuid
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

from app.api.deps import get_httpx_transport
from app.core.config import get_settings
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.main import app
from app.models import BRDP, BRDPCatalog, BRDPHistory, Project, RuleApproval, RuleExtractCandidate, User, UserProjectRole
from app.services import rule_formats
from app.services.rule_extract import RuleExtractFileError, build_candidates, read_rules_file
from app.services.rule_extract_jobs import check_similar, normalize_rule, other_specification

FIXTURES = Path(__file__).parent / "fixtures" / "brex"
LUFTHANSA = FIXTURES / "DMC-LHTSTD-A-00-00-00-000A-022A-D_001-00_SX-US.xml"
CA = FIXTURES / "DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml"


def _brex(issue: str, content: str, url_issue: str | None = None) -> bytes:
    url_issue = url_issue or issue.replace(".", "-")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        f'xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_{url_issue}/xml_schema_flat/brex.xsd">'
        f"<identAndStatusSection/><content><brex>{content}</brex></content></dmodule>"
    ).encode("utf-8")


def _by_id(candidates):
    return {c["origin_identifier"]: c for c in candidates}


# ── Reading and grouping (no database) ────────────────────────────────────


def test_lufthansa_brex_groups_by_the_identifier_in_the_text():
    rf = read_rules_file(LUFTHANSA.read_bytes(), "BREX-4.2", "S1000D 4.2")
    candidates, warnings = build_candidates(rf, "4.2")
    assert warnings == []
    # 33 identifiers with rules only + 469 nonContextRule (13 of them share
    # their identifier with rules) = 502, none without identifier.
    assert len(candidates) == 502
    assert all(c["origin_identifier"] for c in candidates)
    ids = _by_id(candidates)
    # Several rules, one candidate.
    assert ids["BRDP-S1-00070"]["rule_count"] == 2
    assert ids["BRDP-S1-00377"]["rule_count"] == 8
    assert ids["BRDP-S1-00377"]["rule_xml"].count("<contextRules ") == 1
    # General rule plus context blocks: one candidate, the blocks kept.
    s6 = ids["BRDP-S1-00006"]
    assert s6["rule_count"] == 4
    assert s6["rule_xml"].startswith("<structureObjectRule>")
    assert s6["rule_xml"].count('<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/') == 3
    assert s6["rule_problem"] is None
    # Rule plus nonContextRule: one candidate, the decision text kept apart.
    s117 = ids["BRDP-S1-00117"]
    assert s117["rule_count"] == 1 and "//caption" in s117["rule_xml"]
    assert "nonContextRule" not in s117["rule_xml"]
    assert s117["decision_texts"][0].startswith("Decide whether inline captions affect")
    s37 = ids["BRDP-S1-00037"]
    assert s37["rule_count"] == 1 and s37["decision_texts"]
    # nonContextRule only: candidate without rule.
    s1 = ids["BRDP-S1-00001"]
    assert s1["rule_count"] == 0 and s1["rule_xml"] == ""
    assert s1["decision_texts"][0] == 'Decide whether and when to use the alpha characters "I" and "O".'
    # The rule text is the file's own, without the root's xmlns, and with the
    # line endings XML normalizes (the file is CRLF).
    assert b"\r\n" in LUFTHANSA.read_bytes()
    assert "xmlns" not in ids["BRDP-S1-00052"]["rule_xml"]
    assert not any("\r" in c["rule_xml"] for c in candidates)
    # Boolean objectPath, like the lint.
    assert [w["code"] for w in ids["BRDP-S1-00316"]["warnings"]] == ["boolean_path"]
    assert all(c["rule_problem"] is None for c in candidates)


def test_ca_brex_brdecisionref_big_candidate_other_version_and_ids():
    rf = read_rules_file(CA.read_bytes(), "BREX-4.2", "S1000D 4.2")
    candidates, _ = build_candidates(rf, "4.2")
    assert len(candidates) == 533
    ids = _by_id(candidates)
    s7 = ids["BRDP-S1-00007"]
    assert s7["rule_count"] == 4500
    assert len(s7["rule_preview"]) == 20
    # The AI gets a summary, never the rules: count, path kinds, the first 10
    # paths, the most repeated objectUse; no rule-by-rule list.
    summary = s7["summary"]
    assert summary["count"] == 4500 and summary["flags"] == {"0": 4500}
    assert len(summary["first_paths"]) == 10
    assert summary["most_repeated_use"]["count"] == 4500
    assert "rules" not in summary
    # The rule is kept whole (and unchanged: 4.1 URLs included).
    assert s7["rule_xml"].count("<structureObjectRule>") == 4500
    assert "S1000D_4-1" in s7["rule_xml"]
    assert {"code": "other_version_urls"}.items() <= next(w for w in s7["warnings"] if w["code"] == "other_version_urls").items()
    assert next(w for w in s7["warnings"] if w["code"] == "other_version_urls")["params"] == {"versions": ["4.1"], "project": "4.2"}
    # BREX-S1-… numbers are kept as the origin and flagged.
    assert sum(1 for c in candidates if c["origin_identifier"].startswith("BREX-S1-")) == 243
    assert any(w["code"] == "not_brdp_identifier" for w in ids["BREX-S1-00001"]["warnings"])
    assert ids["BRDP-S2-00002"]["rule_count"] == 301


def test_other_specification_names():
    assert other_specification("BRDP-S2-00002", "S1000D 4.2") == "S2000M"
    assert other_specification("BRDP-S3-00010", "S1000D 4.2") == "S3000L"
    assert other_specification("BRDP-S1-00010", "S1000D 4.2") is None
    assert other_specification("BRDP-EXT-00010", "S1000D 4.2") is None
    assert other_specification("BREX-S1-00001", "S1000D 4.2") is None
    assert other_specification("BRDP-S1-00010", "DITA 1.3 Xpath2.0") is None


def test_brex_4_1_and_empty_rules_context():
    content = (
        '<contextRules rulesContext="">'
        '<structureObjectRuleGroup><structureObjectRule id="BRDP-S1-00133">'
        '<objectPath allowedObjectFlag="0">//parameter</objectPath><objectUse>No parameter.</objectUse>'
        "</structureObjectRule></structureObjectRuleGroup></contextRules>"
        '<contextRules rulesContext="http://www.s1000d.org/S1000D_4-1/xml_schema_flat/proced.xsd">'
        "<structureObjectRuleGroup><structureObjectRule>"
        '<objectPath allowedObjectFlag="0">//proceduralStep[count(proceduralStep) = 1]</objectPath>'
        "<objectUse>BRDP-S1-00187. A minimum of two sub-steps.</objectUse></structureObjectRule>"
        "</structureObjectRuleGroup></contextRules>"
    )
    rf = read_rules_file(_brex("4.1", content), "BREX-4.1", "S1000D 4.1")
    ids = _by_id(build_candidates(rf, "4.1")[0])
    general = ids["BRDP-S1-00133"]
    # Imported as general: the rule alone, no wrapper, with the warning.
    assert general["rule_xml"].startswith('<structureObjectRule id="BRDP-S1-00133">')
    assert "contextRules" not in general["rule_xml"]
    assert [w["code"] for w in general["warnings"]] == ["empty_context"]
    assert general["rule_problem"] is None
    proced = ids["BRDP-S1-00187"]
    assert proced["rule_xml"].startswith('<contextRules rulesContext="http://www.s1000d.org/S1000D_4-1/xml_schema_flat/proced.xsd">')
    assert proced["warnings"] == []


def test_brex_3_0_1_objrule_context_and_noncontext_comment():
    content = (
        '<contextrules context="">'
        "<structrules><objrule><objpath objappl=\"0\">//randlist</objpath>"
        "<objuse>BRDP-S1-00133. No random lists.</objuse></objrule></structrules></contextrules>"
        '<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd">'
        '<structrules><objrule id="BRDP-S1-00187"><objpath objappl="0">//step1</objpath>'
        "<objuse>No step1.</objuse></objrule></structrules></contextrules>"
        '<!-- nonContextRule id="BRDP-S1-00004": Decide which information sets to use. -->'
    )
    rf = read_rules_file(_brex("3.0.1", content, "3-0-1"), "BREX-3.0.1", "S1000D 3.0.1")
    ids = _by_id(build_candidates(rf, "3.0.1")[0])
    assert ids["BRDP-S1-00133"]["rule_xml"].startswith("<objrule>")
    assert [w["code"] for w in ids["BRDP-S1-00133"]["warnings"]] == ["empty_context"]
    assert ids["BRDP-S1-00187"]["rule_xml"].startswith('<contextrules context="http://www.s1000d.org/S1000D_3-0-1/')
    assert "<structrules>" in ids["BRDP-S1-00187"]["rule_xml"]
    assert ids["BRDP-S1-00004"]["rule_count"] == 0
    assert ids["BRDP-S1-00004"]["decision_texts"] == ["Decide which information sets to use."]


def test_dita_schematron_ids_from_pattern_assert_and_message():
    sch = (
        '<?xml version="1.0"?><sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">'
        '<sch:let name="g" value="1"/>'
        '<sch:pattern id="p-BRDP-EXT-00007"><sch:rule context="note">'
        '<sch:assert id="BRDP-EXT-00007a" test="@type">Note needs a type.</sch:assert></sch:rule></sch:pattern>'
        '<sch:pattern><sch:rule context="step"><sch:assert id="BRDP-D1-00020b" test="cmd">Step needs cmd.</sch:assert>'
        "</sch:rule></sch:pattern>"
        '<sch:pattern><sch:rule context="table"><sch:report test="@frame">BRDP-S1-00122. No frame.</sch:report>'
        "</sch:rule></sch:pattern>"
        '<sch:pattern><sch:rule context="fig"><sch:assert test="title">Figures need a title.</sch:assert></sch:rule></sch:pattern>'
        "</sch:schema>"
    ).encode()
    rf = read_rules_file(sch, "SCH-DITA", "DITA 1.3 Xpath2.0")
    candidates, warnings = build_candidates(rf, None)
    assert [c["origin_identifier"] for c in candidates] == ["BRDP-EXT-00007", "BRDP-D1-00020", "BRDP-S1-00122", None]
    assert all(c["rule_problem"] is None for c in candidates)
    assert candidates[0]["rule_xml"].startswith('<sch:pattern id="p-BRDP-EXT-00007">')
    assert [w["code"] for w in warnings] == ["schematron_globals"]
    # A Schematron in an XPath 3.0 project: warned, not refused.
    rf3 = read_rules_file(sch, "SCH-DITA", "DITA 1.3 Xpath3.0")
    assert [w["code"] for w in rf3.warnings] == ["query_binding"]


@pytest.mark.parametrize(
    "data, rule_format, standard, message",
    [
        (b"", "BREX-4.2", "S1000D 4.2", "The file is empty."),
        (b"   \n ", "BREX-4.2", "S1000D 4.2", "The file is empty."),
        (b"this is not xml", "BREX-4.2", "S1000D 4.2", "The file is not well-formed XML"),
        (b"<dmodule><content/></dmodule>", "BREX-4.2", "S1000D 4.2", "This data module is not a BREX"),
        (b"<topic/>", "BREX-4.2", "S1000D 4.2", "neither a BREX data module nor a Schematron"),
        (
            _brex("3.0.1", "<contextrules><structrules><objrule><objpath>//a</objpath><objuse>x</objuse></objrule></structrules></contextrules>", "3-0-1"),
            "BREX-4.2",
            "S1000D 4.2",
            "This is a BREX for S1000D 3.0.1; this project is S1000D 4.2 (BREX S1000D 4.2).",
        ),
        (b'<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron"/>', "BREX-4.2", "S1000D 4.2", "This is a Schematron"),
        (_brex("4.2", ""), "SCH-DITA", "DITA 1.3 Xpath2.0", "This is a BREX data module"),
        (_brex("4.2", ""), None, "S1000D 5.0", "has no rule format"),
    ],
)
def test_unreadable_or_wrong_format_files_are_refused_with_the_reason(data, rule_format, standard, message):
    with pytest.raises(RuleExtractFileError) as exc:
        read_rules_file(data, rule_format, standard)
    assert message in str(exc.value)
    assert exc.value.status_code == 422


def test_doctype_with_internal_subset_is_read():
    data = b'<?xml version="1.0"?><!DOCTYPE dmodule []>' + _brex("4.2", "").split(b"?>", 1)[1]
    rf = read_rules_file(data, "BREX-4.2", "S1000D 4.2")
    assert rf.file_format == "BREX-4.2" and rf.warnings == []


def test_external_entity_is_never_read(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP-SECRET-CONTENT")
    rule = (
        '<structureObjectRule><objectPath allowedObjectFlag="0">//a</objectPath>'
        "<objectUse>BRDP-S1-00133. &x; end</objectUse></structureObjectRule>"
    )
    data = (
        f'<?xml version="1.0"?><!DOCTYPE dmodule [<!ENTITY x SYSTEM "file://{secret}">]>'
        '<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd">'
        f"<content><brex><contextRules>{rule}</contextRules></brex></content></dmodule>"
    ).encode()
    rf = read_rules_file(data, "BREX-4.2", "S1000D 4.2")
    assert [w["code"] for w in rf.warnings] == ["external_entities"]
    assert rf.warnings[0]["params"]["names"] == ["x"]
    candidates, _ = build_candidates(rf, "4.2")
    assert "TOP-SECRET-CONTENT" not in json.dumps(candidates)
    # The candidate is still there; its rule keeps the reference, which does
    # not parse on its own, so it imports without rule, with the reason.
    assert candidates[0]["origin_identifier"] is None or candidates[0]["origin_identifier"] == "BRDP-S1-00133"
    assert "TOP-SECRET-CONTENT" not in candidates[0]["rule_xml"]


def test_no_content_noncontext_rule():
    content = (
        "<nonContextRules><nonContextRule><simplePara>BRDP-S1-00480. Decide on something.</simplePara>"
        "<simplePara>This BRDP does not exist in S1000D 4.x. Not to take into account.</simplePara>"
        "</nonContextRule></nonContextRules>"
    )
    rf = read_rules_file(_brex("4.2", content), "BREX-4.2", "S1000D 4.2")
    [c] = build_candidates(rf, "4.2")[0]
    assert c["no_content"] is True


def test_normalized_rule_comparison_ignores_formatting_not_literals():
    a = '<structureObjectRule>\n  <objectPath allowedObjectFlag="0">//a[@x = "a  b"]</objectPath>\n</structureObjectRule>'
    b = '<structureObjectRule><objectPath allowedObjectFlag="0">   //a[@x = "a  b"]  </objectPath></structureObjectRule>'
    c = '<structureObjectRule><objectPath allowedObjectFlag="0">//a[@x = "a b"]</objectPath></structureObjectRule>'
    assert normalize_rule(a, "BREX-4.2") == normalize_rule(b, "BREX-4.2")
    assert normalize_rule(a, "BREX-4.2") != normalize_rule(c, "BREX-4.2")


# ── Endpoints: job, classification, import ────────────────────────────────


@pytest.fixture
def synthetic_standard(monkeypatch):
    standard = f"TEST-EXTRACT-STANDARD-{uuid.uuid4()}"
    monkeypatch.setitem(rule_formats.STANDARD_TO_RULE_FORMAT, standard, "BREX-4.2")
    return standard


@pytest.fixture
async def project_users(synthetic_standard):
    async with async_session_factory() as session:
        project = Project(name=f"Extract Test {uuid.uuid4()}", standard=synthetic_standard)
        editor = User(email=f"extract-ed-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="Ed", global_role="user")
        viewer = User(email=f"extract-vi-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="Vi", global_role="user")
        session.add_all([project, editor, viewer])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        session.add(UserProjectRole(user_id=viewer.id, project_id=project.id, role="viewer"))
        await session.commit()
        for o in (project, editor, viewer):
            await session.refresh(o)
    yield (
        project,
        {"Authorization": f"Bearer {create_access_token(editor.id)}"},
        {"Authorization": f"Bearer {create_access_token(viewer.id)}"},
    )
    async with async_session_factory() as session:
        await session.execute(BRDPCatalog.__table__.delete().where(BRDPCatalog.standard == synthetic_standard))
        for model, oid in ((Project, project.id), (User, editor.id), (User, viewer.id)):
            obj = await session.get(model, oid)
            if obj is not None:
                await session.delete(obj)
        await session.commit()


async def _upload(client, project_id, headers, data: bytes, name="brex.xml"):
    return await client.post(
        f"/api/projects/{project_id}/ai-extract/parse", files={"file": (name, data, "application/xml")}, headers=headers
    )


async def _extract(client, project_id, headers, data: bytes, name="brex.xml"):
    res = await _upload(client, project_id, headers, data, name)
    assert res.status_code == 202, res.text
    job_id = res.json()["job_id"]
    job = (await client.get(f"/api/projects/{project_id}/ai-extract/jobs/{job_id}", headers=headers)).json()
    assert job["status"] == "completed", job
    cands = (await client.get(f"/api/projects/{project_id}/ai-extract/jobs/{job_id}/candidates", headers=headers)).json()
    return job, cands["candidates"]


async def _seed(project_id, identifier, rule=None, **fields):
    async with async_session_factory() as session:
        brdp = BRDP(project_id=project_id, identifier=identifier, title=fields.get("title", "T"),
                    definition=fields.get("definition", "D"), proposal=fields.get("proposal", "P"),
                    validation=fields.get("validation", "Validated"))
        session.add(brdp)
        await session.flush()
        if rule is not None:
            session.add(RuleApproval(brdp_id=brdp.id, format="BREX-4.2", rule_xml=rule, status="approved", source="manual"))
        await session.commit()
        return brdp.id


def _rule(identifier, path, flag="0"):
    return (
        f'<structureObjectRule><objectPath allowedObjectFlag="{flag}">{path}</objectPath>'
        f"<objectUse>{identifier}. Decision by Company. </objectUse></structureObjectRule>"
    )


async def test_parse_requires_editor_and_reports_413_and_422(client, project_users, monkeypatch):
    project, editor, viewer = project_users
    assert (await _upload(client, project.id, viewer, _brex("4.2", ""))).status_code == 403
    res = await _upload(client, project.id, editor, b"not xml")
    assert res.status_code == 422 and "not well-formed" in res.json()["detail"]
    res = await _upload(client, project.id, editor, b"")
    assert res.status_code == 422 and res.json()["detail"] == "The file is empty."
    monkeypatch.setattr(get_settings(), "rule_extract_max_bytes", 1000)
    res = await _upload(client, project.id, editor, b"<x>" + b" " * 2000 + b"</x>")
    assert res.status_code == 413
    assert "limit for a BREX or Schematron" in res.json()["detail"]


async def test_classification_and_import(client, project_users, synthetic_standard):
    project, editor, viewer = project_users
    async with async_session_factory() as session:
        session.add(BRDPCatalog(standard=synthetic_standard, identifier="BRDP-S1-00133", title="Catalog title", definition="Catalog definition"))
        await session.commit()
    await _seed(project.id, "BRDP-EXT-00003")
    await _seed(project.id, "BRDP-S1-00065", _rule("BRDP-S1-00065", "//copyright"), proposal="Validated proposal")
    await _seed(project.id, "BRDP-S1-00070", _rule("BRDP-S1-00070", "//originator"))
    content = (
        "<contextRules>"
        + _rule("BRDP-S1-00133", "//parameter")
        + _rule("BRDP-S1-00065", "//copyright/copyrightPara/emphasis[1]")
        + _rule("BRDP-S1-00070", "//originator")
        + _rule("BRDP-EXT-00014", "//footnote")
        + _rule("BRDP-S1-99999", "//caption")
        + _rule("BRDP-S2-00002", "//accessTo")
        + "</contextRules>"
        "<nonContextRules><nonContextRule><simplePara>BRDP-S1-00480. Decide.</simplePara>"
        "<simplePara>Does not exist in S1000D 4.x. Not to take into account.</simplePara></nonContextRule></nonContextRules>"
    )
    job, cands = await _extract(client, project.id, editor, _brex("4.2", content), "LH.xml")
    by = _by_id(cands)
    assert by["BRDP-S1-00133"]["classification"] == "catalog"
    assert by["BRDP-S1-00133"]["title"] == "Catalog title"
    assert by["BRDP-S1-00065"]["classification"] == "changed"
    assert by["BRDP-S1-00065"]["existing_rule_xml"] == _rule("BRDP-S1-00065", "//copyright")
    assert by["BRDP-S1-00070"]["classification"] == "same"
    assert by["BRDP-EXT-00014"]["classification"] == "new_ext"
    # Next free EXT number (the project has EXT-00003), in file order.
    assert by["BRDP-EXT-00014"]["identifier"] == "BRDP-EXT-00004"
    assert by["BRDP-S1-99999"]["classification"] == "new_ext"
    assert by["BRDP-S1-99999"]["identifier"] == "BRDP-EXT-00005"
    assert any(w["code"] == "not_in_catalog" for w in by["BRDP-S1-99999"]["warnings"])
    assert by["BRDP-S2-00002"]["classification"] == "other_spec"
    assert by["BRDP-S2-00002"]["specification"] == "S2000M"
    assert by["BRDP-S2-00002"]["identifier"] == "BRDP-S2-00002"
    assert by["BRDP-S1-00480"]["classification"] == "empty"
    assert by["BRDP-S1-00480"]["selected"] is False
    assert {c["origin_identifier"]: c["selected"] for c in cands} == {
        "BRDP-S1-00133": True, "BRDP-S1-00065": True, "BRDP-S1-00070": False, "BRDP-EXT-00014": True,
        "BRDP-S1-99999": True, "BRDP-S2-00002": True, "BRDP-S1-00480": False,
    }

    # Texts written by the AI / by hand are saved; an impossible
    # classification is refused; a viewer cannot edit.
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    k = {c["origin_identifier"]: c["key"] for c in cands}
    res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [
        {"key": k["BRDP-EXT-00014"], "title": "Footnotes", "definition": "Use of footnotes", "proposal": "Footnotes shall not be used.", "draft_status": "drafted"},
        {"key": k["BRDP-S1-00133"], "proposal": "Parameters shall not be used.", "draft_status": "drafted"},
    ]})
    assert res.status_code == 200, res.text
    assert (await client.patch(f"{url}/candidates", headers=editor, json={"items": [{"key": k["BRDP-S1-00133"], "classification": "changed"}]})).status_code == 422
    assert (await client.patch(f"{url}/candidates", headers=viewer, json={"items": [{"key": k["BRDP-S1-00133"], "proposal": "x"}]})).status_code == 403

    keys = [c["key"] for c in cands if c["selected"]]
    assert (await client.post(f"{url}/apply", headers=viewer, json={"keys": keys})).status_code == 403
    res = await client.post(f"{url}/apply", headers=editor, json={"keys": keys})
    assert res.status_code == 200, res.text
    result = res.json()
    assert (result["created"], result["updated"], result["omitted"]) == (4, 1, 0)
    assert (await client.post(f"{url}/apply", headers=editor, json={"keys": keys})).status_code == 409

    async with async_session_factory() as session:
        brdps = {b.identifier: b for b in (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).scalars()}
        ext4 = brdps["BRDP-EXT-00004"]
        assert (ext4.title, ext4.proposal, ext4.validation) == ("Footnotes", "Footnotes shall not be used.", "Pending")
        approval = await session.get(RuleApproval, (ext4.id, "BREX-4.2"))
        assert (approval.status, approval.source) == ("pending_review", "extracted")
        assert approval.rule_xml == _rule("BRDP-EXT-00014", "//footnote")
        event = (await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id == ext4.id, BRDPHistory.field_name == "extracted_from"))).scalar_one()
        assert json.loads(event.new_value) == {"file": "LH.xml", "origin_identifier": "BRDP-EXT-00014"}
        # Catalog: Title/Definition from the catalog, the AI's Proposal.
        cat = brdps["BRDP-S1-00133"]
        assert (cat.title, cat.definition, cat.proposal) == ("Catalog title", "Catalog definition", "Parameters shall not be used.")
        assert "BRDP-S2-00002" in brdps
        # Changed: only the rule, in Draft; the validated Proposal untouched.
        s65 = brdps["BRDP-S1-00065"]
        assert (s65.proposal, s65.validation) == ("Validated proposal", "Validated")
        a65 = await session.get(RuleApproval, (s65.id, "BREX-4.2"))
        assert a65.status == "pending_review" and "emphasis[1]" in a65.rule_xml
        hist = {h.field_name for h in (await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id == s65.id))).scalars()}
        assert {"rule", "rule_status", "extracted_from"} <= hist

    # Re-importing the same BREX: everything already there is "same".
    job2, cands2 = await _extract(client, project.id, editor, _brex("4.2", content), "LH.xml")
    by2 = _by_id(cands2)
    for origin in ("BRDP-S1-00133", "BRDP-S1-00065", "BRDP-S1-00070", "BRDP-S2-00002"):
        assert by2[origin]["classification"] == "same", origin
    # The EXT of the file became BRDP-EXT-00004 (and S1-99999, missing from
    # the catalog, BRDP-EXT-00005): found again through the origin kept in
    # their history, so a re-import is "same", never another EXT.
    assert (by2["BRDP-EXT-00014"]["classification"], by2["BRDP-EXT-00014"]["identifier"]) == ("same", "BRDP-EXT-00004")
    assert (by2["BRDP-S1-99999"]["classification"], by2["BRDP-S1-99999"]["identifier"]) == ("same", "BRDP-EXT-00005")
    assert all(c["classification"] in ("same", "empty") for c in cands2)
    # A new file replaces the previous candidates.
    async with async_session_factory() as session:
        assert (await session.execute(select(RuleExtractCandidate).where(RuleExtractCandidate.job_id == uuid.UUID(job["id"])))).first() is None


async def test_invalid_rule_imports_without_rule(client, project_users):
    """A rule that cannot be read on its own (it uses an entity declared in
    the file's DOCTYPE) is reported; the candidate imports without it."""
    project, editor, _ = project_users
    data = _brex(
        "4.2",
        '<contextRules><structureObjectRule id="BRDP-EXT-00001"><objectPath allowedObjectFlag="0">//a</objectPath>'
        "<objectUse>Decision by &co;.</objectUse></structureObjectRule></contextRules>",
    ).replace(b"?>\n", b'?>\n<!DOCTYPE dmodule [<!ENTITY co "Company">]>', 1)
    job, cands = await _extract(client, project.id, editor, data)
    [c] = cands
    assert c["rule_problem"]["code"] == "not_parsed"
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await client.post(f"{url}/apply", headers=editor, json={"keys": [c["key"]]})
    assert res.json()["created"] == 1 and res.json()["invalid_rule"] == 1
    async with async_session_factory() as session:
        brdp = (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).scalar_one()
        assert await session.get(RuleApproval, (brdp.id, "BREX-4.2")) is None


async def test_ca_brex_end_to_end_in_a_42_project(client, project_users, monkeypatch):
    """The real "CA" BREX through the endpoint: 533 candidates in the
    background job; the 4,500-rule candidate is sent to the table without
    its rule (count and first 20 only) and imported whole."""
    project, editor, _ = project_users
    job, cands = await _extract(client, project.id, editor, CA.read_bytes(), CA.name)
    assert job["total_items"] == 533 and len(cands) == 533
    by = _by_id(cands)
    s7 = by["BRDP-S1-00007"]
    assert s7["big"] is True and s7["rule_xml"] is None and len(s7["rule_preview"]) == 20 and s7["rule_count"] == 4500
    assert by["BRDP-S2-00002"]["classification"] == "other_spec"
    assert by["BREX-S1-00001"]["classification"] == "new_ext"
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await client.post(f"{url}/apply", headers=editor, json={"keys": [s7["key"]]})
    assert res.status_code == 200 and res.json()["created"] == 1
    async with async_session_factory() as session:
        brdp = (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).scalar_one()
        approval = await session.get(RuleApproval, (brdp.id, "BREX-4.2"))
        assert approval.rule_xml.count("<structureObjectRule>") == 4500


async def test_similar_warning_for_new_ext(project_users):
    project, _, _ = project_users
    async with async_session_factory() as session:
        brdp = BRDP(project_id=project.id, identifier="BRDP-EXT-00001", title="Footnotes", definition="d", proposal="p",
                    validation="Validated", embedding=[1.0] + [0.0] * 1023)
        session.add(brdp)
        await session.commit()

    def handler(request):
        texts = json.loads(request.content)["input"]
        return httpx.Response(200, json={"data": [{"index": i, "embedding": [1.0] + [0.0] * 1023} for i in range(len(texts))]})

    candidates = [{"key": "c1", "classification": "new_ext", "decision_texts": ["Footnotes"], "object_uses": [], "warnings": []}]
    async with async_session_factory() as session:
        warning = await check_similar(project.id, candidates, session, httpx.MockTransport(handler))
    assert warning is None
    assert candidates[0]["warnings"] == [
        {"code": "similar_to", "params": {"identifier": "BRDP-EXT-00001", "similarity": 1.0}, "message": "Similar to BRDP-EXT-00001 (1.0)."}
    ]

    def failing(request):
        return httpx.Response(500, json={"error": "down"})

    candidates[0]["warnings"] = []
    async with async_session_factory() as session:
        warning = await check_similar(project.id, candidates, session, httpx.MockTransport(failing))
    assert warning["code"] == "similarity_unavailable"
    assert candidates[0]["warnings"] == []


async def test_similar_check_makes_no_call_without_embedded_brdps(project_users):
    project, _, _ = project_users
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(500)

    candidates = [{"key": "c1", "classification": "new_ext", "decision_texts": ["x"], "object_uses": [], "warnings": []}]
    async with async_session_factory() as session:
        assert await check_similar(project.id, candidates, session, httpx.MockTransport(handler)) is None
    assert calls == []


async def test_similar_check_runs_inside_the_job(client, project_users):
    project, editor, _ = project_users
    async with async_session_factory() as session:
        session.add(BRDP(project_id=project.id, identifier="BRDP-EXT-00001", title="t", definition="d", proposal="p",
                         validation="Validated", embedding=[1.0] + [0.0] * 1023))
        await session.commit()

    def handler(request):
        texts = json.loads(request.content)["input"]
        return httpx.Response(200, json={"data": [{"index": i, "embedding": [1.0] + [0.0] * 1023} for i in range(len(texts))]})

    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)
    try:
        _, cands = await _extract(client, project.id, editor, _brex("4.2", "<contextRules>" + _rule("BRDP-EXT-00009", "//a") + "</contextRules>"))
    finally:
        app.dependency_overrides.pop(get_httpx_transport, None)
    assert [w["code"] for w in cands[0]["warnings"]] == ["similar_to"]
