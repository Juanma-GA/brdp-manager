"""Legacy wrappers around stored BREX rules: taken apart once, the same way
Generate always took them apart.

Real cases: BRDP-S1-00507 (S1000D 4.2) is stored as
<rules><structureObjectRule/><nonContextRule/></rules> and BRDP-S1-00070 as a
bare <structureObjectRuleGroup> holding two structureObjectRule. Generate has
always ignored such wrappers when it assembles the BREX (it takes every rule
wherever it sits), but the format check (rule_format_check.py) -- and with it
the rule test -- rejects them. Instead of making the check more tolerant, the
stored text is cleaned: the Excel import stores it clean, and
scripts/normalize_rule_wrappers.py cleans what is already stored.

Mirror of src/utils/ruleWrappers.js (Generate's assembly uses that one) --
same token scan, same pieces, same result. Shared cases:
backend/tests/fixtures/rule_wrapper_cases.json (pytest and
scripts/test-rule-wrappers.mjs).

split_rule_pieces(xml, format) scans the text and returns, in document
order, what Generate keeps -- each as the exact text it was written with:
  block       a context block with a non-empty scope attribute
              (<contextRules rulesContext="…"> / <contextrules context="…">),
              whole, nothing inside it taken again
  rule        <structureObjectRule> (4.x) / <objrule> (3.0.1), at any depth
  noncontext  <nonContextRule> (4.x) / a comment starting with
              "nonContextRule" (3.0.1), at any depth
  comment     any other comment outside the pieces above (Generate drops
              these; the stored rule keeps them)
Everything else -- the wrapper tags themselves (<rules>, a bare
<structureObjectRuleGroup>/<structrules>, a <contextRules> with no scope),
whitespace, text -- is not a piece. Only the BREX formats have wrappers;
another format gives None.

unwrap_rule_xml(xml, format) -> (text, changed): the rule unchanged unless
the format check reports a wrapper (rule_format_wrapper), everything left
out of the pieces is only wrapper tags (WRAPPER_ELEMENTS) and whitespace --
never text or another element, which would be lost -- and the pieces,
joined by a line break, pass the check. Anything else (already clean,
another problem, content that would be lost) stays exactly as it is and is
reported by scripts/report_invalid_rules.py.
"""

import re

from app.api.routes.approvals import _rule_format_problem, _xml_well_formed_error

_SHAPES = {
    "BREX-4.2": {"blocks": {"contextRules": "rulesContext"}, "rules": {"structureObjectRule": "rule", "nonContextRule": "noncontext"}, "comment": False},
    "BREX-4.1": {"blocks": {"contextRules": "rulesContext"}, "rules": {"structureObjectRule": "rule", "nonContextRule": "noncontext"}, "comment": False},
    "BREX-3.0.1": {"blocks": {"contextrules": "context"}, "rules": {"objrule": "rule"}, "comment": True},
}

# Comments, CDATA, processing instructions and tags (with their attributes),
# the same scan as removeSpannedCalsEntries in src/validation/schemaValidation.js.
_TOKEN_RE = re.compile(
    r"<!--([\s\S]*?)-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>"
    r"|<(/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:\"[^\"]*\"|'[^']*'))*)\s*(/?)>"
)
_NON_CONTEXT_COMMENT_RE = re.compile(r"^\s*nonContextRule")
_TAG_RE = re.compile(r"<(/?)([A-Za-z_][\w.:-]*)(?:\s+[^\s=/>]+\s*=\s*(?:\"[^\"]*\"|'[^']*'))*\s*/?>")

# The legacy containers that may be dropped: nothing but structure around the
# rules (a <contextRules>/<contextrules> gets here only without a scope --
# with one it is a block piece).
WRAPPER_ELEMENTS = {
    "BREX-4.2": {"rules", "structureObjectRuleGroup", "nonContextRules", "contextRules"},
    "BREX-4.1": {"rules", "structureObjectRuleGroup", "nonContextRules", "contextRules"},
    "BREX-3.0.1": {"rules", "structrules", "contextrules"},
}


def _local(name: str) -> str:
    return name.split(":")[-1]


def _attribute(attrs: str, name: str) -> str:
    m = re.search(r"(?:^|\s)" + re.escape(name) + r"\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", attrs or "")
    return (m.group(1) if m and m.group(1) is not None else (m.group(2) if m else "")) or ""


def split_rule_pieces(xml: str, format: str) -> list[dict] | None:
    shape = _SHAPES.get(format)
    if shape is None:
        return None
    text = xml or ""
    pieces: list[dict] = []
    depth = 0
    kept = None  # (kind, start, depth at which it closes)
    for m in _TOKEN_RE.finditer(text):
        comment, closing, name, attrs, self_closing = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        if name is None:
            if comment is not None and kept is None:
                kind = "noncontext" if shape["comment"] and _NON_CONTEXT_COMMENT_RE.match(comment) else "comment"
                pieces.append({"kind": kind, "text": m.group(0), "start": m.start(), "end": m.end()})
            continue
        if closing:
            depth -= 1
            if kept is not None and depth == kept[2]:
                pieces.append({"kind": kept[0], "text": text[kept[1] : m.end()], "start": kept[1], "end": m.end()})
                kept = None
            continue
        if kept is None:
            local = _local(name)
            kind = None
            scope = shape["blocks"].get(local)
            if scope is not None and _attribute(attrs, scope).strip():
                kind = "block"
            elif local in shape["rules"]:
                kind = shape["rules"][local]
            if kind is not None:
                if self_closing:
                    pieces.append({"kind": kind, "text": m.group(0), "start": m.start(), "end": m.end()})
                    continue
                kept = (kind, m.start(), depth)
        if not self_closing:
            depth += 1
    return pieces


def unwrap_rule_xml(xml: str, format: str) -> tuple[str, bool]:
    if format not in _SHAPES or not xml or not xml.strip() or _xml_well_formed_error(xml) is not None:
        return xml, False
    problem = _rule_format_problem(xml, format)
    if problem is None or problem["code"] != "rule_format_wrapper":
        return xml, False
    pieces = split_rule_pieces(xml, format) or []
    if not _only_wrappers_left(xml, pieces, WRAPPER_ELEMENTS[format]):
        return xml, False
    cleaned = "\n".join(p["text"] for p in pieces)
    if not cleaned.strip() or _xml_well_formed_error(cleaned) is not None or _rule_format_problem(cleaned, format) is not None:
        return xml, False
    return cleaned, True


def _only_wrappers_left(xml: str, pieces: list[dict], wrappers: set[str]) -> bool:
    """True when what the pieces leave out is only wrapper tags and
    whitespace."""
    rest, cursor = [], 0
    for p in pieces:
        rest.append(xml[cursor : p["start"]])
        cursor = p["end"]
    rest.append(xml[cursor:])
    left = "".join(rest)
    if any(_local(m.group(2)) not in wrappers for m in _TAG_RE.finditer(left)):
        return False
    return not _TAG_RE.sub("", left).strip()


async def normalize_stored_rule_wrappers(session, user, *, dry_run: bool) -> list[dict]:
    """Cleans every stored rule (rule_approvals, BRDPs in the trash included)
    with unwrap_rule_xml. Returns one entry per rule that has a wrapper:
    {"project", "identifier", "format", "old", "new", "changed"} -- changed
    False when the wrapper cannot be removed without losing content (the rule
    is left as it is and still shows in report_invalid_rules.py). Unless
    dry_run, writes the clean text, keeps the rule's status, and records the
    change in the BRDP's history (field "rule", attributed to user); the
    caller commits. A last test registered for the old text reads as out of
    date afterwards (its hash no longer matches), as for any edit.
    """
    from sqlalchemy import select

    from app.models import BRDP, Project, RuleApproval
    from app.services.history import record_change

    rows = (
        await session.execute(
            select(RuleApproval, BRDP.identifier, Project.name)
            .join(BRDP, BRDP.id == RuleApproval.brdp_id)
            .join(Project, Project.id == BRDP.project_id)
            .where(RuleApproval.format.in_(list(_SHAPES)))
            .order_by(Project.name, BRDP.identifier, RuleApproval.format)
        )
    ).all()
    results = []
    for approval, identifier, project in rows:
        xml = approval.rule_xml or ""
        if _xml_well_formed_error(xml) is not None:
            continue
        problem = _rule_format_problem(xml, approval.format)
        if problem is None or problem["code"] != "rule_format_wrapper":
            continue
        cleaned, changed = unwrap_rule_xml(xml, approval.format)
        results.append(
            {"project": project, "identifier": identifier, "format": approval.format, "old": xml, "new": cleaned, "changed": changed}
        )
        if changed and not dry_run:
            approval.rule_xml = cleaned
            record_change(session, approval.brdp_id, user, "rule", xml, cleaned)
    return results
