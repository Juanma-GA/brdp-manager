import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.db.base import engine
from app.main import app


@pytest_asyncio.fixture
async def client():
    """Real HTTP-shaped client against the actual FastAPI app -- no mocking
    of the DB layer. Requires a reachable Postgres at settings.database_url
    (see backend/.env.example / DATABASE_URL) with migrations applied.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture(autouse=True)
async def _dispose_engine_after_test():
    """app/db/base.py's engine/session factory is a module-level singleton
    -- correct for the real app (one event loop for its whole process
    lifetime), but pytest-asyncio gives each test function its own loop by
    default. Without disposing the pool here, the second test reuses
    pooled asyncpg connections bound to the first test's (now-closed) loop
    and blows up with "attached to a different loop". Disposing after every
    test forces fresh connections on the current loop next time.
    """
    yield
    await engine.dispose()
