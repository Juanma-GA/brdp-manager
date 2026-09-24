import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.brdp import EMBEDDING_DIM


class BRDPCatalog(Base):
    """Official, per-standard BRDP catalog (docs request) -- global
    reference data, not scoped to any project. No proposal column: the
    catalog only ever ships identifier/title/definition, never a
    proposal (that's project-specific work). Populated by
    scripts/import_brdp_catalog.py, never written to from the API.

    embedding/embedding_text_hash: on-demand embeddings (docs request)
    cover the catalog too, same columns/on-demand model as BRDP -- the
    embedding_jobs background job computes both a project's own pending
    BRDPs AND its standard's catalog pending entries in one run; a
    catalog with nothing pending (the common case after its first run for
    a given standard) is skipped entirely, never recomputed for nothing.
    """

    __tablename__ = "brdp_catalog"
    __table_args__ = (
        UniqueConstraint("standard", "identifier", name="uq_brdp_catalog_standard_identifier"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    standard: Mapped[str] = mapped_column(String, nullable=False, index=True)
    identifier: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    definition: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Composed from title+definition only (embeddings.py's
    # catalog_embedding_text) -- the catalog has no proposal column at all.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    embedding_text_hash: Mapped[str | None] = mapped_column(String, nullable=True)
