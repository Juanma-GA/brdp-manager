import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# mistral-embed's current output dimension (docs/v2 §3 point 6). Fixed once
# rows exist — changing it means a migration + re-embedding every BRDP, not
# just a config flag.
EMBEDDING_DIM = 1024


class BRDP(Base):
    __tablename__ = "brdps"
    __table_args__ = (
        # identifier only needs to be unique WITHIN a project -- the same
        # identifier string is valid in two different projects (each
        # project is its own independent BRDP dataset), so this is
        # deliberately a composite constraint, never a bare unique on
        # identifier alone.
        UniqueConstraint("project_id", "identifier", name="uq_brdps_project_id_identifier"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    identifier: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    definition: Mapped[str] = mapped_column(Text, nullable=False, default="")
    proposal: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # "Pending" | "Validated" | "Refused"
    validation: Mapped[str] = mapped_column(String, nullable=False, default="Pending")
    comments: Mapped[str] = mapped_column(Text, nullable=False, default="")
    history: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # Populated/refreshed only when validation == 'Validated' (see §3 point 1
    # — computed from definition+proposal). NULL until then, so a similarity
    # query naturally excludes never-validated and not-yet-embedded rows.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
