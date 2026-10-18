"""Builds the reconstructed GMC ATA fixtures for "AI Extract: emparejar por
contenido también las candidatas de catálogo, de otra edición, de otra
especificación, de regla por defecto y de prefijo propio".

The real GMC ATA BREX (DMC-ATABREX-F-00-00-0000-00A-022A-D_018-00_EN-US) is
not in this repository, so its shape is reproduced with REAL rules of the
"CA" BREX of tests/fixtures/brex (the same selection as
build_ata_like_fixtures.py: the first rule of each decision, without
repeating a rule):

  GMC-like-018-reconstructed.xml   the "issue 018" file, indented, without
      brDecisionRef (commented out, as in the real file):
      - 150 rules SOR-1..SOR-150 without any identifier: 141 the same as the
        project's, 7 corrected by the project, SOR-97/98 placeholders;
      - SOR-259 "BRDP-S1-00226: …" (a catalog identifier, one rule);
      - SOR-260, 261, 267, 268, 269 "BRDP-S1-00007: …": one candidate with
        five rules;
      - SOR-262..265 "BRDP-GEN-00077..00080: …" and SOR-266
        "BRDP-GEN-00081: …" in a comrep context block (an own prefix).
  GMC-like-project-rules.json  the project made by Excel: 159 BRDPs
      BRDP-EXT-00001..00159 with their rules stored compact, no history:
      S1-00226 = BRDP-EXT-00083; the five rules of S1-00007 = BRDP-EXT-00084,
      00085, 00090, 00091, 00092 (one rule each); GEN-00077..00081 =
      BRDP-EXT-00086, 00087, 00088, 00089, 00105.

Expected on import (S1-00226 and S1-00007 in the project standard's
catalog): 147 "Ya existe (igual)" (141 + S1-00226 + the five GEN), S1-00007
"De catálogo" unchecked with the warning naming its five BRDPs, 7 "Ya existe
(cambia)", 2 "Nueva EXT", and no project BRDP left out of the file.

    cd backend && python scripts/build_gmc_like_fixtures.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from lxml import etree  # noqa: E402

from build_ata_like_fixtures import (  # noqa: E402
    _XMLNS,
    _compact,
    _correct_flag,
    _correct_path,
    _correct_use,
    _rule,
    _text,
    _with_context,
    select_rules,
)

FIXTURES = ROOT / "tests" / "fixtures" / "brex"
OUT_XML = FIXTURES / "GMC-like-018-reconstructed.xml"
OUT_JSON = FIXTURES / "GMC-like-project-rules.json"

OTHER_SORS = list(range(1, 151))
PLACEHOLDERS = (97, 98)
COMREP = "http://www.s1000d.org/S1000D_4-2/xml_schema_flat/comrep.xsd"
# SOR → (identifier in the file, project identifier, context)
IDENTIFIED = {
    259: ("BRDP-S1-00226", "BRDP-EXT-00083", ""),
    260: ("BRDP-S1-00007", "BRDP-EXT-00084", ""),
    261: ("BRDP-S1-00007", "BRDP-EXT-00085", ""),
    262: ("BRDP-GEN-00077", "BRDP-EXT-00086", ""),
    263: ("BRDP-GEN-00078", "BRDP-EXT-00087", ""),
    264: ("BRDP-GEN-00079", "BRDP-EXT-00088", ""),
    265: ("BRDP-GEN-00080", "BRDP-EXT-00089", ""),
    266: ("BRDP-GEN-00081", "BRDP-EXT-00105", COMREP),
    267: ("BRDP-S1-00007", "BRDP-EXT-00090", ""),
    268: ("BRDP-S1-00007", "BRDP-EXT-00091", ""),
    269: ("BRDP-S1-00007", "BRDP-EXT-00092", ""),
}
PROJECT_SIZE = 159
# Corrected by the project (by SOR): path, objectUse or flag.
CORRECTIONS = {12: _correct_path, 34: _correct_path, 56: _correct_use, 78: _correct_use, 90: _correct_use, 110: _correct_flag, 140: _correct_path}


def main() -> None:
    _root, rules = select_rules()
    others = [s for s in OTHER_SORS if s not in PLACEHOLDERS]
    needed = len(others) + len(IDENTIFIED)
    rules = rules[:needed]
    assert len(rules) == needed, len(rules)
    reserved = {project for _, project, _ in IDENTIFIED.values()}
    free = [f"BRDP-EXT-{n:05d}" for n in range(1, PROJECT_SIZE + 1) if f"BRDP-EXT-{n:05d}" not in reserved]
    assert len(free) == len(others), (len(free), len(others))

    project = []
    file_rules = {}  # sor → (context, element)
    for sor, identifier, (el, context) in zip(others, free, rules):
        stored = _rule(el, None)
        change = None
        if sor in CORRECTIONS:
            CORRECTIONS[sor](stored)
            change = CORRECTIONS[sor].__name__.replace("_correct_", "")
        file_rules[sor] = (context, _rule(el, sor), None)
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
    for (sor, (origin, identifier, context)), (el, _ctx) in zip(sorted(IDENTIFIED.items()), rules[len(others):]):
        stored = _rule(el, None)
        in_file = _rule(el, sor)
        use = in_file.find("objectUse")
        use.text = f"{origin}: {(use.text or '').strip()}"
        file_rules[sor] = (context, in_file, origin)
        project.append(
            {
                "identifier": identifier,
                "sor": sor,
                "title": ((stored.find("objectUse").text or "").strip()[:120]) or f"Rule SOR-{sor}",
                "rule_xml": _with_context(_compact(stored), context),
                "change": None,
                "origin_in_file": origin,
            }
        )
    for sor in PLACEHOLDERS:
        rule = etree.fromstring(
            f'<structureObjectRule id="SOR-{sor}"><objectPath allowedObjectFlag="2">//placeholder</objectPath>'
            "<objectUse>Place holder rule for future use</objectUse></structureObjectRule>"
        )
        file_rules[sor] = ("", rule, None)
    project.sort(key=lambda r: r["identifier"])
    assert len(project) == PROJECT_SIZE

    brex = etree.Element("brex")
    general = etree.SubElement(brex, "contextRules")
    blocks: dict[str, etree._Element] = {}
    for sor in sorted(file_rules):
        context, rule, origin = file_rules[sor]
        if origin:
            # The brDecisionRef the real file has commented out.
            rule.insert(0, etree.Comment(f' <brDecisionRef brDecisionIdentNumber="{origin}"/> '))
        if not context:
            general.append(rule)
            continue
        if context not in blocks:
            blocks[context] = etree.SubElement(etree.SubElement(brex, "contextRules", rulesContext=context), "structureObjectRuleGroup")
        blocks[context].append(rule)
    ident = _XMLNS.sub("", _text(_root.find("identAndStatusSection")))
    ident = re.sub(r'modelIdentCode="CA"', 'modelIdentCode="ATABREX"', ident)
    body = etree.tostring(brex, encoding="unicode", pretty_print=True)
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:dc="http://www.purl.org/dc/elements/1.1/">\n'
        "<!-- Reconstructed for the tests with real rules of the CA BREX; it is not the GMC ATA BREX. -->\n"
        f"{ident}\n<content>\n{body}</content>\n</dmodule>\n"
    )
    OUT_XML.write_text(xml, encoding="utf-8", newline="\n")
    OUT_JSON.write_text(json.dumps(project, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"{OUT_XML.name}: {len(file_rules)} rules; {OUT_JSON.name}: {len(project)} BRDPs")


if __name__ == "__main__":
    main()
