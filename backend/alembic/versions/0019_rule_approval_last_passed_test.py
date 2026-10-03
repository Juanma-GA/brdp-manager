"""rule_approvals.last_passed_test -- the last test of a rule that passed,
with its examples (Test de reglas: guardar la prueba aprobada).

Until now a passed test kept only its result and date (and, for a test
passed with examples edited by hand, their XML): the examples were lost
when the panel closed, so there was no evidence of what the rule had been
checked against, and every new test depended on the LLM again. This column
keeps the last passed test of each rule (one per rule, replaced by the next
passed test and left alone by any other result):

    {"at", "rule_xml", "rule_hash", "proposal", "examples_from", "edited_count",
     "examples": [{"label", "expected", "schema", "xml", "skeleton_node_paths",
                   "result", "matches"}]}

"Ver prueba aprobada" shows it; "Probar con los ejemplos guardados" runs the
current rule on its documents (engine only, no LLM). Existing rows stay NULL,
nothing to backfill (their examples were never kept).

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-30

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("rule_approvals", sa.Column("last_passed_test", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("rule_approvals", "last_passed_test")
