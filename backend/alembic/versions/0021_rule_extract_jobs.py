"""rule_extract_jobs + rule_extract_candidates -- AI Extract (1/2): import
BRDPs from a BREX or a Schematron.

A job is one file read into a project (parse + classify in the background,
with progress, like import_jobs); its candidates are one row each so editing
one never rewrites the others, and the rule is a column of its own (a
candidate can carry megabytes of rules). Nothing to backfill.

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-01

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0021"
down_revision: Union[str, None] = "0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "rule_extract_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("started_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("filename", sa.String(), nullable=False, server_default=""),
        sa.Column("file_format", sa.String(), nullable=False, server_default=""),
        sa.Column("status", sa.String(), nullable=False, server_default="running"),
        sa.Column("phase", sa.String(), nullable=False, server_default="reading"),
        sa.Column("total_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processed_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("warnings", postgresql.JSONB(), nullable=True),
        sa.Column("apply_result", postgresql.JSONB(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_rule_extract_jobs_project_id", "rule_extract_jobs", ["project_id"])
    op.create_table(
        "rule_extract_candidates",
        sa.Column(
            "job_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("rule_extract_jobs.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("data", postgresql.JSONB(), nullable=False),
        sa.Column("rule_xml", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_table("rule_extract_candidates")
    op.drop_index("ix_rule_extract_jobs_project_id", table_name="rule_extract_jobs")
    op.drop_table("rule_extract_jobs")
