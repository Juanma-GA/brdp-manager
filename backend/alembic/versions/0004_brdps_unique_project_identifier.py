"""Composite unique constraint on brdps(project_id, identifier).

Identifier only needs to be unique WITHIN a project -- the same identifier
string is valid in two different projects, since each project is its own
independent BRDP dataset. Confirmed against real data before writing this:
no existing (project_id, identifier) duplicates in the current dev DB, so
this is a pure additive constraint, nothing to backfill/dedupe first.

The application layer (backend/app/api/routes/brdps.py) also pre-checks
this and returns a clean 409 before ever reaching the DB, matching this
codebase's existing convention for uniqueness (see users.py's email
check) -- this migration is the actual source of truth / last line of
defense, the pre-check is just for a clean error message instead of a raw
IntegrityError under a race.

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-11

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_unique_constraint("uq_brdps_project_id_identifier", "brdps", ["project_id", "identifier"])


def downgrade() -> None:
    op.drop_constraint("uq_brdps_project_id_identifier", "brdps", type_="unique")
