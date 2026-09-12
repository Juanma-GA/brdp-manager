from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# backend/alembic.ini -- resolved from this file's path so it works
# regardless of the process's cwd, not from a relative "alembic.ini" guess.
_ALEMBIC_INI = Path(__file__).resolve().parent.parent.parent / "alembic.ini"


def _alembic_head() -> str | None:
    """The latest revision the checked-out code defines (alembic/versions/)
    -- read straight from the migration scripts, no DB connection needed.
    """
    cfg = Config(str(_ALEMBIC_INI))
    script = ScriptDirectory.from_config(cfg)
    return script.get_current_head()


async def get_migration_status(conn: AsyncConnection) -> dict:
    """Non-blocking pending-migrations check (docs request): compares the
    DB's actually-applied revision (the alembic_version table) against the
    code's head revision. Must never raise or block startup/`/health` --
    a missing alembic_version table (a fresh, never-migrated DB) reads as
    current=None rather than an error.
    """
    head = _alembic_head()
    try:
        result = await conn.execute(text("SELECT version_num FROM alembic_version"))
        row = result.first()
        current = row[0] if row else None
    except Exception:
        current = None
    return {"current": current, "head": head, "up_to_date": current == head}
