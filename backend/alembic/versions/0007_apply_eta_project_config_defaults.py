"""Backfill projects.project_config with Apply/Import ETA settings.

HR0/HR8 (AACF): the Apply-import time/cost estimate used 4 hardcoded
constants in ProjectConfigPage.jsx (MEASURED_MS_PER_PLAIN_ROW,
MEASURED_MS_PER_VALIDATED_ROW, VALIDATED_ROWS_WARNING_THRESHOLD,
APPLY_ETA_WARNING_SECONDS) with no UI to change them per project. They
move into project_config (same mechanism as every other per-project
setting -- modelIdentCode, systemDiffCode, etc.), editable from Project
Configuration like the rest.

Backfilled here for every EXISTING project with the values already live
in code (2ms/plain row, 1500ms/Validated row -- the real number the user
measured against production Mistral, not invented; 10 rows / 30s
warning thresholds) so nothing silently changes behavior for a project
that hasn't been touched since. `defaults || project_config` keeps any
existing value for a project that (somehow) already has one of these
keys and only fills in what's missing -- safe to re-run.

New projects get the same defaults via _DEFAULT_PROJECT_CONFIG in
app/api/routes/projects.py (updated in this same round), not here --
this migration only ever runs once against rows that exist right now.

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-15

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DEFAULTS_JSON = (
    '{"applyEtaMsPerPlainRow": 2, "applyEtaMsPerValidatedRow": 1500, '
    '"applyEtaValidatedRowsThreshold": 10, "applyEtaWarningSeconds": 30}'
)

_KEYS = [
    "applyEtaMsPerPlainRow",
    "applyEtaMsPerValidatedRow",
    "applyEtaValidatedRowsThreshold",
    "applyEtaWarningSeconds",
]


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        text("UPDATE projects SET project_config = CAST(:defaults AS jsonb) || project_config"),
        {"defaults": _DEFAULTS_JSON},
    )


def downgrade() -> None:
    conn = op.get_bind()
    remove_expr = " - ".join(["project_config"] + [f"'{k}'" for k in _KEYS])
    conn.execute(text(f"UPDATE projects SET project_config = {remove_expr}"))
