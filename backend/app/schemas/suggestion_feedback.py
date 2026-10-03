import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class SuggestionFeedbackCreate(BaseModel):
    brdp_id: uuid.UUID
    kind: Literal["definition", "proposal", "rule"]
    suggested_text: str
    # The (up to 10) BRDP ids /similar returned as few-shot precedent for
    # this particular suggestion -- kept even for a discarded outcome, so
    # a manual review later can see exactly what precedent produced a bad
    # suggestion, not just that one happened.
    source_brdp_ids: list[uuid.UUID] = []
    outcome: Literal["accepted", "discarded"]


class SuggestionFeedbackOut(BaseModel):
    id: uuid.UUID
    brdp_id: uuid.UUID
    kind: str
    suggested_text: str
    source_brdp_ids: list
    outcome: str
    created_at: datetime

    model_config = {"from_attributes": True}
