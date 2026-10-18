"""audit_log: new action "project.duplicated" (Duplicar un proyecto).

Only the CHECK constraint on audit_log.action changes: it lists one more
value. The row of a duplicate names the new project as its target and
keeps the source's id and name, the standard and the BRDP and rule counts
in detail.

downgrade() refuses while any "project.duplicated" row exists: the old
constraint would reject it, and deleting audit rows is never done by a
migration.

Revision ID: 0030
Revises: 0029
Create Date: 2026-10-10

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: Union[str, None] = "0029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_BEFORE = (
    "brdp.deleted_permanently",
    "project.trashed",
    "project.restored",
    "project.deleted_permanently",
    "user.created",
    "user.updated",
    "user.password_reset",
    "user.trashed",
    "user.restored",
    "user.deleted_permanently",
    "project_role.assigned",
    "project_role.changed",
    "project_role.removed",
)
_AFTER = _BEFORE[:4] + ("project.duplicated",) + _BEFORE[4:]


def _check(actions: tuple[str, ...]) -> str:
    return "action IN (" + ", ".join(f"'{a}'" for a in actions) + ")"


def upgrade() -> None:
    op.drop_constraint("ck_audit_log_action", "audit_log", type_="check")
    op.create_check_constraint("ck_audit_log_action", "audit_log", _check(_AFTER))


def downgrade() -> None:
    count = op.get_bind().execute(
        sa.text("SELECT count(*) FROM audit_log WHERE action = 'project.duplicated'")
    ).scalar_one()
    if count:
        raise RuntimeError(
            f"audit_log has {count} 'project.duplicated' row(s); the previous constraint would reject them. "
            "Not downgrading: audit rows are never deleted by a migration."
        )
    op.drop_constraint("ck_audit_log_action", "audit_log", type_="check")
    op.create_check_constraint("ck_audit_log_action", "audit_log", _check(_BEFORE))
