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
from app.models import BRDP, BRDPCatalog, Project, RuleApproval, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.schemas.similar import SimilarCandidateOut, SimilarOut
from app.services.embeddings import EmbeddingUnavailable, brdp_embedding_text, compute_embedding
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT as _STANDARD_TO_RULE_FORMAT

router = APIRouter(prefix="/api/projects/{project_id}/brdps/{brdp_id}/similar", tags=["similar"])

# docs/v2 §3 point 3 -- HR7, never silently degrade: below this many
# passing candidates, the response says so explicitly instead of padding
# with weak matches. Starting value, not empirically tuned yet (§3 point 5
# -- revisit after real usage, same as the rest of the mechanism). Applies
# to kind='proposal'/'rule' only -- docs request removed this gate for
# kind='definition' (its corpus round), which always calls the LLM now.
MIN_CANDIDATES = 3

# Minimum cosine similarity (1 - pgvector cosine distance) to count as a
# real match at all, independent of MIN_CANDIDATES -- without this, a
# project with only 3 total Validated BRDPs would always report
# "sufficient precedent" even if none of them are actually similar. Also
# the threshold for kind='definition''s "Similar" list (docs request).
MIN_SIMILARITY = 0.5

CANDIDATE_LIMIT = 10

# kind='definition' only (docs request): "up to 5 similar" / "3 lowest-
# similarity style references, only when fewer than 3 similar".
DEFINITION_SIMILAR_LIMIT = 5
DEFINITION_STYLE_REFERENCE_LIMIT = 3


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

    # docs request (Suggest Definition corpus round), point 1 -- "Prohibido
    # sobre BRDPs de catálogo": an official catalog BRDP already HAS a
    # standard-issued Definition, so suggesting one is nonsensical. The
    # frontend disables the button for this case; this is the server-side
    # defense (checked against the real table, never by identifier prefix
    # -- a project can legitimately have non-EXT identifiers that aren't
    # catalog entries, and vice versa). Cheap enough to do before the real
    # embedding call below, so a direct API call never pays for one either.
    if kind == "definition":
        is_catalog_brdp = (
            await db.execute(
                select(func.count())
                .select_from(BRDPCatalog)
                .where(BRDPCatalog.standard == project.standard, BRDPCatalog.identifier == brdp.identifier)
            )
        ).scalar_one() > 0
        if is_catalog_brdp:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"BRDP {brdp.identifier!r} already has an official definition from the "
                    f"{project.standard!r} catalog -- Suggest Definition is not available for it."
                ),
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

    if kind == "definition":
        return await _get_definition_similar(db, project, project_id, brdp_id, query_embedding)

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
        # kind == "definition" never reaches here -- it returns early via
        # _get_definition_similar() above, with its own corpus logic.
        text = candidate_brdp.proposal if kind == "proposal" else rule_text_by_brdp_id.get(candidate_brdp.id, "")
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


_DefinitionPoolEntry = tuple[tuple[str, uuid.UUID], float, SimilarCandidateOut]


def _dedupe_records_matching_catalog(pool: list[_DefinitionPoolEntry]) -> list[_DefinitionPoolEntry]:
    """docs request (Suggest Definition language/wrap/dedup round), point 3:
    a catalog entry and a Records BRDP that share an identifier AND have
    byte-identical Definition text are the same precedent shown twice --
    drop the Records one (prefer Catalog, the official source) so it
    doesn't spend one of the 5 'similar' slots (or 3 'style reference'
    slots) on content already shown once. If a project adapted the
    wording, the text differs, so BOTH are kept -- genuinely different
    precedent, not a duplicate.
    """
    catalog_texts_by_identifier: dict[str, set[str]] = {}
    for key, _score, candidate in pool:
        if key[0] == "catalog":
            catalog_texts_by_identifier.setdefault(candidate.identifier, set()).add(candidate.text)
    return [
        entry
        for entry in pool
        if not (
            entry[0][0] == "brdp"
            and entry[2].text in catalog_texts_by_identifier.get(entry[2].identifier, set())
        )
    ]


async def _get_definition_similar(
    db: AsyncSession,
    project: Project,
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    query_embedding: list[float],
) -> SimilarOut:
    """kind='definition' corpus (docs request, Suggest Definition round):
    unlike proposal/rule, candidates come from BOTH this standard's other
    Validated BRDPs (across every project, same as proposal/rule already
    do) AND its official catalog -- and MIN_CANDIDATES no longer applies,
    since the LLM is always called for this kind regardless of precedent.

    The "top N" / "bottom N" queries below are each independently LIMITed
    and merged in Python -- correct because the true global top-N (or
    bottom-N) across two sorted sources can never include an item outside
    either source's own top-N (or bottom-N): a source can contribute at
    most N items to the global N, so anything past its own Nth-best could
    never make the cut. This avoids pulling a whole standard's corpus
    (thousands of rows for a SOPTE-scale deployment) into Python just to
    pick 5 + 3 candidates.
    """
    brdp_distance = BRDP.embedding.cosine_distance(query_embedding).label("distance")
    brdp_base = (
        select(BRDP, Project.name.label("project_name"), brdp_distance)
        .join(Project, BRDP.project_id == Project.id)
        .where(
            Project.standard == project.standard,
            BRDP.validation == "Validated",
            BRDP.id != brdp_id,
            BRDP.embedding.is_not(None),
            # Same as proposal/rule: a trashed BRDP is never precedent.
            ACTIVE_BRDP_FILTER,
        )
    )
    brdp_top_rows = (
        await db.execute(brdp_base.order_by(brdp_distance, BRDP.id).limit(DEFINITION_SIMILAR_LIMIT))
    ).all()
    brdp_bottom_rows = (
        await db.execute(brdp_base.order_by(brdp_distance.desc(), BRDP.id).limit(DEFINITION_STYLE_REFERENCE_LIMIT))
    ).all()

    catalog_distance = BRDPCatalog.embedding.cosine_distance(query_embedding).label("distance")
    catalog_base = select(BRDPCatalog, catalog_distance).where(
        BRDPCatalog.standard == project.standard, BRDPCatalog.embedding.is_not(None)
    )
    catalog_top_rows = (
        await db.execute(catalog_base.order_by(catalog_distance, BRDPCatalog.id).limit(DEFINITION_SIMILAR_LIMIT))
    ).all()
    catalog_bottom_rows = (
        await db.execute(
            catalog_base.order_by(catalog_distance.desc(), BRDPCatalog.id).limit(DEFINITION_STYLE_REFERENCE_LIMIT)
        )
    ).all()

    def brdp_candidate(row) -> _DefinitionPoolEntry:
        b, project_name, distance = row.BRDP, row.project_name, row.distance
        similarity = 1 - distance
        candidate = SimilarCandidateOut(
            id=b.id,
            identifier=b.identifier,
            text=b.definition,
            title=b.title or "",
            definition=b.definition,
            score=similarity,
            # "Records: <project name>" / "Catalog" -- the exact origin
            # label format the docs request's own prompt template uses
            # ({Records: project name | Catalog}), rendered verbatim into
            # both the LLM prompt and the UI's reference list.
            source=f"Records: {project_name}",
        )
        return (("brdp", b.id), similarity, candidate)

    def catalog_candidate(row) -> _DefinitionPoolEntry:
        c, distance = row.BRDPCatalog, row.distance
        similarity = 1 - distance
        candidate = SimilarCandidateOut(
            id=c.id,
            identifier=c.identifier,
            text=c.definition,
            title=c.title or "",
            definition=c.definition,
            score=similarity,
            source="Catalog",
        )
        return (("catalog", c.id), similarity, candidate)

    top_pool = _dedupe_records_matching_catalog(
        [brdp_candidate(r) for r in brdp_top_rows] + [catalog_candidate(r) for r in catalog_top_rows]
    )
    top_pool.sort(key=lambda entry: entry[1], reverse=True)
    top_filtered = [
        (key, candidate) for key, score, candidate in top_pool if score >= MIN_SIMILARITY
    ][:DEFINITION_SIMILAR_LIMIT]
    similar: list[SimilarCandidateOut] = [candidate for _key, candidate in top_filtered]
    similar_keys = {key for key, _candidate in top_filtered}

    style_references: list[SimilarCandidateOut] = []
    # DEFINITION_STYLE_REFERENCE_LIMIT doubles as both "how many style
    # references to add" and "the 'similar' count below which they kick
    # in" -- both are the same number (3) in the docs request, deliberately.
    if len(similar) < DEFINITION_STYLE_REFERENCE_LIMIT:
        bottom_pool = _dedupe_records_matching_catalog(
            [brdp_candidate(r) for r in brdp_bottom_rows] + [catalog_candidate(r) for r in catalog_bottom_rows]
        )
        bottom_pool.sort(key=lambda entry: entry[1])  # ascending -- least similar first
        seen_keys = set(similar_keys)
        for key, _score, candidate in bottom_pool:
            if key in seen_keys:
                continue
            seen_keys.add(key)
            style_references.append(candidate)
            if len(style_references) >= DEFINITION_STYLE_REFERENCE_LIMIT:
                break

    # Same computation as the proposal/rule path above (HR7 -- never
    # silently degrade): a Validated BRDP in another project of this
    # standard with no embedding yet is invisible to the searches above.
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

    return SimilarOut(
        kind="definition",
        sufficient_precedent=True,
        candidates=similar,
        style_references=style_references,
        message=None,
        format=None,
        excluded_pending_other_projects=excluded_pending_other_projects,
    )
