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

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import BRDP, Project

# The one place `deleted_at IS NULL` is spelled out as a SQLAlchemy
# expression -- import this into any query that needs it instead of
# writing `BRDP.deleted_at.is_(None)` again.
ACTIVE_BRDP_FILTER = BRDP.deleted_at.is_(None)


async def list_active_brdps(project_id: uuid.UUID, db: AsyncSession) -> list[BRDP]:
    """Every BRDP in a project that isn't trashed -- powers BRDP Records,
    Export to Excel, and the dataset Generate BREX/Schematron reads
    (GET /api/projects/{project_id}/brdps), so a trashed BRDP disappears
    from all three at once by construction, not by three separate fixes.
    """
    result = await db.execute(select(BRDP).where(BRDP.project_id == project_id, ACTIVE_BRDP_FILTER))
    return list(result.scalars().all())


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


async def list_trashed_brdps(db: AsyncSession):
    """Every soft-deleted BRDP across ALL projects (docs request: the
    Papelera lists every project's trash, not just the one currently
    open), newest-deleted first. Project name is joined in here rather
    than left for the route to look up per row, so the Papelera table
    doesn't cost an extra query per project represented.

    Returns raw (BRDP, project_name) rows -- the route assembles
    TrashedBRDPOut from them.
    """
    result = await db.execute(
        select(BRDP, Project.name.label("project_name"))
        .join(Project, BRDP.project_id == Project.id)
        .where(BRDP.deleted_at.is_not(None))
        .order_by(BRDP.deleted_at.desc())
    )
    return result.all()


async def get_trashed_brdp(brdp_id: uuid.UUID, db: AsyncSession) -> BRDP | None:
    """The inverse of get_active_brdp -- only matches a row that IS
    trashed, for the Trash's Restore/Delete-permanently actions. Not
    project-scoped: the Trash spans every project, and the admin acting on
    a row already knows its id from the listing above.
    """
    result = await db.execute(select(BRDP).where(BRDP.id == brdp_id, BRDP.deleted_at.is_not(None)))
    return result.scalar_one_or_none()
