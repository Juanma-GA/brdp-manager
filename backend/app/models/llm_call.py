import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LlmCall(Base):
    """One call to the LLM -- chat through /api/llm-proxy or embeddings
    (Protecciones 2a). Usage only: never the content sent or received.
    user_id has no foreign key (migration 0027): the row outlives its user.
    """

    __tablename__ = "llm_calls"
    __table_args__ = (
        CheckConstraint("kind IN ('chat', 'embedding')", name="ck_llm_calls_kind"),
        CheckConstraint("result IN ('ok', 'upstream_error', 'failed', 'rate_limited')", name="ck_llm_calls_result"),
        Index("ix_llm_calls_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # "chat" | "embedding"
    kind: Mapped[str] = mapped_column(String, nullable=False)
    # "ok" | "upstream_error" | "failed" | "rate_limited"
    result: Mapped[str] = mapped_column(String, nullable=False)
    upstream_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    request_chars: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    text_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
