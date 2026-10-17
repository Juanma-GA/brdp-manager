"""refresh_tokens.rotated_at: when a refresh replaced this token.

A token replaced by a refresh (rotation) can be presented once more for a
few seconds (REFRESH_TOKEN_REUSE_GRACE_SECONDS): a page reload or a
navigation that aborts the refresh after the server rotated the token, or
two tabs opened at once, otherwise send the old cookie again and lose the
session. Revocations that end a session on purpose (logout, password
change or reset, user deleted) never set it, and clear it on the user's
other tokens, so the grace never revives a session that was closed.

Revision ID: 0031
Revises: 0030
Create Date: 2026-10-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: Union[str, None] = "0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("refresh_tokens", sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("refresh_tokens", "rotated_at")
