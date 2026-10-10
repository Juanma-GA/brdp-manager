"""Creates (or brings up to date) the database the backend tests use --
`npm run test:db:create` (scripts/create-test-db.mjs) runs this.

  python scripts/create_test_db.py      (from backend/)

1. Which database: TEST_DATABASE_URL (environment or backend/.env). When it
   is not set, the app's DATABASE_URL with "_test" added to the database
   name (brdp_manager -> brdp_manager_test, same server and role), and the
   line TEST_DATABASE_URL=... is added to backend/.env so `npm run
   test:backend` finds it.
2. Refuses, like the tests themselves (tests/_testdb.py), a name that does
   not end in "_test" or the app's own database.
3. Creates the database on that server if it does not exist (connecting to
   the server's "postgres" maintenance database with the same role).
4. Enables pgvector in it (CREATE EXTENSION IF NOT EXISTS vector).
5. Applies the migrations (`alembic upgrade head` with DATABASE_URL set to
   the test database). An existing database is just brought up to date.

When the role may not create a database or the extension, it says so and
prints the SQL an administrator must run (also as `docker exec` for the
usual brdp-postgres container). Nothing is changed in the app's database.

Exit code: 0 done; 1 refused or failed; 2 the role lacks a privilege (the
message has the SQL); 3 the server is not reachable.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "tests"))

import asyncpg  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from _testdb import (  # noqa: E402
    ENV_FILE,
    TestDatabaseRefused,
    check_test_url,
    configured_test_url,
    derived_test_url,
)

TIMEOUT_SECONDS = 10
MAINTENANCE_DATABASES = ("postgres", "template1")
DOCKER_CONTAINER = "brdp-postgres"


def _out(line: str = "") -> None:
    sys.stdout.buffer.write((line + "\n").encode("utf-8"))
    sys.stdout.flush()


def _quote_ident(name: str) -> str:
    """The identifier as SQL: bare when it is a plain lower-case name (so the
    printed commands need no nested quotes in PowerShell), quoted otherwise."""
    if name and (name[0].isalpha() or name[0] == "_") and all(c.islower() or c.isdigit() or c == "_" for c in name):
        return name
    return '"' + name.replace('"', '""') + '"'


def _first_line(exc: BaseException) -> str:
    text = str(exc).strip()
    return text.splitlines()[0] if text else type(exc).__name__


def _admin_help(database: str, role: str | None, with_create: bool) -> None:
    sql = []
    if with_create:
        sql.append(f"CREATE DATABASE {_quote_ident(database)}" + (f" OWNER {_quote_ident(role)};" if role else ";"))
    _out("An administrator (a superuser, e.g. postgres) must run, once:")
    _out()
    for line in sql:
        _out(f"    {line}")
    _out(f"    -- connected to {database}:")
    _out("    CREATE EXTENSION IF NOT EXISTS vector;")
    _out()
    _out(f"With Postgres in Docker ({DOCKER_CONTAINER}), from PowerShell or a Linux shell:")
    _out()
    if with_create:
        _out(f'    docker exec {DOCKER_CONTAINER} psql -U postgres -c "{sql[0]}"')
    _out(f'    docker exec {DOCKER_CONTAINER} psql -U postgres -d {database} -c "CREATE EXTENSION IF NOT EXISTS vector;"')
    _out()
    _out("(In the official image the superuser is POSTGRES_USER; use it instead of postgres if that is what")
    _out("the container was created with.) Then run `npm run test:db:create` again.")


def _choose_url() -> tuple[str, str]:
    configured = configured_test_url()
    if configured is not None:
        return configured
    return derived_test_url(), "derived"


def _remember_in_env_file(url: str) -> None:
    line = f"TEST_DATABASE_URL={url}"
    existing = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    sep = "" if not existing or existing.endswith("\n") else "\n"
    ENV_FILE.write_text(
        existing + sep + "# Database of the backend tests (npm run test:backend); never the app's DATABASE_URL.\n" + line + "\n",
        encoding="utf-8",
    )


async def _connect(url, database: str):
    return await asyncpg.connect(
        host=url.host or "localhost",
        port=url.port or 5432,
        user=url.username,
        password=url.password,
        database=database,
        timeout=TIMEOUT_SECONDS,
    )


async def _ensure_database(url) -> int:
    """0 exists or created, 2 not allowed to create it, 3 server unreachable."""
    last_error = None
    for maintenance in MAINTENANCE_DATABASES:
        try:
            conn = await _connect(url, maintenance)
        except (OSError, asyncio.TimeoutError) as exc:
            _out(f"Cannot reach the Postgres server {url.host or 'localhost'}:{url.port or 5432}: {_first_line(exc)}")
            _out("Start Postgres (Linux: service postgresql start; Windows/Docker: docker start brdp-postgres).")
            return 3
        except asyncpg.PostgresError as exc:
            last_error = exc
            continue
        try:
            exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", url.database)
            if exists:
                _out(f"Database {url.database} already exists: bringing it up to date.")
                return 0
            try:
                await conn.execute(f"CREATE DATABASE {_quote_ident(url.database)}")
            except asyncpg.InsufficientPrivilegeError as exc:
                _out(f"The role {url.username} may not create databases ({_first_line(exc)}).")
                _admin_help(url.database, url.username, with_create=True)
                return 2
            _out(f"Database {url.database} created.")
            return 0
        finally:
            await conn.close()
    _out(f"Cannot connect to the server's maintenance database as {url.username}: {_first_line(last_error)}")
    return 3


async def _ensure_vector(url) -> int:
    try:
        conn = await _connect(url, url.database)
    except Exception as exc:  # noqa: BLE001
        _out(f"Cannot connect to {url.database}: {_first_line(exc)}")
        return 3
    try:
        if await conn.fetchval("SELECT 1 FROM pg_extension WHERE extname = 'vector'"):
            _out("pgvector already enabled.")
            return 0
        try:
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        except asyncpg.InsufficientPrivilegeError as exc:
            _out(f"The role {url.username} may not enable pgvector in {url.database} ({_first_line(exc)}).")
            _admin_help(url.database, url.username, with_create=False)
            return 2
        except asyncpg.PostgresError as exc:
            _out(f"pgvector could not be enabled in {url.database}: {_first_line(exc)}")
            _out("Install pgvector on the Postgres server (the brdp-postgres image pgvector/pgvector has it).")
            return 1
        _out("pgvector enabled.")
        return 0
    finally:
        await conn.close()


async def _revision(url) -> str | None:
    conn = await _connect(url, url.database)
    try:
        try:
            return await conn.fetchval("SELECT version_num FROM alembic_version")
        except asyncpg.UndefinedTableError:
            return None
    finally:
        await conn.close()


def _upgrade(test_url: str) -> int:
    env = {**os.environ, "DATABASE_URL": test_url, "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND,
        env=env,
        capture_output=True,
    )
    if result.returncode != 0:
        _out("alembic upgrade head failed:")
        for line in (result.stdout + result.stderr).decode("utf-8", "replace").strip().splitlines()[-15:]:
            _out(f"    {line}")
        return 1
    return 0


async def _main() -> int:
    url_text, source = _choose_url()
    try:
        test_db = check_test_url(url_text, "derived from DATABASE_URL" if source == "derived" else source)
    except TestDatabaseRefused as exc:
        _out(f"Not created: {exc}")
        return 1
    url = make_url(test_db.url)
    _out(f"Test database: {test_db.shown}")

    code = await _ensure_database(url)
    if code:
        return code
    code = await _ensure_vector(url)
    if code:
        return code
    before = await _revision(url)
    if _upgrade(test_db.url):
        return 1
    after = await _revision(url)
    if before == after:
        _out(f"Migrations: already at {after}.")
    else:
        _out(f"Migrations: {before or '(none)'} -> {after}.")

    if source == "derived":
        _remember_in_env_file(test_db.url)
        _out(f"Added TEST_DATABASE_URL to {ENV_FILE.relative_to(BACKEND.parent)} (password included, as DATABASE_URL is).")
    _out("Test database ready: npm run test:backend")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
