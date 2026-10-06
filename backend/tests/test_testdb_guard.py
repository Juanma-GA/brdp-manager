"""The rules that keep the backend tests off the app's database
(tests/_testdb.py, Protecciones 1b). Pure checks: no database is touched."""

import pytest

import _testdb
from _testdb import TestDatabaseRefused, check_test_url, derived_test_url, resolve_test_database, same_database
from sqlalchemy.engine import make_url

APP = "postgresql+asyncpg://brdp:brdp@localhost:5432/brdp_manager"


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Isolated settings: no DATABASE_URL/TEST_DATABASE_URL in the
    environment and a backend/.env of the test's own."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    env_file = tmp_path / ".env"
    monkeypatch.setattr(_testdb, "ENV_FILE", env_file)

    def write(text: str) -> None:
        env_file.write_text(text, encoding="utf-8")

    return monkeypatch, write


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"])
def test_loopback_names_are_the_same_host(host):
    assert same_database(make_url(f"postgresql://u@{host}/db"), make_url("postgresql://x@localhost:5432/db"))


def test_different_name_or_port_is_another_database():
    base = make_url("postgresql://u@localhost/db")
    assert not same_database(base, make_url("postgresql://u@localhost/db_test"))
    assert not same_database(base, make_url("postgresql://u@localhost:5433/db"))


def test_missing_test_url_is_refused_with_the_create_command(env):
    monkeypatch, write = env
    write(f"DATABASE_URL={APP}\n")
    with pytest.raises(TestDatabaseRefused) as exc:
        resolve_test_database()
    assert exc.value.code == "missing"
    assert "npm run test:db:create" in str(exc.value)


def test_app_database_by_another_host_name_is_refused(env):
    monkeypatch, write = env
    write(f"DATABASE_URL={APP}\n")
    with pytest.raises(TestDatabaseRefused) as exc:
        check_test_url("postgresql+asyncpg://other:pw@127.0.0.1/brdp_manager", "environment")
    assert exc.value.code == "same"
    assert "pw" not in str(exc.value)


def test_app_database_from_the_environment_counts_too(env):
    monkeypatch, write = env
    write(f"DATABASE_URL={APP}\n")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://brdp:brdp@localhost/brdp_manager_test")
    with pytest.raises(TestDatabaseRefused) as exc:
        check_test_url("postgresql+asyncpg://brdp:brdp@127.0.0.1/brdp_manager_test", "environment")
    assert exc.value.code == "same"


def test_app_default_counts_when_nothing_sets_database_url(env):
    with pytest.raises(TestDatabaseRefused) as exc:
        check_test_url("postgresql+asyncpg://brdp:brdp@127.0.0.1:5432/brdp_manager", "environment")
    assert exc.value.code == "same"


def test_name_without_test_suffix_is_refused(env):
    monkeypatch, write = env
    write(f"DATABASE_URL={APP}\n")
    with pytest.raises(TestDatabaseRefused) as exc:
        check_test_url("postgresql+asyncpg://brdp:brdp@localhost/brdp_manager_copy", "environment")
    assert exc.value.code == "suffix"


def test_test_url_from_env_file_is_accepted(env):
    monkeypatch, write = env
    write(f"DATABASE_URL={APP}\nTEST_DATABASE_URL=postgresql+asyncpg://brdp:brdp@localhost/brdp_manager_test\n")
    db = resolve_test_database()
    assert db.source == "backend/.env"
    assert db.parsed.database == "brdp_manager_test"


def test_environment_wins_over_env_file(env):
    monkeypatch, write = env
    write(f"DATABASE_URL={APP}\nTEST_DATABASE_URL=postgresql+asyncpg://brdp:brdp@localhost/a_test\n")
    monkeypatch.setenv("TEST_DATABASE_URL", "postgresql+asyncpg://brdp:brdp@localhost/b_test")
    assert resolve_test_database().parsed.database == "b_test"


def test_derived_url_adds_the_suffix_once(env):
    monkeypatch, write = env
    write(f"DATABASE_URL={APP}\n")
    assert make_url(derived_test_url()).database == "brdp_manager_test"
    write("DATABASE_URL=postgresql+asyncpg://brdp:brdp@localhost/x_test\n")
    assert make_url(derived_test_url()).database == "x_test"


def test_the_suite_itself_runs_on_the_test_database():
    from app.core.config import get_settings

    url = make_url(get_settings().database_url)
    assert url.database.endswith("_test")
