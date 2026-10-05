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
document(); a value replaced outside the app, @@...@@; a nonContextRule), and
informative rules (BREX flag 2 without values whose objectUse does not say
"must not" -- they document what is allowed, s1kd-brexcheck never rejects
them), are listed apart and not counted.

Each problem is counted once per rule, not once per place (a rule with the
same problem in three of its structureObjectRules is one finding; the detail
says "(3 places)"). Reference projects -- names starting with "Official
Default", or --reference-prefix -- are listed and totalled apart from the
working projects. Since Barrido final 2/2 there is one more check: the same
value twice in a rule's list of allowed values. A boolean objectPath is a condition
evaluated like s1kd-brexcheck, not a finding. Rules in the trash are listed too, marked as
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


# Projects whose rules are a reference (the "Official Default …" projects
# hold the default BREX of a standard, not a project's own decisions): their
# findings are counted apart from the working projects'. A name prefix,
# overridable with --reference-prefix (repeatable).
DEFAULT_REFERENCE_PREFIXES = ("Official Default",)


def is_reference(project: str, prefixes) -> bool:
    return any(project.startswith(prefix) for prefix in prefixes)


def _detail(f: dict) -> str:
    places = f.get("occurrences", 1)
    return f"{f['detail']} ({places} places)" if places > 1 else f["detail"]


def render(rows: list[tuple], findings: dict, reference_prefixes=DEFAULT_REFERENCE_PREFIXES) -> str:
    """Each problem is counted once per rule (Barrido final 2/2): a rule with
    the same problem in several places is one finding, the detail says how
    many places. Reference projects and working projects have their own
    totals."""
    by_project: dict[tuple, list[str]] = {}
    known: list[str] = []
    totals = {True: {"rules": 0, "findings": 0, "occurrences": 0, "projects": set()},
              False: {"rules": 0, "findings": 0, "occurrences": 0, "projects": set()}}
    for i, (project, standard, identifier, deleted_at, format, status, _rule_xml) in enumerate(rows):
        brdp = f"{identifier} (in trash)" if deleted_at is not None else identifier
        status_label = _STATUS_LABEL.get(status, status)
        reference = is_reference(project, reference_prefixes)
        bucket = totals[reference]
        bucket["rules"] += 1
        bucket["projects"].add(project)
        lines = by_project.setdefault((project, standard), [])
        for f in findings.get(str(i), []):
            if f.get("known"):
                known.append(f"| {_cell(project)} | {_cell(brdp)} | {_cell(format)} | {_cell(f['kind'])} | {_cell(_detail(f))} |")
            else:
                lines.append(f"| {_cell(brdp)} | {_cell(format)} | {_cell(status_label)} | {_cell(f['kind'])} | {_cell(_detail(f))} |")
                bucket["findings"] += 1
                bucket["occurrences"] += f.get("occurrences", 1)

    def summary(label: str, b: dict) -> str:
        extra = f" ({b['occurrences']} place(s))" if b["occurrences"] != b["findings"] else ""
        return f"{label}: {b['rules']} rule(s) in {len(b['projects'])} project(s); {b['findings']} finding(s){extra}."

    total_findings = totals[True]["findings"] + totals[False]["findings"]
    out = [
        f"Checked {len(rows)} stored rule(s) in {len(by_project)} project(s); {total_findings} finding(s), each problem counted once per rule.",
        "- " + summary("Working projects", totals[False]),
        "- " + summary(f"Reference projects ({', '.join(p + '…' for p in reference_prefixes)})", totals[True]),
    ]

    def section(title: str, reference: bool) -> list[str]:
        part: list[str] = []
        clean: list[str] = []
        for (project, standard), lines in by_project.items():
            if is_reference(project, reference_prefixes) != reference:
                continue
            if not lines:
                clean.append(project)
                continue
            part += ["", f"### {project} — {standard}", "", "| BRDP | Format | Rule Status | Finding | Detail |", "|---|---|---|---|---|", *lines]
        if not part and not clean:
            return []
        head = ["", f"## {title}"]
        if clean:
            part += ["", "Projects with no findings: " + ", ".join(sorted(clean)) + "."]
        return head + part

    out += section("Working projects", False)
    out += section("Reference projects", True)
    out += ["", "### Known and accepted (not counted)", ""]
    if known:
        out += ["| Project | BRDP | Format | Finding | Detail |", "|---|---|---|---|---|", *known]
    else:
        out.append("None.")
    return "\n".join(out)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", help="only this project (name or id)")
    parser.add_argument(
        "--reference-prefix",
        action="append",
        help='a project whose name starts with this is a reference project (default: "Official Default"); repeatable',
    )
    args = parser.parse_args()
    rows = await load_rules(args.project)
    findings = lint_with_node([{"key": str(i), "format": row[4], "rule_xml": row[6] or ""} for i, row in enumerate(rows)])
    print(render(rows, findings, tuple(args.reference_prefix or DEFAULT_REFERENCE_PREFIXES)))


if __name__ == "__main__":
    # UTF-8 whatever the console code page (rule text and project names can
    # be any character; on Windows stdout is cp1252 by default).
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
