import copy
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, project_not_found, require_admin, require_project_role
from app.db.base import get_db
from app.models import BRDP, BRDPCatalog, Project, User, UserProjectRole
from app.repositories.brdp_repository import compute_status_counts
from app.repositories.project_repository import ACTIVE_PROJECT_FILTER, active_project_name_taken, get_active_project
from app.schemas.project import ProjectConfigUpdate, ProjectCreate, ProjectDuplicate, ProjectOut, ProjectRename
from app.services.audit import record, record_project_deleted_permanently
from app.services.project_config import project_config_problem
from app.services.project_duplicate import copy_project_contents
from app.services.rule_formats import SUPPORTED_STANDARDS
from app.services.schema_location import schema_location_problem

router = APIRouter(prefix="/api/projects", tags=["projects"])


async def _to_out(db: AsyncSession, project: Project, effective_role: str, counts: dict | None = None) -> ProjectOut:
    """counts (a compute_status_counts() entry) is precomputed by the
    caller for the bulk list_projects case -- one query pair for EVERY
    project being serialized, never one per project. The single-object
    endpoints below (create/rename/config update) don't have a precomputed
    batch to pull from and call this far less often (once per explicit
    user action, not once per project in a list), so they let this
    function compute its own 1-project counts rather than duplicate this
    fallback at each call site.
    """
    if counts is None:
        computed = await compute_status_counts(db, [project])
        counts = computed[project.id]
    return ProjectOut(
        id=project.id,
        name=project.name,
        standard=project.standard,
        project_config=project.project_config,
        created_at=project.created_at,
        effective_role=effective_role,
        proposal_status_counts=counts["proposal_status_counts"],
        rule_status_counts=counts["rule_status_counts"],
    )


def _resolve_effective_role(user: User, raw_role: str | None) -> str:
    """Single place that encodes the admin-bypass rule (docs/v2 §4.3) so no
    frontend component has to repeat "if admin, treat as editor" -- an
    admin has no user_project_roles row at all, so the raw value for them
    is always None regardless of which project is being looked at.
    """
    if user.global_role == "admin":
        return "editor"
    return raw_role or "viewer"


async def _get_role_map(db: AsyncSession, user_id: uuid.UUID, project_ids: list[uuid.UUID]) -> dict:
    if not project_ids:
        return {}
    result = await db.execute(
        select(UserProjectRole).where(
            UserProjectRole.user_id == user_id, UserProjectRole.project_id.in_(project_ids)
        )
    )
    return {row.project_id: row.role for row in result.scalars().all()}


@router.get("", response_model=list[ProjectOut])
async def list_projects(
    current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[ProjectOut]:
    """Admin sees every project without needing a user_project_roles row
    (docs/v2 §4.3 clarification); everyone else sees only what they're
    explicitly assigned to. Each row also carries the caller's effective
    capability on that project (effective_role) so the frontend can hide
    edit controls it has no right to use, instead of rendering them
    optimistically -- and never has to special-case admin itself.
    """
    if current_user.global_role == "admin":
        result = await db.execute(select(Project).where(ACTIVE_PROJECT_FILTER))
        projects = list(result.scalars().all())
        counts_by_id = await compute_status_counts(db, projects)
        return [
            await _to_out(db, p, _resolve_effective_role(current_user, None), counts_by_id[p.id]) for p in projects
        ]

    result = await db.execute(
        select(Project)
        .join(UserProjectRole, UserProjectRole.project_id == Project.id)
        .where(UserProjectRole.user_id == current_user.id, ACTIVE_PROJECT_FILTER)
    )
    projects = list(result.scalars().all())
    role_map = await _get_role_map(db, current_user.id, [p.id for p in projects])
    # Same single-pass counts computation regardless of how many projects
    # this user can see -- 2 queries total (compute_status_counts), plus
    # the project/role queries above, never one pair per project.
    counts_by_id = await compute_status_counts(db, projects)
    return [
        await _to_out(db, p, _resolve_effective_role(current_user, role_map.get(p.id)), counts_by_id[p.id])
        for p in projects
    ]


_DEFAULT_PROJECT_CONFIG = {
    "systemDiffCode": "A",
    "issueNumber": "001",
    "inWork": "00",
    "languageIsoCode": "en",
    "countryIsoCode": "US",
    "securityClassification": "01",
}


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate, _admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)
) -> ProjectOut:
    """Not itemized as admin-only in docs/v2 §4.2's endpoint table or the
    §4.3 permission matrix (project creation isn't a row there at all) --
    treated as admin-only here since it's a structural action akin to User
    Management, not project content. Flagged for confirmation.

    _DEFAULT_PROJECT_CONFIG seeds the 6 identification fields every BREX/
    Schematron-S1000D generator reads the same values for regardless of
    standard (see generateBREX.js/generateBREX41.js/generateBREX301.js --
    confirmed identical field set); projectName/modelIdentCode/
    enterpriseCode stay unset for the user to fill in. Harmless no-op for a
    DITA 1.3 Xpath2.0/Xpath3.0 project, whose Project Configuration page
    only ever shows/reads projectName (generateSchematronDITA.js reads
    nothing else) -- these defaults are simply never displayed there. Any
    value the caller does supply in body.project_config wins over the default.
    """
    if body.standard not in SUPPORTED_STANDARDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "standard_not_supported", "standard": body.standard, "supported": list(SUPPORTED_STANDARDS)},
        )
    shape = project_config_problem(body.project_config)
    if shape:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=shape)
    project_config = {**_DEFAULT_PROJECT_CONFIG, **body.project_config}
    problem = schema_location_problem(body.standard, project_config)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=problem)
    project = Project(name=body.name, standard=body.standard, project_config=project_config)
    db.add(project)
    await db.flush()  # assigns project.id, needed below, before the real commit

    if body.seed_from_catalog:
        catalog_entries = (
            (await db.execute(select(BRDPCatalog).where(BRDPCatalog.standard == body.standard))).scalars().all()
        )
        for entry in catalog_entries:
            db.add(
                BRDP(
                    project_id=project.id,
                    identifier=entry.identifier,
                    title=entry.title,
                    definition=entry.definition,
                    proposal="",
                    validation="Pending",
                )
            )

    await db.commit()
    await db.refresh(project)
    return await _to_out(db, project, _resolve_effective_role(_admin, None))


@router.get("/{project_id}/config", response_model=ProjectOut)
async def get_project_config(
    project_id: uuid.UUID,
    current_user: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> ProjectOut:
    project = await get_active_project(project_id, db)
    if project is None:
        raise project_not_found()

    # Skip the lookup entirely for admin -- _resolve_effective_role ignores
    # raw_role for them anyway (there is no user_project_roles row to find).
    role_map = {} if current_user.global_role == "admin" else await _get_role_map(db, current_user.id, [project_id])
    return await _to_out(db, project, _resolve_effective_role(current_user, role_map.get(project_id)))


@router.put("/{project_id}/config", response_model=ProjectOut)
async def update_project_config(
    project_id: uuid.UUID,
    body: ProjectConfigUpdate,
    current_user: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> ProjectOut:
    project = await get_active_project(project_id, db)
    if project is None:
        raise project_not_found()
    # Same rules as the configuration page (src/utils/ruleSchemaContext.js):
    # a schema location the app could not use is never stored.
    shape = project_config_problem(body.project_config)
    if shape:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=shape)
    problem = schema_location_problem(project.standard, body.project_config)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=problem)
    project.project_config = body.project_config
    await db.commit()
    await db.refresh(project)

    # require_project_role("editor") above already guarantees the caller is
    # either admin or has a real "editor" row -- both resolve to "editor".
    return await _to_out(db, project, _resolve_effective_role(current_user, "editor"))


@router.patch("/{project_id}", response_model=ProjectOut)
async def rename_project(
    project_id: uuid.UUID,
    body: ProjectRename,
    current_user: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> ProjectOut:
    """Renames a project -- the PUT on /config only ever touches
    project_config, never projects.name, so this is a separate endpoint
    rather than folding name into that body. Same editor-level gate as
    /config (project-level metadata, not the higher bar DELETE needs).
    """
    project = await get_active_project(project_id, db)
    if project is None:
        raise project_not_found()
    project.name = body.name
    await db.commit()
    await db.refresh(project)
    return await _to_out(db, project, _resolve_effective_role(current_user, "editor"))


async def running_job_kinds(project_id: uuid.UUID, db: AsyncSession) -> list[str]:
    """The kinds of background job running on a project right now
    (import / embeddings / extraction) -- a project with one cannot be
    deleted (AACF 2): the job would keep writing into a project nobody can
    see. Each kind's own get_running_job, so a stale job is reaped exactly
    as its own start endpoint would."""
    from app.services import embedding_jobs, import_jobs, rule_extract_jobs

    kinds = []
    if await import_jobs.get_running_job(project_id, db) is not None:
        kinds.append("import")
    if await embedding_jobs.get_running_job(project_id, db) is not None:
        kinds.append("embeddings")
    if await rule_extract_jobs.get_running_job(project_id, db) is not None:
        kinds.append("extraction")
    return kinds


def _running_job_conflict(kinds: list[str], action: str) -> HTTPException:
    """409 project_has_running_job naming the jobs; `action` ("delete" |
    "duplicate") picks the interface sentence."""
    verb = "duplicating" if action == "duplicate" else "deleting"
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": "project_has_running_job",
            "jobs": kinds,
            "action": action,
            "message": f"A background job ({', '.join(kinds)}) is running on this project; wait for it to finish before {verb} the project.",
        },
    )


@router.post("/{project_id}/duplicate", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def duplicate_project(
    project_id: uuid.UUID,
    body: ProjectDuplicate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> ProjectOut:
    """Duplicar un proyecto: a new project with another name, a snapshot of
    the source -- afterwards the two are independent. Admin-only, like
    creating a project.

    Same standard and a deep copy of project_config; the active BRDPs with
    their embeddings, their rules (any format) with their status and last
    test, and one "copied_from" History entry per BRDP
    (app/services/project_duplicate.py). One transaction: a failure
    anywhere leaves nothing behind.

    404 if the source does not exist or is in the Papelera; 409
    project_name_taken if an active project already has the name (ignoring
    case and accents; a project in the Papelera does not count); 409
    project_has_running_job while an import, embeddings or extraction job
    runs on the source.
    """
    source = await get_active_project(project_id, db)
    if source is None:
        raise project_not_found()
    name = body.name
    if await active_project_name_taken(name, db):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "project_name_taken",
                "name": name,
                "action": "duplicate",
                "message": f"An active project is already called {name!r}; choose another name for the copy.",
            },
        )
    kinds = await running_job_kinds(project_id, db)
    if kinds:
        raise _running_job_conflict(kinds, "duplicate")

    started = time.monotonic()
    copy_ = Project(name=name, standard=source.standard, project_config=copy.deepcopy(source.project_config))
    db.add(copy_)
    await db.flush()
    counts = await copy_project_contents(
        db,
        source_id=source.id,
        source_name=source.name,
        standard=source.standard,
        new_id=copy_.id,
        actor=admin,
    )
    record(
        db,
        admin,
        "project.duplicated",
        target_type="project",
        target_id=copy_.id,
        target_label=copy_.name,
        project_id=copy_.id,
        project_name=copy_.name,
        detail={
            "source_project_id": str(source.id),
            "source_project_name": source.name,
            "standard": source.standard,
            "brdp_count": counts["brdp_count"],
            "rule_count": counts["rule_count"],
            "duration_ms": int((time.monotonic() - started) * 1000),
        },
    )
    await db.commit()
    await db.refresh(copy_)
    return await _to_out(db, copy_, _resolve_effective_role(admin, None))


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    permanent: bool = Query(False, description="Delete for good, skipping the Papelera (scripts and tests only)."),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Admin-only, deliberately stricter than editor -- an editor can
    change everything about a project's CONTENT but must never be able to
    make the project itself disappear, same reasoning as create_project.

    AACF 2 (Decisión 13, HR9): the project moves to the Papelera
    (deleted_at/deleted_by/deleted_by_email); nothing else changes -- its
    BRDPs, rules, history and roles are kept so a restore brings it back
    whole. Refused (409 project_has_running_job) while a background job
    runs on it.

    permanent=true deletes it for good at once, the same real delete as the
    Papelera's "Delete permanently" (ON DELETE CASCADE on brdps,
    rule_approvals, roles and jobs). The interface never uses it; it is for
    scripts and tests that create throwaway projects and must not leave
    them in anyone's Papelera.
    """
    project = await db.get(Project, project_id)
    if project is None or (project.deleted_at is not None and not permanent):
        raise project_not_found()
    kinds = await running_job_kinds(project_id, db)
    if kinds:
        raise _running_job_conflict(kinds, "delete")
    if permanent:
        await record_project_deleted_permanently(db, admin, project)
        await db.delete(project)
    else:
        project.deleted_at = datetime.now(timezone.utc)
        project.deleted_by = admin.id
        project.deleted_by_email = admin.email
        record(
            db,
            admin,
            "project.trashed",
            target_type="project",
            target_id=project.id,
            target_label=project.name,
            project_id=project.id,
            project_name=project.name,
            detail={"standard": project.standard},
        )
    await db.commit()
