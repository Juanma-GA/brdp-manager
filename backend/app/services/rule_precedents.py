"""Suggest Rule precedent cleanup (Suggest Rule adjustments round): a stored
Verified rule is only useful to the LLM as a precedent if it IS a rule of
the format -- a <structureObjectRule> (BREX 4.x), an <objrule> (BREX 3.0.1)
or an <sch:pattern>/<sch:rule> (DITA Schematron). Real data has both:

  - rules that are only a <nonContextRule> (e.g. BRDP-EXT-00066) -- not a
    rule of the format at all, never shown to the LLM as one;
  - rules that mix a real rule with wrappers (<rules>, a context-less
    <contextRules>) or a <nonContextRule> next to it (e.g. BRDP-S1-00489)
    -- only the rule elements themselves are kept.

Schema context (Suggest Rule part 2): a <contextRules rulesContext="...">
(BREX 4.x) or <contextrules context="..."> (BREX 3.0.1) block that holds
rules of the format is kept WHOLE, context attribute included -- its rules
only apply to that schema (BRDP-S1-00006's three `//dmodule` prohibitions
apply to condcrossreftable/fault/prdcrossreftable only; extracted loose
they read as "dmodule is prohibited everywhere"). A context block with an
empty/missing context attribute is just a wrapper, as before.

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


def _extract_element_spans(text: str, scan: str, local_name: str) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    pos = 0
    start_re = _start_tag_re(local_name)
    while True:
        start = start_re.search(scan, pos)
        if start is None:
            return found
        if start.group("empty"):
            found.append((start.start(), text[start.start() : start.end()]))
            pos = start.end()
            continue
        end_re = re.compile(rf"</{re.escape(start.group('tag'))}\s*>")
        end = end_re.search(scan, start.end())
        if end is None:
            return found  # unbalanced -- stop rather than guess
        found.append((start.start(), text[start.start() : end.end()]))
        pos = end.end()


# Context-scoped block element and its context attribute, per format.
_FORMAT_CONTEXT_BLOCK: dict[str, tuple[str, str]] = {
    "BREX-4.2": ("contextRules", "rulesContext"),
    "BREX-4.1": ("contextRules", "rulesContext"),
    "BREX-3.0.1": ("contextrules", "context"),
}


def _context_blocks(scan: str, rule_format: str) -> list[tuple[int, int]]:
    """Spans of the context blocks that carry a non-empty context attribute
    AND hold at least one rule element of the format."""
    spec = _FORMAT_CONTEXT_BLOCK.get(rule_format)
    if spec is None:
        return []
    block_name, attr = spec
    attr_re = re.compile(rf"\b{attr}\s*=\s*(?:\"\s*[^\"\s][^\"]*\"|'\s*[^'\s][^']*')")
    spans: list[tuple[int, int]] = []
    start_re = _start_tag_re(block_name)
    pos = 0
    while True:
        start = start_re.search(scan, pos)
        if start is None:
            return spans
        if start.group("empty"):
            pos = start.end()
            continue
        end = re.compile(rf"</{re.escape(start.group('tag'))}\s*>").search(scan, start.end())
        if end is None:
            return spans
        inner = scan[start.end() : end.start()]
        has_rule = any(_start_tag_re(n).search(inner) for n in _FORMAT_RULE_ELEMENTS[rule_format])
        if attr_re.search(scan[start.start() : start.end()]) and has_rule:
            spans.append((start.start(), end.end()))
        pos = end.end()


def extract_format_rules(rule_xml: str, rule_format: str) -> str | None:
    """The rule elements of `rule_format` found in `rule_xml`, joined by a
    newline, verbatim -- or None when there is none (the precedent is not
    usable and must be dropped). An unknown format keeps the text as is.
    """
    names = _FORMAT_RULE_ELEMENTS.get(rule_format)
    if names is None:
        return rule_xml
    rule_xml = rule_xml or ""
    scan = _blank_comments(rule_xml)
    # Context blocks first: kept whole, and blanked out of the scan so their
    # inner rules are never taken a second time as loose ones.
    spans = _context_blocks(scan, rule_format)
    loose_scan = scan
    for a, b in spans:
        loose_scan = loose_scan[:a] + " " * (b - a) + loose_scan[b:]
    pieces: list[tuple[int, str]] = [(a, rule_xml[a:b]) for a, b in spans]
    for name in names:
        found = _extract_element_spans(rule_xml, loose_scan, name)
        if found:
            pieces.extend(found)
            break
    if not pieces:
        return None
    pieces.sort(key=lambda p: p[0])
    if len(pieces) == 1 and pieces[0][1].strip() == rule_xml.strip():
        return rule_xml.strip()
    return "\n".join(text for _, text in pieces)
