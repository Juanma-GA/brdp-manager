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
  GET   /limits                     viewer  free text: the word / character limits
  POST  /text                       editor  free text (JSON {text, filename}) →
                                            202 {job_id}; 422 empty or over the
                                            word / character limit (counted
                                            here again), 409 another running
  GET   /jobs/{job_id}/text         viewer  the text of a free-text job
  POST  /jobs/{job_id}/decisions    editor  the decisions the AI found in it
                                            ([{quote, title}]): quotes checked
                                            and classified in the background;
                                            409 unless the job is waiting
  POST  /jobs/{job_id}/apply        editor  import the selected candidates;
                                            409 when a key is unknown, a
                                            checked row has texts pending or
                                            failed, or the counts do not add
                                            up (nothing written)

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
    RuleExtractDecisions,
    RuleExtractJobAccepted,
    RuleExtractJobOut,
    RuleExtractLimitsOut,
    RuleExtractSourceTextOut,
    RuleExtractTextRequest,
)
from app.services.rule_extract import RuleExtractFileError, read_rules_file
from app.services.rule_extract_jobs import (
    ApplyRefused,
    apply_edit,
    apply_job,
    candidate_out,
    create_job,
    create_text_job,
    get_most_recent_job,
    get_running_job,
    next_ext_allocator,
    run_extract_job,
    run_text_extract_job,
)
from app.services.text_extract import count_words
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


@router.get("/limits", response_model=RuleExtractLimitsOut)
async def get_limits(_viewer: User = Depends(require_project_role("viewer"))) -> RuleExtractLimitsOut:
    settings = get_settings()
    return RuleExtractLimitsOut(max_words=settings.extract_text_max_words, max_chars=settings.extract_text_max_chars)


@router.post("/text", response_model=RuleExtractJobAccepted, status_code=status.HTTP_202_ACCEPTED)
async def start_text(
    project_id: uuid.UUID,
    body: RuleExtractTextRequest,
    editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
) -> RuleExtractJobAccepted:
    """The page counts the words before calling the AI; they are counted
    here again (a direct request is bound by the same limit). Over the limit
    the text is rejected, never cut."""
    await _project(project_id, db)
    settings = get_settings()
    text = body.text.replace("\r\n", "\n")
    words = count_words(text)
    if words == 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The text is empty.")
    if words > settings.extract_text_max_words:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"This text has {words} words; the limit is {settings.extract_text_max_words}. "
            "Split it into sections and import them one by one.",
        )
    if len(text) > settings.extract_text_max_chars:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"This text has {len(text)} characters; the limit is {settings.extract_text_max_chars}. "
            "Split it into sections and import them one by one.",
        )
    running = await get_running_job(project_id, db)
    if running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An extraction is already running for this project (started at {running.started_at.isoformat()})",
        )
    job = await create_text_job(project_id, editor.id, body.filename.strip(), text, words, db)
    return RuleExtractJobAccepted(job_id=job.id)


@router.get("/jobs/{job_id}/text", response_model=RuleExtractSourceTextOut)
async def get_source_text(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    _viewer: User = Depends(require_project_role("viewer")),
    db: AsyncSession = Depends(get_db),
) -> RuleExtractSourceTextOut:
    job = await _job(project_id, job_id, db)
    if job.source_kind != "text":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This extraction is not a free text")
    return RuleExtractSourceTextOut(job_id=job.id, text=job.source_text or "", word_count=job.word_count or 0)


@router.post("/jobs/{job_id}/decisions", response_model=RuleExtractJobOut, status_code=status.HTTP_202_ACCEPTED)
async def post_decisions(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    body: RuleExtractDecisions,
    background_tasks: BackgroundTasks,
    _editor: User = Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
    transport: httpx.AsyncBaseTransport | None = Depends(get_httpx_transport),
) -> RuleExtractJob:
    job = await _job(project_id, job_id, db)
    if job.source_kind != "text" or job.status != "awaiting_decisions":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This extraction is not waiting for decisions")
    job.status = "running"
    job.phase = "classifying"
    await db.commit()
    await db.refresh(job)
    background_tasks.add_task(run_text_extract_job, job.id, project_id, [d.model_dump() for d in body.decisions], transport)
    return job


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
            select(RuleExtractCandidate)
            .where(RuleExtractCandidate.job_id == job.id, RuleExtractCandidate.key.in_(list(edits)))
            .order_by(RuleExtractCandidate.position)
            # Row locks: a batch of AI texts and a "select all shown" saved
            # at the same time each apply their edit on the other's result
            # (never a lost update), always locked in the same order.
            .with_for_update()
        )
    ).scalars().all()
    missing = set(edits) - {r.key for r in rows}
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown candidates: {', '.join(sorted(missing))}")
    allocate = None
    if any(e.get("classification") for e in edits.values()):
        allocate = await next_ext_allocator(job, db)
    try:
        for row in rows:
            row.data = apply_edit(row.data, edits[row.key], allocate)
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
    if job.source_kind == "text" and body.import_as != "pending":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A free text is never imported as already in force: its BRDPs are created Pending, without a rule.",
        )
    try:
        return await apply_job(job, body.keys, editor, db, import_as=body.import_as)
    except ApplyRefused as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=exc.detail) from exc
