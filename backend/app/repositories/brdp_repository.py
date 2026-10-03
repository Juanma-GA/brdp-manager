"""Database access for BRDP rows -- the single place that knows a
soft-deleted (trashed) row must be invisible to every normal read path
(atexis-global.mdc: "Database access only through repository/model
layer"). Every route/service that used to `select(BRDP)`/`db.get(BRDP,
...)` directly now goes through here instead, so `WHERE deleted_at IS
NULL` (or its absence, for the Trash itself) is never repeated ad hoc.

ACTIVE_BRDP_FILTER is exported for the handful of call sites that build a
larger/joined query the two named functions below don't cover (e.g.
similar.py's cross-project precedent search, approvals.py's
RuleApproval-joined bulk lookup) -- those still centralize the actual
`deleted_at IS NULL` condition from here rather than re-typing
`BRDP.deleted_at.is_(None)` at each call site.
"""
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import BRDP, Project, RuleApproval
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT

# The one place `deleted_at IS NULL` is spelled out as a SQLAlchemy
# expression -- import this into any query that needs it instead of
# writing `BRDP.deleted_at.is_(None)` again.
ACTIVE_BRDP_FILTER = BRDP.deleted_at.is_(None)

# GET /brdps's Rule Status vocabulary (RULE_STATES in src/utils/ruleState.js)
# -- "todo" isn't a rule_approvals.status value at all, it's the absence of
# a row (see compute_status_counts()'s docstring below).
_RULE_STATUS_TO_APPROVAL_STATUS = {"draft": "pending_review", "verified": "approved"}


async def list_active_brdps(
    project_id: uuid.UUID,
    db: AsyncSession,
    proposal_status: str | None = None,
    rule_status: str | None = None,
    rule_format: str | None = None,
) -> list[BRDP]:
    """Every BRDP in a project that isn't trashed -- powers BRDP Records,
    Export to Excel, and the dataset Generate BREX/Schematron reads
    (GET /api/projects/{project_id}/brdps), so a trashed BRDP disappears
    from all three at once by construction, not by three separate fixes.

    proposal_status/rule_status (both optional, both applied in SQL, never
    in-memory -- the whole point, with SOPTE's 2819 rows/188 pages in
    mind) are BRDP Records' new status filters. rule_format is the
    CALLER-resolved STANDARD_TO_RULE_FORMAT[project.standard] (None for a
    standard with no rule format yet, e.g. S1000D 5.0/6.0) -- resolving it
    is the route's job (it already has the Project row for the
    require_project_role check), not this repository's; every other
    caller of this function (Export to Excel, Generate, GeneratePage's
    dataset fetch) leaves proposal_status/rule_status/rule_format at their
    None default and gets the exact same unfiltered list as before this
    parameter existed.
    """
    query = select(BRDP).where(BRDP.project_id == project_id, ACTIVE_BRDP_FILTER)
    if proposal_status:
        query = query.where(BRDP.validation == proposal_status)
    if rule_status:
        if rule_status == "todo":
            if rule_format is not None:
                approved_ids = select(RuleApproval.brdp_id).where(RuleApproval.format == rule_format)
                query = query.where(BRDP.id.not_in(approved_ids))
            # else: standard has no rule format at all -> every active BRDP
            # is "todo", no extra WHERE needed.
        elif rule_format is None:
            # Nothing can ever be draft/verified without a rule format.
            return []
        else:
            target_status = _RULE_STATUS_TO_APPROVAL_STATUS[rule_status]
            matching_ids = select(RuleApproval.brdp_id).where(
                RuleApproval.format == rule_format, RuleApproval.status == target_status
            )
            query = query.where(BRDP.id.in_(matching_ids))
    result = await db.execute(query)
    return list(result.scalars().all())


async def compute_status_counts(db: AsyncSession, projects: list[Project]) -> dict[uuid.UUID, dict]:
    """Proposal Status (brdps.validation) and Rule Status counts for every
    project in `projects`, in exactly 2 SQL queries regardless of how many
    projects are passed -- never one query per project (the same N+1
    class of bug already fixed twice this session, for Reset Data and
    Import). Powers both GET /api/projects (bulk, every visible project at
    once) and GET /api/projects/{id}/brdps/stats (a 1-element list).

    Rule Status is scoped to each project's OWN rule_approvals format
    (STANDARD_TO_RULE_FORMAT[project.standard] -- BREX-4.2 for an S1000D
    4.2 project, SCH-DITA for either DITA flavor, None for S1000D 5.0/6.0,
    which have no rule format at all yet). This matters: a stale
    rule_approvals row left over under a DIFFERENT format (e.g. after a
    standard rename) must never be counted as this project's real Rule
    Status, and "to_do" itself is the absence of an approval row under
    that SPECIFIC format, not a stored value -- computed here as
    total_active - draft - verified, not queried directly.

    Returns {project_id: {"proposal_status_counts": {...}, "rule_status_counts": {...}}},
    with every count defaulting to 0 (a brand-new project with zero BRDPs
    gets all-zero dicts, not a missing key or a KeyError).
    """
    if not projects:
        return {}
    project_ids = [p.id for p in projects]

    proposal_rows = (
        await db.execute(
            select(BRDP.project_id, BRDP.validation, func.count())
            .where(BRDP.project_id.in_(project_ids), ACTIVE_BRDP_FILTER)
            .group_by(BRDP.project_id, BRDP.validation)
        )
    ).all()
    proposal_counts = {pid: {"pending": 0, "validated": 0, "refused": 0} for pid in project_ids}
    totals = dict.fromkeys(project_ids, 0)
    _VALIDATION_TO_KEY = {"Pending": "pending", "Validated": "validated", "Refused": "refused"}
    for project_id, validation, count in proposal_rows:
        key = _VALIDATION_TO_KEY.get(validation)
        if key:
            proposal_counts[project_id][key] = count
        totals[project_id] += count

    rule_rows = (
        await db.execute(
            select(BRDP.project_id, RuleApproval.format, RuleApproval.status, func.count())
            .select_from(RuleApproval)
            .join(BRDP, BRDP.id == RuleApproval.brdp_id)
            .where(BRDP.project_id.in_(project_ids), ACTIVE_BRDP_FILTER)
            .group_by(BRDP.project_id, RuleApproval.format, RuleApproval.status)
        )
    ).all()
    by_project_format_status: dict[tuple, int] = {}
    for project_id, fmt, approval_status, count in rule_rows:
        by_project_format_status[(project_id, fmt, approval_status)] = count

    rule_counts = {}
    for project in projects:
        fmt = STANDARD_TO_RULE_FORMAT.get(project.standard)
        total = totals.get(project.id, 0)
        draft = by_project_format_status.get((project.id, fmt, "pending_review"), 0) if fmt else 0
        verified = by_project_format_status.get((project.id, fmt, "approved"), 0) if fmt else 0
        rule_counts[project.id] = {"to_do": total - draft - verified, "draft": draft, "verified": verified}

    return {
        pid: {"proposal_status_counts": proposal_counts[pid], "rule_status_counts": rule_counts[pid]}
        for pid in project_ids
    }


async def get_active_brdp(project_id: uuid.UUID, brdp_id: uuid.UUID, db: AsyncSession) -> BRDP | None:
    """A single BRDP, scoped to `project_id` (so a caller can't reach
    another project's row just by knowing its id) and to non-trashed rows
    only. Returns None rather than raising -- callers translate a miss to
    404, same as the `db.get()` calls this replaces.
    """
    result = await db.execute(
        select(BRDP).where(BRDP.id == brdp_id, BRDP.project_id == project_id, ACTIVE_BRDP_FILTER)
    )
    return result.scalar_one_or_none()


async def get_active_brdp_by_id(brdp_id: uuid.UUID, db: AsyncSession) -> BRDP | None:
    """Like get_active_brdp, but not scoped to a known project_id -- for
    the one caller (POST /api/suggestion-feedback) that only has a bare
    brdp_id in its request body and derives project_id FROM the result,
    rather than a path param it could scope by up front.
    """
    result = await db.execute(select(BRDP).where(BRDP.id == brdp_id, ACTIVE_BRDP_FILTER))
    return result.scalar_one_or_none()


async def get_active_brdp_by_identifier(project_id: uuid.UUID, identifier: str, db: AsyncSession) -> BRDP | None:
    """Backs both the create-time uniqueness pre-check and the Trash's
    restore conflict check -- deliberately excludes trashed rows, so an
    identifier freed up by a soft-delete (the partial unique index's whole
    point) reads as available here too, matching what the DB will actually
    allow.
    """
    result = await db.execute(
        select(BRDP).where(BRDP.project_id == project_id, BRDP.identifier == identifier, ACTIVE_BRDP_FILTER)
    )
    return result.scalar_one_or_none()


async def list_trashed_brdps(db: AsyncSession, project_ids: list[uuid.UUID] | None = None):
    """Every soft-deleted BRDP, newest-deleted first. Project name is
    joined in here rather than left for the route to look up per row, so
    the Papelera table doesn't cost an extra query per project
    represented.

    `project_ids=None` (admin) lists every project's trash, matching the
    original admin-only behavior. A non-admin editor passes their own
    editor-project ids here so the query itself never returns a row from
    a project they don't have access to -- an empty list correctly yields
    zero rows (SQLAlchemy's `.in_(())` matches nothing) rather than "no
    filter".

    Returns raw (BRDP, project_name) rows -- the route assembles
    TrashedBRDPOut from them.
    """
    query = (
        select(BRDP, Project.name.label("project_name"))
        .join(Project, BRDP.project_id == Project.id)
        .where(BRDP.deleted_at.is_not(None))
    )
    if project_ids is not None:
        query = query.where(BRDP.project_id.in_(project_ids))
    result = await db.execute(query.order_by(BRDP.deleted_at.desc()))
    return result.all()


async def get_trashed_brdp(brdp_id: uuid.UUID, db: AsyncSession) -> BRDP | None:
    """The inverse of get_active_brdp -- only matches a row that IS
    trashed, for the Trash's Restore/Delete-permanently actions. Not
    project-scoped: the Trash spans every project, and the admin acting on
    a row already knows its id from the listing above.
    """
    result = await db.execute(select(BRDP).where(BRDP.id == brdp_id, BRDP.deleted_at.is_not(None)))
    return result.scalar_one_or_none()


async def list_trashed_brdps_by_ids(
    brdp_ids: list[uuid.UUID], db: AsyncSession, project_ids: list[uuid.UUID] | None = None
) -> list[BRDP]:
    """Backs the Trash's bulk 'Delete permanently' -- one SELECT for the
    whole selected batch (never one per id), same batching discipline as
    every other function here. Only matches rows that are STILL trashed;
    an id the caller sent that isn't in the result is either not trashed
    any more (restored in the real race the docs request calls out),
    never existed, or -- same `project_ids` filter as list_trashed_brdps,
    and same reasoning: a non-admin editor's own project ids -- belongs to
    a project they can't touch. All three collapse into the same
    `not_found` outcome on purpose: the route never distinguishes "not
    yours" from "already gone", so a caller can't use this endpoint to
    probe whether an id exists in a project they have no access to.
    """
    if not brdp_ids:
        return []
    query = select(BRDP).where(BRDP.id.in_(brdp_ids), BRDP.deleted_at.is_not(None))
    if project_ids is not None:
        query = query.where(BRDP.project_id.in_(project_ids))
    result = await db.execute(query)
    return list(result.scalars().all())
