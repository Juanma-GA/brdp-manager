from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db

# Routers for /api/auth, /api/projects, /api/projects/{id}/brdps, etc. are
# added in later phases (see docs/v2/03-especificacion-v2-para-claude-code.md
# §4.2) — this app currently only proves the DB wiring (Phase 1).
app = FastAPI(title="BRDP Manager v2 API")


@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict:
    await db.execute(text("SELECT 1"))
    return {"status": "ok"}
