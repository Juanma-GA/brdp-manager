"""Add users.must_change_password (docs request: admin-issued/reset
passwords are random temporaries the user must never keep using -- this
flag is what the frontend checks, right after login, to force the
Change Password screen before anything else is reachable).

Server-side default false so every existing row backfills correctly
without a separate data migration; new rows explicit about it too via
the model (server_default is enough here since there's no existing data
that would need a different value).

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-12

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "must_change_password")
