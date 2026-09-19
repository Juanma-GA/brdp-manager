import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# Fixed row id -- this table is a true installation-wide singleton (one
# row, never one per project/user, unlike Project.project_config). GET/PUT
# always address this exact id rather than the app picking "the first
# row" or doing a find-or-create dance on every request; the 0009
# migration is the only place that ever INSERTs into this table.
SINGLETON_ID = uuid.UUID("00000000-0000-0000-0000-0000000a17a5")


class AppSettings(Base):
    """Installation-wide settings -- not scoped to any one project (unlike
    Project.project_config). The Apply/Import ETA figures moved here from
    project_config (see the previous round's migration 0007): HR8 (AACF --
    nothing hardcoded, thresholds/limits included) requires these to be
    configurable, but not "configurable separately per project" -- an
    Apply import costs the same per row everywhere (the same Mistral
    embedding call), so a copy of the same number duplicated into every
    project's project_config was never real per-project variance. One row
    here, edited from Settings, admin-only (see
    app/api/routes/app_settings.py), read by every project's Apply ETA
    calculation instead.

    updated_by is ON DELETE SET NULL, same audit-trail-resilient pattern
    as ImportJob.started_by / BRDPHistory.user_id: the settings row must
    survive the editing admin's account being deleted later.
    """

    __tablename__ = "app_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=lambda: SINGLETON_ID)
    apply_eta_ms_per_plain_row: Mapped[int] = mapped_column(Integer, nullable=False)
    apply_eta_ms_per_validated_row: Mapped[int] = mapped_column(Integer, nullable=False)
    apply_eta_validated_rows_threshold: Mapped[int] = mapped_column(Integer, nullable=False)
    apply_eta_warning_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
