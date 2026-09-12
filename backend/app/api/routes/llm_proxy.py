import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.deps import get_current_user, get_httpx_transport
from app.core.config import get_settings
from app.models import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/llm-proxy", tags=["llm-proxy"])


class LLMProxyRequest(BaseModel):
    # Only the already-built, provider-shaped request body -- unlike v1's
    # /api/proxy, `targetEndpoint` and `apiKey` are never accepted from the
    # client. The server resolves both from its own ACTIVE_LLM_PROVIDER
    # config (docs/v2 §4.2 -- closes S2/SSRF and S3/plaintext-key-on-client
    # by construction, not by convention).
    payload: dict


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
        detail = f"Unknown ACTIVE_LLM_PROVIDER: {settings.active_llm_provider!r}"
        logger.error(detail)
        raise HTTPException(status_code=500, detail=detail)
    if not endpoint or not api_key:
        detail = f"LLM provider '{settings.active_llm_provider}' is not fully configured on the server"
        logger.error(detail)
        raise HTTPException(status_code=500, detail=detail)
    return endpoint, api_key


@router.post("")
async def llm_proxy(
    body: LLMProxyRequest,
    _current_user: User = Depends(get_current_user),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> StreamingResponse:
    """Byte-for-byte pass-through of the upstream response (same behavior
    as v1's server.js pump loop) -- preserves streaming SSE chunks exactly
    as the provider sent them; llmAPI.js's parsing logic doesn't change,
    only the URL it calls (docs/v2 §5.1).
    """
    endpoint, api_key = _resolve_provider()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

    http_client = httpx.AsyncClient(timeout=None, transport=transport)
    try:
        request = http_client.build_request("POST", endpoint, headers=headers, json=body.payload)
        upstream = await http_client.send(request, stream=True)
    except Exception:
        # The client only ever gets a generic 500 back (docs/v2 S8 -- never
        # leak upstream connection internals to it), but that must never
        # mean the failure itself goes unrecorded. A corporate proxy doing
        # SSL interception (SSLCertVerificationError), a DNS failure, a
        # connect timeout -- log the real exception with its full
        # traceback before returning the generic response.
        logger.exception("LLM proxy request to the upstream provider (%s) failed", endpoint)
        await http_client.aclose()
        raise HTTPException(status_code=500, detail="LLM proxy request failed")

    if upstream.status_code >= 400:
        try:
            error_body = await upstream.aread()
        finally:
            await upstream.aclose()
            await http_client.aclose()
        logger.error(
            "Upstream LLM provider (%s) returned status %s: %s",
            endpoint,
            upstream.status_code,
            error_body.decode(errors="replace"),
        )
        raise HTTPException(status_code=upstream.status_code, detail=error_body.decode(errors="replace"))

    async def _pump():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        except Exception:
            # Response headers are already sent by this point, so the
            # client can't be given a fresh status code -- the stream just
            # ends -- but the server must still record what happened
            # instead of failing silently mid-response.
            logger.exception("LLM proxy stream from upstream provider (%s) failed mid-response", endpoint)
            raise
        finally:
            await upstream.aclose()
            await http_client.aclose()

    content_type = upstream.headers.get("content-type", "application/json")
    return StreamingResponse(_pump(), media_type=content_type)
