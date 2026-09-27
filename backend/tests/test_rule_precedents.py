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
