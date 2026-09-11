import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BRDPHistory(Base):
    """Real per-field audit trail (Option B) -- one row per field that
    actually changed value, never one row per save. Distinct from the
    unused `brdps.history` JSONB column (v1 leftover, left as-is for now;
    its removal is a separate dead-code cleanup round, not this one).

    user_id is ON DELETE SET NULL rather than CASCADE: history must
    survive the acting user's account being deleted later. user_email is
    a point-in-time snapshot so "who" still shows even once the user is
    gone.
    """

    __tablename__ = "brdp_history"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brdp_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("brdps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    user_email: Mapped[str] = mapped_column(String, nullable=False)
    # "identifier" | "title" | "definition" | "proposal" | "proposal_status" | "rule_status"
    field_name: Mapped[str] = mapped_column(String, nullable=False)
    old_value: Mapped[str] = mapped_column(Text, nullable=False)
    new_value: Mapped[str] = mapped_column(Text, nullable=False)
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
