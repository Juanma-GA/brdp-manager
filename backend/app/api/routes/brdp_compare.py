"""Comparar dos BRDP lado a lado: what the current BRDP can be compared with,
and the detail of the one chosen. Read-only; the view itself (diffs,
structural summary of the rules) is computed in the browser, without AI.

Permissions: viewer on the current project, and viewer on the project of
every BRDP returned (has_project_role -- the admin sees every project; the
Official Default is a project like any other). A project the user cannot
see is simply left out of the candidates, and its BRDP's detail answers
404, never 403, so its existence is not revealed.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import has_project_role, require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import BRDP, BRDPCatalog, Project, RuleApproval, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.repositories.project_repository import ACTIVE_PROJECT_FILTER
from app.schemas.brdp_compare import CompareCandidateOut, CompareCandidatesOut, CompareDetailOut
from app.schemas.rule_approval import RuleApprovalOut, rule_xml_hash
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT
from app.services.rule_extract_jobs import catalog_edition_labels

router = APIRouter(prefix="/api/projects/{project_id}/brdps/{brdp_id}", tags=["brdp-compare"])


def _rule_state(approval: RuleApproval | None) -> str:
    if approval is None:
        return "todo"
    return "verified" if approval.status == "approved" else "draft"


async def _approval_for(db: AsyncSession, brdp_id: uuid.UUID, standard: str) -> tuple[str | None, RuleApproval | None]:
    rule_format = STANDARD_TO_RULE_FORMAT.get(standard)
    if rule_format is None:
        return None, None
    return rule_format, await db.get(RuleApproval, (brdp_id, rule_format))


@router.get("/compare-candidates", response_model=CompareCandidatesOut)
async def get_compare_candidates(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    current_user: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> CompareCandidatesOut:
    """The same BRDP in other projects: same identifier, active (never in
    the Papelera), in a project the user can see. Only when the identifier
    is in the official catalog of THIS project's standard (or, failing
    that, of another S1000D edition: catalog_edition_labels) -- an EXT
    identifier is the project's own and can match another project's by
    chance (the same rule as Suggest Proposal/Rule's same_brdp). Projects
    of another standard are included; each candidate carries its standard.
    """
    brdp = await _get_owned_brdp(project_id, brdp_id, db)
    project = await db.get(Project, project_id)
    catalog_identifier = (
        await db.execute(
            select(func.count())
            .select_from(BRDPCatalog)
            .where(BRDPCatalog.standard == project.standard, BRDPCatalog.identifier == brdp.identifier)
        )
    ).scalar_one() > 0
    # An identifier only in another S1000D edition's catalog (the "4.1"
    # label) is just as official: the same identifier elsewhere is the same
    # decision, so other projects are searched too.
    if not catalog_identifier:
        catalog_identifier = bool(await catalog_edition_labels(project.standard, [brdp.identifier], db))

    same_brdp: list[CompareCandidateOut] = []
    if catalog_identifier:
        rows = (
            await db.execute(
                select(BRDP, Project)
                .join(Project, BRDP.project_id == Project.id)
                .where(ACTIVE_PROJECT_FILTER)
                .where(Project.id != project_id, BRDP.identifier == brdp.identifier, ACTIVE_BRDP_FILTER)
                .order_by(Project.name, BRDP.id)
            )
        ).all()
        allowed: dict[uuid.UUID, bool] = {}
        # The edition label of each candidate, under its own project's
        # standard: one lookup per standard, not per row.
        labels_by_standard: dict[str, dict[str, str]] = {}
        for other, other_project in rows:
            if other_project.id not in allowed:
                allowed[other_project.id] = await has_project_role(current_user, other_project.id, "viewer", db)
            if not allowed[other_project.id]:
                continue
            rule_format, approval = await _approval_for(db, other.id, other_project.standard)
            if other_project.standard not in labels_by_standard:
                labels_by_standard[other_project.standard] = await catalog_edition_labels(
                    other_project.standard, [brdp.identifier], db
                )
            same_brdp.append(
                CompareCandidateOut(
                    brdp_id=other.id,
                    project_id=other_project.id,
                    project_name=other_project.name,
                    standard=other_project.standard,
                    identifier=other.identifier,
                    catalog_edition=labels_by_standard[other_project.standard].get(other.identifier),
                    title=other.title or "",
                    validation=other.validation,
                    rule_format=rule_format,
                    rule_state=_rule_state(approval),
                    last_test_result=approval.last_test_result if approval else None,
                    last_test_up_to_date=(
                        approval.last_test_rule_hash == rule_xml_hash(approval.rule_xml)
                        if approval is not None and approval.last_test_result is not None
                        else None
                    ),
                )
            )
    return CompareCandidatesOut(
        identifier=brdp.identifier,
        standard=project.standard,
        catalog_identifier=catalog_identifier,
        same_brdp=same_brdp,
    )


@router.get("/compare-detail/{other_brdp_id}", response_model=CompareDetailOut)
async def get_compare_detail(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    other_brdp_id: uuid.UUID,
    current_user: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> CompareDetailOut:
    """The chosen BRDP -- of this project or of another one the user can
    see (also the current BRDP itself, for the left column). 404 when it
    does not exist, is in the Papelera, or is in a project the user has no
    role in (never 403: that would reveal the project exists).
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BRDP not found")
    other = (await db.execute(select(BRDP).where(BRDP.id == other_brdp_id, ACTIVE_BRDP_FILTER))).scalar_one_or_none()
    if other is None or not await has_project_role(current_user, other.project_id, "viewer", db):
        raise not_found
    other_project = await db.get(Project, other.project_id)
    rule_format, approval = await _approval_for(db, other.id, other_project.standard)
    return CompareDetailOut(
        brdp_id=other.id,
        project_id=other_project.id,
        project_name=other_project.name,
        standard=other_project.standard,
        identifier=other.identifier,
        catalog_edition=(await catalog_edition_labels(other_project.standard, [other.identifier], db)).get(other.identifier),
        title=other.title or "",
        definition=other.definition or "",
        proposal=other.proposal or "",
        validation=other.validation,
        comments=other.comments or "",
        rule_format=rule_format,
        rule=RuleApprovalOut.model_validate(approval) if approval is not None else None,
    )
