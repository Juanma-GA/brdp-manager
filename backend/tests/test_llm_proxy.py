"""POST /api/llm-proxy. No real Mistral/Qwen API key exists in this
environment, so the network boundary is mocked via httpx.MockTransport
(app.dependency_overrides[get_httpx_transport]) -- the same "mock only the
external network call" pattern used throughout this project's frontend
tests. Everything else (auth requirement, provider/endpoint/key resolution
from server settings, streaming pass-through, error propagation) runs for
real against the actual app.
"""
import logging
import traceback

import httpx
import pytest

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token
from app.core.config import get_settings
from app.db.base import async_session_factory
from app.main import app
from app.models import User


@pytest.fixture
async def auth_headers():
    async with async_session_factory() as session:
        user = User(
            email="llm-proxy-test@example.com",
            password_hash="irrelevant",
            display_name="LLM Proxy Test",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        user_id = user.id

    token = create_access_token(user_id)
    yield {"Authorization": f"Bearer {token}"}

    async with async_session_factory() as session:
        db_user = await session.get(User, user_id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


@pytest.fixture(autouse=True)
def _reset_transport_override():
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


def _install_mock_transport(handler):
    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)


async def test_requires_authentication(client):
    response = await client.post("/api/llm-proxy", json={"payload": {"model": "x"}})
    assert response.status_code == 401


async def test_streams_upstream_chunks_byte_for_byte(client, auth_headers):
    sse_body = (
        b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
        b'data: {"type":"message_stop"}\n\n'
    )

    captured_requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(200, content=sse_body, headers={"content-type": "text/event-stream"})

    _install_mock_transport(handler)

    response = await client.post(
        "/api/llm-proxy", json={"payload": {"model": "mistral-small", "messages": []}}, headers=auth_headers
    )
    assert response.status_code == 200
    assert response.content == sse_body
    # FastAPI/Starlette appends "; charset=utf-8" to text-like media types
    # automatically -- the meaningful assertion is that it forwarded the
    # upstream's real content-type, not something it made up.
    assert response.headers["content-type"].startswith("text/event-stream")

    assert len(captured_requests) == 1
    sent = captured_requests[0]
    settings = get_settings()
    assert str(sent.url) == settings.mistral_endpoint
    assert sent.headers["authorization"] == f"Bearer {settings.mistral_api_key}"


async def test_client_supplied_endpoint_and_key_are_ignored(client, auth_headers):
    """The whole point of docs/v2 §4.2's S2/SSRF fix: even if a client sends
    targetEndpoint/apiKey (v1's shape), the server resolves both from its
    own settings -- never from the request body.
    """
    captured_requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(200, content=b"ok", headers={"content-type": "text/plain"})

    _install_mock_transport(handler)

    response = await client.post(
        "/api/llm-proxy",
        json={
            "payload": {"model": "x"},
            "targetEndpoint": "http://169.254.169.254/latest/meta-data/",
            "apiKey": "attacker-supplied-key",
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    sent = captured_requests[0]
    settings = get_settings()
    assert str(sent.url) == settings.mistral_endpoint
    assert "169.254.169.254" not in str(sent.url)
    assert sent.headers["authorization"] == f"Bearer {settings.mistral_api_key}"


async def test_upstream_error_status_is_propagated_not_streamed(client, auth_headers):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, content=b'{"error":"rate limited"}')

    _install_mock_transport(handler)

    response = await client.post(
        "/api/llm-proxy", json={"payload": {"model": "x"}}, headers=auth_headers
    )
    assert response.status_code == 429
    assert "rate limited" in response.text


async def test_upstream_connection_failure_is_logged_with_real_traceback(client, auth_headers, caplog):
    """A user reported dozens of real 500s from this endpoint with NO
    traceback ever appearing in the server console -- FastAPI's default
    HTTPException handler just serializes {"detail": ...} to the client
    and never logs anything server-side, for any status code, so a real
    failure (their suspicion: a corporate SSL-inspecting proxy causing an
    SSLCertVerificationError when calling out to Mistral) was going
    completely unrecorded. This simulates exactly that shape of failure
    (a transport-level exception raised while sending the request, before
    any response comes back) and confirms the server now logs the real
    exception with a full traceback, while the client still only ever
    sees the same generic message (docs/v2 S8 -- never leak upstream
    connection internals to the client).
    """

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated SSL certificate verification failure")

    _install_mock_transport(handler)

    with caplog.at_level(logging.ERROR):
        response = await client.post(
            "/api/llm-proxy", json={"payload": {"model": "x"}}, headers=auth_headers
        )

    assert response.status_code == 500
    assert response.json()["detail"] == "LLM proxy request failed"

    matching = [
        r for r in caplog.records if r.levelno >= logging.ERROR and "upstream provider" in r.message
    ]
    assert len(matching) == 1, f"expected exactly one matching error log record, got: {caplog.records}"
    record = matching[0]
    assert record.exc_info is not None, "the log record must carry a real traceback, not just a message"
    formatted = "".join(traceback.format_exception(*record.exc_info))
    assert "simulated SSL certificate verification failure" in formatted
    assert "ConnectError" in formatted
