"""audit_log: one row per administrative action (Protecciones 2b, AACF G7/HR9).

Adds the table audit_log: who did it (actor_id + actor_email), what
(action, from a fixed list), to what (target_type "brdp" | "project" |
"user" | "project_role", target_id, target_label -- the BRDP identifier,
project name or user email as it was), in which project (project_id,
project_name) and small facts in detail (JSONB). Never a password, a
token or the content of a BRDP or a rule.

No foreign keys, on purpose: like brdp_history and llm_calls, a row must
outlive the user, project or BRDP it names -- a permanent delete is
exactly what it records. Indexes on created_at (the endpoint reads the
last N days) and on (target_type, target_id) (everything done to one
object).

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0028"
down_revision: Union[str, None] = "0027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ACTIONS = (
    "brdp.deleted_permanently",
    "project.trashed",
    "project.restored",
    "project.deleted_permanently",
    "user.created",
    "user.updated",
    "user.password_reset",
    "user.trashed",
    "user.restored",
    "user.deleted_permanently",
    "project_role.assigned",
    "project_role.changed",
    "project_role.removed",
)


def upgrade() -> None:
    op.create_table(
        "audit_log",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_email", sa.Text(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("target_type", sa.String(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("target_label", sa.Text(), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("project_name", sa.Text(), nullable=True),
        sa.Column("detail", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.CheckConstraint(
            "action IN (" + ", ".join(f"'{a}'" for a in _ACTIONS) + ")", name="ck_audit_log_action"
        ),
        sa.CheckConstraint(
            "target_type IN ('brdp', 'project', 'user', 'project_role')", name="ck_audit_log_target_type"
        ),
    )
    op.create_index("ix_audit_log_created_at", "audit_log", ["created_at"])
    op.create_index("ix_audit_log_target", "audit_log", ["target_type", "target_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_log_target", table_name="audit_log")
    op.drop_index("ix_audit_log_created_at", table_name="audit_log")
    op.drop_table("audit_log")
