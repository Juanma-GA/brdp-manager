"""The backend's scripts and tests on Windows (Protecciones 1c).

- A script that prints writes UTF-8 whatever the console: on Windows a
  Python whose output is a pipe or a file uses the console's code page
  (cp1252) and an accent, "→" or a rule's text would come out wrong or stop
  the script with UnicodeEncodeError. Every script that prints reconfigures
  stdout/stderr to UTF-8 (or writes UTF-8 bytes itself).
- No file is opened as text without encoding=: on Windows the default is
  cp1252, not UTF-8.
"""
import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
SCRIPTS = sorted((BACKEND / "scripts").glob("*.py"))
RECONFIGURE = 'for _stream in (sys.stdout, sys.stderr):  # UTF-8 on any console or pipe, Windows included (Protecciones 1c)\n    _stream.reconfigure(encoding="utf-8", errors="backslashreplace")\n'


def _prints(source: str) -> bool:
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id == "print":
                return True
            if isinstance(f, ast.Attribute) and f.attr == "write" and isinstance(f.value, ast.Attribute) and f.value.attr in ("stdout", "stderr"):
                return True
    return False


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_a_script_that_prints_writes_utf8(script):
    source = script.read_text(encoding="utf-8")
    if not _prints(source):
        pytest.skip("prints nothing")
    handled = 'reconfigure(encoding="utf-8"' in source or "sys.stdout.buffer.write" in source
    assert handled, f"{script.name} prints but does not reconfigure stdout to UTF-8 (see Protecciones 1c)"


def test_the_reconfigure_lines_never_fail_on_a_cp1252_console():
    code = "import sys\n" + RECONFIGURE + 'print("→ áéíóú ✓ — BRDP-S1-00012 «cita»")\n'
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        env={**os.environ, "PYTHONIOENCODING": "cp1252"},
        check=False,
    )
    assert out.returncode == 0, out.stderr.decode("utf-8", "replace")
    assert out.stdout.decode("utf-8").strip() == "→ áéíóú ✓ — BRDP-S1-00012 «cita»"


def _text_io_without_encoding(path: Path) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
        if name not in ("open", "read_text", "write_text"):
            continue
        keywords = {k.arg for k in node.keywords}
        modes = [a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str) and set(a.value) <= set("rwabxt+")]
        modes += [k.value.value for k in node.keywords if k.arg == "mode" and isinstance(k.value, ast.Constant)]
        if any("b" in m for m in modes):
            continue
        if "encoding" not in keywords:
            found.append(f"{path.relative_to(BACKEND)}:{node.lineno} {name}()")
    return found


def test_no_text_file_is_opened_without_an_encoding():
    files = [p for d in ("app", "scripts", "tests", "alembic") for p in (BACKEND / d).rglob("*.py")]
    found = [hit for p in files for hit in _text_io_without_encoding(p)]
    assert found == [], "open as text without encoding= (cp1252 on Windows): " + ", ".join(found)
