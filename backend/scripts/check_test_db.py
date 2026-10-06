"""One-line check of the database the backend tests use, before pytest runs
(scripts/run-backend-tests.mjs, `npm run test:backend`).

The tests use TEST_DATABASE_URL (environment or backend/.env), never the
app's DATABASE_URL (tests/_testdb.py, the same rules tests/conftest.py
applies). Prints ONE line and exits:

  0  reachable and migrated to the latest Alembic revision
  3  not reachable (server down, wrong host/port, wrong credentials, or
     the database does not exist yet)
  4  reachable but its schema is not the latest
  5  TEST_DATABASE_URL is not set
  6  TEST_DATABASE_URL must not be used (name without "_test", or it is
     the app's own database)
  7  the JWT key pair is missing (keys/ is not in git: a fresh clone has
     none, and every test that logs in would fail with the same error)

Codes 3, 4 and 5 are fixed by `npm run test:db:create`.

So a database that is not up costs one clear line instead of hundreds of
identical errors from every test. The password is never printed.

  python scripts/check_test_db.py      (from backend/)
"""

import asyncio
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "tests"))

import asyncpg  # noqa: E402
from alembic.config import Config  # noqa: E402
from alembic.script import ScriptDirectory  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from _testdb import CREATE_COMMAND, TestDatabaseRefused, resolve_test_database  # noqa: E402

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
        _out(f"Test database not reachable ({shown}): {reason}. If it does not exist yet: {CREATE_COMMAND}.")
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
            f"{', '.join(heads)}: run `{CREATE_COMMAND}` to bring it up to date."
        )
        return 4
    _out(f"Test database OK ({shown}, migration {current}).")
    return 0


def _missing_jwt_keys() -> list[str]:
    from app.core.config import get_settings

    settings = get_settings()
    missing = []
    for value in (settings.jwt_private_key_path, settings.jwt_public_key_path):
        path = Path(value)
        if not path.is_absolute():
            path = BACKEND / path
        if not path.is_file():
            missing.append(value)
    return missing


def main() -> int:
    missing = _missing_jwt_keys()
    if missing:
        _out(
            f"JWT key file(s) missing: {', '.join(missing)} (relative to backend/). "
            "Create them with: python scripts/generate_rsa_keypair.py (from backend/)."
        )
        return 7
    try:
        test_db = resolve_test_database()
    except TestDatabaseRefused as exc:
        _out(str(exc))
        return 5 if exc.code == "missing" else 6
    return asyncio.run(_check(make_url(test_db.url)))


if __name__ == "__main__":
    sys.exit(main())
