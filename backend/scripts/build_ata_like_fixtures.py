"""Builds the reconstructed ATA CMP fixtures for "AI Extract: reconocer reglas
ya existentes por su contenido".

The real ATA CMP BREX (DMC-ATABREX-F-00-00-0000-01A-022A-D_009/010-00_EN-US)
is not in this repository, so its shape is reproduced with REAL rules of the
"CA" BREX of tests/fixtures/brex (the first rule of each decision, without
repeating a rule already taken):

  ATA-CMP-like-010-reconstructed.xml   the "issue 010" file: 463
      structureObjectRule with id="SOR-n" and no BRDP identifier
      (brDecisionRef removed, identifiers removed from objectUse), indented.
      SOR-3 changed by "ATA" (one path step and its objectUse); SOR-97 and
      SOR-98 "Place holder rule for future use".
  ATA-CMP-like-009-project-rules.json  the project made from "issue 009" by
      Excel: 461 BRDPs (BRDP-EXT-nnnnn, SOR-3 = BRDP-EXT-00002) with their
      rules stored compact and without id="SOR-n"; ten of them corrected by
      the project (BRDP-EXT-00043, 00059, 00130, 00182, 00420, 00423-00427:
      path corrected in five, objectUse in four, the flag in one).

Expected on import: 450 "Ya existe (igual)", 10 "Ya existe (cambia)"
(content), SOR-3 → BRDP-EXT-00002 (similarity), SOR-97/98 "Nueva EXT".

    cd backend && python scripts/build_ata_like_fixtures.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lxml import etree  # noqa: E402

from app.services.rule_extract_jobs import rule_content  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "brex"
SOURCE = FIXTURES / "DMC-CAAA00000000AAA022AD-001-00-SX-ZZ.xml"
OUT_XML = FIXTURES / "ATA-CMP-like-010-reconstructed.xml"
OUT_JSON = FIXTURES / "ATA-CMP-like-009-project-rules.json"

RULE_COUNT = 461
PLACEHOLDERS = (97, 98)
PATH_CORRECTED = ("BRDP-EXT-00043", "BRDP-EXT-00059", "BRDP-EXT-00130", "BRDP-EXT-00182", "BRDP-EXT-00420")
USE_CORRECTED = ("BRDP-EXT-00423", "BRDP-EXT-00425", "BRDP-EXT-00426", "BRDP-EXT-00427")
FLAG_CORRECTED = ("BRDP-EXT-00424",)
ATA_CHANGED_SOR = 3
ATA_CHANGED_ID = "BRDP-EXT-00002"
_XMLNS = re.compile(r'\s+xmlns(?::[\w.-]+)?="[^"]*"')
_ID = re.compile(r"^\s*BRDP-[A-Z0-9]+-\d{5}[\s.:\-–—]*")


def _text(el) -> str:
    return etree.tostring(el, encoding="unicode")


def _rule(el, sor: int | None) -> etree._Element:
    """A copy of the CA rule without brDecisionRef, without identifiers in
    objectUse, with id="SOR-n" when given."""
    rule = etree.fromstring(_XMLNS.sub("", _text(el)))
    for bd in rule.findall("brDecisionRef"):
        rule.remove(bd)
    use = rule.find("objectUse")
    if use is not None and use.text:
        use.text = _ID.sub("", use.text, count=1)
    rule.tail = None
    if sor is not None:
        rule.attrib.clear()
        rule.set("id", f"SOR-{sor}")
    return rule


def _compact(rule: etree._Element) -> str:
    return re.sub(r">\s+<", "><", _text(rule)).strip()


def _with_context(rule_xml: str, context: str) -> str:
    if not context:
        return rule_xml
    return (
        f'<contextRules rulesContext="{context}"><structureObjectRuleGroup>{rule_xml}'
        "</structureObjectRuleGroup></contextRules>"
    )


def select_rules():
    tree = etree.parse(str(SOURCE))
    taken, seen = [], set()
    for el in tree.iter("structureObjectRule"):
        bd = el.find("brDecisionRef")
        key = bd.get("brDecisionIdentNumber") if bd is not None else None
        if key in seen:
            continue
        seen.add(key)
        block = next((a for a in el.iterancestors("contextRules")), None)
        context = (block.get("rulesContext") or "") if block is not None else ""
        rule = _rule(el, None)
        rc = rule_content(_with_context(_compact(rule), context), "BREX-4.2")
        if rc is None or any(rc.pieces == other for _, _, other in taken):
            continue
        taken.append((el, context, rc.pieces))
        if len(taken) == RULE_COUNT:
            break
    tree_root = tree.getroot()
    return tree_root, [(el, context) for el, context, _ in taken]


def _correct_path(rule: etree._Element) -> None:
    path = rule.find("objectPath")
    path.text = path.text.strip() + "[not(@changeType = 'delete')]"


def _correct_use(rule: etree._Element) -> None:
    use = rule.find("objectUse")
    use.text = (use.text or "").strip().rstrip(".") + ". Corrected by the project (issue 009)."


def _correct_flag(rule: etree._Element) -> None:
    path = rule.find("objectPath")
    path.set("allowedObjectFlag", "0" if path.get("allowedObjectFlag") != "0" else "2")


def _ata_change(rule: etree._Element) -> None:
    """What "ATA" changed in SOR-3 for issue 010: the last step of the path
    and one sentence of the objectUse."""
    path = rule.find("objectPath")
    path.text = re.sub(r"([A-Za-z]+)(\W*)$", r"\1Group\2", path.text.strip(), count=1)
    use = rule.find("objectUse")
    use.text = (use.text or "").strip() + " Revised in issue 010."


def main() -> None:
    source_root, rules = select_rules()
    assert len(rules) == RULE_COUNT, len(rules)
    # SOR numbers: 1..463 with the placeholders at 97 and 98.
    sors = [n for n in range(1, RULE_COUNT + len(PLACEHOLDERS) + 1) if n not in PLACEHOLDERS]
    # Project identifiers: in order, SOR-3 → BRDP-EXT-00002 and SOR-2 → 00003.
    identifiers = {}
    for index, sor in enumerate(sors, start=1):
        identifiers[sor] = f"BRDP-EXT-{index:05d}"
    identifiers[2], identifiers[3] = identifiers[3], identifiers[2]
    assert identifiers[ATA_CHANGED_SOR] == ATA_CHANGED_ID

    project = []
    file_rules = {}  # sor → (context, element)
    for sor, (el, context) in zip(sors, rules):
        identifier = identifiers[sor]
        stored = _rule(el, None)
        change = None
        if identifier in PATH_CORRECTED:
            _correct_path(stored)
            change = "path"
        elif identifier in USE_CORRECTED:
            _correct_use(stored)
            change = "objectUse"
        elif identifier in FLAG_CORRECTED:
            _correct_flag(stored)
            change = "flag"
        in_file = _rule(el, sor)
        if sor == ATA_CHANGED_SOR:
            _ata_change(in_file)
            change = "changed by ATA in 010"
        file_rules[sor] = (context, in_file)
        use = stored.find("objectUse")
        project.append(
            {
                "identifier": identifier,
                "sor": sor,
                "title": ((use.text or "").strip()[:120] if use is not None else "") or f"Rule SOR-{sor}",
                "rule_xml": _with_context(_compact(stored), context),
                "change": change,
            }
        )
    for sor in PLACEHOLDERS:
        rule = etree.fromstring(
            f'<structureObjectRule id="SOR-{sor}"><objectPath allowedObjectFlag="2">//placeholder</objectPath>'
            "<objectUse>Place holder rule for future use</objectUse></structureObjectRule>"
        )
        file_rules[sor] = ("", rule)

    # The file: general rules first (SOR order), then one block per context.
    brex = etree.Element("brex")
    general = etree.SubElement(brex, "contextRules")
    blocks: dict[str, etree._Element] = {}
    for sor in sorted(file_rules):
        context, rule = file_rules[sor]
        if not context:
            general.append(rule)
            continue
        if context not in blocks:
            blocks[context] = etree.SubElement(etree.SubElement(brex, "contextRules", rulesContext=context), "structureObjectRuleGroup")
        blocks[context].append(rule)
    ident = _XMLNS.sub("", _text(source_root.find("identAndStatusSection")))
    ident = re.sub(r'modelIdentCode="CA"', 'modelIdentCode="ATABREX"', ident)
    body = etree.tostring(brex, encoding="unicode", pretty_print=True)
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:dc="http://www.purl.org/dc/elements/1.1/">\n'
        "<!-- Reconstructed for the tests with real rules of the CA BREX; it is not the ATA CMP BREX. -->\n"
        f"{ident}\n<content>\n{body}</content>\n</dmodule>\n"
    )
    OUT_XML.write_text(xml, encoding="utf-8", newline="\n")
    OUT_JSON.write_text(json.dumps(project, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"{OUT_XML.name}: {len(file_rules)} rules; {OUT_JSON.name}: {len(project)} BRDPs")


if __name__ == "__main__":
    main()
