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

    # viewer, not editor: logging feedback never mutates the BRDP itself
    # (the real accept action is a separate PUT, already editor-gated) --
    # a viewer using the BRDP Assistant read-only (docs/v2 §4.3) can still
    # discard/rate a suggestion they were shown.
    if not await has_project_role(current_user, brdp.project_id, "viewer", db):
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
