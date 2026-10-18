"""project_config.schemaLocation: no "master" for S1000D 4.1 / 4.2.

S1000D publishes master schemas only for Issue 3.0.1; the configuration page
used to offer "Master" for 4.1 and 4.2 as well. A 4.x project with "master"
stored moves to "flat" (the form of every real 4.x DM and template seen so
far). The app already reads "master" on 4.x as flat (schemaLocationOf in
src/utils/ruleSchemaContext.js), so nothing changes in behaviour; this only
cleans the stored value. Projects have no history, so the affected projects
are printed here (alembic upgrade output) to be reported.

The downgrade cannot know which projects had "master" before, so it leaves
the data as it is.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-01

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_STANDARDS = ("S1000D 4.1", "S1000D 4.2")


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, name, standard FROM projects "
            "WHERE standard IN :standards AND project_config->>'schemaLocation' = 'master' "
            "ORDER BY name"
        ).bindparams(sa.bindparam("standards", expanding=True)),
        {"standards": list(_STANDARDS)},
    ).fetchall()
    for row in rows:
        print(f"0020: schema location master -> flat: {row.name} ({row.standard}, {row.id})")
    if not rows:
        print("0020: no S1000D 4.x project had schema location master")
    bind.execute(
        sa.text(
            "UPDATE projects SET project_config = jsonb_set(project_config, '{schemaLocation}', '\"flat\"') "
            "WHERE standard IN :standards AND project_config->>'schemaLocation' = 'master'"
        ).bindparams(sa.bindparam("standards", expanding=True)),
        {"standards": list(_STANDARDS)},
    )


def downgrade() -> None:
    pass
