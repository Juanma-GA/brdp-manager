import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ImportJob(Base):
    """One row per Excel import Apply run (docs request: Apply moved from a
    blocking request to a background job so navigating away and back, or
    closing the tab, doesn't lose progress -- Postgres is the only source
    of truth for "is an import running", never localStorage/sessionStorage,
    HR1).

    started_by is ON DELETE SET NULL, same audit-trail-resilient pattern as
    BRDPHistory.user_id: the job record (and its final status) must survive
    the acting user's account being deleted later.

    status is a plain string, not a DB enum, matching this project's
    existing convention for small closed vocabularies (see BRDP.validation,
    RuleApproval.status) -- application code is the single source of truth
    for the 3 legal values: "running" | "completed" | "failed".
    """

    __tablename__ = "import_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    started_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String, nullable=False, default="running")
    total_rows: Mapped[int] = mapped_column(Integer, nullable=False)
    processed_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    validated_rows_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # HR7: a failure must be visible and explained, never a silent
    # degradation -- this is that explanation, surfaced verbatim to the
    # user via the status endpoint/badge.
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # {created, updated, rejected, conflicts_kept, conflicts_cleared} once
    # status="completed" -- see ImportApplyResultSummary schema for why
    # this exists beyond the originally requested column list.
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
