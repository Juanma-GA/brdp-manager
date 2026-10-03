"""One-off: synthesize a SOPTE-scale project (~2819 BRDPs) directly in Postgres
to verify the status-counts/filter feature (GET /api/projects's
proposal_status_counts/rule_status_counts, GET /brdps/stats,
proposal_status/rule_status query filters) at real scale, since this sandbox
has no actual SOPTE/Lufthansa dataset. Mirrors real-world skew (most rows
Validated, a known exact slice Verified) so the filter's exact-count claim is
checkable against a precomputed ground truth, not just "looks about right".
Rerunning wipes and recreates the project's BRDPs, so it's safe to reuse
in a future round without accumulating duplicates.

    cd backend && python scripts/seed_sopte_scale_verification.py
"""
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import Project, User, UserProjectRole, BRDP, RuleApproval

PROJECT_NAME = "SOPTE Scale Verification"
TOTAL = 2819
# Known, exact ground truth distribution (checkable against the UI/API
# results, not approximate):
#   Proposal Status: 1200 Pending, 1400 Validated, 219 Refused
#   Rule Status (format BREX-4.2, this project's standard S1000D 4.2):
#     1500 verified (approved), 600 draft (pending_review), 719 to_do (none)
N_VERIFIED = 1500
N_DRAFT = 600
N_TODO = TOTAL - N_VERIFIED - N_DRAFT
N_PENDING = 1200
N_VALIDATED = 1400
N_REFUSED = TOTAL - N_PENDING - N_VALIDATED


async def main():
    async with async_session_factory() as db:
        project = (
            await db.execute(select(Project).where(Project.name == PROJECT_NAME))
        ).scalar_one_or_none()
        if project is None:
            project = Project(
                name=PROJECT_NAME,
                standard="S1000D 4.2",
                project_config={
                    "modelIdentCode": "SOPT",
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
            print(f"Created project {PROJECT_NAME!r} (id={project.id})")
        else:
            print(f"Project {PROJECT_NAME!r} already exists (id={project.id}) -- wiping its BRDPs first")
            existing = (await db.execute(select(BRDP.id).where(BRDP.project_id == project.id))).scalars().all()
            if existing:
                await db.execute(RuleApproval.__table__.delete().where(RuleApproval.brdp_id.in_(existing)))
                await db.execute(BRDP.__table__.delete().where(BRDP.project_id == project.id))
                await db.commit()
                print(f"  wiped {len(existing)} existing BRDPs")

        admin = (await db.execute(select(User).where(User.email == "admin@example.com"))).scalar_one()
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

        # Proposal status assignment, in fixed contiguous blocks by index so
        # the ground truth is trivially reconstructible: [0,1200) Pending,
        # [1200,2600) Validated, [2600,2819) Refused.
        def proposal_status_for(i):
            if i < N_PENDING:
                return "Pending"
            if i < N_PENDING + N_VALIDATED:
                return "Validated"
            return "Refused"

        # Rule status assignment, independent contiguous blocks so the two
        # dimensions overlap realistically (not perfectly correlated):
        # [0,1500) verified, [1500,2100) draft, [2100,2819) to_do.
        def rule_status_for(i):
            if i < N_VERIFIED:
                return "verified"
            if i < N_VERIFIED + N_DRAFT:
                return "draft"
            return "to_do"

        brdp_rows = []
        approval_rows = []
        for i in range(TOTAL):
            bid = uuid.uuid4()
            identifier = f"BRDP-SOPT-{i:05d}"
            brdp_rows.append(
                {
                    "id": bid,
                    "project_id": project.id,
                    "identifier": identifier,
                    "title": f"Synthetic SOPTE rule {i}",
                    "definition": f"Definition text for {identifier}.",
                    "proposal": f"Proposal text for {identifier}.",
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
                        "rule_xml": f"<structureObjectRule id=\"{identifier}\"><objectPath allowedObjectFlag=\"1\">//dmodule</objectPath></structureObjectRule>",
                        "source": "manual",
                    }
                )

        await db.execute(BRDP.__table__.insert(), brdp_rows)
        await db.commit()
        await db.execute(RuleApproval.__table__.insert(), approval_rows)
        await db.commit()
        print(f"Inserted {len(brdp_rows)} BRDPs, {len(approval_rows)} rule_approvals")
        print(f"Ground truth: project_id={project.id}")
        print(f"  proposal_status_counts = pending:{N_PENDING} validated:{N_VALIDATED} refused:{N_REFUSED}")
        print(f"  rule_status_counts = to_do:{N_TODO} draft:{N_DRAFT} verified:{N_VERIFIED}")


asyncio.run(main())
