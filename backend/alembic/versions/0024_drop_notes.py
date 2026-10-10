"""Drop the notes table.

The per-BRDP notes (GET/PUT /api/projects/{id}/brdps/{id}/notes) had no
caller in the v2 interface; retired in Barrido final 4 together with their
route, model and schema. Any row left in the table is dropped with it (the
interface never offered a way to write one).

downgrade() recreates the table empty, as 0001 created it.

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-05

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0024"
down_revision: Union[str, None] = "0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table("notes")


def downgrade() -> None:
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
