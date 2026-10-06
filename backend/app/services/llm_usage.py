"""Usage record of every call to the LLM (Protecciones 2a, AACF G7).

One llm_calls row per call: chat through /api/llm-proxy and embeddings
(app/services/embeddings.py). Usage only -- who, when, which kind, how it
ended, how long, how much was sent -- never the content of the messages
or of the answers.

Writing the row must never make the call fail: every write is in its own
session, and any error is logged and swallowed. A chat call's row is
written when the call STARTS (result "failed", no duration) and updated
when it ends, so calls running at the same time count for the per-user
limit (Part 2) from the moment they start; a row left as "failed" with no
duration is a call that never finished (the server stopped mid-call).
"""

import asyncio
import logging
import math
import uuid
from dataclasses import dataclass

from sqlalchemy import func, select, text, update

from app.core.config import get_settings

from app.db import base as db_base
from app.models import LlmCall

logger = logging.getLogger(__name__)

KIND_CHAT = "chat"
KIND_EMBEDDING = "embedding"
RESULT_OK = "ok"
RESULT_UPSTREAM_ERROR = "upstream_error"
RESULT_FAILED = "failed"
RESULT_RATE_LIMITED = "rate_limited"

# Finishing a row from a place where awaiting is not safe (the streaming
# response's finally, which runs while the request may be cancelled): the
# write runs as its own task, kept here so it is never garbage-collected
# before it ends.
_pending_writes: set[asyncio.Task] = set()


def _session():
    # Read at call time, so tests can make the write fail.
    return db_base.async_session_factory()


def chat_request_chars(payload) -> int:
    """Characters sent in a chat request: the text of its messages."""
    messages = payload.get("messages") if isinstance(payload, dict) else None
    if not isinstance(messages, list):
        return 0
    return sum(len(m["content"]) for m in messages if isinstance(m, dict) and isinstance(m.get("content"), str))


async def record_call(
    *,
    user_id: uuid.UUID | None,
    kind: str,
    result: str,
    upstream_status: int | None = None,
    duration_ms: int | None = None,
    request_chars: int = 0,
    text_count: int | None = None,
) -> uuid.UUID | None:
    """Writes one finished call. Returns its id, or None if it could not
    be written (logged; the call goes on)."""
    try:
        async with _session() as session:
            row = LlmCall(
                user_id=user_id,
                kind=kind,
                result=result,
                upstream_status=upstream_status,
                duration_ms=duration_ms,
                request_chars=request_chars,
                text_count=text_count,
            )
            session.add(row)
            await session.commit()
            return row.id
    except Exception:  # noqa: BLE001 -- the record never breaks the call
        logger.exception("Could not record an LLM call (kind=%s, result=%s, user=%s)", kind, result, user_id)
        return None


async def finish_call(
    call_id: uuid.UUID | None, *, result: str, upstream_status: int | None = None, duration_ms: int | None = None
) -> None:
    """Sets how a call started with record_call(result="failed") ended."""
    if call_id is None:
        return
    try:
        async with _session() as session:
            await session.execute(
                update(LlmCall)
                .where(LlmCall.id == call_id)
                .values(result=result, upstream_status=upstream_status, duration_ms=duration_ms)
            )
            await session.commit()
    except Exception:  # noqa: BLE001 -- the record never breaks the call
        logger.exception("Could not finish the record of LLM call %s (result=%s)", call_id, result)


def finish_call_later(call_id: uuid.UUID | None, **fields) -> None:
    """finish_call as its own task, for code that must not await."""
    if call_id is None:
        return
    task = asyncio.get_running_loop().create_task(finish_call(call_id, **fields))
    _pending_writes.add(task)
    task.add_done_callback(_pending_writes.discard)


async def wait_for_pending_writes() -> None:
    """Waits for the writes started with finish_call_later (tests)."""
    while _pending_writes:
        await asyncio.gather(*list(_pending_writes), return_exceptions=True)


# The two windows of the per-user chat limit (Part 2), moving back from now.
WINDOW_SECONDS = {"minute": 60, "day": 24 * 60 * 60}


@dataclass(frozen=True)
class RateLimited:
    """A chat call refused because the user is over a limit."""

    limit: int
    window: str  # "minute" | "day"
    retry_after_seconds: int


def _limits() -> list[tuple[str, int]]:
    # The day first: when both are reached, the day is the one worth
    # telling (waiting a minute would not help).
    settings = get_settings()
    return [(w, n) for w, n in (("day", settings.llm_calls_per_day), ("minute", settings.llm_calls_per_minute)) if n > 0]


async def _over_limit(session, user_id: uuid.UUID) -> RateLimited | None:
    counted = (LlmCall.user_id == user_id, LlmCall.kind == KIND_CHAT, LlmCall.result != RESULT_RATE_LIMITED)
    for window, limit in _limits():
        seconds = WINDOW_SECONDS[window]
        since = func.now() - func.make_interval(0, 0, 0, 0, 0, 0, seconds)
        count = (await session.execute(select(func.count()).where(*counted, LlmCall.created_at > since))).scalar_one()
        if count < limit:
            continue
        # The user is under the limit again when the call at position
        # (count - limit) of the window, oldest first, leaves it.
        leaves = (
            await session.execute(
                select(
                    func.extract("epoch", LlmCall.created_at + func.make_interval(0, 0, 0, 0, 0, 0, seconds) - func.now())
                )
                .where(*counted, LlmCall.created_at > since)
                .order_by(LlmCall.created_at)
                .offset(count - limit)
                .limit(1)
            )
        ).scalar_one_or_none()
        retry_after = max(1, math.ceil(float(leaves or 1)))
        return RateLimited(limit=limit, window=window, retry_after_seconds=retry_after)
    return None


async def start_chat_call(user_id: uuid.UUID, request_chars: int) -> tuple[uuid.UUID | None, RateLimited | None]:
    """Checks the user's chat limits and records the call (Part 2).

    Over a limit: a "rate_limited" row (it never counts for the limit) and
    the reason; the provider must not be called. Otherwise: the row of a
    call in progress, to finish with finish_call. Counted from llm_calls
    over moving windows (the last 60 s, the last 24 h), so the limit holds
    across processes and browser tabs; a per-user advisory lock makes
    simultaneous calls count one after another. If the database cannot be
    read the call goes on (logged): the record never stops the LLM.
    """
    try:
        async with _session() as session:
            limited = None
            if _limits():
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": f"llm-calls:{user_id}"}
                )
                limited = await _over_limit(session, user_id)
            row = LlmCall(
                user_id=user_id,
                kind=KIND_CHAT,
                result=RESULT_RATE_LIMITED if limited else RESULT_FAILED,
                request_chars=request_chars,
                duration_ms=0 if limited else None,
            )
            session.add(row)
            await session.commit()
            return row.id, limited
    except Exception:  # noqa: BLE001 -- the record never breaks the call
        logger.exception("Could not check or record an LLM call (kind=chat, user=%s)", user_id)
        return None, None
