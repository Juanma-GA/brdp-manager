"""Database access for projects and users -- the single place that knows a
project or a user in the Papelera (AACF 2, Decisión 13) must be invisible
to every normal read path, the same way brdp_repository.py does it for a
trashed BRDP.

ACTIVE_PROJECT_FILTER / ACTIVE_USER_FILTER are the only spelling of
`deleted_at IS NULL` for these two tables. ACTIVE_PROJECT_IDS is the
subquery brdp_repository.ACTIVE_BRDP_FILTER uses, so every BRDP query that
already excluded trashed BRDPs also excludes the BRDPs of a deleted
project -- Suggest, Comparar, the BRDP Papelera, jobs and Excel at once,
by construction, not by a fix per query.
"""
import unicodedata
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Project, User

ACTIVE_PROJECT_FILTER = Project.deleted_at.is_(None)
ACTIVE_PROJECT_IDS = select(Project.id).where(ACTIVE_PROJECT_FILTER)
ACTIVE_USER_FILTER = User.deleted_at.is_(None)


async def get_active_project(project_id: uuid.UUID, db: AsyncSession) -> Project | None:
    """The project, or None if it does not exist or is in the Papelera --
    callers answer 404 "Project not found" for both."""
    project = await db.get(Project, project_id)
    if project is None or project.deleted_at is not None:
        return None
    return project


async def get_trashed_project(project_id: uuid.UUID, db: AsyncSession) -> Project | None:
    project = await db.get(Project, project_id)
    if project is None or project.deleted_at is None:
        return None
    return project


async def get_active_user(user_id: uuid.UUID, db: AsyncSession) -> User | None:
    user = await db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        return None
    return user


async def get_deleted_user(user_id: uuid.UUID, db: AsyncSession) -> User | None:
    user = await db.get(User, user_id)
    if user is None or user.deleted_at is None:
        return None
    return user


def comparable_project_name(name: str) -> str:
    """A project name as two names are compared: trimmed, without accents
    (NFKD, combining marks dropped) and case-folded -- "Proyecto Ñ" and
    "proyecto n" are the same name."""
    decomposed = unicodedata.normalize("NFKD", name.strip())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()


async def active_project_name_taken(name: str, db: AsyncSession, exclude_id: uuid.UUID | None = None) -> bool:
    """Whether an active project already has this name, ignoring case and
    accents -- what a restore or a duplicate must not repeat. Compared in
    Python over the active names (a few hundred at most): Postgres has no
    accent folding without the unaccent extension, and ILIKE would read a
    "%" or "_" in the name as a wildcard. A project in the Papelera never
    counts."""
    query = select(Project.id, Project.name).where(ACTIVE_PROJECT_FILTER)
    if exclude_id is not None:
        query = query.where(Project.id != exclude_id)
    wanted = comparable_project_name(name)
    return any(comparable_project_name(row.name) == wanted for row in (await db.execute(query)).all())
