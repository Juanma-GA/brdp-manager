"""Initial schema — users, projects, user_project_roles, brdps, notes,
rule_approvals, suggestion_feedback, refresh_tokens (see
docs/v2/03-especificacion-v2-para-claude-code.md §2 and app/models/*.py).

Revision ID: 0001
Revises:
Create Date: 2026-09-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from pgvector.sqlalchemy import Vector

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIM = 1024  # keep in sync with app/models/brdp.py


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("global_role", sa.String(), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("standard", sa.String(), nullable=False),
        sa.Column("project_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "user_project_roles",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("role", sa.String(), nullable=False),
    )

    op.create_table(
        "brdps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("identifier", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("definition", sa.Text(), nullable=False, server_default=""),
        sa.Column("proposal", sa.Text(), nullable=False, server_default=""),
        sa.Column("validation", sa.String(), nullable=False, server_default="Pending"),
        sa.Column("comments", sa.Text(), nullable=False, server_default=""),
        sa.Column("history", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("embedding", Vector(EMBEDDING_DIM), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_brdps_project_id", "brdps", ["project_id"])

    op.create_table(
        "notes",
        sa.Column(
            "brdp_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("brdps.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "rule_approvals",
        sa.Column(
            "brdp_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("brdps.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("format", sa.String(), primary_key=True),
        sa.Column("rule_xml", sa.Text(), nullable=False, server_default=""),
        sa.Column("source", sa.String(), nullable=False, server_default="llm"),
        sa.Column("status", sa.String(), nullable=False, server_default="pending_review"),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "suggestion_feedback",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "brdp_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("brdps.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("suggested_text", sa.Text(), nullable=False),
        sa.Column("source_brdp_ids", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_suggestion_feedback_brdp_id", "suggestion_feedback", ["brdp_id"])

    op.create_table(
        "refresh_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])
    op.create_index("ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"], unique=True)


def downgrade() -> None:
    op.drop_table("refresh_tokens")
    op.drop_table("suggestion_feedback")
    op.drop_table("rule_approvals")
    op.drop_table("notes")
    op.drop_table("brdps")
    op.drop_table("user_project_roles")
    op.drop_table("projects")
    op.drop_table("users")
