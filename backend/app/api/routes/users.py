import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import error_detail
from app.api.deps import get_current_user, project_not_found, require_admin
from app.core.security import generate_temporary_password, hash_password
from app.db.base import get_db
from app.models import Project, RefreshToken, User, UserProjectRole
from app.repositories.project_repository import (
    ACTIVE_PROJECT_IDS,
    ACTIVE_USER_FILTER,
    get_active_project,
    get_active_user,
    get_deleted_user,
)
from app.schemas.auth import UserOut
from app.services.audit import record
from app.schemas.user import (
    DeletedUserOut,
    ProjectRoleAssign,
    ProjectRoleOut,
    TemporaryPasswordOut,
    UserCreate,
    UserCreateOut,
    UserUpdate,
    UserWithRolesOut,
)

router = APIRouter(prefix="/api/users", tags=["users"])


# Shared with the other admin-only routes (app/api/deps.py).
_require_admin = require_admin


# ── Audit log (Protecciones 2b) ─────────────────────────────────────────
# Every write below that the app cannot undo by itself, or that changes
# who can do what, stages one audit_log row in the same transaction.


def _record_user(db: AsyncSession, actor: User, action: str, user: User, detail: dict | None = None) -> None:
    """target_label is the user's email as it was before the action."""
    record(
        db,
        actor,
        action,
        target_type="user",
        target_id=user.id,
        target_label=user.email,
        detail=detail,
    )


def _record_role(
    db: AsyncSession,
    actor: User,
    action: str,
    user: User,
    project: Project,
    old_role: str | None,
    new_role: str | None,
) -> None:
    """target = the user whose role changed (their email as label), with
    the project; detail = role before and after (None when there was none
    or there is none any more)."""
    record(
        db,
        actor,
        action,
        target_type="project_role",
        target_id=user.id,
        target_label=user.email,
        project_id=project.id,
        project_name=project.name,
        detail={"old_role": old_role, "new_role": new_role},
    )


@router.get("", response_model=list[UserWithRolesOut])
async def list_users(_admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)):
    # Active users only, and only their roles on active projects (AACF 2):
    # a deleted user is in "Deleted users" below; a role on a project in the
    # Papelera is kept for its restore but grants nothing meanwhile.
    users = (await db.execute(select(User).where(ACTIVE_USER_FILTER))).scalars().all()
    # One query for every user's roles (never one per user).
    role_rows = (
        await db.execute(select(UserProjectRole).where(UserProjectRole.project_id.in_(ACTIVE_PROJECT_IDS)))
    ).scalars().all()
    roles_by_user: dict = {}
    for role in role_rows:
        roles_by_user.setdefault(role.user_id, []).append(role)
    out = []
    for user in users:
        roles = roles_by_user.get(user.id, [])
        out.append(
            UserWithRolesOut(
                id=user.id,
                email=user.email,
                display_name=user.display_name,
                global_role=user.global_role,
                must_change_password=user.must_change_password,
                project_roles=[ProjectRoleOut.model_validate(r) for r in roles],
            )
        )
    return out


@router.post("", response_model=UserCreateOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate, _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> UserCreateOut:
    """No password comes from the admin at all (docs request: unified with
    Reset password below) -- a real random temporary is generated here,
    must_change_password starts True, and the temporary is returned in
    THIS response only. It is never stored in plaintext, never logged,
    and there is no way to retrieve it again after this call returns.
    """
    existing = (await db.execute(select(User).where(User.email == body.email))).scalars().all()
    if any(u.deleted_at is None for u in existing):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_detail("user_email_registered", message="Email already registered", email=body.email),
        )
    deleted = next((u for u in existing if u.deleted_at is not None), None)
    if deleted is not None:
        # AACF 2, Part 4.6: never a second account for the same person --
        # the deleted one is offered for a restore instead.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "user_deleted_exists",
                "user_id": str(deleted.id),
                "email": deleted.email,
                "message": "A deleted user already has this email; restore that user instead.",
            },
        )

    temporary_password = generate_temporary_password()
    user = User(
        email=body.email,
        password_hash=hash_password(temporary_password),
        display_name=body.display_name,
        global_role=body.global_role,
        must_change_password=True,
    )
    db.add(user)
    await db.flush()  # assigns user.id for the audit row
    _record_user(db, _admin, "user.created", user, {"global_role": user.global_role})
    await db.commit()
    await db.refresh(user)
    return UserCreateOut(**UserOut.model_validate(user).model_dump(), temporary_password=temporary_password)


@router.post("/{user_id}/reset-password", response_model=TemporaryPasswordOut)
async def reset_password(
    user_id: uuid.UUID,
    _admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> TemporaryPasswordOut:
    """Same mechanism as create_user (docs request: unify, no fixed value
    like "1234" -- that's a known credential anyone with app access could
    exploit, and it would violate MIN_PASSWORD_LENGTH anyway): a real
    random temporary password, returned in plaintext exactly once in this
    response, must_change_password set True so the frontend forces the
    Change Password screen on next login.

    Also revokes every active refresh token for this user, unconditionally
    (unlike self-service change-password, there is no "current session to
    exclude" here -- an admin resetting someone else's password is, by
    definition, acting on a session that isn't their own).
    """
    user = await get_active_user(user_id, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_detail("user_not_found", message="User not found"))

    temporary_password = generate_temporary_password()
    user.password_hash = hash_password(temporary_password)
    user.must_change_password = True

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )
    # Never the temporary password in the audit row.
    _record_user(db, _admin, "user.password_reset", user)

    await db.commit()
    return TemporaryPasswordOut(temporary_password=temporary_password)


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    _admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Admin-only edit of another user's email/display_name -- global_role
    is deliberately not part of UserUpdate at all (this round's spec: only
    assignable at creation), so it can't be changed through this endpoint
    regardless of what the request body contains.
    """
    user = await get_active_user(user_id, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_detail("user_not_found", message="User not found"))
    if body.email != user.email:
        # Any user with that email, active or deleted: a deleted user's
        # email stays theirs, so a restore never finds it taken.
        existing = (await db.execute(select(User.id).where(User.email == body.email))).first()
        if existing is not None:
            raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_detail("user_email_registered", message="Email already registered", email=body.email),
        )
    if body.email != user.email or body.display_name != user.display_name:
        _record_user(
            db,
            _admin,
            "user.updated",
            user,
            {
                "email": {"old": user.email, "new": body.email},
                "display_name": {"old": user.display_name, "new": body.display_name},
            },
        )
    user.email = body.email
    user.display_name = body.display_name
    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Admin-only. AACF 2 (Decisión 13): the user is marked deleted
    (deleted_at/deleted_by/deleted_by_email) and every refresh token of
    theirs is revoked at once -- they cannot log in, their open session ends
    at its next request (get_current_user and /refresh refuse a deleted
    user), and they leave the user list and role selectors. Their project
    roles are kept for a restore; History keeps their email as always.

    Two guards, both enforced here (not just hidden in the UI):
    - The last remaining (active) admin cannot be deleted -- the system
      must always keep at least one account able to manage users. Checked
      first: since only an admin can ever call this endpoint, the one case
      where this fires is necessarily an admin deleting themselves while
      they're the sole admin, so it takes priority over the plain
      self-delete message below (more specific reason).
    - An admin cannot delete their own account AT ALL, even when they are
      not the last one.
    """
    user = await get_active_user(user_id, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_detail("user_not_found", message="User not found"))

    if user.global_role == "admin":
        admin_count = (
            await db.execute(
                select(func.count()).select_from(User).where(User.global_role == "admin", ACTIVE_USER_FILTER)
            )
        ).scalar_one()
        if admin_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_detail("user_last_admin", message="Cannot delete the last remaining admin"),
            )

    if user_id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_detail("user_cannot_delete_self", message="You cannot delete your own account"),
        )

    now = datetime.now(timezone.utc)
    user.deleted_at = now
    user.deleted_by = admin.id
    user.deleted_by_email = admin.email
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    _record_user(db, admin, "user.trashed", user, {"global_role": user.global_role})
    await db.commit()


@router.get("/deleted", response_model=list[DeletedUserOut])
async def list_deleted_users(_admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)):
    users = (
        await db.execute(select(User).where(User.deleted_at.is_not(None)).order_by(User.deleted_at.desc()))
    ).scalars().all()
    return [DeletedUserOut.model_validate(u) for u in users]


@router.post("/{user_id}/restore", response_model=UserOut)
async def restore_user(
    user_id: uuid.UUID, _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> User:
    """Brings the user back with the roles they still have: a role on a
    project deleted permanently meanwhile went with that project (ON DELETE
    CASCADE), so they come back without it. They log in with the password
    they had (their sessions were revoked when deleted)."""
    user = await get_deleted_user(user_id, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Deleted user not found")
    taken = (
        await db.execute(select(User.id).where(User.email == user.email, ACTIVE_USER_FILTER))
    ).first()
    if taken is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "user_email_taken",
                "email": user.email,
                "message": "An active user already has this email.",
            },
        )
    user.deleted_at = None
    user.deleted_by = None
    user.deleted_by_email = None
    _record_user(db, _admin, "user.restored", user)
    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/{user_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_permanently(
    user_id: uuid.UUID, _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> None:
    """The real delete of a user already deleted: their roles and refresh
    tokens go with them (ON DELETE CASCADE); History keeps the email stored
    in each entry (user_id SET NULL), as before AACF 2."""
    user = await get_deleted_user(user_id, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Deleted user not found")
    # The roles go with the user (ON DELETE CASCADE): the audit row keeps
    # which ones they had, with each project's name as it is now.
    role_rows = (
        await db.execute(
            select(Project.name, UserProjectRole.role)
            .join(Project, Project.id == UserProjectRole.project_id)
            .where(UserProjectRole.user_id == user.id)
            .order_by(Project.name)
        )
    ).all()
    _record_user(
        db,
        _admin,
        "user.deleted_permanently",
        user,
        {"global_role": user.global_role, "project_roles": [{"project": n, "role": r} for n, r in role_rows]},
    )
    await db.delete(user)
    await db.commit()


@router.put("/{user_id}/project-roles", response_model=ProjectRoleOut)
async def assign_project_role(
    user_id: uuid.UUID,
    body: ProjectRoleAssign,
    _admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> UserProjectRole:
    if body.role not in ("viewer", "editor"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="role must be viewer or editor")
    user = await get_active_user(user_id, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_detail("user_not_found", message="User not found"))
    project = await get_active_project(body.project_id, db)
    if project is None:
        raise project_not_found()

    existing = (
        await db.execute(
            select(UserProjectRole).where(
                UserProjectRole.user_id == user_id, UserProjectRole.project_id == body.project_id
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.role != body.role:
            _record_role(db, _admin, "project_role.changed", user, project, existing.role, body.role)
        existing.role = body.role
        assignment = existing
    else:
        assignment = UserProjectRole(user_id=user_id, project_id=body.project_id, role=body.role)
        db.add(assignment)
        _record_role(db, _admin, "project_role.assigned", user, project, None, body.role)
    await db.commit()
    return assignment


@router.delete("/{user_id}/project-roles/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_project_role(
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    _admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    existing = (
        await db.execute(
            select(UserProjectRole).where(
                UserProjectRole.user_id == user_id, UserProjectRole.project_id == project_id
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        # The user and the project may be in the Papelera (a role there is
        # kept for a restore and can still be removed): read them as rows.
        user = await db.get(User, user_id)
        project = await db.get(Project, project_id)
        _record_role(db, _admin, "project_role.removed", user, project, existing.role, None)
        await db.delete(existing)
        await db.commit()
