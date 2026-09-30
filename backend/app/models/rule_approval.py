import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RuleApproval(Base):
    """Frozen, per-(brdp, format) generated rule snapshot — v1's
    `rule_approvals` table, unchanged in shape, only gains `project_id`
    scoping (via the brdp FK) and a UUID brdp_id.
    """

    __tablename__ = "rule_approvals"

    brdp_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("brdps.id", ondelete="CASCADE"), primary_key=True
    )
    # e.g. "BREX-4.2", "BREX-4.1", "BREX-3.0.1", "SCH-S1000D", "SCH-DITA"
    format: Mapped[str] = mapped_column(String, primary_key=True)
    rule_xml: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # "llm" | "manual" | "external_llm" -- see app/schemas/rule_approval.py's RuleSource.
    source: Mapped[str] = mapped_column(String, nullable=False, default="llm")
    # "pending_review" | "approved"
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending_review")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # The last "Test rule" run on this rule (Test de reglas T3). Nullable
    # together: all NULL = never tested. last_test_rule_hash is the SHA-256
    # hex digest of the rule_xml that was tested -- when it no longer
    # matches the current rule_xml the test is outdated (the rule changed
    # since), which RuleApprovalOut reports as last_test_up_to_date=False.
    # "passed" | "review" | "failed" | "inconclusive" | "not_executable"
    last_test_result: Mapped[str | None] = mapped_column(String, nullable=True)
    # {"code": ..., "params": {...}} -- a code, never a sentence, so the
    # UI shows it in the viewer's own language (see RuleTestReason).
    last_test_reason: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    last_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_test_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    last_test_rule_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # A passed test the user got to "Correct" by editing examples by hand
    # after the recorded test had failed / was inconclusive / had nothing
    # runnable: [{"label", "xml"}] -- each edited example as it was run.
    # NULL for a test recorded from the examples as the LLM wrote them.
    last_test_edited_examples: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # The last test of this rule that PASSED, with its examples (Test de
    # reglas: guardar la prueba aprobada): {"at", "rule_xml", "rule_hash",
    # "proposal", "examples_from", "edited_count", "examples": [{"label",
    # "expected", "schema", "xml", "skeleton_node_paths", "result",
    # "matches"}]}. Replaced by the next passed test, left alone by any other
    # result -- so a failed test never loses the evidence of the last pass,
    # and "Probar con los ejemplos guardados" can re-run it after the rule
    # changes. NULL: no passed test has been recorded with its examples.
    last_passed_test: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
