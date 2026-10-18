"""Canonicalize projects.standard to the 7 exact display strings.

project.standard used to be stored as a "bare" string ("S1000D 4.2",
"S1000D 4.1", "S1000D 3.0.1", "DITA 1.3") from before the Create Project
UI round canonicalized it to the 7 exact strings the dropdown now offers
("BREX — S1000D 4.2", etc. -- see docs/v2 §2 and app/models/project.py).
Anything created after that round already uses the canonical form (the
POST /api/projects route only ever accepts one of the 7); this migration
is a one-time backfill for rows created before it, including
scripts/seed_dev_data.py's own demo project, which itself shipped the
bare "S1000D 4.2" string until this same round fixed it.

No DB-level CHECK/ENUM exists on this column (plain String), so this is
a pure data migration -- any row not matching one of the known bare
strings is left untouched rather than guessed at.

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-10

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# old bare value -> new canonical value. Schematron 1.0 — S1000D and the
# 5.0/6.0 BREX options never existed under a pre-canonical bare form (they
# were only ever introduced already-canonical), so they have no entry here.
_LEGACY_TO_CANONICAL = {
    "S1000D 4.2": "BREX — S1000D 4.2",
    "S1000D 4.1": "BREX — S1000D 4.1",
    "S1000D 3.0.1": "BREX — S1000D 3.0.1",
    "DITA 1.3": "Schematron 1.0 — DITA",
}


def upgrade() -> None:
    conn = op.get_bind()
    for old_value, new_value in _LEGACY_TO_CANONICAL.items():
        conn.execute(
            text("UPDATE projects SET standard = :new WHERE standard = :old"),
            {"new": new_value, "old": old_value},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for old_value, new_value in _LEGACY_TO_CANONICAL.items():
        conn.execute(
            text("UPDATE projects SET standard = :old WHERE standard = :new"),
            {"old": old_value, "new": new_value},
        )
