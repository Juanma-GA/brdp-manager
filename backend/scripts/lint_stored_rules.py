"""Read-only lint of the rules stored in the database, grouped by project.

The same checks scripts/lint-curated-templates.mjs applies to the curated
Excel templates -- cannot reject, "must not" but allowed, a path that is not a
node path (a boolean expression), not executable / partially executable, not
a rule of its format -- plus two patterns found in real Lufthansa rules:

  - allowedObjectFlag="1" (3.0.1: objappl="1") on a path whose last step
    filters by the node's own value (//@assyCode[matches(., ...)]) and no
    objectValue/objval: the rule only requires ONE node with a good value to
    exist, so a node with a bad value is never rejected;
  - count(ancestor::*) used as a depth: it counts every ancestor (the document
    root, content, ...), not how deep the element is nested.

The checks live in JS, on the rule-test engine the "Test rule" panel uses
(scripts/lib/ruleLint.mjs). This script reads the rules and hands them to
scripts/lint-rules-stdin.mjs rather than duplicating the checks in Python.
Node: $NODE if set, else "node" on the PATH.

    cd backend && .venv/bin/python scripts/lint_stored_rules.py [--project NAME_OR_ID]

It changes nothing: fixing a rule is a decision for the project's editors.
Reasons that are known and accepted (another file: doc-available(), doc(),
document(); a value replaced outside the app, @@...@@; a nonContextRule) are
listed apart and not counted. Rules in the trash are listed too, marked as
such. Exit code 0 always (a report, not a gate).
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import or_, select

from app.db.base import async_session_factory
from app.models import BRDP, Project, RuleApproval

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_LINT = REPO_ROOT / "scripts" / "lint-rules-stdin.mjs"
_STATUS_LABEL = {"approved": "Verified", "pending_review": "Draft"}


def lint_with_node(items: list[dict]) -> dict:
    """items: [{key, format, rule_xml}] -> {key: [finding, ...]}."""
    if not items:
        return {}
    node = os.environ.get("NODE", "node")
    try:
        result = subprocess.run(
            [node, str(NODE_LINT)],
            input=json.dumps(items).encode("utf-8"),
            capture_output=True,
            cwd=REPO_ROOT,
            check=False,
        )
    except FileNotFoundError:
        raise SystemExit(f"ERROR: Node not found ({node}); set NODE to the node executable.")
    if result.returncode != 0:
        raise SystemExit(f"ERROR: {NODE_LINT.name} failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    return json.loads(result.stdout.decode("utf-8"))


def _cell(value) -> str:
    return " ".join(str(value).replace("|", "\\|").split())


async def load_rules(project: str | None) -> list[tuple]:
    query = (
        select(Project.name, Project.standard, BRDP.identifier, BRDP.deleted_at, RuleApproval.format, RuleApproval.status, RuleApproval.rule_xml)
        .join(BRDP, BRDP.id == RuleApproval.brdp_id)
        .join(Project, Project.id == BRDP.project_id)
        .order_by(Project.name, BRDP.identifier, RuleApproval.format)
    )
    if project:
        try:
            query = query.where(or_(Project.name == project, Project.id == uuid.UUID(project)))
        except ValueError:
            query = query.where(Project.name == project)
    async with async_session_factory() as session:
        return (await session.execute(query)).all()


def render(rows: list[tuple], findings: dict) -> str:
    by_project: dict[tuple, list[str]] = {}
    known: list[str] = []
    total = 0
    clean_projects: set[str] = set()
    for i, (project, standard, identifier, deleted_at, format, status, _rule_xml) in enumerate(rows):
        brdp = f"{identifier} (in trash)" if deleted_at is not None else identifier
        status_label = _STATUS_LABEL.get(status, status)
        lines = by_project.setdefault((project, standard), [])
        for f in findings.get(str(i), []):
            if f.get("known"):
                known.append(f"| {_cell(project)} | {_cell(brdp)} | {_cell(format)} | {_cell(f['kind'])} | {_cell(f['detail'])} |")
            else:
                lines.append(f"| {_cell(brdp)} | {_cell(format)} | {_cell(status_label)} | {_cell(f['kind'])} | {_cell(f['detail'])} |")
                total += 1
    out = [f"Checked {len(rows)} stored rule(s) in {len(by_project)} project(s); {total} finding(s)."]
    for (project, standard), lines in by_project.items():
        if not lines:
            clean_projects.add(project)
            continue
        out += ["", f"### {project} — {standard}", "", "| BRDP | Format | Rule Status | Finding | Detail |", "|---|---|---|---|---|", *lines]
    if clean_projects:
        out += ["", "Projects with no findings: " + ", ".join(sorted(clean_projects)) + "."]
    out += ["", "### Known, not testable here (not counted)", ""]
    if known:
        out += ["| Project | BRDP | Format | Finding | Detail |", "|---|---|---|---|---|", *known]
    else:
        out.append("None.")
    return "\n".join(out)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", help="only this project (name or id)")
    args = parser.parse_args()
    rows = await load_rules(args.project)
    findings = lint_with_node([{"key": str(i), "format": row[4], "rule_xml": row[6] or ""} for i, row in enumerate(rows)])
    print(render(rows, findings))


if __name__ == "__main__":
    # UTF-8 whatever the console code page (rule text and project names can
    # be any character; on Windows stdout is cp1252 by default).
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
