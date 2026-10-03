"""GET /api/config/ai-provider -- read-only, server-resolved (docs/v2 §5).
Verified manually against a live .env during the Phase 3 close (changed
ACTIVE_LLM_PROVIDER and confirmed the response changed too); this is the
automated regression version of that same check.
"""
import uuid

import pytest

from app.core.config import get_settings
from app.core.security import create_access_token, hash_password
from app.db.base import async_session_factory
from app.models import User


@pytest.fixture
async def auth_headers():
    async with async_session_factory() as session:
        user = User(
            email=f"config-test-{uuid.uuid4()}@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Config Test",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        user_id = user.id

    yield {"Authorization": f"Bearer {create_access_token(user_id)}"}

    async with async_session_factory() as session:
        db_user = await session.get(User, user_id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def test_requires_authentication(client):
    response = await client.get("/api/config/ai-provider")
    assert response.status_code == 401


async def test_reflects_real_server_settings(client, auth_headers):
    response = await client.get("/api/config/ai-provider", headers=auth_headers)
    assert response.status_code == 200
    body = response.json()
    settings = get_settings()
    assert body["provider"] == settings.active_llm_provider
    expected_model = (
        settings.mistral_model if settings.active_llm_provider == "mistral" else settings.qwen_chat_model
    )
    assert body["model"] == expected_model
