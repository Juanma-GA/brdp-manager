"""AI Extract (1/2): classification of the candidates, the background job
that reads and classifies a file, and the import of the reviewed ones.

Classification is done by code -- the AI never decides it:
  same / changed  the identifier already exists in the project: the
                  candidate's rule is compared with the stored one, both
                  normalized as in "Comparar dos BRDP" (whitespace of the
                  formatting never counts; XPath keeps the spaces inside its
                  string literals). "same" also when the candidate has no
                  rule to import (nothing would change).
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
import re
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from lxml import etree
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.approvals import _rule_state, _wrap_rule_xml_fragment
from app.api.routes.similar import MIN_SIMILARITY
from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, BRDPHistory, Project, RuleApproval, RuleExtractCandidate, RuleExtractJob, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.services.embeddings import EmbeddingUnavailable, compute_embeddings_batch, truncate_for_embedding_input
from app.services.history import record_change
from app.services.rule_extract import BIG_CANDIDATE_RULES, DEFAULT_RULE_RE, STANDARD_ISSUE, RulesFile, build_candidates
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT
from app.services.text_extract import build_text_candidates, normalize_ws
from app.services.rule_wrappers import unwrap_rule_xml

STALE_JOB_MINUTES = 60
_STALE_JOB_THRESHOLD = timedelta(minutes=STALE_JOB_MINUTES)
EMBED_BATCH_SIZE = 32
_EXT_RE = re.compile(r"^BRDP-EXT-(\d+)$")
_OFFICIAL_RE = re.compile(r"^BRDP-([A-Z])(\d)-\d{5}$")

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

CLASSIFICATIONS = (
    "same", "changed", "catalog", "catalog_edition", "catalog_edition_marked", "other_spec", "default_rule", "new_ext", "empty",
)
# "From catalog (S1000D 4.1)": an identifier of the project's specification
# that is not in its own standard's catalog but is in another edition's
# (the same number is the same decision across editions). Imported with its
# own identifier, or "marked" with the edition (BRDP-S1-00012-4.1).
CATALOG_CLASSES = ("catalog", "catalog_edition", "catalog_edition_marked")
TEXT_FIELDS = ("title", "definition", "proposal")
TEXT_SOURCES = ("project", "catalog", "file", "ai", "manual")


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


_WRITES_TITLE = ("new_ext", "other_spec", "default_rule")


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


def edition_suffix(edition: str) -> str:
    """"S1000D 4.1" → "4.1" (the "marked" identifier is BRDP-S1-00012-4.1)."""
    return edition.split(" ", 1)[1] if " " in edition else edition


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


def _next_ext_numbers(identifiers) -> int:
    highest = 0
    for identifier in identifiers:
        m = _EXT_RE.match(identifier)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest


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
    edition_catalog: dict[str, dict[str, BRDPCatalog]] = {}
    if _edition_version(project.standard) is not None:
        missing = [
            i for i in origin_ids
            if i not in catalog and (m := _OFFICIAL_RE.match(i)) and m.group(1) + m.group(2) in _own_codes(project.standard)
        ]
        if missing:
            rows = (
                await db.execute(
                    select(BRDPCatalog).where(
                        BRDPCatalog.standard.like("S1000D %"),
                        BRDPCatalog.standard != project.standard,
                        BRDPCatalog.identifier.in_(missing),
                    )
                )
            ).scalars().all()
            for r in rows:
                edition_catalog.setdefault(r.identifier, {})[r.standard] = r

    def match(origin):
        if not origin:
            return None
        return existing.get(origin) or extracted.get(origin)

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
    own_spec = "DITA" if project.standard.startswith("DITA") else "S1000D"
    for c in candidates:
        origin = c["origin_identifier"]
        importable_rule = c["rule_xml"] if c["rule_xml"] and not c.get("rule_problem") else ""
        c.update({"title": "", "definition": "", "proposal": "", "draft_status": "pending", "existing_rule_xml": None})
        if origin and origin in catalog:
            c["catalog_texts"] = {"title": catalog[origin].title, "definition": catalog[origin].definition}
        brdp = match(origin)
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
            options = [base, "new_ext"]
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
            c["option_identifiers"] = {"catalog_edition": origin, "catalog_edition_marked": f"{origin}-{edition_suffix(edition)}"}
            c["warnings"].append(
                {
                    "code": "catalog_other_edition",
                    "params": {"identifier": origin, "standard": project.standard, "edition": edition},
                    "message": f"{origin} is not in the {project.standard} catalog; it is in {edition}.",
                }
            )
            options = ["catalog_edition", "catalog_edition_marked", "new_ext"]
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
        else:
            base = "new_ext"
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
        c["base_classification"] = base
        classification = (
            "empty" if c.get("no_content") and base in ("catalog", "catalog_edition", "new_ext", "other_spec", "default_rule") else base
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
        c["selected"] = classification in ("new_ext", "catalog", "other_spec", "changed")
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
    are still the file's, when an EXT identifier of the file is imported
    under another EXT number (it was taken in the project)."""
    c["warnings"] = [w for w in c.get("warnings", []) if w.get("code") != "rule_ids_from_file"]
    origin = c.get("origin_identifier")
    classification = c.get("classification")
    if classification == "empty":
        classification = c.get("base_classification")
    marked = classification == "catalog_edition_marked"
    if not marked and (classification != "new_ext" or not _EXT_RE.match(origin or "")):
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
) -> dict | None:
    """Adds a "similar_to" warning to every new_ext candidate whose origin
    text is at or above MIN_SIMILARITY of an embedded BRDP of the project.
    Returns a file-level warning when the check could not run (HR7), or
    None. No call at all when the project has no embedded BRDP."""
    targets = [c for c in candidates if c["classification"] == "new_ext" and _similarity_text(c)]
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
                [truncate_for_embedding_input(_similarity_text(c))[0] for c in batch], transport
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


# ── Job ───────────────────────────────────────────────────────────────────


async def _reap_if_stale(job: RuleExtractJob, db: AsyncSession) -> RuleExtractJob:
    if job.status == "running" and datetime.now(timezone.utc) - job.started_at > _STALE_JOB_THRESHOLD:
        job.status = "failed"
        job.error = f"Extraction likely interrupted — no progress for over {STALE_JOB_MINUTES} minutes"
        job.finished_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(job)
    return job


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
        candidates, file_warnings = await asyncio.to_thread(build_candidates, rf, STANDARD_ISSUE.get(project.standard))
        await _progress(progress, job_id, phase="classifying", total_items=len(candidates), processed_items=0)
        await classify_candidates(project, candidates, work)
        await _progress(progress, job_id, processed_items=len(candidates))
        similar_targets = sum(1 for c in candidates if c["classification"] == "new_ext")
        await _progress(progress, job_id, phase="similar", total_items=similar_targets, processed_items=0)

        async def on_progress(done):
            await _progress(progress, job_id, processed_items=done)

        similarity_warning = await check_similar(project_id, candidates, work, transport, on_progress)
        if similarity_warning is not None:
            file_warnings.append(similarity_warning)
        for position, c in enumerate(candidates):
            rule_xml = c.pop("rule_xml")
            work.add(RuleExtractCandidate(job_id=job_id, key=c["key"], position=position, data=c, rule_xml=rule_xml))
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
        job = await work.get(RuleExtractJob, job_id)
        candidates = build_text_candidates(job.source_text or "", decisions)
        await _progress(progress, job_id, phase="classifying", total_items=len(candidates), processed_items=0)
        await classify_text_candidates(project, candidates, work)
        await _progress(progress, job_id, processed_items=len(candidates))
        similar_targets = sum(1 for c in candidates if c["classification"] == "new_ext")
        await _progress(progress, job_id, phase="similar", total_items=similar_targets, processed_items=0)

        async def on_progress(done):
            await _progress(progress, job_id, processed_items=done)

        file_warnings = []
        similarity_warning = await check_similar(project_id, candidates, work, transport, on_progress)
        if similarity_warning is not None:
            file_warnings.append(similarity_warning)
        for position, c in enumerate(candidates):
            rule_xml = c.pop("rule_xml")
            work.add(RuleExtractCandidate(job_id=job_id, key=c["key"], position=position, data=c, rule_xml=rule_xml))
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


def candidate_out(row: RuleExtractCandidate) -> dict:
    """The candidate for the review table. The full rule (and the stored one
    of an existing BRDP, for the diff) only up to BIG_CANDIDATE_RULES rules;
    beyond that the table shows the count and the first rules."""
    data = dict(row.data)
    big = data.get("rule_count", 0) > BIG_CANDIDATE_RULES
    data["rule_xml"] = None if big else row.rule_xml
    if big:
        data["existing_rule_xml"] = None
    data["big"] = big
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
    out = dict(data)
    by_ai = edit.get("draft_status") == "drafted"
    by_hand = False
    for field in EDITABLE_FIELDS:
        if field not in edit or edit[field] is None:
            continue
        value = edit[field]
        if field == "classification":
            if value not in out.get("options", []):
                raise ValueError(f"{out['key']}: classification {value!r} is not possible for this candidate")
            if value != out.get("classification"):
                out["classification"] = value
                identifiers = dict(out.get("option_identifiers") or {})
                target = out.get("base_classification") if value == "empty" else value
                if target not in identifiers and target == "new_ext" and new_ext_identifier is not None:
                    identifiers["new_ext"] = new_ext_identifier()
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
    """A function giving, on each call, the next free EXT number for a
    candidate reclassified as a new EXT: after the project's numbers and
    every number the extraction already uses (the file's and the ones
    proposed to its candidates)."""
    existing = await _active_identifiers(job.project_id, db)
    rows = (await db.execute(select(RuleExtractCandidate.data).where(RuleExtractCandidate.job_id == job.id))).scalars().all()
    used = list(existing)
    for data in rows:
        used.append(data.get("origin_identifier") or "")
        used.extend((data.get("option_identifiers") or {}).values())
    counter = [_next_ext_numbers(used)]

    def allocate() -> str:
        counter[0] += 1
        return f"BRDP-EXT-{counter[0]:05d}"

    return allocate


# ── Import ────────────────────────────────────────────────────────────────


def _history_event(
    filename: str,
    origin: str | None,
    in_force: bool = False,
    catalog_edition: str | None = None,
    standard: str | None = None,
    quote: str | None = None,
) -> str:
    event = {"file": filename, "origin_identifier": origin}
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
    existing = await _active_identifiers(project.id, db)
    all_data = (await db.execute(select(RuleExtractCandidate.data).where(RuleExtractCandidate.job_id == job.id))).scalars().all()
    file_numbers = [d.get("origin_identifier") or "" for d in all_data] + [d.get("identifier") or "" for d in all_data]
    next_ext = [max(_next_ext_numbers(existing), _next_ext_numbers(file_numbers))]
    taken: set[str] = set()
    updated_keys: set[str] = set()
    result = {
        "import_as": import_as, "selected": len(keys), "created": 0, "updated": 0, "omitted": 0, "invalid_rule": 0, "kept_pending": 0,
        "omitted_detail": [], "created_identifiers": [], "updated_identifiers": [], "kept_pending_detail": [],
    }

    def omit(c: dict, reason: str) -> None:
        result["omitted"] += 1
        result["omitted_detail"].append({"key": c["key"], "identifier": _label(c), "origin_identifier": c.get("origin_identifier"), "reason": reason})

    def new_ext(shown: str | None) -> str:
        if shown and _EXT_RE.match(shown) and shown not in existing and shown not in taken:
            return shown
        while True:
            next_ext[0] += 1
            identifier = f"BRDP-EXT-{next_ext[0]:05d}"
            if identifier not in existing and identifier not in taken:
                return identifier

    def kept_pending(c: dict, identifier: str) -> None:
        result["kept_pending"] += 1
        result["kept_pending_detail"].append({"key": c["key"], "identifier": identifier})

    now = datetime.now(timezone.utc)
    for row in rows:
        c = row.data
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
            record_change(db, brdp.id, user, "extracted_from", "", _history_event(job.filename, origin, verified), always=True)
            result["updated"] += 1
            updated_keys.add(c["key"])
            result["updated_identifiers"].append({"key": c["key"], "identifier": brdp.identifier})
            continue
        if classification == "new_ext":
            identifier = new_ext(c.get("identifier"))
        elif classification in ("catalog_edition", "catalog_edition_marked"):
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
        edition = c.get("catalog_edition") if classification in ("catalog_edition", "catalog_edition_marked") else None
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
