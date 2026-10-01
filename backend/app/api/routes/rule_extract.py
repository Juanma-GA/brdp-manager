"""AI Extract (1/2): import BRDPs from an existing BREX or Schematron.

  POST  /parse                      editor  multipart .xml → 202 {job_id};
                                            413 too large, 422 not readable
                                            or not the project's format,
                                            409 another extraction running
  GET   /jobs/active                viewer  the project's latest extraction
  GET   /jobs/{job_id}              viewer  its status and progress
  GET   /jobs/{job_id}/candidates   viewer  the candidates for the review
  PATCH /jobs/{job_id}/candidates   editor  save texts written by the AI or by
                                            hand, classification, selection
  POST  /jobs/{job_id}/apply        editor  import the selected candidates

Nothing is written to the project's BRDPs until /apply. See
app/services/rule_extract.py (reading) and rule_extract_jobs.py
(classification, job, import).

Every endpoint answers an unexpected error with a reason (HR7), never a bare
500: _ReadableErrorRoute turns it into {"detail": "..."}; a missing table
(the migration not applied) says so.
"""
import logging
import uuid

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_httpx_transport, require_project_role
from app.core.config import get_settings
from app.db.base import get_db
from app.models import Project, RuleExtractCandidate, RuleExtractJob, User
from app.schemas.rule_extract import (
    RuleExtractApplyRequest,
    RuleExtractCandidateEdits,
    RuleExtractCandidatesOut,
    RuleExtractJobAccepted,
    RuleExtractJobOut,
)
from app.services.rule_extract import RuleExtractFileError, read_rules_file
from app.services.rule_extract_jobs import (
    apply_edit,
    apply_job,
    candidate_out,
    create_job,
    get_most_recent_job,
    get_running_job,
    run_extract_job,
)
from app.services.rule_formats import STANDARD_TO_RULE_FORMAT

logger = logging.getLogger(__name__)


def readable_error(exc: Exception) -> tuple[int, str]:
    """(status, reason) for an error nobody expected."""
    orig = getattr(exc, "orig", None)
    text = f"{type(orig).__name__ if orig is not None else ''} {orig if orig is not None else exc}"
    if isinstance(exc, ProgrammingError) and ("UndefinedTable" in text or ("relation" in text and "does not exist" in text)):
        return (
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The database is missing the AI Extract tables (rule_extract_jobs): the migration has not been applied. "
            "Run `alembic upgrade head` in backend/ and restart the server.",
        )
    if isinstance(exc, DBAPIError):
        return status.HTTP_500_INTERNAL_SERVER_ERROR, f"Database error: {str(orig or exc).strip().splitlines()[0]}"
    return status.HTTP_500_INTERNAL_SERVER_ERROR, f"Unexpected error ({type(exc).__name__}): {exc}"


class _ReadableErrorRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def readable(request: Request):
            try:
                return await handler(request)
            except (HTTPException, RequestValidationError):
                raise
            except Exception as exc:  # noqa: BLE001 -- HR7: answered with a reason
                logger.exception("AI Extract: %s %s failed", request.method, request.url.path)
                code, detail = readable_error(exc)
                return JSONResponse(status_code=code, content={"detail": detail})

        return readable


router = APIRouter(prefix="/api/projects/{project_id}/ai-extract", tags=["ai-extract"], route_class=_ReadableErrorRoute)


async def _project(project_id: uuid.UUID, db: AsyncSession) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


async def _job(project_id: uuid.UUID, job_id: uuid.UUID, db: AsyncSession) -> RuleExtractJob:
    job = await db.get(RuleExtractJob, job_id)
    if job is None or job.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Extraction not found")
    return job


@router.post("/parse", response_model=RuleExtractJobAccepted, status_code=status.HTTP_202_ACCEPTED)
async def parse_rules(
    project_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> RuleExtractJobAccepted:
    project = await _project(project_id, db)
    limit = get_settings().rule_extract_max_bytes
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"The file is larger than {limit // (1024 * 1024)} MB, the limit for a BREX or Schematron.",
        )
    try:
        rules_file = read_rules_file(data, STANDARD_TO_RULE_FORMAT.get(project.standard), project.standard)
    except RuleExtractFileError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    running = await get_running_job(project_id, db)
    if running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An extraction is already running for this project (started at {running.started_at.isoformat()})",
        )
    job = await create_job(project_id, editor.id, file.filename or "", rules_file, db)
    background_tasks.add_task(run_extract_job, job.id, project_id, rules_file, transport)
    return RuleExtractJobAccepted(job_id=job.id)


@router.get("/jobs/active", response_model=RuleExtractJobOut | None)
async def get_active_job(
    project_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> RuleExtractJob | None:
    return await get_most_recent_job(project_id, db)


@router.get("/jobs/{job_id}", response_model=RuleExtractJobOut)
async def get_job(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> RuleExtractJob:
    return await _job(project_id, job_id, db)


@router.get("/jobs/{job_id}/candidates", response_model=RuleExtractCandidatesOut)
async def get_candidates(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> RuleExtractCandidatesOut:
    job = await _job(project_id, job_id, db)
    rows = (
        await db.execute(
            select(RuleExtractCandidate).where(RuleExtractCandidate.job_id == job.id).order_by(RuleExtractCandidate.position)
        )
    ).scalars().all()
    return RuleExtractCandidatesOut(job_id=job.id, candidates=[candidate_out(r) for r in rows])


@router.patch("/jobs/{job_id}/candidates", response_model=RuleExtractCandidatesOut)
async def edit_candidates(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    body: RuleExtractCandidateEdits,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleExtractCandidatesOut:
    """Saves the edits of the given candidates and returns them. All or
    nothing: one invalid edit is a 422 and nothing is saved."""
    job = await _job(project_id, job_id, db)
    if job.applied_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="These candidates were already imported")
    edits = {e.key: e.model_dump(exclude_unset=True) for e in body.items}
    rows = (
        await db.execute(
            select(RuleExtractCandidate).where(RuleExtractCandidate.job_id == job.id, RuleExtractCandidate.key.in_(list(edits)))
        )
    ).scalars().all()
    missing = set(edits) - {r.key for r in rows}
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown candidates: {', '.join(sorted(missing))}")
    try:
        for row in rows:
            row.data = apply_edit(row.data, edits[row.key])
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    await db.commit()
    return RuleExtractCandidatesOut(job_id=job.id, candidates=[candidate_out(r) for r in sorted(rows, key=lambda r: r.position)])


@router.post("/jobs/{job_id}/apply")
async def apply_candidates(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    body: RuleExtractApplyRequest,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    job = await _job(project_id, job_id, db)
    if job.status != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The extraction has not finished")
    if job.applied_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="These candidates were already imported")
    if not body.keys:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No candidate selected")
    return await apply_job(job, body.keys, editor, db)
