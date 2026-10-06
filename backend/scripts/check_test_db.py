"""One-line check of the database the backend tests use, before pytest runs
(scripts/run-backend-tests.mjs, `npm run test:backend`).

The tests use the app's own settings.database_url (DATABASE_URL in the
environment or backend/.env). Prints ONE line and exits:

  0  reachable and migrated to the latest Alembic revision
  3  not reachable (server down, wrong host/port, wrong credentials)
  4  reachable but its schema is not the latest (run `alembic upgrade head`)

So a database that is not up costs one clear line instead of hundreds of
identical errors from every test. The password is never printed.

  python scripts/check_test_db.py      (from backend/)
"""

import asyncio
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import asyncpg  # noqa: E402
from alembic.config import Config  # noqa: E402
from alembic.script import ScriptDirectory  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from app.core.config import get_settings  # noqa: E402

TIMEOUT_SECONDS = 5


def _out(line: str) -> None:
    sys.stdout.buffer.write((line + "\n").encode("utf-8"))
    sys.stdout.flush()


async def _check(url) -> int:
    shown = url.render_as_string(hide_password=True)
    try:
        conn = await asyncpg.connect(
            host=url.host or "localhost",
            port=url.port or 5432,
            user=url.username,
            password=url.password,
            database=url.database,
            timeout=TIMEOUT_SECONDS,
        )
    except Exception as exc:  # noqa: BLE001 -- any reason means "not reachable"
        reason = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
        _out(f"Test database not reachable ({shown}): {reason}")
        return 3
    try:
        try:
            current = await conn.fetchval("SELECT version_num FROM alembic_version")
        except asyncpg.UndefinedTableError:
            current = None
    finally:
        await conn.close()
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    heads = ScriptDirectory.from_config(config).get_heads()
    if current not in heads:
        _out(
            f"Test database {shown} is at migration {current or '(none)'}, the code expects "
            f"{', '.join(heads)}: run `alembic upgrade head` in backend/."
        )
        return 4
    _out(f"Test database OK ({shown}, migration {current}).")
    return 0


def main() -> int:
    url = make_url(get_settings().database_url)
    return asyncio.run(_check(url))


if __name__ == "__main__":
    sys.exit(main())
