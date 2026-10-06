"""Audit log of administrative actions (Protecciones 2b, AACF G7/HR9).

record() stages one audit_log row in the caller's session and never
commits: the row goes into the same transaction as the action it
describes. If the row cannot be written, the commit fails and the action
is undone with it -- the opposite of llm_calls, where a usage row that
cannot be written never stops the call. An irreversible admin action is
never done without its record.

detail carries small facts only (a title, a count, a role). Never a
password (not even a temporary one), a token, or the content of a BRDP or
a rule.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog, User

# Every action the log knows; the table's CHECK constraint (migration
# 0028) lists the same values.
AUDIT_ACTIONS = (
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

AUDIT_TARGET_TYPES = ("brdp", "project", "user", "project_role")


def record(
    db: AsyncSession,
    actor: User,
    action: str,
    *,
    target_type: str,
    target_id: uuid.UUID | None,
    target_label: str,
    project_id: uuid.UUID | None = None,
    project_name: str | None = None,
    detail: dict | None = None,
) -> AuditLog:
    """Stage one audit row (db.add, no commit). The caller commits it
    together with the action."""
    if action not in AUDIT_ACTIONS:
        raise ValueError(f"unknown audit action {action!r}")
    if target_type not in AUDIT_TARGET_TYPES:
        raise ValueError(f"unknown audit target type {target_type!r}")
    row = AuditLog(
        actor_id=actor.id,
        actor_email=actor.email,
        action=action,
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        project_id=project_id,
        project_name=project_name,
        detail=detail or {},
    )
    db.add(row)
    return row


async def record_project_deleted_permanently(db: AsyncSession, actor: User, project) -> AuditLog:
    """The permanent delete of a project, from the Papelera or with
    ?permanent=true: one row, with the number of BRDPs it had (active and
    in the Papelera) and its standard -- never one row per BRDP."""
    from sqlalchemy import func, select

    from app.models import BRDP

    brdp_count = (
        await db.execute(select(func.count()).select_from(BRDP).where(BRDP.project_id == project.id))
    ).scalar_one()
    return record(
        db,
        actor,
        "project.deleted_permanently",
        target_type="project",
        target_id=project.id,
        target_label=project.name,
        project_id=project.id,
        project_name=project.name,
        detail={"brdp_count": brdp_count, "standard": project.standard, "was_in_trash": project.deleted_at is not None},
    )
