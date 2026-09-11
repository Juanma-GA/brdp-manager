import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_httpx_transport, require_project_role
from app.db.base import get_db
from app.models import BRDP, BRDPHistory, User
from app.schemas.brdp import BRDPCreate, BRDPOut, BRDPUpdate
from app.schemas.brdp_history import BRDPHistoryOut
from app.services.embeddings import EmbeddingUnavailable, compute_embedding
from app.services.history import record_change

router = APIRouter(prefix="/api/projects/{project_id}/brdps", tags=["brdps"])

# DB column name -> the audit trail's field_name (docs request: the
# Proposal Status column/label maps to the "validation" column, so the
# history entry should read "proposal_status", not the internal name).
_HISTORY_FIELDS = {
    "identifier": "identifier",
    "title": "title",
    "definition": "definition",
    "proposal": "proposal",
    "validation": "proposal_status",
}


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


async def _identifier_taken(
    project_id: uuid.UUID, identifier: str, db: AsyncSession, *, exclude_brdp_id: uuid.UUID | None = None
) -> bool:
    """Pre-check for the (project_id, identifier) unique constraint --
    matches this codebase's existing convention for uniqueness (see
    users.py's email check): a clean 409 from an application-level query,
    not a raw IntegrityError/500 from the DB constraint, which remains the
    actual source of truth for data integrity. identifier is unique WITHIN
    a project only -- the same identifier is valid in a different project.
    """
    query = select(BRDP).where(BRDP.project_id == project_id, BRDP.identifier == identifier)
    if exclude_brdp_id is not None:
        query = query.where(BRDP.id != exclude_brdp_id)
    existing = (await db.execute(query)).scalar_one_or_none()
    return existing is not None


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
    if await _identifier_taken(project_id, body.identifier, db):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A BRDP with identifier {body.identifier!r} already exists in this project",
        )
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
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> BRDP:
    brdp = await _get_owned_brdp(project_id, brdp_id, db)
    updates = body.model_dump(exclude_unset=True)
    if "identifier" in updates and updates["identifier"] != brdp.identifier:
        if await _identifier_taken(project_id, updates["identifier"], db, exclude_brdp_id=brdp.id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A BRDP with identifier {updates['identifier']!r} already exists in this project",
            )
    was_validated = brdp.validation == "Validated"
    # Snapshot old values BEFORE mutating, only for fields actually present
    # in this request -- record_change() below then does the real old-vs-
    # new diff and only stages a row when the value genuinely changed.
    old_values = {field: getattr(brdp, field) for field in _HISTORY_FIELDS if field in updates}
    for field, value in updates.items():
        setattr(brdp, field, value)
    for field, history_name in _HISTORY_FIELDS.items():
        if field in old_values:
            record_change(db, brdp.id, editor, history_name, old_values[field], getattr(brdp, field))

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


@router.get("/{brdp_id}/history", response_model=list[BRDPHistoryOut])
async def get_brdp_history(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> list[BRDPHistory]:
    """Read-only for viewer, same as every other read endpoint -- this is a
    query, not a mutation (docs request explicit on this point).
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    result = await db.execute(
        select(BRDPHistory).where(BRDPHistory.brdp_id == brdp_id).order_by(BRDPHistory.changed_at.desc())
    )
    return list(result.scalars().all())
