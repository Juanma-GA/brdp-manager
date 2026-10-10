"""Rename the 7 project.standard display strings to the 6 new ones, and
retire the "Schematron 1.0 — S1000D" standard entirely.

Docs request: Schematron output is no longer its own project standard --
for the three real S1000D standards, the Generate page now offers a
BREX / Schematron output selector (generateBREXSch.js picks the right
base BREX generator for the project's real standard), fed by the SAME
BREX-format approved rules either way. So:

    BREX — S1000D 3.0.1        -> S1000D 3.0.1
    BREX — S1000D 4.1          -> S1000D 4.1
    BREX — S1000D 4.2          -> S1000D 4.2
    BREX — S1000D 5.0          -> S1000D 5.0
    BREX — S1000D 6.0          -> S1000D 6.0
    Schematron 1.0 — S1000D    -> S1000D 3.0.1  (see below)
    Schematron 1.0 — DITA      -> DITA 1.3

Confirmed with the user: no project exists today with standard =
"Schematron 1.0 — S1000D" (this branch is defensive, in case one exists
in another environment) -- it migrates to "S1000D 3.0.1" because that is
exactly the real BREX standard generateBREXSch.js always generated under
the hood for it (docs/v2, CLAUDE.md).

Same pattern as 0002_canonicalize_project_standard.py: UPDATE one known
value at a time, both on projects.standard AND on brdp_catalog.standard
(the official catalog rows imported by scripts/import_brdp_catalog.py
also carry the long-form standard string, e.g. the real 427-row
"BREX — S1000D 4.2" catalog). Any row not matching one of the known old
strings is left untouched rather than guessed at.

downgrade() is NOT perfectly symmetric for one case: both
"BREX — S1000D 3.0.1" and "Schematron 1.0 — S1000D" upgrade to the same
"S1000D 3.0.1", so downgrade cannot tell them apart any more and restores
every "S1000D 3.0.1" row to "BREX — S1000D 3.0.1" only -- never recreating
"Schematron 1.0 — S1000D". This loses no real data: no row was ever
actually "Schematron 1.0 — S1000D" to begin with (confirmed above), and
"BREX — S1000D 3.0.1" is the value the forward migration would have
produced for one anyway.

Revision ID: 0012
Revises: 0011
Create Date: 2026-09-18

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# old canonical value -> new canonical value, applied to BOTH
# projects.standard and brdp_catalog.standard.
_OLD_TO_NEW = {
    "BREX — S1000D 3.0.1": "S1000D 3.0.1",
    "BREX — S1000D 4.1": "S1000D 4.1",
    "BREX — S1000D 4.2": "S1000D 4.2",
    "BREX — S1000D 5.0": "S1000D 5.0",
    "BREX — S1000D 6.0": "S1000D 6.0",
    "Schematron 1.0 — DITA": "DITA 1.3",
    # Merges into the same target as "BREX — S1000D 3.0.1" above -- see
    # module docstring for why this is one-way (not reversed in downgrade).
    "Schematron 1.0 — S1000D": "S1000D 3.0.1",
}

_TABLES_WITH_STANDARD = ("projects", "brdp_catalog")


def upgrade() -> None:
    conn = op.get_bind()
    for table in _TABLES_WITH_STANDARD:
        for old_value, new_value in _OLD_TO_NEW.items():
            conn.execute(
                text(f"UPDATE {table} SET standard = :new WHERE standard = :old"),
                {"new": new_value, "old": old_value},
            )


def downgrade() -> None:
    conn = op.get_bind()
    # Skip "Schematron 1.0 — S1000D" here -- both it and
    # "BREX — S1000D 3.0.1" upgrade to "S1000D 3.0.1", so restoring
    # "BREX — S1000D 3.0.1" for every such row is the faithful (if
    # not perfectly symmetric) reversal -- see module docstring.
    reversed_pairs = {
        new_value: old_value
        for old_value, new_value in _OLD_TO_NEW.items()
        if old_value != "Schematron 1.0 — S1000D"
    }
    for table in _TABLES_WITH_STANDARD:
        for new_value, old_value in reversed_pairs.items():
            conn.execute(
                text(f"UPDATE {table} SET standard = :old WHERE standard = :new"),
                {"old": old_value, "new": new_value},
            )
