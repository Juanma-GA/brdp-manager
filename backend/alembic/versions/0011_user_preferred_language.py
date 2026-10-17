"""Add users.preferred_language (docs request: language becomes an
account setting stored server-side -- Opción B -- instead of
localStorage, so it follows the account across devices/browsers).

Nullable, no server_default: NULL correctly means "no preference chosen
yet" for both every pre-existing account (this migration is purely
additive, no backfill) and any brand-new one that hasn't touched the
language switcher -- the frontend's existing 'en' fallback already
covers that case without this column needing to fake a default that
would collapse that distinction.

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("preferred_language", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "preferred_language")
