"""GET .../brdps/{brdp_id}/similar -- docs/v2 §3. Returns few-shot
precedent for Suggest Definition/Proposal/Rule; the frontend builds the
actual LLM prompt from this (§4's "FastAPI never builds prompts" rule) --
this endpoint never calls the LLM itself, only pgvector + Postgres.
"""
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_httpx_transport, require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import BRDP, Project, RuleApproval, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.schemas.similar import SimilarCandidateOut, SimilarOut
from app.services.embeddings import EmbeddingUnavailable, brdp_embedding_text, compute_embedding
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT as _STANDARD_TO_RULE_FORMAT

router = APIRouter(prefix="/api/projects/{project_id}/brdps/{brdp_id}/similar", tags=["similar"])

# docs/v2 §3 point 3 -- HR7, never silently degrade: below this many
# passing candidates, the response says so explicitly instead of padding
# with weak matches. Starting value, not empirically tuned yet (§3 point 5
# -- revisit after real usage, same as the rest of the mechanism).
MIN_CANDIDATES = 3

# Minimum cosine similarity (1 - pgvector cosine distance) to count as a
# real match at all, independent of MIN_CANDIDATES -- without this, a
# project with only 3 total Validated BRDPs would always report
# "sufficient precedent" even if none of them are actually similar.
MIN_SIMILARITY = 0.5

CANDIDATE_LIMIT = 10


@router.get("", response_model=SimilarOut)
async def get_similar(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    kind: str = Query(..., pattern="^(definition|proposal|rule)$"),
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> SimilarOut:
    brdp = await _get_owned_brdp(project_id, brdp_id, db)
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    rule_format: str | None = None
    if kind == "rule":
        rule_format = _STANDARD_TO_RULE_FORMAT.get(project.standard)
        if rule_format is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Rule suggestions are not available for project standard {project.standard!r}",
            )

    # Computed fresh from the SOURCE BRDP's current text, not read from
    # brdp.embedding -- that column is only ever populated by the
    # embedding_jobs background job for a Validated BRDP (docs request:
    # on-demand embeddings), but the whole point of Suggest Definition/
    # Proposal/Rule is helping with a BRDP that ISN'T validated yet, so a
    # stored embedding usually doesn't even exist here. Must use the exact
    # same composition (title+definition+proposal) the job stores under,
    # via the shared brdp_embedding_text() helper -- a query embedded
    # under a different text shape than the candidates would compare
    # cosine distance across two incompatible embedding spaces.
    query_text = brdp_embedding_text(brdp)
    try:
        query_embedding = await compute_embedding(query_text, transport=transport)
    except EmbeddingUnavailable as err:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Could not compute query embedding: {err}"
        )

    distance_col = BRDP.embedding.cosine_distance(query_embedding).label("distance")
    stmt = (
        select(BRDP, distance_col)
        .join(Project, BRDP.project_id == Project.id)
        .where(
            Project.standard == project.standard,
            BRDP.validation == "Validated",
            BRDP.id != brdp_id,
            BRDP.embedding.is_not(None),
            # A trashed BRDP must never count as precedent for Suggest
            # Definition/Proposal/Rule (docs request), even though its
            # rule_approvals row (for "rule") is left alive by a
            # soft-delete -- this is the one thing that actually hides it
            # from that join.
            ACTIVE_BRDP_FILTER,
        )
    )
    if kind == "rule":
        stmt = stmt.join(
            RuleApproval,
            (RuleApproval.brdp_id == BRDP.id) & (RuleApproval.format == rule_format),
        ).where(RuleApproval.status == "approved")
    stmt = stmt.order_by(distance_col).limit(CANDIDATE_LIMIT)

    rows = (await db.execute(stmt)).all()

    rule_text_by_brdp_id: dict[uuid.UUID, str] = {}
    if kind == "rule" and rows:
        candidate_ids = [row.BRDP.id for row in rows]
        approvals = (
            await db.execute(
                select(RuleApproval).where(
                    RuleApproval.brdp_id.in_(candidate_ids), RuleApproval.format == rule_format
                )
            )
        ).scalars()
        rule_text_by_brdp_id = {a.brdp_id: a.rule_xml for a in approvals}

    candidates: list[SimilarCandidateOut] = []
    for row in rows:
        candidate_brdp, distance = row.BRDP, row.distance
        similarity = 1 - distance
        if similarity < MIN_SIMILARITY:
            continue  # rows are ordered by distance ascending -- no later row can pass either
        if kind == "definition":
            text = candidate_brdp.definition
        elif kind == "proposal":
            text = candidate_brdp.proposal
        else:
            text = rule_text_by_brdp_id.get(candidate_brdp.id, "")
        candidates.append(
            SimilarCandidateOut(
                id=candidate_brdp.id, identifier=candidate_brdp.identifier, text=text, score=similarity
            )
        )

    # HR7 -- never silently degrade: a Validated BRDP in ANOTHER project of
    # this same standard that hasn't been through its own project's
    # embedding job yet is invisible to the query above (BRDP.embedding.
    # is_not(None) excludes it), and nothing else here would ever surface
    # that it was left out. Scoped to other projects only -- this project's
    # own pending BRDPs already block Suggest entirely via the frontend's
    # disabled-while-pending rule, so they can never actually reach this
    # query in practice.
    excluded_pending_other_projects = (
        await db.execute(
            select(func.count())
            .select_from(BRDP)
            .join(Project, BRDP.project_id == Project.id)
            .where(
                Project.standard == project.standard,
                Project.id != project_id,
                BRDP.validation == "Validated",
                BRDP.embedding.is_(None),
                ACTIVE_BRDP_FILTER,
            )
        )
    ).scalar_one()

    sufficient = len(candidates) >= MIN_CANDIDATES
    message = (
        None
        if sufficient
        else (
            f"Insufficient precedent: only {len(candidates)} Validated BRDP(s) of the same standard "
            f"meet the similarity threshold (minimum {MIN_CANDIDATES} required). Suggestions built "
            "without enough precedent are not offered automatically -- review manually instead."
        )
    )
    return SimilarOut(
        kind=kind,
        sufficient_precedent=sufficient,
        candidates=candidates,
        message=message,
        format=rule_format,
        excluded_pending_other_projects=excluded_pending_other_projects,
    )
