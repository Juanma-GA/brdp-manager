import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# mistral-embed's current output dimension (docs/v2 §3 point 6). Fixed once
# rows exist — changing it means a migration + re-embedding every BRDP, not
# just a config flag.
EMBEDDING_DIM = 1024


class BRDP(Base):
    """Soft-delete (Papelera/Trash, docs request): deleted_at/deleted_by/
    deleted_by_email mark a row as trashed without removing it -- every
    read path that shouldn't see a trashed BRDP goes through
    app/repositories/brdp_repository.py's active-only helpers rather than
    querying this table directly. Only the Trash's "Delete permanently"
    action ever issues a real db.delete() against this table.
    """

    __tablename__ = "brdps"
    __table_args__ = (
        # identifier only needs to be unique WITHIN a project -- the same
        # identifier string is valid in two different projects (each
        # project is its own independent BRDP dataset), so this is
        # deliberately a composite constraint, never a bare unique on
        # identifier alone. Partial (WHERE deleted_at IS NULL), not a plain
        # UniqueConstraint -- Postgres doesn't support a conditional
        # UniqueConstraint, only a conditional unique Index -- so a trashed
        # BRDP's identifier becomes available again for a brand-new BRDP in
        # the same project (docs request: "borrar y crear otra con el mismo
        # identifier debe permitirlo"), while still enforcing real
        # uniqueness among the rows anyone can actually see/use.
        Index(
            "uq_brdps_project_id_identifier",
            "project_id",
            "identifier",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
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
    # Computed on demand by the embedding_jobs background job (never on
    # create/update/import any more -- see app/services/embedding_jobs.py),
    # from title+definition+proposal (embeddings.py's brdp_embedding_text).
    # NULL until a Validated BRDP has actually been through that job at
    # least once, so a similarity query naturally excludes never-embedded
    # rows -- same guarantee as before, just populated on a different
    # schedule.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    # The SHA-256 hex digest of the exact text that was embedded, set
    # alongside `embedding` by the SAME job run, never independently --
    # this is "what got embedded", not "what should be embedded right
    # now". A row is pending re-embedding whenever this hash no longer
    # matches a hash computed fresh from the BRDP's CURRENT title/
    # definition/proposal (embedding_jobs.py's is_pending) -- editing the
    # title after validation is exactly the case this is for: the stored
    # embedding is now stale even though `embedding` itself is still a
    # real (non-NULL) vector.
    embedding_text_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    # NULL = active/visible everywhere; set = trashed (Settings > Papelera).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Point-in-time snapshot, same reasoning as BRDPHistory.user_email: the
    # Papelera's "who deleted this" column must keep working after the
    # deleting user's account is gone (deleted_by alone would go NULL).
    deleted_by_email: Mapped[str | None] = mapped_column(String, nullable=True)
