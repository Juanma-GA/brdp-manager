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


@router.get("", response_model=list[ProjectOut])
async def list_projects(
    current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[Project]:
    """Admin sees every project without needing a user_project_roles row
    (docs/v2 §4.3 clarification); everyone else sees only what they're
    explicitly assigned to.
    """
    if current_user.global_role == "admin":
        result = await db.execute(select(Project))
    else:
        result = await db.execute(
            select(Project)
            .join(UserProjectRole, UserProjectRole.project_id == Project.id)
            .where(UserProjectRole.user_id == current_user.id)
        )
    return list(result.scalars().all())


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate, _admin: User = Depends(_require_admin), db: AsyncSession = Depends(get_db)
) -> Project:
    """Not itemized as admin-only in docs/v2 §4.2's endpoint table or the
    §4.3 permission matrix (project creation isn't a row there at all) --
    treated as admin-only here since it's a structural action akin to User
    Management, not project content. Flagged for confirmation.
    """
    project = Project(name=body.name, standard=body.standard, project_config=body.project_config)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@router.get("/{project_id}/config", response_model=ProjectOut)
async def get_project_config(
    project_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


@router.put("/{project_id}/config", response_model=ProjectOut)
async def update_project_config(
    project_id: uuid.UUID,
    body: ProjectConfigUpdate,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    project.project_config = body.project_config
    await db.commit()
    await db.refresh(project)
    return project
