"""Add brdp_history table (real per-field audit trail, Option B).

Distinct from the pre-existing brdps.history JSONB column, which is left
untouched and unused here -- removing that column is a separate dead-code
cleanup round, not this one. This is a genuinely new, additive table: one
row per field that actually changed, written by the write endpoints
(brdps.py's PUT, approvals.py's propose/approve/revoke), never one row per
save.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "brdp_history",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "brdp_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("brdps.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("user_email", sa.String(), nullable=False),
        sa.Column("field_name", sa.String(), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=False),
        sa.Column("new_value", sa.Text(), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_brdp_history_brdp_id", "brdp_history", ["brdp_id"])


def downgrade() -> None:
    op.drop_index("ix_brdp_history_brdp_id", table_name="brdp_history")
    op.drop_table("brdp_history")
