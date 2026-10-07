"""rule_approvals.correction_dismissed_hash: a proposed correction that was
discarded (Corrección propuesta de reglas con defecto).

When code finds a defect in a saved rule and prepares a correction, the
person accepts it or discards it. Discarding is remembered by the SHA-256
of the rule text it was proposed for: the proposal does not come back for
that text, and comes back (re-evaluated) as soon as the rule changes.
Nullable: NULL = nothing discarded.

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-07

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: Union[str, None] = "0028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("rule_approvals", sa.Column("correction_dismissed_hash", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("rule_approvals", "correction_dismissed_hash")
