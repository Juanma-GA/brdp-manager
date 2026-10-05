"""POST /api/llm-proxy. No real Mistral/Qwen API key exists in this
environment, so the network boundary is mocked via httpx.MockTransport
(app.dependency_overrides[get_httpx_transport]) -- the same "mock only the
external network call" pattern used throughout this project's frontend
tests. Everything else (auth requirement, provider/endpoint/key resolution
from server settings, streaming pass-through, error propagation) runs for
real against the actual app.
"""
import json
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


def _payload():
    """A payload as the app sends it (src/api/llmAPI.js)."""
    return {"max_tokens": 100, "temperature": 0.3, "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]}


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

    response = await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=auth_headers)
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
    # The model is the server's (.env), added to what the client sent.
    sent_body = json.loads(sent.content)
    assert sent_body["model"] == settings.mistral_model
    assert sent_body["messages"] == _payload()["messages"]


async def test_client_supplied_endpoint_and_key_are_refused(client, auth_headers):
    """The whole point of docs/v2 §4.2's S2/SSRF fix: the server resolves
    the endpoint and key from its own settings, never from the request.
    Since AACF 1 (Part 5) a client that sends them (v1's shape) is refused
    outright, and nothing reaches the provider.
    """
    captured_requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(200, content=b"ok", headers={"content-type": "text/plain"})

    _install_mock_transport(handler)

    response = await client.post(
        "/api/llm-proxy",
        json={
            "payload": _payload(),
            "targetEndpoint": "http://169.254.169.254/latest/meta-data/",
            "apiKey": "attacker-supplied-key",
        },
        headers=auth_headers,
    )
    assert response.status_code == 422
    assert {e["loc"][-1] for e in response.json()["detail"]} == {"targetEndpoint", "apiKey"}
    assert captured_requests == []


@pytest.mark.parametrize(
    "payload, code",
    [
        ({**_payload(), "model": "some-other-model"}, "llm_params_not_allowed"),
        ({**_payload(), "top_p": 0.9}, "llm_params_not_allowed"),
        ({**_payload(), "stream": True}, "llm_params_not_allowed"),
        ({"temperature": 0.3}, "llm_messages_invalid"),
        ({"messages": [{"role": "tool", "content": "x"}]}, "llm_messages_invalid"),
        ({**_payload(), "temperature": "hot"}, "llm_temperature_invalid"),
        ({**_payload(), "max_tokens": 0}, "llm_max_tokens_invalid"),
    ],
)
async def test_parameters_outside_the_list_are_refused(client, auth_headers, payload, code):
    """AACF 1, Part 5: a closed list of parameters (the ones the app sends);
    the model is the server's. Anything else is refused with a code -- never
    dropped or adjusted silently -- and nothing reaches the provider."""
    calls = []
    _install_mock_transport(lambda request: calls.append(request) or httpx.Response(200, content=b"{}"))
    response = await client.post("/api/llm-proxy", json={"payload": payload}, headers=auth_headers)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == code
    assert calls == []


async def test_max_tokens_over_the_setting_is_refused_not_lowered(client, auth_headers):
    limit = get_settings().llm_max_tokens
    calls = []
    _install_mock_transport(lambda request: calls.append(request) or httpx.Response(200, content=b"{}"))
    response = await client.post(
        "/api/llm-proxy", json={"payload": {**_payload(), "max_tokens": limit + 1}}, headers=auth_headers
    )
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "llm_max_tokens_too_high", "max": limit, "requested": limit + 1}
    assert calls == []
    # The limit itself goes through, exactly as sent.
    response = await client.post("/api/llm-proxy", json={"payload": {**_payload(), "max_tokens": limit}}, headers=auth_headers)
    assert response.status_code == 200
    assert json.loads(calls[0].content)["max_tokens"] == limit


async def test_upstream_error_status_is_propagated_not_streamed(client, auth_headers, caplog):
    """The provider's status is kept; its body goes to the log under a
    reference, never to the browser (Decisión 12)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, content=b'{"error":"rate limited"}')

    _install_mock_transport(handler)

    with caplog.at_level(logging.ERROR):
        response = await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=auth_headers)
    assert response.status_code == 429
    detail = response.json()["detail"]
    assert detail["code"] == "llm_upstream_error" and detail["upstream_status"] == 429
    assert "rate limited" not in response.text
    assert any(f"ref={detail['ref']}" in r.getMessage() and "rate limited" in r.getMessage() for r in caplog.records)


async def test_upstream_401_never_reaches_the_browser_as_401(client, auth_headers):
    """A 401/403 from the provider is about the server's API key; passed
    through, the browser would take it for its own expired session."""
    _install_mock_transport(lambda request: httpx.Response(401, content=b'{"error":"bad key"}'))
    response = await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=auth_headers)
    assert response.status_code == 502
    assert response.json()["detail"]["upstream_status"] == 401


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
        response = await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=auth_headers)

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert detail["code"] == "llm_request_failed" and detail["ref"]
    assert "SSL" not in response.text and "ConnectError" not in response.text

    matching = [
        r for r in caplog.records if r.levelno >= logging.ERROR and "upstream provider" in r.message
    ]
    assert len(matching) == 1, f"expected exactly one matching error log record, got: {caplog.records}"
    record = matching[0]
    assert f"ref={detail['ref']}" in record.message
    assert record.exc_info is not None, "the log record must carry a real traceback, not just a message"
    formatted = "".join(traceback.format_exception(*record.exc_info))
    assert "simulated SSL certificate verification failure" in formatted
    assert "ConnectError" in formatted
