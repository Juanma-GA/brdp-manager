"""users.ui_preferences: the person's interface preferences on the server
(AACF 3, Decisión 5, HR1).

Adds users.ui_preferences (JSONB, NOT NULL, default '{}'). Today it holds
two optional keys, validated by the API (schemas/auth.py UiPreferencesPatch):
sidebar_collapsed (bool) and records_detail_width (int). Every existing user
gets {} -- the app's current defaults. Values the browser stored before
(localStorage sidebarCollapsed, brdp-records-detail-width) are not read or
migrated.

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-05

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0026"
down_revision: Union[str, None] = "0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "ui_preferences",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "ui_preferences")
