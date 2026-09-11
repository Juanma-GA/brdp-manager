import uuid

from sqlalchemy import String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BRDPCatalog(Base):
    """Official, per-standard BRDP catalog (docs request) -- global
    reference data, not scoped to any project. No proposal column: the
    catalog only ever ships identifier/title/definition, never a
    proposal (that's project-specific work). Populated by
    scripts/import_brdp_catalog.py, never written to from the API.
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
