"""Which database the backend tests may use -- and the refusal when it is
the wrong one (Protecciones 1b).

The tests create and delete projects, users, catalog rows and rules. On a
developer's machine the app's DATABASE_URL is the WORKING database (real
projects, the loaded catalogs), so the tests never use it: they use
TEST_DATABASE_URL, from the environment or backend/.env, and only when

  - it is set,
  - its database name ends in "_test", and
  - it is not the app's database (DATABASE_URL in the environment, in
    backend/.env, or the app's default when neither sets it). Host names
    that reach the same server count as the same host: localhost,
    127.0.0.1, ::1 and any name that resolves to one of the same addresses.

Used by tests/conftest.py (before anything imports the app, so even a
hand-run `pytest` is protected), by scripts/check_test_db.py
(`npm run test:backend`) and by scripts/create_test_db.py
(`npm run test:db:create`). No app code depends on it.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values
from sqlalchemy.engine import URL, make_url

BACKEND = Path(__file__).resolve().parents[1]
ENV_FILE = BACKEND / ".env"
TEST_SUFFIX = "_test"
DEFAULT_PORT = 5432
# The app's own default (app/core/config.py, Settings.database_url) when
# neither the environment nor backend/.env sets DATABASE_URL.
APP_DEFAULT_DATABASE_URL = "postgresql+asyncpg://brdp:brdp@localhost:5432/brdp_manager"
CREATE_COMMAND = "npm run test:db:create"
_LOOPBACK = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "::", ""}


class TestDatabaseRefused(Exception):
    """The test database is missing or must not be used. `code` says why:
    "missing" (TEST_DATABASE_URL not set), "invalid" (not a database URL),
    "suffix" (name does not end in _test), "same" (it is the app's)."""

    __test__ = False  # not a test class, despite the name

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TestDatabase:
    __test__ = False

    url: str
    parsed: URL
    source: str  # "environment" | "backend/.env" | "derived"

    @property
    def shown(self) -> str:
        return self.parsed.render_as_string(hide_password=True)


def _env_file_values() -> dict[str, str]:
    if not ENV_FILE.exists():
        return {}
    return {k: v for k, v in dotenv_values(ENV_FILE).items() if v is not None}


def app_database_urls() -> list[str]:
    """Every URL the app could be using: the environment's DATABASE_URL,
    backend/.env's, and the app's default when neither sets one."""
    urls = []
    if os.environ.get("DATABASE_URL"):
        urls.append(os.environ["DATABASE_URL"])
    file_url = _env_file_values().get("DATABASE_URL")
    if file_url:
        urls.append(file_url)
    if not urls:
        urls.append(APP_DEFAULT_DATABASE_URL)
    return urls


def _addresses(host: str | None) -> set[str]:
    name = (host or "").strip().lower().strip("[]")
    if name in _LOOPBACK:
        return {"loopback"}
    found = {name}
    try:
        for info in socket.getaddrinfo(name, None):
            addr = info[4][0]
            found.add("loopback" if addr in _LOOPBACK or addr.startswith("127.") else addr)
    except (OSError, UnicodeError):
        pass
    return found


def same_database(a: URL, b: URL) -> bool:
    """Same server (host by address, port) and same database name. The user
    does not matter: another role on the same database is the same data."""
    if (a.database or "") != (b.database or ""):
        return False
    if (a.port or DEFAULT_PORT) != (b.port or DEFAULT_PORT):
        return False
    return bool(_addresses(a.host) & _addresses(b.host))


def configured_test_url() -> tuple[str, str] | None:
    """(url, source) of TEST_DATABASE_URL, or None when it is not set."""
    if os.environ.get("TEST_DATABASE_URL"):
        return os.environ["TEST_DATABASE_URL"], "environment"
    value = _env_file_values().get("TEST_DATABASE_URL")
    if value:
        return value, "backend/.env"
    return None


def check_test_url(url: str, source: str) -> TestDatabase:
    """The test database for `url`, or TestDatabaseRefused with one line."""
    try:
        parsed = make_url(url)
    except Exception as exc:  # noqa: BLE001 -- any parse error is "not a URL"
        raise TestDatabaseRefused("invalid", f"TEST_DATABASE_URL ({source}) is not a database URL: {exc}") from exc
    if not parsed.database:
        raise TestDatabaseRefused("invalid", f"TEST_DATABASE_URL ({source}) names no database.")
    shown = parsed.render_as_string(hide_password=True)
    for app_url in app_database_urls():
        try:
            app_parsed = make_url(app_url)
        except Exception:  # noqa: BLE001 -- an unparsable app URL cannot match
            continue
        if same_database(parsed, app_parsed):
            raise TestDatabaseRefused(
                "same",
                f"TEST_DATABASE_URL ({source}) is the app's own database "
                f"({app_parsed.render_as_string(hide_password=True)}): the tests would create and delete data in it.",
            )
    if not parsed.database.endswith(TEST_SUFFIX):
        raise TestDatabaseRefused(
            "suffix",
            f"TEST_DATABASE_URL ({source}) points to database '{parsed.database}', whose name does not end in "
            f"'{TEST_SUFFIX}': the tests only run on a database meant for them ({shown}).",
        )
    return TestDatabase(url=url, parsed=parsed, source=source)


def resolve_test_database() -> TestDatabase:
    """TEST_DATABASE_URL, checked. Raises TestDatabaseRefused (one line,
    with the command to create it when it is missing)."""
    configured = configured_test_url()
    if configured is None:
        raise TestDatabaseRefused(
            "missing",
            "TEST_DATABASE_URL is not set (environment or backend/.env), so the backend tests do not run: "
            f"create the test database with `{CREATE_COMMAND}`.",
        )
    return check_test_url(*configured)


def derived_test_url() -> str:
    """The default test URL: the app's DATABASE_URL with "_test" added to
    the database name (brdp_manager -> brdp_manager_test)."""
    app = make_url(app_database_urls()[0])
    name = app.database or "brdp_manager"
    if not name.endswith(TEST_SUFFIX):
        name += TEST_SUFFIX
    return app.set(database=name).render_as_string(hide_password=False)
