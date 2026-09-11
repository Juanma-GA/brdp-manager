import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.approvals import router as approvals_router
from app.api.routes.auth import router as auth_router
from app.api.routes.brdp_catalog import router as brdp_catalog_router
from app.api.routes.brdps import router as brdps_router
from app.api.routes.config import router as config_router
from app.api.routes.llm_proxy import router as llm_proxy_router
from app.api.routes.notes import router as notes_router
from app.api.routes.projects import router as projects_router
from app.api.routes.similar import router as similar_router
from app.api.routes.suggestion_feedback import router as suggestion_feedback_router
from app.api.routes.users import router as users_router
from app.api.routes.validate_brex import router as validate_brex_router
from app.core.config import get_settings
from app.core.migrations import get_migration_status
from app.db.base import engine, get_db

logger = logging.getLogger(__name__)

app = FastAPI(title="BRDP Manager v2 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(projects_router)
app.include_router(config_router)
app.include_router(brdp_catalog_router)
app.include_router(brdps_router)
app.include_router(notes_router)
app.include_router(approvals_router)
app.include_router(similar_router)
app.include_router(suggestion_feedback_router)
app.include_router(llm_proxy_router)
app.include_router(validate_brex_router)


@app.on_event("startup")
async def warn_on_pending_migrations() -> None:
    """Non-blocking: a DB behind head must never stop the app from
    starting (docs request) -- this only logs so it's visible in the
    server's own startup output, same DB check /health exposes below.
    """
    async with engine.connect() as conn:
        migrations = await get_migration_status(conn)
    if not migrations["up_to_date"]:
        logger.warning(
            "Database is behind the latest migration: current=%s head=%s -- run `alembic upgrade head`.",
            migrations["current"],
            migrations["head"],
        )


@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict:
    await db.execute(text("SELECT 1"))
    migrations = await get_migration_status(await db.connection())
    return {"status": "ok", "migrations": migrations}
