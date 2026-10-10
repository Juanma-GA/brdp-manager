import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserProjectRole(Base):
    """Per-assignment role — a user can be `editor` on one project and
    `viewer` on another. This table (never a role on the JWT/client) is the
    only source of "what can this user do on this project" (see
    docs/v2/03-especificacion-v2-para-claude-code.md §4.1/§4.3), so that
    swapping the auth issuer for Keycloak later never touches authorization.
    """

    __tablename__ = "user_project_roles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    # "viewer" | "editor" — see §4.3 for the exact permission matrix.
    role: Mapped[str] = mapped_column(String, nullable=False)
