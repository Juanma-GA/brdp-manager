"""Administration reads with no screen (Protecciones 2a).

GET /api/admin/llm-usage?days=N: calls to the LLM per user and day, split
by kind (chat / embedding) and result, from llm_calls. Admins only.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.db.base import get_db
from app.models import LlmCall, User
from app.schemas.llm_usage import LlmUsageOut, LlmUsageRow

router = APIRouter(prefix="/api/admin", tags=["admin"])

# A year: enough to look back over the whole use of a deployment.
MAX_USAGE_DAYS = 366


@router.get("/llm-usage", response_model=LlmUsageOut)
async def llm_usage(
    days: int = Query(7, ge=1, le=MAX_USAGE_DAYS),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> LlmUsageOut:
    """The last `days` days (a moving window back from now), grouped by the
    UTC day of each call. Deleted users stay, marked; calls with no user
    (an embedding job whose user is not known) come with user_id null."""
    day = cast(func.timezone("UTC", LlmCall.created_at), Date).label("day")
    stmt = (
        select(
            day,
            LlmCall.user_id,
            User.email,
            User.deleted_at,
            LlmCall.kind,
            LlmCall.result,
            func.count().label("calls"),
            func.coalesce(func.sum(LlmCall.request_chars), 0).label("request_chars"),
        )
        .outerjoin(User, User.id == LlmCall.user_id)
        .where(LlmCall.created_at >= func.now() - func.make_interval(0, 0, 0, days))
        .group_by(day, LlmCall.user_id, User.email, User.deleted_at, LlmCall.kind, LlmCall.result)
        .order_by(day.desc(), User.email, LlmCall.kind, LlmCall.result)
    )
    rows = (await db.execute(stmt)).all()
    return LlmUsageOut(
        days=days,
        rows=[
            LlmUsageRow(
                day=r.day,
                user_id=r.user_id,
                user_email=r.email,
                user_deleted=r.deleted_at is not None,
                kind=r.kind,
                result=r.result,
                calls=r.calls,
                request_chars=r.request_chars,
            )
            for r in rows
        ],
    )
