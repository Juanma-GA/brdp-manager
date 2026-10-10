import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Project(Base):
    """Soft delete (AACF 2, Decisión 13), the same pattern as BRDP:
    deleted_at/deleted_by/deleted_by_email mark a project as moved to the
    Papelera without removing anything -- its BRDPs, rules, history and
    roles stay as they are, so a restore brings it back whole. Every read
    path goes through app/repositories/project_repository.py
    (ACTIVE_PROJECT_FILTER / get_active_project); only the Papelera's
    "Delete permanently" issues a real db.delete() (ON DELETE CASCADE).

    The name is not unique (it never was), so there is no index to make
    partial.
    """

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    # One of the 7 exact canonical strings the Create Project dropdown
    # offers (docs/v2 §2): "S1000D 3.0.1", "S1000D 4.1", "S1000D 4.2",
    # "S1000D 5.0", "S1000D 6.0", "DITA 1.3 Xpath2.0", "DITA 1.3 Xpath3.0"
    # — fixed at project creation. For the three real S1000D standards, the
    # Generate page offers a BREX / Schematron output selector (Schematron
    # is a deterministic conversion of a real BREX under the hood) fed by
    # the same approved rules either way; neither DITA standard has such a
    # selector (no BREX equivalent) -- the two DITA standards exist because
    # each BRDP's Rule is separately hand-authored native Schematron per
    # XPath flavor (no shared conversion step), only differing in the
    # assembled document's queryBinding attribute (generateSchematronDITA.js).
    standard: Mapped[str] = mapped_column(String, nullable=False)
    # Model Ident Code, Issue, language/country, security classification...
    # (v1's `config` key/value table, folded into one JSONB column per project).
    project_config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # NULL = active; set = in the Papelera (Settings > Papelera > Projects).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Point-in-time snapshot (same reasoning as BRDP.deleted_by_email).
    deleted_by_email: Mapped[str | None] = mapped_column(String, nullable=True)
