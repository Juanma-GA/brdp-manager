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
from app.services.rule_extract import RuleExtractFileError, build_candidates, literal_texts, object_use_text, read_rules_file
from app.services.rule_extract_jobs import (
    apply_edit,
    check_similar,
    closest_edition,
    default_rule_specification,
    normalize_rule,
    other_specification,
    set_texts,
    text_state,
)
from app.services.rule_wrappers import split_rule_pieces

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
    # Rule plus nonContextRule: one candidate, both pieces in its rule (the
    # nonContextRule after the executable rule, as written), and the
    # decision text literal: no AI needed for Definition and Proposal.
    s117 = ids["BRDP-S1-00117"]
    assert (s117["rule_count"], s117["noncontext_count"]) == (1, 1)
    assert s117["rule_xml"].startswith("<structureObjectRule>") and "//caption" in s117["rule_xml"]
    assert s117["rule_xml"].endswith("</nonContextRule>")
    assert [p["kind"] for p in split_rule_pieces(s117["rule_xml"], "BREX-4.2")] == ["rule", "noncontext"]
    assert s117["literal"] == {
        "title": None,
        "definition": "Decide whether inline captions affect the text line spacing and how this is defined",
        "proposal": "Captions shall not be used.",
    }
    s37 = ids["BRDP-S1-00037"]
    assert s37["literal"]["proposal"] == (
        "LOEDM is not being used. The LOEP is part of the final PDF delivery, but not available as a physical DM."
    )
    # nonContextRule only: that nonContextRule is its rule; a bare TDWG
    # decision is the Proposal as it is.
    s1 = ids["BRDP-S1-00001"]
    assert (s1["rule_count"], s1["noncontext_count"]) == (0, 1)
    assert s1["rule_xml"].startswith("<nonContextRule>") and s1["rule_problem"] is None
    assert s1["literal"] == {"title": None, "definition": 'Decide whether and when to use the alpha characters "I" and "O".', "proposal": "Decision made by TDWG."}
    # All 469 nonContextRules are in some candidate's rule, and all 469 give
    # a literal Proposal (300 "Decision made by Project. …", 169 TDWG).
    assert sum(c["noncontext_count"] for c in candidates) == 469
    assert sum(len([p for p in split_rule_pieces(c["rule_xml"], "BREX-4.2") if p["kind"] == "noncontext"]) for c in candidates) == 469
    literal = [c for c in candidates if c["proposal_from"] == "noncontext"]
    assert len(literal) == 469 and all(c["literal"]["definition"] for c in literal)
    # Without a nonContextRule: one candidate whose rules all say the same
    # objectUse once "Decision by Company." is dropped -- S1-00052 -- has it
    # as its Proposal; the 32 whose objectUses only say who decided, none.
    from_use = [c for c in candidates if c["proposal_from"] == "object_use"]
    assert [c["origin_identifier"] for c in from_use] == ["BRDP-S1-00052"]
    assert from_use[0]["literal"]["proposal"] == "Allowed LHT infocodes, including 055 and 930 which are not allowed in ATA CMP."
    assert sum(1 for c in candidates if not c["literal"]["proposal"]) == 32
    assert sum(1 for c in literal if c["literal"]["proposal"] == "Decision made by TDWG.") == 169
    assert not any(c["literal"]["proposal"].startswith("Decision made by Project") for c in literal)
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
    # BREX-S1-… numbers are kept as the origin; default-BREX rules, not
    # "not a BRDP identifier" (their own classification, see below).
    assert sum(1 for c in candidates if c["origin_identifier"].startswith("BREX-S1-")) == 243
    assert not any(w["code"] == "not_brdp_identifier" for w in ids["BREX-S1-00001"]["warnings"])
    # No nonContextRule in the "CA" BREX, but every candidate's rules share
    # one objectUse: it is the Proposal of all 533 (S1-00007: one text over
    # its 4,500 rules, not only the 20 kept in object_uses).
    assert all(c["proposal_from"] == "object_use" for c in candidates)
    assert s7["literal"]["proposal"] == (
        "The element or attribute is not used. The list of optional elements are specified in List of Optional Elements appendix. (Chap. 2.5.1 Para_2.1.3)."
    )
    assert ids["BRDP-S1-00012"]["literal"]["proposal"] == 'The security classification is always "01" (Unclassified). (Chap. 3.6 Para_2.4).'
    assert ids["BRDP-S2-00002"]["rule_count"] == 301


def test_other_specification_names():
    assert other_specification("BRDP-S2-00002", "S1000D 4.2") == "S2000M"
    assert other_specification("BRDP-S3-00010", "S1000D 4.2") == "S3000L"
    assert other_specification("BRDP-S1-00010", "S1000D 4.2") is None
    assert other_specification("BRDP-EXT-00010", "S1000D 4.2") is None
    assert other_specification("BREX-S1-00001", "S1000D 4.2") is None
    assert other_specification("BRDP-S1-00010", "DITA 1.3 Xpath2.0") is None
    assert default_rule_specification("BREX-S1-00001") == "S1000D"
    assert default_rule_specification("BREX-S2-00010") == "S2000M"
    assert default_rule_specification("BRDP-S1-00001") is None


def test_literal_texts_from_the_noncontext_paragraphs():
    # Two paragraphs: Definition + Proposal, "Decision made by Project." dropped.
    assert literal_texts([["Decide X.", "Decision made by Project. X shall be used."]]) == {"title": None,
        "definition": "Decide X.", "proposal": "X shall be used."}
    # A bare decision paragraph stays as it is.
    assert literal_texts([["Decide X.", "Decision made by TDWG."]])["proposal"] == "Decision made by TDWG."
    assert literal_texts([["Decide X.", "Decision made by Project."]])["proposal"] == "Decision made by Project."
    # More paragraphs: all of them after the first, one per line.
    assert literal_texts([["Decide X.", "Decision made by Project. A.", "B."]])["proposal"] == "A.\nB."
    # One paragraph: it is the Proposal; Title and Definition from elsewhere.
    assert literal_texts([["Only text."]]) == {"title": None, "definition": None, "proposal": "Only text."}
    # The identifier alone in the first paragraph: no Definition.
    assert literal_texts([["", "Decision made by Project. Y."]]) == {"title": None, "definition": None, "proposal": "Y."}
    assert literal_texts([]) == {"title": None, "definition": None, "proposal": None}


def _ref_rule(identifier, use, path="//x"):
    return (
        f'<structureObjectRule><brDecisionRef brDecisionIdentNumber="{identifier}"/>'
        f'<objectPath allowedObjectFlag="0">{path}</objectPath><objectUse>{use}</objectUse></structureObjectRule>'
    )


def test_proposal_from_the_objectuse_every_rule_shares():
    """Without a nonContextRule, the one objectUse all the candidate's rules
    share is the Proposal (whitespace and the identifier in front do not
    count); several distinct ones, none, or only the identifier / who
    decided: the AI writes it."""
    content = (
        # Same text in both rules, written differently.
        _ref_rule("BRDP-S1-00012", "BRDP-S1-00012. Caveats are\n   not used.") + _ref_rule("BRDP-S1-00012", "Caveats are not used.", "//y")
        # Two distinct objectUses.
        + _ref_rule("BRDP-S1-00013", "Caveats are not used.") + _ref_rule("BRDP-S1-00013", "Something else.", "//y")
        # Empty, and only the identifier.
        + _ref_rule("BRDP-S1-00014", "") + _ref_rule("BRDP-S1-00015", "BRDP-S1-00015.")
        # Only who decided; then who decided + a real text.
        + _ref_rule("BRDP-S1-00016", "BRDP-S1-00016. Decision by Company.")
        + _ref_rule("BRDP-S1-00017", "BRDP-S1-00017. Decision by Company.") + _ref_rule("BRDP-S1-00017", "BRDP-S1-00017. Allowed codes: 055.", "//y")
        # A nonContextRule wins over the objectUse.
        + _ref_rule("BRDP-S1-00018", "Rule text.")
        + '<nonContextRule id="BRDP-S1-00018"><simplePara>BRDP-S1-00018. Decide Y.</simplePara><simplePara>Decision made by Project. Y shall be used.</simplePara></nonContextRule>'
    )
    rf = read_rules_file(_brex("4.2", content), "BREX-4.2", "S1000D 4.2")
    ids = _by_id(build_candidates(rf, "4.2")[0])
    proposal = {i: (ids[i]["literal"]["proposal"], ids[i]["proposal_from"]) for i in ids}
    assert proposal["BRDP-S1-00012"] == ("Caveats are not used.", "object_use")
    assert proposal["BRDP-S1-00013"] == (None, None)
    assert proposal["BRDP-S1-00014"] == (None, None)
    assert proposal["BRDP-S1-00015"] == (None, None)
    assert proposal["BRDP-S1-00016"] == (None, None)
    assert proposal["BRDP-S1-00017"] == ("Allowed codes: 055.", "object_use")
    assert proposal["BRDP-S1-00018"] == ("Y shall be used.", "noncontext")
    # Given to the review as the file's text: catalog with it → nothing for the AI.
    c = {"classification": "catalog", "literal": ids["BRDP-S1-00012"]["literal"], "catalog_texts": {"title": "T", "definition": "D"}}
    set_texts(c)
    assert (c["proposal"], c["text_sources"]["proposal"], c["ai_fields"]) == ("Caveats are not used.", "file", [])
    assert object_use_text("Decision made by TDWG. Use A.", None) == "Use A."
    assert object_use_text("BRDP-S1-00002. Decision by .", "BRDP-S1-00002") == ""


def test_proposal_from_objuse_in_3_0_1_and_never_from_schematron_messages():
    content = (
        '<objrule id="BRDP-S1-00133"><objpath objappl="0">//randlist</objpath><objuse>BRDP-S1-00133. No random lists.</objuse></objrule>'
    )
    rf = read_rules_file(_brex("3.0.1", content), "BREX-3.0.1", "S1000D 3.0.1")
    c = _by_id(build_candidates(rf, "3.0.1")[0])["BRDP-S1-00133"]
    assert (c["literal"]["proposal"], c["proposal_from"]) == ("No random lists.", "object_use")
    rf = read_rules_file(XPATH2.read_bytes(), "SCH-DITA", "DITA 1.3 Xpath2.0")
    assert not any(c["proposal_from"] for c in build_candidates(rf, None)[0])


def test_set_texts_sources_and_ai_fields():
    lit = {"definition": "File def.", "proposal": "File proposal."}
    # New EXT with literal texts: only the Title is for the AI.
    c = {"classification": "new_ext", "literal": lit}
    set_texts(c)
    assert (c["definition"], c["proposal"]) == ("File def.", "File proposal.")
    assert c["text_sources"] == {"title": None, "definition": "file", "proposal": "file"}
    assert (c["ai_fields"], c["draft_status"]) == (["title"], "pending")
    # Catalog: Title/Definition from the catalog, Proposal from the file: no AI.
    c = {"classification": "catalog", "literal": lit, "catalog_texts": {"title": "Cat T", "definition": "Cat D"}}
    set_texts(c)
    assert (c["title"], c["definition"], c["proposal"]) == ("Cat T", "Cat D", "File proposal.")
    assert c["text_sources"] == {"title": "catalog", "definition": "catalog", "proposal": "file"}
    assert (c["ai_fields"], c["draft_status"]) == ([], "not_needed")
    # Only executable rules, no decision text: the AI writes the Proposal.
    c = {"classification": "catalog", "literal": {"definition": None, "proposal": None}, "catalog_texts": {"title": "T", "definition": "D"}}
    set_texts(c)
    assert (c["ai_fields"], c["draft_status"]) == (["proposal"], "pending")
    # One paragraph: the Proposal; Title and Definition from the AI.
    c = {"classification": "new_ext", "literal": {"definition": None, "proposal": "P."}}
    set_texts(c)
    assert c["ai_fields"] == ["title", "definition"]
    # Reclassified: the AI's title kept where the AI writes; a hand edit kept always.
    c = {"classification": "catalog", "literal": lit, "catalog_texts": {"title": "Cat T", "definition": "Cat D"},
         "title": "AI title", "definition": "x", "proposal": "Hand proposal",
         "text_sources": {"title": "ai", "definition": "ai", "proposal": "manual"}}
    c["classification"] = "new_ext"
    set_texts(c, keep_written=True)
    assert (c["title"], c["definition"], c["proposal"]) == ("AI title", "File def.", "Hand proposal")
    assert c["text_sources"] == {"title": "ai", "definition": "file", "proposal": "manual"}
    assert c["draft_status"] == "drafted"


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
    # The 3.0.1 nonContextRule (a comment) is the candidate's rule, and its
    # single text the Proposal.
    assert ids["BRDP-S1-00004"]["rule_count"] == 0
    assert ids["BRDP-S1-00004"]["rule_xml"] == '<!-- nonContextRule id="BRDP-S1-00004": Decide which information sets to use. -->'
    assert ids["BRDP-S1-00004"]["rule_problem"] is None
    assert ids["BRDP-S1-00004"]["decision_texts"] == ["Decide which information sets to use."]
    assert ids["BRDP-S1-00004"]["literal"] == {"title": None, "definition": None, "proposal": "Decide which information sets to use."}


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


async def _apply(client, url, headers, body):
    """POST …/apply after writing, as the AI would, the texts still missing
    of the keys sent (the import refuses checked rows without texts)."""
    cands = (await client.get(f"{url}/candidates", headers=headers)).json()["candidates"]
    keys = set(body["keys"])
    items = [
        {"key": c["key"], "draft_status": "drafted", **{f: c.get(f) or f"AI {f} {c['key']}" for f in c.get("ai_fields") or []}}
        for c in cands
        if c["key"] in keys and c.get("ai_fields") and c["classification"] not in ("same", "changed", "empty")
        and not all(c.get(f) for f in c["ai_fields"])
    ]
    if items:
        res = await client.patch(f"{url}/candidates", headers=headers, json={"items": items})
        assert res.status_code == 200, res.text
    return await client.post(f"{url}/apply", headers=headers, json=body)


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
    assert res.status_code == 422 and res.json()["detail"]["code"] == "extract_not_well_formed"
    assert "not well-formed" in res.json()["detail"]["message"]
    res = await _upload(client, project.id, editor, b"")
    assert res.status_code == 422 and res.json()["detail"] == {"code": "extract_file_empty", "message": "The file is empty."}
    monkeypatch.setattr(get_settings(), "rule_extract_max_bytes", 1000)
    res = await _upload(client, project.id, editor, b"<x>" + b" " * 2000 + b"</x>")
    assert res.status_code == 413
    assert res.json()["detail"]["code"] == "extract_file_too_large"
    assert "limit for a BREX or Schematron" in res.json()["detail"]["message"]


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
    # A free EXT number of the file keeps its number; a new one is the next
    # after the project's (EXT-00003) AND the file's (EXT-00014).
    assert by["BRDP-EXT-00014"]["identifier"] == "BRDP-EXT-00014"
    assert by["BRDP-S1-99999"]["classification"] == "new_ext"
    assert by["BRDP-S1-99999"]["identifier"] == "BRDP-EXT-00015"
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
    res = await _apply(client, url, editor, {"keys": keys})
    assert res.status_code == 200, res.text
    result = res.json()
    assert (result["created"], result["updated"], result["omitted"]) == (4, 1, 0)
    assert (await client.post(f"{url}/apply", headers=editor, json={"keys": keys})).status_code == 409

    async with async_session_factory() as session:
        brdps = {b.identifier: b for b in (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).scalars()}
        ext4 = brdps["BRDP-EXT-00014"]
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
    # S1-99999, missing from the catalog, became BRDP-EXT-00015: found
    # again through the origin kept in its history, so a re-import is
    # "same", never another EXT.
    assert (by2["BRDP-EXT-00014"]["classification"], by2["BRDP-EXT-00014"]["identifier"]) == ("same", "BRDP-EXT-00014")
    assert (by2["BRDP-S1-99999"]["classification"], by2["BRDP-S1-99999"]["identifier"]) == ("same", "BRDP-EXT-00015")
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
    res = await _apply(client, url, editor, {"keys": [c["key"]]})
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
    # BREX-S1-… : rules of S1000D's default BREX, unchecked, with the note.
    default = [c for c in cands if c["origin_identifier"].startswith("BREX-S1-")]
    assert len(default) == 243
    assert all(c["classification"] == "default_rule" and c["selected"] is False for c in default)
    b1 = by["BREX-S1-00001"]
    assert (b1["specification"], b1["identifier"], b1["options"]) == ("S1000D", "BREX-S1-00001", ["default_rule", "new_ext"])
    assert [w["code"] for w in b1["warnings"]] == ["default_rule"]
    # Its Proposal is its objectUse; the AI writes Title and Definition.
    assert b1["ai_fields"] == ["title", "definition"] and b1["text_sources"]["proposal"] == "file"
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await _apply(client, url, editor, {"keys": [s7["key"], b1["key"]]})
    assert res.status_code == 200 and res.json()["created"] == 2
    created = {c["key"]: c["identifier"] for c in res.json()["created_identifiers"]}
    assert created[b1["key"]] == "BREX-S1-00001"
    async with async_session_factory() as session:
        brdps = {b.identifier: b for b in (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).scalars()}
        approval = await session.get(RuleApproval, (brdps[created[s7["key"]]].id, "BREX-4.2"))
        assert approval.rule_xml.count("<structureObjectRule>") == 4500
        # Checked by the user: imported with its own identifier.
        assert await session.get(RuleApproval, (brdps["BREX-S1-00001"].id, "BREX-4.2")) is not None


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


async def test_lufthansa_round_trip_keeps_every_noncontext_rule(client, project_users):
    """The whole Lufthansa BREX imported: the 469 nonContextRules are in the
    stored rules (Generate writes them back into <nonContextRules>), the
    literal texts are the BRDPs' Definition/Proposal, and a re-import finds
    everything "same"."""
    project, editor, _ = project_users
    job, cands = await _extract(client, project.id, editor, LUFTHANSA.read_bytes(), LUFTHANSA.name)
    by = _by_id(cands)
    # Literal texts: nothing for the AI but the Title of a new EXT.
    s117 = by["BRDP-S1-00117"]
    assert (s117["proposal"], s117["text_sources"]["proposal"]) == ("Captions shall not be used.", "file")
    assert s117["text_sources"]["definition"] == "file" and s117["ai_fields"] == ["title"]
    assert sum(1 for c in cands if c["text_sources"].get("proposal") == "file") == 470
    assert sum(1 for c in cands if "proposal" in c["ai_fields"]) == 32
    # An S1 identifier renumbered as EXT names itself only in the objectUse
    # text: no "identifiers inside the rule" warning (that one is for an EXT
    # number of the file that was taken).
    assert not any(w["code"] == "rule_ids_from_file" for c in cands for w in c["warnings"])
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await _apply(client, url, editor, {"keys": [c["key"] for c in cands]})
    assert res.status_code == 200 and res.json()["created"] == 502 and res.json()["invalid_rule"] == 0
    created = {c["key"]: c["identifier"] for c in res.json()["created_identifiers"]}
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(BRDP.identifier, BRDP.definition, BRDP.proposal, RuleApproval.rule_xml)
                .join(RuleApproval, RuleApproval.brdp_id == BRDP.id)
                .where(BRDP.project_id == project.id)
            )
        ).all()
    assert len(rows) == 502
    pieces = [p for r in rows for p in split_rule_pieces(r.rule_xml, "BREX-4.2")]
    assert sum(1 for p in pieces if p["kind"] == "noncontext") == 469
    assert sum(r.rule_xml.count("<structureObjectRule>") for r in rows) == sum(c["rule_count"] for c in cands) == 61
    stored = {r.identifier: r for r in rows}[created[s117["key"]]]
    assert stored.proposal == "Captions shall not be used."
    assert stored.definition.startswith("Decide whether inline captions affect")
    # Re-import: everything "same".
    _, cands2 = await _extract(client, project.id, editor, LUFTHANSA.read_bytes(), LUFTHANSA.name)
    assert {c["classification"] for c in cands2} == {"same"}


async def test_reimport_of_a_rule_saved_before_noncontext_rules_were_kept(client, project_users):
    """A BRDP imported before this change (rule without its nonContextRule,
    or no rule at all) is "changed" now; one with the same rule is "same"."""
    project, editor, _ = project_users
    content = (
        "<contextRules>" + _rule("BRDP-S1-00117", "//caption") + _rule("BRDP-S1-00070", "//originator") + "</contextRules>"
        "<nonContextRules>"
        "<nonContextRule><simplePara>BRDP-S1-00117. Decide captions.</simplePara><simplePara>Decision made by Project. Captions shall not be used.</simplePara></nonContextRule>"
        "<nonContextRule><simplePara>BRDP-S1-00001. Decide I and O.</simplePara><simplePara>Decision made by TDWG.</simplePara></nonContextRule>"
        "</nonContextRules>"
    )
    await _seed(project.id, "BRDP-S1-00117", _rule("BRDP-S1-00117", "//caption"))
    await _seed(project.id, "BRDP-S1-00001")
    await _seed(project.id, "BRDP-S1-00070", _rule("BRDP-S1-00070", "//originator"))
    _, cands = await _extract(client, project.id, editor, _brex("4.2", content))
    by = _by_id(cands)
    assert by["BRDP-S1-00117"]["classification"] == "changed"
    assert by["BRDP-S1-00001"]["classification"] == "changed"
    assert by["BRDP-S1-00070"]["classification"] == "same"
    # An existing BRDP keeps its texts: they are the project's.
    assert by["BRDP-S1-00117"]["text_sources"] == {"title": "project", "definition": "project", "proposal": "project"}


async def test_reclassifying_sets_the_texts_again(client, project_users, synthetic_standard):
    project, editor, _ = project_users
    async with async_session_factory() as session:
        session.add(BRDPCatalog(standard=synthetic_standard, identifier="BRDP-S1-00117", title="Cat T", definition="Cat D"))
        await session.commit()
    content = (
        "<contextRules>" + _rule("BRDP-S1-00117", "//caption") + "</contextRules>"
        "<nonContextRules><nonContextRule><simplePara>BRDP-S1-00117. Decide captions.</simplePara>"
        "<simplePara>Decision made by Project. Captions shall not be used.</simplePara></nonContextRule></nonContextRules>"
    )
    job, cands = await _extract(client, project.id, editor, _brex("4.2", content))
    [c] = cands
    assert (c["classification"], c["title"], c["definition"], c["proposal"]) == ("catalog", "Cat T", "Cat D", "Captions shall not be used.")
    assert (c["ai_fields"], c["draft_status"]) == ([], "not_needed")
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}/candidates"
    res = await client.patch(url, headers=editor, json={"items": [{"key": c["key"], "classification": "new_ext"}]})
    [c] = res.json()["candidates"]
    assert (c["title"], c["definition"], c["proposal"]) == ("", "Decide captions.", "Captions shall not be used.")
    assert (c["ai_fields"], c["draft_status"]) == (["title"], "pending")
    # The AI's title, then a hand edit of the Proposal: sources follow.
    await client.patch(url, headers=editor, json={"items": [{"key": c["key"], "title": "Captions", "draft_status": "drafted"}]})
    res = await client.patch(url, headers=editor, json={"items": [{"key": c["key"], "proposal": "No captions.", "draft_status": "manual"}]})
    [c] = res.json()["candidates"]
    assert c["text_sources"] == {"title": "ai", "definition": "file", "proposal": "manual"}


async def test_parse_errors_always_have_a_reason(client, project_users, monkeypatch, caplog):
    """HR7 + Decisión 12: an unexpected error answers with a code and a
    reference, never the exception's text; the text goes to the log under
    that reference. A missing table (the migration not applied) has its own
    code."""
    import logging

    from sqlalchemy.exc import ProgrammingError

    from app.api.routes import rule_extract as route

    project, editor, _ = project_users

    def boom(*_a, **_k):
        raise RuntimeError("something odd")

    monkeypatch.setattr(route, "read_rules_file", boom)
    with caplog.at_level(logging.ERROR, logger="app.errors"):
        res = await _upload(client, project.id, editor, _brex("4.2", ""))
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert detail["code"] == "internal_error" and len(detail["ref"]) == 8
    assert "something odd" not in res.text and "RuntimeError" not in res.text
    logged = [r for r in caplog.records if f"ref={detail['ref']}" in r.getMessage()]
    assert logged and "something odd" in "".join(__import__("traceback").format_exception(*logged[0].exc_info))

    class UndefinedTableError(Exception):
        pass

    async def missing_table(*_a, **_k):
        raise ProgrammingError("SELECT … FROM rule_extract_jobs", {}, UndefinedTableError('relation "rule_extract_jobs" does not exist'))

    monkeypatch.setattr(route, "read_rules_file", read_rules_file)
    monkeypatch.setattr(route, "get_running_job", missing_table)
    res = await _upload(client, project.id, editor, _brex("4.2", ""))
    assert res.status_code == 503
    assert res.json()["detail"]["code"] == "database_not_migrated"
    assert "rule_extract_jobs" not in res.text and "relation" not in res.text
    # The page's first call (the latest extraction) too.
    monkeypatch.setattr(route, "get_most_recent_job", missing_table)
    res = await client.get(f"/api/projects/{project.id}/ai-extract/jobs/active", headers=editor)
    assert res.status_code == 503 and res.json()["detail"]["code"] == "database_not_migrated"


# ── Real Schematron files (tests/fixtures/schematron/) ────────────────────
#
# BRDP-D1_schematron-xpath2.sch: queryBinding xslt2, no prefix, 6 BRDPs
# (00001-00003, 00005-00007; 00004 only named in a comment), 00007 written as
# three patterns (00007a, 00007, 00007b), each with its own comment, and the
# @@URI-CARPETA-DOSIER@@ placeholder. BRDP-D1_schematron-xpath3.sch:
# xslt3, sch: prefix, 7 BRDPs, 9 global sch:let holding inline functions
# (textoNota and esAdvertencia call nodoConref) and one global sch:ns (xs).

SCH = Path(__file__).parent / "fixtures" / "schematron"
XPATH2 = SCH / "BRDP-D1_schematron-xpath2.sch"
XPATH3 = SCH / "BRDP-D1_schematron-xpath3.sch"
_GLOBAL_FUNCTIONS = ["colDe", "colContiene", "colPart", "valor", "docFicha", "nodoConref", "textoNota", "esAdvertencia", "conrefRoto"]


def _let_names(rule_xml):
    import re

    return re.findall(r'<(?:sch:)?let name="(\w+)"', rule_xml)


def test_xpath2_schematron_comments_titles_and_ids():
    rf = read_rules_file(XPATH2.read_bytes(), "SCH-DITA", "DITA 1.3 Xpath2.0")
    candidates, warnings = build_candidates(rf, None)
    assert [c["origin_identifier"] for c in candidates] == [
        "BRDP-EXT-00001", "BRDP-EXT-00002", "BRDP-EXT-00003", "BRDP-EXT-00005", "BRDP-EXT-00006", "BRDP-EXT-00007",
    ]
    assert all(c["rule_problem"] is None and c["warnings"] == [] for c in candidates)
    # Only file warning: 00004 is named in a comment but has no rule here.
    assert warnings == [
        {
            "code": "comment_without_rule",
            "params": {"identifier": "BRDP-EXT-00004"},
            "message": "BRDP-EXT-00004 is mentioned in a comment, but has no rule in this file.",
        }
    ]
    ids = _by_id(candidates)
    assert ids["BRDP-EXT-00001"]["literal"]["title"] == "Campo cantidad repuestos no vacío"
    assert ids["BRDP-EXT-00006"]["literal"]["title"] == 'Valores permitidos para Figuras y Marcas tras la fila "Repuestos"'
    # The comment before the pattern is stored with the rule, in front of it;
    # the file's header comment ("Cuatro cosas…") is not.
    r1 = ids["BRDP-EXT-00001"]["rule_xml"]
    assert r1.startswith("<!-- BRDP-EXT-00001 — Campo cantidad repuestos no vacío -->\n<pattern id=\"p-BRDP-EXT-00001\">")
    assert "Cuatro cosas" not in r1
    # 00005's comment block starts after 00004's comment (another BRDP).
    assert ids["BRDP-EXT-00005"]["rule_xml"].startswith("<!-- BRDP-EXT-00005 — Valores permitidos para NOC")
    # 00007: one candidate with its three patterns, each after its comment;
    # the section header (BRDP-EXT-00007 — …) goes with 00007a and gives the
    # title.
    c7 = ids["BRDP-EXT-00007"]
    assert c7["rule_count"] == 3
    assert c7["literal"]["title"] == "Toda advertencia del procedimiento, recogida en PRECAUCIONES DE SEGURIDAD."
    x = c7["rule_xml"]
    positions = [x.index(s) for s in (
        "BRDP-EXT-00007 — Toda advertencia", "BRDP-EXT-00007a — EL CENTINELA", '<pattern id="p-BRDP-EXT-00007a">',
        "BRDP-EXT-00007 — La comparacion", '<pattern id="p-BRDP-EXT-00007">',
        "BRDP-EXT-00007b — LA ADVERTENCIA", '<pattern id="p-BRDP-EXT-00007b">',
    )]
    assert positions == sorted(positions)
    # The placeholder replaced outside the app stays literal.
    assert x.count("'@@URI-CARPETA-DOSIER@@'") == 3
    # Proposal still for the AI: the title is the only fixed text.
    set_texts(c7)
    assert c7["title"] == c7["literal"]["title"] and c7["text_sources"]["title"] == "file"
    assert c7["ai_fields"] == ["definition", "proposal"]


def test_xpath3_schematron_each_rule_carries_the_global_functions_it_uses():
    rf = read_rules_file(XPATH3.read_bytes(), "SCH-DITA", "DITA 1.3 Xpath3.0")
    assert rf.warnings == []
    candidates, warnings = build_candidates(rf, None)
    # Every global sch:let and the sch:ns is used by some rule: no warning.
    assert warnings == []
    ids = _by_id(candidates)
    assert list(ids) == [f"BRDP-EXT-0000{n}" for n in range(1, 8)]
    lets = {i: [n for n in _let_names(c["rule_xml"]) if n in _GLOBAL_FUNCTIONS] for i, c in ids.items()}
    # Each after the ones it uses, alphabetical otherwise (never the file's
    # order, so a document generated by the app imports back the same).
    assert lets["BRDP-EXT-00001"] == ["colDe", "colPart", "valor"]
    assert lets["BRDP-EXT-00006"] == ["colContiene", "colDe", "colPart", "valor"]
    assert lets["BRDP-EXT-00004"] == ["docFicha"]
    # textoNota, esAdvertencia and conrefRoto call nodoConref: it comes
    # along, before them.
    assert lets["BRDP-EXT-00007"] == ["docFicha", "nodoConref", "conrefRoto", "esAdvertencia", "textoNota"]
    assert set().union(*map(set, lets.values())) == set(_GLOBAL_FUNCTIONS)
    for c in candidates:
        x = c["rule_xml"]
        assert c["rule_problem"] is None, c["origin_identifier"]
        # The functions are typed xs:…: the pattern declares the prefix.
        assert 'xmlns:xs="http://www.w3.org/2001/XMLSchema"' in x.split(">", 1)[0] + x[x.index("<sch:pattern"):].split(">", 1)[0]
        # The copied let is the file's text, as written.
        assert '<sch:let name="valor"\n           value="function($fila as element(), $col as xs:string) as xs:string {' in x or "valor" not in lets[c["origin_identifier"]]
        assert not any(w["code"] == "undeclared_variable" for w in c["warnings"])
    # The lets go first inside the pattern, before its rule.
    x1 = ids["BRDP-EXT-00001"]["rule_xml"]
    assert x1.index('<sch:let name="colDe"') < x1.index("<sch:rule ")
    assert ids["BRDP-EXT-00004"]["literal"]["title"] == "El escalón de mantenimiento de la planificación coincide con el del procedimiento."


def _function_comments(text):
    """{function name: the comment right before its global sch:let} of the
    real xpath3 file."""
    import re

    text = text.replace("\r\n", "\n")
    return {
        m.group(2): m.group(1)
        for m in re.finditer(r'(<!--(?:(?!-->)[\s\S])*-->)\s*<sch:let name="(\w+)"', text)
        if m.group(2) in _GLOBAL_FUNCTIONS
    }


def test_xpath3_schematron_function_comments_travel_with_their_functions():
    comments = _function_comments(XPATH3.read_text(encoding="utf-8"))
    # The fixture: 9 functions, each with its comment.
    assert sorted(comments) == sorted(_GLOBAL_FUNCTIONS)
    rf = read_rules_file(XPATH3.read_bytes(), "SCH-DITA", "DITA 1.3 Xpath3.0")
    candidates, _ = build_candidates(rf, None)
    for c in candidates:
        x = c["rule_xml"]
        for name in _let_names(x):
            if name not in _GLOBAL_FUNCTIONS:
                continue
            # Each copy of a function has its comment right before it, once.
            at = x.index(f'<sch:let name="{name}"')
            before = x[:at].rstrip()
            assert before.endswith(comments[name]), (c["origin_identifier"], name)
            assert x.count(comments[name]) == 1
        # The two header blocks of the file are never kept.
        assert "QUÉ ES ESTE FICHERO" not in x and "FUNCIONES COMPARTIDAS" not in x


def test_global_let_comment_only_when_right_before_it():
    text = XPATH3.read_text(encoding="utf-8").replace("\r\n", "\n")
    comments = _function_comments(text)
    # colDe: its comment removed, so the one before it is the section header
    # (==== FUNCIONES COMPARTIDAS ====), which is not kept: no comment.
    text = text.replace(comments["colDe"] + "\n", "", 1)
    # colPart: an element between its comment and the function -- the
    # comment stays behind.
    text = text.replace(comments["colPart"], comments["colPart"] + '\n  <sch:let name="separa" value="1"/>', 1)
    # valor: a comment about a rule (starts with a BRDP id) is not its comment.
    text = text.replace(comments["valor"], "<!-- BRDP-EXT-00009 — otra regla -->", 1)
    rf = read_rules_file(text.encode("utf-8"), "SCH-DITA", "DITA 1.3 Xpath3.0")
    candidates, _ = build_candidates(rf, None)
    x1 = _by_id(candidates)["BRDP-EXT-00001"]["rule_xml"]
    for name in ("colDe", "colPart", "valor"):
        at = x1.index(f'<sch:let name="{name}"')
        assert not x1[:at].rstrip().endswith("-->"), name
    assert comments["colPart"] not in x1 and "FUNCIONES COMPARTIDAS" not in x1 and "otra regla" not in x1


def test_schematron_undeclared_variable_and_unused_globals():
    text = XPATH3.read_text(encoding="utf-8")
    # $valor declared nowhere (renamed), and an extra global nobody uses.
    text = text.replace('<sch:let name="valor"', '<sch:let name="valorRenombrado"', 1)
    text = text.replace('<sch:ns prefix="xs"', '<sch:let name="sinUso" value="1"/>\n  <sch:ns prefix="xs"', 1)
    rf = read_rules_file(text.encode("utf-8"), "SCH-DITA", "DITA 1.3 Xpath3.0")
    candidates, warnings = build_candidates(rf, None)
    ids = _by_id(candidates)
    w1 = [w for w in ids["BRDP-EXT-00001"]["warnings"] if w["code"] == "undeclared_variable"]
    assert w1 == [{"code": "undeclared_variable", "params": {"names": ["valor"]}, "message": "Uses $valor, which is not declared in the file."}]
    assert not ids["BRDP-EXT-00007"]["warnings"]
    assert warnings == [
        {
            "code": "schematron_globals",
            "params": {"element": "sch:let", "count": 2, "names": ["sinUso", "valorRenombrado"]},
            "message": "The Schematron has 2 global sch:let that no rule uses; they are not imported.",
        }
    ]


def test_xpath3_schematron_is_refused_in_an_xpath2_project():
    with pytest.raises(RuleExtractFileError) as exc:
        read_rules_file(XPATH3.read_bytes(), "SCH-DITA", "DITA 1.3 Xpath2.0")
    assert str(exc.value) == (
        'This Schematron uses queryBinding="xslt3" (XPath 3.0); this project is DITA 1.3 Xpath2.0, which runs XPath 2.0.'
    )


def test_schematron_value_of_never_reaches_the_message_text():
    rf = read_rules_file(XPATH3.read_bytes(), "SCH-DITA", "DITA 1.3 Xpath3.0")
    c6 = _by_id(build_candidates(rf, None)[0])["BRDP-EXT-00006"]
    messages = [r["message"] for r in c6["summary"]["rules"]]
    assert any(m.endswith('Valor leído: "…".') for m in messages)
    assert not any("value-of" in m or "$docTec" in m for m in messages)


async def _dita(project_id, standard):
    async with async_session_factory() as session:
        project = await session.get(Project, project_id)
        project.standard = standard
        await session.commit()


async def _project_brdps(project_id):
    async with async_session_factory() as session:
        rows = (await session.execute(select(BRDP).where(BRDP.project_id == project_id))).scalars().all()
        out = {}
        for b in rows:
            approval = await session.get(RuleApproval, (b.id, "SCH-DITA"))
            out[b.identifier] = (b, approval)
        return out


async def test_xpath2_schematron_in_an_empty_project_keeps_its_ids_and_round_trips(client, project_users):
    project, editor, _ = project_users
    await _dita(project.id, "DITA 1.3 Xpath2.0")
    job, cands = await _extract(client, project.id, editor, XPATH2.read_bytes(), "BRDP-D1_schematron-xpath2.sch")
    assert [w["code"] for w in job["warnings"]] == ["comment_without_rule"]
    # Free EXT numbers of the file are kept, never shifted.
    assert [(c["classification"], c["identifier"]) for c in cands] == [
        ("new_ext", f"BRDP-EXT-0000{n}") for n in (1, 2, 3, 5, 6, 7)
    ]
    assert all(not any(w["code"] == "rule_ids_from_file" for w in c["warnings"]) for c in cands)
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await _apply(client, url, editor, {"keys": [c["key"] for c in cands], "import_as": "in_force"})
    assert res.status_code == 200, res.text
    result = res.json()
    assert (result["created"], result["kept_pending"], result["import_as"]) == (6, 0, "in_force")
    brdps = await _project_brdps(project.id)
    assert sorted(brdps) == [f"BRDP-EXT-0000{n}" for n in (1, 2, 3, 5, 6, 7)]
    b1, a1 = brdps["BRDP-EXT-00001"]
    assert (b1.title, b1.validation) == ("Campo cantidad repuestos no vacío", "Validated")
    assert (a1.status, a1.source) == ("approved", "extracted") and a1.approved_at is not None
    async with async_session_factory() as session:
        hist = {h.field_name: h for h in (await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id == b1.id))).scalars()}
    assert (hist["rule_status"].old_value, hist["rule_status"].new_value) == ("todo", "verified")
    assert json.loads(hist["extracted_from"].new_value) == {
        "file": "BRDP-D1_schematron-xpath2.sch", "origin_identifier": "BRDP-EXT-00001", "in_force": True,
    }
    # Re-importing the same file: every candidate is "same".
    _, cands2 = await _extract(client, project.id, editor, XPATH2.read_bytes(), "BRDP-D1_schematron-xpath2.sch")
    assert [c["classification"] for c in cands2] == ["same"] * 6


async def test_xpath3_schematron_imports_as_pending_review(client, project_users):
    project, editor, _ = project_users
    await _dita(project.id, "DITA 1.3 Xpath3.0")
    job, cands = await _extract(client, project.id, editor, XPATH3.read_bytes(), "BRDP-D1_schematron-xpath3.sch")
    assert job["warnings"] == []
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await _apply(client, url, editor, {"keys": [c["key"] for c in cands]})
    assert res.status_code == 200 and res.json()["import_as"] == "pending"
    brdps = await _project_brdps(project.id)
    assert len(brdps) == 7
    for identifier, (b, a) in brdps.items():
        assert (b.validation, a.status) == ("Pending", "pending_review"), identifier
    assert _let_names(brdps["BRDP-EXT-00007"][1].rule_xml)[:5] == ["docFicha", "nodoConref", "conrefRoto", "esAdvertencia", "textoNota"]
    assert 'xmlns:xs="http://www.w3.org/2001/XMLSchema"' in brdps["BRDP-EXT-00001"][1].rule_xml


async def test_ext_numbers_of_the_file(client, project_users):
    """A free EXT number keeps its number; an occupied one with another rule
    is "changed"; reclassified as a new EXT it takes the next free number
    and warns that the ids inside the rule are still the file's; a rule
    with no identifier takes the next number after the file's own."""
    project, editor, _ = project_users
    await _seed(project.id, "BRDP-EXT-00005", _rule("BRDP-EXT-00005", "//para"))
    content = (
        "<contextRules>"
        + '<structureObjectRule id="BRDP-EXT-00002"><objectPath allowedObjectFlag="0">//a</objectPath><objectUse>A.</objectUse></structureObjectRule>'
        + '<structureObjectRule id="p-BRDP-EXT-00005"><objectPath allowedObjectFlag="0">//b</objectPath><objectUse>B.</objectUse></structureObjectRule>'
        + '<structureObjectRule><objectPath allowedObjectFlag="0">//c</objectPath><objectUse>No identifier.</objectUse></structureObjectRule>'
        + '<structureObjectRule id="BRDP-EXT-00009"><objectPath allowedObjectFlag="0">//d</objectPath><objectUse>D.</objectUse></structureObjectRule>'
        + "</contextRules>"
    )
    job, cands = await _extract(client, project.id, editor, _brex("4.2", content))
    got = [(c["origin_identifier"], c["classification"], c["identifier"]) for c in cands]
    assert got == [
        ("BRDP-EXT-00002", "new_ext", "BRDP-EXT-00002"),
        ("BRDP-EXT-00005", "changed", "BRDP-EXT-00005"),
        # After the project's (00005) and the file's (00009): 00010.
        (None, "new_ext", "BRDP-EXT-00010"),
        ("BRDP-EXT-00009", "new_ext", "BRDP-EXT-00009"),
    ]
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    k5 = cands[1]["key"]
    res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [{"key": k5, "classification": "new_ext"}]})
    assert res.status_code == 200, res.text
    [c5] = res.json()["candidates"]
    assert c5["identifier"] == "BRDP-EXT-00011"
    [w] = [w for w in c5["warnings"] if w["code"] == "rule_ids_from_file"]
    assert w["params"] == {"identifier": "BRDP-EXT-00011", "origin": "BRDP-EXT-00005", "ids": ["p-BRDP-EXT-00005"]}
    # Back to "changed": its identifier again, no warning.
    res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [{"key": k5, "classification": "changed"}]})
    [c5] = res.json()["candidates"]
    assert c5["identifier"] == "BRDP-EXT-00005" and not any(w["code"] == "rule_ids_from_file" for w in c5["warnings"])
    res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [{"key": k5, "classification": "new_ext"}]})
    assert res.json()["candidates"][0]["identifier"] == "BRDP-EXT-00011"
    res = await _apply(client, url, editor, {"keys": [c["key"] for c in cands]})
    assert res.status_code == 200, res.text
    created = {c["key"]: c["identifier"] for c in res.json()["created_identifiers"]}
    assert [created[c["key"]] for c in cands] == ["BRDP-EXT-00002", "BRDP-EXT-00011", "BRDP-EXT-00010", "BRDP-EXT-00009"]
    async with async_session_factory() as session:
        ids = set((await session.execute(select(BRDP.identifier).where(BRDP.project_id == project.id))).scalars())
    assert ids == {"BRDP-EXT-00002", "BRDP-EXT-00005", "BRDP-EXT-00009", "BRDP-EXT-00010", "BRDP-EXT-00011"}


async def test_in_force_import(client, project_users):
    """"Ya en vigor": Validated + Verified for valid rules; a candidate whose
    rule is not valid stays Pending without rule; a changed rule is
    Verified and the existing Proposal is untouched."""
    project, editor, _ = project_users
    await _seed(project.id, "BRDP-EXT-00001", _rule("BRDP-EXT-00001", "//para"), proposal="Kept proposal", validation="Refused")
    content = (
        "<contextRules>"
        + _rule("BRDP-EXT-00001", "//footnote")
        + _rule("BRDP-EXT-00002", "//caption")
        + '<structureObjectRule id="BRDP-EXT-00003"><objectPath allowedObjectFlag="0">//a</objectPath>'
        "<objectUse>Decision by &co;.</objectUse></structureObjectRule>"
        + "</contextRules>"
    )
    data = _brex("4.2", content).replace(b"?>\n", b'?>\n<!DOCTYPE dmodule [<!ENTITY co "Company">]>', 1)
    job, cands = await _extract(client, project.id, editor, data)
    by = _by_id(cands)
    # A rule that does not parse on its own has no identifier to read: a new EXT.
    [bad] = [c for c in cands if c["rule_problem"]]
    assert bad["rule_problem"]["code"] == "not_parsed" and bad["identifier"] == "BRDP-EXT-00003"
    by["BRDP-EXT-00003"] = bad
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    assert (await client.post(f"{url}/apply", headers=editor, json={"keys": [cands[0]["key"]], "import_as": "live"})).status_code == 422
    res = await _apply(client, url, editor, {"keys": [c["key"] for c in cands], "import_as": "in_force"})
    assert res.status_code == 200, res.text
    result = res.json()
    assert (result["created"], result["updated"], result["kept_pending"], result["invalid_rule"]) == (2, 1, 1, 1)
    assert result["kept_pending_detail"] == [{"key": by["BRDP-EXT-00003"]["key"], "identifier": "BRDP-EXT-00003"}]
    async with async_session_factory() as session:
        brdps = {b.identifier: b for b in (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).scalars()}
        b1 = brdps["BRDP-EXT-00001"]
        assert (b1.proposal, b1.validation) == ("Kept proposal", "Refused")
        a1 = await session.get(RuleApproval, (b1.id, "BREX-4.2"))
        assert a1.status == "approved" and "//footnote" in a1.rule_xml
        assert brdps["BRDP-EXT-00002"].validation == "Validated"
        assert (await session.get(RuleApproval, (brdps["BRDP-EXT-00002"].id, "BREX-4.2"))).status == "approved"
        assert brdps["BRDP-EXT-00003"].validation == "Pending"
        assert await session.get(RuleApproval, (brdps["BRDP-EXT-00003"].id, "BREX-4.2")) is None
        events = {
            b: json.loads(h.new_value)
            for b, h in [
                (identifier, (await session.execute(select(BRDPHistory).where(BRDPHistory.brdp_id == brdps[identifier].id, BRDPHistory.field_name == "extracted_from"))).scalar_one())
                for identifier in ("BRDP-EXT-00001", "BRDP-EXT-00002", "BRDP-EXT-00003")
            ]
        }
    assert events["BRDP-EXT-00001"].get("in_force") is True
    assert events["BRDP-EXT-00002"].get("in_force") is True
    assert "in_force" not in events["BRDP-EXT-00003"]


async def test_lufthansa_in_force_import_is_all_verified(client, project_users):
    """The whole Lufthansa BREX "Ya en vigor": the 502 BRDPs Validated with
    their rule Verified (61 structureObjectRule + 469 nonContextRule), so a
    Generate with "only verified rules" takes all of them."""
    project, editor, _ = project_users
    job, cands = await _extract(client, project.id, editor, LUFTHANSA.read_bytes(), LUFTHANSA.name)
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    res = await _apply(client, url, editor, {"keys": [c["key"] for c in cands], "import_as": "in_force"})
    assert res.status_code == 200, res.text
    assert (res.json()["created"], res.json()["kept_pending"]) == (502, 0)
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(BRDP.validation, RuleApproval.status, RuleApproval.rule_xml)
                .join(RuleApproval, RuleApproval.brdp_id == BRDP.id)
                .where(BRDP.project_id == project.id)
            )
        ).all()
    assert {(r.validation, r.status) for r in rows} == {("Validated", "approved")}
    assert sum(r.rule_xml.count("<structureObjectRule>") for r in rows) == 61
    assert sum(1 for r in rows for p in split_rule_pieces(r.rule_xml, "BREX-4.2") if p["kind"] == "noncontext") == 469


# ── Import only with complete texts ───────────────────────────────────────


def test_text_state_from_the_data_alone():
    base = {"classification": "new_ext", "ai_fields": ["title", "definition"], "proposal": "P."}
    assert text_state({**base, "title": "", "definition": "", "draft_status": "pending"}) == "pending"
    assert text_state({**base, "title": "", "definition": "", "draft_status": "failed"}) == "failed"
    assert text_state({**base, "title": "T", "definition": "D", "draft_status": "drafted"}) == "complete"
    # A hand edit of one field of a failed row: still failed.
    assert text_state({**base, "title": "T", "definition": "", "draft_status": "failed"}) == "failed"
    assert text_state({"classification": "catalog", "ai_fields": [], "draft_status": "not_needed"}) == "complete"
    for cls in ("same", "changed", "empty"):
        assert text_state({"classification": cls, "ai_fields": ["title"], "title": ""}) == "complete"


def test_apply_edit_never_overwrites_a_hand_edit_and_works_out_the_status():
    c = {"key": "c1", "classification": "new_ext", "options": ["new_ext"], "ai_fields": ["title", "definition"],
         "title": "", "definition": "", "proposal": "P.", "draft_status": "failed", "text_sources": {"proposal": "file"}}
    # By hand, one of two fields: the row is still failed (blocks the import).
    one = apply_edit(c, {"key": "c1", "title": "Hand title", "draft_status": "manual"})
    assert (one["title"], one["text_sources"]["title"], one["draft_status"]) == ("Hand title", "manual", "failed")
    # Both: complete, "manual".
    both = apply_edit(one, {"key": "c1", "definition": "Hand def", "draft_status": "manual"})
    assert both["draft_status"] == "manual" and text_state(both) == "complete"
    # An AI batch coming back afterwards keeps the hand texts.
    after = apply_edit(both, {"key": "c1", "title": "AI title", "definition": "AI def", "draft_status": "drafted"})
    assert (after["title"], after["definition"]) == ("Hand title", "Hand def")
    # A failed AI batch never undoes texts already there.
    assert apply_edit(both, {"key": "c1", "draft_status": "failed"})["draft_status"] == "manual"
    # A pending row edited by hand in one field stays pending.
    pending = apply_edit({**c, "draft_status": "pending"}, {"key": "c1", "title": "T", "draft_status": "manual"})
    assert pending["draft_status"] == "pending"


async def test_apply_refuses_checked_rows_without_texts_unknown_keys_and_counts_every_row(client, project_users):
    project, editor, _ = project_users
    content = (
        _rule("BRDP-EXT-00001", "//a") + _rule("BRDP-EXT-00002", "//b") + _rule("BRDP-EXT-00003", "//c")
    )
    job, cands = await _extract(client, project.id, editor, _brex("4.2", content))
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    by = _by_id(cands)
    k1, k2, k3 = (by[f"BRDP-EXT-0000{i}"]["key"] for i in (1, 2, 3))
    # Row 1 written, row 2 failed, row 3 still pending.
    fields1 = {f: f"AI {f}" for f in by["BRDP-EXT-00001"]["ai_fields"]}
    res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [
        {"key": k1, **fields1, "draft_status": "drafted"}, {"key": k2, "draft_status": "failed"},
    ]})
    assert res.status_code == 200, res.text
    res = await client.post(f"{url}/apply", headers=editor, json={"keys": [k1, k2, k3]})
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert (detail["code"], detail["pending"], detail["failed"]) == ("texts_incomplete", ["BRDP-EXT-00003"], ["BRDP-EXT-00002"])
    async with async_session_factory() as session:
        assert (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).first() is None
    # An unknown key: refused, nothing written.
    res = await client.post(f"{url}/apply", headers=editor, json={"keys": [k1, "c99999"]})
    assert res.status_code == 409 and res.json()["detail"]["code"] == "unknown_candidates"
    # Unchecked rows with failed / pending texts never block; a repeated key counts once.
    res = await client.post(f"{url}/apply", headers=editor, json={"keys": [k1, k1]})
    assert res.status_code == 200, res.text
    result = res.json()
    assert (result["selected"], result["created"], result["updated"], result["omitted"]) == (1, 1, 0, 0)


async def test_concurrent_saves_never_lose_an_edit(client, project_users):
    """A batch of AI texts and a "select all shown" saved at the same time:
    both edits are kept (row locks, never a lost update)."""
    import asyncio

    project, editor, _ = project_users
    content = "".join(_rule(f"BRDP-EXT-{i:05d}", f"//x{i}") for i in range(1, 31))
    job, cands = await _extract(client, project.id, editor, _brex("4.2", content))
    url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
    for c in cands:
        assert c["selected"] is True
    off = [{"key": c["key"], "selected": False} for c in cands]
    texts = [{"key": c["key"], "draft_status": "drafted", **{f: f"AI {f}" for f in c["ai_fields"]}} for c in cands]
    results = await asyncio.gather(
        *[client.patch(f"{url}/candidates", headers=editor, json={"items": items}) for items in (texts, off, texts[:10], off[10:])]
    )
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    final = (await client.get(f"{url}/candidates", headers=editor)).json()["candidates"]
    assert all(c["selected"] is False for c in final)
    assert all(text_state(c) == "complete" and c["draft_status"] == "drafted" for c in final)


# ── Catalog of another edition ─────────────────────────────────────────────


def test_closest_edition():
    assert closest_edition("S1000D 4.2", ["S1000D 4.1", "S1000D 5.0"]) == "S1000D 4.1"
    assert closest_edition("S1000D 4.2", ["S1000D 3.0.1", "S1000D 5.0"]) == "S1000D 5.0"
    # A tie: the most recent.
    assert closest_edition("S1000D 4.2", ["S1000D 4.1", "S1000D 4.3"]) == "S1000D 4.3"
    assert closest_edition("S1000D 4.2", ["S1000D 4.2"]) is None
    assert closest_edition("DITA 1.3 Xpath2.0", ["S1000D 4.1"]) is None


@pytest.fixture
async def project_42_users():
    async with async_session_factory() as session:
        project = Project(name=f"Extract 4.2 {uuid.uuid4()}", standard="S1000D 4.2")
        editor = User(email=f"extract-ed-{uuid.uuid4()}@example.com", password_hash=hash_password("x"), display_name="Ed", global_role="user")
        session.add_all([project, editor])
        await session.flush()
        session.add(UserProjectRole(user_id=editor.id, project_id=project.id, role="editor"))
        await session.commit()
        await session.refresh(project)
        await session.refresh(editor)
    yield project, {"Authorization": f"Bearer {create_access_token(str(editor.id))}"}
    async with async_session_factory() as session:
        await session.delete(await session.get(Project, project.id))
        await session.commit()


async def test_identifier_from_another_editions_catalog(client, project_42_users):
    """An S1 identifier missing from the 4.2 catalog but in the 4.1 one:
    "From catalog (S1000D 4.1)", unchecked, Title and Definition from that
    catalog, two options only (the "marked" one was retired: the edition
    label says where it comes from); imported with its identifier, and a
    re-import finds it. A BRDP imported earlier with the retired suffix
    (BRDP-S1-xxxxx-4.1) is found as "already exists". In both catalogs: a
    normal catalog BRDP."""
    project, editor = project_42_users
    n = uuid.uuid4().int % 90000 + 10000
    only41, both, in5, nowhere, taken = (f"BRDP-S1-{(n + i) % 100000:05d}" for i in range(5))
    added = []
    async with async_session_factory() as session:
        for standard, identifier, title in (
            ("S1000D 4.1", only41, "Title 4.1"), ("S1000D 4.1", both, "Old title"), ("S1000D 4.2", both, "Title 4.2"),
            ("S1000D 5.0", only41, "Title 5.0"), ("S1000D 5.0", in5, "Title 5.0 only"), ("S1000D 4.1", taken, "Taken"),
        ):
            row = BRDPCatalog(standard=standard, identifier=identifier, title=title, definition=f"Def {title}")
            session.add(row)
            added.append(row)
        await session.commit()
    try:
        content = "".join(
            f'<structureObjectRule id="{i}"><brDecisionRef brDecisionIdentNumber="{i}"/><objectPath allowedObjectFlag="0">//x{k}</objectPath>'
            f"<objectUse>{i}. Rule {k} text.</objectUse></structureObjectRule>"
            for k, i in enumerate((only41, both, in5, nowhere, taken))
        )
        await _seed(project.id, f"{taken}-4.1")
        job, cands = await _extract(client, project.id, editor, _brex("4.2", content))
        by = _by_id(cands)
        c41 = by[only41]
        assert (c41["classification"], c41["selected"], c41["catalog_edition"]) == ("catalog_edition", False, "S1000D 4.1")
        assert c41["options"] == ["catalog_edition", "new_ext"]
        assert c41["option_identifiers"] == {"catalog_edition": only41}
        assert (c41["title"], c41["definition"], c41["proposal"]) == ("Title 4.1", "Def Title 4.1", "Rule 0 text.")
        assert c41["text_sources"] == {"title": "catalog", "definition": "catalog", "proposal": "file"} and c41["ai_fields"] == []
        w = next(w for w in c41["warnings"] if w["code"] == "catalog_other_edition")
        assert w["params"] == {"identifier": only41, "standard": "S1000D 4.2", "edition": "S1000D 4.1"}
        assert (by[both]["classification"], by[both]["title"]) == ("catalog", "Title 4.2")
        assert (by[in5]["classification"], by[in5]["catalog_edition"]) == ("catalog_edition", "S1000D 5.0")
        assert by[in5]["options"] == ["catalog_edition", "new_ext"]
        assert by[nowhere]["classification"] == "new_ext"
        assert any(w["code"] == "not_in_catalog" for w in by[nowhere]["warnings"])
        # The suffixed BRDP of an earlier import (no extracted_from event
        # here: it came in some other way) is the same decision.
        assert (by[taken]["classification"], by[taken]["identifier"]) == ("changed", f"{taken}-4.1")

        url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
        # The retired classification in a direct request: refused with its reason.
        res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [
            {"key": by[in5]["key"], "classification": "catalog_edition_marked"},
        ]})
        assert res.status_code == 422, res.text
        assert "retired" in res.json()["detail"]
        res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [
            {"key": by[taken]["key"], "classification": "catalog_edition_marked"},
        ]})
        assert res.status_code == 422, res.text
        keys = [by[i]["key"] for i in (only41, both, in5, taken)]
        res = await _apply(client, url, editor, {"keys": keys})
        assert res.status_code == 200, res.text
        result = res.json()
        assert (result["selected"], result["created"], result["updated"], result["omitted"]) == (4, 3, 1, 0)
        async with async_session_factory() as session:
            brdps = {b.identifier: b for b in (await session.execute(select(BRDP).where(BRDP.project_id == project.id))).scalars()}
            assert {only41, both, in5, f"{taken}-4.1"} == set(brdps)
            assert (brdps[only41].title, brdps[in5].title) == ("Title 4.1", "Title 5.0 only")
            approval = await session.get(RuleApproval, (brdps[f"{taken}-4.1"].id, "BREX-4.2"))
            assert f'brDecisionIdentNumber="{taken}"' in approval.rule_xml  # the rule is unchanged
            event = (await session.execute(select(BRDPHistory.new_value).where(
                BRDPHistory.brdp_id == brdps[only41].id, BRDPHistory.field_name == "extracted_from"))).scalar_one()
            assert json.loads(event)["catalog_edition"] == "S1000D 4.1" and json.loads(event)["catalog_standard"] == "S1000D 4.2"
        # Re-import: all found, "same".
        job2, cands2 = await _extract(client, project.id, editor, _brex("4.2", content))
        by2 = _by_id(cands2)
        assert [by2[i]["classification"] for i in (only41, in5, taken)] == ["same", "same", "same"]
        assert by2[taken]["identifier"] == f"{taken}-4.1"
    finally:
        async with async_session_factory() as session:
            for row in added:
                await session.delete(await session.get(BRDPCatalog, row.id))
            await session.commit()


async def test_an_old_extraction_with_marked_rows_reads_as_catalog_edition(client, project_42_users):
    """A job saved before the "marked" option was retired: its rows read as
    "From catalog (S1000D 4.1)" with the original identifier (candidates,
    candidate keys and the import), never an error."""
    project, editor = project_42_users
    n = uuid.uuid4().int % 90000 + 10000
    only41 = f"BRDP-S1-{n:05d}"
    async with async_session_factory() as session:
        row = BRDPCatalog(standard="S1000D 4.1", identifier=only41, title="Title 4.1", definition="Def 4.1")
        session.add(row)
        await session.commit()
        catalog_id = row.id
    try:
        content = (
            f'<structureObjectRule id="{only41}"><brDecisionRef brDecisionIdentNumber="{only41}"/>'
            f'<objectPath allowedObjectFlag="0">//x</objectPath><objectUse>{only41}. Rule text.</objectUse></structureObjectRule>'
        )
        job, cands = await _extract(client, project.id, editor, _brex("4.2", content))
        key = _by_id(cands)[only41]["key"]
        # Rewrite the row as the old code saved a "marked" choice.
        async with async_session_factory() as session:
            cand = await session.get(RuleExtractCandidate, (uuid.UUID(job["id"]), key))
            data = dict(cand.data)
            data.update({
                "classification": "catalog_edition_marked",
                "identifier": f"{only41}-4.1",
                "options": ["catalog_edition", "catalog_edition_marked", "new_ext"],
                "option_identifiers": {"catalog_edition": only41, "catalog_edition_marked": f"{only41}-4.1"},
                "selected": True,
            })
            cand.data = data
            await session.commit()
        url = f"/api/projects/{project.id}/ai-extract/jobs/{job['id']}"
        c = _by_id((await client.get(f"{url}/candidates", headers=editor)).json()["candidates"])[only41]
        assert (c["classification"], c["identifier"]) == ("catalog_edition", only41)
        assert c["options"] == ["catalog_edition", "new_ext"]
        assert c["option_identifiers"] == {"catalog_edition": only41}
        assert not any(w["code"] == "rule_ids_from_file" for w in c["warnings"])
        keys = (await client.get(f"{url}/candidate-keys", headers=editor)).json()
        entry = next(k for k in keys["keys"] if k["key"] == key)
        assert (entry["identifier"], entry["classification"]) == (only41, "catalog_edition")
        # An edit of another field keeps working and persists the normalized row.
        res = await client.patch(f"{url}/candidates", headers=editor, json={"items": [{"key": key, "title": "Edited"}]})
        assert res.status_code == 200, res.text
        res = await _apply(client, url, editor, {"keys": [key]})
        assert res.status_code == 200, res.text
        assert res.json()["created_identifiers"][0]["identifier"] == only41
    finally:
        async with async_session_factory() as session:
            await session.delete(await session.get(BRDPCatalog, catalog_id))
            await session.commit()
