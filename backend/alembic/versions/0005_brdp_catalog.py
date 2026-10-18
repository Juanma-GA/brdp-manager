"""Add brdp_catalog table (official per-standard BRDP catalog).

Global reference data, not scoped to any project -- standard, identifier,
title, definition, no proposal column (the catalog never has one). Unique
on (standard, identifier) so scripts/import_brdp_catalog.py can upsert
idempotently. Populated by that script, never written to from the API.

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "brdp_catalog",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("standard", sa.String(), nullable=False),
        sa.Column("identifier", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("definition", sa.Text(), nullable=False, server_default=""),
        sa.UniqueConstraint("standard", "identifier", name="uq_brdp_catalog_standard_identifier"),
    )
    op.create_index("ix_brdp_catalog_standard", "brdp_catalog", ["standard"])


def downgrade() -> None:
    op.drop_index("ix_brdp_catalog_standard", table_name="brdp_catalog")
    op.drop_table("brdp_catalog")
