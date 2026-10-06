"""llm_calls: one row per call to the LLM (Protecciones 2a, Part 1), and
GET /api/admin/llm-usage. The provider is mocked at the network boundary
(httpx.MockTransport), as in test_llm_proxy.py; the database is real.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import delete, select

from app.api.deps import get_httpx_transport
from app.core.security import create_access_token
from app.db.base import async_session_factory
from app.main import app
from app.models import LlmCall, User
from app.services import embeddings, llm_usage

SSE_BODY = b'{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}]}'


async def _new_user(role: str = "user") -> User:
    async with async_session_factory() as session:
        user = User(
            email=f"llm-usage-{uuid.uuid4().hex[:8]}@example.com",
            password_hash="irrelevant",
            display_name="LLM usage test",
            global_role=role,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _cleanup(user_ids):
    async with async_session_factory() as session:
        await session.execute(delete(LlmCall).where(LlmCall.user_id.in_(user_ids)))
        for uid in user_ids:
            u = await session.get(User, uid)
            if u is not None:
                await session.delete(u)
        await session.commit()


@pytest.fixture
async def user():
    u = await _new_user()
    yield u
    await _cleanup([u.id])


@pytest.fixture
async def admin():
    u = await _new_user("admin")
    yield u
    await _cleanup([u.id])


@pytest.fixture(autouse=True)
def _reset_transport_override():
    yield
    app.dependency_overrides.pop(get_httpx_transport, None)


def _headers(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _payload(text: str = "hello there"):
    return {"max_tokens": 100, "temperature": 0.3, "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": text}]}


def _mock(handler):
    app.dependency_overrides[get_httpx_transport] = lambda: httpx.MockTransport(handler)


async def _rows(user_id) -> list[LlmCall]:
    await llm_usage.wait_for_pending_writes()
    async with async_session_factory() as session:
        result = await session.execute(select(LlmCall).where(LlmCall.user_id == user_id).order_by(LlmCall.created_at))
        return list(result.scalars().all())


async def test_ok_call_leaves_one_row_without_content(client, user):
    _mock(lambda request: httpx.Response(200, content=SSE_BODY, headers={"content-type": "application/json"}))
    response = await client.post("/api/llm-proxy", json={"payload": _payload("hello there")}, headers=_headers(user))
    assert response.status_code == 200
    [row] = await _rows(user.id)
    assert (row.kind, row.result, row.upstream_status) == ("chat", "ok", 200)
    assert row.request_chars == len("sys") + len("hello there")
    assert row.duration_ms is not None and row.duration_ms >= 0
    assert row.text_count is None
    # Usage only: no column holds the text sent or received.
    assert not {"content", "messages", "answer", "payload"} & set(LlmCall.__table__.columns.keys())


async def test_upstream_error_is_recorded_with_its_status(client, user):
    _mock(lambda request: httpx.Response(503, content=b"down"))
    response = await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=_headers(user))
    assert response.status_code == 503
    [row] = await _rows(user.id)
    assert (row.result, row.upstream_status) == ("upstream_error", 503)
    assert row.duration_ms is not None


async def test_network_failure_is_recorded_as_failed(client, user):
    def handler(request):
        raise httpx.ConnectError("no route")

    _mock(handler)
    response = await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=_headers(user))
    assert response.status_code == 500
    [row] = await _rows(user.id)
    assert (row.result, row.upstream_status) == ("failed", None)
    assert row.duration_ms is not None


async def test_refused_payload_is_recorded_as_failed(client, user):
    payload = {**_payload(), "model": "other"}
    response = await client.post("/api/llm-proxy", json={"payload": payload}, headers=_headers(user))
    assert response.status_code == 422
    [row] = await _rows(user.id)
    assert (row.kind, row.result, row.upstream_status) == ("chat", "failed", None)


class _CutStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'{"choices":'
        raise httpx.ReadError("connection reset mid-stream")


async def test_stream_cut_midway_is_recorded_as_failed(client, user):
    _mock(lambda request: httpx.Response(200, stream=_CutStream(), headers={"content-type": "application/json"}))
    with pytest.raises(Exception):
        await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=_headers(user))
    [row] = await _rows(user.id)
    assert (row.result, row.upstream_status) == ("failed", 200)
    assert row.duration_ms is not None


async def test_record_failure_never_breaks_the_call(client, user, monkeypatch, caplog):
    def broken_session():
        raise RuntimeError("database unreachable")

    monkeypatch.setattr(llm_usage, "_session", broken_session)
    _mock(lambda request: httpx.Response(200, content=SSE_BODY, headers={"content-type": "application/json"}))
    with caplog.at_level(logging.ERROR):
        response = await client.post("/api/llm-proxy", json={"payload": _payload()}, headers=_headers(user))
    assert response.status_code == 200
    assert response.content == SSE_BODY
    assert any("Could not record an LLM call" in r.getMessage() for r in caplog.records)


async def test_embedding_call_leaves_a_row_with_text_count(user):
    def handler(request):
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1]}, {"index": 1, "embedding": [0.2]}]})

    vectors = await embeddings.compute_embeddings_batch(["abc", "de"], httpx.MockTransport(handler), user_id=user.id)
    assert vectors == [[0.1], [0.2]]
    [row] = await _rows(user.id)
    assert (row.kind, row.result, row.upstream_status) == ("embedding", "ok", 200)
    assert (row.request_chars, row.text_count) == (5, 2)


async def test_embedding_failure_is_recorded(user):
    def handler(request):
        return httpx.Response(500, text="boom")

    with pytest.raises(embeddings.EmbeddingUnavailable):
        await embeddings.compute_embedding("abc", httpx.MockTransport(handler), user_id=user.id)
    [row] = await _rows(user.id)
    assert (row.kind, row.result, row.upstream_status, row.text_count) == ("embedding", "upstream_error", 500, 1)


async def test_embedding_without_known_user_has_empty_user_id():
    marker = "unknown-user-" + uuid.uuid4().hex
    call_id = await llm_usage.record_call(user_id=None, kind="embedding", result="ok", request_chars=len(marker), text_count=1)
    async with async_session_factory() as session:
        row = await session.get(LlmCall, call_id)
        assert row.user_id is None and row.kind == "embedding"
        await session.delete(row)
        await session.commit()


async def test_admin_usage_by_user_day_kind_and_result(client, user, admin):
    for kind, result in [("chat", "ok"), ("chat", "ok"), ("chat", "upstream_error"), ("embedding", "ok")]:
        await llm_usage.record_call(user_id=user.id, kind=kind, result=result, request_chars=10)
    # A day outside a 1-day window, and a user that is then deleted.
    async with async_session_factory() as session:
        session.add(
            LlmCall(user_id=user.id, kind="chat", result="ok", request_chars=1, created_at=datetime.now(timezone.utc) - timedelta(days=3))
        )
        db_user = await session.get(User, user.id)
        db_user.deleted_at = datetime.now(timezone.utc)
        await session.commit()

    response = await client.get("/api/admin/llm-usage?days=1", headers=_headers(admin))
    assert response.status_code == 200
    mine = [r for r in response.json()["rows"] if r["user_id"] == str(user.id)]
    by_key = {(r["kind"], r["result"]): r for r in mine}
    assert by_key[("chat", "ok")]["calls"] == 2
    assert by_key[("chat", "ok")]["request_chars"] == 20
    assert by_key[("chat", "upstream_error")]["calls"] == 1
    assert by_key[("embedding", "ok")]["calls"] == 1
    assert all(r["user_deleted"] and r["user_email"] == user.email for r in mine)
    assert len(mine) == 3  # the call 3 days ago is outside days=1

    wide = await client.get("/api/admin/llm-usage?days=7", headers=_headers(admin))
    assert sum(r["calls"] for r in wide.json()["rows"] if r["user_id"] == str(user.id)) == 5


async def test_rows_survive_a_user_deleted_for_good(user):
    await llm_usage.record_call(user_id=user.id, kind="chat", result="ok")
    async with async_session_factory() as session:
        await session.delete(await session.get(User, user.id))
        await session.commit()
    assert len(await _rows(user.id)) == 1


async def test_admin_usage_is_for_admins_only(client, user):
    assert (await client.get("/api/admin/llm-usage", headers=_headers(user))).status_code == 403
    assert (await client.get("/api/admin/llm-usage")).status_code == 401
    assert (await client.get("/api/admin/llm-usage?days=0", headers=_headers(user))).status_code in (403, 422)
