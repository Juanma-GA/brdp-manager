import asyncio
import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict

from app.api.deps import get_current_user, get_httpx_transport
from app.core.config import get_settings
from app.core.errors import error_detail, new_error_ref
from app.models import User
from app.services import llm_usage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/llm-proxy", tags=["llm-proxy"])


class LLMProxyRequest(BaseModel):
    # Only the already-built, provider-shaped request body -- unlike v1's
    # /api/proxy, `targetEndpoint` and `apiKey` are never accepted from the
    # client (any other field is refused). The server resolves both from its
    # own ACTIVE_LLM_PROVIDER config (docs/v2 §4.2 -- closes S2/SSRF and
    # S3/plaintext-key-on-client by construction, not by convention).
    model_config = ConfigDict(extra="forbid")

    payload: dict


# AACF 1, Part 5: the parameters the app sends today (src/api/llmAPI.js).
# The model is not one of them: the server sets it from .env (Decisión 4,
# one LLM). Anything else, or a max_tokens over Settings.llm_max_tokens, is
# refused with a code the frontend translates -- never adjusted silently.
ALLOWED_PAYLOAD_PARAMS = ("messages", "temperature", "max_tokens")
_MESSAGE_ROLES = {"system", "user", "assistant"}


def _payload_problem(payload: dict) -> dict | None:
    """The reason the payload is refused, as an error detail, or None."""
    not_allowed = sorted(k for k in payload if k not in ALLOWED_PAYLOAD_PARAMS)
    if not_allowed:
        return error_detail("llm_params_not_allowed", params=not_allowed, allowed=list(ALLOWED_PAYLOAD_PARAMS))
    messages = payload.get("messages")
    if (
        not isinstance(messages, list)
        or not messages
        or not all(
            isinstance(m, dict) and set(m) == {"role", "content"} and m["role"] in _MESSAGE_ROLES and isinstance(m["content"], str)
            for m in messages
        )
    ):
        return error_detail("llm_messages_invalid")
    temperature = payload.get("temperature")
    if temperature is not None and (isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or temperature < 0):
        return error_detail("llm_temperature_invalid")
    max_tokens = payload.get("max_tokens")
    limit = get_settings().llm_max_tokens
    if max_tokens is not None:
        if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens < 1:
            return error_detail("llm_max_tokens_invalid", max=limit)
        if max_tokens > limit:
            return error_detail("llm_max_tokens_too_high", max=limit, requested=max_tokens)
    return None


def _model() -> str:
    settings = get_settings()
    return settings.mistral_model if settings.active_llm_provider == "mistral" else settings.qwen_chat_model


def _resolve_provider() -> tuple[str, str]:
    # FastAPI's default handler for HTTPException just serializes {"detail":
    # ...} to the client -- it never logs anything server-side, for ANY
    # status code, including these deliberate 500s. So every raise here
    # needs its own explicit log line, or a real misconfiguration (wrong
    # ACTIVE_LLM_PROVIDER, empty API key) would leave zero trace in the
    # server's own logs despite firing on every single request.
    settings = get_settings()
    if settings.active_llm_provider == "mistral":
        endpoint, api_key = settings.mistral_endpoint, settings.mistral_api_key
    elif settings.active_llm_provider == "qwen":
        endpoint, api_key = settings.qwen_endpoint, settings.qwen_api_key
    else:
        ref = new_error_ref()
        logger.error("ref=%s Unknown ACTIVE_LLM_PROVIDER: %r", ref, settings.active_llm_provider)
        raise HTTPException(status_code=500, detail=error_detail("llm_not_configured", ref))
    if not endpoint or not api_key:
        ref = new_error_ref()
        logger.error("ref=%s LLM provider '%s' is not fully configured on the server", ref, settings.active_llm_provider)
        raise HTTPException(status_code=500, detail=error_detail("llm_not_configured", ref))
    return endpoint, api_key


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


class _ProviderTimeout(Exception):
    """The provider did not send anything within the time limit."""


def _timeout_seconds() -> float | None:
    seconds = get_settings().llm_request_timeout_seconds
    return seconds if seconds > 0 else None


async def _within(awaitable, timeout: float | None):
    """Awaits within the time limit (Settings.llm_request_timeout_seconds,
    None = no limit); over it, _ProviderTimeout."""
    if timeout is None:
        return await awaitable
    try:
        return await asyncio.wait_for(awaitable, timeout)
    except asyncio.TimeoutError as exc:
        raise _ProviderTimeout from exc


def _timeout_exception(seconds: float) -> HTTPException:
    return HTTPException(status_code=504, detail=error_detail("llm_timeout", seconds=int(seconds)))


@router.post("")
async def llm_proxy(
    body: LLMProxyRequest,
    current_user: User = Depends(get_current_user),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> Response:
    """Byte-for-byte pass-through of the upstream response (same behavior
    as v1's server.js pump loop) -- preserves streaming SSE chunks exactly
    as the provider sent them; llmAPI.js's parsing logic doesn't change,
    only the URL it calls (docs/v2 §5.1). A JSON answer is read whole
    before it is sent on; an SSE stream is passed on as it arrives.

    Time limit (Settings.llm_request_timeout_seconds, 0 = none): until the
    provider starts answering and between two chunks of the answer. Over
    it, a 504 llm_timeout {seconds} (for an SSE stream already started,
    the stream ends) and a "failed" row with its duration.

    Every call leaves one llm_calls row (Protecciones 2a, services/
    llm_usage.py), also a refused or failed one: a payload refused here
    or a server without a configured provider is "failed" (the provider
    was never called). The row is written when the call starts and
    finished when it ends -- for a streamed answer, when the stream ends
    ("failed" if it is cut).
    """
    started = time.monotonic()
    request_chars = llm_usage.chat_request_chars(body.payload)
    problem = _payload_problem(body.payload)
    if problem:
        await llm_usage.record_call(
            user_id=current_user.id,
            kind=llm_usage.KIND_CHAT,
            result=llm_usage.RESULT_FAILED,
            duration_ms=_elapsed_ms(started),
            request_chars=request_chars,
        )
        raise HTTPException(status_code=422, detail=problem)

    # Protecciones 2a, Part 2: the per-user limits (Settings llm_calls_per_
    # minute / per_day). Over one, a 429 the frontend waits on (minute) or
    # explains (day); the provider is never called.
    call_id, limited = await llm_usage.start_chat_call(current_user.id, request_chars)
    if limited:
        raise HTTPException(
            status_code=429,
            detail=error_detail(
                "llm_rate_limited",
                limit=limited.limit,
                window=limited.window,
                retry_after_seconds=limited.retry_after_seconds,
                message=f"Limit of {limited.limit} AI requests per {limited.window} reached; "
                f"try again in {limited.retry_after_seconds} s.",
            ),
            headers={"Retry-After": str(limited.retry_after_seconds)},
        )
    try:
        endpoint, api_key = _resolve_provider()
    except HTTPException:
        await llm_usage.finish_call(call_id, result=llm_usage.RESULT_FAILED, duration_ms=_elapsed_ms(started))
        raise
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    upstream_payload = {"model": _model(), **body.payload}

    # The time limit is applied here, by the proxy, and not by httpx: the
    # same wait for every transport (tests use a MockTransport, which
    # ignores httpx's own timeouts), until the response starts and then
    # between two chunks of it.
    timeout = _timeout_seconds()
    http_client = httpx.AsyncClient(timeout=None, transport=transport)
    try:
        request = http_client.build_request("POST", endpoint, headers=headers, json=upstream_payload)
        upstream = await _within(http_client.send(request, stream=True), timeout)
    except _ProviderTimeout:
        logger.warning("LLM provider (%s) did not answer within %s s", endpoint, timeout)
        await http_client.aclose()
        await llm_usage.finish_call(call_id, result=llm_usage.RESULT_FAILED, duration_ms=_elapsed_ms(started))
        raise _timeout_exception(timeout)
    except Exception:
        # The client only ever gets a generic 500 back (docs/v2 S8 -- never
        # leak upstream connection internals to it), but that must never
        # mean the failure itself goes unrecorded. A corporate proxy doing
        # SSL interception (SSLCertVerificationError), a DNS failure, a
        # connect timeout -- log the real exception with its full
        # traceback before returning the generic response.
        ref = new_error_ref()
        logger.exception("ref=%s LLM proxy request to the upstream provider (%s) failed", ref, endpoint)
        await http_client.aclose()
        await llm_usage.finish_call(call_id, result=llm_usage.RESULT_FAILED, duration_ms=_elapsed_ms(started))
        raise HTTPException(status_code=500, detail=error_detail("llm_request_failed", ref))

    if upstream.status_code >= 400:
        try:
            error_body = await upstream.aread()
        finally:
            await upstream.aclose()
            await http_client.aclose()
        ref = new_error_ref()
        logger.error(
            "ref=%s Upstream LLM provider (%s) returned status %s: %s",
            ref,
            endpoint,
            upstream.status_code,
            error_body.decode(errors="replace"),
        )
        await llm_usage.finish_call(
            call_id,
            result=llm_usage.RESULT_UPSTREAM_ERROR,
            upstream_status=upstream.status_code,
            duration_ms=_elapsed_ms(started),
        )
        # The provider's own body stays in the log (Decisión 12). Its status
        # is kept, except 401/403: those are about the SERVER's API key, and
        # passed through they would make the browser refresh -- and then
        # end -- the user's own session.
        status_code = 502 if upstream.status_code in (401, 403) else upstream.status_code
        raise HTTPException(
            status_code=status_code, detail=error_detail("llm_upstream_error", ref, upstream_status=upstream.status_code)
        )

    content_type = upstream.headers.get("content-type", "application/json")
    chunks = upstream.aiter_bytes()

    if not content_type.startswith("text/event-stream"):
        # A single JSON answer -- the only kind the app asks for (`stream`
        # is not an allowed parameter). It is read whole before answering,
        # so a provider that stops in the middle of it ends in the same 504
        # as one that never starts (an error the page can show), never in
        # a half answer.
        body_parts: list[bytes] = []
        try:
            while True:
                try:
                    body_parts.append(await _within(chunks.__anext__(), timeout))
                except StopAsyncIteration:
                    break
        except _ProviderTimeout:
            logger.warning("LLM provider (%s) stopped sending its answer for %s s", endpoint, timeout)
            await llm_usage.finish_call(
                call_id, result=llm_usage.RESULT_FAILED, upstream_status=upstream.status_code, duration_ms=_elapsed_ms(started)
            )
            raise _timeout_exception(timeout)
        except Exception:
            ref = new_error_ref()
            logger.exception("ref=%s LLM proxy answer from the upstream provider (%s) failed mid-response", ref, endpoint)
            await llm_usage.finish_call(
                call_id, result=llm_usage.RESULT_FAILED, upstream_status=upstream.status_code, duration_ms=_elapsed_ms(started)
            )
            raise HTTPException(status_code=500, detail=error_detail("llm_request_failed", ref))
        finally:
            await upstream.aclose()
            await http_client.aclose()
        await llm_usage.finish_call(
            call_id, result=llm_usage.RESULT_OK, upstream_status=upstream.status_code, duration_ms=_elapsed_ms(started)
        )
        return Response(content=b"".join(body_parts), media_type=content_type)

    async def _pump():
        completed = False
        try:
            while True:
                try:
                    chunk = await _within(chunks.__anext__(), timeout)
                except StopAsyncIteration:
                    break
                yield chunk
            completed = True
        except _ProviderTimeout:
            # Headers are already sent: the stream just ends, recorded as
            # failed (no new status code can reach the client any more).
            logger.warning("LLM provider (%s) stream stalled for %s s; ended", endpoint, timeout)
        except Exception:
            # Response headers are already sent by this point, so the
            # client can't be given a fresh status code -- the stream just
            # ends -- but the server must still record what happened
            # instead of failing silently mid-response.
            logger.exception("LLM proxy stream from upstream provider (%s) failed mid-response", endpoint)
            raise
        finally:
            # Not awaited: this runs while the response may be cancelled
            # (the client went away), where an await is not safe.
            llm_usage.finish_call_later(
                call_id,
                result=llm_usage.RESULT_OK if completed else llm_usage.RESULT_FAILED,
                upstream_status=upstream.status_code,
                duration_ms=_elapsed_ms(started),
            )
            await upstream.aclose()
            await http_client.aclose()

    return StreamingResponse(_pump(), media_type=content_type)
