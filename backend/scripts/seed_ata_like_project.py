"""Fills an existing (empty) project with the reconstructed "ATA CMP issue
009" rules (tests/fixtures/brex/ATA-CMP-like-009-project-rules.json): 461
BRDPs with their Verified rules, as an Excel import leaves them (no
"extracted_from" history). For scripts/verify-rule-extract-content-match.mjs;
the project itself is created and deleted by that script through the API.

    cd backend && python scripts/seed_ata_like_project.py <project id>
"""
import asyncio
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.db.base import async_session_factory  # noqa: E402
from app.models import BRDP, Project, RuleApproval  # noqa: E402
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT  # noqa: E402

RULES = ROOT / "tests" / "fixtures" / "brex" / "ATA-CMP-like-009-project-rules.json"


async def main(project_id: str) -> None:
    rows = json.loads(RULES.read_text(encoding="utf-8"))
    async with async_session_factory() as db:
        project = await db.get(Project, uuid.UUID(project_id))
        if project is None:
            raise SystemExit(f"No project {project_id}")
        fmt = STANDARD_TO_RULE_FORMAT[project.standard]
        for r in rows:
            b = BRDP(project_id=project.id, identifier=r["identifier"], title=r["title"], definition="", proposal="", validation="Validated")
            db.add(b)
            await db.flush()
            db.add(RuleApproval(brdp_id=b.id, format=fmt, rule_xml=r["rule_xml"], status="approved", source="manual"))
        await db.commit()
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({"seeded": len(rows)}))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
