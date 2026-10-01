"""Seeds a SOPTE-scale S1000D 3.0.1 project (2818 Verified rules) whose
Generate report has its three schema-URL blocks long and open at once, for
scripts/verify-prefix-attr-scroll.mjs (the Generate page must still scroll
down to the XML and the Copy/Download buttons). The project uses the
"master" schema location, so:

- 2700 rules allow one flat DM schema URL         -> "rewritten" (green)
- 100 rules allow every DM schema flat AND master -> "mixes forms" (amber,
  the shape of SOPTE's BRDP-EXT-02772)
- 18 rules carry a urn: context                   -> "not recognized" (amber)

Rerunning wipes and recreates the project's BRDPs. `cleanup` deletes the
project.

    cd backend && .venv/bin/python scripts/seed_generate_report_scale.py
    cd backend && .venv/bin/python scripts/seed_generate_report_scale.py cleanup
"""
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.db.base import async_session_factory
from app.models import BRDP, Project, RuleApproval

PROJECT_NAME = "Generate Report Scale Verification"
N_REWRITTEN = 2700
N_MIXED = 100
N_UNRECOGNIZED = 18
DM_SCHEMAS = ["appliccrossreftable", "brex", "checklist", "comrep", "condcrossreftable", "container", "crew",
              "descript", "fault", "frontmatter", "ipd", "prdcrossreftable", "proced", "process", "schedul",
              "techrep", "wrngdata"]


def flat(schema: str) -> str:
    return f"http://www.s1000d.org/S1000D_3-0-1/xml_schema_flat/{schema}.xsd"


def master(schema: str) -> str:
    return f"http://www.s1000d.org/S1000D_3-0-1/xml_schema_master/dm/{schema}Schema.xsd"


def objvals(urls: list[str]) -> str:
    return "".join(f'\n  <objval valtype="single" val1="{u}"/>' for u in urls)


def rule_for(i: int, identifier: str) -> str:
    if i < N_REWRITTEN:
        schema = DM_SCHEMAS[i % len(DM_SCHEMAS)]
        return (f'<objrule id="{identifier}">\n  <objpath>//@xsi:noNamespaceSchemaLocation</objpath>\n'
                f"  <objuse>Only the {schema} schema.</objuse>{objvals([flat(schema)])}\n</objrule>")
    if i < N_REWRITTEN + N_MIXED:
        return (f'<objrule id="{identifier}">\n  <objpath>//@xsi:noNamespaceSchemaLocation</objpath>\n'
                f"  <objuse>Only the DM schemas, flat or master.</objuse>"
                f"{objvals([flat(s) for s in DM_SCHEMAS] + [master(s) for s in DM_SCHEMAS])}\n</objrule>")
    return (f'<contextrules context="urn:csdb:proced:{i}">\n  <structrules>\n'
            f'    <objrule id="{identifier}"><objpath objappl="0">//acronym</objpath><objuse>No acronyms.</objuse></objrule>\n'
            "  </structrules>\n</contextrules>")


async def main(cleanup: bool) -> None:
    async with async_session_factory() as db:
        project = (await db.execute(select(Project).where(Project.name == PROJECT_NAME))).scalar_one_or_none()
        if project is not None:
            existing = (await db.execute(select(BRDP.id).where(BRDP.project_id == project.id))).scalars().all()
            if existing:
                await db.execute(RuleApproval.__table__.delete().where(RuleApproval.brdp_id.in_(existing)))
                await db.execute(BRDP.__table__.delete().where(BRDP.project_id == project.id))
            if cleanup:
                await db.delete(project)
                await db.commit()
                print(f"Deleted project {PROJECT_NAME!r}")
                return
            await db.commit()
        elif cleanup:
            print("Nothing to clean up")
            return
        if project is None:
            project = Project(
                name=PROJECT_NAME,
                standard="S1000D 3.0.1",
                project_config={"projectName": PROJECT_NAME, "modelIdentCode": "SOPT", "schemaLocation": "master"},
            )
            db.add(project)
            await db.commit()
            await db.refresh(project)
        brdps, approvals = [], []
        for i in range(N_REWRITTEN + N_MIXED + N_UNRECOGNIZED):
            bid = uuid.uuid4()
            identifier = f"BRDP-GRS-{i:05d}"
            brdps.append({"id": bid, "project_id": project.id, "identifier": identifier,
                          "title": f"Schema rule {i}", "definition": f"Definition of {identifier}.",
                          "proposal": f"Proposal of {identifier}.", "validation": "Validated"})
            approvals.append({"brdp_id": bid, "format": "BREX-3.0.1", "status": "approved",
                              "rule_xml": rule_for(i, identifier), "source": "manual"})
        await db.execute(BRDP.__table__.insert(), brdps)
        await db.execute(RuleApproval.__table__.insert(), approvals)
        await db.commit()
        print(f"Project {PROJECT_NAME!r} id={project.id}: {len(brdps)} Verified rules")


asyncio.run(main(len(sys.argv) > 1 and sys.argv[1] == "cleanup"))
