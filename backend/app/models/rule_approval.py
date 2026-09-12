import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RuleApproval(Base):
    """Frozen, per-(brdp, format) generated rule snapshot — v1's
    `rule_approvals` table, unchanged in shape, only gains `project_id`
    scoping (via the brdp FK) and a UUID brdp_id.
    """

    __tablename__ = "rule_approvals"

    brdp_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("brdps.id", ondelete="CASCADE"), primary_key=True
    )
    # e.g. "BREX-4.2", "BREX-4.1", "BREX-3.0.1", "SCH-S1000D", "SCH-DITA"
    format: Mapped[str] = mapped_column(String, primary_key=True)
    rule_xml: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # "llm" | "manual"
    source: Mapped[str] = mapped_column(String, nullable=False, default="llm")
    # "pending_review" | "approved"
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending_review")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
