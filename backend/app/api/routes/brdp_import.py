import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_project_role
from app.db.base import get_db
from app.models import ImportJob, User
from app.schemas.brdp_import import (
    ImportAnalyzeRequest,
    ImportAnalyzeResponse,
    ImportApplyRequest,
    ImportJobAccepted,
    ImportJobStatusOut,
)
from app.services.import_jobs import analyze_rows, create_job, get_most_recent_job, get_running_job, run_import_job

router = APIRouter(prefix="/api/projects/{project_id}/brdps/import", tags=["brdp-import"])


@router.post("/analyze", response_model=ImportAnalyzeResponse)
async def analyze_import(
    project_id: uuid.UUID,
    body: ImportAnalyzeRequest,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> ImportAnalyzeResponse:
    """Phase 1 (docs request): pure classification, no writes to Postgres
    at all -- exists only to build the confirmation summary the user
    reviews before Apply. Editor-gated like every other BRDP write path
    even though this call itself never mutates anything, since its only
    purpose is to prepare an /apply call.
    """
    _project, _rule_format, results, _existing_brdps, _existing_approvals, _catalog = await analyze_rows(
        project_id, body.rows, db
    )
    return ImportAnalyzeResponse(results=results)


@router.post("/apply", response_model=ImportJobAccepted, status_code=status.HTTP_202_ACCEPTED)
async def apply_import(
    project_id: uuid.UUID,
    body: ImportApplyRequest,
    background_tasks: BackgroundTasks,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> ImportJobAccepted:
    """Phase 2 (docs request) -- now asynchronous: creates the import_jobs
    row and hands the real work off to run_import_job() via
    BackgroundTasks (see app/services/import_jobs.py's module docstring
    for why that's the right mechanism here), returning job_id immediately
    rather than blocking until every row is processed. The classification
    itself is re-run fresh against CURRENT Postgres state inside the job
    (never trusts a classification computed by the client at analyze
    time, or even one computed here before the job starts -- Postgres
    could change between accepting the request and the job actually
    running), so a row someone else changed in between (e.g. approved a
    rule mid-review) gets reclassified fresh rather than acted on stale.

    At most one running job per project (docs request: decide and
    document the concurrency behavior) -- a second Apply while one is
    still running is rejected with 409 rather than silently interleaved,
    which could otherwise double-create or lose an update on the same
    identifier.
    """
    if body.conflict_resolution not in ("keep", "clear"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="conflict_resolution must be 'keep' or 'clear'"
        )

    active = await get_running_job(project_id, db)
    if active is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An import is already running for this project (job {active.id}, started at {active.started_at.isoformat()})",
        )

    job = await create_job(project_id, editor.id, body.rows, db)
    background_tasks.add_task(run_import_job, job.id, project_id, body.rows, body.conflict_resolution, editor.id)
    return ImportJobAccepted(job_id=job.id)


async def _get_job_in_project(project_id: uuid.UUID, job_id: uuid.UUID, db: AsyncSession) -> ImportJob:
    job = await db.get(ImportJob, job_id)
    if job is None or job.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Import job not found")
    return job


@router.get("/status/active", response_model=ImportJobStatusOut | None)
async def get_active_import_status(
    project_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> ImportJobStatusOut | None:
    """Lets any page that loads ask "what's the state of this project's
    import" without knowing a job_id in advance (docs request) -- covers
    navigating away and back, reloading, closing the tab and reopening the
    app later, or a second device/tab. Returns the most recent job
    regardless of status (see get_most_recent_job), not just a running
    one, so a job that finished WHILE the tab was closed is still visible
    on the next visit instead of silently forgotten -- callers decide what
    to render per status (the Sidebar badge specifically only renders for
    "running", so a long-finished job never lingers as a stale badge).
    Registered before /status/{job_id} so "active" is never captured as a
    job_id path parameter. Viewer-readable like every other progress/
    status view in this app (only editor can trigger an import, but
    anyone with access to the project can see its state).
    """
    job = await get_most_recent_job(project_id, db)
    return ImportJobStatusOut.model_validate(job, from_attributes=True) if job is not None else None


@router.get("/status/{job_id}", response_model=ImportJobStatusOut)
async def get_import_status(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> ImportJobStatusOut:
    job = await _get_job_in_project(project_id, job_id, db)
    return ImportJobStatusOut.model_validate(job, from_attributes=True)
