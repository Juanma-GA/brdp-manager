"""Suggest Rule precedent cleanup (Suggest Rule adjustments round): a stored
Verified rule is only useful to the LLM as a precedent if it IS a rule of
the format -- a <structureObjectRule> (BREX 4.x), an <objrule> (BREX 3.0.1)
or an <sch:pattern>/<sch:rule> (DITA Schematron). Real data has both:

  - rules that are only a <nonContextRule> (e.g. BRDP-EXT-00066) -- not a
    rule of the format at all, never shown to the LLM as one;
  - rules that mix a real rule with wrappers (<rules>, <contextRules>) or a
    <nonContextRule> next to it (e.g. BRDP-S1-00489) -- only the rule
    elements themselves are kept.

Extraction is textual (spans of the ORIGINAL string), never a parse and
re-serialize: a precedent must reach the prompt exactly as it was written,
and re-serializing a fragment with fake namespace declarations (the
tolerant-parse trick in approvals.py) would add noise to it. None of these
elements can nest inside itself, so "start tag -> first matching end tag"
is exact.
"""
import re

# Rule elements per rule_approvals format. For SCH-DITA a <pattern> is the
# unit; bare <rule> elements are only taken when there is no pattern at all
# (a rule inside a pattern is already part of it).
_FORMAT_RULE_ELEMENTS: dict[str, tuple[str, ...]] = {
    "BREX-4.2": ("structureObjectRule",),
    "BREX-4.1": ("structureObjectRule",),
    "BREX-3.0.1": ("objrule",),
    "SCH-DITA": ("pattern", "rule"),
}

_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _start_tag_re(local_name: str) -> re.Pattern:
    # Optional namespace prefix; attribute values may legally contain ">"
    # (Schematron tests do), so quoted values are consumed as a whole.
    return re.compile(
        rf"<(?P<tag>(?:[\w.-]+:)?{local_name})(?=[\s/>])(?:\"[^\"]*\"|'[^']*'|[^'\">])*?(?P<empty>/)?>"
    )


def _blank_comments(text: str) -> str:
    """Same-length copy with comment bodies blanked -- matches found in it
    map 1:1 onto the original, and a tag mentioned inside a comment is
    never taken for a real element."""
    return _COMMENT_RE.sub(lambda m: " " * len(m.group(0)), text)


def _extract_elements(text: str, scan: str, local_name: str) -> list[str]:
    found: list[str] = []
    pos = 0
    start_re = _start_tag_re(local_name)
    while True:
        start = start_re.search(scan, pos)
        if start is None:
            return found
        if start.group("empty"):
            found.append(text[start.start() : start.end()])
            pos = start.end()
            continue
        end_re = re.compile(rf"</{re.escape(start.group('tag'))}\s*>")
        end = end_re.search(scan, start.end())
        if end is None:
            return found  # unbalanced -- stop rather than guess
        found.append(text[start.start() : end.end()])
        pos = end.end()


def extract_format_rules(rule_xml: str, rule_format: str) -> str | None:
    """The rule elements of `rule_format` found in `rule_xml`, joined by a
    newline, verbatim -- or None when there is none (the precedent is not
    usable and must be dropped). An unknown format keeps the text as is.
    """
    names = _FORMAT_RULE_ELEMENTS.get(rule_format)
    if names is None:
        return rule_xml
    scan = _blank_comments(rule_xml or "")
    for name in names:
        elements = _extract_elements(rule_xml, scan, name)
        if elements:
            if len(elements) == 1 and elements[0].strip() == (rule_xml or "").strip():
                return rule_xml.strip()
            return "\n".join(elements)
    return None
