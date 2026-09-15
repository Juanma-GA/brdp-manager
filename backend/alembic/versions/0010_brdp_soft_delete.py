"""BRDP soft-delete (Papelera/Trash) -- docs request.

Adds deleted_at/deleted_by/deleted_by_email to brdps (NULL = active/
visible everywhere; set = trashed). Every read path that must not see a
trashed BRDP now goes through app/repositories/brdp_repository.py's
active-only helpers instead of querying brdps directly.

uq_brdps_project_id_identifier moves from a plain UniqueConstraint to a
partial unique Index (WHERE deleted_at IS NULL) -- Postgres has no
conditional UniqueConstraint, only a conditional unique index -- so a
trashed BRDP's identifier becomes available again for a brand-new BRDP in
the same project, per the docs request's explicit "borrar y crear otra
con el mismo identifier debe permitirlo" case, while still enforcing real
uniqueness among the rows anyone can actually see or act on.

Also changes brdp_history.brdp_id from NOT NULL / ON DELETE CASCADE to
nullable / ON DELETE SET NULL. This is a correction, not something the
docs request asked for directly -- it assumed this was "ya presente"
(already the case), but the column shipped in migration 0003 as CASCADE.
Without this change, the Trash's "Delete permanently" action (a real
db.delete() on the BRDP row) would silently wipe that BRDP's entire audit
trail along with it, contradicting the docs request's own explicit test
case ("su brdp_history sigue existiendo" after a permanent delete). Same
SET NULL + point-in-time-email-snapshot pattern already used for
user_id/user_email on this same table.

Revision ID: 0010
Revises: 0009
Create Date: 2026-09-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("brdps", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "brdps",
        sa.Column(
            "deleted_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column("brdps", sa.Column("deleted_by_email", sa.String(), nullable=True))

    op.drop_constraint("uq_brdps_project_id_identifier", "brdps", type_="unique")
    op.create_index(
        "uq_brdps_project_id_identifier",
        "brdps",
        ["project_id", "identifier"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    op.drop_constraint("brdp_history_brdp_id_fkey", "brdp_history", type_="foreignkey")
    op.alter_column("brdp_history", "brdp_id", existing_type=postgresql.UUID(as_uuid=True), nullable=True)
    op.create_foreign_key(
        "brdp_history_brdp_id_fkey",
        "brdp_history",
        "brdps",
        ["brdp_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("brdp_history_brdp_id_fkey", "brdp_history", type_="foreignkey")
    # A permanent delete taken under this migration may have already left
    # SET-NULL rows behind -- those can't be un-NULLed (the original
    # brdp_id is gone for good), so downgrading back to NOT NULL would
    # break on real data. Only re-tighten to NOT NULL if nothing has
    # actually gone NULL yet; otherwise leave the column nullable rather
    # than fail the downgrade or silently delete those history rows.
    bind = op.get_bind()
    has_null = bind.execute(sa.text("SELECT 1 FROM brdp_history WHERE brdp_id IS NULL LIMIT 1")).fetchone()
    if has_null is None:
        op.alter_column("brdp_history", "brdp_id", existing_type=postgresql.UUID(as_uuid=True), nullable=False)
    op.create_foreign_key(
        "brdp_history_brdp_id_fkey",
        "brdp_history",
        "brdps",
        ["brdp_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_index("uq_brdps_project_id_identifier", table_name="brdps")
    op.create_unique_constraint("uq_brdps_project_id_identifier", "brdps", ["project_id", "identifier"])

    op.drop_column("brdps", "deleted_by_email")
    op.drop_column("brdps", "deleted_by")
    op.drop_column("brdps", "deleted_at")
