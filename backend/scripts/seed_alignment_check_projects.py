"""One-off: seed 10 projects spanning a realistic range of sizes (2 to
2819 BRDPs) directly in Postgres, to verify BRDP Projects' Proposal/Rule
Status summary columns stay vertically aligned across wildly different
digit counts -- the exact scenario named in the encargo (a SOPTE-sized
row with 4-digit counts next to a 2-BRDP row with single-digit counts).
This sandbox has no access to the user's real named projects (SOPTE,
"Navantia S80 - DTM 2.0 (ditamap-XMetal)", etc.), so this synthesizes a
comparable spread with distinct, honestly-labeled names. Rerunning wipes
and recreates every project this script owns, so it's safe to reuse.

    cd backend && python scripts/seed_alignment_check_projects.py
"""
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole, BRDP, RuleApproval

# (name, total, pending, validated, refused, to_do, draft, verified)
# Deliberately includes the two extremes the encargo names: a SOPTE-sized
# project with lopsided, mostly-Validated counts and a couple of
# single-digit projects -- plus a spread in between so the alignment
# check isn't just "biggest vs smallest".
PROJECTS = [
    ("Alignment Check - SOPTE-scale", 2819, 0, 2818, 1, 719, 600, 1500),
    ("Alignment Check - Navantia S80-scale", 2, 0, 2, 0, 0, 0, 2),
    ("Alignment Check - Lufthansa-scale", 1847, 200, 1600, 47, 900, 400, 547),
    ("Alignment Check - Boeing-scale", 963, 50, 900, 13, 300, 200, 463),
    ("Alignment Check - Airbus-scale", 412, 12, 390, 10, 100, 100, 212),
    ("Alignment Check - Embraer-scale", 88, 8, 78, 2, 30, 20, 38),
    ("Alignment Check - Dassault-scale", 27, 2, 24, 1, 10, 5, 12),
    ("Alignment Check - Leonardo-scale", 15, 1, 13, 1, 5, 3, 7),
    ("Alignment Check - Saab-scale", 9, 0, 9, 0, 2, 2, 5),
    ("Alignment Check - Pilatus-scale", 3, 0, 3, 0, 1, 0, 2),
]


async def main():
    async with async_session_factory() as db:
        admin = (await db.execute(select(User).where(User.email == "admin@example.com"))).scalar_one()

        for name, total, pending, validated, refused, to_do, draft, verified in PROJECTS:
            assert pending + validated + refused == total, name
            assert to_do + draft + verified == total, name

            project = (await db.execute(select(Project).where(Project.name == name))).scalar_one_or_none()
            if project is None:
                project = Project(
                    name=name,
                    standard="S1000D 4.2",
                    project_config={
                        "modelIdentCode": "ALGN",
                        "systemDiffCode": "A",
                        "issueNumber": "001",
                        "languageIsoCode": "en",
                        "countryIsoCode": "US",
                        "securityClassification": "01",
                    },
                )
                db.add(project)
                await db.commit()
                await db.refresh(project)
                print(f"Created project {name!r} (id={project.id})")
            else:
                existing = (await db.execute(select(BRDP.id).where(BRDP.project_id == project.id))).scalars().all()
                if existing:
                    await db.execute(RuleApproval.__table__.delete().where(RuleApproval.brdp_id.in_(existing)))
                    await db.execute(BRDP.__table__.delete().where(BRDP.project_id == project.id))
                    await db.commit()
                print(f"Reusing project {name!r} (id={project.id}), wiped {len(existing)} old BRDPs")

            role = (
                await db.execute(
                    select(UserProjectRole).where(
                        UserProjectRole.user_id == admin.id, UserProjectRole.project_id == project.id
                    )
                )
            ).scalar_one_or_none()
            if role is None:
                db.add(UserProjectRole(user_id=admin.id, project_id=project.id, role="editor"))
                await db.commit()

            def proposal_status_for(i):
                if i < pending:
                    return "Pending"
                if i < pending + validated:
                    return "Validated"
                return "Refused"

            def rule_status_for(i):
                if i < verified:
                    return "verified"
                if i < verified + draft:
                    return "draft"
                return "to_do"

            slug = name.split(" - ")[1].replace("-scale", "").upper()[:6]
            brdp_rows = []
            approval_rows = []
            for i in range(total):
                bid = uuid.uuid4()
                identifier = f"BRDP-{slug}-{i:05d}"
                brdp_rows.append(
                    {
                        "id": bid,
                        "project_id": project.id,
                        "identifier": identifier,
                        "title": f"Synthetic {name} rule {i}",
                        "definition": f"Definition for {identifier}.",
                        "proposal": f"Proposal for {identifier}.",
                        "validation": proposal_status_for(i),
                    }
                )
                rstate = rule_status_for(i)
                if rstate != "to_do":
                    approval_rows.append(
                        {
                            "brdp_id": bid,
                            "format": "BREX-4.2",
                            "status": "approved" if rstate == "verified" else "pending_review",
                            "rule_xml": f'<structureObjectRule id="{identifier}"><objectPath allowedObjectFlag="1">//dmodule</objectPath></structureObjectRule>',
                            "source": "manual",
                        }
                    )

            if brdp_rows:
                await db.execute(BRDP.__table__.insert(), brdp_rows)
                await db.commit()
            if approval_rows:
                await db.execute(RuleApproval.__table__.insert(), approval_rows)
                await db.commit()
            print(f"  {total} BRDPs, {len(approval_rows)} rule_approvals")

        print("\nDone. 10 projects seeded for the alignment check.")


asyncio.run(main())
