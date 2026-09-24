import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class EmbeddingJob(Base):
    """One row per on-demand "Compute embeddings" run (docs request) --
    same pattern as ImportJob (background execution, progress polled from
    Postgres, single running job per project, stale-job reap,
    CancelledError handling), applied to embeddings instead of Excel
    import now that computing an embedding is no longer something create/
    update/import do inline.

    A run covers BOTH this project's own pending Validated BRDPs AND its
    standard's catalog pending entries -- one job, one progress bar,
    total_items/processed_items count the two together (the docs request
    scopes launching the job to "editores del proyecto", not to a
    separate catalog concept the UI would need to track independently).

    started_by is ON DELETE SET NULL, same audit-trail-resilient pattern
    as ImportJob.started_by.
    """

    __tablename__ = "embedding_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    started_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String, nullable=False, default="running")
    total_items: Mapped[int] = mapped_column(Integer, nullable=False)
    processed_items: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # HR7: a failure must be visible and explained, never silently
    # dropped -- surfaced verbatim via the status endpoint.
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # {brdps_embedded, catalog_embedded} once status="completed".
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
