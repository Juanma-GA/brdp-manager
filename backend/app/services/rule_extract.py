"""AI Extract (1/2), parsing: one candidate BRDP per decision found in an
existing BREX (S1000D 3.0.1, 4.1, 4.2) or Schematron (DITA). No AI here --
everything that can come from the file comes from code.

Reading is safe (no XXE): lxml with resolve_entities=False, no_network=True
and load_dtd=False. A <!DOCTYPE dmodule []> is read normally; an entity that
points outside the file (<!ENTITY x SYSTEM "file:///…">, an ICN declared
with NDATA) is never resolved -- the file is read and a warning names the
entities. The size limit (rule_extract_max_bytes, 413) is checked by the
route before anything is read.

The file must be of the project's rule format (the BREX of its issue, or a
Schematron for DITA); anything else is a 422 with the reason.

Rules are taken from the ORIGINAL TEXT of the file (spans, the same tag scan
as rule_wrappers.py), never re-serialized by lxml: re-serializing would add
the root's namespace declarations to every rule and change its whitespace.
What is stored is what the file says.

Candidates (one per BRDP identifier; a rule with no identifier is a
candidate of its own). The identifier is searched, in this order:
  1. brDecisionRef/@brDecisionIdentNumber (S1000D 4.2), taken as written --
     the "CA" BREX uses BREX-S1-NNNNN numbers there, which are kept;
  2. the @id of the rule (structureObjectRule/objrule/nonContextRule) or, in
     a Schematron, of the sch:pattern or its first sch:assert/sch:report
     (BRDP-…, p-BRDP-…, BRDP-EXT-00007a);
  3. the text that starts objectUse/objuse/simplePara/the assert message
     ("BRDP-S1-00052. …") -- the Lufthansa BREX carries it only there.
Rules with the same identifier are one candidate: several rules (S1-00070),
a general rule plus context blocks (S1-00006), a rule plus a nonContextRule
(S1-00117). The candidate's rule is assembled from its rules: the general
ones as they are, the ones of a context block inside one block per context
(<contextRules rulesContext="…"><structureObjectRuleGroup>… / 3.0.1
<contextrules context="…"><structrules>…), then unwrapped and checked
(rule_wrappers.unwrap_rule_xml, the format check) -- a rule that fails the
check is reported and the candidate imports without it. A context block
whose scope attribute is empty (rulesContext="", an old Lufthansa BREX) is
read as general, with a warning: no BREX validator applies such a block.
A nonContextRule (3.0.1: its comment) is part of the candidate's rule too,
after the executable rules, exactly as written: Generate writes it back into
<nonContextRules>, so importing a BREX and generating it again keeps it. A
candidate with only nonContextRules has them as its rule.

Its paragraphs are also the decision text. When the file already says it,
nothing is asked of the AI (literal_texts): with two or more paragraphs the
first one (without the identifier) is the Definition and the rest the
Proposal ("Decision made by Project." dropped when text follows it; a bare
"Decision made by TDWG." stays as it is); a single paragraph is the
Proposal.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from lxml import etree

from app.api.routes.approvals import _rule_format_problem, _wrap_rule_xml_fragment, _xml_well_formed_error
from app.services.rule_wrappers import unwrap_rule_xml

SCHEMATRON_NS = "http://purl.oclc.org/dsdl/schematron"

# More rules than this and a candidate is shown, and sent to the AI, as a
# summary: the table lists the first PREVIEW_RULES, the AI never gets XML.
BIG_CANDIDATE_RULES = 200
PREVIEW_RULES = 20
# Rules described one by one to the AI (a candidate up to BIG_CANDIDATE_RULES
# lists this many; the rest are counted).
DETAILED_RULES = 30
MAX_VALUES_PER_RULE = 30
# A path or test longer than this is cut in the summary, with the number of
# characters left out (never silently -- HR7). A long path is usually a list
# of values written as predicates (Lufthansa's S1-00052: ~100 information
# codes in 10,000 characters); those values are listed apart, in full
# (_compared_values), so the cut path loses nothing the AI needs.
MAX_PATH_CHARS = 400
MAX_COMPARED_VALUES = 400
_COMPARISON_RE = re.compile(r"(@?[A-Za-z_][\w:.-]*|\.)\s*(!=|=)\s*(\"[^\"]*\"|'[^']*')")


def _compared_values(path: str | None) -> list[dict]:
    """The literal values a path compares names with, grouped by name and
    operator, in order of appearance: //dmCode/@infoCode="000" or
    //dmCode/@infoCode="002" → [{"name": "@infoCode", "op": "=",
    "values": ["000", "002"], "more": 0}]."""
    groups: dict[tuple[str, str], list[str]] = {}
    for m in _COMPARISON_RE.finditer(path or ""):
        name = m.group(1).rsplit("/", 1)[-1]
        values = groups.setdefault((name, m.group(2)), [])
        value = m.group(3)[1:-1]
        if value not in values:
            values.append(value)
    return [
        {"name": name, "op": op, "values": values[:MAX_COMPARED_VALUES], "more": max(0, len(values) - MAX_COMPARED_VALUES)}
        for (name, op), values in groups.items()
        if len(values) >= 2
    ]


def _clip_path(text: str | None) -> str:
    flat = re.sub(r"\s+", " ", text or "").strip()
    if len(flat) <= MAX_PATH_CHARS:
        return flat
    return f"{flat[:MAX_PATH_CHARS]} … [{len(flat) - MAX_PATH_CHARS} more characters]"

STANDARD_ISSUE = {"S1000D 3.0.1": "3.0.1", "S1000D 4.1": "4.1", "S1000D 4.2": "4.2"}
FORMAT_LABEL = {
    "BREX-4.2": "BREX S1000D 4.2",
    "BREX-4.1": "BREX S1000D 4.1",
    "BREX-3.0.1": "BREX S1000D 3.0.1",
    "SCH-DITA": "Schematron (DITA)",
}

# A rule of a specification's default BREX (the "CA" BREX numbers them
# BREX-S1-00001…BREX-S1-00243): not a project decision.
DEFAULT_RULE_RE = re.compile(r"^BREX-([A-Z]\d)-\d+$")
_ID_RE = re.compile(r"(?<![A-Za-z0-9])(?:p-)?(BRDP-[A-Z0-9]+-\d{5})")
_ID_PREFIX_RE = re.compile(r"^\s*(BRDP-[A-Z0-9]+-\d{5})(?![0-9])")
_ISSUE_URL_RE = re.compile(r"S1000D_(\d)-(\d)(?:-(\d))?")
_NO_CONTENT_RE = re.compile(r"does not exist in S1000D|not to take into account", re.IGNORECASE)
# "Decision made by Project." in front of the decision itself: dropped from
# the Proposal only when text follows it.
_PROJECT_DECISION_RE = re.compile(r"^Decision made by (?:the )?Project\s*[.:]\s*(?=\S)", re.IGNORECASE)

# Same token scan as rule_wrappers.py (comments, CDATA, PIs and tags with
# their attributes).
_TOKEN_RE = re.compile(
    r"<!--([\s\S]*?)-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>"
    r"|<(/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:\"[^\"]*\"|'[^']*'))*)\s*(/?)>"
)


class RuleExtractFileError(Exception):
    """A file that cannot be read as the project's rules. status_code 413
    (too large) or 422 (anything else); the message says why (HR7)."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class _Piece:
    kind: str  # "rule" | "noncontext"
    text: str
    context: str | None = None  # raw (still escaped) scope attribute; None = general
    empty_context: bool = False


@dataclass
class RulesFile:
    file_format: str
    root: str
    text: str
    warnings: list[dict] = field(default_factory=list)


def _local(name: str) -> str:
    return name.split(":")[-1]


def _attr(attrs: str, name: str) -> str | None:
    """The raw (still escaped) value of an attribute, or None when absent."""
    m = re.search(r"(?:^|\s)" + re.escape(name) + r"\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", attrs or "")
    if not m:
        return None
    return m.group(1) if m.group(1) is not None else m.group(2)


def _issue_of_url(url: str | None) -> str | None:
    m = _ISSUE_URL_RE.search(url or "")
    if not m:
        return None
    return ".".join(g for g in m.groups() if g is not None)


def _decode(data: bytes, encoding: str | None) -> str:
    for enc in (encoding, "utf-8"):
        if not enc:
            continue
        try:
            # XML normalizes line endings to \n; the rules are taken from the
            # text, so it is done here (a CRLF file must not store \r).
            return data.decode(enc).lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace").lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")


def read_rules_file(data: bytes, rule_format: str | None, standard: str) -> RulesFile:
    """Checks the file and returns its text and format. Raises
    RuleExtractFileError (422) with the reason when the file is empty, is
    not XML, or is not the project's rule format."""
    if rule_format is None:
        raise RuleExtractFileError(f"The project's standard ({standard}) has no rule format, so there are no rules to import.")
    if not data or not data.strip():
        raise RuleExtractFileError("The file is empty.")
    parser = etree.XMLParser(
        resolve_entities=False, no_network=True, load_dtd=False, dtd_validation=False, huge_tree=True
    )
    try:
        tree = etree.ElementTree(etree.fromstring(data, parser))
    except etree.XMLSyntaxError as exc:
        raise RuleExtractFileError(f"The file is not well-formed XML: {exc}") from exc
    except ValueError as exc:  # e.g. a str with an encoding declaration
        raise RuleExtractFileError(f"The file is not XML: {exc}") from exc
    root = tree.getroot()
    docinfo = tree.docinfo
    warnings: list[dict] = []

    external = []
    dtd = docinfo.internalDTD
    if dtd is not None:
        for entity in dtd.iterentities():
            if entity.system_url:
                external.append(entity.name)
    if external or docinfo.system_url:
        warnings.append(
            {
                "code": "external_entities",
                "params": {"names": external, "dtd": docinfo.system_url or ""},
                "message": "The file declares external entities or a DTD outside it; they were not read.",
            }
        )

    text = _decode(data, docinfo.encoding)
    local = etree.QName(root).localname
    namespace = etree.QName(root).namespace
    project_label = FORMAT_LABEL.get(rule_format, rule_format)

    if local == "schema" and namespace == SCHEMATRON_NS:
        if rule_format != "SCH-DITA":
            raise RuleExtractFileError(f"This is a Schematron; this project's rules are {project_label}.")
        binding = (root.get("queryBinding") or "").strip().lower()
        expected = "xslt3" if standard == "DITA 1.3 Xpath3.0" else "xslt2"
        if binding and binding != expected:
            warnings.append(
                {
                    "code": "query_binding",
                    "params": {"found": binding, "expected": expected},
                    "message": f"The Schematron uses queryBinding=\"{binding}\"; this project expects \"{expected}\".",
                }
            )
        return RulesFile("SCH-DITA", local, text, warnings)

    if local == "dmodule":
        brex = root.find("content/brex")
        if brex is None:
            raise RuleExtractFileError("This data module is not a BREX: it has no <brex> in its <content>.")
        if rule_format == "SCH-DITA":
            raise RuleExtractFileError(f"This is a BREX data module; this project's rules are {project_label}.")
        url = root.get("{http://www.w3.org/2001/XMLSchema-instance}noNamespaceSchemaLocation")
        issue = _issue_of_url(url)
        has_objrule = brex.find(".//objrule") is not None
        has_sor = brex.find(".//structureObjectRule") is not None
        if issue is None:
            if has_objrule and not has_sor:
                issue = "3.0.1"
            elif has_sor and rule_format in ("BREX-4.1", "BREX-4.2"):
                issue = rule_format.split("-", 1)[1]
                warnings.append(
                    {
                        "code": "issue_not_stated",
                        "params": {"assumed": issue},
                        "message": f"The BREX does not state its S1000D issue; it was read as {issue}.",
                    }
                )
        file_format = f"BREX-{issue}" if issue else None
        if file_format != rule_format:
            found = f"S1000D {issue}" if issue else "an unknown S1000D issue"
            raise RuleExtractFileError(f"This is a BREX for {found}; this project is {standard} ({project_label}).")
        return RulesFile(file_format, local, text, warnings)

    raise RuleExtractFileError(
        f"This is neither a BREX data module nor a Schematron: the root element is <{root.tag if isinstance(root.tag, str) else '?'}>."
    )


def _body_start(text: str, root: str) -> int:
    """Where the root element starts (after the prolog and any DOCTYPE with
    its internal subset), so declarations are never scanned as tags."""
    pos = 0
    m = re.search(r"<!DOCTYPE", text)
    if m:
        after = m.end()
        bracket = text.find("[", after)
        close = text.find(">", after)
        if bracket != -1 and (close == -1 or bracket < close):
            end_subset = text.find("]", bracket)
            pos = text.find(">", end_subset) + 1 if end_subset != -1 else after
        else:
            pos = close + 1 if close != -1 else after
    m = re.compile(r"<(?:[A-Za-z_][\w.-]*:)?" + re.escape(root) + r"[\s>/]").search(text, pos)
    return m.start() if m else pos


def _scan_pieces(rf: RulesFile) -> tuple[list[_Piece], list[dict]]:
    """Every rule and nonContextRule of the file, in document order, with
    the context block it sits in. Also returns file-level warnings (global
    sch:let / sch:ns of a Schematron)."""
    text = rf.text
    if rf.file_format == "SCH-DITA":
        rule_tags = {"pattern": "rule"}
        blocks: dict[str, str] = {}
        comment_rules = False
    elif rf.file_format == "BREX-3.0.1":
        rule_tags = {"objrule": "rule"}
        blocks = {"contextrules": "context"}
        comment_rules = True
    else:
        rule_tags = {"structureObjectRule": "rule", "nonContextRule": "noncontext"}
        blocks = {"contextRules": "rulesContext"}
        comment_rules = False

    pieces: list[_Piece] = []
    warnings: list[dict] = []
    stack: list[tuple[str, str | None]] = []  # (local name, scope attribute if a context block)
    kept: tuple[str, int, int] | None = None  # (kind, start, depth)
    kept_context: tuple[str | None, bool] = (None, False)
    globals_counter: Counter = Counter()
    in_rules_area = rf.file_format == "SCH-DITA"
    for m in _TOKEN_RE.finditer(text, _body_start(text, rf.root)):
        comment, closing, name, attrs, self_closing = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        if name is None:
            if (
                comment is not None
                and comment_rules
                and kept is None
                and any(s[0] == "brex" for s in stack)
                and comment.strip().startswith("nonContextRule")
            ):
                pieces.append(_Piece("noncontext", m.group(0)))
            continue
        local = _local(name)
        if closing:
            if stack:
                stack.pop()
            if kept is not None and len(stack) == kept[2]:
                pieces.append(_Piece(kept[0], text[kept[1] : m.end()], kept_context[0], kept_context[1]))
                kept = None
            continue
        if kept is None:
            inside = in_rules_area or any(s[0] == "brex" for s in stack)
            if rf.file_format == "SCH-DITA" and len(stack) == 1 and local in ("let", "ns"):
                globals_counter[local] += 1
            if inside and local in rule_tags:
                context, empty = None, False
                for s in reversed(stack):
                    if s[1] is not None:
                        if s[1].strip():
                            context = s[1]
                        else:
                            empty = True
                        break
                if self_closing:
                    pieces.append(_Piece(rule_tags[local], m.group(0), context, empty))
                    continue
                kept = (rule_tags[local], m.start(), len(stack))
                kept_context = (context, empty)
        if not self_closing:
            scope = _attr(attrs, blocks[local]) if local in blocks else None
            stack.append((local, scope))
    for name, count in globals_counter.items():
        warnings.append(
            {
                "code": "schematron_globals",
                "params": {"element": f"sch:{name}", "count": count},
                "message": f"The Schematron has {count} global sch:{name}; they are not part of any imported rule.",
            }
        )
    return pieces, warnings


def _text(el) -> str:
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip() if el is not None else ""


def _find(el, local: str):
    for child in el.iter():
        if isinstance(child.tag, str) and etree.QName(child).localname == local:
            return child
    return None


def _find_all(el, local: str):
    return [c for c in el.iter() if isinstance(c.tag, str) and etree.QName(c).localname == local]


def _parse_piece(piece: _Piece, file_format: str) -> dict:
    """What the piece says: identifier, texts, path(s), values. Never raises
    -- a piece that does not parse (an undefined entity) gets "error"."""
    if piece.kind == "noncontext" and piece.text.startswith("<!--"):
        body = piece.text[4:-3].strip()
        body = re.sub(r"^nonContextRule\s*", "", body)
        id_attr = re.match(r'id="([^"]*)"\s*:?\s*', body)
        if id_attr:
            body = body[id_attr.end() :]
        return {"id_attr": id_attr.group(1) if id_attr else None, "texts": [body.strip()], "error": None}
    try:
        root = etree.fromstring(_wrap_rule_xml_fragment(piece.text).encode("utf-8"))
    except etree.XMLSyntaxError as exc:
        return {"error": str(exc), "texts": []}
    el = root[0]
    info: dict = {"error": None, "id_attr": el.get("id")}
    if piece.kind == "noncontext":
        info["texts"] = [_text(p) for p in _find_all(el, "simplePara") if _text(p)] or [_text(el)]
        return info
    if file_format == "SCH-DITA":
        asserts = []
        for rule in _find_all(el, "rule"):
            for check in [c for c in rule if isinstance(c.tag, str) and etree.QName(c).localname in ("assert", "report")]:
                asserts.append(
                    {
                        "kind": etree.QName(check).localname,
                        "id": check.get("id"),
                        "context": rule.get("context") or "",
                        "test": check.get("test") or "",
                        "role": check.get("role") or "",
                        "message": _text(check),
                    }
                )
        info["asserts"] = asserts
        info["texts"] = [a["message"] for a in asserts if a["message"]]
        return info
    if file_format == "BREX-3.0.1":
        path_el, use_el, value_tag, flag_attr = _find(el, "objpath"), _find(el, "objuse"), "objval", "objappl"
    else:
        path_el, use_el, value_tag, flag_attr = _find(el, "objectPath"), _find(el, "objectUse"), "objectValue", "allowedObjectFlag"
    bd = _find(el, "brDecisionRef")
    values = []
    for v in _find_all(el, value_tag):
        if file_format == "BREX-3.0.1":
            form = v.get("valtype") or "single"
            allowed = v.get("val1") or ""
            if v.get("val2"):
                allowed = f"{allowed}~{v.get('val2')}"
        else:
            form = v.get("valueForm") or "single"
            allowed = v.get("valueAllowed") or ""
        values.append({"form": form, "value": allowed, "text": _text(v)})
    info.update(
        {
            "decision_ref": (bd.get("brDecisionIdentNumber") or "").strip() if bd is not None else None,
            "path": (path_el.text or "") if path_el is not None else "",
            "flag": path_el.get(flag_attr) if path_el is not None else None,
            "use": _text(use_el),
            "values": values,
            "texts": [_text(use_el)] if _text(use_el) else [],
        }
    )
    return info


def _identifier_of(info: dict, file_format: str) -> str | None:
    if info.get("decision_ref"):
        return info["decision_ref"]
    for candidate in [info.get("id_attr")] + [a.get("id") for a in info.get("asserts", [])]:
        m = _ID_RE.search(candidate or "")
        if m:
            return m.group(1)
    for t in info.get("texts", []):
        m = _ID_PREFIX_RE.match(t or "")
        if m:
            return m.group(1)
    return None


def _strip_id_prefix(text: str, identifier: str | None) -> str:
    if identifier and text.lstrip().startswith(identifier):
        return text.lstrip()[len(identifier) :].lstrip(" .:-–—").strip()
    return text.strip()


def _block(file_format: str, context: str, rules: list[str]) -> str:
    body = "\n".join(rules)
    if file_format == "BREX-3.0.1":
        return f'<contextrules context="{context}">\n<structrules>\n{body}\n</structrules>\n</contextrules>'
    return f'<contextRules rulesContext="{context}">\n<structureObjectRuleGroup>\n{body}\n</structureObjectRuleGroup>\n</contextRules>'


def _assemble_rule(file_format: str, rules: list[_Piece], noncontext: list[_Piece] | None = None) -> str:
    """General rules as they are, one block per context, then the
    nonContextRules (3.0.1: their comments) as they are written."""
    general = [p.text for p in rules if p.context is None]
    by_context: dict[str, list[str]] = {}
    for p in rules:
        if p.context is not None:
            by_context.setdefault(p.context, []).append(p.text)
    parts = list(general) + [_block(file_format, ctx, texts) for ctx, texts in by_context.items()]
    parts += [p.text for p in noncontext or []]
    return "\n".join(parts)


def literal_texts(paragraph_groups: list[list[str]]) -> dict:
    """Definition and Proposal written in the file, from the first
    nonContextRule that has text (its paragraphs, the identifier already
    stripped). → {"definition": str | None, "proposal": str | None}."""
    for paras in paragraph_groups:
        if not any(paras):
            continue
        if len(paras) >= 2:
            proposal = "\n".join(_PROJECT_DECISION_RE.sub("", p, count=1) for p in paras[1:] if p)
            return {"definition": paras[0] or None, "proposal": proposal or None}
        return {"definition": None, "proposal": paras[0]}
    return {"definition": None, "proposal": None}


_XPATH_NS = {
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
    "xlink": "http://www.w3.org/1999/xlink",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dc": "http://www.purl.org/dc/elements/1.1/",
}
_EMPTY_DOC = etree.fromstring("<dmodule/>")


def path_returns_boolean(path: str) -> bool:
    """True when the objectPath is an expression that returns true/false
    instead of nodes (S1-00316: //dmStatus/applicRef or //pmStatus/applicRef).
    Evaluated with lxml's XPath 1.0 on an empty document; an expression lxml
    cannot compile (XPath 2.0 functions, unknown prefixes) is not judged."""
    try:
        return isinstance(etree.XPath(path.strip(), namespaces=_XPATH_NS)(_EMPTY_DOC), bool)
    except (etree.XPathError, etree.XPathEvalError, ValueError):
        return False


def _schema_of_context(context: str) -> str:
    m = re.search(r"([A-Za-z]+?)(?:Schema)?\.xsd\s*$", context or "")
    return m.group(1) if m else (context or "")


def _summary(file_format: str, rules: list[_Piece], infos: list[dict]) -> dict:
    """What the AI gets instead of the rules' XML: a code-generated summary
    (never the XML, so a batch never re-sends it). Every candidate has the
    compact fields; one with at most BIG_CANDIDATE_RULES rules also lists
    its first DETAILED_RULES rules one by one."""
    count = len(infos)
    if file_format == "SCH-DITA":
        asserts = [a for info in infos for a in info.get("asserts", [])]
        detailed = [
            {"context": a["context"], "kind": a["kind"], "test": _clip_path(a["test"]), "role": a["role"], "message": a["message"]}
            for a in asserts[:DETAILED_RULES]
        ]
        return {"count": count, "asserts": len(asserts), "rules": detailed, "rules_more": max(0, len(asserts) - DETAILED_RULES)}
    flags = Counter((info.get("flag") or ("2" if file_format != "BREX-3.0.1" else "")) for info in infos)
    kinds = Counter()
    for info in infos:
        path = (info.get("path") or "").strip()
        kinds["absolute" if path.startswith("/") and not path.startswith("//") else "anywhere" if path.startswith("//") else "other"] += 1
    uses = Counter(info.get("use") or "" for info in infos if info.get("use"))
    most_use = uses.most_common(1)[0] if uses else None
    summary = {
        "count": count,
        "flags": dict(flags),
        "path_kinds": dict(kinds),
        "first_paths": [_clip_path(i.get("path")) for i in infos[:10]],
        "most_repeated_use": {"text": most_use[0], "count": most_use[1]} if most_use else None,
        "schemas": sorted({_schema_of_context(p.context) for p in rules if p.context}),
    }
    if count <= BIG_CANDIDATE_RULES:
        summary["rules"] = [
            {
                "path": _clip_path(info.get("path")),
                "compared": _compared_values(info.get("path")),
                "flag": info.get("flag"),
                "use": info.get("use") or "",
                "values": [v["value"] for v in info.get("values", [])[:MAX_VALUES_PER_RULE]],
                "values_more": max(0, len(info.get("values", [])) - MAX_VALUES_PER_RULE),
                "schema": _schema_of_context(piece.context) if piece.context else None,
            }
            for piece, info in list(zip(rules, infos))[:DETAILED_RULES]
        ]
        summary["rules_more"] = max(0, count - DETAILED_RULES)
    return summary


def build_candidates(rf: RulesFile, project_issue: str | None) -> tuple[list[dict], list[dict]]:
    """→ (candidates, file warnings). Each candidate:
    {key, origin_identifier, rule_xml, rule_count, rule_preview, rule_problem,
     noncontext_count, decision_texts, literal, object_uses, summary,
     warnings, no_content}. rule_xml is the rules as written (executable
     ones, then nonContextRules); rule_count counts the executable ones."""
    pieces, warnings = _scan_pieces(rf)
    groups: dict[str, dict] = {}
    order: list[dict] = []
    for piece in pieces:
        info = _parse_piece(piece, rf.file_format)
        identifier = _identifier_of(info, rf.file_format)
        if identifier is None or identifier not in groups:
            group = {
                "identifier": identifier, "rules": [], "infos": [], "noncontext": [], "noncontext_pieces": [],
                "paragraphs": [], "pieces": [], "errors": [],
            }
            order.append(group)
            if identifier is not None:
                groups[identifier] = group
        else:
            group = groups[identifier]
        if info.get("error"):
            group["errors"].append(info["error"])
        group["pieces"].append(piece)
        if piece.kind == "noncontext":
            paras = [_strip_id_prefix(t, identifier) for t in info.get("texts", [])]
            group["paragraphs"].append(paras)
            group["noncontext"].extend(p for p in paras if p)
            group["noncontext_pieces"].append(piece)
        else:
            group["rules"].append(piece)
            group["infos"].append(info)

    candidates = []
    for index, group in enumerate(order, start=1):
        identifier = group["identifier"]
        rules, infos = group["rules"], group["infos"]
        noncontext = group["noncontext_pieces"]
        cand_warnings: list[dict] = []
        rule_xml = ""
        rule_problem = None
        if rules or noncontext:
            rule_xml = _assemble_rule(rf.file_format, rules, noncontext)
            rule_xml = unwrap_rule_xml(rule_xml, rf.file_format)[0]
            if group["errors"]:
                rule_problem = {"code": "not_parsed", "message": f"A rule could not be read: {group['errors'][0]}"}
            else:
                error = _xml_well_formed_error(rule_xml)
                if error is not None:
                    rule_problem = {"code": "not_well_formed", "message": f"The rule is not well-formed XML: {error}"}
                else:
                    problem = _rule_format_problem(rule_xml, rf.file_format)
                    if problem is not None:
                        rule_problem = {"code": problem["code"], "message": problem["message"]}
        if any(p.empty_context for p in rules):
            cand_warnings.append(
                {
                    "code": "empty_context",
                    "params": {},
                    "message": "The source BREX had a general block with an empty rulesContext; the rules are imported as general.",
                }
            )
        boolean_paths = [i["path"].strip() for i in infos if i.get("path") and path_returns_boolean(i["path"])]
        if boolean_paths:
            cand_warnings.append(
                {
                    "code": "boolean_path",
                    "params": {"paths": boolean_paths[:3], "count": len(boolean_paths)},
                    "message": "The path returns true/false, not nodes.",
                }
            )
        if project_issue and rule_xml:
            versions = sorted({_issue_of_url("S1000D_" + "-".join(g for g in m.groups() if g)) for m in _ISSUE_URL_RE.finditer(rule_xml)} - {project_issue})
            if versions:
                cand_warnings.append(
                    {
                        "code": "other_version_urls",
                        "params": {"versions": versions, "project": project_issue},
                        "message": f"Uses schema URLs of S1000D {', '.join(versions)}; in {project_issue} data modules it would not apply.",
                    }
                )
        if identifier is not None and not identifier.startswith("BRDP-") and not DEFAULT_RULE_RE.match(identifier):
            cand_warnings.append(
                {
                    "code": "not_brdp_identifier",
                    "params": {"identifier": identifier},
                    "message": f"The source identifier {identifier} is not a BRDP identifier.",
                }
            )
        object_uses = list(dict.fromkeys(_strip_id_prefix(i.get("use") or "", identifier) for i in infos if i.get("use")))
        if rf.file_format == "SCH-DITA":
            object_uses = list(dict.fromkeys(_strip_id_prefix(t, identifier) for i in infos for t in i.get("texts", []) if t))
        no_content = not rules and bool(_NO_CONTENT_RE.search(" ".join(group["noncontext"])))
        candidates.append(
            {
                "key": f"c{index:05d}",
                "origin_identifier": identifier,
                "rule_xml": rule_xml,
                "rule_count": len(rules),
                "noncontext_count": len(noncontext),
                "rule_preview": [p.text for p in group["pieces"][:PREVIEW_RULES]],
                "rule_problem": rule_problem,
                "decision_texts": group["noncontext"],
                "literal": literal_texts(group["paragraphs"]),
                "object_uses": object_uses[:20],
                "summary": _summary(rf.file_format, rules, infos) if rules else None,
                "warnings": cand_warnings,
                "no_content": no_content,
            }
        )
    return candidates, warnings
