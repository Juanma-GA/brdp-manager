"""Excel import: row classification (shared by /analyze and /apply) and
the background execution of an Apply job.

Business logic lives here, not in app/api/routes/brdp_import.py (docs
request) -- the route module is now just HTTP plumbing: parse the
request, check for a concurrent job, create the ImportJob row, hand off
to run_import_job() via BackgroundTasks, return the job_id.

Apply moved from a blocking request to a background job so navigating
away, reloading, or closing the tab never resets progress -- the
import_jobs table (Postgres) is the only source of truth for "is this
running", never localStorage/sessionStorage (HR1).

Runs via FastAPI's BackgroundTasks -- confirmed the right mechanism here
over a separate task queue (Celery/RQ): this app has no worker process or
message broker, and BackgroundTasks already executes on the same asyncio
event loop FastAPI serves requests on, correctly interleaving with other
requests as long as this coroutine keeps awaiting real I/O (httpx to
Mistral, asyncpg to Postgres) rather than blocking synchronously -- which
it already does throughout, unchanged from the old synchronous path. The
one adjustment BackgroundTasks requires: the request's own `db:
AsyncSession` dependency is torn down right after the response is sent,
before the background task body runs -- so run_import_job() NEVER reuses
that session, it opens its own via async_session_factory() for the whole
job lifetime.

Two separate sessions per job, not one:
  - `work_session` holds the actual BRDP/RuleApproval/BRDPHistory writes,
    uncommitted until the very end, or rolled back whole on any failure
    -- HR7: a mid-job failure (e.g. Mistral down) must never leave a row
    in an ambiguous partial state, exactly like the old synchronous path
    (one commit for the whole apply, or none).
  - `progress_session` commits the import_jobs row's processed_rows after
    every row, independently of work_session's still-open transaction --
    this is what makes progress visible to a poller in a different
    request/connection while the job is still running. Committing on
    work_session instead would defeat the point above (a partial commit
    of real data on every row instead of an atomic all-or-nothing).

Concurrency: at most one running job per project (docs request: decide
and document, don't leave it undefined). POST /apply checks
get_active_job() first and returns 409 if one is already running --
two imports racing on the same identifiers in the same project is a
correctness hazard (double-create, lost update) a single-writer
constraint sidesteps entirely, and "wait for the current one" is a
better user experience than a confusing interleaved result anyway.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException, status
from lxml import etree
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.approvals import _rule_state, _wrap_rule_xml_fragment, _xml_well_formed_error
from app.api.routes.brdps import _HISTORY_FIELDS, _compute_brdp_embedding
from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, ImportJob, Project, RuleApproval, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.schemas.brdp_import import ImportRowIn, ImportRowResult
from app.services.history import record_change
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT

# The only 3 legal Rule Status values -- exactly the display strings
# RecordsPage/Export to Excel already use (records.rule.states.* in
# en/es), never the internal DB tokens ("pending_review"/"approved").
_VALID_RULE_STATUSES = {"To Do", "Draft", "Verified"}

# Terminal states an import_jobs row can settle into -- "running" is the
# only non-terminal one (get_active_job filters on it).
_TERMINAL_STATUSES = {"completed", "failed"}

# A "running" job older than this is treated as dead, not actually in
# progress -- the cheap fallback for a hard process crash/kill that never
# gets a chance to run any cleanup code (asyncio.CancelledError, caught in
# run_import_job below, already covers a clean interruption like a dev
# --reload restart). Deliberately NOT an active heartbeat (a column
# updated periodically while the job runs) -- decided with the user as
# overkill for how rarely a hard crash actually happens; a generous
# fixed margin is enough, since no real import (even thousands of
# Validated rows, each a Mistral embedding call) plausibly runs this long.
# Named here, not a bare literal at each call site, so it's a single,
# obvious place to adjust.
STALE_JOB_MINUTES = 60
_STALE_JOB_THRESHOLD = timedelta(minutes=STALE_JOB_MINUTES)


async def _reap_if_stale(job: ImportJob, db: AsyncSession) -> ImportJob:
    """A `running` job whose started_at is older than _STALE_JOB_THRESHOLD
    is marked `failed` right here, in the same read that noticed it --
    both get_running_job (the 409 check) and get_most_recent_job (what the
    UI polls) call this, so neither one goes on trusting a `running` status
    that can no longer be true, and the UI stops showing it as still alive
    the moment anyone next asks, not only after some later Apply attempt
    happens to trigger the fix.
    """
    if job.status == "running" and datetime.now(timezone.utc) - job.started_at > _STALE_JOB_THRESHOLD:
        job.status = "failed"
        job.error = f"Import likely interrupted — no progress for over {STALE_JOB_MINUTES} minutes"
        job.finished_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(job)
    return job


def _blank(text: str | None) -> bool:
    return text is None or text.strip() == ""


def _elements_structurally_equal(a: etree._Element, b: etree._Element) -> bool:
    """Tag, attributes, and non-blank text/tail compared exactly -- only
    pure-whitespace text/tail (indentation/line breaks between sibling
    elements) is ignored. See _rule_xml_structurally_equal for why.
    """
    if a.tag != b.tag:
        return False
    if dict(a.attrib) != dict(b.attrib):
        return False
    if _blank(a.text) != _blank(b.text) or (not _blank(a.text) and a.text != b.text):
        return False
    if _blank(a.tail) != _blank(b.tail) or (not _blank(a.tail) and a.tail != b.tail):
        return False
    children_a, children_b = list(a), list(b)
    if len(children_a) != len(children_b):
        return False
    return all(_elements_structurally_equal(ca, cb) for ca, cb in zip(children_a, children_b))


def _rule_xml_structurally_equal(a: str, b: str) -> bool:
    """Real structural comparison of two Rule XML fragments -- used to
    decide whether an incoming Rule is a REAL change from what's already
    stored (rule_override below), not the naive `re.sub(r"\\s+", " ", ...)`
    this replaces: a global whitespace collapse over the raw string made
    two DIFFERENT attribute values compare as equal (e.g.
    val1="...SISTEMAS DE  SISTEMAS..." vs "...SISTEMAS DE SISTEMAS...",
    the real BRDP-EXT-01516/02609 case this was reimporting), because it
    collapsed the significant double space inside the attribute value
    right along with the insignificant indentation between tags.

    Attribute values and element text content are therefore NEVER
    normalized here -- compared byte-for-byte via _elements_structurally_equal.
    The only thing ignored is text/tail that is PURELY whitespace, which is
    exactly the indentation/line breaks an LLM or a human editor introduces
    between sibling elements and carries no real meaning.

    Fragments are wrapped via _wrap_rule_xml_fragment (app/api/routes/
    approvals.py) -- the same tolerant multi-root handling AND dynamic
    namespace-prefix declaration _xml_well_formed_error uses, needed here
    too: a native Schematron rule_xml (sch:pattern/sch:rule/sch:assert)
    only declares xmlns:sch on the final assembled document, not on the
    stored fragment, so comparing two such fragments needs the same dummy
    binding to parse at all. Both sides already passed well-formedness
    checks before reaching here in practice; if parsing somehow still
    failed, that can't be evidence of equality, so it's treated as
    "different" rather than raised.
    """
    try:
        root_a = etree.fromstring(_wrap_rule_xml_fragment(a).encode("utf-8"))
        root_b = etree.fromstring(_wrap_rule_xml_fragment(b).encode("utf-8"))
    except etree.XMLSyntaxError:
        return False
    return _elements_structurally_equal(root_a, root_b)


async def _get_owned_project(project_id: uuid.UUID, db: AsyncSession) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


def _classify_row(
    row: ImportRowIn,
    rule_format: str | None,
    existing_brdp: BRDP | None,
    existing_approval: RuleApproval | None,
    catalog_entry: BRDPCatalog | None,
) -> ImportRowResult:
    """Pure function, no DB access -- every business rule from the docs
    request lives here, in the exact priority order confirmed with the
    user: identifier present -> Rule Status is one of the 3 legal values
    -> (no rule format at all for this standard) -> well-formed XML (a
    hard technical defect, checked before any Rule/Rule Status mismatch
    logic) -> Rule/Rule Status combination -> finally, the one case that
    is a real DB conflict rather than a validation rejection. A catalog
    match (docs request) is layered on top at the very end, as a WARNING
    rather than another rejection branch: it only ever matters for a row
    that's going to be applied at all (ok or conflict), never for one
    that's already rejected for an unrelated reason. The warning itself
    only fires when the file's Title/Definition actually differ from the
    catalog's -- the substitution in run_import_job happens
    unconditionally on any match, but a match that already agrees with
    the file has nothing perceptible to warn about.
    """
    identifier = row.identifier.strip()
    if not identifier:
        return ImportRowResult(row_number=row.row_number, identifier="", outcome="rejected", reason="Missing identifier")

    rule_status = row.rule_status
    rule_xml = row.rule.strip()

    if rule_status not in _VALID_RULE_STATUSES:
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="rejected",
            reason=f"Invalid Rule Status value {row.rule_status!r} -- must be exactly 'To Do', 'Draft', or 'Verified'",
        )

    # This project's standard has no rule-approval format at all (S1000D
    # 5.0/6.0 -- no generation engine exists for them yet; every other
    # standard, DITA 1.3 included since it got its own SCH-DITA format,
    # has one) -- there is nothing a Rule/Rule Status column could
    # legitimately claim, so any row that tries is rejected rather than
    # silently ignored.
    if rule_format is None and (rule_xml or rule_status != "To Do"):
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="rejected",
            reason="This project's standard has no rule format -- Rule must be empty and Rule Status must be 'To Do'",
        )

    if rule_xml:
        xml_error = _xml_well_formed_error(rule_xml)
        if xml_error is not None:
            return ImportRowResult(
                row_number=row.row_number,
                identifier=identifier,
                outcome="rejected",
                reason=f"Rule is not well-formed XML: {xml_error}",
            )
        if rule_status == "To Do":
            return ImportRowResult(
                row_number=row.row_number,
                identifier=identifier,
                outcome="rejected",
                reason="Rule has XML content but Rule Status is 'To Do' (claims no rule exists, but one does)",
            )
    elif rule_status in ("Draft", "Verified"):
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="rejected",
            reason=f"Rule Status is {rule_status!r} but Rule is empty (claims a rule that doesn't exist)",
        )

    action = "update" if existing_brdp is not None else "create"

    # Same title/definition resolution run_import_job actually writes
    # (catalog match wins unconditionally, see catalog_override below) --
    # needed here to compare against what's already stored, so "unchanged"
    # means identical to what would actually be written, not to the raw
    # file's own Title/Definition columns.
    resolved_title = catalog_entry.title if catalog_entry is not None else row.title
    resolved_definition = catalog_entry.definition if catalog_entry is not None else row.definition
    # True only for an existing BRDP whose four core fields already equal
    # the value this row would write -- see ImportRowResult.unchanged's own
    # docstring. Independent of the Rule column entirely (catalog_override/
    # rule_override below are separate, unrelated checks).
    unchanged = existing_brdp is not None and (
        existing_brdp.title == resolved_title
        and existing_brdp.definition == resolved_definition
        and existing_brdp.proposal == row.proposal
        and existing_brdp.validation == row.proposal_status
    )

    # The Title/Definition substitution itself (run_import_job below)
    # always happens on a catalog match, unconditionally. This flag is
    # only about whether to SURFACE that as a warning: correction (docs
    # request) -- a match whose Title/Definition already equal the
    # catalog's has nothing perceptible to warn about, even though the
    # same values get written again.
    catalog_override = catalog_entry is not None and (
        row.title != catalog_entry.title or row.definition != catalog_entry.definition
    )

    # The one combination that is a real DB conflict, not a validation
    # failure: the file says "no rule" but this BRDP already has a real
    # (non-todo) one in Postgres. A brand-new BRDP (existing_approval is
    # always None) can never hit this -- there is nothing yet to conflict
    # with.
    if rule_status == "To Do" and not rule_xml and existing_approval is not None:
        # _rule_state can only return "draft"/"verified" here -- "todo" is
        # exactly the absence of a row, and existing_approval is not None.
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="conflict",
            action=action,
            existing_rule_status=_rule_state(existing_approval).capitalize(),
            catalog_override=catalog_override,
            unchanged=unchanged,
        )

    # Same idea as catalog_override above, for the Rule column: warn when
    # this update is about to REPLACE an existing Rule with different
    # content, rather than silently overwriting it. Only fires for a real
    # update of a BRDP that already has an approval row for this format,
    # bringing a non-empty Rule that actually differs -- structurally
    # (see _rule_xml_structurally_equal above), not byte-for-byte, so
    # irrelevant formatting differences (indentation, line breaks) between
    # the file's Rule and what's stored don't cry wolf. A brand-new BRDP
    # (action == "create") never reaches here with existing_approval set,
    # so it can never trigger this on its own.
    rule_override = (
        action == "update"
        and existing_approval is not None
        and bool(rule_xml)
        and not _rule_xml_structurally_equal(existing_approval.rule_xml, rule_xml)
    )

    return ImportRowResult(
        row_number=row.row_number,
        identifier=identifier,
        outcome="ok",
        action=action,
        catalog_override=catalog_override,
        rule_override=rule_override,
        unchanged=unchanged,
    )


async def _load_existing(
    project_id: uuid.UUID, rows: list[ImportRowIn], rule_format: str | None, db: AsyncSession
) -> tuple[dict[str, BRDP], dict[uuid.UUID, RuleApproval]]:
    """Two batch queries total, regardless of how many rows the file has --
    never N+1 per row.
    """
    identifiers = [r.identifier.strip() for r in rows if r.identifier.strip()]
    existing_brdps: dict[str, BRDP] = {}
    if identifiers:
        # ACTIVE_BRDP_FILTER: a trashed BRDP's identifier must read as free
        # (docs request's soft-delete round) -- without this, importing a
        # row whose identifier matches a Papelera entry would silently
        # resurrect/edit that trashed row instead of creating a brand-new
        # active one, which is what the partial unique index actually
        # allows.
        result = await db.execute(
            select(BRDP).where(
                BRDP.project_id == project_id, BRDP.identifier.in_(identifiers), ACTIVE_BRDP_FILTER
            )
        )
        for b in result.scalars().all():
            existing_brdps[b.identifier] = b

    existing_approvals: dict[uuid.UUID, RuleApproval] = {}
    if rule_format and existing_brdps:
        brdp_ids = [b.id for b in existing_brdps.values()]
        result = await db.execute(
            select(RuleApproval).where(RuleApproval.brdp_id.in_(brdp_ids), RuleApproval.format == rule_format)
        )
        for a in result.scalars().all():
            existing_approvals[a.brdp_id] = a

    return existing_brdps, existing_approvals


async def _load_catalog(
    rows: list[ImportRowIn], catalog_standard: str, db: AsyncSession
) -> dict[str, BRDPCatalog]:
    """One batch query, exactly like _load_existing above -- never N+1."""
    identifiers = [r.identifier.strip() for r in rows if r.identifier.strip()]
    catalog_by_identifier: dict[str, BRDPCatalog] = {}
    if identifiers:
        result = await db.execute(
            select(BRDPCatalog).where(
                BRDPCatalog.standard == catalog_standard, BRDPCatalog.identifier.in_(identifiers)
            )
        )
        for entry in result.scalars().all():
            catalog_by_identifier[entry.identifier] = entry
    return catalog_by_identifier


async def analyze_rows(
    project_id: uuid.UUID, rows: list[ImportRowIn], db: AsyncSession
) -> tuple[Project, str | None, list[ImportRowResult], dict[str, BRDP], dict[uuid.UUID, RuleApproval], dict[str, BRDPCatalog]]:
    project = await _get_owned_project(project_id, db)
    rule_format = STANDARD_TO_RULE_FORMAT.get(project.standard)
    existing_brdps, existing_approvals = await _load_existing(project_id, rows, rule_format, db)
    catalog_by_identifier = await _load_catalog(rows, project.standard, db)

    results = []
    for row in rows:
        identifier = row.identifier.strip()
        existing_brdp = existing_brdps.get(identifier)
        existing_approval = existing_approvals.get(existing_brdp.id) if existing_brdp is not None else None
        catalog_entry = catalog_by_identifier.get(identifier)
        results.append(_classify_row(row, rule_format, existing_brdp, existing_approval, catalog_entry))
    return project, rule_format, results, existing_brdps, existing_approvals, catalog_by_identifier


def count_validated_rows(rows: list[ImportRowIn]) -> int:
    """Rows claiming Proposal Status "Validated" -- the ones that will
    trigger a real Mistral embedding call each once applied (matching the
    same literal "Validated" comparison run_import_job/brdps.py use, not
    the frontend's case-insensitive convenience check).
    """
    return sum(1 for r in rows if r.proposal_status == "Validated")


async def get_running_job(project_id: uuid.UUID, db: AsyncSession) -> ImportJob | None:
    """Used only for the single-writer-per-project concurrency check
    (POST /apply -> 409 if this returns something) -- deliberately
    stricter than get_most_recent_job below, which a finished job also
    satisfies. A `running` row older than _STALE_JOB_THRESHOLD is reaped
    (see _reap_if_stale) and no longer counts as running here -- a new
    Apply is allowed through instead of blocking on a job that's
    practically certain to be dead.
    """
    result = await db.execute(
        select(ImportJob)
        .where(ImportJob.project_id == project_id, ImportJob.status == "running")
        .order_by(ImportJob.started_at.desc())
        .limit(1)
    )
    job = result.scalar_one_or_none()
    if job is None:
        return None
    job = await _reap_if_stale(job, db)
    return job if job.status == "running" else None


async def get_most_recent_job(project_id: uuid.UUID, db: AsyncSession) -> ImportJob | None:
    """Backs GET /status/active -- the job any page should show on mount
    (docs request: recover a running job across navigation/reload/closing
    the tab, but ALSO the last job's final result if it finished while the
    tab was closed, rather than silently forgetting it happened). Returns
    the single most recent job for the project regardless of status, not
    just a running one -- the caller (ProjectConfigPage/Sidebar) decides
    what to render for each status; the Sidebar badge specifically only
    ever renders for status="running", so a long-finished job never
    lingers as a stale badge. Also runs the same staleness reap as
    get_running_job (see _reap_if_stale) -- a caller polling this endpoint
    sees a stuck job flip to `failed` on its own, without needing some
    other request to have triggered get_running_job first.
    """
    result = await db.execute(
        select(ImportJob).where(ImportJob.project_id == project_id).order_by(ImportJob.started_at.desc()).limit(1)
    )
    job = result.scalar_one_or_none()
    if job is None:
        return None
    return await _reap_if_stale(job, db)


async def create_job(
    project_id: uuid.UUID, started_by: uuid.UUID, rows: list[ImportRowIn], db: AsyncSession
) -> ImportJob:
    job = ImportJob(
        project_id=project_id,
        started_by=started_by,
        status="running",
        total_rows=len(rows),
        validated_rows_total=count_validated_rows(rows),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def _set_progress(progress_session: AsyncSession, job_id: uuid.UUID, processed_rows: int) -> None:
    job = await progress_session.get(ImportJob, job_id)
    if job is not None:
        job.processed_rows = processed_rows
        await progress_session.commit()


async def _finish_job(
    progress_session: AsyncSession,
    job_id: uuid.UUID,
    *,
    status_value: str,
    error: str | None = None,
    result: dict | None = None,
) -> None:
    job = await progress_session.get(ImportJob, job_id)
    if job is None:
        return
    job.status = status_value
    job.error = error
    job.result = result
    job.finished_at = datetime.now(timezone.utc)
    await progress_session.commit()


async def run_import_job(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    rows: list[ImportRowIn],
    conflict_resolution: str,
    started_by: uuid.UUID,
    transport: httpx.AsyncBaseTransport | None,
) -> None:
    """The actual Apply work, run in the background after POST /apply has
    already returned job_id to the caller. See module docstring for the
    two-session design and why BackgroundTasks is the right tool here.
    """
    progress_session = async_session_factory()
    work_session = async_session_factory()
    try:
        editor = await work_session.get(User, started_by)
        _project, rule_format, results, existing_brdps, existing_approvals, catalog_by_identifier = await analyze_rows(
            project_id, rows, work_session
        )
        rows_by_number = {r.row_number: r for r in rows}

        created = updated = rejected = conflicts_kept = conflicts_cleared = unchanged = 0
        processed = 0

        for result in results:
            if result.outcome == "rejected":
                rejected += 1
                processed += 1
                await _set_progress(progress_session, job_id, processed)
                continue

            row = rows_by_number[result.row_number]
            identifier = row.identifier.strip()
            brdp = existing_brdps.get(identifier)
            # Catalog match (docs request): Title/Definition come from the
            # catalog, never the file, for this identifier -- Proposal/
            # Proposal Status/Rule/Rule Status are untouched by the
            # catalog and stay exactly what the row says.
            catalog_entry = catalog_by_identifier.get(identifier)
            title = catalog_entry.title if catalog_entry is not None else row.title
            definition = catalog_entry.definition if catalog_entry is not None else row.definition

            if brdp is None:
                brdp = BRDP(
                    project_id=project_id,
                    identifier=identifier,
                    title=title,
                    definition=definition,
                    proposal=row.proposal,
                    validation=row.proposal_status,
                )
                work_session.add(brdp)
                # id is a Python-side default (uuid.uuid4) -- SQLAlchemy
                # only applies it at flush, so a rule_approvals row below
                # (which needs a real brdp_id) requires flushing first.
                await work_session.flush()
                if brdp.validation == "Validated":
                    brdp.embedding = await _compute_brdp_embedding(brdp, transport)
                created += 1
                outcome = "created"
            elif result.unchanged:
                # Title/definition/proposal/validation are already exactly
                # what this row would write (see ImportRowResult.unchanged
                # and _classify_row's own computation of the same four-field
                # comparison, reused here rather than duplicated) -- no
                # field reassignment, no brdp_history entry, and critically
                # no _compute_brdp_embedding call. This is the actual fix
                # for a real, confirmed problem: reimporting an unchanged
                # file with many Validated rows used to recompute a real
                # Mistral embedding for every single one regardless of
                # whether anything had changed (~70 minutes wasted on a
                # several-thousand-row project). Entirely independent of
                # the Rule column -- rule_override/conflict handling below
                # still runs exactly as before for this same row.
                unchanged += 1
                outcome = "unchanged"
            else:
                was_validated = brdp.validation == "Validated"
                old_values = {field: getattr(brdp, field) for field in _HISTORY_FIELDS}
                brdp.title = title
                brdp.definition = definition
                brdp.proposal = row.proposal
                brdp.validation = row.proposal_status
                for field, history_name in _HISTORY_FIELDS.items():
                    record_change(work_session, brdp.id, editor, history_name, old_values[field], getattr(brdp, field))
                if brdp.validation == "Validated":
                    brdp.embedding = await _compute_brdp_embedding(brdp, transport)
                elif was_validated:
                    brdp.embedding = None
                updated += 1
                outcome = "updated"

            if result.outcome == "conflict":
                existing_approval = existing_approvals.get(brdp.id)
                if conflict_resolution == "keep":
                    conflicts_kept += 1
                    # Explicitly leave the existing rule_approvals row alone.
                else:
                    if existing_approval is not None:
                        old_state = _rule_state(existing_approval)
                        await work_session.delete(existing_approval)
                        record_change(work_session, brdp.id, editor, "rule_status", old_state, "todo")
                    conflicts_cleared += 1
            elif row.rule.strip():
                # A genuine ok row that asserts a real rule (Draft or
                # Verified, XML already confirmed well-formed by
                # _classify_row above) -- upsert rule_approvals exactly
                # like propose_approval does for the manual-editor path,
                # "manual" source since this is human-authored/reviewed
                # content arriving via Excel, never LLM output.
                new_status = "approved" if row.rule_status == "Verified" else "pending_review"
                existing_approval = existing_approvals.get(brdp.id)
                old_state = _rule_state(existing_approval)
                if existing_approval is None:
                    existing_approval = RuleApproval(brdp_id=brdp.id, format=rule_format)
                    work_session.add(existing_approval)
                existing_approval.rule_xml = row.rule
                existing_approval.source = "manual"
                existing_approval.status = new_status
                existing_approval.approved_at = datetime.now(timezone.utc) if new_status == "approved" else None
                record_change(work_session, brdp.id, editor, "rule_status", old_state, _rule_state(existing_approval))
            # else: rule empty + To Do + no pre-existing approval (conflict
            # already covers the "had one, file clears it" case above) --
            # genuinely nothing to do for the rule.

            processed += 1
            await _set_progress(progress_session, job_id, processed)

        await work_session.commit()
        await _finish_job(
            progress_session,
            job_id,
            status_value="completed",
            result={
                "created": created,
                "updated": updated,
                "rejected": rejected,
                "conflicts_kept": conflicts_kept,
                "conflicts_cleared": conflicts_cleared,
                "unchanged": unchanged,
            },
        )
    except asyncio.CancelledError:
        # Confirmed real (not hypothetical): a dev-server --reload restart
        # mid-job cancels this coroutine, and CancelledError has inherited
        # from BaseException (not Exception) since Python 3.8 -- the
        # except Exception below never sees it, so without this the job
        # row is abandoned "running" forever (get_running_job then blocks
        # every future Apply on this project with a 409, indefinitely).
        # Same rollback/finish as a real failure, then re-raise -- standard
        # asyncio cancellation hygiene, never swallow a CancelledError.
        await work_session.rollback()
        await _finish_job(
            progress_session,
            job_id,
            status_value="failed",
            error="Import interrupted (server restarted or shut down mid-job)",
        )
        raise
    except Exception as exc:  # noqa: BLE001 -- HR7: surface, never swallow
        await work_session.rollback()
        await _finish_job(progress_session, job_id, status_value="failed", error=str(exc))
    finally:
        await work_session.close()
        await progress_session.close()
