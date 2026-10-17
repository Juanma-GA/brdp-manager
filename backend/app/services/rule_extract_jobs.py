"""AI Extract (1/2): classification of the candidates, the background job
that reads and classifies a file, and the import of the reviewed ones.

Classification is done by code -- the AI never decides it:
  same / changed  the identifier already exists in the project: the
                  candidate's rule is compared with the stored one, both
                  normalized as in "Comparar dos BRDP" (whitespace of the
                  formatting never counts; XPath keeps the spaces inside its
                  string literals). "same" also when the candidate has no
                  rule to import (nothing would change). A would-be new_ext
                  whose rule is already in the project under another
                  identifier is also same / changed: matched by content
                  (match_by_content), never checked by default.
  catalog         an identifier of the project standard's catalog that is not
                  in the project: Title/Definition come from the catalog.
  other_spec      an official identifier of another specification
                  (BRDP-S2-… S2000M, BRDP-S3-… S3000L, …) not in the catalog:
                  keeps its identifier, the AI writes Title/Definition.
  new_ext         anything else (an EXT identifier not in the project, an
                  identifier of the own specification missing from the
                  catalog, a non-BRDP identifier such as BREX-S1-…, no
                  identifier). An EXT number of the file that is free in
                  the project keeps its number; the rest get the next free
                  number after the project's AND the file's own numbers.
                  The original identifier stays as the origin. A candidate
                  reclassified as new_ext (an occupied EXT number whose rule
                  changed) gets the next free number and the warning that
                  the identifiers inside its rule are still the file's.
  default_rule    a rule of the standard's default BREX (BREX-S1-nnnnn and,
                  in general, BREX-<spec>-nnnnn): unchecked, a project BREX
                  normally inherits it; imported with its own identifier
                  when checked.
  empty           "Sin contenido": only a nonContextRule saying the decision
                  does not exist in this issue / is not to be taken into
                  account. Unchecked; its base classification is kept so it
                  can still be imported.
Texts (set_texts): each of Title / Definition / Proposal comes from the
project (an existing BRDP), the catalog (Title and Definition of "catalog"),
the file (the nonContextRule's paragraphs, rule_extract.literal_texts) or
the AI -- the AI writes only the fields left (ai_fields); a candidate with
none left is never sent to it. text_sources says where each one came from
(also "manual" once edited by hand).
A possible duplicate is a warning, never a classification: for new_ext the
origin text is embedded and compared with the project's embedded BRDPs; at or
above similar.py's MIN_SIMILARITY the candidate says "Parecida a BRDP-…".
Only the project's Validated BRDPs have embeddings (Pending ones never do),
so only those are compared; when the embeddings service fails, the job says
so and the classification stands (HR7).

The job runs in the background (BackgroundTasks, own sessions, like
import_jobs.py): a 5,500-rule BREX reads in seconds but must not block the
request, and progress is visible meanwhile. Writing the texts with the AI is
driven by the page (the prompt lives in src/prompts, like every other prompt
of the app, under the prompt snapshot and the eval set), and each batch is
saved here (PATCH), so leaving the page and coming back resumes it.

Import (apply) is one transaction, synchronous: no AI and no external call,
a few thousand inserts. new_ext numbers are checked again at import time,
against the identifiers active then. "import_as": "pending" (Proposal
Pending, rule Draft) or "in_force" (the file is already in use: Proposal
Validated and rule Verified for the candidates whose rule passes the format
check; the others stay Pending/Draft and are counted). Validated BRDPs join
the embeddings queue like any other.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import unicodedata
import uuid
from datetime import datetime, timezone

import httpx
from lxml import etree
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.approvals import _rule_state, _wrap_rule_xml_fragment
from app.api.routes.similar import MIN_SIMILARITY
from app.core.config import get_settings
from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, BRDPHistory, Project, RuleApproval, RuleExtractCandidate, RuleExtractJob, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.services.jobs_common import EMBED_BATCH_SIZE, reap_if_stale
from app.services.embeddings import EmbeddingUnavailable, compute_embeddings_batch, truncate_for_embedding_input
from app.services.history import record_change
from app.services.rule_extract import BIG_CANDIDATE_RULES, DEFAULT_RULE_RE, STANDARD_ISSUE, RulesFile, build_candidates
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT
from app.services.text_extract import build_text_candidates, normalize_ws
from app.services.rule_wrappers import unwrap_rule_xml

_EXT_RE = re.compile(r"^BRDP-EXT-(\d+)$")
_OFFICIAL_RE = re.compile(r"^BRDP-([A-Z])(\d)-\d{5}$")
# A project's own identifier prefix (BRDP-ENV-00001): 2-6 uppercase letters,
# not EXT and not a prefix of any loaded catalog. Prefixes with digits (S1,
# S2, D1, A1) are official codes and are not own prefixes.
_OWN_PREFIX_RE = re.compile(r"^BRDP-([A-Z]{2,6})-(\d{5})$")
OWN_PREFIX_PATTERN = re.compile(r"^[A-Z]{2,6}$")

# Specification of each official identifier code.
SPECIFICATIONS = {
    "S1": "S1000D",
    "S2": "S2000M",
    "S3": "S3000L",
    "S4": "S4000P",
    "S5": "S5000F",
    "S6": "S6000T",
    "D1": "DITA",
}
# The codes of the project's own specification: an identifier with one of
# them that is not in the catalog is a new EXT, not "another specification".
# DITA projects use S1000D's identifiers too (the DITA catalog is built from
# the S1000D one).
_OWN_CODES = {"S1000D": {"S1"}, "DITA": {"D1", "S1"}}

# "From catalog (S1000D 4.1)": an identifier of the project's specification
# that is not in its own standard's catalog but is in another edition's
# (the same number is the same decision across editions). Imported with its
# own identifier; the edition label next to it in the app says which
# catalog it comes from.
CATALOG_CLASSES = ("catalog", "catalog_edition")
# Retired: "From catalog (S1000D 4.1), marked" imported the identifier with
# the edition as a suffix (BRDP-S1-00012-4.1). The edition label does the
# same without renaming, so the option is gone. BRDPs already imported with
# the suffix stay as they are; an extraction saved before the change reads
# those rows as "catalog_edition" (retire_marked_classification), and a
# request asking for it is refused with the reason.
RETIRED_MARKED_CLASSIFICATION = "catalog_edition_marked"
TEXT_FIELDS = ("title", "definition", "proposal")


def _own_codes(standard: str) -> set[str]:
    return _OWN_CODES["DITA" if standard.startswith("DITA") else "S1000D"]


def default_rule_specification(identifier: str | None) -> str | None:
    """BREX-S1-00001 → "S1000D", else None."""
    m = DEFAULT_RULE_RE.match(identifier or "")
    return SPECIFICATIONS.get(m.group(1), m.group(1)) if m else None


def set_texts(c: dict, keep_written: bool = False) -> None:
    """Title / Definition / Proposal, text_sources, ai_fields and
    draft_status for the candidate's current classification, in place.
    Fixed sources first: the project's texts for an existing BRDP; the
    catalog's Title and Definition for "catalog"; the file's literal
    Definition and Proposal otherwise. What is left is for the AI. With
    keep_written (a reclassification), text already written by the AI or by
    hand is kept where the AI would write it, and hand edits are kept
    always."""
    classification = c.get("classification")
    if classification == "empty":
        classification = c.get("base_classification")
    fixed: dict[str, tuple[str, str]] = {}
    if classification in ("same", "changed"):
        for f, v in (c.get("project_texts") or {}).items():
            fixed[f] = (v or "", "project")
    else:
        catalog = c.get("catalog_texts") or {}
        if classification in CATALOG_CLASSES and catalog:
            fixed["title"] = (catalog.get("title") or "", "catalog")
            fixed["definition"] = (catalog.get("definition") or "", "catalog")
        # Free text: the title the AI gave with the decision (step 1).
        if c.get("found_title") and "title" not in fixed:
            fixed["title"] = (c["found_title"], "ai")
        literal = c.get("literal") or {}
        if literal.get("title") and "title" not in fixed:
            fixed["title"] = (literal["title"], "file")
        if literal.get("definition") and "definition" not in fixed:
            fixed["definition"] = (literal["definition"], "file")
        if literal.get("proposal"):
            fixed["proposal"] = (literal["proposal"], "file")
    sources = dict(c.get("text_sources") or {})
    ai_fields = []
    for f in TEXT_FIELDS:
        written = keep_written and bool(c.get(f))
        if written and sources.get(f) == "manual":
            continue
        if f in fixed:
            c[f], sources[f] = fixed[f]
            continue
        ai_fields.append(f)
        if not (written and sources.get(f) == "ai"):
            c[f], sources[f] = "", None
    c["text_sources"] = sources
    c["ai_fields"] = ai_fields
    if not ai_fields:
        c["draft_status"] = "not_needed"
    elif all(c.get(f) for f in ai_fields):
        c["draft_status"] = c["draft_status"] if c.get("draft_status") in ("drafted", "manual") else "drafted"
    else:
        c["draft_status"] = "pending"


_WRITES_TITLE = ("new_ext", "own_prefix", "other_spec", "default_rule")


def text_state(c: dict) -> str:
    """Whether a candidate has the texts it needs to be imported, from its
    data alone (never from what a page has in memory, so it survives a page
    reload or a server restart): "complete" (nothing left to write, or every
    field the AI writes has text, written by the AI or by hand), "failed"
    (the AI could not write it: retry, write it by hand, or uncheck the
    row) or "pending" (not written yet). An existing BRDP ("same" /
    "changed") and "Sin contenido" keep the project's texts / are not
    imported: always complete."""
    classification = c.get("classification")
    if classification in ("same", "changed", "empty"):
        return "complete"
    fields = c.get("ai_fields")
    if fields is None:  # an extraction saved before ai_fields existed
        fields = list(TEXT_FIELDS) if classification in _WRITES_TITLE else ["proposal"]
    if all((c.get(f) or "").strip() for f in fields):
        return "complete"
    return "failed" if c.get("draft_status") == "failed" else "pending"


def too_long_fields(c: dict) -> list[dict]:
    """The texts a candidate would create a BRDP with that are over the
    BRDP limits (Settings.brdp_title_max_chars / brdp_text_max_chars, the
    same limits as creating it by hand): [{field, length, max}]. Such a
    candidate keeps its whole text (never cut, HR6) and cannot be imported
    until it is shortened. An existing BRDP ("same"/"changed") keeps the
    project's texts and "Sin contenido" is not imported: never too long."""
    if c.get("classification") in ("same", "changed", "empty"):
        return []
    settings = get_settings()
    limits = {"title": settings.brdp_title_max_chars, "definition": settings.brdp_text_max_chars, "proposal": settings.brdp_text_max_chars}
    return [
        {"field": field, "length": len(c.get(field) or ""), "max": limit}
        for field, limit in limits.items()
        if len(c.get(field) or "") > limit
    ]


def _edition_version(standard: str) -> tuple[int, ...] | None:
    m = re.match(r"^S1000D (\d+(?:\.\d+)*)$", standard or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else None


def _version_value(version: tuple[int, ...]) -> float:
    return sum(n / (10 ** (2 * i)) for i, n in enumerate(version))


def closest_edition(project_standard: str, editions: list[str]) -> str | None:
    """Of the other S1000D editions whose catalog has the identifier, the
    closest to the project's (4.1 for a 4.2 project, before 5.0 or 3.0.1);
    on a tie, the most recent."""
    own = _edition_version(project_standard)
    found = [(e, _edition_version(e)) for e in editions if _edition_version(e) and e != project_standard]
    if own is None or not found:
        return None
    target = _version_value(own)
    return min(found, key=lambda ev: (round(abs(_version_value(ev[1]) - target), 9), -_version_value(ev[1])))[0]


async def load_other_edition_catalogs(
    standard: str, identifiers, own_catalog_ids: set[str], db: AsyncSession
) -> dict[str, dict[str, BRDPCatalog]]:
    """Identifier → {edition: catalog row} for the official identifiers of
    the project's own specification (BRDP-S1-…) that its standard's catalog
    does not have, from the catalogs of the other S1000D editions; one query
    for all of them. Empty for a DITA project, and never for an EXT or an
    identifier of another specification (S2…). Shared by AI Extract and the
    Excel import; closest_edition() picks the edition. Also empty when the
    project's standard has no catalog loaded at all."""
    if _edition_version(standard) is None:
        return {}
    missing = sorted({
        i for i in identifiers
        if i and i not in own_catalog_ids and (m := _OFFICIAL_RE.match(i)) and m.group(1) + m.group(2) in _own_codes(standard)
    })
    out: dict[str, dict[str, BRDPCatalog]] = {}
    if not missing:
        return out
    # Without any catalog for the project's own standard, "not in the
    # S1000D 3.0.1 catalog" cannot be told apart from "no 3.0.1 catalog
    # loaded": nothing is taken from other editions then.
    own_loaded = (
        await db.execute(select(BRDPCatalog.id).where(BRDPCatalog.standard == standard).limit(1))
    ).first()
    if own_loaded is None:
        return out
    rows = (
        await db.execute(
            select(BRDPCatalog).where(
                BRDPCatalog.standard.like("S1000D %"),
                BRDPCatalog.standard != standard,
                BRDPCatalog.identifier.in_(missing),
            )
        )
    ).scalars().all()
    for r in rows:
        out.setdefault(r.identifier, {})[r.standard] = r
    return out


def other_edition_entry(
    standard: str, identifier: str, edition_catalogs: dict[str, dict[str, BRDPCatalog]]
) -> tuple[str, BRDPCatalog] | None:
    """(edition, catalog row) of the closest other edition that has the
    identifier, else None."""
    by_edition = edition_catalogs.get(identifier)
    if not by_edition:
        return None
    edition = closest_edition(standard, list(by_edition))
    return (edition, by_edition[edition]) if edition else None


# A "marked" identifier carries the edition it came from
# (BRDP-S1-00036-4.1, from AI Extract's retired "From catalog (S1000D 4.1),
# marked" option). Such BRDPs still exist in projects.
_MARKED_IDENTIFIER_RE = re.compile(r"^(BRDP-[A-Z]\d-\d{5})-\d+(?:\.\d+)*$")


def catalog_base_identifier(identifier: str) -> str:
    """BRDP-S1-00036-4.1 → BRDP-S1-00036; anything else as it is."""
    m = _MARKED_IDENTIFIER_RE.match(identifier or "")
    return m.group(1) if m else identifier


async def catalog_edition_labels(standard: str, identifiers, db: AsyncSession) -> dict[str, str]:
    """Identifier → the other S1000D edition whose catalog has it ("S1000D
    4.1"), for every identifier the catalog of the project's standard does
    not have -- the "4.1" label next to the identifier in Records, the BRDP
    panel and Compare. Computed, never stored: the same lookup as the Excel
    import and AI Extract (no label when the project's standard has no
    catalog at all), a marked identifier looked up without its suffix, and
    a constant number of queries whatever the number of BRDPs (3 at most)."""
    if _edition_version(standard) is None:
        return {}
    bases = {i: catalog_base_identifier(i) for i in identifiers if i}
    candidates = sorted({b for b in bases.values() if _OFFICIAL_RE.match(b)})
    if not candidates:
        return {}
    own = set(
        (
            await db.execute(
                select(BRDPCatalog.identifier).where(
                    BRDPCatalog.standard == standard, BRDPCatalog.identifier.in_(candidates)
                )
            )
        ).scalars().all()
    )
    editions = await load_other_edition_catalogs(standard, candidates, own, db)
    out = {}
    for identifier, base in bases.items():
        found = other_edition_entry(standard, base, editions)
        if found is not None:
            out[identifier] = found[0]
    return out


def other_specification(identifier: str | None, standard: str) -> str | None:
    """The specification name of an official identifier of another
    specification (BRDP-S2-00002 → "S2000M"), else None."""
    m = _OFFICIAL_RE.match(identifier or "")
    if not m:
        return None
    code = m.group(1) + m.group(2)
    if code in _own_codes(standard) or code == "D1" or m.group(1) == "E":
        return None
    return SPECIFICATIONS.get(code, code)


# ── Normalized rule comparison (as in "Comparar dos BRDP") ───────────────

_XPATH_ELEMENTS = {"objectPath", "objpath"}
_XPATH_ATTRIBUTES = {"context", "test", "select", "value", "path"}


def _collapse(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def norm_space(s: str | None) -> str:
    """Port of _normSpace (src/api/brexToSchematron.js): collapses
    whitespace outside quoted literals, keeps it inside them."""
    out, in_str, quote, pending = [], False, "", False
    for ch in s or "":
        if in_str:
            out.append(ch)
            if ch == quote:
                in_str = False
            continue
        if ch in ("'", '"'):
            if pending:
                out.append(" ")
                pending = False
            in_str, quote = True, ch
            out.append(ch)
            continue
        if ch.isspace():
            pending = True
            continue
        if pending:
            out.append(" ")
            pending = False
        out.append(ch)
    return "".join(out).strip()


def _serialize(el, out: list[str]) -> None:
    if isinstance(el, etree._Comment):
        out.append(f"<!--{_collapse(el.text)}-->")
        return
    if not isinstance(el.tag, str):
        return
    local = etree.QName(el).localname
    attrs = "".join(
        f' {etree.QName(k).localname}="{norm_space(v) if etree.QName(k).localname in _XPATH_ATTRIBUTES else _collapse(v)}"'
        for k, v in el.attrib.items()
    )
    out.append(f"<{local}{attrs}>")
    text = el.text or ""
    if text.strip():
        out.append(norm_space(text) if local in _XPATH_ELEMENTS else _collapse(text))
    for child in el:
        _serialize(child, out)
        if child.tail and child.tail.strip():
            out.append(_collapse(child.tail))
    out.append(f"</{local}>")


def normalize_rule(xml: str, rule_format: str) -> str | None:
    """A canonical form for equality, or None when it does not parse."""
    if not xml or not xml.strip():
        return ""
    cleaned = unwrap_rule_xml(xml, rule_format)[0]
    try:
        root = etree.fromstring(_wrap_rule_xml_fragment(cleaned).encode("utf-8"))
    except etree.XMLSyntaxError:
        return None
    out: list[str] = []
    for child in root:
        _serialize(child, out)
    return "".join(out)


def rules_equal(a: str, b: str, rule_format: str) -> bool:
    na, nb = normalize_rule(a, rule_format), normalize_rule(b, rule_format)
    if na is None or nb is None:
        return _collapse(a) == _collapse(b)
    return na == nb


# ── Matching by content (rules already in the project) ───────────────────
#
# A file without BRDP identifiers (the ATA CMP BREX: structureObjectRule
# id="SOR-n" only) imported into a project whose rules came from Excel (no
# "extracted_from" event) used to give one "Nueva EXT" per rule. Only for the
# candidates that would otherwise be a new EXT, the stored rules of the
# project's other BRDPs are compared by content:
#   1. same normalized pieces as exactly one BRDP          → "same"
#   2. same context + path, or context + objectUse (Schematron: context +
#      test, or context + message), with exactly one BRDP, and similar
#      enough as a whole (CONTENT_MATCH_FLOOR)             → "changed"
#   3. otherwise the most similar one, when exactly one is at or above
#      CONTENT_SIMILARITY                                  → "changed"
# A content match is never checked by default (it may be a correction made in
# the project) and says how it was found. Two BRDPs with the same rule: no
# match, a warning naming them. A BRDP takes one candidate only: an exact
# match wins, then the higher similarity; the others stay "Nueva EXT" with a
# warning.
#
# Normalization (reusing unwrap_rule_xml and norm_space): no wrappers, no
# comments, formatting whitespace collapsed (XPath string literals keep
# theirs), the @id of the rule elements ignored, and the identifier in front
# of an objectUse / nonContextRule text ignored. BREX: each rule is its
# context, flag (allowedObjectFlag / objappl; absent = "2"), path, objectUse,
# values (form, value, text) and severity; each nonContextRule its text.
# Schematron: each pattern (or loose rule), serialized without ids.
#
# Similarity: Sørensen–Dice over the character trigrams of "objectUse | path"
# (Schematron: "message | context test"), lowercased. 0.85, calibrated on the
# real BREX in tests/fixtures/brex: rewriting one path step and adding a
# sentence to the objectUse of each of the 533 decisions of the "CA" BREX
# scores 0.79–1.0 (5th percentile 0.82, median 0.92); changing the path only,
# ≥ 0.96; rewording the objectUse only, ≥ 0.84. The same decision written
# independently by two projects (the 46 shared by Lufthansa and CA) scores
# 0.04–0.29. Different decisions of the same file can be closer (in CA, 193 of
# 533 have another decision at ≥ 0.85), so a single BRDP above the threshold
# is required, and only the BRDPs not matched already are compared.

CONTENT_SIMILARITY = 0.85
# A shared context + path (or objectUse) is the same rule changed only when
# the rest still resembles it: Lufthansa's BRDP-S1-00151 (//@materialUsage
# forbidden, "Decision by Company.") and the default BREX's BREX-S1-00211
# (//@materialUsage with its mu01-mu06 values) share the path but are two
# different decisions, at 0.35; the ten corrections of the reconstructed ATA
# fixture score 0.88-1.0.
CONTENT_MATCH_FLOOR = 0.5
# A rule the file itself marks as modified (changeType="modify", or
# changeMark="1" without a changeType; 3.0.1 change="modify" / mark="1") is
# the next issue of a rule the project already has, so it may have changed
# more than CONTENT_SIMILARITY allows (the ATA CMP 010 SOR-3, path and
# objectUse rewritten: embeddings 0.94, trigrams below 0.85). For those only,
# a BRDP left unmatched is taken at CONTENT_MATCH_FLOOR when it is the best
# with at least MODIFIED_MATCH_MARGIN over the second. 0.1, calibrated on the
# real BREX of tests/fixtures/brex: a path that loses a condition and an
# objectUse that loses a sentence, in pools of 20 unmatched BRDPs (10 of
# them the originals), 400 draws: CA 93.4 % matched to their original, 0.09 %
# to another, 6.5 % left as new; Lufthansa 80 % / 0 % / 20 %; the
# reconstructed ATA 93.9 % / 0 % / 6.1 %. 0.05 matches 2-3 % more but also
# to the wrong BRDP; 0.15 loses 4 % of the right ones. When the original is
# not in the project another BRDP still takes it in 6-19 % of the draws: the
# match is never checked by default and says how it was found.
MODIFIED_MATCH_MARGIN = 0.1
_LEADING_ID_RE = re.compile(r"^BRDP-[A-Z0-9]+-\d{5}(?:-\d+(?:\.\d+)*)?(?![0-9])[\s.:\-–—]*")
_STRING = etree.XPath("string(.)")
_SCH_ID_ELEMENTS = {"pattern", "rule", "assert", "report"}


def _strip_leading_id(text: str | None) -> str:
    return _LEADING_ID_RE.sub("", _collapse(text), count=1)


def _trigrams(text: str) -> frozenset:
    text = text.lower()
    return frozenset(text[i : i + 3] for i in range(len(text) - 2))


def content_similarity(a: frozenset, b: frozenset) -> float:
    """Sørensen–Dice over two trigram sets."""
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


class RuleContent:
    """A stored or extracted rule, normalized for matching by content."""

    __slots__ = ("pieces", "ordered", "path_keys", "use_keys", "grams")

    def __init__(self, pieces, path_keys, use_keys, sim_parts, labels=None):
        # ordered: (piece, label) in document order; label is the rule
        # element's @id when it has one (None otherwise).
        labels = labels or [None] * len(pieces)
        self.ordered = tuple(zip(pieces, labels))
        self.pieces = tuple(sorted(pieces))
        self.path_keys = path_keys
        self.use_keys = use_keys
        self.grams = _trigrams("\n".join(sorted(sim_parts))) if sim_parts else frozenset()


def _sch_serialize(el, out: list[str]) -> None:
    """_serialize without comments and without the ids of the Schematron
    rule elements; attributes in name order."""
    if not isinstance(el.tag, str):
        return
    local = etree.QName(el).localname
    attrs = []
    for k, v in el.attrib.items():
        name = etree.QName(k).localname
        if name == "id" and local in _SCH_ID_ELEMENTS:
            continue
        attrs.append((name, norm_space(v) if name in _XPATH_ATTRIBUTES else _collapse(v)))
    rendered = "".join(' %s="%s"' % (n, v) for n, v in sorted(attrs))
    out.append(f"<{local}{rendered}>")
    if (el.text or "").strip():
        out.append(_collapse(el.text))
    for child in el:
        _sch_serialize(child, out)
        if child.tail and child.tail.strip():
            out.append(_collapse(child.tail))
    out.append(f"</{local}>")


def rule_content(xml: str | None, rule_format: str | None) -> RuleContent | None:
    """None when there is nothing to compare (empty, not well-formed, no
    rule of the format)."""
    if not xml or not xml.strip() or not rule_format:
        return None
    cleaned = unwrap_rule_xml(xml, rule_format)[0]
    try:
        root = etree.fromstring(_wrap_rule_xml_fragment(cleaned).encode("utf-8"))
    except etree.XMLSyntaxError:
        return None
    pieces: list[str] = []
    labels: list = []
    path_keys: set = set()
    use_keys: set = set()
    sim: list[str] = []
    if rule_format == "SCH-DITA":
        for top in root:
            if not isinstance(top.tag, str) or etree.QName(top).localname not in ("pattern", "rule"):
                continue
            out: list[str] = []
            _sch_serialize(top, out)
            pieces.append("S" + "".join(out))
            labels.append(top.get("id"))
            rules = [top] if etree.QName(top).localname == "rule" else [
                r for r in top.iter() if isinstance(r.tag, str) and etree.QName(r).localname == "rule"
            ]
            for rule in rules:
                context = norm_space(rule.get("context"))
                for check in rule:
                    if not isinstance(check.tag, str) or etree.QName(check).localname not in ("assert", "report"):
                        continue
                    kind = etree.QName(check).localname
                    test = norm_space(check.get("test"))
                    message = _collapse(_STRING(check))
                    path_keys.add((context, kind, test))
                    if message:
                        use_keys.add((context, message))
                    sim.append(f"{message} | {context} {test}")
        return RuleContent(pieces, path_keys, use_keys, sim, labels) if pieces else None
    is301 = rule_format == "BREX-3.0.1"
    rule_tag = "objrule" if is301 else "structureObjectRule"
    block_tag, block_attr = ("contextrules", "context") if is301 else ("contextRules", "rulesContext")
    path_tag, use_tag, value_tag, flag_attr = (
        ("objpath", "objuse", "objval", "objappl") if is301 else ("objectPath", "objectUse", "objectValue", "allowedObjectFlag")
    )
    for el in root.iter():
        if isinstance(el, etree._Comment):
            body = _collapse(el.text)
            if body.startswith("nonContextRule"):
                body = re.sub(r'^nonContextRule\s*:?\s*(?:id="[^"]*"\s*:?\s*)?', "", body)
                pieces.append("N" + _strip_leading_id(body))
                labels.append(None)
            continue
        if not isinstance(el.tag, str):
            continue
        local = etree.QName(el).localname
        if local == "nonContextRule":
            paras = [_collapse(_STRING(p)) for p in el.iter() if isinstance(p.tag, str) and etree.QName(p).localname == "simplePara"]
            text = " ".join(p for p in paras if p) if paras else _collapse(_STRING(el))
            pieces.append("N" + _strip_leading_id(text))
            labels.append(el.get("id"))
            continue
        if local != rule_tag:
            continue
        context = ""
        for anc in el.iterancestors():
            if isinstance(anc.tag, str) and etree.QName(anc).localname == block_tag:
                context = _collapse(anc.get(block_attr))
                break
        path, flag, use, severity, values = "", "2", "", "", []
        for child in el:
            if not isinstance(child.tag, str):
                continue
            name = etree.QName(child).localname
            if name == path_tag:
                path = norm_space(child.text)
                flag = (child.get(flag_attr) or "").strip() or "2"
            elif name == use_tag:
                use = _strip_leading_id(_STRING(child))
            elif name == "brSeverityLevel":
                severity = _collapse(_STRING(child))
            elif name == value_tag:
                if is301:
                    values.append([child.get("valtype") or "single", child.get("val1") or "", child.get("val2") or "", _collapse(_STRING(child))])
                else:
                    values.append([child.get("valueForm") or "single", child.get("valueAllowed") or "", "", _collapse(_STRING(child))])
        pieces.append("R" + json.dumps([context, flag, path, use, values, severity], ensure_ascii=False))
        labels.append(el.get("id"))
        path_keys.add((context, path))
        if use:
            use_keys.add((context, use))
        sim.append(f"{use} | {path}")
    return RuleContent(pieces, path_keys, use_keys, sim, labels) if pieces else None


_CHANGE_ATTR_RE = re.compile(r'\s(changeType|changeMark|change|mark)\s*=\s*("[^"]*"|\'[^\']*\')')
_TAG_RE = re.compile(r"<([A-Za-z_][\w.:-]*)((?:\s+[^\s=<>/]+\s*=\s*(?:\"[^\"]*\"|'[^']*'))*)\s*/?>")


def marked_modified(xml: str | None, rule_format: str | None) -> bool:
    """True when an element of the rule says it was modified: changeType=
    "modify" (3.0.1: change="modify"), or changeMark="1" (mark="1") without a
    change type. Added or deleted rules (changeType="add"/"delete") never
    count. Comments are skipped."""
    if not xml or rule_format not in ("BREX-4.2", "BREX-4.1", "BREX-3.0.1"):
        return False
    type_attr, mark_attr = ("change", "mark") if rule_format == "BREX-3.0.1" else ("changeType", "changeMark")
    text = re.sub(r"<!--.*?-->", "", xml, flags=re.S)
    for m in _TAG_RE.finditer(text):
        attrs = {a: v[1:-1].strip() for a, v in _CHANGE_ATTR_RE.findall(m.group(2))}
        kind = attrs.get(type_attr)
        if kind == "modify" or (not kind and attrs.get(mark_attr) == "1"):
            return True
    return False


def match_by_content(
    candidates: list[dict], pool: list[tuple], rule_format: str, identified: set | frozenset = frozenset()
) -> dict[str, dict]:
    """candidates: the ones that would be a new EXT, and the "identified"
    ones (keys in identified: an official, default-rule or own-prefix
    identifier the project does not have), in file order; pool: (brdp,
    stored rule_xml) of the project's BRDPs not matched by identifier or
    origin. → {candidate key: {"brdp", "how": "exact"|"content"|
    "similarity"|"modified", "similarity"}, {"split": [brdp, …]} or
    {"warning": {...}}}.

    An identified candidate keeps its classification unless its rule is
    exactly a project BRDP's (step 1); when each of its several rules is
    exactly the whole rule of a different BRDP, those BRDPs are its own
    (step 1b, "split"); a mere resemblance is only a warning (step 5) and
    never takes a BRDP. Steps 2-4 are for the would-be new EXTs only."""
    stored = [(b, rc) for b, xml in pool if (rc := rule_content(xml, rule_format)) is not None]
    if not stored or not candidates:
        return {}
    by_pieces: dict = {}
    by_path: dict = {}
    by_use: dict = {}
    for b, rc in stored:
        by_pieces.setdefault(rc.pieces, []).append(b)
        for k in rc.path_keys:
            by_path.setdefault(k, {})[b.id] = b
        for k in rc.use_keys:
            by_use.setdefault(k, {})[b.id] = b
    content_of = {b.id: rc for b, rc in stored}
    results: dict[str, dict] = {}
    taken: dict = {}  # brdp id → candidate key (exact matches first)
    contents = {c["key"]: rule_content(c["rule_xml"], rule_format) for c in candidates}

    def taken_warning(b) -> dict:
        return {
            "warning": {
                "code": "brdp_already_matched",
                "params": {"identifier": b.identifier},
                "message": f"Its rule resembles {b.identifier}, already matched with another rule of the file.",
            }
        }

    # 1. Exact.
    for c in candidates:
        rc = contents[c["key"]]
        if rc is None:
            continue
        same = by_pieces.get(rc.pieces, [])
        if len(same) > 1:
            names = sorted(b.identifier for b in same)
            results[c["key"]] = {
                "warning": {
                    "code": "rule_in_several_brdps",
                    "params": {"identifiers": names},
                    "message": f"The same rule is in several BRDPs: {', '.join(names)}.",
                }
            }
        elif same:
            b = same[0]
            if b.id in taken:
                results[c["key"]] = taken_warning(b)
            else:
                taken[b.id] = c["key"]
                results[c["key"]] = {"brdp": b, "how": "exact", "similarity": 1.0}

    def resolve(proposals: list[tuple]) -> None:
        # proposals: (candidate key, brdp, score, how); the highest score
        # takes the BRDP, the others get the warning.
        best: dict = {}
        for key, b, score, how in proposals:
            if b.id in taken:
                results[key] = taken_warning(b)
            elif b.id not in best or score > best[b.id][2]:
                if b.id in best:
                    results[best[b.id][0]] = taken_warning(b)
                best[b.id] = (key, b, score, how)
            else:
                results[key] = taken_warning(b)
        for key, b, score, how in best.values():
            taken[b.id] = key
            results[key] = {"brdp": b, "how": how, "similarity": round(score, 3)}

    # 1b. Identified candidates with several rules: each rule exactly the
    # whole rule of one BRDP (a different one per rule, none taken). All of
    # them → those BRDPs are the candidate's ("split"); only some → a
    # warning naming them, and the BRDPs stay free.
    for c in candidates:
        rc = contents[c["key"]]
        if c["key"] not in identified or rc is None or c["key"] in results or len(rc.ordered) < 2:
            continue
        found = []
        used: set = set()
        for index, (piece, label) in enumerate(rc.ordered, start=1):
            owners = [b for b in by_pieces.get((piece,), []) if b.id not in taken]
            if len(by_pieces.get((piece,), [])) == 1 and len(owners) == 1 and owners[0].id not in used:
                used.add(owners[0].id)
                found.append({"rule": label or str(index), "identifier": owners[0].identifier, "brdp": owners[0]})
        if not found:
            continue
        total = len(rc.ordered)
        if len(found) == total:
            for f in found:
                taken[f["brdp"].id] = c["key"]
            results[c["key"]] = {"split": [f["brdp"] for f in found]}
        else:
            parts = [{"rule": f["rule"], "identifier": f["identifier"]} for f in found]
            results[c["key"]] = {
                "warning": {
                    "code": "rules_partly_in_project",
                    "params": {"count": len(found), "total": total, "parts": parts},
                    "message": f"{len(found)} of its {total} rules are already in the project: "
                    + ", ".join(f"{p['rule']} in {p['identifier']}" for p in parts)
                    + "; importing it would duplicate them.",
                }
            }

    # 2. Same context + path, or context + objectUse, with one BRDP.
    proposals = []
    for c in candidates:
        rc = contents[c["key"]]
        if rc is None or c["key"] in results or c["key"] in identified:
            continue
        found: dict = {}
        for k in rc.path_keys:
            found.update(by_path.get(k, {}))
        if len(found) != 1:
            found = {}
            for k in rc.use_keys:
                found.update(by_use.get(k, {}))
        if len(found) == 1:
            b = next(iter(found.values()))
            score = content_similarity(rc.grams, content_of[b.id].grams)
            if score >= CONTENT_MATCH_FLOOR:
                proposals.append((c["key"], b, score, "content"))
    resolve(proposals)

    # 3. The only one at or above CONTENT_SIMILARITY among the BRDPs left.
    left = [(b, rc) for b, rc in stored if b.id not in taken]
    proposals = []
    for c in candidates:
        rc = contents[c["key"]]
        if rc is None or c["key"] in results or not rc.grams or c["key"] in identified:
            continue
        size = len(rc.grams)
        above = []
        for b, brc in left:
            other = len(brc.grams)
            if not other or 2 * min(size, other) / (size + other) < CONTENT_SIMILARITY:
                continue
            score = content_similarity(rc.grams, brc.grams)
            if score >= CONTENT_SIMILARITY:
                above.append((b, score))
                if len(above) > 1:
                    break
        if len(above) == 1:
            proposals.append((c["key"], above[0][0], above[0][1], "similarity"))
    resolve(proposals)

    # 4. Rules marked as modified in the file: the best BRDP left, at
    # CONTENT_MATCH_FLOOR, with MODIFIED_MATCH_MARGIN over the second.
    left = [(b, brc) for b, brc in stored if b.id not in taken]
    proposals = []
    for c in candidates:
        rc = contents[c["key"]]
        if (
            rc is None
            or c["key"] in results
            or not rc.grams
            or c["key"] in identified
            or not marked_modified(c.get("rule_xml"), rule_format)
        ):
            continue
        scores = sorted(((content_similarity(rc.grams, brc.grams), b) for b, brc in left), key=lambda x: -x[0])
        if not scores or scores[0][0] < CONTENT_MATCH_FLOOR:
            continue
        second = scores[1][0] if len(scores) > 1 else 0.0
        if scores[0][0] - second >= MODIFIED_MATCH_MARGIN:
            proposals.append((c["key"], scores[0][1], scores[0][0], "modified"))
    resolve(proposals)

    # 5. Identified candidates that only resemble a BRDP left (what steps 2
    # and 3 would match for a new EXT): a warning, nothing taken.
    left = [(b, brc) for b, brc in stored if b.id not in taken]
    left_ids = {b.id for b, _ in left}
    for c in candidates:
        rc = contents[c["key"]]
        if c["key"] not in identified or rc is None or c["key"] in results or not rc.grams:
            continue
        found: dict = {}
        for k in rc.path_keys:
            found.update(by_path.get(k, {}))
        if len(found) != 1:
            found = {}
            for k in rc.use_keys:
                found.update(by_use.get(k, {}))
        hit = None
        if len(found) == 1:
            b = next(iter(found.values()))
            score = content_similarity(rc.grams, content_of[b.id].grams)
            if b.id in left_ids and score >= CONTENT_MATCH_FLOOR:
                hit = (b, score)
        if hit is None:
            above = []
            for b, brc in left:
                score = content_similarity(rc.grams, brc.grams)
                if score >= CONTENT_SIMILARITY:
                    above.append((b, score))
            if len(above) == 1:
                hit = above[0]
        if hit is not None:
            b, score = hit
            results[c["key"]] = {
                "warning": {
                    "code": "rule_resembles_brdp",
                    "params": {"identifier": b.identifier, "similarity": round(score, 2)},
                    "message": f"Its rule resembles {b.identifier} ({round(score, 2)}).",
                }
            }
    return results


# ── Classification ────────────────────────────────────────────────────────


async def _active_identifiers(project_id: uuid.UUID, db: AsyncSession) -> dict[str, BRDP]:
    rows = (await db.execute(select(BRDP).where(BRDP.project_id == project_id, ACTIVE_BRDP_FILTER))).scalars().all()
    return {b.identifier: b for b in rows}


async def _extracted_origins(project_id: uuid.UUID, existing: dict[str, BRDP], db: AsyncSession) -> dict[str, BRDP]:
    """Origin identifier → the active BRDP created or updated from it by an
    earlier extraction (its "extracted_from" history event; the latest
    wins). A candidate whose origin became a new EXT number (BRDP-EXT-00014
    in the file → BRDP-EXT-00004 in the project; an S1 identifier missing
    from the catalog) is then found again on a re-import, instead of
    becoming yet another EXT."""
    by_id = {b.id: b for b in existing.values()}
    if not by_id:
        return {}
    rows = (
        await db.execute(
            select(BRDPHistory.brdp_id, BRDPHistory.new_value)
            .where(BRDPHistory.brdp_id.in_(list(by_id)), BRDPHistory.field_name == "extracted_from")
            .order_by(BRDPHistory.changed_at)
        )
    ).all()
    out: dict[str, BRDP] = {}
    for brdp_id, value in rows:
        try:
            origin = json.loads(value).get("origin_identifier")
        except (ValueError, AttributeError):
            continue
        if origin:
            out[origin] = by_id[brdp_id]
    return out


def _next_numbers(identifiers, prefix: str = "EXT") -> int:
    """The highest number of BRDP-<prefix>-nnnnn among the identifiers (0
    when none): the next free one is that + 1, per prefix."""
    pattern = re.compile(r"^BRDP-" + re.escape(prefix) + r"-(\d+)$")
    highest = 0
    for identifier in identifiers:
        m = pattern.match(identifier or "")
        if m:
            highest = max(highest, int(m.group(1)))
    return highest


def _next_ext_numbers(identifiers) -> int:
    return _next_numbers(identifiers, "EXT")


async def catalog_prefixes(db: AsyncSession) -> set[str]:
    """The identifier prefixes used by any loaded catalog, of any standard
    (BRDP-S1-… → S1): a prefix in this set is never a project's own one."""
    rows = (
        await db.execute(select(func.distinct(func.substring(BRDPCatalog.identifier, r"^BRDP-([A-Za-z0-9]+)-"))))
    ).scalars().all()
    return {r for r in rows if r}


def own_prefix(identifier: str | None, catalog_prefix_set: set[str]) -> str | None:
    """"ENV" for BRDP-ENV-00001 (a project's own prefix), else None."""
    m = _OWN_PREFIX_RE.match(identifier or "")
    if not m or m.group(1) == "EXT" or m.group(1) in catalog_prefix_set:
        return None
    return m.group(1)


async def classify_candidates(project: Project, candidates: list[dict], db: AsyncSession) -> None:
    """Sets classification, base_classification, options, identifier
    (proposed), title/definition from the catalog, existing_rule_xml, and
    the classification warnings, in place."""
    rule_format = STANDARD_TO_RULE_FORMAT.get(project.standard)
    existing = await _active_identifiers(project.id, db)
    origin_ids = [c["origin_identifier"] for c in candidates if c["origin_identifier"]]
    catalog = {}
    if origin_ids:
        rows = (
            await db.execute(
                select(BRDPCatalog).where(BRDPCatalog.standard == project.standard, BRDPCatalog.identifier.in_(origin_ids))
            )
        ).scalars().all()
        catalog = {r.identifier: r for r in rows}
    extracted = await _extracted_origins(project.id, existing, db)
    # Other S1000D editions' catalogs, for official identifiers of the
    # project's specification that its own catalog does not have.
    edition_catalog = await load_other_edition_catalogs(project.standard, origin_ids, set(catalog), db)

    # BRDPs imported with the retired "marked" identifier (BRDP-S1-00012-4.1)
    # are the same decision: found by their base identifier too, also when
    # they came in by Excel (no "extracted_from" event).
    marked = {}
    for identifier, b in sorted(existing.items()):
        base_id = catalog_base_identifier(identifier)
        if base_id != identifier:
            marked.setdefault(base_id, b)

    def match(origin):
        if not origin:
            return None
        return existing.get(origin) or extracted.get(origin) or marked.get(origin)

    approvals = {}
    existing_ids = [match(i).id for i in origin_ids if match(i) is not None]
    if rule_format and existing_ids:
        rows = (
            await db.execute(
                select(RuleApproval).where(RuleApproval.brdp_id.in_(existing_ids), RuleApproval.format == rule_format)
            )
        ).scalars().all()
        approvals = {r.brdp_id: r for r in rows}

    # EXT numbers written in the file are kept when free in the project; a
    # candidate that needs a new number gets the next one after both the
    # project's and the file's (never one the file itself uses).
    next_ext = max(_next_ext_numbers(existing), _next_ext_numbers(origin_ids)) + 1
    # A project's own prefix (BRDP-ENV-00001): "Keep ENV" keeps the number.
    prefixes = await catalog_prefixes(db)
    own_spec = "DITA" if project.standard.startswith("DITA") else "S1000D"

    def content_kind(c: dict) -> str | None:
        """"new_ext" for a would-be new EXT, "identified" for an official,
        default-rule or own-prefix identifier the project does not have,
        None when the candidate is not compared by content."""
        origin = c["origin_identifier"]
        if match(origin) is not None or c.get("no_content") or c.get("source") == "text":
            return None
        if not c.get("rule_xml") or c.get("rule_problem"):
            return None
        if origin and (
            origin in catalog
            or (origin in edition_catalog and closest_edition(project.standard, list(edition_catalog[origin])))
            or default_rule_specification(origin)
            or other_specification(origin, project.standard)
            or own_prefix(origin, prefixes)
        ):
            return "identified"
        return "new_ext"

    # Rules already in the project under another identifier (matching by
    # content), against the BRDPs no candidate matched by identifier or
    # origin: the would-be new EXTs, and the candidates whose identifier
    # (catalog, other edition, other specification, default rule, own
    # prefix) the project does not have -- a project copied from Excel keeps
    # those decisions under its own EXT numbers.
    content_matches: dict[str, dict] = {}
    kinds = {c["key"]: content_kind(c) for c in candidates} if rule_format else {}
    eligible = [c for c in candidates if kinds.get(c["key"])]
    identified = {k for k, v in kinds.items() if v == "identified"}
    if eligible:
        matched_ids = {b.id for o in origin_ids if (b := match(o)) is not None}
        pool_rows = (
            await db.execute(
                select(BRDP, RuleApproval)
                .join(RuleApproval, RuleApproval.brdp_id == BRDP.id)
                .where(BRDP.project_id == project.id, ACTIVE_BRDP_FILTER, RuleApproval.format == rule_format)
                .order_by(BRDP.identifier)
            )
        ).all()
        pool = [(b, a.rule_xml) for b, a in pool_rows if b.id not in matched_ids and (a.rule_xml or "").strip()]
        content_matches = match_by_content(eligible, pool, rule_format, identified)
        for b, a in pool_rows:
            approvals.setdefault(b.id, a)
    for c in candidates:
        origin = c["origin_identifier"]
        importable_rule = c["rule_xml"] if c["rule_xml"] and not c.get("rule_problem") else ""
        c.update({"title": "", "definition": "", "proposal": "", "draft_status": "pending", "existing_rule_xml": None})
        if origin and origin in catalog:
            c["catalog_texts"] = {"title": catalog[origin].title, "definition": catalog[origin].definition}
        brdp = match(origin)
        prefix = own_prefix(origin, prefixes)
        if prefix:
            c["own_prefix"] = prefix
        if brdp is not None:
            approval = approvals.get(brdp.id)
            stored = approval.rule_xml if approval is not None else ""
            c["existing_rule_xml"] = stored
            c["existing_rule_state"] = _rule_state(approval)
            if importable_rule and not rules_equal(importable_rule, stored, rule_format):
                base = "changed"
            else:
                base = "same"
                if c.get("source") == "text":
                    c["warnings"].append(
                        {
                            "code": "exists_in_project",
                            "params": {"identifier": brdp.identifier},
                            "message": f"{brdp.identifier} already exists in the project: the import never changes its texts.",
                        }
                    )
                elif not importable_rule:
                    c["warnings"].append(
                        {"code": "no_rule_to_import", "params": {}, "message": "There is no rule to import, nothing would change."}
                    )
            c["project_texts"] = {"title": brdp.title, "definition": brdp.definition, "proposal": brdp.proposal}
            c["identifier"] = brdp.identifier
            c["option_identifiers"] = {base: brdp.identifier}
            # "Keep ENV" then gives the next free ENV number (the origin's is
            # taken), on demand (apply_edit).
            options = [base, "own_prefix", "new_ext"] if prefix else [base, "new_ext"]
        elif origin and origin in catalog:
            base = "catalog"
            c["identifier"] = origin
            options = ["catalog", "new_ext"]
        elif origin and origin in edition_catalog and closest_edition(project.standard, list(edition_catalog[origin])):
            edition = closest_edition(project.standard, list(edition_catalog[origin]))
            entry = edition_catalog[origin][edition]
            base = "catalog_edition"
            c["catalog_edition"] = edition
            c["catalog_texts"] = {"title": entry.title, "definition": entry.definition}
            c["identifier"] = origin
            c["option_identifiers"] = {"catalog_edition": origin}
            c["warnings"].append(
                {
                    "code": "catalog_other_edition",
                    "params": {"identifier": origin, "standard": project.standard, "edition": edition},
                    "message": f"{origin} is not in the {project.standard} catalog; it is in {edition}.",
                }
            )
            options = ["catalog_edition", "new_ext"]
        elif default_rule_specification(origin):
            base = "default_rule"
            c["specification"] = default_rule_specification(origin)
            c["identifier"] = origin
            c["warnings"].append(
                {
                    "code": "default_rule",
                    "params": {"specification": c["specification"]},
                    "message": "A rule of the standard's default BREX; a project BREX normally inherits it.",
                }
            )
            options = ["default_rule", "new_ext"]
        elif other_specification(origin, project.standard):
            base = "other_spec"
            c["specification"] = other_specification(origin, project.standard)
            c["identifier"] = origin
            options = ["other_spec", "new_ext"]
        elif prefix:
            # Not in the project (it would have matched): its number is free.
            base = "own_prefix"
            c["identifier"] = origin
            c["option_identifiers"] = {"own_prefix": origin}
            options = ["own_prefix", "new_ext"]
        elif (found := content_matches.get(c["key"], {})).get("brdp") is not None:
            # The rule is already in the project under another identifier.
            brdp = found["brdp"]
            approval = approvals.get(brdp.id)
            c["existing_rule_xml"] = approval.rule_xml if approval is not None else ""
            c["existing_rule_state"] = _rule_state(approval)
            c["project_texts"] = {"title": brdp.title, "definition": brdp.definition, "proposal": brdp.proposal}
            c["identifier"] = brdp.identifier
            base = "same" if found["how"] == "exact" else "changed"
            c["match_by"] = "similarity" if found["how"] in ("similarity", "modified") else "content"
            c["option_identifiers"] = {base: brdp.identifier}
            if _EXT_RE.match(origin or "") and origin not in existing:
                c["option_identifiers"]["new_ext"] = origin
            if found["how"] == "content":
                c["warnings"].append(
                    {
                        "code": "content_match_changed",
                        "params": {"identifier": brdp.identifier},
                        "message": f"Matched by content with {brdp.identifier}: the project's rule differs from the file's. "
                        "It may be a correction made in the project; review it before importing.",
                    }
                )
            elif found["how"] == "similarity":
                c["warnings"].append(
                    {
                        "code": "similarity_match",
                        "params": {"identifier": brdp.identifier, "similarity": found["similarity"]},
                        "message": f"Matched by similarity with {brdp.identifier}: check it.",
                    }
                )
            elif found["how"] == "modified":
                c["warnings"].append(
                    {
                        "code": "modified_match",
                        "params": {"identifier": brdp.identifier, "similarity": found["similarity"]},
                        "message": f"Marked as modified in the file; matched by similarity with {brdp.identifier}: check it.",
                    }
                )
            options = [base, "new_ext"]
        else:
            base = "new_ext"
            if content_matches.get(c["key"], {}).get("warning"):
                c["warnings"].append(content_matches[c["key"]]["warning"])
            # A free EXT number of the file keeps its number.
            if _EXT_RE.match(origin or ""):
                c["option_identifiers"] = {"new_ext": origin}
            m = _OFFICIAL_RE.match(origin or "")
            if m and m.group(1) + m.group(2) in _own_codes(project.standard):
                c["warnings"].append(
                    {
                        "code": "not_in_catalog",
                        "params": {"identifier": origin, "standard": project.standard},
                        "message": f"{origin} is not in the {project.standard} catalog.",
                    }
                )
            c["identifier"] = None
            options = ["new_ext"]
        if c["key"] in identified and (found := content_matches.get(c["key"])):
            if found.get("brdp") is not None:
                # The same rule is in the project under another identifier:
                # "Ya existe (igual)", the file's classification still an
                # option.
                brdp = found["brdp"]
                approval = approvals.get(brdp.id)
                c["existing_rule_xml"] = approval.rule_xml if approval is not None else ""
                c["existing_rule_state"] = _rule_state(approval)
                c["project_texts"] = {"title": brdp.title, "definition": brdp.definition, "proposal": brdp.proposal}
                identifiers = dict(c.get("option_identifiers") or {})
                identifiers.setdefault(base, c.get("identifier") or origin)
                identifiers["same"] = brdp.identifier
                c["option_identifiers"] = identifiers
                c["identifier"] = brdp.identifier
                c["match_by"] = "content"
                c["warnings"].append(
                    {
                        "code": "content_match_identified",
                        "params": {"identifier": brdp.identifier, "origin": origin},
                        "message": f"Matched by content with {brdp.identifier}; in the file it is identified as {origin}.",
                    }
                )
                options = ["same", base, "new_ext"]
                base = "same"
            elif found.get("split"):
                names = [b.identifier for b in found["split"]]
                c["split_brdps"] = names
                c["content_unselected"] = True
                c["warnings"].append(
                    {
                        "code": "rules_split_in_project",
                        "params": {"count": len(names), "identifiers": names},
                        "message": f"Its {len(names)} rules are already in the project, spread over: {', '.join(names)}; "
                        "importing it would duplicate those rules.",
                    }
                )
            elif found.get("warning"):
                c["warnings"].append(found["warning"])
                if found["warning"]["code"] == "rules_partly_in_project":
                    c["content_unselected"] = True
        c["base_classification"] = base
        classification = (
            "empty"
            if c.get("no_content") and base in ("catalog", "catalog_edition", "new_ext", "own_prefix", "other_spec", "default_rule")
            else base
        )
        if classification == "empty":
            options = ["empty"] + options
        identifiers = c.setdefault("option_identifiers", {})
        if base not in identifiers and c.get("identifier"):
            identifiers[base] = c["identifier"]
        if base == "new_ext" and "new_ext" not in identifiers:
            identifiers["new_ext"] = f"BRDP-EXT-{next_ext:05d}"
            next_ext += 1
        if base == "new_ext":
            c["identifier"] = identifiers["new_ext"]
        c["rule_ids"] = _ids_inside_rule(c.get("rule_xml") or "", origin)
        c["classification"] = classification
        _renumber_warning(c)
        c["options"] = list(dict.fromkeys(options))
        # A content match is never checked by default: the project's rule may
        # be a correction of the file's.
        c["selected"] = (
            classification in ("new_ext", "own_prefix", "catalog", "other_spec", "changed")
            and not c.get("match_by")
            and not c.get("content_unselected")
        )
        c["own_specification"] = own_spec
        set_texts(c)


def _ids_inside_rule(rule_xml: str, origin: str | None) -> list[str]:
    """The identifiers inside the rule's attributes that carry the origin
    identifier (id="p-BRDP-EXT-00005", id="BRDP-EXT-00007a",
    brDecisionIdentNumber="…"), in order, without repeats. Text (an
    objectUse starting "BRDP-S1-00036. …") is not an identifier."""
    if not origin or not rule_xml:
        return []
    text = re.sub(r"<!--[\s\S]*?-->", "", rule_xml)
    found: list[str] = []
    for m in re.finditer(r"\s[\w:.-]+\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", text):
        value = (m.group(1) if m.group(1) is not None else m.group(2)).strip()
        if origin in value and len(value) <= len(origin) + 12 and value not in found:
            found.append(value)
            if len(found) == 5:
                break
    return found


def _renumber_warning(c: dict) -> None:
    """Adds (or removes) the warning that the identifiers inside the rule
    are still the file's, when an EXT or own-prefix identifier of the file
    (BRDP-ENV-00001) is imported under another identifier: another number
    (it was taken in the project), or a new EXT."""
    c["warnings"] = [w for w in c.get("warnings", []) if w.get("code") != "rule_ids_from_file"]
    origin = c.get("origin_identifier")
    classification = c.get("classification")
    if classification == "empty":
        classification = c.get("base_classification")
    if classification not in ("new_ext", "own_prefix") or not (_EXT_RE.match(origin or "") or c.get("own_prefix")):
        return
    if c.get("identifier") and c["identifier"] != origin and c.get("rule_ids"):
        c["warnings"].append(
            {
                "code": "rule_ids_from_file",
                "params": {"identifier": c["identifier"], "origin": origin, "ids": c["rule_ids"]},
                "message": f"Imported as {c['identifier']}; the identifiers inside the rule are still the file's ({', '.join(c['rule_ids'])}).",
            }
        )


def _similarity_text(c: dict) -> str:
    parts = list(c.get("decision_texts") or []) + list(c.get("object_uses") or []) + [c.get("quote") or ""]
    return "\n".join(dict.fromkeys(p for p in parts if p))


async def check_similar(
    project_id: uuid.UUID,
    candidates: list[dict],
    db: AsyncSession,
    transport: httpx.AsyncBaseTransport | None = None,
    on_progress=None,
    user_id: uuid.UUID | None = None,
) -> dict | None:
    """Adds a "similar_to" warning to every new_ext candidate whose origin
    text is at or above MIN_SIMILARITY of an embedded BRDP of the project.
    Returns a file-level warning when the check could not run (HR7), or
    None. No call at all when the project has no embedded BRDP."""
    targets = [c for c in candidates if c["classification"] in ("new_ext", "own_prefix") and _similarity_text(c)]
    if not targets:
        return None
    has_embedded = (
        await db.execute(
            select(BRDP.id).where(BRDP.project_id == project_id, BRDP.embedding.is_not(None), ACTIVE_BRDP_FILTER).limit(1)
        )
    ).first()
    if has_embedded is None:
        return None
    done = 0
    try:
        for start in range(0, len(targets), EMBED_BATCH_SIZE):
            batch = targets[start : start + EMBED_BATCH_SIZE]
            vectors = await compute_embeddings_batch(
                [truncate_for_embedding_input(_similarity_text(c))[0] for c in batch], transport, user_id
            )
            for c, vector in zip(batch, vectors):
                distance = BRDP.embedding.cosine_distance(vector)
                row = (
                    await db.execute(
                        select(BRDP.identifier, distance.label("d"))
                        .where(BRDP.project_id == project_id, BRDP.embedding.is_not(None), ACTIVE_BRDP_FILTER)
                        .order_by(distance)
                        .limit(1)
                    )
                ).first()
                if row is not None and 1 - row.d >= MIN_SIMILARITY:
                    c["warnings"].append(
                        {
                            "code": "similar_to",
                            "params": {"identifier": row.identifier, "similarity": round(1 - row.d, 2)},
                            "message": f"Similar to {row.identifier} ({round(1 - row.d, 2)}).",
                        }
                    )
            done += len(batch)
            if on_progress is not None:
                await on_progress(done)
    except EmbeddingUnavailable as exc:
        return {
            "code": "similarity_unavailable",
            "params": {"reason": str(exc)},
            "message": f"The duplicate check could not run: {exc}",
        }
    return None


# ── Repeated decisions in one free text ───────────────────────────────────

# Two candidates of the same text whose fragments embed at or above this
# cosine similarity are "possibly the same decision" (the same embeddings as
# the "similar to BRDP-…" check). Higher than MIN_SIMILARITY on purpose:
# that one points at a related BRDP of the project, this one unchecks a row,
# and two different decisions of one style guide easily reach 0.5.
REPETITION_SIMILARITY = 0.9


def normalize_title(title: str | None) -> str:
    """A title for comparing: no accents, no case, words only."""
    text = unicodedata.normalize("NFKD", title or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    return " ".join(re.findall(r"\w+", text))


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _mark_repetition(c: dict, first: dict, similarity: float | None) -> None:
    # Named by the identifier the text gave it, else by its title: a new
    # EXT's number is only proposed and may change before the import.
    label = first.get("origin_identifier") or ""
    c["warnings"].append(
        {
            "code": "possible_repetition",
            "params": {"title": first.get("title") or "", "identifier": label, "key": first["key"], "similarity": similarity},
            "message": f"Possible repetition of {label or repr(first.get('title') or first['key'])}.",
        }
    )
    c["repeat_of"] = first["key"]
    c["selected"] = False


async def check_repetitions(
    candidates: list[dict], transport: httpx.AsyncBaseTransport | None = None, user_id: uuid.UUID | None = None
) -> dict | None:
    """Free text (AI Extract 2/2): the same decision written twice in one
    document (a summary repeating a rule in other words) comes back as two
    candidates. Code compares them, in text order: the same title (no
    accents, no case) or fragments embedding at REPETITION_SIMILARITY or
    above make the later one "possible repetition of <the first>", unchecked
    -- never merged or hidden. Returns a file-level warning when the
    embeddings could not run (HR7; the title comparison still did)."""
    firsts: dict[str, dict] = {}
    for c in candidates:
        title = normalize_title(c.get("title"))
        if not title:
            continue
        if title in firsts:
            _mark_repetition(c, firsts[title], None)
        else:
            firsts[title] = c
    targets = [c for c in candidates if not c.get("repeat_of") and _similarity_text(c)]
    if len(targets) < 2:
        return None
    vectors: list[list[float]] = []
    try:
        for start in range(0, len(targets), EMBED_BATCH_SIZE):
            batch = targets[start : start + EMBED_BATCH_SIZE]
            vectors += await compute_embeddings_batch(
                [truncate_for_embedding_input(_similarity_text(c))[0] for c in batch], transport, user_id
            )
    except EmbeddingUnavailable as exc:
        return {
            "code": "repetition_check_unavailable",
            "params": {"reason": str(exc)},
            "message": f"The check for repeated decisions could not compare the fragments: {exc}",
        }
    for i, c in enumerate(targets):
        for j in range(i):
            if targets[j].get("repeat_of"):
                continue
            similarity = _cosine(vectors[i], vectors[j])
            if similarity >= REPETITION_SIMILARITY:
                _mark_repetition(c, targets[j], round(similarity, 2))
                break
    return None


def _manifest(candidates: list[dict]) -> list[dict]:
    """What the job wrote, committed with the rows (see RuleExtractJob.manifest)."""
    return [
        {
            "key": c["key"],
            "identifier": c.get("identifier") or "",
            "origin_identifier": c.get("origin_identifier") or "",
            "classification": c.get("classification") or "",
        }
        for c in candidates
    ]


async def project_brdps_with_rule(job: RuleExtractJob, project: Project, db: AsyncSession) -> tuple[list[dict], list[dict]]:
    """For a rules file: the project's active BRDPs with a rule of its
    format ({identifier, title, rule_state}), and those that no candidate is
    matched with ("Ya existe (igual / cambia)", by its saved classification):
    what the file no longer has. The page filters the first list with the
    classifications it shows, so an unsaved change is counted at once.
    Nothing for a text job; nothing is ever imported or deleted for them."""
    rule_format = STANDARD_TO_RULE_FORMAT.get(project.standard)
    if job.source_kind != "rules" or job.status != "completed" or not rule_format:
        return [], []
    rows = (await db.execute(select(RuleExtractCandidate.data).where(RuleExtractCandidate.job_id == job.id))).scalars().all()
    matched = {d.get("identifier") for d in rows if d.get("classification") in ("same", "changed") and d.get("identifier")}
    # A candidate whose several rules are each the whole rule of a project
    # BRDP (split_brdps) covers those BRDPs, whatever its classification.
    for d in rows:
        matched.update(d.get("split_brdps") or [])
    brdps = (
        await db.execute(
            select(BRDP, RuleApproval)
            .join(RuleApproval, RuleApproval.brdp_id == BRDP.id)
            .where(BRDP.project_id == project.id, ACTIVE_BRDP_FILTER, RuleApproval.format == rule_format)
            .order_by(BRDP.identifier)
        )
    ).all()
    with_rule = [
        {"identifier": b.identifier, "title": b.title, "rule_state": _rule_state(a)} for b, a in brdps if (a.rule_xml or "").strip()
    ]
    return with_rule, [b for b in with_rule if b["identifier"] not in matched]


def missing_from_manifest(job: RuleExtractJob, keys: set[str]) -> list[dict]:
    """The manifest's candidates the server has no row for (should never
    happen; named so the page can say which -- HR7)."""
    return [
        {**m, "classification": "catalog_edition"} if m.get("classification") == RETIRED_MARKED_CLASSIFICATION else m
        for m in (job.manifest or [])
        if m["key"] not in keys
    ]


# ── Job ───────────────────────────────────────────────────────────────────


async def _reap_if_stale(job: RuleExtractJob, db: AsyncSession) -> RuleExtractJob:
    return await reap_if_stale(job, db, "Extraction")


async def get_running_job(project_id: uuid.UUID, db: AsyncSession) -> RuleExtractJob | None:
    job = (
        await db.execute(
            select(RuleExtractJob)
            .where(RuleExtractJob.project_id == project_id, RuleExtractJob.status == "running")
            .order_by(RuleExtractJob.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if job is None:
        return None
    job = await _reap_if_stale(job, db)
    return job if job.status == "running" else None


async def get_most_recent_job(project_id: uuid.UUID, db: AsyncSession) -> RuleExtractJob | None:
    job = (
        await db.execute(
            select(RuleExtractJob).where(RuleExtractJob.project_id == project_id).order_by(RuleExtractJob.started_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    return await _reap_if_stale(job, db) if job is not None else None


async def create_job(project_id: uuid.UUID, user_id: uuid.UUID, filename: str, rf: RulesFile, db: AsyncSession) -> RuleExtractJob:
    """A new file replaces the project's previous extraction: its candidates
    are deleted (the job rows stay, with their result)."""
    old_jobs = select(RuleExtractJob.id).where(RuleExtractJob.project_id == project_id)
    await db.execute(delete(RuleExtractCandidate).where(RuleExtractCandidate.job_id.in_(old_jobs)))
    job = RuleExtractJob(
        project_id=project_id,
        started_by=user_id,
        filename=filename,
        file_format=rf.file_format,
        status="running",
        phase="reading",
        warnings=list(rf.warnings),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def _progress(session: AsyncSession, job_id: uuid.UUID, **fields) -> None:
    job = await session.get(RuleExtractJob, job_id)
    if job is not None:
        for k, v in fields.items():
            setattr(job, k, v)
        await session.commit()


async def run_extract_job(
    job_id: uuid.UUID, project_id: uuid.UUID, rf: RulesFile, transport: httpx.AsyncBaseTransport | None = None
) -> None:
    progress = async_session_factory()
    work = async_session_factory()
    try:
        project = await work.get(Project, project_id)
        # Who started the extraction: the user its embedding calls are
        # recorded under (Protecciones 2a, llm_calls).
        started_by = (await work.get(RuleExtractJob, job_id)).started_by
        candidates, file_warnings = await asyncio.to_thread(build_candidates, rf, STANDARD_ISSUE.get(project.standard))
        await _progress(progress, job_id, phase="classifying", total_items=len(candidates), processed_items=0)
        await classify_candidates(project, candidates, work)
        await _progress(progress, job_id, processed_items=len(candidates))
        similar_targets = sum(1 for c in candidates if c["classification"] in ("new_ext", "own_prefix"))
        await _progress(progress, job_id, phase="similar", total_items=similar_targets, processed_items=0)

        async def on_progress(done):
            await _progress(progress, job_id, processed_items=done)

        similarity_warning = await check_similar(project_id, candidates, work, transport, on_progress, started_by)
        if similarity_warning is not None:
            file_warnings.append(similarity_warning)
        for position, c in enumerate(candidates):
            rule_xml = c.pop("rule_xml")
            work.add(RuleExtractCandidate(job_id=job_id, key=c["key"], position=position, data=c, rule_xml=rule_xml))
        # The manifest goes in the same transaction as the rows.
        (await work.get(RuleExtractJob, job_id)).manifest = _manifest(candidates)
        await work.commit()
        job = await progress.get(RuleExtractJob, job_id)
        job.warnings = (job.warnings or []) + file_warnings
        job.status = "completed"
        job.phase = "done"
        job.total_items = len(candidates)
        job.processed_items = len(candidates)
        job.finished_at = datetime.now(timezone.utc)
        await progress.commit()
    except asyncio.CancelledError:
        await work.rollback()
        await _progress(
            progress, job_id, status="failed", error="Extraction interrupted (server restarted or shut down mid-job)",
            finished_at=datetime.now(timezone.utc),
        )
        raise
    except Exception as exc:  # noqa: BLE001 -- HR7: surface, never swallow
        await work.rollback()
        await _progress(progress, job_id, status="failed", error=str(exc), finished_at=datetime.now(timezone.utc))
    finally:
        await work.close()
        await progress.close()


# ── Free text (AI Extract 2/2) ────────────────────────────────────────────


async def create_text_job(
    project_id: uuid.UUID, user_id: uuid.UUID, filename: str, text: str, word_count: int, db: AsyncSession
) -> RuleExtractJob:
    """A free text replaces the project's previous extraction, like a new
    file. The job waits for the page to find the decisions with the AI
    (status "awaiting_decisions"): the text is stored, so a reload or a
    server restart can ask again."""
    old_jobs = select(RuleExtractJob.id).where(RuleExtractJob.project_id == project_id)
    await db.execute(delete(RuleExtractCandidate).where(RuleExtractCandidate.job_id.in_(old_jobs)))
    job = RuleExtractJob(
        project_id=project_id,
        started_by=user_id,
        filename=filename,
        file_format="text",
        source_kind="text",
        source_text=text,
        word_count=word_count,
        status="awaiting_decisions",
        phase="finding",
        warnings=[],
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def _extracted_quotes(project_id: uuid.UUID, db: AsyncSession) -> dict[str, dict]:
    """Normalized quote → {identifier, file} of the active BRDP an earlier
    free-text extraction created from it (its "extracted_from" event)."""
    existing = await _active_identifiers(project_id, db)
    by_id = {b.id: b for b in existing.values()}
    if not by_id:
        return {}
    rows = (
        await db.execute(
            select(BRDPHistory.brdp_id, BRDPHistory.new_value)
            .where(BRDPHistory.brdp_id.in_(list(by_id)), BRDPHistory.field_name == "extracted_from")
            .order_by(BRDPHistory.changed_at)
        )
    ).all()
    out: dict[str, dict] = {}
    for brdp_id, value in rows:
        try:
            event = json.loads(value)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("quote"):
            out[normalize_ws(event["quote"])] = {"identifier": by_id[brdp_id].identifier, "file": event.get("file") or ""}
    return out


async def classify_text_candidates(project: Project, candidates: list[dict], db: AsyncSession) -> None:
    """classify_candidates, then what is particular to a free text: a quote
    not found in the text is unchecked (its warning is already there), and a
    quote an earlier extraction already imported is unchecked with the BRDP
    it became -- the same text imported twice warns instead of duplicating."""
    await classify_candidates(project, candidates, db)
    imported = await _extracted_quotes(project.id, db)
    for c in candidates:
        if not c.get("quote_found"):
            c["selected"] = False
        earlier = imported.get(normalize_ws(c.get("quote") or ""))
        if earlier and c["classification"] != "same":
            c["warnings"].append(
                {
                    "code": "quote_already_imported",
                    "params": earlier,
                    "message": f"This fragment was already imported as {earlier['identifier']}.",
                }
            )
            c["selected"] = False


async def run_text_extract_job(
    job_id: uuid.UUID, project_id: uuid.UUID, decisions: list[dict], transport: httpx.AsyncBaseTransport | None = None
) -> None:
    """The decisions the AI found (step 1, posted by the page): quotes
    checked and merged by code, classified, duplicate check, stored."""
    progress = async_session_factory()
    work = async_session_factory()
    try:
        project = await work.get(Project, project_id)
        # Who started the extraction: the user its embedding calls are
        # recorded under (Protecciones 2a, llm_calls).
        started_by = (await work.get(RuleExtractJob, job_id)).started_by
        job = await work.get(RuleExtractJob, job_id)
        refused: list[dict] = []
        candidates = build_text_candidates(
            job.source_text or "", decisions, quote_max_chars=get_settings().extract_quote_max_chars, refused=refused
        )
        await _progress(progress, job_id, phase="classifying", total_items=len(candidates), processed_items=0)
        await classify_text_candidates(project, candidates, work)
        await _progress(progress, job_id, processed_items=len(candidates))
        similar_targets = sum(1 for c in candidates if c["classification"] in ("new_ext", "own_prefix"))
        await _progress(progress, job_id, phase="similar", total_items=similar_targets, processed_items=0)

        async def on_progress(done):
            await _progress(progress, job_id, processed_items=done)

        file_warnings = []
        if refused:
            file_warnings.append(
                {
                    "code": "quotes_too_long",
                    "params": {"titles": [r["title"] for r in refused], "max": refused[0]["max"]},
                    "message": f"{len(refused)} decision(s) left out: their quote is over {refused[0]['max']} characters "
                    f"({', '.join(r['title'] or '—' for r in refused)}).",
                }
            )
        repetition_warning = await check_repetitions(candidates, transport, started_by)
        if repetition_warning is not None:
            file_warnings.append(repetition_warning)
        similarity_warning = await check_similar(project_id, candidates, work, transport, on_progress, started_by)
        if similarity_warning is not None:
            file_warnings.append(similarity_warning)
        for position, c in enumerate(candidates):
            rule_xml = c.pop("rule_xml")
            work.add(RuleExtractCandidate(job_id=job_id, key=c["key"], position=position, data=c, rule_xml=rule_xml))
        # The manifest goes in the same transaction as the rows.
        (await work.get(RuleExtractJob, job_id)).manifest = _manifest(candidates)
        await work.commit()
        job = await progress.get(RuleExtractJob, job_id)
        job.warnings = (job.warnings or []) + file_warnings
        job.status = "completed"
        job.phase = "done"
        job.total_items = len(candidates)
        job.processed_items = len(candidates)
        job.finished_at = datetime.now(timezone.utc)
        await progress.commit()
    except asyncio.CancelledError:
        await work.rollback()
        await _progress(
            progress, job_id, status="failed", error="Extraction interrupted (server restarted or shut down mid-job)",
            finished_at=datetime.now(timezone.utc),
        )
        raise
    except Exception as exc:  # noqa: BLE001 -- HR7: surface, never swallow
        await work.rollback()
        await _progress(progress, job_id, status="failed", error=str(exc), finished_at=datetime.now(timezone.utc))
    finally:
        await work.close()
        await progress.close()


# ── Candidates out / edits ────────────────────────────────────────────────


def retire_marked_classification(data: dict) -> dict:
    """A candidate saved before the "marked" option was retired, read as
    today's: "catalog_edition" with the original identifier, without the
    retired option. Anything else as it is (the same dict)."""
    if not isinstance(data, dict):
        return data
    retired = RETIRED_MARKED_CLASSIFICATION
    options = data.get("options") or []
    identifiers = data.get("option_identifiers") or {}
    if data.get("classification") != retired and retired not in options and retired not in identifiers:
        return data
    out = dict(data)
    out["options"] = [o for o in options if o != retired]
    identifiers = {k: v for k, v in identifiers.items() if k != retired}
    identifiers.setdefault("catalog_edition", out.get("origin_identifier"))
    out["option_identifiers"] = identifiers
    if out.get("classification") == retired:
        out["classification"] = "catalog_edition"
        out["identifier"] = identifiers.get("catalog_edition") or out.get("origin_identifier")
    _renumber_warning(out)
    return out


def candidate_out(row: RuleExtractCandidate) -> dict:
    """The candidate for the review table. The full rule (and the stored one
    of an existing BRDP, for the diff) only up to BIG_CANDIDATE_RULES rules;
    beyond that the table shows the count and the first rules."""
    data = retire_marked_classification(dict(row.data))
    big = data.get("rule_count", 0) > BIG_CANDIDATE_RULES
    data["rule_xml"] = None if big else row.rule_xml
    if big:
        data["existing_rule_xml"] = None
    data["big"] = big
    data["too_long"] = too_long_fields(data)
    return data


EDITABLE_FIELDS = ("classification", "title", "definition", "proposal", "draft_status", "selected")
DRAFT_STATUSES = ("pending", "drafted", "failed", "manual", "not_needed")


def apply_edit(data: dict, edit: dict, new_ext_identifier=None) -> dict:
    """Validated update of one candidate's editable fields. Raises
    ValueError with the reason. A new classification sets the texts again
    (set_texts) and the identifier it would be imported with: the one of
    that option, or, the first time it becomes a new EXT, the next free
    number (new_ext_identifier(), from the route). A text saved with
    draft_status "drafted" is the AI's, any other text edit is by hand.
    The AI never overwrites a text written by hand (a batch that comes back
    after the user edited one of its rows). After a hand edit the status is
    worked out from the texts: "manual" once every field the AI writes has
    text, otherwise it stays "pending" / "failed" (a failed row with only
    one of its texts written still blocks the import)."""
    out = dict(retire_marked_classification(data))
    by_ai = edit.get("draft_status") == "drafted"
    by_hand = False
    for field in EDITABLE_FIELDS:
        if field not in edit or edit[field] is None:
            continue
        value = edit[field]
        if field == "classification":
            if value == RETIRED_MARKED_CLASSIFICATION:
                raise ValueError(
                    f"{out['key']}: classification {value!r} was retired: import it as 'catalog_edition' (the original "
                    "identifier; the edition label shows which catalog it comes from) or as 'new_ext'"
                )
            if value not in out.get("options", []):
                raise ValueError(f"{out['key']}: classification {value!r} is not possible for this candidate")
            if value != out.get("classification"):
                out["classification"] = value
                identifiers = dict(out.get("option_identifiers") or {})
                target = out.get("base_classification") if value == "empty" else value
                if target not in identifiers and target == "new_ext" and new_ext_identifier is not None:
                    identifiers["new_ext"] = new_ext_identifier()
                if target not in identifiers and target == "own_prefix" and new_ext_identifier is not None and out.get("own_prefix"):
                    # The origin's number is taken: the next free one with
                    # its prefix (or the origin itself, when it is free).
                    identifiers["own_prefix"] = new_ext_identifier(out["own_prefix"], out.get("origin_identifier"))
                out["option_identifiers"] = identifiers
                if identifiers.get(target):
                    out["identifier"] = identifiers[target]
                _renumber_warning(out)
                set_texts(out, keep_written=True)
            continue
        if field in TEXT_FIELDS:
            if not isinstance(value, str):
                raise ValueError(f"{out['key']}: {field} must be text")
            sources = dict(out.get("text_sources") or {})
            if by_ai and sources.get(field) == "manual" and (out.get(field) or "").strip():
                continue
            if value != out.get(field):
                sources[field] = "ai" if by_ai else "manual"
                by_hand = by_hand or not by_ai
            out["text_sources"] = sources
        elif field == "draft_status":
            if value not in DRAFT_STATUSES:
                raise ValueError(f"{out['key']}: unknown draft status {value!r}")
            if value == "manual":
                continue  # worked out below from the texts
            if value == "failed" and text_state(out) == "complete":
                continue  # a failed batch never undoes texts already there
        elif field == "selected":
            value = bool(value)
        elif not isinstance(value, str):
            raise ValueError(f"{out['key']}: {field} must be text")
        out[field] = value
    if by_hand or edit.get("draft_status") == "manual":
        state = text_state(out)
        if state == "complete":
            if out.get("draft_status") != "not_needed":
                out["draft_status"] = "manual"
        elif out.get("draft_status") not in ("failed",):
            out["draft_status"] = "pending"
    return out


async def next_ext_allocator(job: RuleExtractJob, db: AsyncSession):
    """A function giving, on each call, the next free number with a prefix
    (EXT by default; ENV for "Keep ENV") for a reclassified candidate: after
    the project's numbers and every number the extraction already uses (the
    file's and the ones proposed to its candidates), per prefix. With
    preferred (the candidate's own origin), that identifier when it is free:
    not in the project and not proposed to another candidate."""
    existing = await _active_identifiers(job.project_id, db)
    rows = (await db.execute(select(RuleExtractCandidate.data).where(RuleExtractCandidate.job_id == job.id))).scalars().all()
    used = list(existing)
    proposed: set[str] = set()
    for data in rows:
        used.append(data.get("origin_identifier") or "")
        used.extend((data.get("option_identifiers") or {}).values())
        proposed.update(v for v in (data.get("option_identifiers") or {}).values() if v)
    counters: dict[str, int] = {}

    def allocate(prefix: str = "EXT", preferred: str | None = None) -> str:
        if preferred and preferred.startswith(f"BRDP-{prefix}-") and preferred not in existing and preferred not in proposed:
            proposed.add(preferred)
            return preferred
        if prefix not in counters:
            counters[prefix] = _next_numbers(used, prefix)
        counters[prefix] += 1
        identifier = f"BRDP-{prefix}-{counters[prefix]:05d}"
        proposed.add(identifier)
        return identifier

    return allocate


# ── Import ────────────────────────────────────────────────────────────────


def _history_event(
    filename: str,
    origin: str | None,
    in_force: bool = False,
    catalog_edition: str | None = None,
    standard: str | None = None,
    quote: str | None = None,
    match_by: str | None = None,
) -> str:
    event = {"file": filename, "origin_identifier": origin}
    if match_by:
        # "Regla actualizada desde <fichero> (emparejada por contenido / por
        # parecido)": the rule was found in the project by its content.
        event["match_by"] = match_by
    if quote is not None:
        # Free text: "extraída de <fichero o Texto pegado>", with the quote
        # (file "" = a pasted text, named by the page in its language).
        event["source"] = "text"
        event["quote"] = quote
    if in_force:
        event["in_force"] = True
    if catalog_edition:
        # "catálogo S1000D 4.1, no existe en S1000D 4.2"
        event["catalog_edition"] = catalog_edition
        event["catalog_standard"] = standard
    return json.dumps(event, sort_keys=True, ensure_ascii=False)


IMPORT_AS = ("pending", "in_force")


class ApplyRefused(Exception):
    """The import cannot run as asked; nothing is written. detail is the
    409 body: {code, message, …}."""

    def __init__(self, detail: dict):
        super().__init__(detail["message"])
        self.detail = detail


def _label(c: dict) -> str:
    c = retire_marked_classification(c)
    return c.get("identifier") or c.get("origin_identifier") or c.get("key")


async def apply_job(job: RuleExtractJob, keys: list[str], user: User, db: AsyncSession, import_as: str = "pending") -> dict:
    """Imports the selected candidates in one transaction. Re-checks against
    the project as it is now: an identifier taken meanwhile is omitted with
    its reason, never overwritten.

    New EXT identifiers: the one shown for the candidate (the file's own
    number when it was free, or the next free one) if it is still free now;
    otherwise the next free number after the project's, the file's and the
    ones being imported.

    import_as "pending": Proposal Pending, rule Draft. "in_force" (the file
    is a BREX/Schematron already in use): Proposal Validated and rule
    Verified, but only for the candidates whose rule passes the format
    check; the others stay Pending/Draft and are counted
    (kept_pending). For an existing BRDP ("changed") only the rule changes,
    Verified; its Proposal and Proposal Status are never touched."""
    if import_as not in IMPORT_AS:
        raise ValueError(f"import_as must be one of {IMPORT_AS}")
    text_job = job.source_kind == "text"
    if text_job and import_as != "pending":
        raise ValueError("A free text is never imported as already in force: its BRDPs are created Pending, without a rule")
    in_force = import_as == "in_force"
    project = await db.get(Project, job.project_id)
    rule_format = STANDARD_TO_RULE_FORMAT.get(project.standard)
    keys = list(dict.fromkeys(keys))
    rows = (
        await db.execute(
            select(RuleExtractCandidate)
            .where(RuleExtractCandidate.job_id == job.id, RuleExtractCandidate.key.in_(keys))
            .order_by(RuleExtractCandidate.position)
            .with_for_update()
        )
    ).scalars().all()
    unknown = sorted(set(keys) - {r.key for r in rows})
    if unknown:
        raise ApplyRefused(
            {"code": "unknown_candidates", "keys": unknown, "message": f"Unknown candidates: {', '.join(unknown)}"}
        )
    # Every checked row must have its texts (HR7: a row never reaches the
    # project half-written, and never silently stays out).
    pending = [_label(r.data) for r in rows if text_state(r.data) == "pending"]
    failed = [_label(r.data) for r in rows if text_state(r.data) == "failed"]
    if pending or failed:
        raise ApplyRefused(
            {
                "code": "texts_incomplete",
                "pending": pending,
                "failed": failed,
                "message": f"{len(pending)} checked rows have texts still to write and {len(failed)} have texts that failed: "
                + ", ".join(pending + failed),
            }
        )
    # A text over the BRDP limits is never cut: the row waits until it is
    # shortened (AACF 1, Parts 4-5).
    too_long = [{"identifier": _label(r.data), "fields": too_long_fields(r.data)} for r in rows if too_long_fields(r.data)]
    if too_long:
        raise ApplyRefused(
            {
                "code": "texts_too_long",
                "rows": too_long,
                "message": f"{len(too_long)} checked rows have a text over its limit: "
                + ", ".join(t["identifier"] for t in too_long),
            }
        )
    existing = await _active_identifiers(project.id, db)
    all_data = (await db.execute(select(RuleExtractCandidate.data).where(RuleExtractCandidate.job_id == job.id))).scalars().all()
    file_numbers = [d.get("origin_identifier") or "" for d in all_data] + [d.get("identifier") or "" for d in all_data]
    counters: dict[str, int] = {}
    taken: set[str] = set()
    updated_keys: set[str] = set()
    result = {
        "import_as": import_as, "selected": len(keys), "created": 0, "updated": 0, "omitted": 0, "invalid_rule": 0, "kept_pending": 0,
        "omitted_detail": [], "created_identifiers": [], "updated_identifiers": [], "kept_pending_detail": [],
    }

    def omit(c: dict, reason: str) -> None:
        result["omitted"] += 1
        result["omitted_detail"].append({"key": c["key"], "identifier": _label(c), "origin_identifier": c.get("origin_identifier"), "reason": reason})

    def new_identifier(shown: str | None, prefix: str = "EXT") -> str:
        """The identifier shown for the candidate if it still has the prefix
        and is free; otherwise the next free number with that prefix, after
        the project's, the file's and the ones being imported."""
        if shown and re.match(rf"^BRDP-{re.escape(prefix)}-\d+$", shown) and shown not in existing and shown not in taken:
            return shown
        if prefix not in counters:
            counters[prefix] = max(_next_numbers(existing, prefix), _next_numbers(file_numbers, prefix))
        while True:
            counters[prefix] += 1
            identifier = f"BRDP-{prefix}-{counters[prefix]:05d}"
            if identifier not in existing and identifier not in taken:
                return identifier

    def kept_pending(c: dict, identifier: str) -> None:
        result["kept_pending"] += 1
        result["kept_pending_detail"].append({"key": c["key"], "identifier": identifier})

    now = datetime.now(timezone.utc)
    for row in rows:
        c = retire_marked_classification(row.data)
        classification = c.get("classification")
        origin = c.get("origin_identifier")
        rule_xml = row.rule_xml if row.rule_xml and not c.get("rule_problem") else ""
        if classification in ("same", "empty"):
            omit(c, ("exists" if text_job else "same") if classification == "same" else "no content")
            continue
        verified = in_force and bool(rule_xml) and bool(rule_format)
        if classification == "changed":
            brdp = existing.get(c.get("identifier") or origin)
            if brdp is None:
                omit(c, f"{c.get('identifier') or origin} is no longer in the project")
                continue
            if not rule_xml:
                omit(c, "no rule to import")
                continue
            approval = await db.get(RuleApproval, (brdp.id, rule_format))
            old_state = _rule_state(approval)
            old_xml = approval.rule_xml if approval is not None else ""
            if approval is None:
                approval = RuleApproval(brdp_id=brdp.id, format=rule_format)
                db.add(approval)
            approval.rule_xml = rule_xml
            approval.source = "extracted"
            approval.status = "approved" if verified else "pending_review"
            approval.approved_at = now if verified else None
            record_change(db, brdp.id, user, "rule_status", old_state, "verified" if verified else "draft")
            record_change(db, brdp.id, user, "rule", old_xml, rule_xml)
            record_change(
                db, brdp.id, user, "extracted_from", "", _history_event(job.filename, origin, verified, match_by=c.get("match_by")),
                always=True,
            )
            result["updated"] += 1
            updated_keys.add(c["key"])
            result["updated_identifiers"].append({"key": c["key"], "identifier": brdp.identifier})
            continue
        if classification == "new_ext":
            identifier = new_identifier(c.get("identifier"))
        elif classification == "own_prefix":
            if not c.get("own_prefix"):
                omit(c, "no own prefix")
                continue
            identifier = new_identifier(c.get("identifier"), c["own_prefix"])
        elif classification == "catalog_edition":
            identifier = (c.get("option_identifiers") or {}).get(classification) or c.get("identifier")
            if not identifier or identifier in existing or identifier in taken:
                omit(c, f"{identifier} already exists in the project")
                continue
        else:
            identifier = origin
            if not identifier or identifier in existing or identifier in taken:
                omit(c, f"{identifier} already exists in the project")
                continue
        taken.add(identifier)
        title, definition = c.get("title") or "", c.get("definition") or ""
        edition = c.get("catalog_edition") if classification == "catalog_edition" else None
        if classification in CATALOG_CLASSES:
            entry = (
                await db.execute(
                    select(BRDPCatalog).where(
                        BRDPCatalog.standard == (edition or project.standard), BRDPCatalog.identifier == (origin if edition else identifier)
                    )
                )
            ).scalar_one_or_none()
            if entry is not None:
                title, definition = entry.title, entry.definition
        brdp = BRDP(
            project_id=project.id,
            identifier=identifier,
            title=title,
            definition=definition,
            proposal=c.get("proposal") or "",
            validation="Validated" if verified else "Pending",
        )
        db.add(brdp)
        await db.flush()
        existing[identifier] = brdp
        if rule_xml and rule_format:
            db.add(
                RuleApproval(
                    brdp_id=brdp.id, format=rule_format, rule_xml=rule_xml, source="extracted",
                    status="approved" if verified else "pending_review", approved_at=now if verified else None,
                )
            )
            record_change(db, brdp.id, user, "rule_status", "todo", "verified" if verified else "draft")
            record_change(db, brdp.id, user, "rule", "", rule_xml)
        elif c.get("rule_problem"):
            result["invalid_rule"] += 1
        if in_force and not verified:
            kept_pending(c, identifier)
        record_change(
            db, brdp.id, user, "extracted_from", "",
            _history_event(job.filename, origin, verified, edition, project.standard, c.get("quote") if text_job else None),
            always=True,
        )
        result["created"] += 1
        result["created_identifiers"].append({"key": c["key"], "identifier": identifier})
    # Checked = created + updated + omitted, or nothing is written: a row
    # that went nowhere is an error with its identifier, never a silent loss.
    handled = {d["key"] for d in result["omitted_detail"] + result["created_identifiers"]} | updated_keys
    missing = [_label(r.data) for r in rows if r.key not in handled]
    if missing or result["created"] + result["updated"] + result["omitted"] != len(keys):
        await db.rollback()
        raise ApplyRefused(
            {
                "code": "count_mismatch",
                "missing": missing,
                "message": f"{len(keys)} checked, but {result['created']} created + {result['updated']} updated + "
                f"{result['omitted']} omitted; nothing was imported. Missing: {', '.join(missing) or '-'}",
            }
        )
    job.apply_result = {k: v for k, v in result.items()}
    job.applied_at = datetime.now(timezone.utc)
    await db.commit()
    return result
