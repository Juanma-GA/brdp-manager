"""Settings > Papelera (Trash) -- cross-project view of every soft-deleted
BRDP (see app/models/brdp.py's deleted_at/deleted_by/deleted_by_email and
app/repositories/brdp_repository.py). Restore reverses a soft-delete;
Delete permanently is the one remaining path that still issues a real
db.delete() against a BRDP row.

Admin sees and can act on every project's trash, unchanged. A non-admin
editor sees and can act on only the trash of projects where they hold
`editor` (a viewer role, or none at all, means no access -- not even an
empty list): list_trash/bulk-delete scope the query itself to those
project ids (list_trashed_brdps/list_trashed_brdps_by_ids's project_ids
param), and the single-row restore/delete endpoints check the one BRDP's
own project via has_project_role. A pure viewer, or an editor probing a
project they don't belong to, gets 403 from the single-row endpoints and
is folded into `not_found` (never a separate signal) from the bulk one --
this used to be described as "admin-only end to end"; it no longer is.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import error_detail
from app.api.deps import get_current_user, has_project_role
from app.db.base import get_db
from app.models import BRDP, Project, User, UserProjectRole
from app.repositories.project_repository import active_project_name_taken, get_trashed_project
from app.repositories.brdp_repository import (
    get_active_brdp_by_identifier,
    get_trashed_brdp,
    list_trashed_brdps,
    list_trashed_brdps_by_ids,
)
from app.schemas.brdp import BRDPOut
from app.schemas.trash import (
    ProjectRestoreRequest,
    TrashBulkDeleteRequest,
    TrashBulkDeleteResult,
    TrashedBRDPOut,
    TrashedProjectOut,
)
from app.services.audit import record, record_project_deleted_permanently
from app.services.history import record_change

router = APIRouter(prefix="/api/trash", tags=["trash"])


async def _editor_project_ids(current_user: User, db: AsyncSession) -> list[uuid.UUID]:
    """Every project id where `current_user` holds `editor` -- used to scope
    a non-admin's view of/action on the Trash to just those projects.
    """
    result = await db.execute(
        select(UserProjectRole.project_id).where(
            UserProjectRole.user_id == current_user.id,
            UserProjectRole.role == "editor",
        )
    )
    return [row[0] for row in result.all()]


# ── Projects (AACF 2, Decisión 13) ──────────────────────────────────────
# Admin only, like deleting a project. A project in the Papelera keeps
# everything (BRDPs, rules, history, roles, and its own trashed BRDPs,
# which are hidden from the BRDP list above until it comes back).


def _require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.global_role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return current_user


def _trashed_project_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "trashed_project_not_found", "message": "Project not found in the Papelera"},
    )


@router.get("/projects", response_model=list[TrashedProjectOut])
async def list_trashed_projects(
    _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> list[TrashedProjectOut]:
    brdp_count = (
        select(func.count())
        .select_from(BRDP)
        .where(BRDP.project_id == Project.id, BRDP.deleted_at.is_(None))
        .correlate(Project)
        .scalar_subquery()
    )
    rows = (
        await db.execute(
            select(Project, brdp_count.label("brdp_count"))
            .where(Project.deleted_at.is_not(None))
            .order_by(Project.deleted_at.desc())
        )
    ).all()
    return [
        TrashedProjectOut(
            id=project.id,
            name=project.name,
            standard=project.standard,
            brdp_count=count,
            deleted_at=project.deleted_at,
            deleted_by_email=project.deleted_by_email,
        )
        for project, count in rows
    ]


@router.post("/projects/{project_id}/restore", response_model=TrashedProjectOut)
async def restore_project(
    project_id: uuid.UUID,
    body: ProjectRestoreRequest | None = None,
    _admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> TrashedProjectOut:
    """Brings the project back exactly as it was. If an active project now
    has the same name, refused with 409 project_name_taken (never two
    projects that look the same in the list); the caller can restore it
    under another name (body.name), which must be free too."""
    project = await get_trashed_project(project_id, db)
    if project is None:
        raise _trashed_project_not_found()
    name = (body.name if body and body.name is not None else project.name).strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "project_name_empty", "message": "The project name cannot be empty."},
        )
    if await active_project_name_taken(name, db, exclude_id=project.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "project_name_taken",
                "name": name,
                "message": f"An active project is already called {name!r}; restore this one under another name.",
            },
        )
    count = (
        await db.execute(
            select(func.count()).select_from(BRDP).where(BRDP.project_id == project.id, BRDP.deleted_at.is_(None))
        )
    ).scalar_one()
    out = TrashedProjectOut(
        id=project.id,
        name=name,
        standard=project.standard,
        brdp_count=count,
        deleted_at=project.deleted_at,
        deleted_by_email=project.deleted_by_email,
    )
    detail = {} if name == project.name else {"previous_name": project.name}
    project.name = name
    project.deleted_at = None
    project.deleted_by = None
    project.deleted_by_email = None
    record(
        db,
        _admin,
        "project.restored",
        target_type="project",
        target_id=project.id,
        target_label=name,
        project_id=project.id,
        project_name=name,
        detail=detail,
    )
    await db.commit()
    return out


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_permanently(
    project_id: uuid.UUID, _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> None:
    """The real delete of a project already in the Papelera: ON DELETE
    CASCADE removes its BRDPs, rules, roles and jobs; BRDP history rows
    survive (ON DELETE SET NULL, migration 0010) with the email of whoever
    made each change."""
    project = await get_trashed_project(project_id, db)
    if project is None:
        raise _trashed_project_not_found()
    await record_project_deleted_permanently(db, _admin, project)
    await db.delete(project)
    await db.commit()


# ── BRDPs ───────────────────────────────────────────────────────────────


def _record_brdp_deleted(db: AsyncSession, actor: User, brdp: BRDP, project_name: str | None) -> None:
    """One audit row per BRDP deleted for good (Protecciones 2b): its
    history survives with brdp_id NULL, and this row says which BRDP it was."""
    record(
        db,
        actor,
        "brdp.deleted_permanently",
        target_type="brdp",
        target_id=brdp.id,
        target_label=brdp.identifier,
        project_id=brdp.project_id,
        project_name=project_name,
        detail={"title": brdp.title},
    )


@router.get("", response_model=list[TrashedBRDPOut])
async def list_trash(
    current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[TrashedBRDPOut]:
    project_ids = None
    if current_user.global_role != "admin":
        project_ids = await _editor_project_ids(current_user, db)
        if not project_ids:
            # A pure viewer (or an editor of nothing) gets 403, not an
            # empty list -- the docs request is explicit that this reads
            # as "no access", not "your trash happens to be empty".
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized")

    rows = await list_trashed_brdps(db, project_ids=project_ids)
    return [
        TrashedBRDPOut(
            id=brdp.id,
            identifier=brdp.identifier,
            title=brdp.title,
            project_id=brdp.project_id,
            project_name=project_name,
            deleted_at=brdp.deleted_at,
            deleted_by_email=brdp.deleted_by_email,
        )
        for brdp, project_name in rows
    ]


@router.post("/{brdp_id}/restore", response_model=BRDPOut)
async def restore_brdp(
    brdp_id: uuid.UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    brdp = await get_trashed_brdp(brdp_id, db)
    if brdp is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_detail("trashed_brdp_not_found", message="Trashed BRDP not found"),
        )
    if not await has_project_role(current_user, brdp.project_id, "editor", db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized for this project")

    # Real edge case given the partial unique index (docs request): the
    # identifier this BRDP used to hold may have been reissued to a brand
    # new, currently-active BRDP in the same project while this one sat in
    # the Trash. Restoring would violate that index -- caught here as a
    # clean 409 instead of a raw IntegrityError, same convention as
    # brdps.py's own create-time uniqueness check.
    conflict = await get_active_brdp_by_identifier(brdp.project_id, brdp.identifier, db)
    if conflict is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_detail(
                "brdp_restore_identifier_taken",
                message=(
                    f"Cannot restore: identifier {brdp.identifier!r} is now used by another active "
                    "BRDP in this project. Resolve that conflict (rename or remove the other BRDP) "
                    "before restoring this one."
                ),
                identifier=brdp.identifier,
            ),
        )

    brdp.deleted_at = None
    brdp.deleted_by = None
    record_change(db, brdp.id, current_user, "status", "deleted", "active")
    await db.commit()
    await db.refresh(brdp)
    return brdp


@router.delete("/{brdp_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_brdp_permanently(
    brdp_id: uuid.UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> None:
    """The one real db.delete() left in the whole BRDP lifecycle -- only
    reachable from the Trash, and only for a row that's already trashed
    (an active BRDP must go through the normal soft-delete first). Cascades
    for real to rule_approvals/suggestion_feedback (existing ON
    DELETE CASCADE FKs); brdp_history survives via its ON DELETE SET NULL
    (migration 0010).
    """
    brdp = await get_trashed_brdp(brdp_id, db)
    if brdp is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_detail("trashed_brdp_not_found", message="Trashed BRDP not found"),
        )
    if not await has_project_role(current_user, brdp.project_id, "editor", db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized for this project")
    project = await db.get(Project, brdp.project_id)
    _record_brdp_deleted(db, current_user, brdp, project.name if project else None)
    await db.delete(brdp)
    await db.commit()


@router.delete("", response_model=TrashBulkDeleteResult)
async def bulk_delete_brdps_permanently(
    body: TrashBulkDeleteRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> TrashBulkDeleteResult:
    """Bulk 'Delete permanently' (docs request: same single-bulk-operation
    criterion Reset Data already uses, not N individual DELETEs) -- one
    SELECT to find which of the requested ids are actually still trashed
    AND belong to a project this caller can act on, then real db.delete()
    calls against each, all in ONE transaction/commit.

    An id that comes back missing is never a 500 or a silently partial
    success: it's reported in `not_found` so the caller can tell the
    difference -- covering both the real race the docs request calls out
    (another editor/admin restoring a row between the checkbox selection
    and this confirm) AND an id from a project this caller has no editor
    access to, which is folded into the exact same `not_found` bucket
    rather than a separate signal (so this endpoint can't be used to probe
    whether an id exists in a project the caller can't otherwise see).
    """
    project_ids = None if current_user.global_role == "admin" else await _editor_project_ids(current_user, db)
    found = await list_trashed_brdps_by_ids(body.brdp_ids, db, project_ids=project_ids)
    found_ids = {b.id for b in found}
    not_found = [brdp_id for brdp_id in body.brdp_ids if brdp_id not in found_ids]
    names = {}
    if found:
        names = dict(
            (await db.execute(select(Project.id, Project.name).where(Project.id.in_({b.project_id for b in found})))).all()
        )
    for brdp in found:
        _record_brdp_deleted(db, current_user, brdp, names.get(brdp.project_id))
        await db.delete(brdp)
    await db.commit()
    return TrashBulkDeleteResult(deleted=list(found_ids), not_found=not_found)
