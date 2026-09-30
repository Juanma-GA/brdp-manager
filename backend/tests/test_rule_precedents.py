"""Suggest Rule precedent cleanup (Suggest Rule adjustments round) --
rule_precedents.extract_format_rules.

The two real cases from the docs request -- BRDP-EXT-00066 (only a
<nonContextRule>) and BRDP-S1-00489 (a <structureObjectRule> mixed with a
<rules> wrapper and a <nonContextRule>) -- are RECONSTRUCTIONS: the real
rule XML of those rows lives in the user's production database and is not
available in this environment (only S1-00489's catalog row is, in
sources/Issue 4.2 ... v4.8.xlsx: "<logo> will not be used"). They keep the
exact structure the docs request describes.
"""
import pytest

from app.services.rule_precedents import extract_format_rules

BRDP_EXT_00066 = """<nonContextRule id="BRDP-EXT-00066">
  <brDecisionRef brDecisionIdentNumber="BRDP-EXT-00066"/>
  <simplePara>Illustrations shall be delivered as CGM files.</simplePara>
</nonContextRule>"""

BRDP_S1_00489_RULE = """<structureObjectRule id="BRDP-S1-00489" brSeverityLevel="brsl01">
    <brDecisionRef brDecisionIdentNumber="BRDP-S1-00489"/>
    <objectPath allowedObjectFlag="0">//logo</objectPath>
    <objectUse>The element &lt;logo&gt; shall not be used.</objectUse>
  </structureObjectRule>"""

BRDP_S1_00489 = f"""<rules>
  {BRDP_S1_00489_RULE}
  <nonContextRule id="BRDP-S1-00489-b">
    <simplePara>Logotypes are not presented.</simplePara>
  </nonContextRule>
</rules>"""


def test_non_context_rule_only_is_not_a_precedent():
    assert extract_format_rules(BRDP_EXT_00066, "BREX-4.2") is None
    assert extract_format_rules(BRDP_EXT_00066, "BREX-4.1") is None


def test_mixed_rule_keeps_only_the_structure_object_rule_verbatim():
    assert extract_format_rules(BRDP_S1_00489, "BREX-4.2") == BRDP_S1_00489_RULE


def test_plain_rule_is_returned_unchanged():
    assert extract_format_rules(BRDP_S1_00489_RULE, "BREX-4.2") == BRDP_S1_00489_RULE


def test_several_rule_elements_are_all_kept_in_order():
    first = '<structureObjectRule id="A"><objectPath allowedObjectFlag="0">//a</objectPath></structureObjectRule>'
    second = '<structureObjectRule id="B"><objectPath allowedObjectFlag="0">//b</objectPath></structureObjectRule>'
    xml = f"<contextRules>{first}<nonContextRule id='x'/>{second}</contextRules>"
    assert extract_format_rules(xml, "BREX-4.2") == f"{first}\n{second}"


def test_brex_301_objrule():
    objrule = '<objrule id="R"><objpath objappl="0">//x</objpath><objuse>u</objuse></objrule>'
    assert extract_format_rules(f"<!-- nonContextRule id=\"N\": text -->{objrule}", "BREX-3.0.1") == objrule
    assert extract_format_rules("<!-- nonContextRule id=\"N\": text -->", "BREX-3.0.1") is None
    # a structureObjectRule is not a 3.0.1 rule
    assert extract_format_rules(BRDP_S1_00489_RULE, "BREX-3.0.1") is None


@pytest.mark.parametrize("prefix", ["sch:", ""])
def test_sch_dita_pattern_prefixed_or_not_with_gt_inside_attributes(prefix):
    pattern = (
        f'<{prefix}pattern id="p-X"><{prefix}rule context="step[count(substep) > 1]">'
        f'<{prefix}assert id="X" test="count(ancestor::step) &lt; 3">m</{prefix}assert>'
        f"</{prefix}rule></{prefix}pattern>"
    )
    assert extract_format_rules(f"<wrapper>{pattern}</wrapper>", "SCH-DITA") == pattern


def test_sch_dita_bare_rule_without_pattern():
    rule = '<sch:rule context="note"><sch:assert id="Y" test="@type">m</sch:assert></sch:rule>'
    assert extract_format_rules(rule, "SCH-DITA") == rule


def test_tag_mentioned_only_in_a_comment_is_not_a_rule():
    xml = "<!-- was <structureObjectRule id='old'>...</structureObjectRule> --><nonContextRule id='n'/>"
    assert extract_format_rules(xml, "BREX-4.2") is None


def test_similarly_named_elements_are_not_confused():
    assert extract_format_rules("<objrules><x/></objrules>", "BREX-3.0.1") is None
    assert extract_format_rules("<sch:rules/>", "SCH-DITA") is None


def test_unknown_format_keeps_the_text():
    assert extract_format_rules("<anything/>", "TEST-FORMAT") == "<anything/>"


# --- Schema context (Suggest Rule part 2) ---------------------------------

def _ctx42(schema: str, inner: str) -> str:
    return (
        f'<contextRules rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/{schema}.xsd">'
        f"<structureObjectRuleGroup>{inner}</structureObjectRuleGroup></contextRules>"
    )


def test_context_block_is_kept_whole_with_its_rules_context():
    inner = '<structureObjectRule><objectPath allowedObjectFlag="0">//dmodule</objectPath></structureObjectRule>'
    block = _ctx42("fault", inner)
    assert extract_format_rules(block, "BREX-4.2") == block


def test_loose_rule_and_context_blocks_keep_document_order_and_are_not_duplicated():
    loose = '<structureObjectRule><objectPath allowedObjectFlag="2">//@a</objectPath></structureObjectRule>'
    inner = '<structureObjectRule><objectPath allowedObjectFlag="0">//dmodule</objectPath></structureObjectRule>'
    fault, proced = _ctx42("fault", inner), _ctx42("proced", inner)
    xml = f"<rules>{loose}<nonContextRule id='n'/>{fault}{proced}</rules>"
    out = extract_format_rules(xml, "BREX-4.2")
    assert out == f"{loose}\n{fault}\n{proced}"
    # the inner rules only appear inside their blocks
    assert out.count("//dmodule") == 2


def test_real_template_brdp_s1_00006_keeps_its_three_context_blocks():
    # S1-00006 left the 4.2 template when it was rebuilt with the 10 project
    # decisions; its real rule is kept in the retired-rows fixture.
    import json
    from pathlib import Path

    fixture = Path(__file__).resolve().parents[2] / "scripts" / "rule-test-fixtures" / "retired-template-rules.json"
    rows = json.loads(fixture.read_text(encoding="utf-8"))["rows"]
    rule_xml = next(r["Rule"] for r in rows if r["ID"] == "BRDP-S1-00006" and r["format"] == "BREX-4.2")
    out = extract_format_rules(rule_xml, "BREX-4.2")
    for schema in ("condcrossreftable", "fault", "prdcrossreftable"):
        assert f'rulesContext="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/{schema}.xsd"' in out
    assert out.count("<contextRules") == 3
    # the general rule (schema location values) is still there, outside them
    assert out.index("//@xsi:noNamespaceSchemaLocation") < out.index("<contextRules")


def test_context_block_without_context_is_only_a_wrapper():
    rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//x</objectPath></structureObjectRule>'
    for wrapper in (f'<contextRules rulesContext="">{rule}</contextRules>', f"<contextRules>{rule}</contextRules>"):
        assert extract_format_rules(wrapper, "BREX-4.2") == rule


def test_context_block_without_rules_is_dropped():
    xml = _ctx42("fault", "") + "<nonContextRule id='n'/>"
    assert extract_format_rules(xml, "BREX-4.2") is None


def test_brex_301_contextrules_kept_whole():
    objrule = '<objrule><objpath objappl="0">//emphasis</objpath><objuse>u</objuse></objrule>'
    block = (
        '<contextrules context="http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/proced.xsd">'
        f"<structrules>{objrule}</structrules></contextrules>"
    )
    assert extract_format_rules(block, "BREX-3.0.1") == block
    # a 4.x-style block is not a 3.0.1 context block
    assert extract_format_rules(_ctx42("proced", objrule), "BREX-3.0.1") == objrule


def test_context_block_mentioned_in_a_comment_is_ignored():
    rule = '<structureObjectRule><objectPath allowedObjectFlag="0">//x</objectPath></structureObjectRule>'
    xml = f"<!-- {_ctx42('fault', rule)} -->{rule}"
    assert extract_format_rules(xml, "BREX-4.2") == rule
