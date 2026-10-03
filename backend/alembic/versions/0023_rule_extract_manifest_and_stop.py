"""rule_extract_jobs: manifest, drafting_stopped.

manifest -- the candidates a job wrote ([{key, identifier,
origin_identifier, classification}]), stored in the same transaction as the
candidate rows: if the table ever shows fewer rows than the job read, the
page names the missing ones (HR7) instead of only counting them.

drafting_stopped -- "Stop" on the AI writing the texts: the rows left stay
pending and the page does not resume by itself (not after a reload either)
until "Continue writing". Existing rows: not stopped, no manifest.

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0023"
down_revision: Union[str, None] = "0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("rule_extract_jobs", sa.Column("manifest", postgresql.JSONB(), nullable=True))
    op.add_column(
        "rule_extract_jobs", sa.Column("drafting_stopped", sa.Boolean(), nullable=False, server_default=sa.false())
    )


def downgrade() -> None:
    op.drop_column("rule_extract_jobs", "drafting_stopped")
    op.drop_column("rule_extract_jobs", "manifest")
