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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, has_project_role
from app.db.base import get_db
from app.models import User, UserProjectRole
from app.repositories.brdp_repository import (
    get_active_brdp_by_identifier,
    get_trashed_brdp,
    list_trashed_brdps,
    list_trashed_brdps_by_ids,
)
from app.schemas.brdp import BRDPOut
from app.schemas.trash import TrashBulkDeleteRequest, TrashBulkDeleteResult, TrashedBRDPOut
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trashed BRDP not found")
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
            detail=(
                f"Cannot restore: identifier {brdp.identifier!r} is now used by another active "
                "BRDP in this project. Resolve that conflict (rename or remove the other BRDP) "
                "before restoring this one."
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
    for real to rule_approvals/notes/suggestion_feedback (existing ON
    DELETE CASCADE FKs); brdp_history survives via its ON DELETE SET NULL
    (migration 0010).
    """
    brdp = await get_trashed_brdp(brdp_id, db)
    if brdp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trashed BRDP not found")
    if not await has_project_role(current_user, brdp.project_id, "editor", db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized for this project")
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
    for brdp in found:
        await db.delete(brdp)
    await db.commit()
    return TrashBulkDeleteResult(deleted=list(found_ids), not_found=not_found)
