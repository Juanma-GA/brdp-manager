from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.rate_limit import clear_attempts, is_locked_out, record_failed_attempt
from app.core.security import (
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)
from app.db.base import get_db
from app.models import RefreshToken, User
from app.schemas.auth import ChangePasswordRequest, LoginRequest, MeUpdate, RefreshRequest, TokenResponse, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])


async def _issue_tokens(user: User, db: AsyncSession) -> TokenResponse:
    settings = get_settings()
    access_token = create_access_token(user.id)
    raw_refresh, refresh_hash = generate_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=refresh_hash,
            expires_at=datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    await db.commit()
    return TokenResponse(access_token=access_token, refresh_token=raw_refresh)


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    if is_locked_out(body.email):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Try again later.",
        )

    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        record_failed_attempt(body.email)
        # Same error for "no such user" and "wrong password" -- never
        # reveal which one to an unauthenticated caller.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    clear_attempts(body.email)
    return await _issue_tokens(user, db)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    token_hash = hash_refresh_token(body.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    stored = result.scalar_one_or_none()

    invalid = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")
    if stored is None or stored.revoked_at is not None:
        raise invalid
    if stored.expires_at < datetime.now(timezone.utc):
        raise invalid

    user = await db.get(User, stored.user_id)
    if user is None:
        raise invalid

    # Rotate: revoke the token that was just used, issue a fresh pair. Limits
    # the blast radius of a leaked refresh token to a single use.
    stored.revoked_at = datetime.now(timezone.utc)
    await db.commit()
    return await _issue_tokens(user, db)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(body: RefreshRequest, db: AsyncSession = Depends(get_db)) -> None:
    token_hash = hash_refresh_token(body.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    stored = result.scalar_one_or_none()
    if stored is not None and stored.revoked_at is None:
        stored.revoked_at = datetime.now(timezone.utc)
        await db.commit()
    # Logging out an already-revoked or unknown token is a no-op, not an
    # error -- the caller's goal (no valid session left) is already true.


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user


@router.patch("/me", response_model=UserOut)
async def update_me(
    body: MeUpdate, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> User:
    """Self-service profile edit -- MeUpdate has no email/global_role field
    at all, so neither can be smuggled in here regardless of what the
    request body contains (no admin self-grant possible through this
    endpoint, unlike PATCH /api/users/{id} which is admin-only anyway).
    """
    current_user.display_name = body.display_name
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Separate from PATCH /me on purpose -- that endpoint stays limited to
    display_name and never sees a password. 403 (not 401): the caller is
    already authenticated via a valid access token, they just haven't
    proven they know the CURRENT password, which is a different failure
    than "not logged in" -- same reasoning as _require_admin's 403 for an
    authenticated-but-insufficiently-privileged caller.
    """
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Current password is incorrect")

    current_user.password_hash = hash_password(body.new_password)

    # Revoke every OTHER active refresh token for this user in one UPDATE
    # (docs request) -- an access token isn't tied to the password hash at
    # all, so it keeps working until its own short natural expiry either
    # way; this is what actually forces other sessions to re-login, on
    # their next /refresh.
    conditions = [RefreshToken.user_id == current_user.id, RefreshToken.revoked_at.is_(None)]
    if body.current_refresh_token:
        conditions.append(RefreshToken.token_hash != hash_refresh_token(body.current_refresh_token))
    await db.execute(update(RefreshToken).where(*conditions).values(revoked_at=datetime.now(timezone.utc)))

    await db.commit()
