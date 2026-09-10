import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_httpx_transport, require_project_role
from app.db.base import get_db
from app.models import BRDP, User
from app.schemas.brdp import BRDPCreate, BRDPOut, BRDPUpdate
from app.services.embeddings import EmbeddingUnavailable, compute_embedding

router = APIRouter(prefix="/api/projects/{project_id}/brdps", tags=["brdps"])


async def _compute_brdp_embedding(brdp: BRDP, transport: httpx.AsyncBaseTransport | None) -> list[float]:
    """docs/v2 §3 point 1: embedding text is definition+proposal
    concatenated. A failure here must fail the whole request (never let a
    BRDP become 'Validated' with a stale-or-missing embedding, which would
    silently and permanently exclude it from every future similarity
    search with no indication why -- HR7) -- the caller must call this
    BEFORE db.commit() so an uncaught HTTPException here rolls back the
    validation change along with it, not just skip the embedding.
    """
    text = f"{brdp.definition}\n\n{brdp.proposal}"
    try:
        return await compute_embedding(text, transport=transport)
    except EmbeddingUnavailable as err:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not compute embedding for validated BRDP: {err}",
        )


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
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> BRDP:
    brdp = BRDP(project_id=project_id, **body.model_dump())
    if brdp.validation == "Validated":
        brdp.embedding = await _compute_brdp_embedding(brdp, transport)
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
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> BRDP:
    brdp = await _get_owned_brdp(project_id, brdp_id, db)
    was_validated = brdp.validation == "Validated"
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(brdp, field, value)

    if brdp.validation == "Validated":
        # docs/v2 §3 point 1: compute on first validation, recompute on
        # any edit to an already-validated BRDP -- unconditional on every
        # edit while Validated, not just definition/proposal changes,
        # matching the spec's literal "recalcular si se edita" rather than
        # guessing which fields matter enough to justify the extra call.
        brdp.embedding = await _compute_brdp_embedding(brdp, transport)
    elif was_validated:
        # No longer Validated -- clear the now-stale embedding rather than
        # leave it around. The similarity query already filters on
        # validation='Validated' so this isn't reachable today, but a
        # stale vector surviving an un-validate is a footgun for any
        # future query that forgets that filter.
        brdp.embedding = None

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
