"""Settings > Papelera (Trash) -- admin-only, cross-project view of every
soft-deleted BRDP (see app/models/brdp.py's deleted_at/deleted_by/
deleted_by_email and app/repositories/brdp_repository.py). Restore
reverses a soft-delete; Delete permanently is the one remaining path that
still issues a real db.delete() against a BRDP row.

Admin-only end to end (docs request: "un editor... nunca ve la sección
Papelera... ni puede llamar a sus endpoints directamente") -- unlike GET
/api/settings/import-eta, there's no "any authenticated user" reader here:
nothing outside this admin surface needs to know what's in the Trash.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.base import get_db
from app.models import User
from app.repositories.brdp_repository import get_active_brdp_by_identifier, get_trashed_brdp, list_trashed_brdps
from app.schemas.brdp import BRDPOut
from app.schemas.trash import TrashedBRDPOut
from app.services.history import record_change

router = APIRouter(prefix="/api/trash", tags=["trash"])


def _require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.global_role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return current_user


@router.get("", response_model=list[TrashedBRDPOut])
async def list_trash(
    _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> list[TrashedBRDPOut]:
    rows = await list_trashed_brdps(db)
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
    brdp_id: uuid.UUID, admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
):
    brdp = await get_trashed_brdp(brdp_id, db)
    if brdp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trashed BRDP not found")

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
    record_change(db, brdp.id, admin, "status", "deleted", "active")
    await db.commit()
    await db.refresh(brdp)
    return brdp


@router.delete("/{brdp_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_brdp_permanently(
    brdp_id: uuid.UUID, _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
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
    await db.delete(brdp)
    await db.commit()
