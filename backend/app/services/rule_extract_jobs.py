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
                  identifier): the next free EXT number; the original
                  identifier stays as the origin.
  empty           "Sin contenido": only a nonContextRule saying the decision
                  does not exist in this issue / is not to be taken into
                  account. Unchecked; its base classification is kept so it
                  can still be imported.
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
a few thousand inserts. new_ext numbers are assigned again at import time,
against the identifiers active then.
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
from app.services.rule_extract import BIG_CANDIDATE_RULES, STANDARD_ISSUE, RulesFile, build_candidates
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT
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

CLASSIFICATIONS = ("same", "changed", "catalog", "other_spec", "new_ext", "empty")
_DRAFTED_CLASSES = {"new_ext", "catalog", "other_spec"}


def _own_codes(standard: str) -> set[str]:
    return _OWN_CODES["DITA" if standard.startswith("DITA") else "S1000D"]


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

    next_ext = _next_ext_numbers(existing) + 1
    own_spec = "DITA" if project.standard.startswith("DITA") else "S1000D"
    for c in candidates:
        origin = c["origin_identifier"]
        importable_rule = c["rule_xml"] if c["rule_xml"] and not c.get("rule_problem") else ""
        c.update({"title": "", "definition": "", "proposal": "", "draft_status": "pending", "existing_rule_xml": None})
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
                if not importable_rule:
                    c["warnings"].append(
                        {"code": "no_rule_to_import", "params": {}, "message": "There is no rule to import, nothing would change."}
                    )
            c["title"], c["definition"], c["proposal"] = brdp.title, brdp.definition, brdp.proposal
            c["identifier"] = brdp.identifier
            c["draft_status"] = "not_needed"
            options = [base, "new_ext"]
        elif origin and origin in catalog:
            base = "catalog"
            c["identifier"] = origin
            c["title"], c["definition"] = catalog[origin].title, catalog[origin].definition
            options = ["catalog", "new_ext"]
        elif other_specification(origin, project.standard):
            base = "other_spec"
            c["specification"] = other_specification(origin, project.standard)
            c["identifier"] = origin
            options = ["other_spec", "new_ext"]
        else:
            base = "new_ext"
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
        classification = "empty" if c.get("no_content") and base in ("catalog", "new_ext", "other_spec") else base
        if classification == "empty":
            options = ["empty"] + options
        if classification == "new_ext":
            c["identifier"] = f"BRDP-EXT-{next_ext:05d}"
            next_ext += 1
        c["classification"] = classification
        c["options"] = list(dict.fromkeys(options))
        c["selected"] = classification in ("new_ext", "catalog", "other_spec", "changed")
        c["own_specification"] = own_spec


def _similarity_text(c: dict) -> str:
    parts = list(c.get("decision_texts") or []) + list(c.get("object_uses") or [])
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


EDITABLE_FIELDS = ("title", "definition", "proposal", "draft_status", "selected", "classification")
DRAFT_STATUSES = ("pending", "drafted", "failed", "manual", "not_needed")


def apply_edit(data: dict, edit: dict) -> dict:
    """Validated update of one candidate's editable fields. Raises
    ValueError with the reason."""
    out = dict(data)
    for field in EDITABLE_FIELDS:
        if field not in edit or edit[field] is None:
            continue
        value = edit[field]
        if field == "classification":
            if value not in out.get("options", []):
                raise ValueError(f"{out['key']}: classification {value!r} is not possible for this candidate")
        elif field == "draft_status":
            if value not in DRAFT_STATUSES:
                raise ValueError(f"{out['key']}: unknown draft status {value!r}")
        elif field == "selected":
            value = bool(value)
        elif not isinstance(value, str):
            raise ValueError(f"{out['key']}: {field} must be text")
        out[field] = value
    return out


# ── Import ────────────────────────────────────────────────────────────────


def _history_event(filename: str, origin: str | None) -> str:
    return json.dumps({"file": filename, "origin_identifier": origin}, sort_keys=True, ensure_ascii=False)


async def apply_job(job: RuleExtractJob, keys: list[str], user: User, db: AsyncSession) -> dict:
    """Imports the selected candidates in one transaction. Re-checks against
    the project as it is now: an identifier taken meanwhile is omitted with
    its reason, never overwritten; new EXT numbers are assigned now."""
    project = await db.get(Project, job.project_id)
    rule_format = STANDARD_TO_RULE_FORMAT.get(project.standard)
    rows = (
        await db.execute(
            select(RuleExtractCandidate)
            .where(RuleExtractCandidate.job_id == job.id, RuleExtractCandidate.key.in_(keys))
            .order_by(RuleExtractCandidate.position)
        )
    ).scalars().all()
    existing = await _active_identifiers(project.id, db)
    next_ext = _next_ext_numbers(existing) + 1
    result = {"created": 0, "updated": 0, "omitted": 0, "invalid_rule": 0, "omitted_detail": [], "created_identifiers": []}

    def omit(c: dict, reason: str) -> None:
        result["omitted"] += 1
        result["omitted_detail"].append({"key": c["key"], "origin_identifier": c.get("origin_identifier"), "reason": reason})

    for row in rows:
        c = row.data
        classification = c.get("classification")
        origin = c.get("origin_identifier")
        rule_xml = row.rule_xml if row.rule_xml and not c.get("rule_problem") else ""
        if classification in ("same", "empty"):
            omit(c, "same" if classification == "same" else "no content")
            continue
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
            approval.status = "pending_review"
            approval.approved_at = None
            record_change(db, brdp.id, user, "rule_status", old_state, "draft")
            record_change(db, brdp.id, user, "rule", old_xml, rule_xml)
            record_change(db, brdp.id, user, "extracted_from", "", _history_event(job.filename, origin), always=True)
            result["updated"] += 1
            continue
        if classification == "new_ext":
            identifier = f"BRDP-EXT-{next_ext:05d}"
            next_ext += 1
        else:
            identifier = origin
            if not identifier or identifier in existing:
                omit(c, f"{identifier} already exists in the project")
                continue
        title, definition = c.get("title") or "", c.get("definition") or ""
        if classification == "catalog":
            entry = (
                await db.execute(
                    select(BRDPCatalog).where(BRDPCatalog.standard == project.standard, BRDPCatalog.identifier == identifier)
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
            validation="Pending",
        )
        db.add(brdp)
        await db.flush()
        existing[identifier] = brdp
        if rule_xml and rule_format:
            db.add(RuleApproval(brdp_id=brdp.id, format=rule_format, rule_xml=rule_xml, source="extracted", status="pending_review"))
            record_change(db, brdp.id, user, "rule_status", "todo", "draft")
            record_change(db, brdp.id, user, "rule", "", rule_xml)
        elif c.get("rule_problem"):
            result["invalid_rule"] += 1
        record_change(db, brdp.id, user, "extracted_from", "", _history_event(job.filename, origin), always=True)
        result["created"] += 1
        result["created_identifiers"].append({"key": c["key"], "identifier": identifier})
    job.apply_result = {k: v for k, v in result.items()}
    job.applied_at = datetime.now(timezone.utc)
    await db.commit()
    return result


