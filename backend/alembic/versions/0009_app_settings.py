"""Move Apply/Import ETA settings from per-project project_config to one
installation-wide app_settings row.

HR8 (AACF) requires these 4 numbers to be configurable, not hardcoded --
but not "configurable separately per project" (the previous round's
design, migration 0007): an Apply import costs the same per row in every
project (the same Mistral embedding call for a Validated row), so a copy
of the identical number duplicated into every project's project_config
was never real per-project variance, just the same setting repeated.
HR0 (every setting needs an admin UI) is still satisfied -- just by one
admin-only screen (Settings) instead of N per-project ones. Docs request
this round: "GLOBAL, no por proyecto... un único valor para toda la
instalación".

Seeds the new singleton row from whichever project already has these 4
keys set, preferring a project named "Lufthansa" if one exists -- that is
the project the real, measured-in-production value (1500ms/Validated
row) was reported against, so this is a real migration of an existing
number, not a reset to a generic default. Every project got these keys
via 0007 (backfill) or _DEFAULT_PROJECT_CONFIG (new projects since), so
in an environment where no project is literally named "Lufthansa" (e.g.
this dev database), the fallback -- "whichever project has the keys,
earliest created" -- still recovers the exact same real number, not a
different one; the hardcoded _FALLBACK below is the true last resort,
only used if zero projects exist at all.

Also strips the 4 keys from every project's project_config: nothing in
the app reads them from there any more (ProjectConfigPage.jsx's Import
Settings subsection is removed in this same round), so leaving them
would be stale, duplicated data (HR13).

Revision ID: 0009
Revises: 0008
Create Date: 2026-09-15

"""
import json
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Matches app/models/app_settings.py's SINGLETON_ID -- this migration is
# the only place that ever INSERTs into app_settings, so the constant is
# duplicated here deliberately rather than importing the model (Alembic
# migrations must not depend on current application code, which can
# change out from under an old migration).
_SINGLETON_ID = uuid.UUID("00000000-0000-0000-0000-0000000a17a5")

# Absolute last resort -- same numbers 0007 originally backfilled, only
# used if this database has zero projects with the keys set at all.
_FALLBACK = {
    "applyEtaMsPerPlainRow": 2,
    "applyEtaMsPerValidatedRow": 1500,
    "applyEtaValidatedRowsThreshold": 10,
    "applyEtaWarningSeconds": 30,
}

_KEYS = list(_FALLBACK.keys())


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("apply_eta_ms_per_plain_row", sa.Integer(), nullable=False),
        sa.Column("apply_eta_ms_per_validated_row", sa.Integer(), nullable=False),
        sa.Column("apply_eta_validated_rows_threshold", sa.Integer(), nullable=False),
        sa.Column("apply_eta_warning_seconds", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    conn = op.get_bind()
    row = conn.execute(
        sa.text(
            """
            SELECT project_config
            FROM projects
            WHERE project_config ? 'applyEtaMsPerValidatedRow'
            ORDER BY (name ILIKE '%lufthansa%') DESC, created_at ASC
            LIMIT 1
            """
        )
    ).fetchone()
    source_config = row[0] if row is not None else {}
    seed = {key: source_config.get(key, default) for key, default in _FALLBACK.items()}

    conn.execute(
        sa.text(
            """
            INSERT INTO app_settings
                (id, apply_eta_ms_per_plain_row, apply_eta_ms_per_validated_row,
                 apply_eta_validated_rows_threshold, apply_eta_warning_seconds)
            VALUES (:id, :plain, :validated, :threshold, :warning)
            """
        ),
        {
            "id": str(_SINGLETON_ID),
            "plain": seed["applyEtaMsPerPlainRow"],
            "validated": seed["applyEtaMsPerValidatedRow"],
            "threshold": seed["applyEtaValidatedRowsThreshold"],
            "warning": seed["applyEtaWarningSeconds"],
        },
    )

    remove_expr = " - ".join(["project_config"] + [f"'{k}'" for k in _KEYS])
    conn.execute(sa.text(f"UPDATE projects SET project_config = {remove_expr}"))


def downgrade() -> None:
    conn = op.get_bind()
    row = conn.execute(
        sa.text(
            """
            SELECT apply_eta_ms_per_plain_row, apply_eta_ms_per_validated_row,
                   apply_eta_validated_rows_threshold, apply_eta_warning_seconds
            FROM app_settings WHERE id = :id
            """
        ),
        {"id": str(_SINGLETON_ID)},
    ).fetchone()
    values = (
        {
            "applyEtaMsPerPlainRow": row[0],
            "applyEtaMsPerValidatedRow": row[1],
            "applyEtaValidatedRowsThreshold": row[2],
            "applyEtaWarningSeconds": row[3],
        }
        if row is not None
        else _FALLBACK
    )
    conn.execute(
        sa.text("UPDATE projects SET project_config = CAST(:defaults AS jsonb) || project_config"),
        {"defaults": json.dumps(values)},
    )
    op.drop_table("app_settings")
