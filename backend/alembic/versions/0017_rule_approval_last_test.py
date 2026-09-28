"""rule_approvals.last_test_* -- the last "Test rule" run on a rule
(Test de reglas T3 of 4).

The result is recorded so moving a rule to Verified can warn (never block)
when it was not tested, the test is outdated, failed, was inconclusive or
could not run. All five columns are nullable and NULL together for a rule
never tested -- every existing row stays "not tested", nothing to backfill.

  - last_test_result: "passed" | "failed" | "inconclusive" | "not_executable"
  - last_test_reason: JSONB {"code", "params"} -- a code, never a sentence,
    so the reason is shown in the viewer's own language
  - last_test_at / last_test_by: when and who (SET NULL if the user goes)
  - last_test_rule_hash: SHA-256 hex of the rule_xml that was tested; a
    mismatch with the current rule_xml means "test outdated"

Revision ID: 0017
Revises: 0016
Create Date: 2026-09-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("rule_approvals", sa.Column("last_test_result", sa.String(), nullable=True))
    op.add_column("rule_approvals", sa.Column("last_test_reason", postgresql.JSONB(), nullable=True))
    op.add_column("rule_approvals", sa.Column("last_test_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "rule_approvals",
        sa.Column(
            "last_test_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL", name="rule_approvals_last_test_by_fkey"),
            nullable=True,
        ),
    )
    op.add_column("rule_approvals", sa.Column("last_test_rule_hash", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("rule_approvals", "last_test_rule_hash")
    op.drop_constraint("rule_approvals_last_test_by_fkey", "rule_approvals", type_="foreignkey")
    op.drop_column("rule_approvals", "last_test_by")
    op.drop_column("rule_approvals", "last_test_at")
    op.drop_column("rule_approvals", "last_test_reason")
    op.drop_column("rule_approvals", "last_test_result")
