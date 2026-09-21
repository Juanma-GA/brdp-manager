import re
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_httpx_transport, require_project_role
from app.db.base import get_db
from app.models import BRDP, BRDPHistory, Project, User
from app.repositories.brdp_repository import (
    ACTIVE_BRDP_FILTER,
    compute_status_counts,
    get_active_brdp,
    get_active_brdp_by_identifier,
    list_active_brdps,
)
from app.schemas.brdp import BRDPCreate, BRDPOut, BRDPUpdate, NextExtIdentifierOut
from app.schemas.brdp_history import BRDPHistoryOut
from app.schemas.status_counts import ProposalStatusCounts, RuleStatusCounts
from app.services.embeddings import EmbeddingUnavailable, compute_embedding
from app.services.history import record_change
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT
from pydantic import BaseModel


class BRDPStatsOut(BaseModel):
    """GET /brdps/stats's response -- BRDP Records' header summary. Kept as
    its own small endpoint rather than embedded in list_brdps' response
    (see that endpoint's own docstring for why): counts always reflect the
    project's REAL total, independent of whatever proposal_status/
    rule_status filter the list call is currently using.
    """

    proposal_status_counts: ProposalStatusCounts
    rule_status_counts: RuleStatusCounts


_PROPOSAL_STATUS_VALUES = {"Pending", "Validated", "Refused"}
_RULE_STATUS_VALUES = {"todo", "draft", "verified"}

router = APIRouter(prefix="/api/projects/{project_id}/brdps", tags=["brdps"])

# DB column name -> the audit trail's field_name (docs request: the
# Proposal Status column/label maps to the "validation" column, so the
# history entry should read "proposal_status", not the internal name).
# identifier is absent -- BRDPUpdate doesn't accept it at all (a BRDP's
# identifier is fixed for its lifetime once created), so it can never
# appear in `updates` below.
_HISTORY_FIELDS = {
    "title": "title",
    "definition": "definition",
    "proposal": "proposal",
    "validation": "proposal_status",
}

# Deliberately its own numbering, scoped to ONLY this exact prefix -- NOT
# a port of extractBRDPs.js's generateIds() (frontend, untouchable engine
# file), which looks at the highest number across ANY prefix. Confirmed
# with the user: a project seeded from the catalog (identifiers like
# "BRDP-S1-00001") must still start its first manually-added BRDP at
# BRDP-EXT-00001, not continue from the catalog's numbers -- so catalog
# identifiers need to be ignored entirely here, not just deprioritized.
# NOTE for a future round: AI Extract's generateIds() has this same
# mixed-prefix bug and will need the identical fix when that feature is
# revisited -- not done here, out of scope for this round.
_EXT_IDENTIFIER_PATTERN = re.compile(r"^BRDP-EXT-(\d+)$")


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


async def _identifier_taken(project_id: uuid.UUID, identifier: str, db: AsyncSession) -> bool:
    """Pre-check for the (project_id, identifier) partial unique index --
    matches this codebase's existing convention for uniqueness (see
    users.py's email check): a clean 409 from an application-level query,
    not a raw IntegrityError/500 from the DB constraint, which remains the
    actual source of truth for data integrity. identifier is unique WITHIN
    a project only -- the same identifier is valid in a different project.
    Only ACTIVE rows count (docs request: a trashed BRDP's identifier is
    free to reuse -- matches the partial index, which only constrains
    non-deleted rows).

    Only ever called from create_brdp now -- identifier is immutable once
    a BRDP exists (BRDPUpdate doesn't accept it), so there is no more
    "renaming to an identifier already in use" case to exclude the row's
    own id from.
    """
    return await get_active_brdp_by_identifier(project_id, identifier, db) is not None


async def _get_owned_brdp(project_id: uuid.UUID, brdp_id: uuid.UUID, db: AsyncSession) -> BRDP:
    """Fetches a BRDP, scoped to `project_id` (so a caller can't reach
    another project's row just by knowing its id) and to ACTIVE rows only
    -- a trashed BRDP 404s here exactly like one that never existed
    (docs request: a deleted BRDP must disappear everywhere, including
    edit/delete/history, not just the Records list). Restoring it from the
    Papelera is the only way back in; there is no "edit while trashed".
    404 (not 403) so a caller can't distinguish "wrong project"/"trashed"
    from "doesn't exist".
    """
    brdp = await get_active_brdp(project_id, brdp_id, db)
    if brdp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BRDP not found")
    return brdp


@router.get("", response_model=list[BRDPOut])
async def list_brdps(
    project_id: uuid.UUID,
    proposal_status: str | None = Query(
        None, description="Filter by Proposal Status (brdps.validation): Pending | Validated | Refused"
    ),
    rule_status: str | None = Query(
        None, description="Filter by Rule Status (rule_approvals, this project's own format): todo | draft | verified"
    ),
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> list[BRDP]:
    """BRDP Records' table -- and, when neither filter is given, every
    other caller (Export to Excel, Generate BREX/Schematron's dataset
    fetch, the Delete-project confirmation count, ...), all of which get
    the exact same unfiltered list as before these two params existed.

    Both filters are applied in SQL (list_active_brdps -> a WHERE/JOIN,
    never a Python-side filter over an already-fetched list) -- with
    SOPTE's 2819 rows across 188 client-side pages, fetching everything
    and filtering in memory would defeat the point.
    """
    if proposal_status is not None and proposal_status not in _PROPOSAL_STATUS_VALUES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"proposal_status must be one of {sorted(_PROPOSAL_STATUS_VALUES)}",
        )
    if rule_status is not None and rule_status not in _RULE_STATUS_VALUES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"rule_status must be one of {sorted(_RULE_STATUS_VALUES)}",
        )

    rule_format = None
    if rule_status is not None:
        project = await db.get(Project, project_id)
        if project is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
        rule_format = STANDARD_TO_RULE_FORMAT.get(project.standard)

    return await list_active_brdps(
        project_id, db, proposal_status=proposal_status, rule_status=rule_status, rule_format=rule_format
    )


@router.get("/stats", response_model=BRDPStatsOut)
async def get_brdp_stats(
    project_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> BRDPStatsOut:
    """BRDP Records' header summary -- reuses compute_status_counts(), the
    exact same aggregation GET /api/projects uses for its own per-project
    columns, scoped to this one project (a 1-element list). A brand-new
    project with zero BRDPs gets all-zero counts, not a missing field or
    a 404.

    A SEPARATE endpoint rather than metadata bundled into GET /brdps'
    response: that endpoint's response is `list[BRDPOut]` (a bare array,
    consumed as one directly by several existing callers -- Export to
    Excel, GeneratePage's dataset fetch, the Delete-project confirmation
    count); wrapping it in an object to carry stats alongside the rows
    would be a breaking change to every one of those. It would also be
    the wrong VALUE even if it weren't breaking: the header must show the
    project's real totals regardless of whichever proposal_status/
    rule_status filter the list call above is currently using, not a
    count of the currently-filtered subset -- so bundling them together
    would need this exact same unfiltered aggregation computed a second
    time internally anyway the moment a filter is active.
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    counts = (await compute_status_counts(db, [project]))[project.id]
    return BRDPStatsOut(**counts)


@router.get("/next-ext-identifier", response_model=NextExtIdentifierOut)
async def get_next_ext_identifier(
    project_id: uuid.UUID,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> NextExtIdentifierOut:
    """Powers Add BRDP's pre-filled, locked ID field. Editor-gated since
    it only ever matters to the creation flow, which is itself editor+.
    Only considers ACTIVE identifiers -- a trashed BRDP-EXT-NNNNN's number
    is free to be reissued, consistent with the partial unique index.
    """
    identifiers = (
        (await db.execute(select(BRDP.identifier).where(BRDP.project_id == project_id, ACTIVE_BRDP_FILTER)))
        .scalars()
        .all()
    )
    highest = 0
    for identifier in identifiers:
        match = _EXT_IDENTIFIER_PATTERN.match(identifier)
        if match:
            highest = max(highest, int(match.group(1)))
    return NextExtIdentifierOut(identifier=f"BRDP-EXT-{highest + 1:05d}")


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
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Soft-delete (Papelera/Trash, docs request): the row stays in
    Postgres with deleted_at/deleted_by/deleted_by_email set, invisible to
    every read path that goes through app/repositories/brdp_repository.py
    -- rule_status/rule_xml/history are untouched, so a later Restore
    brings everything back exactly as it was. Only Settings > Papelera's
    "Delete permanently" action ever issues a real db.delete().
    """
    brdp = await _get_owned_brdp(project_id, brdp_id, db)
    brdp.deleted_at = datetime.now(timezone.utc)
    brdp.deleted_by = editor.id
    brdp.deleted_by_email = editor.email
    record_change(db, brdp.id, editor, "status", "active", "deleted")
    await db.commit()


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def reset_project_data(
    project_id: uuid.UUID,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Project Configuration's "Reset Data" -- soft-deletes every ACTIVE
    BRDP in the project via one bulk UPDATE (docs request: this used to be
    N sequential per-row DELETE requests from the frontend, a real N+1;
    the fix belongs here, not just in how the frontend calls it). Same
    soft-delete path as the single-row DELETE above, deliberately -- Reset
    Data is not a hard-delete shortcut, everything it removes lands in the
    Papelera like any other delete.

    The bulk UPDATE itself stays a single round trip via RETURNING; the
    per-row brdp_history inserts that follow are staged in the same
    transaction (db.add(), not a second commit each) so this is still one
    commit total, not len(returned_ids) + 1.
    """
    now = datetime.now(timezone.utc)
    stmt = (
        update(BRDP)
        .where(BRDP.project_id == project_id, ACTIVE_BRDP_FILTER)
        .values(deleted_at=now, deleted_by=editor.id, deleted_by_email=editor.email)
        .returning(BRDP.id)
    )
    result = await db.execute(stmt)
    for brdp_id in result.scalars().all():
        record_change(db, brdp_id, editor, "status", "active", "deleted")
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
