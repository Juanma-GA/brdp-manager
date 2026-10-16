"""Ending sessions: one place, so the rotation grace (auth.py refresh,
REFRESH_TOKEN_REUSE_GRACE_SECONDS) never revives a session closed on purpose.

A refresh token replaced by a refresh keeps ``rotated_at``; within the grace
it still refreshes. Every revocation that ENDS sessions -- logout, password
change, password reset, user deleted -- goes through ``end_sessions``, which
revokes the active tokens and clears ``rotated_at`` on the user's tokens, so
none of them is inside the grace any more.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RefreshToken


async def end_sessions(db: AsyncSession, user_id: uuid.UUID, *, keep_hash: str | None = None, only_hash: str | None = None) -> None:
    """Revoke the user's active refresh tokens and take every one of them
    out of the rotation grace. ``keep_hash``: leave that token (the caller's
    own session, on a password change) as it is. ``only_hash``: end just
    that token's session (logout) -- the user's tokens rotated within the
    grace are also taken out of it, since one of them is that session's own
    previous cookie (another tab mid-refresh may then need to log in again,
    which a logout may cost)."""
    now = datetime.now(timezone.utc)
    revoke = [RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)]
    grace = [RefreshToken.user_id == user_id, RefreshToken.rotated_at.is_not(None)]
    if keep_hash is not None:
        revoke.append(RefreshToken.token_hash != keep_hash)
        grace.append(RefreshToken.token_hash != keep_hash)
    if only_hash is not None:
        revoke.append(RefreshToken.token_hash == only_hash)
    await db.execute(update(RefreshToken).where(*revoke).values(revoked_at=now))
    await db.execute(update(RefreshToken).where(*grace).values(rotated_at=None))
