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
commits work_session after every BATCH, not once at the end. Import's
all-or-nothing commit exists because its rows can interact (the same
identifier, a catalog match, a rule_approvals upsert) -- an import that
dies halfway must not leave a half-applied mix of those. A single
embedding has no such interaction with any other row: it's a real,
independently-expensive Mistral call, so a job that dies halfway should
keep whatever it already computed (no longer pending, no re-billing those
calls on the next run) rather than discard it. progress_session then
becomes redundant with this per-batch commit (work_session's own commit
IS what makes each row's new pending state visible to a poller in a
different connection) but is kept anyway, purely to update the job's own
processed_items/status row exactly like import_jobs.py does, keeping the
two modules' shape recognizably the same.

Docs request (batch embeddings): pending items are grouped into batches
of EMBED_BATCH_SIZE and sent to Mistral in one request per batch via
embeddings.py's compute_embeddings_batch -- confirmed real, ~3s/item with
the one-call-per-item design this replaces made a several-thousand-row
project's job take hours. A batch that fails (after Mistral's own 429
retries, handled inside compute_embeddings_batch, are exhausted) is
retried once as a WHOLE batch; if that retry also fails, the job is
marked failed with a clear message and whatever earlier batches already
committed stays committed -- never lost, never silently retried forever.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import async_session_factory
from app.models import BRDP, BRDPCatalog, EmbeddingJob, Project
from app.repositories.brdp_repository import ACTIVE_BRDP_FILTER
from app.services.embeddings import (
    EmbeddingUnavailable,
    brdp_embedding_text,
    catalog_embedding_text,
    compute_embeddings_batch,
    compute_text_hash,
    truncate_for_embedding_input,
)

logger = logging.getLogger(__name__)

# Named constant per docs request, starting value 32 -- research into
# Mistral's real per-request item limit was inconclusive from this
# sandbox (docs.mistral.ai unreachable; secondary sources disagreed,
# citing figures from 16 to 128), but Mistral's own official cookbook
# example (github.com/mistralai/cookbook, mistral/embeddings/
# embeddings.ipynb) successfully batches 1,153 real texts at a chunk size
# of 50 -- real, current, first-party usage strictly above 32, which is
# the closest thing to primary-source confirmation reachable here that
# 32 is safely within the real limit. If Mistral's real limit ever turns
# out to be lower than this, that surfaces as a real batch failure
# through the retry-once-then-fail path below, never silently.
EMBED_BATCH_SIZE = 32

# Docs request: "reintentar ese lote una vez; si vuelve a fallar, marcar
# el job failed" -- one retry of the WHOLE batch, separate from and on
# top of the 429-specific retry loop already inside
# compute_embeddings_batch (a 429 is a rate-limit signal, not a genuine
# failure, so it doesn't consume this budget).
_MAX_BATCH_RETRIES = 1

# Same fixed margin as import_jobs.py's STALE_JOB_MINUTES, same reasoning
# (a hard process crash with no chance to run cleanup code) -- not shared
# via import on purpose, each background-job module owns its own copy, same
# as generateBREX41/generateBREX301 each own their suffixed helpers rather
# than reaching into a sibling module's internals.
STALE_JOB_MINUTES = 60
_STALE_JOB_THRESHOLD = timedelta(minutes=STALE_JOB_MINUTES)


def _chunked(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


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


async def _compute_batch_with_retry(
    texts: list[str], transport: httpx.AsyncBaseTransport | None
) -> list[list[float]]:
    """One retry of the WHOLE batch on a genuine failure (docs request) --
    a 429 never reaches here as a failure at all, since
    compute_embeddings_batch already retries those internally with
    backoff; this only sees EmbeddingUnavailable for other real failure
    modes (network error, 5xx, malformed response).
    """
    last_exc = EmbeddingUnavailable("unreachable -- loop below always returns or re-raises")
    for attempt in range(_MAX_BATCH_RETRIES + 1):
        try:
            return await compute_embeddings_batch(texts, transport=transport)
        except EmbeddingUnavailable as exc:
            last_exc = exc
            if attempt < _MAX_BATCH_RETRIES:
                logger.warning(
                    "Embedding batch of %s text(s) failed (attempt %s/%s), retrying once: %s",
                    len(texts),
                    attempt + 1,
                    _MAX_BATCH_RETRIES + 1,
                    exc,
                )
    raise last_exc


def _texts_for_embedding(items: list, text_for: Callable) -> list[str]:
    """Builds the batch's `input` list from real (untruncated) BRDP/
    catalog text, applying truncate_for_embedding_input per item (HR7:
    explicit, never silent) and logging which ones needed it. The
    ORIGINAL untruncated text is what gets hashed after a successful
    embed (see run_embedding_job below) -- truncation only ever affects
    what bytes are sent to Mistral, never what pending-detection compares
    against.
    """
    texts = []
    for item in items:
        full_text = text_for(item)
        send_text, was_truncated = truncate_for_embedding_input(full_text)
        if was_truncated:
            logger.warning(
                "Text for %s exceeds the embeddings model's input limit -- truncated before sending",
                getattr(item, "identifier", getattr(item, "id", item)),
            )
        texts.append(send_text)
    return texts


async def run_embedding_job(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    transport: httpx.AsyncBaseTransport | None,
) -> None:
    """The actual embedding work, run in the background after POST
    /compute has already returned job_id. See module docstring for why
    work_session commits after every BATCH here, unlike import_jobs.py's
    all-or-nothing commit, and for the batching itself (docs request).
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

        for batch in _chunked(pending_brdps, EMBED_BATCH_SIZE):
            texts = _texts_for_embedding(batch, brdp_embedding_text)
            vectors = await _compute_batch_with_retry(texts, transport)
            for brdp, vector in zip(batch, vectors):
                brdp.embedding = vector
                # Hash of the FULL, untruncated text -- see
                # truncate_for_embedding_input's own docstring for why.
                brdp.embedding_text_hash = compute_text_hash(brdp_embedding_text(brdp))
            await work_session.commit()
            brdps_embedded += len(batch)
            processed += len(batch)
            await _set_progress(progress_session, job_id, processed)

        for batch in _chunked(pending_catalog, EMBED_BATCH_SIZE):
            texts = _texts_for_embedding(batch, catalog_embedding_text)
            vectors = await _compute_batch_with_retry(texts, transport)
            for entry, vector in zip(batch, vectors):
                entry.embedding = vector
                entry.embedding_text_hash = compute_text_hash(catalog_embedding_text(entry))
            await work_session.commit()
            catalog_embedded += len(batch)
            processed += len(batch)
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
        # forever. Rolls back only the CURRENT, uncommitted batch (if any
        # was in flight) -- every earlier batch already has its own
        # committed transaction, untouched by this rollback.
        await work_session.rollback()
        await _finish_job(
            progress_session,
            job_id,
            status_value="failed",
            error="Embedding computation interrupted (server restarted or shut down mid-job)",
        )
        raise
    except Exception as exc:  # noqa: BLE001 -- HR7: surface, never swallow
        # Same reasoning as the CancelledError branch above -- only the
        # in-flight batch (never committed) is rolled back; every earlier
        # batch's commit stands.
        await work_session.rollback()
        await _finish_job(progress_session, job_id, status_value="failed", error=str(exc))
    finally:
        await work_session.close()
        await progress_session.close()
