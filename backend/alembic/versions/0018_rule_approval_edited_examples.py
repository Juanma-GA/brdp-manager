"""rule_approvals.last_test_edited_examples -- a test recorded as passed
after the user edited examples by hand (Test de reglas, pending items).

When the recorded test of a generation failed, was inconclusive or had no
runnable example, and the user's hand edits in the Test rule panel turn the
verdict into "Correct", the panel records it once as passed, with the
edited examples as they were run: [{"label", "xml"}]. NULL for every other
test (the examples as the LLM wrote them) -- existing rows stay NULL,
nothing to backfill.

Revision ID: 0018
Revises: 0017
Create Date: 2026-09-30

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("rule_approvals", sa.Column("last_test_edited_examples", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("rule_approvals", "last_test_edited_examples")
