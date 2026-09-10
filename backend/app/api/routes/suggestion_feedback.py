"""POST /api/suggestion-feedback -- docs/v2 §3 point 5, the feedback loop
that closes AACF's point 2 requirement ("sin esto no hay forma de validar
si el mecanismo de few-shot realmente mejora algo"). No analytics on top
of this yet -- reviewed manually after a month of real use.

Not nested under /api/projects/{project_id} (docs/v2 §4.2's endpoint
table lists it bare) -- its scope comes from `brdp_id` in the body, so
authorization has to look up that BRDP's project_id first rather than
binding to a project_id path param the way require_project_role does.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, has_project_role
from app.db.base import get_db
from app.models import BRDP, SuggestionFeedback, User
from app.schemas.suggestion_feedback import SuggestionFeedbackCreate, SuggestionFeedbackOut

router = APIRouter(prefix="/api/suggestion-feedback", tags=["suggestion-feedback"])


@router.post("", response_model=SuggestionFeedbackOut, status_code=status.HTTP_201_CREATED)
async def create_suggestion_feedback(
    body: SuggestionFeedbackCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SuggestionFeedback:
    brdp = await db.get(BRDP, body.brdp_id)
    if brdp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BRDP not found")

    # A discarded outcome never mutates the BRDP itself -- viewer-safe,
    # same as reading a rule_approvals row. But outcome='accepted' here is
    # a CLAIM that the caller actually accepted a suggestion, and the real
    # accept action (the BRDP field PUT, or the approvals PUT for a rule)
    # is editor-gated -- docs/v2 §4.3's "viewer can read BRDP Assistant
    # suggestions but the Accept button is disabled" rule, so logging
    # outcome='accepted' needs the same floor as accepting for real, or a
    # viewer could write a false "I accepted this" row into the feedback
    # table they were never allowed to act on.
    min_role = "editor" if body.outcome == "accepted" else "viewer"
    if not await has_project_role(current_user, brdp.project_id, min_role, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized for this project")

    feedback = SuggestionFeedback(
        brdp_id=body.brdp_id,
        kind=body.kind,
        suggested_text=body.suggested_text,
        source_brdp_ids=[str(bid) for bid in body.source_brdp_ids],
        outcome=body.outcome,
    )
    db.add(feedback)
    await db.commit()
    await db.refresh(feedback)
    return feedback
