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
    "BRDP-LINT-MUSTNOT": _sor("//emphasis", "2", "Emphasis must not be used."),
    "BRDP-LINT-NUMBER": _sor("count(//emphasis)", "0"),
    "BRDP-LINT-BADBOOL": _sor("//emphasis and (//para", "0"),
    "BRDP-LINT-DOCUMENT": _sor("//dmRef[not(document('x.xml'))]", "0"),
    "BRDP-LINT-FLAG1": _sor("//@assyCode[matches(., '^\\d{2}$')]", "1", rule_id="R-FLAG1"),
    "BRDP-LINT-DEPTH": _sor("//proceduralStep[count(ancestor::*) &gt; 8]", "0"),
    "BRDP-LINT-FORMAT": "//&lt;emphasis&gt;",
    # Mejoras A, Part 3: two objectPath in one structureObjectRule.
    "BRDP-LINT-TWOPATHS": (
        '<structureObjectRule id="R-TWO"><objectPath allowedObjectFlag="0">//a</objectPath><objectUse>u</objectUse>'
        '<objectPath allowedObjectFlag="0">//b</objectPath><objectUse>v</objectUse></structureObjectRule>'
    ),
    # Barrido final 2/2: the same problem in three places of one rule is
    # ONE finding; the same allowed value twice is a finding of its own.
    "BRDP-LINT-THRICE": "".join(
        _sor(f"//@{name}[matches(., '^\\d{{2}}$')]", "1", rule_id=f"R-THRICE-{name}")
        for name in ("assyCode", "subSystemCode", "subSubSystemCode")
    ),
    "BRDP-LINT-DUPLICATE": _sor(
        "//@emphasisType",
        "2",
        extra='<objectValue valueForm="single" valueAllowed="em01"/>'
        '<objectValue valueForm="single" valueAllowed="em02"/>'
        '<objectValue valueForm="single" valueAllowed="em01"/>',
        rule_id="R-DUP",
    ),
    # Known, not counted (Plantillas, Part 4): an informative rule -- flag 2
    # without values that does not say "must not" (a node path or a
    # condition), as in the default S1000D BREX.
    "BRDP-LINT-INFO": _sor("//acronym", "2", "Acronyms are allowed."),
    "BRDP-LINT-INFO-BOOLEAN": _sor("//acronym or //abbreviation", "2", "Acronyms and abbreviations may be used."),
    # Correct rules: never listed. A boolean path is a condition the engine
    # evaluates like s1kd-brexcheck (Plantillas, Part 4).
    "BRDP-LINT-OK-BOOLEAN": _sor("//emphasis and //para", "0"),
    "BRDP-LINT-OK": _sor("//emphasis", "0", "Emphasis must not be used."),
    "BRDP-LINT-OK-DEPTH": _sor("//proceduralStep[count(ancestor-or-self::proceduralStep) &gt; 5]", "0"),
    "BRDP-LINT-OK-FLAG1": _sor("//dmodule[.//dmCode]", "1"),
    # A boolean condition with a value predicate inside it: flag 1 only
    # requires the condition to hold, never "flag 1 with a value predicate"
    # (real case: Official Default CMP ATA 4.2, EXT-00029).
    "BRDP-LINT-OK-FLAG1-CONDITION": _sor(
        "(/ddn or /dml or //dmStatus/applic/assert/@applicPropertyType or "
        "//dmStatus/applic/displayText/simplePara[normalize-space(.) != ''])",
        "1",
    ),
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
        "BRDP-LINT-MUSTNOT": '"must not" but allowed',
        "BRDP-LINT-NUMBER": "not a node path",
        "BRDP-LINT-BADBOOL": "not executable",
        "BRDP-LINT-DOCUMENT": "not executable",
        "BRDP-LINT-FLAG1": "flag 1 with a value predicate",
        "BRDP-LINT-DEPTH": "count(ancestor::*) as depth",
        "BRDP-LINT-FORMAT": "not a rule of the format",
        "BRDP-LINT-TWOPATHS": "more than one objectPath in a rule",
        "BRDP-LINT-THRICE": "flag 1 with a value predicate",
        "BRDP-LINT-DUPLICATE": "duplicate allowed value",
    }
    for identifier, kind in expected.items():
        assert any(f"| {kind} |" in line for line in _rows(out, identifier)), (identifier, out)
    # A flag 2 rule that says "must not" still cannot reject: a finding.
    assert any("| cannot reject |" in line for line in _rows(out, "BRDP-LINT-MUSTNOT")), out
    # A number says so; a boolean that does not parse keeps its XPath error;
    # the flag-1 row names the rule and the fix.
    assert any("does not select nodes" in line and "a number" in line for line in _rows(out, "BRDP-LINT-NUMBER")), out
    assert any("XPath error" in line for line in _rows(out, "BRDP-LINT-BADBOOL")), out
    assert any("R-FLAG1" in line and "never rejected" in line for line in _rows(out, "BRDP-LINT-FLAG1")), out
    # Once per rule: one row for the three places, every place named.
    thrice = _rows(out, "BRDP-LINT-THRICE")
    assert len(thrice) == 1, out
    assert "(3 places)" in thrice[0] and all(f"R-THRICE-{n}" in thrice[0] for n in ("assyCode", "subSystemCode", "subSubSystemCode")), out
    dup = _rows(out, "BRDP-LINT-DUPLICATE")
    assert len(dup) == 1 and "R-DUP" in dup[0] and "em01 (2 times)" in dup[0] and "em02" not in dup[0], out
    # document() is known and accepted: listed apart, not counted.
    known = out.split("### Known and accepted (not counted)")[1]
    assert "BRDP-LINT-DOCUMENT" in known
    assert "reads another file (document())" in known
    # Informative rules: known, not counted -- node path and condition.
    counted = out.split("### Known and accepted (not counted)")[0]
    for identifier in ("BRDP-LINT-INFO", "BRDP-LINT-INFO-BOOLEAN"):
        assert any("| informative rule (flag 2) |" in line and "never rejects" in line for line in _rows(known, identifier)), (identifier, out)
        assert _rows(counted, identifier) == [], (identifier, out)
    for identifier in (
        "BRDP-LINT-OK",
        "BRDP-LINT-OK-DEPTH",
        "BRDP-LINT-OK-FLAG1",
        "BRDP-LINT-OK-FLAG1-CONDITION",
        "BRDP-LINT-OK-VALUES",
        "BRDP-LINT-OK-BOOLEAN",
    ):
        assert _rows(out, identifier) == [], (identifier, out)
    # 8 counted findings: one per seeded rule, plus "cannot reject" next to
    # "must not" but allowed, and "not executable" next to "not a rule of the
    # format" (document() and the informative rules are known, not counted).
    assert any("can only have one <objectPath>; this one has 2" in line for line in _rows(out, "BRDP-LINT-TWOPATHS")), out
    # The two-path rule also counts "not executable" (its test refuses it),
    # like the rule that is not of the format.
    assert "Checked 18 stored rule(s) in 1 project(s); 12 finding(s), each problem counted once per rule." in out
    assert "- Working projects: 18 rule(s) in 1 project(s); 12 finding(s) (14 place(s))." in out
    assert "- Reference projects (Official Default…): 0 rule(s) in 0 project(s); 0 finding(s)." in out


async def test_project_filter_by_name_and_unknown_project(seeded_project):
    assert f"### {seeded_project.name}" in _run(seeded_project.name)
    assert "Checked 0 stored rule(s) in 0 project(s); 0 finding(s)" in _run(f"no such project {uuid.uuid4()}")


async def test_reference_projects_are_totalled_apart():
    """An "Official Default …" project is a reference: its findings have
    their own total and section, never mixed with the working projects'."""
    suffix = uuid.uuid4().hex[:8]
    names = {True: f"Official Default Lint {suffix}", False: f"Lint Working {suffix}"}
    async with async_session_factory() as session:
        projects = {}
        for reference, name in names.items():
            project = Project(name=name, standard="S1000D 4.2")
            session.add(project)
            await session.flush()
            projects[reference] = project
            for n in range(2 if reference else 1):
                brdp = BRDP(project_id=project.id, identifier=f"BRDP-LINT-{n}", title="t", definition="d", proposal="p", validation="Validated")
                session.add(brdp)
                await session.flush()
                xml = _sor("//emphasis", "2", "Emphasis must not be used.")
                session.add(RuleApproval(brdp_id=brdp.id, format="BREX-4.2", rule_xml=xml, source="manual", status="approved"))
        await session.commit()
    try:
        out = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True,
            cwd=SCRIPT.parent.parent,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            check=True,
        ).stdout.decode("utf-8")
        working, reference = out.split("## Reference projects")
        assert f"### {names[False]}" in working.split("## Working projects")[1] and names[True] not in working
        assert f"### {names[True]}" in reference
        # Totals: each rule here has two findings ("cannot reject" and
        # "must not but allowed"); the database may hold other projects.
        head = out.split("\n")[1:3]
        assert head[0].startswith("- Working projects:") and head[1].startswith("- Reference projects (Official Default…):")
    finally:
        async with async_session_factory() as session:
            for project in projects.values():
                db_project = await session.get(Project, project.id)
                await session.delete(db_project)
            await session.commit()
