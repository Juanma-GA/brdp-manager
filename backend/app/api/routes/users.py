import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.security import generate_temporary_password, hash_password
from app.db.base import get_db
from app.models import RefreshToken, User, UserProjectRole
from app.schemas.auth import UserOut
from app.schemas.user import (
    ProjectRoleAssign,
    ProjectRoleOut,
    TemporaryPasswordOut,
    UserCreate,
    UserCreateOut,
    UserUpdate,
    UserWithRolesOut,
)

router = APIRouter(prefix="/api/users", tags=["users"])


def _require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.global_role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return current_user


@router.get("", response_model=list[UserWithRolesOut])
async def list_users(_admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)):
    users = (await db.execute(select(User))).scalars().all()
    out = []
    for user in users:
        roles = (
            (await db.execute(select(UserProjectRole).where(UserProjectRole.user_id == user.id)))
            .scalars()
            .all()
        )
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
    existing = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    temporary_password = generate_temporary_password()
    user = User(
        email=body.email,
        password_hash=hash_password(temporary_password),
        display_name=body.display_name,
        global_role=body.global_role,
        must_change_password=True,
    )
    db.add(user)
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
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    temporary_password = generate_temporary_password()
    user.password_hash = hash_password(temporary_password)
    user.must_change_password = True

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )

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
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if body.email != user.email:
        existing = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
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
    """Admin-only. Cascade is real DB-level ON DELETE CASCADE on
    refresh_tokens.user_id and user_project_roles.user_id (see the 0001
    migration) -- nothing else references users.id, so brdps/notes/
    rule_approvals are never touched by deleting a user.

    Two guards, both enforced here (not just hidden in the UI):
    - The last remaining admin in the system cannot be deleted -- the
      system must always keep at least one account able to manage users.
      Checked first: since only an admin can ever call this endpoint, the
      one case where this fires is necessarily an admin deleting
      themselves while they're the sole admin, so it takes priority over
      the plain self-delete message below (more specific reason).
    - An admin cannot delete their own account AT ALL, even when they are
      not the last one -- otherwise deleting your own account mid-session
      would work as long as another admin happens to exist.
    """
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if user.global_role == "admin":
        admin_count = (
            await db.execute(select(func.count()).select_from(User).where(User.global_role == "admin"))
        ).scalar_one()
        if admin_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete the last remaining admin"
            )

    if user_id == admin.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own account")

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

    existing = (
        await db.execute(
            select(UserProjectRole).where(
                UserProjectRole.user_id == user_id, UserProjectRole.project_id == body.project_id
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.role = body.role
        assignment = existing
    else:
        assignment = UserProjectRole(user_id=user_id, project_id=body.project_id, role=body.role)
        db.add(assignment)
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
        await db.delete(existing)
        await db.commit()
