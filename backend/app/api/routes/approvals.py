import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from lxml import etree
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import BRDP, RuleApproval, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.schemas.rule_approval import (
    BulkRuleApprovalOut,
    BulkRuleApprovalWithRuleOut,
    RuleApprovalOut,
    RuleApprovalPropose,
)
from app.services.history import record_change

router = APIRouter(
    prefix="/api/projects/{project_id}/brdps/{brdp_id}/approvals/{format}", tags=["approvals"]
)

# Separate router (no {brdp_id} segment) for the project-wide bulk lookup
# below -- APIRouter's prefix is fixed at construction, so it can't share
# `router` above.
project_router = APIRouter(prefix="/api/projects/{project_id}/approvals/{format}", tags=["approvals"])


def _project_approvals_stmt(project_id: uuid.UUID, format: str):
    """Shared by both bulk endpoints below -- the only difference between
    them is the response model (whether rule_xml is serialized out), never
    the query itself. ACTIVE_BRDP_FILTER: a trashed BRDP's rule_approvals
    row is left alive by a soft-delete (docs request), but must not
    surface here -- this feeds both RecordsPage's Rule Status column AND
    Export to Excel, both of which a deleted BRDP must disappear from.
    """
    return (
        select(RuleApproval)
        .join(BRDP, RuleApproval.brdp_id == BRDP.id)
        .where(BRDP.project_id == project_id, RuleApproval.format == format, ACTIVE_BRDP_FILTER)
    )


@project_router.get("", response_model=list[BulkRuleApprovalOut])
async def list_project_approvals(
    project_id: uuid.UUID,
    format: str,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> list[RuleApproval]:
    """Every rule-approval row for this project+format in one call -- powers
    RecordsPage's Rule Status column sort, which needs every row's status
    up front to sort the FULL dataset before pagination, not just fetch
    each visible row's own status independently the way RuleStatusCell
    does for display. A BRDP absent from the result has no approval row
    at all (frontend's ruleStateOf(null) => "todo", same convention the
    per-BRDP GET endpoint above already uses).
    """
    result = await db.execute(_project_approvals_stmt(project_id, format))
    return list(result.scalars().all())


@project_router.get("/export", response_model=list[BulkRuleApprovalWithRuleOut])
async def list_project_approvals_for_export(
    project_id: uuid.UUID,
    format: str,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> list[RuleApproval]:
    """Same query as list_project_approvals above, but also returns
    rule_xml -- Project Configuration's Export to Excel needs the actual
    rule text for its Rule column (docs request), which the lean bulk
    endpoint deliberately omits. This is the JOIN with rule_approvals that
    export didn't have before: brdpToExportRow (ProjectConfigPage.jsx)
    looks up each BRDP's row here by brdp_id, same "absent row -> todo,
    empty rule" convention as everywhere else.
    """
    result = await db.execute(_project_approvals_stmt(project_id, format))
    return list(result.scalars().all())


def _rule_state(approval: RuleApproval | None) -> str:
    """Mirrors the frontend's ruleStateOf()/RULE_STATES (RecordsPage.jsx)
    exactly, "todo" included (no underscore -- matches the i18n table's
    records.rule.states.todo key, so the History section's formatHistoryValue()
    can translate it the same way the live stepper does). "todo" is not a
    DB value, it's the absence of a row. Used only to compute the
    audit-trail transition; never persisted on RuleApproval itself.
    """
    if approval is None:
        return "todo"
    return "verified" if approval.status == "approved" else "draft"


# Matches a qualified-name-shaped `prefix:local` occurrence (tag or
# attribute name) -- deliberately requires a letter/underscore start on
# BOTH sides so it can't mistake something like a bare "12:34" for a
# namespace prefix (an NCName can't start with a digit). See
# _wrap_rule_xml_fragment() for why this is needed.
_QNAME_RE = re.compile(r"\b([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)")


def _wrap_rule_xml_fragment(xml_text: str) -> str:
    """Wraps a Rule XML fragment in a throwaway <root> for parsing -- a
    rule_xml value here is always a fragment, never a full <?xml ...?>
    document, and since the rulesContext round it can legitimately have
    multiple XML-sibling roots (a loose structureObjectRule alongside one
    or more complete <contextRules rulesContext="..."> blocks in the same
    cell, e.g. BRDP-S1-00006). Confirmed empirically that lxml's
    etree.fromstring() otherwise rejects that with "Extra content at the
    end of the document" -- wrapping fixes it.

    Also declares (with a dummy, well-formedness-only URI) any namespace
    prefix the fragment actually USES but never declares itself --
    confirmed empirically necessary for real native Schematron content
    (<sch:pattern>/<sch:rule>/<sch:assert>): generateSchematronDITA.js's
    finalizeSchematronDocument() only ever declares xmlns:sch on the outer
    <sch:schema> wrapper, so an approved rule_xml fragment is only valid
    XML once embedded there -- checked standalone (here, or in
    _rule_xml_structurally_equal in import_jobs.py) it would otherwise
    fail with "Namespace prefix sch is not defined" even though the exact
    same content is perfectly well-formed in its real, final context.
    Detected generically by scanning for any `prefix:name` usage rather
    than hardcoding "sch" specifically -- so it also covers a BREX
    document using another prefix (e.g. "ns2", see brexToSchematron.js's
    _buildHeader for the same idea applied to a full assembled document
    instead of one fragment), and costs nothing for a prefix-free BREX
    fragment (no match -> no extra declaration, unchanged from before).
    """
    prefixes = {m.group(1) for m in _QNAME_RE.finditer(xml_text)} - {"xml", "xmlns"}
    ns_decls = "".join(f' xmlns:{p}="urn:x-wellformed-check:{p}"' for p in sorted(prefixes))
    return f"<root{ns_decls}>{xml_text}</root>"


def _xml_well_formed_error(xml_text: str) -> str | None:
    """Well-formedness only -- not a full XSD validation (that already
    happens later, in the browser, against the actual generated document).
    This exists because the manual rule editor is a NEW write path into
    rule_approvals that bypasses the generation engine entirely, so it
    also bypasses the engine's own checkWellFormed() safety net -- without
    this, a broken tag saved here would surface silently, later, inside a
    generated BREX/Schematron document instead of at save time. Mirrors
    the frontend's checkWellFormed() (src/api/generateBREX.js) so the API
    enforces the same rule even for a caller that skips the UI.

    See _wrap_rule_xml_fragment() for the fragment-wrapping/namespace
    details.
    """
    try:
        wrapped = xml_text if xml_text.lstrip().startswith("<?xml") else _wrap_rule_xml_fragment(xml_text)
        etree.fromstring(wrapped.encode("utf-8"))
        return None
    except etree.XMLSyntaxError as exc:
        return str(exc)


@router.get("", response_model=RuleApprovalOut | None)
async def get_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval | None:
    """Read-only for viewer -- §4.3: viewer can see a project's rule
    approvals, just never propose/approve/revoke one (see the editor-gated
    endpoints below).
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    return await db.get(RuleApproval, (brdp_id, format))


@router.put("", response_model=RuleApprovalOut)
async def propose_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    body: RuleApprovalPropose,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    await _get_owned_brdp(project_id, brdp_id, db)
    xml_error = _xml_well_formed_error(body.rule_xml)
    if xml_error is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"rule_xml is not well-formed XML: {xml_error}",
        )
    status_value = "approved" if body.status == "approved" else "pending_review"
    approval = await db.get(RuleApproval, (brdp_id, format))
    old_state = _rule_state(approval)
    if approval is None:
        approval = RuleApproval(brdp_id=brdp_id, format=format)
        db.add(approval)
    approval.rule_xml = body.rule_xml
    approval.source = body.source
    approval.status = status_value
    approval.approved_at = datetime.now(timezone.utc) if status_value == "approved" else None
    record_change(db, brdp_id, editor, "rule_status", old_state, _rule_state(approval))
    await db.commit()
    await db.refresh(approval)
    return approval


@router.post("/approve", response_model=RuleApprovalOut)
async def approve_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is None or approval.status != "pending_review":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No pending_review approval found for this BRDP/format",
        )
    approval.status = "approved"
    approval.approved_at = datetime.now(timezone.utc)
    record_change(db, brdp_id, editor, "rule_status", "draft", "verified")
    await db.commit()
    await db.refresh(approval)
    return approval


@router.post("/revoke", response_model=RuleApprovalOut)
async def revoke_approval_status(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    """Rule Status stepper's Verified -> Draft action: flips an approved
    rule back to pending_review while PRESERVING rule_xml/source -- unlike
    the DELETE endpoint below, nothing is deleted, so the text that was
    actually reviewed is never lost. This is intentional (docs request
    item 2): Edit is unavailable directly on an approved rule precisely so
    a Verified rule can never end up with different text than what was
    reviewed, without needing auto-revocation logic on edit.
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is None or approval.status != "approved":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No approved approval found for this BRDP/format",
        )
    approval.status = "pending_review"
    approval.approved_at = None
    record_change(db, brdp_id, editor, "rule_status", "verified", "draft")
    await db.commit()
    await db.refresh(approval)
    return approval


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def discard_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Full delete of the row, editor+ only. Distinct from POST /revoke
    above: this discards the rule entirely (v1's "discard a pending_review
    candidate" action), it does not just flip status back while keeping
    the text.
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is not None:
        await db.delete(approval)
        await db.commit()
