import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    # One of the 7 exact canonical strings the Create Project dropdown
    # offers (docs/v2 §2): "BREX — S1000D 3.0.1", "BREX — S1000D 4.1",
    # "BREX — S1000D 4.2", "BREX — S1000D 5.0", "BREX — S1000D 6.0",
    # "Schematron 1.0 — S1000D", "Schematron 1.0 — DITA" — fixed at project
    # creation, never offered as a per-generation selector ("Generate
    # BREX/Schematron" generates directly in the project's standard).
    standard: Mapped[str] = mapped_column(String, nullable=False)
    # Model Ident Code, Issue, language/country, security classification...
    # (v1's `config` key/value table, folded into one JSONB column per project).
    project_config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
