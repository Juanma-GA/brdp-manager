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

import uuid
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.approvals import _rule_state, _xml_well_formed_error
from app.api.routes.brdp_catalog import _resolve_catalog_standard
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

    # This project's standard has no rule-approval format at all (e.g.
    # Schematron 1.0 -- DITA) -- there is nothing a Rule/Rule Status
    # column could legitimately claim, so any row that tries is rejected
    # rather than silently ignored.
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
        )

    return ImportRowResult(row_number=row.row_number, identifier=identifier, outcome="ok", action=action, catalog_override=catalog_override)


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
    """One batch query, exactly like _load_existing above -- never N+1.
    catalog_standard is already resolved (see _resolve_catalog_standard):
    "Schematron 1.0 -- S1000D" shares its catalog with "BREX -- S1000D
    3.0.1" rather than having its own, so the lookup has to go through the
    same alias Create Project's own catalog count/seed already uses, or a
    Schematron project would never match anything.
    """
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
    catalog_by_identifier = await _load_catalog(rows, _resolve_catalog_standard(project.standard), db)

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
    satisfies.
    """
    result = await db.execute(
        select(ImportJob)
        .where(ImportJob.project_id == project_id, ImportJob.status == "running")
        .order_by(ImportJob.started_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def get_most_recent_job(project_id: uuid.UUID, db: AsyncSession) -> ImportJob | None:
    """Backs GET /status/active -- the job any page should show on mount
    (docs request: recover a running job across navigation/reload/closing
    the tab, but ALSO the last job's final result if it finished while the
    tab was closed, rather than silently forgetting it happened). Returns
    the single most recent job for the project regardless of status, not
    just a running one -- the caller (ProjectConfigPage/Sidebar) decides
    what to render for each status; the Sidebar badge specifically only
    ever renders for status="running", so a long-finished job never
    lingers as a stale badge.
    """
    result = await db.execute(
        select(ImportJob).where(ImportJob.project_id == project_id).order_by(ImportJob.started_at.desc()).limit(1)
    )
    return result.scalar_one_or_none()


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

        created = updated = rejected = conflicts_kept = conflicts_cleared = 0
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
            },
        )
    except Exception as exc:  # noqa: BLE001 -- HR7: surface, never swallow
        await work_session.rollback()
        await _finish_job(progress_session, job_id, status_value="failed", error=str(exc))
    finally:
        await work_session.close()
        await progress_session.close()
