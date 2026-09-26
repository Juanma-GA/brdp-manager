"""app/services/embeddings.py in isolation -- the plain functions, not
through any FastAPI route, since none of it has a dependency on the
request lifecycle at all.
"""
import json

import httpx
import pytest

from app.core.config import get_settings
from app.services import embeddings as embeddings_module
from app.services.embeddings import (
    EMBED_MAX_CHARS_PER_INPUT,
    EmbeddingUnavailable,
    compute_embedding,
    compute_embeddings_batch,
    truncate_for_embedding_input,
)


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


# ---- Batch embeddings (docs request) --------------------------------------


async def test_compute_embeddings_batch_sends_the_full_list_in_one_request():
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        sent = json.loads(request.content)
        data = [{"embedding": [float(i)], "index": i} for i in range(len(sent["input"]))]
        return httpx.Response(200, json={"data": data})

    texts = [f"text-{i}" for i in range(5)]
    result = await compute_embeddings_batch(texts, transport=httpx.MockTransport(handler))

    assert len(captured) == 1, "all 5 texts must go out in ONE request, not 5"
    sent_body = json.loads(captured[0].content)
    assert sent_body["input"] == texts
    assert result == [[0.0], [1.0], [2.0], [3.0], [4.0]]


async def test_compute_embeddings_batch_reorders_by_index_never_assumes_response_order():
    """Docs request, explicit requirement: match up by each response
    item's own "index" field, never assume it comes back in request
    order -- this mock deliberately returns the reverse order.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        data = [{"embedding": [float(i)], "index": i} for i in range(len(sent["input"]))]
        data.reverse()
        return httpx.Response(200, json={"data": data})

    texts = ["a", "b", "c"]
    result = await compute_embeddings_batch(texts, transport=httpx.MockTransport(handler))
    assert result == [[0.0], [1.0], [2.0]]


async def test_compute_embeddings_batch_empty_list_makes_no_request():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not be called for an empty batch")

    result = await compute_embeddings_batch([], transport=httpx.MockTransport(handler))
    assert result == []


async def test_compute_embeddings_batch_missing_index_raises_embedding_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        # Only 1 item returned for 2 requested -- index 1 is missing.
        return httpx.Response(200, json={"data": [{"embedding": [0.0], "index": 0}]})

    with pytest.raises(EmbeddingUnavailable):
        await compute_embeddings_batch(["a", "b"], transport=httpx.MockTransport(handler))


async def test_compute_embeddings_batch_malformed_item_raises_embedding_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"unexpected": "shape"}]})

    with pytest.raises(EmbeddingUnavailable):
        await compute_embeddings_batch(["a"], transport=httpx.MockTransport(handler))


async def test_single_and_batch_calls_return_identical_vector_for_the_same_text():
    """The docs request's own closing verification method: recomputing one
    text alone via compute_embedding must match what a batch call assigned
    that same text -- both go through the exact same deterministic mock.
    """

    def deterministic_handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        texts = sent["input"]
        data = [
            {"embedding": [float(len(t)), float(sum(map(ord, t)) % 97)], "index": i} for i, t in enumerate(texts)
        ]
        return httpx.Response(200, json={"data": data})

    texts = ["alpha text", "beta text", "gamma text"]
    batch_result = await compute_embeddings_batch(texts, transport=httpx.MockTransport(deterministic_handler))
    single_result = await compute_embedding("beta text", transport=httpx.MockTransport(deterministic_handler))

    assert single_result == batch_result[1]


# ---- Explicit truncation for oversized input text (docs request, HR7) -----


def test_truncate_for_embedding_input_leaves_short_text_untouched():
    text = "A normal, short BRDP definition."
    result, was_truncated = truncate_for_embedding_input(text)
    assert result == text
    assert was_truncated is False


def test_truncate_for_embedding_input_cuts_oversized_text_with_explicit_marker():
    text = "x" * (EMBED_MAX_CHARS_PER_INPUT + 5000)
    result, was_truncated = truncate_for_embedding_input(text)
    assert was_truncated is True
    assert len(result) <= EMBED_MAX_CHARS_PER_INPUT
    assert "truncated" in result.lower()
    assert result.startswith("x")


def test_truncate_for_embedding_input_empty_text_is_not_truncated():
    result, was_truncated = truncate_for_embedding_input("")
    assert result == ""
    assert was_truncated is False


# ---- 429 rate-limit handling (docs request) --------------------------------
#
# Patches embeddings.py's OWN `asyncio` module reference (not the real,
# global asyncio module) with a stand-in that only fakes `sleep` -- so
# these tests run instantly without actually waiting, and without risking
# any effect on pytest-asyncio's own real use of asyncio elsewhere.


class _FakeAsyncio:
    def __init__(self):
        self.waited: list[float] = []

    async def sleep(self, seconds: float) -> None:
        self.waited.append(seconds)


async def test_429_respects_retry_after_header_seconds(monkeypatch):
    fake_asyncio = _FakeAsyncio()
    monkeypatch.setattr(embeddings_module, "asyncio", fake_asyncio)

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "2"}, json={"error": "rate limited"})
        return httpx.Response(200, json={"data": [{"embedding": [0.1, 0.2], "index": 0}]})

    result = await compute_embedding("text", transport=httpx.MockTransport(handler))
    assert result == [0.1, 0.2]
    assert len(calls) == 2, "must retry after the 429, not fail the call"
    assert fake_asyncio.waited == [2.0]


async def test_429_without_retry_after_header_uses_a_default_wait(monkeypatch):
    fake_asyncio = _FakeAsyncio()
    monkeypatch.setattr(embeddings_module, "asyncio", fake_asyncio)

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(200, json={"data": [{"embedding": [0.5], "index": 0}]})

    result = await compute_embedding("text", transport=httpx.MockTransport(handler))
    assert result == [0.5]
    assert len(calls) == 2
    assert fake_asyncio.waited == [embeddings_module._DEFAULT_429_WAIT_SECONDS]


async def test_429_exhausting_all_retries_raises_embedding_unavailable_not_a_hang(monkeypatch):
    fake_asyncio = _FakeAsyncio()
    monkeypatch.setattr(embeddings_module, "asyncio", fake_asyncio)

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(429, json={"error": "rate limited"})

    with pytest.raises(EmbeddingUnavailable):
        await compute_embedding("text", transport=httpx.MockTransport(handler))
    assert len(calls) == embeddings_module._MAX_429_RETRIES + 1


def test_parse_retry_after_numeric_seconds():
    assert embeddings_module._parse_retry_after("5") == 5.0


def test_parse_retry_after_missing_or_invalid_returns_none():
    assert embeddings_module._parse_retry_after(None) is None
    assert embeddings_module._parse_retry_after("") is None
    assert embeddings_module._parse_retry_after("not-a-date-or-number") is None


def test_parse_retry_after_http_date():
    from datetime import datetime, timedelta, timezone
    from email.utils import format_datetime

    target = datetime.now(timezone.utc) + timedelta(seconds=30)
    value = embeddings_module._parse_retry_after(format_datetime(target, usegmt=True))
    assert value is not None
    assert 25 <= value <= 30
