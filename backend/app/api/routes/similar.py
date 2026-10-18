"""GET .../brdps/{brdp_id}/similar -- docs/v2 §3. Returns few-shot
precedent for Suggest Definition/Proposal/Rule; the frontend builds the
actual LLM prompt from this (§4's "FastAPI never builds prompts" rule) --
this endpoint never calls the LLM itself, only pgvector + Postgres.
"""
import re
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import logging
from app.core.errors import error_detail, new_error_ref
from app.api.deps import get_httpx_transport, require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import BRDP, BRDPCatalog, Project, RuleApproval, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.repositories.project_repository import ACTIVE_PROJECT_FILTER
from app.schemas.similar import SimilarCandidateOut, SimilarOut
from app.services.embeddings import EmbeddingUnavailable, brdp_embedding_text, compute_embedding
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT as _STANDARD_TO_RULE_FORMAT
from app.services.rule_precedents import extract_format_rules
from app.services.rule_templates import load_template_rules

logger = logging.getLogger("app.errors")
router = APIRouter(prefix="/api/projects/{project_id}/brdps/{brdp_id}/similar", tags=["similar"])

# Minimum cosine similarity (1 - pgvector cosine distance) to count as a
# real "similar" match -- used by every kind's similarity-ranked group.
MIN_SIMILARITY = 0.5

# kind='rule' (docs request, Suggest Rule round): there is no longer a
# minimum-precedent gate -- the LLM is always called. same_brdp + similar
# are topped up to RULE_MIN_REFERENCES with standard_fallback, then with
# template_fallback, so the prompt always shows the format at least this
# many times when the standard has any rules at all.
RULE_SAME_BRDP_LIMIT = 5
RULE_SIMILAR_LIMIT = 5
RULE_MIN_REFERENCES = 3
# Rows read per query page while skipping precedents with no rule element
# of the format (see _get_rule_similar's usable_rows).
_RULE_PAGE_SIZE = 20

# Mirrors src/utils/proposalMarkers.js's UNFILLED_MARKER_RE -- keep both in
# sync (same fixtures in tests/test_similar.py and
# scripts/test-rule-name-check.mjs). A placeholder the user hasn't filled
# in yet is ANY "[...]" that
#   - starts a word: preceded by the start of the text, whitespace or
#     sentence punctuation ( , ; : ! ? ¿ ¡ quotes, dashes) -- never by a
#     letter, digit, ")", "]", "*", "/", "@", "." etc., so an XPath
#     predicate glued to a step (para[@x], //a[1], x[.='y'], (//p)[2]) is
#     never one;
#   - and whose content doesn't start with "@" or a digit ([@type='x'],
#     [1..n] are predicates/ranges, not placeholders).
# This covers Suggest Proposal's own markers ([LIST: …], [SHALL/SHALL
# NOT], [VALUE: …]) AND the ones people type by hand ([e C1008, C1234],
# [tbd]) -- the previous uppercase-name-only pattern missed the latter.
UNFILLED_MARKER_RE = re.compile(r"(?:^|(?<=[\s(,;:!?¿¡\"'«“‘—–]))\[(?![@\d\s\]])[^\[\]]+\]")

# kind='definition' only (docs request): "up to 5 similar" / "3 lowest-
# similarity style references, only when fewer than 3 similar".
DEFINITION_SIMILAR_LIMIT = 5
DEFINITION_STYLE_REFERENCE_LIMIT = 3

# kind='proposal' only (docs request, Suggest Proposal round): "Same BRDP
# in other projects" and "Similar decisions" TOGETHER never exceed this --
# the latter only tops up the former to this combined total (or provides
# all of it alone, when the identifier isn't catalog-issued and "Same
# BRDP" is empty). "This project" is independent, capped separately.
PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT = 5
PROPOSAL_THIS_PROJECT_LIMIT = 3


@router.get("", response_model=SimilarOut)
async def get_similar(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    kind: str = Query(..., pattern="^(title|definition|proposal|rule)$"),
    viewer: User = Depends(require_project_role("viewer")),
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
        await _check_rule_prerequisites(db, brdp, rule_format)

    # docs request (Suggest Definition corpus round), point 1 -- "Prohibido
    # sobre BRDPs de catálogo": an official catalog BRDP already HAS a
    # standard-issued Definition, so suggesting one is nonsensical. The
    # frontend disables the button for this case; this is the server-side
    # defense (checked against the real table, never by identifier prefix
    # -- a project can legitimately have non-EXT identifiers that aren't
    # catalog entries, and vice versa). Cheap enough to do before the real
    # embedding call below, so a direct API call never pays for one either.
    # Suggest Title: same gate (the catalog gives the official Title too).
    if kind in ("definition", "title"):
        is_catalog_brdp = (
            await db.execute(
                select(func.count())
                .select_from(BRDPCatalog)
                .where(BRDPCatalog.standard == project.standard, BRDPCatalog.identifier == brdp.identifier)
            )
        ).scalar_one() > 0
        if is_catalog_brdp:
            what = "title" if kind == "title" else "definition"
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"BRDP {brdp.identifier!r} already has an official {what} from the "
                    f"{project.standard!r} catalog -- Suggest {what.capitalize()} is not available for it."
                ),
            )

    # Suggest Title rewrites the Title the BRDP already has as the name of
    # its decision point; with no Title there is nothing to rewrite.
    if kind == "title" and not brdp.title.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"BRDP {brdp.identifier!r} has no Title yet -- write one before Suggest Title.",
        )

    # docs request (Suggest Proposal round), point 2: a Proposal is the
    # project's concrete ANSWER to the decision point the Definition
    # describes -- writing one without a Definition first has nothing to
    # answer. Checked server-side (the frontend disables the button for the
    # same reason) before the real embedding call below, same placement as
    # the catalog-BRDP gate above. Explicitly allowed for a catalog-sourced
    # BRDP (unlike kind='definition' above) -- the catalog only supplies
    # the official Definition, never a Proposal, which is always this
    # project's own decision to make.
    if kind == "proposal" and not brdp.definition.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"BRDP {brdp.identifier!r} has no Definition yet -- add or accept one before Suggest Proposal.",
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
        query_embedding = await compute_embedding(query_text, transport=transport, user_id=viewer.id)
    except EmbeddingUnavailable as err:
        ref = new_error_ref()
        logger.error("ref=%s query embedding for Suggest failed: %s", ref, err)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=error_detail("embedding_unavailable", ref))

    # Suggest Title uses the Definition corpus: the closest decision points
    # (and a few different ones) carry their titles, used only as style.
    if kind in ("definition", "title"):
        return await _get_definition_similar(db, project, project_id, brdp_id, query_embedding)

    if kind == "proposal":
        return await _get_proposal_similar(db, project, project_id, brdp_id, brdp, query_embedding)

    # Only kind == "rule" ever reaches here -- "definition"/"proposal" both
    # return early above via their own dedicated corpus functions.
    return await _get_rule_similar(db, project, project_id, brdp_id, brdp, rule_format, query_embedding)


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
    do) AND its official catalog -- and there is no minimum-precedent gate,
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
        .where(ACTIVE_PROJECT_FILTER)
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
            source_type="records",
            source_project=project_name,
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
            source_type="catalog",
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
            .where(ACTIVE_PROJECT_FILTER)
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


async def _get_proposal_similar(
    db: AsyncSession,
    project: Project,
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    brdp: BRDP,
    query_embedding: list[float],
) -> SimilarOut:
    """kind='proposal' corpus (docs request, Suggest Proposal round): three
    disjoint groups instead of the old single ranked list. The catalog
    never enters (it has no Proposal at all), so this is entirely a
    Records-only search, unlike kind='definition'.

      - same_brdp ("Same BRDP in other projects"): up to
        PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT Validated BRDPs (non-empty
        Proposal) in OTHER projects sharing this BRDP's EXACT identifier
        -- a plain identifier lookup, no embeddings. Populated ONLY when
        this identifier exists in this standard's official catalog -- an
        EXT-style auto-generated identifier can coincide across two
        unrelated projects by pure chance, so identifier matching is only
        semantically meaningful for a real catalog-issued id.
      - candidates ("Similar decisions"): up to
        PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT - len(same_brdp) MORE, via
        embedding similarity among OTHER projects, excluding any BRDP
        already in same_brdp -- so the two groups combined never exceed
        PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT, and when same_brdp is empty
        (the EXT case) this group alone provides all of it.
      - this_project ("This project"): up to PROPOSAL_THIS_PROJECT_LIMIT,
        via embedding similarity within THIS SAME project -- disjoint from
        the other two groups by construction (those are always OTHER
        projects), so it never needs cross-group dedup against them.

    No "style reference" fallback for this kind (unlike definition) --
    if all three groups are empty, the response says so and stops there.
    No minimum-precedent gate here either -- sufficient_precedent is
    always True and message always None, same as kind='definition'.
    """
    is_catalog_brdp = (
        await db.execute(
            select(func.count())
            .select_from(BRDPCatalog)
            .where(BRDPCatalog.standard == project.standard, BRDPCatalog.identifier == brdp.identifier)
        )
    ).scalar_one() > 0

    same_brdp: list[SimilarCandidateOut] = []
    same_brdp_ids: set[uuid.UUID] = set()
    if is_catalog_brdp:
        same_brdp_rows = (
            await db.execute(
                select(BRDP, Project.name.label("project_name"))
                .join(Project, BRDP.project_id == Project.id)
                .where(ACTIVE_PROJECT_FILTER)
                .where(
                    Project.standard == project.standard,
                    Project.id != project_id,
                    BRDP.identifier == brdp.identifier,
                    BRDP.validation == "Validated",
                    BRDP.proposal != "",
                    ACTIVE_BRDP_FILTER,
                )
                # No similarity to rank by (this is a direct identifier
                # match, not an embedding search) -- ordered by project
                # name then id purely for a stable, reproducible result.
                .order_by(Project.name, BRDP.id)
                .limit(PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT)
            )
        ).all()
        for row in same_brdp_rows:
            b, project_name = row.BRDP, row.project_name
            same_brdp.append(
                SimilarCandidateOut(
                    id=b.id,
                    identifier=b.identifier,
                    text=b.proposal,
                    title=b.title or "",
                    definition=b.definition,
                    # No embedding-based similarity for a direct identifier
                    # match -- never rendered (the UI never shows a score
                    # for this group), 0.0 is a pure unused placeholder.
                    score=0.0,
                    source=project_name,
                    source_type="project",
                    source_project=project_name,
                )
            )
            same_brdp_ids.add(b.id)

    similar: list[SimilarCandidateOut] = []
    similar_limit = PROPOSAL_SAME_BRDP_AND_SIMILAR_LIMIT - len(same_brdp)
    if similar_limit > 0:
        distance_col = BRDP.embedding.cosine_distance(query_embedding).label("distance")
        similar_filters = [
            Project.standard == project.standard,
            Project.id != project_id,
            BRDP.validation == "Validated",
            BRDP.proposal != "",
            BRDP.embedding.is_not(None),
            ACTIVE_BRDP_FILTER,
        ]
        if same_brdp_ids:
            similar_filters.append(BRDP.id.not_in(same_brdp_ids))
        similar_rows = (
            await db.execute(
                select(BRDP, Project.name.label("project_name"), distance_col)
                .join(Project, BRDP.project_id == Project.id)
                .where(ACTIVE_PROJECT_FILTER)
                .where(*similar_filters)
                .order_by(distance_col, BRDP.id)
                .limit(similar_limit)
            )
        ).all()
        for row in similar_rows:
            b, project_name, distance = row.BRDP, row.project_name, row.distance
            similarity = 1 - distance
            if similarity < MIN_SIMILARITY:
                break  # ordered ascending by distance -- no later row can pass either
            similar.append(
                SimilarCandidateOut(
                    id=b.id,
                    identifier=b.identifier,
                    text=b.proposal,
                    title=b.title or "",
                    definition=b.definition,
                    score=similarity,
                    source=project_name,
                    source_type="project",
                    source_project=project_name,
                )
            )

    this_project_distance = BRDP.embedding.cosine_distance(query_embedding).label("distance")
    this_project_rows = (
        await db.execute(
            select(BRDP, this_project_distance)
            .where(
                BRDP.project_id == project_id,
                BRDP.id != brdp_id,
                BRDP.validation == "Validated",
                BRDP.proposal != "",
                BRDP.embedding.is_not(None),
                ACTIVE_BRDP_FILTER,
            )
            .order_by(this_project_distance, BRDP.id)
            .limit(PROPOSAL_THIS_PROJECT_LIMIT)
        )
    ).all()
    this_project: list[SimilarCandidateOut] = []
    for row in this_project_rows:
        b, distance = row.BRDP, row.distance
        similarity = 1 - distance
        if similarity < MIN_SIMILARITY:
            break  # ordered ascending by distance -- no later row can pass either
        this_project.append(
            SimilarCandidateOut(
                id=b.id,
                identifier=b.identifier,
                text=b.proposal,
                title=b.title or "",
                definition=b.definition,
                score=similarity,
                # Empty, not the project's own name -- "This project" is
                # already implied by the group itself, never named in
                # either the prompt block or the UI for this group.
                source="",
                source_type="",
            )
        )

    # Same computation/reasoning as kind='definition'/the old proposal/rule
    # path (HR7 -- never silently degrade), scoped to non-empty Proposal
    # too -- otherwise this would overstate how many were left out
    # specifically because of a missing embedding, by also counting rows
    # that would have been excluded anyway for lacking a Proposal at all.
    excluded_pending_other_projects = (
        await db.execute(
            select(func.count())
            .select_from(BRDP)
            .join(Project, BRDP.project_id == Project.id)
            .where(ACTIVE_PROJECT_FILTER)
            .where(
                Project.standard == project.standard,
                Project.id != project_id,
                BRDP.validation == "Validated",
                BRDP.proposal != "",
                BRDP.embedding.is_(None),
                ACTIVE_BRDP_FILTER,
            )
        )
    ).scalar_one()

    return SimilarOut(
        kind="proposal",
        sufficient_precedent=True,
        candidates=similar,
        same_brdp=same_brdp,
        this_project=this_project,
        message=None,
        format=None,
        excluded_pending_other_projects=excluded_pending_other_projects,
    )


async def _check_rule_prerequisites(db: AsyncSession, brdp: BRDP, rule_format: str) -> None:
    """docs request (Suggest Rule round), Part 1 -- server-side defense for
    the same conditions the frontend already disables the button for.
    Flow: Suggest Proposal -> the user fills in its placeholders and
    validates it -> Suggest Rule. A rule implements a DECIDED Proposal, so
    every check here is about that decision being actually taken. Catalog
    BRDPs are allowed (unlike Suggest Definition).
    """
    proposal = (brdp.proposal or "").strip()
    if not proposal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"BRDP {brdp.identifier!r} has no Proposal yet -- Suggest Rule implements a decided Proposal.",
        )
    if UNFILLED_MARKER_RE.search(proposal):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"BRDP {brdp.identifier!r}'s Proposal still has unfilled placeholders -- fill them in first.",
        )
    if brdp.validation != "Validated":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"BRDP {brdp.identifier!r}'s Proposal is not Validated yet -- validate it before Suggest Rule.",
        )
    existing = await db.get(RuleApproval, (brdp.id, rule_format))
    if existing is not None and existing.status == "approved":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"BRDP {brdp.identifier!r} already has a Verified rule -- revoke it to Draft first.",
        )


def _rule_candidate(b: BRDP, rule_xml: str, score: float, source: str) -> SimilarCandidateOut:
    """A kind='rule' precedent is a "Proposal -> rule" PAIR (docs request):
    `text` is the rule_xml, `proposal` the Proposal it implements."""
    return SimilarCandidateOut(
        id=b.id,
        identifier=b.identifier,
        text=rule_xml,
        score=score,
        title=b.title or "",
        definition=b.definition,
        proposal=b.proposal,
        source=source,
        source_type="project",
        source_project=source,
    )


async def _get_rule_similar(
    db: AsyncSession,
    project: Project,
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    brdp: BRDP,
    rule_format: str,
    query_embedding: list[float],
) -> SimilarOut:
    """kind='rule' corpus (docs request, Suggest Rule round), four groups in
    order, never repeating a BRDP across them:

      - same_brdp: this BRDP's exact identifier in OTHER projects of the
        standard, with a Verified rule. Only when the identifier is a real
        catalog entry of the standard -- same reasoning as Suggest
        Proposal's same_brdp: an EXT-style auto-generated identifier can
        coincide across unrelated projects by pure chance, and this group
        is highlighted in red as "the same decision", so a coincidence
        would be actively misleading.
      - candidates ("similar"): Validated BRDPs of the standard (any
        project) with a Verified rule and similarity >= MIN_SIMILARITY, up
        to RULE_SIMILAR_LIMIT.
      - standard_fallback: only if the two groups above hold fewer than
        RULE_MIN_REFERENCES -- other Verified rules of the standard, most
        similar first even below MIN_SIMILARITY (no embedding sorts last),
        topping up to RULE_MIN_REFERENCES. Shown to the LLM as format
        examples, never as related decisions.
      - template_fallback: only if STILL short -- Verified rows of the
        standard's curated Excel template (rule_templates.py), same role.

    A trashed BRDP is never precedent (ACTIVE_BRDP_FILTER): its
    rule_approvals row survives a soft-delete, so the join alone wouldn't
    hide it.
    """
    is_catalog_brdp = (
        await db.execute(
            select(func.count())
            .select_from(BRDPCatalog)
            .where(BRDPCatalog.standard == project.standard, BRDPCatalog.identifier == brdp.identifier)
        )
    ).scalar_one() > 0

    def verified_rules_stmt(*columns):
        return (
            select(BRDP, RuleApproval.rule_xml, Project.name.label("project_name"), *columns)
            .join(Project, BRDP.project_id == Project.id)
            .where(ACTIVE_PROJECT_FILTER)
            .join(RuleApproval, (RuleApproval.brdp_id == BRDP.id) & (RuleApproval.format == rule_format))
            .where(
                Project.standard == project.standard,
                BRDP.id != brdp_id,
                RuleApproval.status == "approved",
                ACTIVE_BRDP_FILTER,
            )
        )

    # Precedent cleanup (Suggest Rule adjustments round): a stored rule is
    # only a precedent if it contains a rule element of the format
    # (rule_precedents.py) -- a <nonContextRule>-only rule is skipped, a
    # mixed one is reduced to its rule elements. Rows are therefore read a
    # page at a time until each group is full, so a skipped row never
    # leaves a group short while usable rows remain.
    async def usable_rows(stmt):
        offset = 0
        while True:
            page = (await db.execute(stmt.limit(_RULE_PAGE_SIZE).offset(offset))).all()
            for row in page:
                rule = extract_format_rules(row.rule_xml, rule_format)
                if rule is not None:
                    yield row, rule
            if len(page) < _RULE_PAGE_SIZE:
                return
            offset += _RULE_PAGE_SIZE

    used_ids: set[uuid.UUID] = set()

    same_brdp: list[SimilarCandidateOut] = []
    if is_catalog_brdp:
        same_stmt = verified_rules_stmt().where(Project.id != project_id, BRDP.identifier == brdp.identifier)
        async for row, rule in usable_rows(same_stmt.order_by(Project.name, BRDP.id)):
            same_brdp.append(_rule_candidate(row.BRDP, rule, 0.0, row.project_name))
            used_ids.add(row.BRDP.id)
            if len(same_brdp) >= RULE_SAME_BRDP_LIMIT:
                break

    distance_col = BRDP.embedding.cosine_distance(query_embedding).label("distance")

    similar_stmt = verified_rules_stmt(distance_col).where(
        BRDP.validation == "Validated", BRDP.embedding.is_not(None)
    )
    if used_ids:
        similar_stmt = similar_stmt.where(BRDP.id.not_in(used_ids))
    similar: list[SimilarCandidateOut] = []
    async for row, rule in usable_rows(similar_stmt.order_by(distance_col, BRDP.id)):
        similarity = 1 - row.distance
        if similarity < MIN_SIMILARITY:
            break  # ordered ascending by distance -- no later row can pass either
        similar.append(_rule_candidate(row.BRDP, rule, similarity, row.project_name))
        used_ids.add(row.BRDP.id)
        if len(similar) >= RULE_SIMILAR_LIMIT:
            break

    standard_fallback: list[SimilarCandidateOut] = []
    missing = RULE_MIN_REFERENCES - len(same_brdp) - len(similar)
    if missing > 0:
        fallback_stmt = verified_rules_stmt(distance_col)
        if used_ids:
            fallback_stmt = fallback_stmt.where(BRDP.id.not_in(used_ids))
        async for row, rule in usable_rows(fallback_stmt.order_by(distance_col.asc().nulls_last(), BRDP.id)):
            score = 0.0 if row.distance is None else 1 - row.distance
            standard_fallback.append(_rule_candidate(row.BRDP, rule, score, row.project_name))
            if len(standard_fallback) >= missing:
                break
        missing -= len(standard_fallback)

    template_fallback: list[SimilarCandidateOut] = []
    if missing > 0:
        already_shown = {c.text.strip() for c in (*same_brdp, *similar, *standard_fallback)}
        for entry in load_template_rules(project.standard):
            rule = extract_format_rules(entry.rule_xml, rule_format)
            if entry.identifier == brdp.identifier or rule is None or rule in already_shown:
                continue
            template_fallback.append(
                SimilarCandidateOut(
                    # Not a real BRDP -- a stable synthetic id, only ever
                    # used as a UI key (never sent back as precedent id).
                    id=uuid.uuid5(uuid.NAMESPACE_URL, f"brdp-template:{project.standard}:{entry.identifier}"),
                    identifier=entry.identifier,
                    text=rule,
                    score=0.0,
                    title=entry.title,
                    definition=entry.definition,
                    proposal=entry.proposal,
                    source="Template",
                    source_type="template",
                )
            )
            if len(template_fallback) >= missing:
                break

    # HR7 -- never silently degrade: a Validated BRDP in another project of
    # this standard with no embedding yet can't be ranked as "similar".
    excluded_pending_other_projects = (
        await db.execute(
            select(func.count())
            .select_from(BRDP)
            .join(Project, BRDP.project_id == Project.id)
            .where(ACTIVE_PROJECT_FILTER)
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
        kind="rule",
        sufficient_precedent=True,
        candidates=similar,
        same_brdp=same_brdp,
        standard_fallback=standard_fallback,
        template_fallback=template_fallback,
        message=None,
        format=rule_format,
        excluded_pending_other_projects=excluded_pending_other_projects,
    )
