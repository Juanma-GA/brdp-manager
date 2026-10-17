"""On-demand embeddings -- compute Mistral embeddings via a background job
instead of inline on create/update/import.

Docs request: creating/editing/importing a BRDP as Validated no longer
triggers a real Mistral call at all (confirmed real cost problem: reimporting
a several-thousand-row project used to cost tens of minutes of embedding
calls even for a no-op reimport). Instead:

  - brdps.embedding_text_hash / brdp_catalog.embedding_text_hash: the
    SHA-256 hex digest of the text that was ACTUALLY embedded (title+
    definition+proposal for a BRDP, title+definition for a catalog entry --
    embeddings.py's brdp_embedding_text/catalog_embedding_text), set only
    by the new embedding_jobs background job, alongside `embedding` itself.
    A row is "pending" whenever this hash doesn't match a hash computed
    fresh from its CURRENT text (app/services/embedding_jobs.py's
    is_pending) -- so editing a title after validation correctly marks the
    row pending again, without needing a separate boolean flag kept in
    sync by every write path.
  - brdp_catalog.embedding: the catalog never had one before -- Suggest's
    precedent pool now needs it too, same on-demand model.
  - embedding_jobs table: one row per "Compute embeddings" run, same shape
    and lifecycle as import_jobs (see 0008_import_jobs.py).
  - app_settings (0009_app_settings.py) is dropped entirely: its only
    reason to exist was the Apply/Import ETA figures for the (now removed)
    inline embedding cost during import -- nothing else in the app ever
    read this table, so it becomes fully dead code the moment that cost
    disappears (HR13). The Apply/Import warning UI it powered is removed
    in this same round; the "estimated time" concept moves to the new
    embedding_jobs job's own live progress instead of a pre-configured
    ms-per-row setting.
  - import_jobs.validated_rows_total (0008_import_jobs.py) is dropped for
    the same HR13 reason: it only ever fed the "N of these rows trigger a
    real embedding API call" context line shown while an import job runs
    -- Apply itself never calls Mistral any more, so that line (and the
    count backing it) has nothing left to describe.

Composition change means every embedding computed before this migration is
now stale by definition (old text was definition+proposal only, no title)
-- "no mezclar embeddings de composiciones distintas" (docs request): this
migration clears `embedding`/`embedding_text_hash` on every existing brdps
row outright, rather than just leaving embedding_text_hash NULL and trusting
the pending-detection alone to keep old-composition vectors out of use.
Every currently-Validated BRDP across every project becomes pending
immediately after this migration -- expected and intentional, not a bug;
the first "Compute embeddings" run per project/catalog standard re-embeds
them under the new composition.

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-21

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIM = 1024  # keep in sync with app/models/brdp.py

# Same numbers app_settings' seed/downgrade always used (0009's _FALLBACK) --
# reused here only so downgrade() can recreate a row that behaves exactly
# like a freshly-migrated-up-to-0009 database would, not because this
# migration reads or writes them for any other reason.
_FALLBACK_ETA = {
    "apply_eta_ms_per_plain_row": 2,
    "apply_eta_ms_per_validated_row": 1500,
    "apply_eta_validated_rows_threshold": 10,
    "apply_eta_warning_seconds": 30,
}
_SINGLETON_ID = "00000000-0000-0000-0000-0000000a17a5"


def upgrade() -> None:
    op.add_column("brdps", sa.Column("embedding_text_hash", sa.String(), nullable=True))
    op.add_column("brdp_catalog", sa.Column("embedding", Vector(EMBEDDING_DIM), nullable=True))
    op.add_column("brdp_catalog", sa.Column("embedding_text_hash", sa.String(), nullable=True))
    op.drop_column("import_jobs", "validated_rows_total")

    # "No mezclar embeddings de composiciones distintas" -- every embedding
    # computed under the old definition+proposal composition is invalid
    # under the new title+definition+proposal one; brdp_catalog never had
    # embeddings before this migration, so there's nothing to clear there.
    op.execute("UPDATE brdps SET embedding = NULL, embedding_text_hash = NULL WHERE embedding IS NOT NULL")

    op.create_table(
        "embedding_jobs",
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
        sa.Column("total_items", sa.Integer(), nullable=False),
        sa.Column("processed_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("result", postgresql.JSONB(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_embedding_jobs_project_id", "embedding_jobs", ["project_id"])

    op.drop_table("app_settings")


def downgrade() -> None:
    op.add_column(
        "import_jobs", sa.Column("validated_rows_total", sa.Integer(), nullable=False, server_default="0")
    )

    op.create_table(
        "app_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("apply_eta_ms_per_plain_row", sa.Integer(), nullable=False),
        sa.Column("apply_eta_ms_per_validated_row", sa.Integer(), nullable=False),
        sa.Column("apply_eta_validated_rows_threshold", sa.Integer(), nullable=False),
        sa.Column("apply_eta_warning_seconds", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            INSERT INTO app_settings
                (id, apply_eta_ms_per_plain_row, apply_eta_ms_per_validated_row,
                 apply_eta_validated_rows_threshold, apply_eta_warning_seconds)
            VALUES (:id, :plain, :validated, :threshold, :warning)
            """
        ),
        {
            "id": _SINGLETON_ID,
            "plain": _FALLBACK_ETA["apply_eta_ms_per_plain_row"],
            "validated": _FALLBACK_ETA["apply_eta_ms_per_validated_row"],
            "threshold": _FALLBACK_ETA["apply_eta_validated_rows_threshold"],
            "warning": _FALLBACK_ETA["apply_eta_warning_seconds"],
        },
    )

    op.drop_index("ix_embedding_jobs_project_id", table_name="embedding_jobs")
    op.drop_table("embedding_jobs")

    # embeddings computed under the new composition are left in place --
    # they're real, valid data under whichever composition was live when
    # they were computed; downgrading the schema doesn't retroactively
    # invalidate them, and there is no old inline-embed code path left to
    # "go back to" recomputing them under the old composition anyway.
    op.drop_column("brdp_catalog", "embedding_text_hash")
    op.drop_column("brdp_catalog", "embedding")
    op.drop_column("brdps", "embedding_text_hash")
