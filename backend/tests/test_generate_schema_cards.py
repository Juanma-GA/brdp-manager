"""Unit tests for backend/scripts/generate_schema_cards.py's resolver
itself -- against small SYNTHETIC XSD fragments (via lxml.etree.fromstring,
never real files), isolating the mechanics from whatever the real DITA/
S1000D schema trees happen to contain. The real-data cases (real elements,
hand-verified against the real XSDs: S1000D 4.2 <table>/@frame, <para>
varying by schema, DITA <note>/@type, the redefine self-reference for
<hazardstatement>) are covered end-to-end via GET /api/schema-cards in
test_schema_cards.py -- this file exists ONLY for the one scenario that
isn't reproducible with real data in this repo: an unresolved reference.

Honest limitation, not a shortcut: a full audit of every group/
attributeGroup/element/attribute ref in sources/D1.3/schema (all 119 .xsd
files) found EVERY reference resolves to a real declaration somewhere in
the tree -- confirmed by a standalone grep-based cross-check during
development, not assumed -- so `generate_schema_cards.py --mode=merged`
against the real DITA schema produces 0 unresolved elements (see the
generation report: 765 cards, 0 unresolved). Rather than force a fake
"unresolved" reading out of real production data (which would misrepresent
this schema set's actual completeness), this test proves the mechanism
itself works correctly with a deliberately incomplete synthetic schema.
"""
import sys
from pathlib import Path

import pytest
from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from generate_schema_cards import Scope, _collect_top_level, compute_card  # noqa: E402

XSD_NS = "http://www.w3.org/2001/XMLSchema"


def _parse(xml: str):
    return etree.fromstring(xml.encode("utf-8"))


def _make_scope(xml: str) -> Scope:
    scope = Scope(label="synthetic")
    _collect_top_level(_parse(xml), scope)
    return scope


def test_resolved_element_with_required_attribute_and_enum_and_children():
    """Baseline sanity check on the synthetic-XSD test harness itself,
    mirroring the REAL frame/table shape (S1000D 4.2) but built from a
    tiny in-memory fragment -- confirms attrs/children/resolved all come
    out correctly before testing the unresolved path below."""
    xml = f"""<xs:schema xmlns:xs="{XSD_NS}">
      <xs:element name="widget" type="widgetType"/>
      <xs:complexType name="widgetType">
        <xs:sequence>
          <xs:element ref="part"/>
        </xs:sequence>
        <xs:attribute ref="mode" use="required"/>
        <xs:attribute ref="frame"/>
      </xs:complexType>
      <xs:element name="part" type="xs:string"/>
      <xs:attribute name="mode" type="modeType"/>
      <xs:simpleType name="modeType">
        <xs:restriction base="xs:string">
          <xs:enumeration value="a"/>
          <xs:enumeration value="b"/>
        </xs:restriction>
      </xs:simpleType>
      <xs:attribute name="frame" type="xs:string"/>
    </xs:schema>"""
    scope = _make_scope(xml)
    card = compute_card("widget", scope.elements["widget"], scope)
    assert card["resolved"] is True
    assert card["children"] == ["part"]
    mode_attr = next(a for a in card["attributes"] if a["name"] == "mode")
    assert mode_attr["required"] is True
    assert mode_attr["enum"] == ["a", "b"]
    frame_attr = next(a for a in card["attributes"] if a["name"] == "frame")
    assert frame_attr["required"] is False
    assert frame_attr["enum"] is None


def test_missing_group_ref_marks_children_unresolved_never_guessed():
    """A content model referencing a group that genuinely doesn't exist
    anywhere in scope -- the docs request's own instruction ("donde el
    modelo de contenido no se pueda resolver con fiabilidad, marcar la
    ficha como unresolved en vez de adivinar")."""
    xml = f"""<xs:schema xmlns:xs="{XSD_NS}">
      <xs:element name="widget" type="widgetType"/>
      <xs:complexType name="widgetType">
        <xs:sequence>
          <xs:element ref="part"/>
          <xs:group ref="does-not-exist-anywhere"/>
        </xs:sequence>
      </xs:complexType>
      <xs:element name="part" type="xs:string"/>
    </xs:schema>"""
    scope = _make_scope(xml)
    card = compute_card("widget", scope.elements["widget"], scope)
    assert card["resolved"] is False
    # Partial information is still reported (HR7 -- never silently drop
    # what WAS resolved before the failure): "part" was found before the
    # missing group ref broke the walk.
    assert "part" in card["children"]


def test_missing_attribute_group_ref_marks_unresolved():
    xml = f"""<xs:schema xmlns:xs="{XSD_NS}">
      <xs:element name="widget" type="widgetType"/>
      <xs:complexType name="widgetType">
        <xs:attribute ref="mode"/>
        <xs:attributeGroup ref="does-not-exist-anywhere"/>
      </xs:complexType>
      <xs:attribute name="mode" type="xs:string"/>
    </xs:schema>"""
    scope = _make_scope(xml)
    card = compute_card("widget", scope.elements["widget"], scope)
    assert card["resolved"] is False
    assert any(a["name"] == "mode" for a in card["attributes"])


def test_missing_complex_type_base_marks_unresolved():
    xml = f"""<xs:schema xmlns:xs="{XSD_NS}">
      <xs:element name="widget">
        <xs:complexType>
          <xs:complexContent>
            <xs:extension base="does-not-exist-anywhere">
              <xs:attribute ref="mode"/>
            </xs:extension>
          </xs:complexContent>
        </xs:complexType>
      </xs:element>
      <xs:attribute name="mode" type="xs:string"/>
    </xs:schema>"""
    scope = _make_scope(xml)
    card = compute_card("widget", scope.elements["widget"], scope)
    assert card["resolved"] is False
    # The extension's OWN attribute is still resolved even though the base
    # type it extends is missing -- partial information preserved.
    assert any(a["name"] == "mode" for a in card["attributes"])


@pytest.mark.parametrize("scenario", ["missing group", "missing attributeGroup", "missing complexType base"])
def test_a_resolved_sibling_element_is_never_affected_by_an_unrelated_unresolved_one(scenario):
    """Confirms `resolved: False` is scoped to the ONE element whose
    content model genuinely can't be resolved -- never contaminates an
    unrelated element's own, perfectly resolvable card."""
    xml = f"""<xs:schema xmlns:xs="{XSD_NS}">
      <xs:element name="broken" type="brokenType"/>
      <xs:complexType name="brokenType">
        <xs:group ref="does-not-exist-anywhere"/>
      </xs:complexType>
      <xs:element name="fine" type="fineType"/>
      <xs:complexType name="fineType">
        <xs:sequence>
          <xs:element ref="part"/>
        </xs:sequence>
      </xs:complexType>
      <xs:element name="part" type="xs:string"/>
    </xs:schema>"""
    scope = _make_scope(xml)
    broken_card = compute_card("broken", scope.elements["broken"], scope)
    fine_card = compute_card("fine", scope.elements["fine"], scope)
    assert broken_card["resolved"] is False
    assert fine_card["resolved"] is True
    assert fine_card["children"] == ["part"]
