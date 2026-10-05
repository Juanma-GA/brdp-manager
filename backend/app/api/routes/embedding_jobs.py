import uuid

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import logging
from app.core.errors import error_detail, new_error_ref
from app.api.deps import get_httpx_transport, require_project_role
from app.db.base import get_db
from app.models import BRDP, EmbeddingJob, Project, User
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.schemas.embedding_job import (
    EmbeddingJobAccepted,
    EmbeddingJobStatusOut,
    EmbeddingPendingOut,
    SingleBrdpEmbeddingOut,
)
from app.services.embeddings import EmbeddingUnavailable
from app.services.embedding_jobs import (
    count_pending,
    create_job,
    embed_single_brdp,
    get_most_recent_job,
    get_running_job,
    pending_summary,
    run_embedding_job,
)

logger = logging.getLogger("app.errors")
router = APIRouter(prefix="/api/projects/{project_id}/embeddings", tags=["embedding-jobs"])


async def _get_owned_project(project_id: uuid.UUID, db: AsyncSession) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


@router.get("/pending", response_model=EmbeddingPendingOut)
async def get_pending_embeddings(
    project_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> EmbeddingPendingOut:
    """Viewer-readable like every other progress/status view (docs
    request) -- only editors can launch the job, but anyone with access to
    the project can see whether one is needed.
    """
    project = await _get_owned_project(project_id, db)
    project_pending, catalog_pending, only_id = await pending_summary(project, db)
    return EmbeddingPendingOut(
        project_pending=project_pending, catalog_pending=catalog_pending, only_pending_brdp_id=only_id
    )


@router.post("/brdps/{brdp_id}", response_model=SingleBrdpEmbeddingOut)
async def embed_one_brdp(
    project_id: uuid.UUID,
    brdp_id: uuid.UUID,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> SingleBrdpEmbeddingOut:
    """Embeds ONE BRDP synchronously (Suggest Rule adjustments round, Part
    6): when the selected BRDP is the project's only pending one, Suggest
    embeds it first instead of asking for "Compute embeddings". Editor-
    only like /compute; 409 while the job runs (it may be embedding this
    very row); a BRDP that isn't pending is a no-op (embedded: false).
    """
    await _get_owned_project(project_id, db)
    brdp = (
        await db.execute(select(BRDP).where(BRDP.id == brdp_id, BRDP.project_id == project_id, ACTIVE_BRDP_FILTER))
    ).scalar_one_or_none()
    if brdp is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=error_detail("brdp_not_found", message="BRDP not found")
        )
    if await get_running_job(project_id, db) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_detail(
                "embedding_job_running", message="Embedding computation is already running for this project"
            ),
        )
    try:
        embedded = await embed_single_brdp(brdp, db, transport)
    except EmbeddingUnavailable as err:
        # The provider's own text stays in the log under the reference
        # (Decisión 12); the person reads a sentence.
        ref = new_error_ref()
        logger.error("ref=%s embedding of one BRDP failed: %s", ref, err)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=error_detail("embedding_unavailable", ref))
    return SingleBrdpEmbeddingOut(embedded=embedded)


@router.post("/compute", response_model=EmbeddingJobAccepted, status_code=status.HTTP_202_ACCEPTED)
async def compute_embeddings(
    project_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> EmbeddingJobAccepted:
    """Launches the background "Compute embeddings" job (docs request:
    "Solo editores del proyecto pueden lanzarlo"). At most one running job
    per project -- two editors pressing the button at the same time (docs
    request's own edge case) must produce a single job, not two racing to
    embed the same pending rows; the second request gets 409 instead.

    total_items is computed fresh right here, from the SAME pending
    queries the job itself will run -- not reused from a possibly-stale
    GET /pending response the frontend might be holding, since Postgres
    could have changed between that read and this call.
    """
    project = await _get_owned_project(project_id, db)

    active = await get_running_job(project_id, db)
    if active is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=error_detail(
                "embedding_job_running",
                message=f"Embedding computation is already running for this project (job {active.id}, started at {active.started_at.isoformat()})",
                started_at=active.started_at.isoformat(),
            ),
        )

    project_pending, catalog_pending = await count_pending(project, db)
    job = await create_job(project_id, editor.id, project_pending + catalog_pending, db)
    background_tasks.add_task(run_embedding_job, job.id, project_id, transport)
    return EmbeddingJobAccepted(job_id=job.id)


async def _get_job_in_project(project_id: uuid.UUID, job_id: uuid.UUID, db: AsyncSession) -> EmbeddingJob:
    job = await db.get(EmbeddingJob, job_id)
    if job is None or job.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Embedding job not found")
    return job


@router.get("/status/active", response_model=EmbeddingJobStatusOut | None)
async def get_active_embedding_status(
    project_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> EmbeddingJobStatusOut | None:
    """Lets any page recover a running job (or see the last one's final
    result) without knowing a job_id in advance -- same purpose as
    brdp_import.py's GET /status/active. Registered before /status/{job_id}
    so "active" is never captured as a job_id path parameter.
    """
    job = await get_most_recent_job(project_id, db)
    return EmbeddingJobStatusOut.model_validate(job, from_attributes=True) if job is not None else None


@router.get("/status/{job_id}", response_model=EmbeddingJobStatusOut)
async def get_embedding_status(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> EmbeddingJobStatusOut:
    job = await _get_job_in_project(project_id, job_id, db)
    return EmbeddingJobStatusOut.model_validate(job, from_attributes=True)
