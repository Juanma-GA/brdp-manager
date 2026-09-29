"""Read-only report of stored rules that are not a rule of their format.

Consolidation C3, Part 1d. Since C2 (Part 0), saving a rule that contains no
rule element of its format (e.g. just the text //&lt;emphasis&gt;) is refused
with 422, and the Test rule panel reports such a rule as "not executable"
(reason rule_format). Rules saved BEFORE that check, or brought in by the
Excel import (which does not apply it), may still be in the database. This
script lists them -- project, BRDP, format, rule status and the reason --
using the same check_rule_format() as the save endpoint. It changes nothing:
fixing a rule is a decision for the project's editors, in the interface.

    cd backend && .venv/bin/python scripts/report_invalid_rules.py

Exit code 0 always (it is a report, not a gate). Rules in the trash (their
BRDP soft-deleted) are listed too, marked as such.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lxml import etree
from sqlalchemy import select

from app.api.routes.approvals import _rule_format_problem
from app.db.base import async_session_factory
from app.models import BRDP, Project, RuleApproval

_STATUS_LABEL = {"approved": "Verified", "pending_review": "Draft"}


def _problem(rule_xml: str, format: str) -> str | None:
    """The reason in English, or None when the rule is a rule of its format
    (or the format is not checked)."""
    try:
        problem = _rule_format_problem(rule_xml or "", format)
    except etree.XMLSyntaxError as err:
        return f"not well-formed XML: {err}"
    return None if problem is None else problem["message"]


async def main() -> None:
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(Project.name, BRDP.identifier, BRDP.deleted_at, RuleApproval.format, RuleApproval.status, RuleApproval.rule_xml)
                .join(BRDP, BRDP.id == RuleApproval.brdp_id)
                .join(Project, Project.id == BRDP.project_id)
                .order_by(Project.name, BRDP.identifier, RuleApproval.format)
            )
        ).all()
    invalid = []
    for project, identifier, deleted_at, format, status, rule_xml in rows:
        reason = _problem(rule_xml, format)
        if reason is not None:
            trash = " (in trash)" if deleted_at is not None else ""
            invalid.append((project, f"{identifier}{trash}", format, _STATUS_LABEL.get(status, status), reason))
    print(f"Checked {len(rows)} stored rule(s); {len(invalid)} are not a rule of their format.")
    if not invalid:
        return
    print()
    print("| Project | BRDP | Format | Rule Status | Reason |")
    print("|---|---|---|---|---|")
    for project, brdp, format, status, reason in invalid:
        cells = [str(c).replace("|", "\\|").replace("\n", " ") for c in (project, brdp, format, status, reason)]
        print("| " + " | ".join(cells) + " |")


if __name__ == "__main__":
    asyncio.run(main())
