import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_project_role
from app.db.base import get_db
from app.models import Project, User, UserProjectRole
from app.schemas.project import ProjectConfigUpdate, ProjectCreate, ProjectOut, ProjectRename

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.global_role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return current_user


def _to_out(project: Project, effective_role: str) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        standard=project.standard,
        project_config=project.project_config,
        created_at=project.created_at,
        effective_role=effective_role,
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
        result = await db.execute(select(Project))
        projects = list(result.scalars().all())
        return [_to_out(p, _resolve_effective_role(current_user, None)) for p in projects]

    result = await db.execute(
        select(Project)
        .join(UserProjectRole, UserProjectRole.project_id == Project.id)
        .where(UserProjectRole.user_id == current_user.id)
    )
    projects = list(result.scalars().all())
    role_map = await _get_role_map(db, current_user.id, [p.id for p in projects])
    return [_to_out(p, _resolve_effective_role(current_user, role_map.get(p.id))) for p in projects]


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate, _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> ProjectOut:
    """Not itemized as admin-only in docs/v2 §4.2's endpoint table or the
    §4.3 permission matrix (project creation isn't a row there at all) --
    treated as admin-only here since it's a structural action akin to User
    Management, not project content. Flagged for confirmation.
    """
    project = Project(name=body.name, standard=body.standard, project_config=body.project_config)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return _to_out(project, _resolve_effective_role(_admin, None))


@router.get("/{project_id}/config", response_model=ProjectOut)
async def get_project_config(
    project_id: uuid.UUID,
    current_user: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> ProjectOut:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    # Skip the lookup entirely for admin -- _resolve_effective_role ignores
    # raw_role for them anyway (there is no user_project_roles row to find).
    role_map = {} if current_user.global_role == "admin" else await _get_role_map(db, current_user.id, [project_id])
    return _to_out(project, _resolve_effective_role(current_user, role_map.get(project_id)))


@router.put("/{project_id}/config", response_model=ProjectOut)
async def update_project_config(
    project_id: uuid.UUID,
    body: ProjectConfigUpdate,
    current_user: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> ProjectOut:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    project.project_config = body.project_config
    await db.commit()
    await db.refresh(project)

    # require_project_role("editor") above already guarantees the caller is
    # either admin or has a real "editor" row -- both resolve to "editor".
    return _to_out(project, _resolve_effective_role(current_user, "editor"))


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
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    project.name = body.name
    await db.commit()
    await db.refresh(project)
    return _to_out(project, _resolve_effective_role(current_user, "editor"))


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    _admin: User = Depends(_require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Admin-only, deliberately stricter than editor -- an editor can
    change everything about a project's CONTENT but must never be able to
    make the project itself disappear, same reasoning as create_project.
    The actual cascade (brdps, and from there notes/rule_approvals/
    suggestion_feedback, plus user_project_roles) is real DB-level
    ON DELETE CASCADE on those foreign keys (see the 0001 migration) --
    this just deletes the project row and lets Postgres do the rest,
    rather than issuing a manual DELETE per child table.
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    await db.delete(project)
    await db.commit()
