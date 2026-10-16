"""backend/.env.example lists exactly what backend/app/core/config.py reads.

A setting added to Settings without a line in .env.example (or a line left
behind after a setting is removed) fails here, so the example an operator
copies is never out of date. Each uncommented example value must also be
the setting's default: the file promises "a variable left out takes the
value shown here".

A variable may be listed commented out ("# NAME=value", at the start of a
line) when setting it would do harm by default (SOURCES_DIR). TEST_DATABASE_URL
is the one variable listed that config.py does not read: the test tooling
reads it (tests/_testdb.py).
"""
import re
from pathlib import Path

import pytest
from dotenv import dotenv_values

from app.core.config import Settings

EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"
READ_ELSEWHERE = {"TEST_DATABASE_URL"}  # tests/_testdb.py
LINE = re.compile(r"^(#\s)?([A-Z][A-Z0-9_]*)=", re.M)


def _example_names() -> dict[str, bool]:
    """name -> True if the line is active, False if commented out."""
    names: dict[str, bool] = {}
    for match in LINE.finditer(EXAMPLE.read_text(encoding="utf-8")):
        names[match.group(2)] = match.group(1) is None
    return names


def _setting_names() -> set[str]:
    return {name.upper() for name in Settings.model_fields}


def test_every_setting_is_in_the_example():
    missing = sorted(_setting_names() - set(_example_names()))
    assert not missing, f"config.py reads these but backend/.env.example does not list them: {missing}"


def test_the_example_lists_nothing_config_does_not_read():
    extra = sorted(set(_example_names()) - _setting_names() - READ_ELSEWHERE)
    assert not extra, f"backend/.env.example lists variables config.py does not read: {extra}"


def test_example_values_are_the_defaults(monkeypatch):
    for name in _setting_names() | READ_ELSEWHERE:
        monkeypatch.delenv(name, raising=False)
    defaults = Settings(_env_file=None).model_dump()
    from_example = Settings(_env_file=str(EXAMPLE)).model_dump()
    active = {name for name, on in _example_names().items() if on}
    values = dotenv_values(EXAMPLE)
    wrong = []
    for name in sorted(active - READ_ELSEWHERE):
        if values.get(name) in ("", None):
            # An empty value stands for "no value" (secrets, optional).
            assert defaults[name.lower()] in (None, ""), f"{name} is empty in the example but has a default"
            continue
        if from_example[name.lower()] != defaults[name.lower()]:
            wrong.append(f"{name}: example {from_example[name.lower()]!r}, default {defaults[name.lower()]!r}")
    assert not wrong, "backend/.env.example values that are not the defaults: " + "; ".join(wrong)


def test_no_leftovers():
    text = EXAMPLE.read_text(encoding="utf-8")
    for gone in ("REQUESTS_CA_BUNDLE", "pip install -e"):
        assert gone not in text
