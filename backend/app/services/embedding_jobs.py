"""On-demand embeddings (docs request): pending detection and the
background "Compute embeddings" job that replaces the old inline-on-
validate/inline-on-import Mistral calls.

A row -- a Validated BRDP, or any catalog entry -- is "pending" when its
stored embedding_text_hash doesn't match a hash computed fresh from its
CURRENT text (see is_pending_brdp/is_pending_catalog below). This is
deliberately comparison-based, not a boolean flag kept in sync by every
write path: brdps.py's create/update never touch embedding_text_hash at
all any more, so editing a title after validation correctly makes the row
pending again purely because the freshly-computed hash no longer matches
what's stored, with nothing on the write side needing to know that
happened.

Same job-management pattern as import_jobs.py (two sessions, single
running job per project via get_running_job's 409 check, STALE_JOB_MINUTES
reap, explicit asyncio.CancelledError handling for a clean interruption
like a dev --reload restart) -- see that module's docstring for why
BackgroundTasks is the right mechanism here too.

One real difference from import_jobs.py, deliberate: run_embedding_job
commits work_session after EVERY item, not once at the end. Import's
all-or-nothing commit exists because its rows can interact (the same
identifier, a catalog match, a rule_approvals upsert) -- an import that
dies halfway must not leave a half-applied mix of those. A single
embedding has no such interaction with any other row: it's a real,
independently-expensive Mistral call, so a job that dies halfway should
keep whatever it already computed (no longer pending, no re-billing those
calls on the next run) rather than discard it. progress_session then
becomes redundant with this per-item commit (work_session's own commit IS
what makes the row's new pending state visible to a poller in a different
connection) but is kept anyway, purely to update the job's own
processed_items/status row exactly like import_jobs.py does, keeping the
two modules' shape recognizably the same.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, EmbeddingJob, Project
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.services.embeddings import brdp_embedding_text, catalog_embedding_text, compute_embedding, compute_text_hash

# Same fixed margin as import_jobs.py's STALE_JOB_MINUTES, same reasoning
# (a hard process crash with no chance to run cleanup code) -- not shared
# via import on purpose, each background-job module owns its own copy, same
# as generateBREX41/generateBREX301 each own their suffixed helpers rather
# than reaching into a sibling module's internals.
STALE_JOB_MINUTES = 60
_STALE_JOB_THRESHOLD = timedelta(minutes=STALE_JOB_MINUTES)


def is_pending_brdp(brdp: BRDP) -> bool:
    """A Validated BRDP is pending whenever its stored embedding_text_hash
    doesn't match a hash of its CURRENT title/definition/proposal -- covers
    both "never embedded" (embedding_text_hash is None) and "embedded, but
    edited since" in the same comparison.
    """
    return brdp.embedding_text_hash != compute_text_hash(brdp_embedding_text(brdp))


def is_pending_catalog(entry: BRDPCatalog) -> bool:
    return entry.embedding_text_hash != compute_text_hash(catalog_embedding_text(entry))


async def _pending_brdps(project_id: uuid.UUID, db: AsyncSession) -> list[BRDP]:
    result = await db.execute(
        select(BRDP).where(BRDP.project_id == project_id, BRDP.validation == "Validated", ACTIVE_BRDP_FILTER)
    )
    return [b for b in result.scalars().all() if is_pending_brdp(b)]


async def _pending_catalog(standard: str, db: AsyncSession) -> list[BRDPCatalog]:
    result = await db.execute(select(BRDPCatalog).where(BRDPCatalog.standard == standard))
    return [e for e in result.scalars().all() if is_pending_catalog(e)]


async def count_pending(project: Project, db: AsyncSession) -> tuple[int, int]:
    """Returns (project_pending, catalog_pending) -- backs both GET
    /pending (the banner/button's own gate) and create_job's total_items.
    """
    project_pending = await _pending_brdps(project.id, db)
    catalog_pending = await _pending_catalog(project.standard, db)
    return len(project_pending), len(catalog_pending)


async def _reap_if_stale(job: EmbeddingJob, db: AsyncSession) -> EmbeddingJob:
    """Same staleness reap as import_jobs.py's _reap_if_stale -- a
    `running` job whose started_at is older than _STALE_JOB_THRESHOLD is
    dead (hard crash with no cleanup), marked `failed` on the same read
    that noticed it.
    """
    if job.status == "running" and datetime.now(timezone.utc) - job.started_at > _STALE_JOB_THRESHOLD:
        job.status = "failed"
        job.error = f"Embedding computation likely interrupted — no progress for over {STALE_JOB_MINUTES} minutes"
        job.finished_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(job)
    return job


async def get_running_job(project_id: uuid.UUID, db: AsyncSession) -> EmbeddingJob | None:
    """Single-writer-per-project concurrency check (POST /compute -> 409 if
    this returns something) -- two editors pressing "Compute embeddings" at
    the same time must produce one job, not two racing to embed (and
    commit) the same pending rows.
    """
    result = await db.execute(
        select(EmbeddingJob)
        .where(EmbeddingJob.project_id == project_id, EmbeddingJob.status == "running")
        .order_by(EmbeddingJob.started_at.desc())
        .limit(1)
    )
    job = result.scalar_one_or_none()
    if job is None:
        return None
    job = await _reap_if_stale(job, db)
    return job if job.status == "running" else None


async def get_most_recent_job(project_id: uuid.UUID, db: AsyncSession) -> EmbeddingJob | None:
    """Backs GET /status/active -- lets a page that just loaded recover a
    running job, or see the last job's final result, without knowing a
    job_id in advance. Same shape as import_jobs.py's get_most_recent_job.
    """
    result = await db.execute(
        select(EmbeddingJob)
        .where(EmbeddingJob.project_id == project_id)
        .order_by(EmbeddingJob.started_at.desc())
        .limit(1)
    )
    job = result.scalar_one_or_none()
    if job is None:
        return None
    return await _reap_if_stale(job, db)


async def create_job(project_id: uuid.UUID, started_by: uuid.UUID, total: int, db: AsyncSession) -> EmbeddingJob:
    job = EmbeddingJob(project_id=project_id, started_by=started_by, status="running", total_items=total)
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def _set_progress(progress_session: AsyncSession, job_id: uuid.UUID, processed_items: int) -> None:
    job = await progress_session.get(EmbeddingJob, job_id)
    if job is not None:
        job.processed_items = processed_items
        await progress_session.commit()


async def _finish_job(
    progress_session: AsyncSession,
    job_id: uuid.UUID,
    *,
    status_value: str,
    error: str | None = None,
    result: dict | None = None,
) -> None:
    job = await progress_session.get(EmbeddingJob, job_id)
    if job is None:
        return
    job.status = status_value
    job.error = error
    job.result = result
    job.finished_at = datetime.now(timezone.utc)
    await progress_session.commit()


async def run_embedding_job(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    transport: httpx.AsyncBaseTransport | None,
) -> None:
    """The actual embedding work, run in the background after POST
    /compute has already returned job_id. See module docstring for why
    work_session commits after every item here, unlike import_jobs.py's
    all-or-nothing commit.
    """
    progress_session = async_session_factory()
    work_session = async_session_factory()
    try:
        project = await work_session.get(Project, project_id)
        pending_brdps = await _pending_brdps(project_id, work_session)
        pending_catalog = await _pending_catalog(project.standard, work_session)

        processed = 0
        brdps_embedded = 0
        catalog_embedded = 0

        for brdp in pending_brdps:
            text = brdp_embedding_text(brdp)
            brdp.embedding = await compute_embedding(text, transport=transport)
            brdp.embedding_text_hash = compute_text_hash(text)
            await work_session.commit()
            brdps_embedded += 1
            processed += 1
            await _set_progress(progress_session, job_id, processed)

        for entry in pending_catalog:
            text = catalog_embedding_text(entry)
            entry.embedding = await compute_embedding(text, transport=transport)
            entry.embedding_text_hash = compute_text_hash(text)
            await work_session.commit()
            catalog_embedded += 1
            processed += 1
            await _set_progress(progress_session, job_id, processed)

        await _finish_job(
            progress_session,
            job_id,
            status_value="completed",
            result={"brdps_embedded": brdps_embedded, "catalog_embedded": catalog_embedded},
        )
    except asyncio.CancelledError:
        # Same real scenario as import_jobs.py's own handling: a dev-server
        # --reload restart (or any clean interruption) cancels this
        # coroutine, and CancelledError inherits BaseException (not
        # Exception) since Python 3.8, so the except Exception below never
        # sees it -- without this the job row is abandoned "running"
        # forever. No rollback here (unlike import_jobs.py): every item up
        # to this point already has its own committed transaction, so
        # there's nothing uncommitted to roll back -- only the job's own
        # status needs to move to failed.
        await _finish_job(
            progress_session,
            job_id,
            status_value="failed",
            error="Embedding computation interrupted (server restarted or shut down mid-job)",
        )
        raise
    except Exception as exc:  # noqa: BLE001 -- HR7: surface, never swallow
        await _finish_job(progress_session, job_id, status_value="failed", error=str(exc))
    finally:
        await work_session.close()
        await progress_session.close()
