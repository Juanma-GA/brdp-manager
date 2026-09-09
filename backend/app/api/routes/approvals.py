import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_project_role
from app.api.routes.brdps import _get_owned_brdp
from app.db.base import get_db
from app.models import RuleApproval, User
from app.schemas.rule_approval import RuleApprovalOut, RuleApprovalPropose

router = APIRouter(
    prefix="/api/projects/{project_id}/brdps/{brdp_id}/approvals/{format}", tags=["approvals"]
)


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
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleApproval:
    await _get_owned_brdp(project_id, brdp_id, db)
    status_value = "approved" if body.status == "approved" else "pending_review"
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is None:
        approval = RuleApproval(brdp_id=brdp_id, format=format)
        db.add(approval)
    approval.rule_xml = body.rule_xml
    approval.source = body.source
    approval.status = status_value
    approval.approved_at = datetime.now(timezone.utc) if status_value == "approved" else None
    await db.commit()
    await db.refresh(approval)
    return approval


@router.post("/approve", response_model=RuleApprovalOut)
async def approve_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    _editor: User = Depends(require_project_role("editor")),
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
    await db.commit()
    await db.refresh(approval)
    return approval


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_approval(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    format: str,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Covers both v1 actions that end up here: discarding a pending_review
    candidate, and revoking an already-approved rule -- same DELETE either
    way, editor+ only in both cases.
    """
    await _get_owned_brdp(project_id, brdp_id, db)
    approval = await db.get(RuleApproval, (brdp_id, format))
    if approval is not None:
        await db.delete(approval)
        await db.commit()
