"""scripts/lint_stored_rules.py: one seeded rule of each pattern is listed, a
correct rule is not.

The checks themselves live in JS (scripts/lib/ruleLint.mjs); this test runs
the real script as a subprocess -- Python reads the database, Node lints --
the same way a user runs it, so Node must be on the PATH (or $NODE).
"""
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from app.db.base import async_session_factory
from app.models import BRDP, Project, RuleApproval

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "lint_stored_rules.py"


def _sor(path: str, flag: str, use: str = "x", extra: str = "", rule_id: str | None = None) -> str:
    id_attr = f' id="{rule_id}"' if rule_id else ""
    return (
        f"<structureObjectRule{id_attr}><objectPath allowedObjectFlag=\"{flag}\">{path}</objectPath>"
        f"<objectUse>{use}</objectUse>{extra}</structureObjectRule>"
    )


RULES = {
    # One of each finding.
    "BRDP-LINT-CANNOT": _sor("//acronym", "2", "Acronyms are allowed."),
    "BRDP-LINT-MUSTNOT": _sor("//emphasis", "2", "Emphasis must not be used."),
    "BRDP-LINT-BOOLEAN": _sor("//emphasis and //para", "0"),
    "BRDP-LINT-DOCUMENT": _sor("//dmRef[not(document('x.xml'))]", "0"),
    "BRDP-LINT-FLAG1": _sor("//@assyCode[matches(., '^\\d{2}$')]", "1", rule_id="R-FLAG1"),
    "BRDP-LINT-DEPTH": _sor("//proceduralStep[count(ancestor::*) &gt; 8]", "0"),
    "BRDP-LINT-FORMAT": "//&lt;emphasis&gt;",
    # Correct rules: never listed.
    "BRDP-LINT-OK": _sor("//emphasis", "0", "Emphasis must not be used."),
    "BRDP-LINT-OK-DEPTH": _sor("//proceduralStep[count(ancestor-or-self::proceduralStep) &gt; 5]", "0"),
    "BRDP-LINT-OK-FLAG1": _sor("//dmodule[.//dmCode]", "1"),
    "BRDP-LINT-OK-VALUES": _sor(
        "//@assyCode[matches(., '^\\d{2}$')]",
        "1",
        extra='<objectValue valueForm="pattern" valueAllowed="\\d{2}">two digits</objectValue>',
    ),
}


@pytest.fixture
async def seeded_project():
    async with async_session_factory() as session:
        project = Project(name=f"Lint Test Project {uuid.uuid4()}", standard="S1000D 4.2")
        session.add(project)
        await session.flush()
        for identifier, xml in RULES.items():
            brdp = BRDP(project_id=project.id, identifier=identifier, title="t", definition="d", proposal="p", validation="Validated")
            session.add(brdp)
            await session.flush()
            session.add(RuleApproval(brdp_id=brdp.id, format="BREX-4.2", rule_xml=xml, source="manual", status="approved"))
        await session.commit()
        await session.refresh(project)
    yield project
    async with async_session_factory() as session:
        db_project = await session.get(Project, project.id)
        if db_project is not None:
            await session.delete(db_project)
            await session.commit()


def _run(project_id) -> str:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--project", str(project_id)],
        capture_output=True,
        cwd=SCRIPT.parent.parent,
        env=env,
        check=True,
    )
    return result.stdout.decode("utf-8")


def _rows(output: str, identifier: str) -> list[str]:
    return [line for line in output.splitlines() if line.startswith(f"| {identifier} |") or f"| {identifier} |" in line]


async def test_each_pattern_is_listed_and_correct_rules_are_not(seeded_project):
    out = _run(seeded_project.id)
    assert f"### {seeded_project.name} — S1000D 4.2" in out
    expected = {
        "BRDP-LINT-CANNOT": "cannot reject",
        "BRDP-LINT-MUSTNOT": '"must not" but allowed',
        "BRDP-LINT-BOOLEAN": "not a node path",
        "BRDP-LINT-DOCUMENT": "not executable",
        "BRDP-LINT-FLAG1": "flag 1 with a value predicate",
        "BRDP-LINT-DEPTH": "count(ancestor::*) as depth",
        "BRDP-LINT-FORMAT": "not a rule of the format",
    }
    for identifier, kind in expected.items():
        assert any(f"| {kind} |" in line for line in _rows(out, identifier)), (identifier, out)
    # The boolean path says so; the flag-1 row names the rule and the fix.
    assert any("does not select nodes" in line for line in _rows(out, "BRDP-LINT-BOOLEAN")), out
    assert any("R-FLAG1" in line and "never rejected" in line for line in _rows(out, "BRDP-LINT-FLAG1")), out
    # document() is known and accepted: listed apart, not counted.
    known = out.split("### Known, not testable here (not counted)")[1]
    assert "BRDP-LINT-DOCUMENT" in known
    assert "reads another file (document())" in known
    for identifier in ("BRDP-LINT-OK", "BRDP-LINT-OK-DEPTH", "BRDP-LINT-OK-FLAG1", "BRDP-LINT-OK-VALUES"):
        assert _rows(out, identifier) == [], (identifier, out)
    # 8 counted findings: one per seeded rule, plus "cannot reject" next to
    # "must not" but allowed, and "not executable" next to "not a rule of the
    # format" (document() is the known one, not counted).
    assert "Checked 11 stored rule(s) in 1 project(s); 8 finding(s)." in out


async def test_project_filter_by_name_and_unknown_project(seeded_project):
    assert f"### {seeded_project.name}" in _run(seeded_project.name)
    assert "Checked 0 stored rule(s) in 0 project(s); 0 finding(s)." in _run(f"no such project {uuid.uuid4()}")
