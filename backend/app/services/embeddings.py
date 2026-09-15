"""Real calls to Mistral's embeddings endpoint (docs/v2 §3 point 1/6) --
used both when a BRDP becomes Validated (routes/brdps.py, stored on the
row) and at query time for the /similar endpoint's source-BRDP embedding
(routes/similar.py, computed on the fly, never stored). Same "backend
resolves endpoint/key from its own settings, never from the caller"
pattern as routes/llm_proxy.py's _resolve_provider(); this is a distinct
function rather than a generic "call any Mistral endpoint" helper because
the request/response shape (a single "input" list, a "data[0].embedding"
array) is specific to embeddings, not chat completions.
"""

import logging

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)


class EmbeddingUnavailable(Exception):
    """A real, deliberate failure to compute an embedding -- misconfigured
    server settings, or the upstream call itself failing. Callers must
    treat this as "we don't know the embedding right now", never
    substitute a stale or zero vector to paper over it (HR7: never
    silently degrade) -- routes/brdps.py lets this propagate as a 502 to
    the editor who just tried to validate a BRDP; routes/similar.py lets
    it propagate too, since a /similar call that can't even embed the
    BRDP it was asked about has nothing meaningful to return.
    """


def _resolve_embed_provider() -> tuple[str, str, str]:
    settings = get_settings()
    # docs/v2 §3 point 6's own documented caveat: embeddings are Mistral-
    # only right now. Calling Mistral anyway while ACTIVE_LLM_PROVIDER is
    # "qwen" would silently break the exact data-residency guarantee that
    # setting exists to enforce -- refuse loudly instead.
    if settings.active_llm_provider != "mistral":
        detail = (
            "Embeddings are only implemented for the mistral provider (docs/v2 §3 point 6); "
            f"ACTIVE_LLM_PROVIDER is {settings.active_llm_provider!r}"
        )
        logger.error(detail)
        raise EmbeddingUnavailable(detail)
    if not settings.mistral_embed_endpoint or not settings.mistral_api_key:
        detail = "Mistral embeddings endpoint/API key is not fully configured on the server"
        logger.error(detail)
        raise EmbeddingUnavailable(detail)
    return settings.mistral_embed_endpoint, settings.mistral_api_key, settings.mistral_embed_model


async def compute_embedding(text: str, transport: httpx.AsyncBaseTransport | None = None) -> list[float]:
    """`transport` is injectable (mirrors get_httpx_transport in
    api/deps.py) so callers under FastAPI can pass through the same
    dependency-overridable transport used for llm_proxy.py's tests --
    production callers leave it None, which makes httpx use the real
    network.
    """
    endpoint, api_key, model = _resolve_embed_provider()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    payload = {"model": model, "input": [text]}

    async with httpx.AsyncClient(timeout=30.0, transport=transport) as client:
        try:
            response = await client.post(endpoint, headers=headers, json=payload)
        except Exception:
            logger.exception("Embedding request to Mistral (%s) failed", endpoint)
            raise EmbeddingUnavailable("Embedding request failed") from None

        if response.status_code >= 400:
            logger.error(
                "Mistral embeddings endpoint (%s) returned status %s: %s",
                endpoint,
                response.status_code,
                response.text,
            )
            raise EmbeddingUnavailable(f"Embedding request failed with status {response.status_code}")

        body = response.json()
        try:
            return body["data"][0]["embedding"]
        except (KeyError, IndexError, TypeError):
            logger.error("Unexpected shape in Mistral embeddings response: %s", body)
            raise EmbeddingUnavailable("Unexpected embeddings response shape") from None
