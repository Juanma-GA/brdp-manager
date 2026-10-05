import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class User(Base):
    """Soft delete (AACF 2, Decisión 13): a deleted user keeps the row
    (deleted_at/deleted_by/deleted_by_email), their project roles and the
    email History shows on their changes; they cannot log in or refresh a
    session (app/api/deps.py, routes/auth.py) and are out of every user list
    and role selector. Only "Delete permanently" (Settings > Users >
    Deleted users) removes the row. The email is unique among ACTIVE users
    only (partial unique index, as uq_brdps_project_id_identifier), so a
    deleted user's email is offered for a restore, never reused silently
    (routes/users.py create_user).
    """

    __tablename__ = "users"
    __table_args__ = (
        Index("ix_users_email", "email", unique=True, postgresql_where=text("deleted_at IS NULL")),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    # "admin" | "user" — global_role=admin is the ONLY thing that grants
    # Settings -> User Management, independent of any per-project role
    # (see docs/v2/03-especificacion-v2-para-claude-code.md §4.3).
    global_role: Mapped[str] = mapped_column(String, nullable=False, default="user")
    # True right after Create user or an admin's Reset password (both set a
    # random temporary password, docs request) -- the frontend forces the
    # Change Password screen, blocking every other route, until a
    # successful POST /api/auth/change-password clears this back to False.
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # NULL = no preference chosen yet -- the frontend falls back to its
    # existing default ('en') exactly as it did before this column
    # existed, for both pre-migration accounts and newly created ones
    # that haven't touched the language switcher yet (docs request: this
    # column intentionally has no DB-level default that would erase that
    # distinction). "en" | "es", the only two languages this app ships.
    preferred_language: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # NULL = active; set = deleted (Settings > Users > Deleted users).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    deleted_by_email: Mapped[str | None] = mapped_column(String, nullable=True)
