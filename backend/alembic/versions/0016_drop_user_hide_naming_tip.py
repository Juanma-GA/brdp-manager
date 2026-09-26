"""Drop users.hide_naming_tip (docs request: "Don't show again" on the
naming-convention tip round back -- user decision: the tip is a genuinely
useful reminder in an app used only sporadically, so it should always be
available again next session rather than permanently silenceable. "Got
it" (session-only dismissal, held in memory, never persisted) is all that
remains -- see RecordsPage.jsx's namingTipSessionSeenRef.

0015 (the migration that added this column) is NOT edited -- it already
shipped and ran in real environments; this is a separate, additive
migration that undoes it, same convention as any other column removed
after the fact in this branch (e.g. 0014's own app_settings/
validated_rows_total drops).

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-26

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("users", "hide_naming_tip")


def downgrade() -> None:
    op.add_column(
        "users",
        sa.Column("hide_naming_tip", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
