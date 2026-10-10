"""What is saved as a rule must contain a rule of the project's format.

Consolidation C2, Part 0. Real case: "Paste rule" with just the text
//&lt;emphasis&gt; -- well-formed XML with no element at all -- was accepted,
saved as Draft and could be tested. PUT …/approvals/{format} now rejects it
with 422 and the reason.

Mirror of checkRuleFormat() in src/validation/schemaValidation.js (the
interface checks first and disables Accept/Save; this is the defense for a
caller that skips the interface). Keep both in sync -- same codes, same
allowed shapes:

  BREX 4.2/4.1  <structureObjectRule>, <nonContextRule>, or a <contextRules>
                block holding at least one structureObjectRule
  BREX 3.0.1    <objrule>, a <contextrules> block holding at least one
                objrule, or a comment starting with "nonContextRule" (the
                3.0.1 stand-in for a rule without context)
  SCH-DITA      <pattern> or <rule>, with or without a prefix

A BREX rule element has one path and one use (rule_format_multiple, Mejoras
A): the interface splits a mechanical one before saving (ruleSplit.js).

Comments are always allowed next to the rule; loose text and any other
top-level element are not. An unknown format is not checked. The Excel
import does not reject a row with this check, but it stores a rule without
legacy wrappers (<rules>, a bare <structureObjectRuleGroup> -- see
rule_wrappers.py, which scripts/normalize_rule_wrappers.py applies to what is
already stored); anything else is reported by scripts/report_invalid_rules.py
and scripts/lint-curated-templates.mjs.
"""

from dataclasses import dataclass

from lxml import etree


@dataclass(frozen=True)
class _Shape:
    label: str
    rules: tuple[str, ...]
    blocks: dict
    expected: str
    non_context_comment: bool = False


_SHAPES = {
    "BREX-4.2": _Shape("BREX 4.2", ("structureObjectRule", "nonContextRule"), {"contextRules": "structureObjectRule"}, "structureObjectRule"),
    "BREX-4.1": _Shape("BREX 4.1", ("structureObjectRule", "nonContextRule"), {"contextRules": "structureObjectRule"}, "structureObjectRule"),
    "BREX-3.0.1": _Shape("BREX 3.0.1", ("objrule",), {"contextrules": "objrule"}, "objrule", non_context_comment=True),
    "SCH-DITA": _Shape("Schematron (DITA)", ("pattern", "rule"), {}, "sch:pattern"),
}

# Element names that belong to one format only.
_RULE_ELEMENT_FORMAT = {
    "structureObjectRule": "BREX 4.x",
    "nonContextRule": "BREX 4.x",
    "contextRules": "BREX 4.x",
    "structureObjectRuleGroup": "BREX 4.x",
    "objrule": "BREX 3.0.1",
    "contextrules": "BREX 3.0.1",
    "structrules": "BREX 3.0.1",
    "pattern": "Schematron (DITA)",
    "rule": "Schematron (DITA)",
}

_MESSAGES = {
    "rule_format_missing": "This is not a {format} rule: {expected} is missing",
    "rule_format_text": "Loose text outside the rule element is not allowed: “{text}”",
    "rule_format_wrapper": "<{element}> is not allowed around the rule: write {expected} directly",
    "rule_format_empty_block": "<{element}> contains no {inner}",
    "rule_format_other_format": "<{element}> belongs to a {otherFormat} rule, not to a {format} rule",
    "rule_format_foreign": "<{element}> is not part of a {format} rule",
    "rule_format_multiple": "A <{element}> can only have one <{child}>; this one has {count}",
    "rule_format_duplicate_ids": "Several <{element}> have the same id ({ids}); each rule needs its own id",
}

# Mejoras A, Part 3: one path and one use per rule element (brex4.2.xsd /
# brex4.1.xsd: structureObjectRule = brDecisionRef*, objectPath,
# objectUse?, objectValue*; 3.0.1 brex.xsd: objrule = objpath, objuse?,
# objval*). Mirror of multiplePathOrUse() in src/utils/ruleSplit.js.
_SINGLE_CHILDREN = {
    "BREX-4.2": ("structureObjectRule", ("objectPath", "objectUse")),
    "BREX-4.1": ("structureObjectRule", ("objectPath", "objectUse")),
    "BREX-3.0.1": ("objrule", ("objpath", "objuse")),
}


def _local(tag: str) -> str:
    return etree.QName(tag).localname


def _qualified(el: etree._Element) -> str:
    """The element's name as written (prefix:local or local)."""
    return f"{el.prefix}:{_local(el.tag)}" if el.prefix else _local(el.tag)


def _clip(text: str, n: int = 60) -> str:
    return text if len(text) <= n else f"{text[: n - 1]}…"


def check_rule_format(root: etree._Element, format: str) -> dict | None:
    """The first problem of a parsed, wrapped rule fragment (the throwaway
    <root> from _wrap_rule_xml_fragment), or None when it is a rule of the
    format (or the format is unknown). The problem is
    {"code", "params", "message"}.
    """
    shape = _SHAPES.get(format)
    if shape is None:
        return None
    base = {"format": shape.label, "expected": shape.expected}

    def fail(code: str, **params) -> dict:
        full = {**base, **params}
        return {"code": code, "params": full, "message": _MESSAGES[code].format(**full)}

    texts: list[str] = []
    if root.text and root.text.strip():
        texts.append(root.text.strip())
    rules = 0
    for child in root:
        if child.tail and child.tail.strip():
            texts.append(child.tail.strip())
        if isinstance(child, etree._Comment):
            if shape.non_context_comment and (child.text or "").strip().startswith("nonContextRule"):
                rules += 1
            continue
        if not isinstance(child.tag, str):  # processing instruction
            continue
        local = _local(child.tag)
        if local in shape.rules:
            rules += 1
            continue
        inner = shape.blocks.get(local)
        descendants = {_local(d.tag) for d in child.iterdescendants() if isinstance(d.tag, str)}
        if inner:
            if inner not in descendants:
                return fail("rule_format_empty_block", element=_qualified(child), inner=inner)
            rules += 1
            continue
        other = _RULE_ELEMENT_FORMAT.get(local)
        if other and other != shape.label and not (shape.label.startswith("BREX 4") and other == "BREX 4.x"):
            return fail("rule_format_other_format", element=_qualified(child), otherFormat=other)
        if any(r in descendants for r in shape.rules):
            return fail("rule_format_wrapper", element=_qualified(child))
        return fail("rule_format_foreign", element=_qualified(child))
    if rules == 0:
        return fail("rule_format_missing")
    single = _SINGLE_CHILDREN.get(format)
    if single:
        rule_name, children = single
        for el in root.iter():
            if not isinstance(el.tag, str) or _local(el.tag) != rule_name:
                continue
            for child in children:
                count = sum(1 for c in el if isinstance(c.tag, str) and _local(c.tag) == child)
                if count > 1:
                    return fail("rule_format_multiple", element=rule_name, child=child, count=count)
        # Mejoras B, Part 4.3: a rule element's id is xs:ID -- one per rule.
        # Mirror of duplicateRuleIds() in src/utils/ruleSplit.js.
        seen: dict[str, int] = {}
        for el in root.iter():
            if isinstance(el.tag, str) and _local(el.tag) == rule_name and el.get("id"):
                seen[el.get("id")] = seen.get(el.get("id"), 0) + 1
        duplicated = [i for i, n in seen.items() if n > 1]
        if duplicated:
            return fail("rule_format_duplicate_ids", element=rule_name, ids=", ".join(duplicated))
    if texts:
        return fail("rule_format_text", text=_clip(texts[0]))
    return None
