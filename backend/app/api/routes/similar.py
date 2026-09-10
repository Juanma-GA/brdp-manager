"""GET .../brdps/{brdp_id}/similar -- docs/v2 §3. Returns few-shot
precedent for Suggest Definition/Proposal/Rule; the frontend builds the
actual LLM prompt from this (§4's "FastAPI never builds prompts" rule) --
this endpoint never calls the LLM itself, only pgvector + Postgres.
"""
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_httpx_transport, require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import BRDP, Project, RuleApproval, User
from app.schemas.similar import SimilarCandidateOut, SimilarOut
from app.services.embeddings import EmbeddingUnavailable, compute_embedding

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

# project.standard (fixed per project, docs/v2 §2) -> the rule_approvals
# format its BREX rules are stored under. Schematron formats are derived
# from BREX-3.0.1 deterministically (see CLAUDE.md's brexToSchematron
# section), not something a user directly "Suggests a Rule" for, so only
# the three BREX standards map here; anything else (DITA, unrecognized)
# has no rule-kind precedent available. Flagged here, not hidden: this is
# a scope decision docs/v2 §3 doesn't spell out explicitly.
_STANDARD_TO_RULE_FORMAT = {
    "S1000D 4.2": "BREX-4.2",
    "S1000D 4.1": "BREX-4.1",
    "S1000D 3.0.1": "BREX-3.0.1",
}


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
    # brdp.embedding -- that column is only populated for Validated BRDPs
    # (docs/v2 §3 point 1), but the whole point of Suggest Definition/
    # Proposal/Rule is helping with a BRDP that ISN'T validated yet.
    query_text = f"{brdp.definition}\n\n{brdp.proposal}"
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
        kind=kind, sufficient_precedent=sufficient, candidates=candidates, message=message, format=rule_format
    )
