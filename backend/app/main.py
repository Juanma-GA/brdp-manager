from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.auth import router as auth_router
from app.db.base import get_db

# Routers for /api/projects, /api/projects/{id}/brdps, etc. are added in
# Phase 3 (see docs/v2/03-especificacion-v2-para-claude-code.md §4.2).
app = FastAPI(title="BRDP Manager v2 API")
app.include_router(auth_router)


@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict:
    await db.execute(text("SELECT 1"))
    return {"status": "ok"}
