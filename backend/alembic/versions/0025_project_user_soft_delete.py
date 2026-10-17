"""Projects and users go to a Papelera instead of being deleted (AACF 2,
Decisión 13, HR9).

Adds deleted_at / deleted_by / deleted_by_email to projects and users
(NULL = active), the same three columns migration 0010 added to brdps.
Nothing is deleted or changed: every existing project and user stays
active.

users.email: the plain unique index ix_users_email becomes a partial
unique index (WHERE deleted_at IS NULL), like uq_brdps_project_id_identifier
-- the email is unique among active users; a deleted user's email is
offered for a restore (routes/users.py), never reused silently.

projects.name never had a unique index (two projects may share a name),
so there is nothing to make partial there.

Before touching anything, upgrade() checks for duplicate emails (they
cannot exist under the current unique index, but a database restored from
elsewhere might lack it): if any is found it stops and names them, without
modifying any row.

downgrade() refuses while any project or user is in the Papelera --
dropping the columns would bring them back as active without anyone
deciding it. Restore or delete them permanently first.

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-05

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025"
down_revision: Union[str, None] = "0024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("projects", "users")


def upgrade() -> None:
    bind = op.get_bind()
    duplicates = bind.execute(
        sa.text("SELECT email, count(*) FROM users GROUP BY email HAVING count(*) > 1 ORDER BY email")
    ).fetchall()
    if duplicates:
        listed = ", ".join(f"{email} ({count})" for email, count in duplicates)
        raise RuntimeError(
            f"Migration 0025 stopped: duplicate user emails ({listed}). Nothing was changed; "
            "resolve them by hand and run the migration again."
        )

    for table in _TABLES:
        op.add_column(table, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        op.add_column(
            table,
            sa.Column(
                "deleted_by",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("users.id", ondelete="SET NULL", name=f"{table}_deleted_by_fkey"),
                nullable=True,
            ),
        )
        op.add_column(table, sa.Column("deleted_by_email", sa.String(), nullable=True))

    op.drop_index("ix_users_email", table_name="users")
    op.create_index(
        "ix_users_email",
        "users",
        ["email"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    in_trash = {
        table: bind.execute(sa.text(f"SELECT count(*) FROM {table} WHERE deleted_at IS NOT NULL")).scalar_one()
        for table in _TABLES
    }
    if any(in_trash.values()):
        raise RuntimeError(
            "Migration 0025 cannot be downgraded: "
            + ", ".join(f"{count} {table}" for table, count in in_trash.items() if count)
            + " in the Papelera would come back as active. Restore them or delete them permanently first."
        )

    op.drop_index("ix_users_email", table_name="users")
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    for table in _TABLES:
        op.drop_column(table, "deleted_by_email")
        op.drop_column(table, "deleted_by")
        op.drop_column(table, "deleted_at")
