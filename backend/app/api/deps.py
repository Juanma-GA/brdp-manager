import uuid

import httpx
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_access_token
from app.db.base import get_db
from app.models import User, UserProjectRole

_bearer_scheme = HTTPBearer(auto_error=False)

_ROLE_RANK = {"viewer": 0, "editor": 1}


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Rejects: missing Authorization header, expired token, token signed
    with a different key, and any other malformed/invalid token -- all with
    the same 401, never revealing which (docs/v2 §6 test requirement).
    Never trusts a role claimed by the client; this only establishes WHO is
    calling, never WHAT they can do (see require_project_role below).
    """
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None:
        raise unauthorized

    try:
        payload = decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise unauthorized

    try:
        user_id = uuid.UUID(payload.get("sub", ""))
    except ValueError:
        raise unauthorized

    user = await db.get(User, user_id)
    if user is None:
        raise unauthorized
    return user


async def has_project_role(current_user: User, project_id: uuid.UUID, min_role: str, db: AsyncSession) -> bool:
    """Core check behind require_project_role, factored out so an endpoint
    that ISN'T path-scoped by project_id (e.g. POST /api/suggestion-feedback,
    scoped by brdp_id instead -- its project_id has to be looked up from
    the BRDP row first) can still apply the exact same rule, rather than
    reimplementing it or skipping the check because require_project_role's
    dependency signature can't bind to a param FastAPI never sees in the
    path.
    """
    if current_user.global_role == "admin":
        return True

    result = await db.execute(
        select(UserProjectRole).where(
            UserProjectRole.user_id == current_user.id,
            UserProjectRole.project_id == project_id,
        )
    )
    assignment = result.scalar_one_or_none()
    return assignment is not None and _ROLE_RANK.get(assignment.role, -1) >= _ROLE_RANK[min_role]


def require_project_role(min_role: str):
    """Dependency factory for project-scoped endpoints (Phase 3's
    brdps/notes/approvals routes). `project_id` is bound from the route's
    own path parameter of the same name -- FastAPI matches dependency
    parameters against path params by name.

    global_role='admin' bypasses per-project checks entirely (§4.3: admin
    acts on any project). Everyone else needs a user_project_roles row at
    or above `min_role` -- never trusts a role the client claims.
    """

    async def dependency(
        project_id: uuid.UUID,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if not await has_project_role(current_user, project_id, min_role, db):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authorized for this project",
            )
        return current_user

    return dependency


def get_httpx_transport() -> httpx.AsyncBaseTransport | None:
    """Overridden in tests (app.dependency_overrides) with an
    httpx.MockTransport so api/routes/llm_proxy.py can be tested without a
    real Mistral/Qwen API key -- production leaves this None, which makes
    httpx.AsyncClient use its real network transport.
    """
    return None
