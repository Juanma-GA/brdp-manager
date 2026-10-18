"""Add users.hide_naming_tip (docs request: "Don't show again" on the
naming-convention tip persists server-side, per user -- same Opción B
pattern as users.preferred_language (0011): a user-level preference that
must follow the account across devices/browsers, never localStorage
(HR1).

NOT NULL with server_default false: unlike preferred_language, there is
no meaningful "unset" state to preserve here -- every account, old or
new, either has the tip hidden or hasn't asked to hide it, and "hasn't
asked" is exactly what `false` means. A plain boolean column (not
nullable) keeps every reader (UserOut, the frontend) from having to
handle a third NULL state that would never mean anything different from
`false` anyway.

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-25

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("hide_naming_tip", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "hide_naming_tip")
