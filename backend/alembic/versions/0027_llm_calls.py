"""llm_calls: one row per call to the LLM (Protecciones 2a, AACF G7/G12).

Adds the table llm_calls: who called (user_id, nullable -- an embedding
job whose user is not known), when, what (kind "chat" | "embedding"), how
it ended (result "ok" | "upstream_error" | "failed" | "rate_limited", the
provider's HTTP status when there is one), how long it took and how much
was sent (request_chars; text_count for embeddings). Never the content of
the messages or of the answers.

user_id has no foreign key, on purpose: like brdp_history, a row outlives
the user it names (a soft-deleted user keeps it anyway, and a permanently
deleted one must not take its usage with it). Index (user_id, created_at):
the per-user limit counts the last minute and the last 24 hours.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0027"
down_revision: Union[str, None] = "0026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "llm_calls",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("result", sa.String(), nullable=False),
        sa.Column("upstream_status", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("request_chars", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("text_count", sa.Integer(), nullable=True),
        sa.CheckConstraint("kind IN ('chat', 'embedding')", name="ck_llm_calls_kind"),
        sa.CheckConstraint(
            "result IN ('ok', 'upstream_error', 'failed', 'rate_limited')", name="ck_llm_calls_result"
        ),
    )
    op.create_index("ix_llm_calls_user_created", "llm_calls", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_llm_calls_user_created", table_name="llm_calls")
    op.drop_table("llm_calls")
