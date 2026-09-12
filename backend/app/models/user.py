import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
