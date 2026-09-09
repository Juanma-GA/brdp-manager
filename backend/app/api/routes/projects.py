import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_project_role
from app.db.base import get_db
from app.models import Project, User, UserProjectRole
from app.schemas.project import ProjectConfigUpdate, ProjectCreate, ProjectOut

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.global_role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return current_user


def _to_out(project: Project, my_role: str) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        standard=project.standard,
        project_config=project.project_config,
        created_at=project.created_at,
        my_role=my_role,
    )


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
    explicitly assigned to. Each row also carries the caller's own role on
    that project (my_role) so the frontend can hide edit controls it has
    no right to use, instead of rendering them optimistically.
    """
    if current_user.global_role == "admin":
        result = await db.execute(select(Project))
        projects = list(result.scalars().all())
        return [_to_out(p, "admin") for p in projects]

    result = await db.execute(
        select(Project)
        .join(UserProjectRole, UserProjectRole.project_id == Project.id)
        .where(UserProjectRole.user_id == current_user.id)
    )
    projects = list(result.scalars().all())
    role_map = await _get_role_map(db, current_user.id, [p.id for p in projects])
    return [_to_out(p, role_map.get(p.id, "viewer")) for p in projects]


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
    return _to_out(project, "admin")


@router.get("/{project_id}/config", response_model=ProjectOut)
async def get_project_config(
    project_id: uuid.UUID,
    current_user: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> ProjectOut:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    if current_user.global_role == "admin":
        my_role = "admin"
    else:
        role_map = await _get_role_map(db, current_user.id, [project_id])
        my_role = role_map.get(project_id, "viewer")
    return _to_out(project, my_role)


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

    my_role = "admin" if current_user.global_role == "admin" else "editor"
    return _to_out(project, my_role)
