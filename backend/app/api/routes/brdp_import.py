import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_httpx_transport, require_project_role
from app.api.routes.approvals import _rule_state, _xml_well_formed_error
from app.api.routes.brdp_catalog import _resolve_catalog_standard
from app.api.routes.brdps import _HISTORY_FIELDS, _compute_brdp_embedding
from app.db.base import get_db
from app.models import BRDP, BRDPCatalog, Project, RuleApproval, User
from app.schemas.brdp_import import (
    ImportAnalyzeRequest,
    ImportAnalyzeResponse,
    ImportApplyRequest,
    ImportApplyResponse,
    ImportApplyRowResult,
    ImportRowIn,
    ImportRowResult,
)
from app.services.history import record_change
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT

router = APIRouter(prefix="/api/projects/{project_id}/brdps/import", tags=["brdp-import"])

# The only 3 legal Rule Status values -- exactly the display strings
# RecordsPage/Export to Excel already use (records.rule.states.* in
# en/es), never the internal DB tokens ("pending_review"/"approved").
_VALID_RULE_STATUSES = {"To Do", "Draft", "Verified"}


async def _get_owned_project(project_id: uuid.UUID, db: AsyncSession) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


def _classify_row(
    row: ImportRowIn,
    rule_format: str | None,
    existing_brdp: BRDP | None,
    existing_approval: RuleApproval | None,
    catalog_entry: BRDPCatalog | None,
) -> ImportRowResult:
    """Pure function, no DB access -- every business rule from the docs
    request lives here, in the exact priority order confirmed with the
    user: identifier present -> Rule Status is one of the 3 legal values
    -> (no rule format at all for this standard) -> well-formed XML (a
    hard technical defect, checked before any Rule/Rule Status mismatch
    logic) -> Rule/Rule Status combination -> finally, the one case that
    is a real DB conflict rather than a validation rejection. A catalog
    match (docs request) is layered on top at the very end, as a WARNING
    rather than another rejection branch: it only ever matters for a row
    that's going to be applied at all (ok or conflict), never for one
    that's already rejected for an unrelated reason.
    """
    identifier = row.identifier.strip()
    if not identifier:
        return ImportRowResult(row_number=row.row_number, identifier="", outcome="rejected", reason="Missing identifier")

    rule_status = row.rule_status
    rule_xml = row.rule.strip()

    if rule_status not in _VALID_RULE_STATUSES:
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="rejected",
            reason=f"Invalid Rule Status value {row.rule_status!r} -- must be exactly 'To Do', 'Draft', or 'Verified'",
        )

    # This project's standard has no rule-approval format at all (e.g.
    # Schematron 1.0 -- DITA) -- there is nothing a Rule/Rule Status
    # column could legitimately claim, so any row that tries is rejected
    # rather than silently ignored.
    if rule_format is None and (rule_xml or rule_status != "To Do"):
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="rejected",
            reason="This project's standard has no rule format -- Rule must be empty and Rule Status must be 'To Do'",
        )

    if rule_xml:
        xml_error = _xml_well_formed_error(rule_xml)
        if xml_error is not None:
            return ImportRowResult(
                row_number=row.row_number,
                identifier=identifier,
                outcome="rejected",
                reason=f"Rule is not well-formed XML: {xml_error}",
            )
        if rule_status == "To Do":
            return ImportRowResult(
                row_number=row.row_number,
                identifier=identifier,
                outcome="rejected",
                reason="Rule has XML content but Rule Status is 'To Do' (claims no rule exists, but one does)",
            )
    elif rule_status in ("Draft", "Verified"):
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="rejected",
            reason=f"Rule Status is {rule_status!r} but Rule is empty (claims a rule that doesn't exist)",
        )

    action = "update" if existing_brdp is not None else "create"

    # The one combination that is a real DB conflict, not a validation
    # failure: the file says "no rule" but this BRDP already has a real
    # (non-todo) one in Postgres. A brand-new BRDP (existing_approval is
    # always None) can never hit this -- there is nothing yet to conflict
    # with.
    if rule_status == "To Do" and not rule_xml and existing_approval is not None:
        # _rule_state can only return "draft"/"verified" here -- "todo" is
        # exactly the absence of a row, and existing_approval is not None.
        return ImportRowResult(
            row_number=row.row_number,
            identifier=identifier,
            outcome="conflict",
            action=action,
            existing_rule_status=_rule_state(existing_approval).capitalize(),
            catalog_override=catalog_entry is not None,
        )

    return ImportRowResult(
        row_number=row.row_number, identifier=identifier, outcome="ok", action=action, catalog_override=catalog_entry is not None
    )


async def _load_existing(
    project_id: uuid.UUID, rows: list[ImportRowIn], rule_format: str | None, db: AsyncSession
) -> tuple[dict[str, BRDP], dict[uuid.UUID, RuleApproval]]:
    """Two batch queries total, regardless of how many rows the file has --
    never N+1 per row.
    """
    identifiers = [r.identifier.strip() for r in rows if r.identifier.strip()]
    existing_brdps: dict[str, BRDP] = {}
    if identifiers:
        result = await db.execute(select(BRDP).where(BRDP.project_id == project_id, BRDP.identifier.in_(identifiers)))
        for b in result.scalars().all():
            existing_brdps[b.identifier] = b

    existing_approvals: dict[uuid.UUID, RuleApproval] = {}
    if rule_format and existing_brdps:
        brdp_ids = [b.id for b in existing_brdps.values()]
        result = await db.execute(
            select(RuleApproval).where(RuleApproval.brdp_id.in_(brdp_ids), RuleApproval.format == rule_format)
        )
        for a in result.scalars().all():
            existing_approvals[a.brdp_id] = a

    return existing_brdps, existing_approvals


async def _load_catalog(
    rows: list[ImportRowIn], catalog_standard: str, db: AsyncSession
) -> dict[str, BRDPCatalog]:
    """One batch query, exactly like _load_existing above -- never N+1.
    catalog_standard is already resolved (see _resolve_catalog_standard):
    "Schematron 1.0 -- S1000D" shares its catalog with "BREX -- S1000D
    3.0.1" rather than having its own, so the lookup has to go through the
    same alias Create Project's own catalog count/seed already uses, or a
    Schematron project would never match anything.
    """
    identifiers = [r.identifier.strip() for r in rows if r.identifier.strip()]
    catalog_by_identifier: dict[str, BRDPCatalog] = {}
    if identifiers:
        result = await db.execute(
            select(BRDPCatalog).where(
                BRDPCatalog.standard == catalog_standard, BRDPCatalog.identifier.in_(identifiers)
            )
        )
        for entry in result.scalars().all():
            catalog_by_identifier[entry.identifier] = entry
    return catalog_by_identifier


async def _analyze(
    project_id: uuid.UUID, rows: list[ImportRowIn], db: AsyncSession
) -> tuple[Project, str | None, list[ImportRowResult], dict[str, BRDP], dict[uuid.UUID, RuleApproval], dict[str, BRDPCatalog]]:
    project = await _get_owned_project(project_id, db)
    rule_format = STANDARD_TO_RULE_FORMAT.get(project.standard)
    existing_brdps, existing_approvals = await _load_existing(project_id, rows, rule_format, db)
    catalog_by_identifier = await _load_catalog(rows, _resolve_catalog_standard(project.standard), db)

    results = []
    for row in rows:
        identifier = row.identifier.strip()
        existing_brdp = existing_brdps.get(identifier)
        existing_approval = existing_approvals.get(existing_brdp.id) if existing_brdp is not None else None
        catalog_entry = catalog_by_identifier.get(identifier)
        results.append(_classify_row(row, rule_format, existing_brdp, existing_approval, catalog_entry))
    return project, rule_format, results, existing_brdps, existing_approvals, catalog_by_identifier


@router.post("/analyze", response_model=ImportAnalyzeResponse)
async def analyze_import(
    project_id: uuid.UUID,
    body: ImportAnalyzeRequest,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> ImportAnalyzeResponse:
    """Phase 1 (docs request): pure classification, no writes to Postgres
    at all -- exists only to build the confirmation summary the user
    reviews before Apply. Editor-gated like every other BRDP write path
    even though this call itself never mutates anything, since its only
    purpose is to prepare an /apply call.
    """
    _project, _rule_format, results, _existing_brdps, _existing_approvals, _catalog = await _analyze(
        project_id, body.rows, db
    )
    return ImportAnalyzeResponse(results=results)


@router.post("/apply", response_model=ImportApplyResponse)
async def apply_import(
    project_id: uuid.UUID,
    body: ImportApplyRequest,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> ImportApplyResponse:
    """Phase 2 (docs request): re-runs the exact same classification as
    /analyze against CURRENT Postgres state -- never trusts a
    classification computed by the client at analyze time, so a row
    someone else changed in between (e.g. approved a rule mid-review)
    gets reclassified fresh rather than acted on stale. Rejected rows are
    skipped entirely: nothing about them is written, not even
    Title/Definition/Proposal/Proposal Status.
    """
    if body.conflict_resolution not in ("keep", "clear"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="conflict_resolution must be 'keep' or 'clear'"
        )

    _project, rule_format, results, existing_brdps, existing_approvals, catalog_by_identifier = await _analyze(
        project_id, body.rows, db
    )
    rows_by_number = {r.row_number: r for r in body.rows}

    apply_results: list[ImportApplyRowResult] = []
    created = updated = rejected = conflicts_kept = conflicts_cleared = 0

    for result in results:
        if result.outcome == "rejected":
            rejected += 1
            apply_results.append(
                ImportApplyRowResult(
                    row_number=result.row_number, identifier=result.identifier, outcome="rejected", reason=result.reason
                )
            )
            continue

        row = rows_by_number[result.row_number]
        identifier = row.identifier.strip()
        brdp = existing_brdps.get(identifier)
        # Catalog match (docs request): Title/Definition come from the
        # catalog, never the file, for this identifier -- Proposal/
        # Proposal Status/Rule/Rule Status are untouched by the catalog
        # and stay exactly what the row says.
        catalog_entry = catalog_by_identifier.get(identifier)
        title = catalog_entry.title if catalog_entry is not None else row.title
        definition = catalog_entry.definition if catalog_entry is not None else row.definition

        if brdp is None:
            brdp = BRDP(
                project_id=project_id,
                identifier=identifier,
                title=title,
                definition=definition,
                proposal=row.proposal,
                validation=row.proposal_status,
            )
            db.add(brdp)
            # id is a Python-side default (uuid.uuid4) -- SQLAlchemy only
            # applies it at flush, so a rule_approvals row below (which
            # needs a real brdp_id) requires flushing first.
            await db.flush()
            if brdp.validation == "Validated":
                brdp.embedding = await _compute_brdp_embedding(brdp, transport)
            created += 1
            outcome = "created"
        else:
            was_validated = brdp.validation == "Validated"
            old_values = {field: getattr(brdp, field) for field in _HISTORY_FIELDS}
            brdp.title = title
            brdp.definition = definition
            brdp.proposal = row.proposal
            brdp.validation = row.proposal_status
            for field, history_name in _HISTORY_FIELDS.items():
                record_change(db, brdp.id, editor, history_name, old_values[field], getattr(brdp, field))
            if brdp.validation == "Validated":
                brdp.embedding = await _compute_brdp_embedding(brdp, transport)
            elif was_validated:
                brdp.embedding = None
            updated += 1
            outcome = "updated"

        if result.outcome == "conflict":
            existing_approval = existing_approvals.get(brdp.id)
            if body.conflict_resolution == "keep":
                conflicts_kept += 1
                outcome = f"{outcome}_conflict_kept"
                # Explicitly leave the existing rule_approvals row alone.
            else:
                if existing_approval is not None:
                    old_state = _rule_state(existing_approval)
                    await db.delete(existing_approval)
                    record_change(db, brdp.id, editor, "rule_status", old_state, "todo")
                conflicts_cleared += 1
                outcome = f"{outcome}_conflict_cleared"
        elif row.rule.strip():
            # A genuine ok row that asserts a real rule (Draft or
            # Verified, XML already confirmed well-formed by _classify_row
            # above) -- upsert rule_approvals exactly like propose_approval
            # does for the manual-editor path, "manual" source since this
            # is human-authored/reviewed content arriving via Excel, never
            # LLM output.
            new_status = "approved" if row.rule_status == "Verified" else "pending_review"
            existing_approval = existing_approvals.get(brdp.id)
            old_state = _rule_state(existing_approval)
            if existing_approval is None:
                existing_approval = RuleApproval(brdp_id=brdp.id, format=rule_format)
                db.add(existing_approval)
            existing_approval.rule_xml = row.rule
            existing_approval.source = "manual"
            existing_approval.status = new_status
            existing_approval.approved_at = datetime.now(timezone.utc) if new_status == "approved" else None
            record_change(db, brdp.id, editor, "rule_status", old_state, _rule_state(existing_approval))
        # else: rule empty + To Do + no pre-existing approval (conflict
        # already covers the "had one, file clears it" case above) --
        # genuinely nothing to do for the rule.

        apply_results.append(ImportApplyRowResult(row_number=result.row_number, identifier=identifier, outcome=outcome))

    await db.commit()
    return ImportApplyResponse(
        results=apply_results,
        created=created,
        updated=updated,
        rejected=rejected,
        conflicts_kept=conflicts_kept,
        conflicts_cleared=conflicts_cleared,
    )
