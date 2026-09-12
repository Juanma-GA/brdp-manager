"""app/services/embeddings.py in isolation -- the plain function, not
through any FastAPI route, since it has no dependency on the request
lifecycle at all.
"""
import httpx
import pytest

from app.core.config import get_settings
from app.services.embeddings import EmbeddingUnavailable, compute_embedding


async def test_compute_embedding_parses_real_shaped_response():
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "id": "embd-123",
                "object": "list",
                "data": [{"object": "embedding", "embedding": [0.1, 0.2, 0.3], "index": 0}],
                "model": "mistral-embed",
                "usage": {"prompt_tokens": 5, "total_tokens": 5},
            },
        )

    result = await compute_embedding("some BRDP text", transport=httpx.MockTransport(handler))
    assert result == [0.1, 0.2, 0.3]

    assert len(captured) == 1
    sent = captured[0]
    settings = get_settings()
    assert str(sent.url) == settings.mistral_embed_endpoint
    assert sent.headers["authorization"] == f"Bearer {settings.mistral_api_key}"
    import json

    sent_body = json.loads(sent.content)
    assert sent_body["model"] == settings.mistral_embed_model
    assert sent_body["input"] == ["some BRDP text"]


async def test_upstream_error_status_raises_embedding_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid api key"})

    with pytest.raises(EmbeddingUnavailable):
        await compute_embedding("text", transport=httpx.MockTransport(handler))


async def test_transport_level_failure_raises_embedding_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated failure")

    with pytest.raises(EmbeddingUnavailable):
        await compute_embedding("text", transport=httpx.MockTransport(handler))


async def test_malformed_response_shape_raises_embedding_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    with pytest.raises(EmbeddingUnavailable):
        await compute_embedding("text", transport=httpx.MockTransport(handler))
