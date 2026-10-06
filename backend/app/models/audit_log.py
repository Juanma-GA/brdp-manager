import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

_ACTIONS_SQL = (
    "action IN ('brdp.deleted_permanently', 'project.trashed', 'project.restored', "
    "'project.deleted_permanently', 'user.created', 'user.updated', 'user.password_reset', "
    "'user.trashed', 'user.restored', 'user.deleted_permanently', 'project_role.assigned', "
    "'project_role.changed', 'project_role.removed')"
)
_TARGET_TYPES_SQL = "target_type IN ('brdp', 'project', 'user', 'project_role')"


class AuditLog(Base):
    """One administrative action (Protecciones 2b): who did it, to what,
    and when. actor_id, target_id and project_id have no foreign key
    (migration 0028): the row outlives the user, the project and the BRDP
    it names, so labels and emails are stored as they were.
    """

    __tablename__ = "audit_log"
    __table_args__ = (
        CheckConstraint(_ACTIONS_SQL, name="ck_audit_log_action"),
        CheckConstraint(_TARGET_TYPES_SQL, name="ck_audit_log_target_type"),
        Index("ix_audit_log_created_at", "created_at"),
        Index("ix_audit_log_target", "target_type", "target_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    actor_email: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    target_type: Mapped[str] = mapped_column(String, nullable=False)
    target_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    target_label: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    project_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    detail: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}", default=dict)
