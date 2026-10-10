import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SuggestionFeedback(Base):
    """Closes the loop on the similarity engine (§3 point 5): whether a
    Suggest Definition/Proposal/Rule suggestion built from the `/similar`
    few-shot examples was actually accepted or discarded. No analytics on
    top of this yet — reviewed manually after a month of real use before
    investing in tuning the mechanism.
    """

    __tablename__ = "suggestion_feedback"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brdp_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("brdps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # "definition" | "proposal" | "rule"
    kind: Mapped[str] = mapped_column(String, nullable=False)
    suggested_text: Mapped[str] = mapped_column(Text, nullable=False)
    # The (up to 10) BRDP ids used as few-shot precedent for this suggestion.
    source_brdp_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # "accepted" | "discarded"
    outcome: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
