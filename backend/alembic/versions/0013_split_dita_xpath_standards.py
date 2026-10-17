"""Split the single "DITA 1.3" project standard into two: "DITA 1.3
Xpath2.0" and "DITA 1.3 Xpath3.0".

Docs request / real bug found reading generateSchematronDITA.js: the
assembled Schematron document's queryBinding is hardcoded to "xslt2" in
three places (the document template, the well-formedness validation gate,
and the LLM fallback prompt) -- with real XPath 3.0 Rule content (the
Navantia-Xpath3.0 project), the final document would carry a wrong
queryBinding header. Unlike Schematron 1.0 -- S1000D (merged into a single
Generate-page output selector in migration 0012, because that Rule was the
SAME data fed through one deterministic BREX->Schematron converter either
way), here each BRDP's Rule is separately hand-authored native Schematron
per XPath flavor -- there is no shared conversion step, so two real,
separate projects are needed regardless; a single "XPath version" config
field on one DITA 1.3 project would not by itself solve anything, since
the Rule content itself already differs row by row between the two real
Navantia projects. Decided with the user: two standards, so the version is
visible in the Projects list's own "Project standard" column without
opening each project.

    DITA 1.3   ->   DITA 1.3 Xpath2.0

No "DITA 1.3 Xpath3.0" row is created here -- confirmed with the user that
no real Xpath3.0 project exists yet (one will be created fresh, once the
app already supports it, not migrated from anything).

Same pattern as 0002_canonicalize_project_standard.py and
0012_rename_project_standards.py: UPDATE one known value at a time, both
on projects.standard AND on brdp_catalog.standard (the official catalog
rows imported by scripts/import_brdp_catalog.py also carry the standard
string, and any DITA catalog entries from
scripts/enrich_dita_catalog.py's "DITA 1.3" enrichment run must keep
matching real DITA projects after this migration, or catalog_override
would silently stop firing for every one of them). Any row not matching
the known old string is left untouched rather than guessed at.

downgrade() collapses BOTH new strings back to the single old one: any
"DITA 1.3 Xpath2.0" row (the only ones this migration itself could have
produced) AND, defensively, any "DITA 1.3 Xpath3.0" row that might exist
by the time of a downgrade (created after this migration ran, before a
hypothetical future rollback) both become "DITA 1.3" again -- there is
nothing else "DITA 1.3" could mean once split, so folding both directions
back into it is the only faithful reversal, even though it is not a
perfect inverse of the (one-directional) upgrade.

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-20

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_STANDARD = "DITA 1.3"
_NEW_STANDARD = "DITA 1.3 Xpath2.0"
# Only relevant to downgrade() -- see module docstring's "downgrade()
# collapses BOTH new strings" paragraph. Never written by upgrade().
_XPATH3_STANDARD = "DITA 1.3 Xpath3.0"

_TABLES_WITH_STANDARD = ("projects", "brdp_catalog")


def upgrade() -> None:
    conn = op.get_bind()
    for table in _TABLES_WITH_STANDARD:
        conn.execute(
            text(f"UPDATE {table} SET standard = :new WHERE standard = :old"),
            {"new": _NEW_STANDARD, "old": _OLD_STANDARD},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for table in _TABLES_WITH_STANDARD:
        for current_value in (_NEW_STANDARD, _XPATH3_STANDARD):
            conn.execute(
                text(f"UPDATE {table} SET standard = :old WHERE standard = :current"),
                {"old": _OLD_STANDARD, "current": current_value},
            )
