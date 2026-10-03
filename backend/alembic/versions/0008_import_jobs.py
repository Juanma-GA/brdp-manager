"""Add import_jobs table.

Excel import Apply moves from a blocking request to a background job
(docs request): navigating away, reloading, or closing the tab used to
reset the in-progress Apply form entirely (no server-side record of it
at all -- the whole thing lived in ProjectConfigPage.jsx component
state). Postgres becomes the only source of truth for "is an import
running for this project" (HR1: never localStorage/sessionStorage) via
GET /brdps/import/status/{job_id} and GET /brdps/import/status/active.

started_by is ON DELETE SET NULL (same pattern as brdp_history.user_id):
the job record must survive the acting user's account being deleted
later -- the id is enough for audit trail purposes, no email snapshot
needed here since (unlike brdp_history) this isn't shown per-row in a UI
list, only "who currently has one running" at most.

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-15

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "import_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "started_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="running"),
        sa.Column("total_rows", sa.Integer(), nullable=False),
        sa.Column("processed_rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("validated_rows_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        # {created, updated, rejected, conflicts_kept, conflicts_cleared}
        # once status="completed" -- the same summary ImportApplyResponse
        # always returned synchronously, now delivered via the status
        # endpoint once the job finishes. Not in the original column list
        # from the request; added because without it there's no way to
        # show the "N created / N updated / ..." result once the job is
        # done (see ImportApplyResultSummary in app/schemas/brdp_import.py).
        sa.Column("result", postgresql.JSONB(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_import_jobs_project_id", "import_jobs", ["project_id"])
    # Speeds up "is there a running job for project X" (status/active
    # endpoint), the query this table exists to serve fast on every page
    # load across the whole app.
    op.create_index(
        "ix_import_jobs_project_id_status",
        "import_jobs",
        ["project_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_import_jobs_project_id_status", table_name="import_jobs")
    op.drop_index("ix_import_jobs_project_id", table_name="import_jobs")
    op.drop_table("import_jobs")
