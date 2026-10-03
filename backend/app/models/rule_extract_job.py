import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RuleExtractJob(Base):
    """AI Extract (1/2): one row per BREX/Schematron read into a project.

    Parsing and classifying run in the background (a 5,500-rule BREX takes
    seconds, plus the embeddings call for the duplicate check), with
    progress, like the Excel import (ImportJob). Postgres is the only state:
    the candidates live in rule_extract_candidates, so leaving the page and
    coming back resumes the review where it was (HR1).

    status: "running" | "completed" | "failed"; phase while running:
    "reading" | "classifying" | "similar". apply_result is set once the
    selected candidates were imported ({created, updated, omitted,
    invalid_rule, ...}); a job is applied at most once.

    AI Extract (2/2) -- source_kind "text": BRDPs from free text. The page
    reads the text (pasted, or a .txt/.md/.docx/.pdf read in the browser),
    the server checks its word count and stores it (source_text,
    word_count); the job then waits for the page to find the decisions with
    the AI (status "awaiting_decisions", phase "finding") and, once they are
    posted, classifies them in the background like a file. filename is the
    file's name, or "" for a pasted text.
    """

    __tablename__ = "rule_extract_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    started_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String, nullable=False, default="")
    file_format: Mapped[str] = mapped_column(String, nullable=False, default="")
    source_kind: Mapped[str] = mapped_column(String, nullable=False, default="rules", server_default="rules")
    source_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    word_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="running")
    phase: Mapped[str] = mapped_column(String, nullable=False, default="reading")
    total_items: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processed_items: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # File-level warnings ([{code, params, message}]), e.g. external entities
    # not read, the duplicate check unavailable.
    warnings: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    apply_result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RuleExtractCandidate(Base):
    """One candidate BRDP of a RuleExtractJob. The rule is a column of its
    own (a candidate can carry megabytes: BRDP-S1-00007 of the "CA" BREX has
    4,500 rules) so saving the edits of one row never rewrites the others.
    `data` holds everything else: classification, texts written by the AI
    or by hand, warnings, the code-generated summary sent to the AI."""

    __tablename__ = "rule_extract_candidates"

    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rule_extract_jobs.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String, primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    rule_xml: Mapped[str] = mapped_column(Text, nullable=False, default="")
