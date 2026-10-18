"""rule_extract_jobs: source_kind, source_text, word_count -- AI Extract
(2/2): BRDPs from free text (a pasted text or a .txt/.md/.docx/.pdf read in
the browser). A text job stores the text it reads and its word count; a
BREX/Schematron job is "rules" and leaves both empty. Existing rows are
"rules".

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: Union[str, None] = "0021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("rule_extract_jobs", sa.Column("source_kind", sa.String(), nullable=False, server_default="rules"))
    op.add_column("rule_extract_jobs", sa.Column("source_text", sa.Text(), nullable=True))
    op.add_column("rule_extract_jobs", sa.Column("word_count", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("rule_extract_jobs", "word_count")
    op.drop_column("rule_extract_jobs", "source_text")
    op.drop_column("rule_extract_jobs", "source_kind")
