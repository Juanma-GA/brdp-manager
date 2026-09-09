import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_project_role
from app.db.base import get_db
from app.models import BRDP, User
from app.schemas.brdp import BRDPCreate, BRDPOut, BRDPUpdate

router = APIRouter(prefix="/api/projects/{project_id}/brdps", tags=["brdps"])


async def _get_owned_brdp(project_id: uuid.UUID, brdp_id: uuid.UUID, db: AsyncSession) -> BRDP:
    """Fetches a BRDP and verifies it actually belongs to `project_id` --
    without this, an editor of project A could mutate a BRDP that belongs
    to project B just by putting A's project_id in the path and B's real
    brdp_id, since require_project_role only checks the path's project_id,
    never the resource's own. 404 (not 403) so a caller can't distinguish
    "wrong project" from "doesn't exist".
    """
    brdp = await db.get(BRDP, brdp_id)
    if brdp is None or brdp.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BRDP not found")
    return brdp


@router.get("", response_model=list[BRDPOut])
async def list_brdps(
    project_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> list[BRDP]:
    result = await db.execute(select(BRDP).where(BRDP.project_id == project_id))
    return list(result.scalars().all())


@router.post("", response_model=BRDPOut, status_code=status.HTTP_201_CREATED)
async def create_brdp(
    project_id: uuid.UUID,
    body: BRDPCreate,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> BRDP:
    brdp = BRDP(project_id=project_id, **body.model_dump())
    db.add(brdp)
    await db.commit()
    await db.refresh(brdp)
    return brdp


@router.put("/{brdp_id}", response_model=BRDPOut)
async def update_brdp(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    body: BRDPUpdate,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> BRDP:
    brdp = await _get_owned_brdp(project_id, brdp_id, db)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(brdp, field, value)
    await db.commit()
    await db.refresh(brdp)
    return brdp


@router.delete("/{brdp_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_brdp(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> None:
    brdp = await _get_owned_brdp(project_id, brdp_id, db)
    await db.delete(brdp)
    await db.commit()
