import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.deps import get_current_user, get_httpx_transport
from app.core.config import get_settings
from app.models import User

router = APIRouter(prefix="/api/llm-proxy", tags=["llm-proxy"])


class LLMProxyRequest(BaseModel):
    # Only the already-built, provider-shaped request body -- unlike v1's
    # /api/proxy, `targetEndpoint` and `apiKey` are never accepted from the
    # client. The server resolves both from its own ACTIVE_LLM_PROVIDER
    # config (docs/v2 §4.2 -- closes S2/SSRF and S3/plaintext-key-on-client
    # by construction, not by convention).
    payload: dict


def _resolve_provider() -> tuple[str, str]:
    settings = get_settings()
    if settings.active_llm_provider == "mistral":
        endpoint, api_key = settings.mistral_endpoint, settings.mistral_api_key
    elif settings.active_llm_provider == "qwen":
        endpoint, api_key = settings.qwen_endpoint, settings.qwen_api_key
    else:
        raise HTTPException(
            status_code=500, detail=f"Unknown ACTIVE_LLM_PROVIDER: {settings.active_llm_provider!r}"
        )
    if not endpoint or not api_key:
        raise HTTPException(
            status_code=500,
            detail=f"LLM provider '{settings.active_llm_provider}' is not fully configured on the server",
        )
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
    request = http_client.build_request("POST", endpoint, headers=headers, json=body.payload)
    upstream = await http_client.send(request, stream=True)

    if upstream.status_code >= 400:
        error_body = await upstream.aread()
        await upstream.aclose()
        await http_client.aclose()
        raise HTTPException(status_code=upstream.status_code, detail=error_body.decode(errors="replace"))

    async def _pump():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await http_client.aclose()

    content_type = upstream.headers.get("content-type", "application/json")
    return StreamingResponse(_pump(), media_type=content_type)
